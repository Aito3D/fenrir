"""Bounded post-kill ffmpeg cleanup (#2580, fix shape from PR #2581 by @ronaldheft).

A SIGKILLed ffmpeg stuck in uninterruptible I/O on a dead RTSP socket can take
arbitrarily long to be reaped. The cleanup paths used to ``await process.wait()``
unbounded after ``kill()`` — on a P2S RTSP read timeout this parked the fan-out
stream coroutine for 12 hours, leaving every viewer attached to a stalled
broadcaster while snapshots/diagnostics (fresh connections) kept working.

The same unbounded wait existed in THREE places, all bounded now:
1. ``_terminate_ffmpeg`` — the stream generator's cleanup (the reported hang).
2. ``stop_camera`` — hung the very request a user makes to recover.
3. ``cleanup_orphaned_streams`` — hung the janitor that is the safety net.
"""

from __future__ import annotations

import asyncio
import time
from contextlib import suppress

import pytest

from backend.app.api.routes import camera

pytestmark = pytest.mark.asyncio


class _FakeServer:
    def close(self) -> None:
        pass

    async def wait_closed(self) -> None:
        pass


class _TimeoutReader:
    """stdout that immediately reports a read timeout (stalled RTSP)."""

    async def read(self, _size: int = -1) -> bytes:
        raise TimeoutError


class _SingleFrameReader:
    """stdout that yields one complete JPEG then EOF."""

    def __init__(self) -> None:
        self._sent = False

    async def read(self, _size: int = -1) -> bytes:
        if self._sent:
            return b""
        self._sent = True
        return b"\xff\xd8fresh-frame\xff\xd9"


class _StuckPostKillProcess:
    """ffmpeg whose post-kill wait() never completes unless cancelled."""

    def __init__(self, pid: int = 41001) -> None:
        self.pid = pid
        self.returncode = None
        self.stdout = _TimeoutReader()
        self.stderr = None
        self.wait_calls = 0
        self.killed = False
        self.post_kill_wait_cancelled = asyncio.Event()
        self._release = asyncio.Event()

    def terminate(self) -> None:
        pass

    def kill(self) -> None:
        self.killed = True

    async def wait(self) -> int:
        self.wait_calls += 1
        if self.wait_calls == 1:
            # Graceful-terminate window: simulate "didn't exit in time".
            raise TimeoutError
        try:
            await self._release.wait()
        except asyncio.CancelledError:
            self.post_kill_wait_cancelled.set()
            raise
        self.returncode = -9
        return self.returncode


class _FrameProcess:
    """Healthy replacement ffmpeg delivering one frame."""

    def __init__(self, pid: int = 41002) -> None:
        self.pid = pid
        self.returncode = None
        self.stdout = _SingleFrameReader()
        self.stderr = None

    def terminate(self) -> None:
        pass

    def kill(self) -> None:
        pass

    async def wait(self) -> int:
        self.returncode = 0
        return self.returncode


# ---------------------------------------------------------------------------
# 1. _terminate_ffmpeg — the helper itself is bounded
# ---------------------------------------------------------------------------


async def test_terminate_ffmpeg_abandons_unreaped_kill(monkeypatch):
    monkeypatch.setattr(camera, "_FFMPEG_KILL_TIMEOUT", 0.05)
    proc = _StuckPostKillProcess()

    # Must return promptly instead of hanging on the post-kill wait.
    await asyncio.wait_for(camera._terminate_ffmpeg(proc, "test"), timeout=1.0)

    assert proc.killed is True
    assert proc.post_kill_wait_cancelled.is_set()
    assert proc.pid not in camera._state.spawned_ffmpeg_pids


# ---------------------------------------------------------------------------
# 2. Stream generator — reconnects instead of pinning the fan-out pump
#    (regression scenario from PR #2581)
# ---------------------------------------------------------------------------


async def test_rtsp_stream_ends_bounded_past_unreaped_ffmpeg(monkeypatch):
    """RTSP read timeout -> kill hangs -> the generator must finish its bounded
    cleanup instead of pinning the producer task forever (regression scenario
    from PR #2581). In this fork the SharedStreamHub respawns a fresh producer
    once the stalled one ends, so the guarantee under test is prompt, bounded
    termination of the generator itself."""
    stalled = _StuckPostKillProcess()
    spawned: list[object] = []

    async def fake_create_subprocess_exec(*_args, **_kwargs):
        spawned.append(stalled)
        return stalled

    async def fake_create_tls_proxy(_ip_address: str, _port: int):
        return 48521, _FakeServer()

    monkeypatch.setattr(camera, "get_ffmpeg_path", lambda: "/fake/ffmpeg")
    monkeypatch.setattr(camera, "create_tls_proxy", fake_create_tls_proxy)
    monkeypatch.setattr(camera.asyncio, "create_subprocess_exec", fake_create_subprocess_exec)
    monkeypatch.setattr(camera, "_FFMPEG_KILL_TIMEOUT", 0.01)

    stream = camera.generate_rtsp_mjpeg_stream(
        ip_address="192.0.2.17",
        access_code="test-code",
        model="P2S",
        fps=15,
        stream_id="9999-fanout",
        disconnect_event=asyncio.Event(),
        printer_id=9999,
    )

    try:
        # Must end promptly (bounded kill wait), not hang on the unreaped wait().
        with pytest.raises(StopAsyncIteration):
            await asyncio.wait_for(anext(stream), timeout=5.0)
        assert stalled.killed is True
        assert stalled.post_kill_wait_cancelled.is_set()
        assert len(spawned) == 1
    finally:
        stalled._release.set()
        with suppress(Exception):
            await asyncio.wait_for(stream.aclose(), timeout=2.0)


# ---------------------------------------------------------------------------
# 3. Janitor — cleanup_orphaned_streams must not hang on an unreaped process
# ---------------------------------------------------------------------------


async def test_cleanup_orphaned_streams_bounded_on_unreaped_process(monkeypatch):
    monkeypatch.setattr(camera, "_FFMPEG_KILL_TIMEOUT", 0.05)
    monkeypatch.setattr(camera, "_scan_bambu_ffmpeg_pids", lambda: [])

    import os

    # Real pid: janitor layer 2 prunes _spawned_ffmpeg_pids entries whose pid
    # doesn't exist (os.kill(pid, 0)), which would reset the spawn age and
    # skip the stale-stream kill below.
    proc = _StuckPostKillProcess(pid=os.getpid())
    proc.wait_calls = 1  # skip the graceful-terminate branch; janitor kills directly
    sid = "9998-fanout"
    now = time.monotonic()
    camera._active_streams[sid] = proc
    camera._state.spawned_ffmpeg_pids[proc.pid] = now - 120  # spawned long ago
    camera._state.last_frame_times[9998] = now - 60  # stale: no frames >30s

    try:
        # Must complete despite proc.wait() never returning.
        await asyncio.wait_for(camera.cleanup_orphaned_streams(), timeout=2.0)

        assert proc.killed is True
        assert sid not in camera._active_streams
        assert proc.pid not in camera._state.spawned_ffmpeg_pids
    finally:
        proc._release.set()
        camera._active_streams.pop(sid, None)
        camera._state.spawned_ffmpeg_pids.pop(proc.pid, None)
        camera._state.last_frame_times.pop(9998, None)
        camera._disconnect_events.pop(sid, None)
