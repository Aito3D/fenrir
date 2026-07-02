"""Tests for the go2rtc service."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from backend.app.services.go2rtc import Go2RTCService


class TestGo2RTCService:
    """Test Go2RTCService lifecycle and API interactions."""

    def test_initial_state(self):
        svc = Go2RTCService()
        assert svc.running is False
        assert svc.ready is False
        assert svc.api_url == "http://127.0.0.1:1984"

    @pytest.mark.asyncio
    async def test_start_no_binary(self):
        """start() should log warning and return when binary not found."""
        svc = Go2RTCService()
        with patch.object(svc, "_find_binary", return_value=None):
            await svc.start()
        assert svc.running is False

    @pytest.mark.asyncio
    async def test_stop_idempotent(self):
        """stop() should not raise when called on a non-running service."""
        svc = Go2RTCService()
        await svc.stop()  # should not raise

    @pytest.mark.asyncio
    async def test_ensure_stream_not_running(self):
        """ensure_stream returns False when service is not running."""
        svc = Go2RTCService()
        result = await svc.ensure_stream(1, "rtsp://example.com/stream")
        assert result is False

    @pytest.mark.asyncio
    async def test_webrtc_offer_not_running(self):
        """webrtc_offer returns None when service is not running."""
        svc = Go2RTCService()
        result = await svc.webrtc_offer("printer_1", "v=0\r\n...")
        assert result is None

    @pytest.mark.asyncio
    async def test_ensure_stream_success(self):
        """ensure_stream returns True on 200 response."""
        svc = Go2RTCService()
        svc._process = MagicMock(returncode=None)
        svc._api_ready = True
        svc._client = AsyncMock(spec=httpx.AsyncClient)
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        svc._client.put = AsyncMock(return_value=mock_resp)

        result = await svc.ensure_stream(42, "rtsp://cam/stream")
        assert result is True
        svc._client.put.assert_called_once()

    @pytest.mark.asyncio
    async def test_ensure_stream_failure(self):
        """ensure_stream returns False on non-200 response."""
        svc = Go2RTCService()
        svc._process = MagicMock(returncode=None)
        svc._api_ready = True
        svc._client = AsyncMock(spec=httpx.AsyncClient)
        mock_resp = MagicMock()
        mock_resp.status_code = 500
        mock_resp.text = "internal error"
        svc._client.put = AsyncMock(return_value=mock_resp)

        result = await svc.ensure_stream(1, "rtsp://cam/stream")
        assert result is False

    @pytest.mark.asyncio
    async def test_webrtc_offer_success(self):
        """webrtc_offer returns SDP answer on 200 response."""
        svc = Go2RTCService()
        svc._process = MagicMock(returncode=None)
        svc._api_ready = True
        svc._client = AsyncMock(spec=httpx.AsyncClient)
        answer = {"sdp": "v=0\r\n...", "type": "answer"}
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = answer
        svc._client.post = AsyncMock(return_value=mock_resp)

        result = await svc.webrtc_offer("printer_1", "v=0\r\noffer")
        assert result == answer

    @pytest.mark.asyncio
    async def test_webrtc_offer_http_error(self):
        """webrtc_offer returns None on HTTP error."""
        svc = Go2RTCService()
        svc._process = MagicMock(returncode=None)
        svc._api_ready = True
        svc._client = AsyncMock(spec=httpx.AsyncClient)
        svc._client.post = AsyncMock(side_effect=httpx.ConnectError("refused"))

        result = await svc.webrtc_offer("printer_1", "v=0\r\noffer")
        assert result is None

    @pytest.mark.asyncio
    async def test_remove_stream(self):
        """remove_stream calls delete on client."""
        svc = Go2RTCService()
        svc._process = MagicMock(returncode=None)
        svc._api_ready = True
        svc._client = AsyncMock(spec=httpx.AsyncClient)
        svc._client.delete = AsyncMock()

        await svc.remove_stream(42)
        svc._client.delete.assert_called_once()

    def test_find_binary_uses_shutil_which(self):
        svc = Go2RTCService()
        with patch("shutil.which", return_value="/usr/bin/go2rtc"):
            assert svc._find_binary() == "/usr/bin/go2rtc"

    def test_find_binary_returns_none(self):
        svc = Go2RTCService()
        with patch("shutil.which", return_value=None), patch("pathlib.Path.is_file", return_value=False):
            assert svc._find_binary() is None
