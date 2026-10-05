"""Timelapse editing never leaves ffmpeg running or temp files behind.

``TimelapseProcessor.process`` awaited ``communicate()`` with no timeout, so a
stalled ffmpeg hung the request for good, and a client that gave up left the
child running (cancelling the coroutine does not kill a subprocess). The route
wrote its output and audio to fixed names in /tmp -- two edits of one archive
overwrote each other -- and a failed "replace" left processed_<id>.mp4 behind.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import patch

import pytest

from backend.app.services import timelapse_processor as tp

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _ffmpeg_present(monkeypatch):
    """The processor refuses to construct without an ffmpeg binary, and CI
    runners have none. Every test here stubs the subprocess (or `process`)
    itself, so a fake path is all the constructor needs."""
    monkeypatch.setattr(tp, "get_ffmpeg_path", lambda: "/usr/bin/ffmpeg")


class _HangingProcess:
    def __init__(self):
        self.killed = False
        self.waited = False
        self.returncode = None

    async def communicate(self):
        await asyncio.sleep(3600)
        return b"", b""

    def kill(self):
        self.killed = True
        self.returncode = -9

    async def wait(self):
        self.waited = True
        return self.returncode


async def test_a_stalled_ffmpeg_is_killed_at_the_timeout(tmp_path):
    proc = _HangingProcess()

    async def _spawn(*_args, **_kwargs):
        return proc

    with patch.object(tp.asyncio, "create_subprocess_exec", _spawn), patch.object(tp, "PROCESS_TIMEOUT_SECONDS", 0.05):
        ok = await tp.TimelapseProcessor(tmp_path / "in.mp4").process(output_path=tmp_path / "out.mp4", speed=2.0)

    assert ok is False
    assert proc.killed and proc.waited


async def test_a_cancelled_edit_kills_ffmpeg(tmp_path):
    proc = _HangingProcess()

    async def _spawn(*_args, **_kwargs):
        return proc

    with patch.object(tp.asyncio, "create_subprocess_exec", _spawn):
        task = asyncio.create_task(
            tp.TimelapseProcessor(tmp_path / "in.mp4").process(output_path=tmp_path / "out.mp4", speed=2.0)
        )
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    assert proc.killed and proc.waited


@pytest.mark.integration
async def test_a_failed_replace_leaves_no_temp_output(
    async_client, archive_factory, printer_factory, db_session, tmp_path
):
    from backend.app.core.config import settings

    printer = await printer_factory()
    archive = await archive_factory(printer.id)
    video = settings.base_dir / Path(archive.file_path).parent / "timelapse.mp4"
    video.parent.mkdir(parents=True, exist_ok=True)
    video.write_bytes(b"original")
    archive.timelapse_path = str(video.relative_to(settings.base_dir))
    await db_session.commit()

    seen: list[Path] = []

    async def _fails(self, output_path, **_kwargs):
        seen.append(Path(output_path))
        Path(output_path).write_bytes(b"half")
        return False

    try:
        with patch.object(tp.TimelapseProcessor, "process", _fails):
            response = await async_client.post(
                f"/api/v1/archives/{archive.id}/timelapse/process", data={"save_mode": "replace", "speed": "2"}
            )
        assert response.status_code == 500
        assert seen and not seen[0].exists(), "the failed output was left behind"
        assert video.read_bytes() == b"original"
    finally:
        video.unlink(missing_ok=True)
