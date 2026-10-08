"""WS /printers/{id}/camera/mse — go2rtc MSE relay for viewers that cannot
reach go2rtc's WebRTC media port.

go2rtc answers a WebRTC offer with host candidates only (its LAN addresses on
:8555). A browser that reaches Fenrir through an HTTP-only path — a Cloudflare
tunnel, a reverse proxy on another network — gets the SDP answer over HTTP and
then can never connect the media, so every go2rtc tile spun forever while the
chamber-image printers (MJPEG over HTTP) kept working. This route carries
go2rtc's MSE stream (fragmented MP4 over WebSocket) over the same origin as the
rest of the app, so it rides whatever carries the HTTP.

Pinned here:
- the camera stream token gate runs before ``accept()`` (4401, like /ws);
- go2rtc not ready / unknown printer / non-RTSP model close before accept;
- only ``{"type": "mse"}`` requests reach go2rtc, and its frames come back
  byte-for-byte.
"""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import WebSocketDisconnect
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.api.routes import camera as camera_route
from backend.app.core.printer_scope import ALL_PRINTERS


class _FakeClient:
    """The browser side: a queue of inbound messages, recorded outbound ones."""

    def __init__(self, inbound: list[dict]):
        self._inbound = list(inbound)
        self.accept = AsyncMock()
        self.close = AsyncMock()
        self.sent_bytes: list[bytes] = []
        self.sent_text: list[str] = []
        self.all_sent = asyncio.Event()

    async def receive(self) -> dict:
        if self._inbound:
            return self._inbound.pop(0)
        # Hold the socket open until the upstream side has delivered.
        await self.all_sent.wait()
        return {"type": "websocket.disconnect", "code": 1000}

    async def send_bytes(self, data: bytes) -> None:
        self.sent_bytes.append(data)

    async def send_text(self, data: str) -> None:
        self.sent_text.append(data)


class _FakeUpstream:
    """go2rtc's /api/ws: replays scripted frames once the MSE request arrives."""

    def __init__(self, frames: list[bytes | str], client: _FakeClient):
        self._frames = frames
        self._client = client
        self.received: list[str | bytes] = []
        self._requested = asyncio.Event()

    async def send(self, message: str | bytes) -> None:
        self.received.append(message)
        self._requested.set()

    def __aiter__(self):
        return self._iter()

    async def _iter(self):
        await self._requested.wait()
        for frame in self._frames:
            yield frame
        self._client.all_sent.set()
        # Stay open until the relay cancels us, like a live stream.
        await asyncio.Event().wait()


def _mse_request() -> dict:
    return {"type": "websocket.receive", "text": json.dumps({"type": "mse", "value": "avc1.640029"})}


@pytest.fixture
def ready_go2rtc(monkeypatch):
    svc = MagicMock()
    svc.ready = True
    svc.ensure_stream = AsyncMock(return_value=ALL_PRINTERS)
    svc.ws_url = MagicMock(side_effect=lambda name: f"ws://go2rtc/api/ws?src={name}")
    monkeypatch.setattr(camera_route, "go2rtc_service", svc)
    return svc


@pytest.fixture
def session_maker(monkeypatch, test_engine):
    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(camera_route, "async_session", maker)
    return maker


def _open_upstream(monkeypatch, upstream):
    opened: list[str] = []

    class _Ctx:
        def __init__(self, url, **_kwargs):
            opened.append(url)

        async def __aenter__(self):
            return upstream

        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr(camera_route, "_open_go2rtc_ws", _Ctx)
    return opened


@pytest.mark.asyncio
async def test_refuses_before_accept_without_a_token_when_auth_is_on(
    monkeypatch, session_maker, ready_go2rtc, printer_factory
):
    printer = await printer_factory(model="H2D")
    monkeypatch.setattr(camera_route, "is_auth_enabled", AsyncMock(return_value=ALL_PRINTERS))
    verify = AsyncMock(return_value=ALL_PRINTERS)
    monkeypatch.setattr(camera_route, "verify_camera_stream_token", verify)
    client = _FakeClient([])

    await camera_route.camera_mse_stream(client, printer.id, token=None)

    client.close.assert_awaited_once_with(code=4401)
    client.accept.assert_not_awaited()
    ready_go2rtc.ensure_stream.assert_not_awaited()


@pytest.mark.asyncio
async def test_refuses_before_accept_with_an_invalid_token(monkeypatch, session_maker, ready_go2rtc, printer_factory):
    printer = await printer_factory(model="H2D")
    monkeypatch.setattr(camera_route, "is_auth_enabled", AsyncMock(return_value=ALL_PRINTERS))
    monkeypatch.setattr(camera_route, "verify_camera_stream_token", AsyncMock(return_value=None))
    client = _FakeClient([])

    await camera_route.camera_mse_stream(client, printer.id, token="stale")

    client.close.assert_awaited_once_with(code=4401)
    client.accept.assert_not_awaited()


@pytest.mark.asyncio
async def test_closes_before_accept_when_go2rtc_is_not_ready(monkeypatch, session_maker, printer_factory):
    printer = await printer_factory(model="H2D")
    monkeypatch.setattr(camera_route, "is_auth_enabled", AsyncMock(return_value=None))
    svc = MagicMock()
    svc.ready = False
    svc.ensure_stream = AsyncMock()
    monkeypatch.setattr(camera_route, "go2rtc_service", svc)
    client = _FakeClient([])

    await camera_route.camera_mse_stream(client, printer.id, token=None)

    client.close.assert_awaited_once()
    client.accept.assert_not_awaited()
    svc.ensure_stream.assert_not_awaited()


@pytest.mark.asyncio
async def test_closes_before_accept_for_a_chamber_image_model(
    monkeypatch, session_maker, ready_go2rtc, printer_factory
):
    printer = await printer_factory(model="A1")
    monkeypatch.setattr(camera_route, "is_auth_enabled", AsyncMock(return_value=None))
    client = _FakeClient([])

    await camera_route.camera_mse_stream(client, printer.id, token=None)

    client.close.assert_awaited_once()
    client.accept.assert_not_awaited()
    ready_go2rtc.ensure_stream.assert_not_awaited()


@pytest.mark.asyncio
async def test_closes_before_accept_for_an_unknown_printer(monkeypatch, session_maker, ready_go2rtc):
    monkeypatch.setattr(camera_route, "is_auth_enabled", AsyncMock(return_value=None))
    client = _FakeClient([])

    await camera_route.camera_mse_stream(client, 99999, token=None)

    client.close.assert_awaited_once()
    client.accept.assert_not_awaited()


@pytest.mark.asyncio
async def test_relays_the_mse_request_up_and_the_frames_down(monkeypatch, session_maker, ready_go2rtc, printer_factory):
    printer = await printer_factory(model="H2D")
    monkeypatch.setattr(camera_route, "is_auth_enabled", AsyncMock(return_value=ALL_PRINTERS))
    monkeypatch.setattr(camera_route, "verify_camera_stream_token", AsyncMock(return_value=ALL_PRINTERS))
    client = _FakeClient([_mse_request()])
    codec_msg = json.dumps({"type": "mse", "value": 'video/mp4; codecs="avc1.640029"'})
    upstream = _FakeUpstream([codec_msg, b"\x00init", b"\x00seg1"], client)
    opened = _open_upstream(monkeypatch, upstream)

    await asyncio.wait_for(camera_route.camera_mse_stream(client, printer.id, token="good"), timeout=5)

    ready_go2rtc.ensure_stream.assert_awaited_once()
    assert opened == [f"ws://go2rtc/api/ws?src=printer_{printer.id}"]
    client.accept.assert_awaited_once()
    assert upstream.received == [_mse_request()["text"]]
    assert client.sent_text == [codec_msg]
    assert client.sent_bytes == [b"\x00init", b"\x00seg1"]


@pytest.mark.asyncio
async def test_drops_client_messages_other_than_an_mse_request(
    monkeypatch, session_maker, ready_go2rtc, printer_factory
):
    """go2rtc's /api/ws also speaks webrtc/offer, hls, mp4, mjpeg… — the relay
    exists to carry MSE, so nothing else from the browser reaches it."""
    printer = await printer_factory(model="X1C")
    monkeypatch.setattr(camera_route, "is_auth_enabled", AsyncMock(return_value=None))
    client = _FakeClient(
        [
            {"type": "websocket.receive", "text": json.dumps({"type": "webrtc/offer", "value": "v=0"})},
            {"type": "websocket.receive", "text": "not json"},
            {"type": "websocket.receive", "bytes": b"\x01\x02"},
            _mse_request(),
        ]
    )
    upstream = _FakeUpstream([b"\x00init"], client)
    _open_upstream(monkeypatch, upstream)

    await asyncio.wait_for(camera_route.camera_mse_stream(client, printer.id, token=None), timeout=5)

    assert upstream.received == [_mse_request()["text"]]
    assert client.sent_bytes == [b"\x00init"]


@pytest.mark.asyncio
async def test_closes_the_client_when_go2rtc_refuses_the_socket(
    monkeypatch, session_maker, ready_go2rtc, printer_factory
):
    printer = await printer_factory(model="H2D")
    monkeypatch.setattr(camera_route, "is_auth_enabled", AsyncMock(return_value=None))

    class _Refused:
        def __init__(self, url, **_kwargs):
            pass

        async def __aenter__(self):
            raise OSError("connection refused")

        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr(camera_route, "_open_go2rtc_ws", _Refused)
    client = _FakeClient([])

    await camera_route.camera_mse_stream(client, printer.id, token=None)

    client.close.assert_awaited()
    client.accept.assert_not_awaited()


@pytest.mark.asyncio
async def test_a_client_that_disconnects_mid_stream_ends_the_relay(
    monkeypatch, session_maker, ready_go2rtc, printer_factory
):
    printer = await printer_factory(model="H2D")
    monkeypatch.setattr(camera_route, "is_auth_enabled", AsyncMock(return_value=None))
    client = _FakeClient([_mse_request()])

    async def _raise_disconnect():
        raise WebSocketDisconnect(code=1001)

    client.receive = _raise_disconnect
    upstream = _FakeUpstream([], client)
    _open_upstream(monkeypatch, upstream)

    await asyncio.wait_for(camera_route.camera_mse_stream(client, printer.id, token=None), timeout=5)

    client.accept.assert_awaited_once()
