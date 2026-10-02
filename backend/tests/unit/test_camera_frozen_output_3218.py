"""An RTSP stream repeating one frame is restarted, not trusted (#3218).

On a P2S whose camera session had dropped, ffmpeg kept writing ~29 fps of one
byte-identical JPEG for two hours with no socket to the printer left. Every
repeat looked like a live stream to every check. 20 s without a changed frame
now ends the session -- unless the restart shows the very same picture again,
which is a still scene (a dark, idle chamber), not a frozen ffmpeg.

Upstream's generator reconnects inside itself; here one call of
``generate_rtsp_mjpeg_stream`` is one ffmpeg session under SharedStreamHub,
whose dead-producer restart spawns the next one. So each session is driven as
its own call, and the frame a session froze on is read from ``_state``.
"""

import asyncio
import zlib
from contextlib import suppress

import pytest

from backend.app.api.routes import camera

PRINTER_ID = 3218
STREAM_ID = f"{PRINTER_ID}-fanout-frozen"


def _jpeg(n: int) -> bytes:
    return b"\xff\xd8frame-" + str(n).encode() + b"\xff\xd9"


class _Clock:
    def __init__(self) -> None:
        self.now = 1_000_000.0

    def __call__(self) -> float:
        return self.now


class _FakeServer:
    def close(self) -> None:
        pass

    async def wait_closed(self) -> None:
        pass


class _Stdout:
    """One frame per read, the clock advancing a second each time."""

    def __init__(self, frames, clock: _Clock) -> None:
        self._frames = iter(frames)
        self._clock = clock

    async def read(self, _size: int = -1) -> bytes:
        self._clock.now += 1.0
        return next(self._frames, b"")


class _Stderr:
    async def read(self, _size: int = -1) -> bytes:
        return b""


class _Proc:
    _next_pid = 79000

    def __init__(self, frames, clock: _Clock) -> None:
        _Proc._next_pid += 1
        self.pid = _Proc._next_pid
        self.returncode = None
        self.stdout = _Stdout(frames, clock)
        self.stderr = _Stderr()
        self.terminated = False

    def terminate(self) -> None:
        self.terminated = True
        self.returncode = 0

    def kill(self) -> None:
        self.returncode = -9

    async def wait(self) -> int:
        if self.returncode is None:
            self.returncode = 0
        return self.returncode


@pytest.fixture
def rtsp(monkeypatch):
    clock = _Clock()
    sessions: list = []
    spawned: list[_Proc] = []
    real_sleep = asyncio.sleep

    async def _fake_exec(*_args, **_kwargs):
        proc = _Proc(sessions.pop(0) if sessions else [], clock)
        spawned.append(proc)
        return proc

    async def _fake_proxy(_ip: str, _port: int):
        return 48997, _FakeServer()

    async def _no_sleep(_seconds, *args, **kwargs):
        await real_sleep(0)

    monkeypatch.setattr(camera, "get_ffmpeg_path", lambda: "/fake/ffmpeg")
    monkeypatch.setattr(camera, "create_tls_proxy", _fake_proxy)
    monkeypatch.setattr(camera, "rtsp_socket_timeout_flag", lambda: "timeout")
    monkeypatch.setattr(camera.asyncio, "create_subprocess_exec", _fake_exec)
    monkeypatch.setattr(camera.asyncio, "sleep", _no_sleep)
    monkeypatch.setattr(camera.time, "monotonic", clock)
    camera._state.frozen_frame_crc.pop(PRINTER_ID, None)
    yield clock, sessions, spawned
    camera._state.frozen_frame_crc.pop(PRINTER_ID, None)


def _stream():
    return camera.generate_rtsp_mjpeg_stream(
        ip_address="192.0.2.41",
        access_code="test-code",
        model="P2S",
        fps=30,
        stream_id=STREAM_ID,
        disconnect_event=asyncio.Event(),
        printer_id=PRINTER_ID,
    )


async def _collect(stream, limit: int) -> list[bytes]:
    """Frames of one session: until the generator ends, or ``limit`` of them."""
    frames = []
    pending_header = False
    async for chunk in stream:
        if chunk.startswith(b"--frame"):
            pending_header = True
            continue
        if pending_header:
            frames.append(chunk)
            pending_header = False
        if len(frames) >= limit:
            break
    with suppress(Exception):
        await stream.aclose()
    return frames


async def _session(frames, limit: int = 1000) -> list[bytes]:
    return await asyncio.wait_for(_collect(_stream(), limit=limit), timeout=10)


async def test_a_frozen_session_ends_and_the_next_one_is_live(rtsp):
    _clock, sessions, spawned = rtsp
    # The reporter's case: one real frame, then ffmpeg repeats it forever.
    sessions.append([_jpeg(1)] * 100)
    frames = await _session(sessions)

    # About 20 s of the frozen frame went out, then the session ended itself
    # rather than streaming the remaining 78 copies.
    assert 20 <= len(frames) <= 23
    assert spawned[0].terminated
    # The frame it froze on is remembered for the session the hub starts next.
    assert camera._state.frozen_frame_crc[PRINTER_ID] == zlib.crc32(_jpeg(1))

    sessions.append([_jpeg(n) for n in range(2, 40)])
    frames = await _session(sessions)

    assert len(spawned) == 2
    assert frames == [_jpeg(n) for n in range(2, 40)]
    # The picture moved: the freeze memory is cleared.
    assert PRINTER_ID not in camera._state.frozen_frame_crc


async def test_a_moving_picture_is_never_restarted(rtsp):
    _clock, sessions, spawned = rtsp
    sessions.append([_jpeg(n) for n in range(120)])

    frames = await _session(sessions)

    assert len(frames) == 120
    assert len(spawned) == 1
    assert PRINTER_ID not in camera._state.frozen_frame_crc


async def test_short_runs_of_repeats_are_fine(rtsp):
    """ffmpeg's -r repeats frames when it outputs faster than the camera
    sends; a few repeats between changes are normal and keep the session."""
    _clock, sessions, spawned = rtsp
    sessions.append([_jpeg(n // 5) for n in range(150)])

    frames = await _session(sessions)

    assert len(frames) == 150
    assert len(spawned) == 1


async def test_a_still_scene_is_rechecked_rarely_not_every_20s(rtsp):
    """A dark chamber can encode to the same frame every time. The first
    restart shows the same picture again, so the camera really shows it."""
    _clock, sessions, spawned = rtsp
    black = _jpeg(0)
    sessions.append([black] * 30)  # ended after 20 s...
    first = await _session(sessions)
    assert 20 <= len(first) <= 23

    sessions.append([black] * 400)  # ...and the picture is the same
    second = await _session(sessions)

    # The still scene ran for the 300 s re-check interval, not 20 s.
    assert 300 <= len(second) <= 303
    assert len(spawned) == 2
    # Still remembered, so the next session is a still scene again too.
    assert camera._state.frozen_frame_crc[PRINTER_ID] == zlib.crc32(black)


async def test_a_still_scene_is_still_rechecked_eventually(rtsp):
    _clock, sessions, spawned = rtsp
    black = _jpeg(0)
    sessions.append([black] * 30)
    await _session(sessions)
    sessions.append([black] * 400)
    await _session(sessions)

    sessions.append([_jpeg(n) for n in range(1, 50)])  # lights on
    frames = await _session(sessions)

    # The re-check found the picture moving again: every frame delivered.
    assert len(spawned) == 3
    assert frames[-1] == _jpeg(49)
    assert PRINTER_ID not in camera._state.frozen_frame_crc


async def test_a_moving_picture_resets_the_still_scene(rtsp):
    """Once the picture moves, a later freeze is caught after 20 s again."""
    _clock, sessions, spawned = rtsp
    black = _jpeg(0)
    sessions.append([black] * 30)
    await _session(sessions)

    # Same picture first (a still scene), then it moves, then freezes again.
    sessions.append([black] + [_jpeg(n) for n in range(1, 10)] + [_jpeg(9)] * 400)
    frames = await _session(sessions)

    # Ended 20 s into the second freeze, not 300 s.
    assert len(spawned) == 2
    assert 30 <= len(frames) <= 33
    assert frames[-1] == _jpeg(9)
    assert camera._state.frozen_frame_crc[PRINTER_ID] == zlib.crc32(_jpeg(9))


async def test_a_session_without_a_printer_id_still_catches_a_freeze(rtsp):
    """No per-printer memory, so every freeze is caught at 20 s and a still
    scene costs one restart per 20 s -- never a session that runs forever."""
    _clock, sessions, spawned = rtsp
    sessions.append([_jpeg(1)] * 100)
    stream = camera.generate_rtsp_mjpeg_stream(
        ip_address="192.0.2.41",
        access_code="test-code",
        model="P2S",
        fps=30,
        stream_id=STREAM_ID,
        disconnect_event=asyncio.Event(),
        printer_id=None,
    )

    frames = await asyncio.wait_for(_collect(stream, limit=1000), timeout=10)

    assert 20 <= len(frames) <= 23
    assert PRINTER_ID not in camera._state.frozen_frame_crc
