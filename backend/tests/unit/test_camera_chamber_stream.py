"""Unit tests for chamber image stream resilience.

Covers the disconnect_event wiring, in-place reconnect after a broken
connection, giving up after bounded attempts, and JPEG payload validation
in read_next_chamber_frame.
"""

import asyncio
import struct

import pytest

import backend.app.api.routes.camera as cam
from backend.app.services.camera import ChamberConnectionClosed, read_next_chamber_frame

VALID_JPEG = b"\xff\xd8" + b"x" * 8 + b"\xff\xd9"


class FakeWriter:
    """Minimal asyncio StreamWriter stand-in."""

    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True

    async def wait_closed(self):
        return None

    def is_closing(self):
        return self.closed


def _feed_chamber_frame(reader: asyncio.StreamReader, payload: bytes) -> None:
    """Feed a chamber-protocol frame (16-byte header + payload) into a reader."""
    header = struct.pack("<I", len(payload)) + b"\x00" * 12
    reader.feed_data(header + payload)


class TestReadNextChamberFrameValidation:
    """JPEG structure validation on the chamber payload."""

    @pytest.mark.asyncio
    async def test_accepts_valid_jpeg(self):
        reader = asyncio.StreamReader()
        _feed_chamber_frame(reader, VALID_JPEG)
        frame = await read_next_chamber_frame(reader, timeout=1.0)
        assert frame == VALID_JPEG

    @pytest.mark.asyncio
    async def test_rejects_payload_without_jpeg_markers(self):
        reader = asyncio.StreamReader()
        _feed_chamber_frame(reader, b"\x00" * 16)
        frame = await read_next_chamber_frame(reader, timeout=1.0)
        assert frame is None  # treated like a timeout — caller retries

    @pytest.mark.asyncio
    async def test_rejects_truncated_jpeg(self):
        reader = asyncio.StreamReader()
        _feed_chamber_frame(reader, b"\xff\xd8" + b"x" * 8)  # missing EOI
        frame = await read_next_chamber_frame(reader, timeout=1.0)
        assert frame is None

    @pytest.mark.asyncio
    async def test_invalid_payload_size_raises(self):
        reader = asyncio.StreamReader()
        reader.feed_data(struct.pack("<I", 0) + b"\x00" * 12)
        with pytest.raises(ChamberConnectionClosed):
            await read_next_chamber_frame(reader, timeout=1.0)


class TestChamberStreamDisconnectEvent:
    """disconnect_event stops the generator and blocks reconnects."""

    @pytest.mark.asyncio
    async def test_disconnect_event_stops_stream(self, monkeypatch):
        ev = asyncio.Event()
        writer = FakeWriter()

        async def fake_connect(ip, code):
            return (object(), writer)

        async def fake_read(reader, timeout=30.0):
            return VALID_JPEG

        monkeypatch.setattr(cam, "generate_chamber_image_stream", fake_connect)
        monkeypatch.setattr(cam, "read_next_chamber_frame", fake_read)

        gen = cam.generate_chamber_mjpeg_stream(
            "1.2.3.4", "code", fps=5, stream_id="7-test", printer_id=7, raw=True, disconnect_event=ev
        )
        first = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
        assert first == VALID_JPEG
        assert cam._disconnect_events.get("7-test") is ev
        assert "7-test" in cam._state.active_chamber_streams

        ev.set()
        with pytest.raises(StopAsyncIteration):
            await asyncio.wait_for(gen.__anext__(), timeout=1.0)

        assert writer.closed
        assert "7-test" not in cam._disconnect_events
        assert "7-test" not in cam._state.active_chamber_streams

    @pytest.mark.asyncio
    async def test_disconnect_during_break_prevents_reconnect(self, monkeypatch):
        ev = asyncio.Event()
        connects = []

        async def fake_connect(ip, code):
            connects.append(1)
            return (object(), FakeWriter())

        async def fake_read(reader, timeout=30.0):
            # Simulate the stop endpoint: event set, then the connection dies
            ev.set()
            raise ChamberConnectionClosed("closed by stop")

        monkeypatch.setattr(cam, "generate_chamber_image_stream", fake_connect)
        monkeypatch.setattr(cam, "read_next_chamber_frame", fake_read)
        monkeypatch.setattr(cam, "_CHAMBER_RECONNECT_DELAYS", (0.0, 0.0, 0.0))

        gen = cam.generate_chamber_mjpeg_stream(
            "1.2.3.4", "code", fps=5, stream_id="8-test", printer_id=8, raw=True, disconnect_event=ev
        )
        with pytest.raises(StopAsyncIteration):
            await asyncio.wait_for(gen.__anext__(), timeout=1.0)
        assert len(connects) == 1  # no reconnect after an intentional stop


class TestChamberStreamReconnect:
    """In-place reconnect keeps the generator alive through network hiccups."""

    @pytest.mark.asyncio
    async def test_reconnects_after_broken_connection(self, monkeypatch):
        writers = []
        reads = {"n": 0}

        async def fake_connect(ip, code):
            writer = FakeWriter()
            writers.append(writer)
            return (object(), writer)

        async def fake_read(reader, timeout=30.0):
            reads["n"] += 1
            if reads["n"] == 1:
                raise ChamberConnectionClosed("wifi blip")
            return VALID_JPEG

        monkeypatch.setattr(cam, "generate_chamber_image_stream", fake_connect)
        monkeypatch.setattr(cam, "read_next_chamber_frame", fake_read)
        monkeypatch.setattr(cam, "_CHAMBER_RECONNECT_DELAYS", (0.0, 0.0, 0.0))

        gen = cam.generate_chamber_mjpeg_stream(
            "1.2.3.4", "code", fps=5, stream_id="9-test", printer_id=9, raw=True
        )
        frame = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
        assert frame == VALID_JPEG
        assert len(writers) == 2  # initial + one reconnect
        assert writers[0].closed  # old connection closed before redial
        # active-streams registry points at the new connection
        assert cam._state.active_chamber_streams["9-test"][1] is writers[1]

        await gen.aclose()
        assert writers[1].closed
        assert "9-test" not in cam._state.active_chamber_streams

    @pytest.mark.asyncio
    async def test_reconnect_after_repeated_timeouts(self, monkeypatch):
        """Three consecutive timeouts count as broken and trigger reconnect."""
        writers = []
        reads = {"n": 0}

        async def fake_connect(ip, code):
            writer = FakeWriter()
            writers.append(writer)
            return (object(), writer)

        async def fake_read(reader, timeout=30.0):
            reads["n"] += 1
            if reads["n"] <= 3:
                return None  # timeout
            return VALID_JPEG

        monkeypatch.setattr(cam, "generate_chamber_image_stream", fake_connect)
        monkeypatch.setattr(cam, "read_next_chamber_frame", fake_read)
        monkeypatch.setattr(cam, "_CHAMBER_RECONNECT_DELAYS", (0.0,))

        gen = cam.generate_chamber_mjpeg_stream("1.2.3.4", "code", fps=5, stream_id="10-test", raw=True)
        frame = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
        assert frame == VALID_JPEG
        assert len(writers) == 2
        await gen.aclose()

    @pytest.mark.asyncio
    async def test_gives_up_after_bounded_attempts(self, monkeypatch):
        connects = {"n": 0}

        async def fake_connect(ip, code):
            connects["n"] += 1
            if connects["n"] == 1:
                return (object(), FakeWriter())
            return None  # every reconnect attempt fails

        async def fake_read(reader, timeout=30.0):
            raise ChamberConnectionClosed("gone")

        monkeypatch.setattr(cam, "generate_chamber_image_stream", fake_connect)
        monkeypatch.setattr(cam, "read_next_chamber_frame", fake_read)
        monkeypatch.setattr(cam, "_CHAMBER_RECONNECT_DELAYS", (0.0, 0.0, 0.0))

        gen = cam.generate_chamber_mjpeg_stream("1.2.3.4", "code", fps=5, stream_id="11-test", raw=True)
        with pytest.raises(StopAsyncIteration):
            await asyncio.wait_for(gen.__anext__(), timeout=1.0)
        assert connects["n"] == 4  # initial + 3 bounded attempts
        assert "11-test" not in cam._state.active_chamber_streams


class TestHubViewerCountAccessor:
    """SharedStreamHub.viewer_count() used by the stop endpoint."""

    def test_zero_for_missing_printer(self):
        hub = cam.SharedStreamHub()
        assert hub.viewer_count(999) == 0

    def test_reflects_entry_viewer_count(self):
        hub = cam.SharedStreamHub()
        entry = cam._SharedStream()
        entry.viewer_count = 3
        hub._streams[1] = entry
        assert hub.viewer_count(1) == 3
