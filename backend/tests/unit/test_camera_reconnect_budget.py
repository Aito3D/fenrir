"""The external-camera reconnect budget counts failures in a row, not every drop.

Upstream's built-in RTSP path counted every ffmpeg respawn against a lifetime
budget of 30, so a stock X1C (which ends each session after about a minute)
stopped for good after half an hour. This fork's built-in stream is produced
by SharedStreamHub, whose producer restarts reset after a recovery window, so
only the external-camera half of upstream's test applies here. The external
path allowed three reconnects for the life of the stream.
"""

import asyncio

import pytest

from backend.app.services import external_camera

FRAME = b"\xff\xd8frame\xff\xd9"


# ---------------------------------------------------------------------------
# External cameras
# ---------------------------------------------------------------------------


@pytest.fixture
def external(monkeypatch):
    sessions: list[int] = []
    opened: list[int] = []
    closed: list[int] = []

    def _fake_stream_rtsp(_url, _fps, on_process=None, **_kwargs):
        frames = sessions.pop(0) if sessions else 0
        index = len(opened)
        opened.append(frames)

        async def _gen():
            try:
                for _ in range(frames):
                    yield FRAME
            finally:
                closed.append(index)

        return _gen()

    async def _no_sleep(_seconds, *args, **kwargs):
        return None

    monkeypatch.setattr(external_camera, "_stream_rtsp", _fake_stream_rtsp)
    monkeypatch.setattr(external_camera.asyncio, "sleep", _no_sleep)
    return sessions, opened, closed


async def test_external_routine_drops_keep_the_stream_going(external):
    """Used to end for good on the fourth drop."""
    sessions, opened, _ = external
    sessions.extend([2, 2, 2, 2, 2, 2])

    frames = [f async for f in external_camera.generate_mjpeg_stream("rtsp://cam.test/live", "rtsp", 10)]

    assert len(frames) == 12
    assert opened == [2, 2, 2, 2, 2, 2, 0], "a session with no frame ends the stream"


async def test_external_stops_when_asked(external):
    sessions, opened, _ = external
    sessions.extend([1] * 10)
    stop = asyncio.Event()

    frames = []
    async for frame in external_camera.generate_mjpeg_stream("rtsp://cam.test/live", "rtsp", 10, stop_event=stop):
        frames.append(frame)
        if len(frames) == 3:
            stop.set()

    assert len(frames) == 3
    assert len(opened) == 3


async def test_closing_the_external_stream_closes_the_open_session(external):
    """The session owns the ffmpeg process; it must stop when the viewer goes,
    not whenever the abandoned iterator happens to be collected."""
    sessions, _, closed = external
    sessions.extend([50])

    stream = external_camera.generate_mjpeg_stream("rtsp://cam.test/live", "rtsp", 10)
    await anext(stream)
    await stream.aclose()

    assert closed == [0]


async def test_a_cancelled_viewer_is_not_redialled(monkeypatch):
    """The real sessions swallow CancelledError and just end. Without a check,
    the now-unlimited reconnect loop would read that as a routine drop."""
    opened: list[int] = []
    reading = asyncio.Event()
    swallow = [True]

    def _fake_stream_rtsp(_url, _fps, on_process=None, **_kwargs):
        opened.append(len(opened))

        async def _gen():
            yield FRAME
            try:
                reading.set()
                await asyncio.Event().wait()  # blocked on the camera
            except asyncio.CancelledError:
                if not swallow[0]:
                    raise
                return  # swallowed, exactly like _stream_rtsp

        return _gen()

    monkeypatch.setattr(external_camera, "_stream_rtsp", _fake_stream_rtsp)

    async def _viewer():
        async for _ in external_camera.generate_mjpeg_stream("rtsp://cam.test/live", "rtsp", 10):
            pass

    task = asyncio.create_task(_viewer())
    await asyncio.wait_for(reading.wait(), timeout=5)
    task.cancel()
    # asyncio.wait, not wait_for: on a regression the loop redials forever,
    # and wait_for would hang waiting for the cancelled task to finish.
    done, _ = await asyncio.wait({task}, timeout=5)
    if not done:
        swallow[0] = False
        task.cancel()
        await asyncio.wait({task}, timeout=5)

    assert done, "the cancelled viewer's stream kept running"
    assert opened == [0], "a cancelled viewer's stream must not open another session"
