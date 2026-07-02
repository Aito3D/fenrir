"""Integration tests for Camera API endpoints.

Tests the full request/response cycle for /api/v1/printers/{id}/camera/ endpoints.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession


class TestCameraAPI:
    """Integration tests for /api/v1/printers/{id}/camera/ endpoints."""

    # ========================================================================
    # Camera Stop Endpoint
    # ========================================================================

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_stop_camera_stream_get_rejected(self, async_client: AsyncClient, printer_factory):
        """Verify camera stop endpoint rejects GET (CSRF prevention)."""
        printer = await printer_factory()

        response = await async_client.get(f"/api/v1/printers/{printer.id}/camera/stop")
        assert response.status_code in (404, 405)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_stop_camera_stream_post(self, async_client: AsyncClient, printer_factory):
        """Verify camera stop endpoint works with POST method (sendBeacon compatibility)."""
        printer = await printer_factory()

        response = await async_client.post(f"/api/v1/printers/{printer.id}/camera/stop")

        assert response.status_code == 200
        result = response.json()
        assert "stopped" in result
        assert isinstance(result["stopped"], int)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_stop_camera_stream_no_active_streams(self, async_client: AsyncClient, printer_factory):
        """Verify stop returns 0 when no active streams exist."""
        printer = await printer_factory()

        response = await async_client.post(f"/api/v1/printers/{printer.id}/camera/stop")

        assert response.status_code == 200
        assert response.json()["stopped"] == 0

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_stop_camera_stream_with_active_stream(self, async_client: AsyncClient, printer_factory):
        """Verify stop terminates active streams for the printer."""
        printer = await printer_factory()

        # Mock an active stream — wait() must be AsyncMock since it's awaited
        mock_process = MagicMock()
        mock_process.returncode = None
        mock_process.pid = 99999
        mock_process.terminate = MagicMock()
        mock_process.wait = AsyncMock()

        mock_hub = MagicMock()
        mock_hub.is_active.return_value = False

        with (
            patch("backend.app.api.routes.camera._state.active_streams", {f"{printer.id}-abc123": mock_process}),
            patch("backend.app.api.routes.camera._hub", mock_hub),
        ):
            response = await async_client.post(f"/api/v1/printers/{printer.id}/camera/stop")

        assert response.status_code == 200
        assert response.json()["stopped"] == 1
        mock_process.terminate.assert_called_once()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_stop_camera_stream_only_stops_matching_printer(self, async_client: AsyncClient, printer_factory):
        """Verify stop only terminates streams for the specified printer."""
        printer1 = await printer_factory(name="Printer 1")
        printer2 = await printer_factory(name="Printer 2")

        # Mock active streams for both printers — wait() must be AsyncMock since it's awaited
        mock_process1 = MagicMock()
        mock_process1.returncode = None
        mock_process1.pid = 99998
        mock_process1.terminate = MagicMock()
        mock_process1.wait = AsyncMock()

        mock_process2 = MagicMock()
        mock_process2.returncode = None
        mock_process2.pid = 99997
        mock_process2.terminate = MagicMock()
        mock_process2.wait = AsyncMock()

        active_streams = {
            f"{printer1.id}-abc123": mock_process1,
            f"{printer2.id}-def456": mock_process2,
        }

        mock_hub = MagicMock()
        mock_hub.is_active.return_value = False

        with (
            patch("backend.app.api.routes.camera._state.active_streams", active_streams),
            patch("backend.app.api.routes.camera._hub", mock_hub),
        ):
            response = await async_client.post(f"/api/v1/printers/{printer1.id}/camera/stop")

        assert response.status_code == 200
        assert response.json()["stopped"] == 1
        mock_process1.terminate.assert_called_once()
        mock_process2.terminate.assert_not_called()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_stop_camera_stream_handles_fanout_stream_id(self, async_client: AsyncClient, printer_factory):
        """Stop must terminate streams keyed with the deterministic
        ``{printer_id}-fanout`` id used by the fan-out broadcaster (#1089).
        Regression guard against the prefix-match drifting away from the
        broadcaster's stream-id convention.
        """
        printer = await printer_factory()
        mock_process = MagicMock()
        mock_process.returncode = None
        mock_process.pid = 99996
        mock_process.terminate = MagicMock()
        mock_process.wait = AsyncMock()

        from backend.app.api.routes import camera as camera_routes

        with patch.object(
            camera_routes._state,
            "active_streams",
            {f"{printer.id}-fanout": mock_process},
        ):
            response = await async_client.post(f"/api/v1/printers/{printer.id}/camera/stop")

        assert response.status_code == 200
        assert response.json()["stopped"] == 1
        mock_process.terminate.assert_called_once()

    # ========================================================================
    # Camera Test Endpoint
    # ========================================================================

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_test_printer_not_found(self, async_client: AsyncClient):
        """Verify 404 when testing camera for non-existent printer."""
        response = await async_client.get("/api/v1/printers/99999/camera/test")

        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_test_success(self, async_client: AsyncClient, printer_factory):
        """Verify camera test returns success when camera is accessible."""
        printer = await printer_factory()

        with patch("backend.app.api.routes.camera.test_camera_connection", new_callable=AsyncMock) as mock_test:
            mock_test.return_value = {"success": True, "message": "Camera connected"}

            response = await async_client.get(f"/api/v1/printers/{printer.id}/camera/test")

        assert response.status_code == 200
        result = response.json()
        assert result["success"] is True

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_test_failure(self, async_client: AsyncClient, printer_factory):
        """Verify camera test returns failure when camera is not accessible."""
        printer = await printer_factory()

        with patch("backend.app.api.routes.camera.test_camera_connection", new_callable=AsyncMock) as mock_test:
            mock_test.return_value = {"success": False, "message": "Connection timeout"}

            response = await async_client.get(f"/api/v1/printers/{printer.id}/camera/test")

        assert response.status_code == 200
        result = response.json()
        assert result["success"] is False

    # ========================================================================
    # Camera Diagnose Endpoint (#1395 follow-up)
    # ========================================================================

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_diagnose_printer_not_found(self, async_client: AsyncClient):
        response = await async_client.post("/api/v1/printers/99999/camera/diagnose")
        assert response.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_diagnose_returns_structured_result(self, async_client: AsyncClient, printer_factory):
        """Endpoint returns the per-stage shape the frontend modal renders."""
        from backend.app.services.camera_diagnose import (
            CameraDiagnoseResult,
            CameraDiagnoseStage,
        )

        printer = await printer_factory()

        fake = CameraDiagnoseResult(
            printer_id=printer.id,
            protocol="rtsp",
            port=322,
            profile="P2S",
            overall_status="failed",
            stages=[
                CameraDiagnoseStage(name="tcp_reachable", status="ok", duration_ms=12),
                CameraDiagnoseStage(name="first_frame", status="failed", duration_ms=15123, code="no_frame"),
            ],
            summary_code="no_frame",
        )
        with patch(
            "backend.app.services.camera_diagnose.diagnose_camera",
            new_callable=AsyncMock,
            return_value=fake,
        ):
            response = await async_client.post(f"/api/v1/printers/{printer.id}/camera/diagnose")

        assert response.status_code == 200
        body = response.json()
        assert body["printer_id"] == printer.id
        assert body["protocol"] == "rtsp"
        assert body["profile"] == "P2S"
        assert body["overall_status"] == "failed"
        assert body["summary_code"] == "no_frame"
        assert [s["name"] for s in body["stages"]] == ["tcp_reachable", "first_frame"]
        assert body["stages"][1]["code"] == "no_frame"

    # ========================================================================
    # Camera Snapshot Endpoint
    # ========================================================================

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_snapshot_printer_not_found(self, async_client: AsyncClient):
        """Verify 404 when capturing snapshot for non-existent printer."""
        response = await async_client.get("/api/v1/printers/99999/camera/snapshot")

        assert response.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_snapshot_success(self, async_client: AsyncClient, printer_factory):
        """Verify snapshot returns JPEG image when successful."""
        printer = await printer_factory()

        # Create a fake JPEG (starts with FFD8)
        fake_jpeg = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"

        with patch("backend.app.api.routes.camera.capture_camera_frame", new_callable=AsyncMock) as mock_capture:
            mock_capture.return_value = True

            # Mock the file read (uses Path.read_bytes via asyncio.to_thread)
            with (
                patch("pathlib.Path.read_bytes", return_value=fake_jpeg),
                patch("pathlib.Path.exists", return_value=True),
                patch("pathlib.Path.unlink"),
            ):
                response = await async_client.get(f"/api/v1/printers/{printer.id}/camera/snapshot")

        assert response.status_code == 200
        assert response.headers["content-type"] == "image/jpeg"
        assert response.content == fake_jpeg

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_snapshot_failure(self, async_client: AsyncClient, printer_factory):
        """Verify 503 when camera capture fails."""
        printer = await printer_factory()

        with patch("backend.app.api.routes.camera.capture_camera_frame", new_callable=AsyncMock) as mock_capture:
            mock_capture.return_value = False

            with patch("pathlib.Path.exists", return_value=False), patch("pathlib.Path.unlink"):
                response = await async_client.get(f"/api/v1/printers/{printer.id}/camera/snapshot")

        assert response.status_code == 503
        assert "Failed to capture" in response.json()["detail"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_snapshot_reuses_buffered_frame_when_stream_active(
        self, async_client: AsyncClient, printer_factory
    ):
        """#1271: /camera/snapshot must reuse the broadcaster's buffered frame
        when a live stream is running, instead of opening a second concurrent
        RTSP socket. On printers with strict single-connection enforcement (e.g.
        X2D firmware 01.01.00.00) opening a second socket kicks the live stream.
        """
        printer = await printer_factory()
        fake_jpeg = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"

        from backend.app.api.routes import camera as camera_routes

        # Simulate a running producer: one active stream entry + hub-buffered frame.
        active_streams = {f"{printer.id}-fanout": MagicMock()}

        with (
            patch.object(camera_routes._state, "active_streams", active_streams),
            patch.object(camera_routes._hub, "get_last_frame", return_value=fake_jpeg),
            patch("backend.app.api.routes.camera.capture_camera_frame", new_callable=AsyncMock) as mock_capture,
        ):
            response = await async_client.get(f"/api/v1/printers/{printer.id}/camera/snapshot")

        assert response.status_code == 200
        assert response.content == fake_jpeg
        # The fresh-capture path must NOT have been taken — that's the whole point.
        mock_capture.assert_not_called()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_snapshot_external_camera_success(self, async_client: AsyncClient, printer_factory):
        """Verify snapshot uses external camera when configured."""
        printer = await printer_factory(
            external_camera_enabled=True,
            external_camera_url="http://192.168.1.50/mjpeg",
            external_camera_type="mjpeg",
        )

        fake_jpeg = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"

        with patch(
            "backend.app.services.external_camera.capture_frame",
            new_callable=AsyncMock,
            return_value=fake_jpeg,
        ):
            response = await async_client.get(f"/api/v1/printers/{printer.id}/camera/snapshot")

        assert response.status_code == 200
        assert response.headers["content-type"] == "image/jpeg"
        assert response.content == fake_jpeg

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_snapshot_external_camera_failure(self, async_client: AsyncClient, printer_factory):
        """Verify 503 when external camera capture fails."""
        printer = await printer_factory(
            external_camera_enabled=True,
            external_camera_url="http://192.168.1.50/mjpeg",
            external_camera_type="mjpeg",
        )

        with patch(
            "backend.app.services.external_camera.capture_frame",
            new_callable=AsyncMock,
            return_value=None,
        ):
            response = await async_client.get(f"/api/v1/printers/{printer.id}/camera/snapshot")

        assert response.status_code == 503
        assert "external camera" in response.json()["detail"].lower()

    # ========================================================================
    # Camera Stream Endpoint
    # ========================================================================

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_stream_printer_not_found(self, async_client: AsyncClient):
        """Verify 404 when streaming camera for non-existent printer."""
        response = await async_client.get("/api/v1/printers/99999/camera/stream")

        assert response.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_stream_fps_validation(self, async_client: AsyncClient, printer_factory):
        """Verify FPS parameter is validated via Query bounds (ge=1, le=30)."""
        printer = await printer_factory()

        # FPS out of range should be rejected by FastAPI Query validation
        response = await async_client.get(
            f"/api/v1/printers/{printer.id}/camera/stream",
            params={"fps": 100},  # Exceeds le=30
        )
        assert response.status_code == 422

    # ========================================================================
    # Plate Detection Endpoints
    # ========================================================================

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_plate_detection_status_printer_not_found(self, async_client: AsyncClient):
        """Verify 404 when checking plate detection status for non-existent printer."""
        response = await async_client.get("/api/v1/printers/99999/camera/plate-detection/status")

        assert response.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_plate_detection_status_opencv_not_available(self, async_client: AsyncClient, printer_factory):
        """Verify plate detection status returns unavailable when OpenCV not installed."""
        printer = await printer_factory()

        with patch("backend.app.services.plate_detection.OPENCV_AVAILABLE", False):
            response = await async_client.get(f"/api/v1/printers/{printer.id}/camera/plate-detection/status")

        assert response.status_code == 200
        result = response.json()
        assert result["available"] is False
        assert result["calibrated"] is False

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_plate_detection_status_success(self, async_client: AsyncClient, printer_factory):
        """Verify plate detection status returns correctly when OpenCV available."""
        printer = await printer_factory()

        # OpenCV is available in test environment, just check the response structure
        response = await async_client.get(f"/api/v1/printers/{printer.id}/camera/plate-detection/status")

        assert response.status_code == 200
        result = response.json()
        assert "available" in result
        assert "calibrated" in result

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_check_plate_empty_printer_not_found(self, async_client: AsyncClient):
        """Verify 404 when checking plate for non-existent printer."""
        response = await async_client.get("/api/v1/printers/99999/camera/check-plate")

        assert response.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_check_plate_empty_success_structure(self, async_client: AsyncClient, printer_factory):
        """Verify check plate returns proper structure when OpenCV available."""
        printer = await printer_factory()

        # Mock PlateDetectionResult to avoid camera timeout
        mock_result = MagicMock()
        mock_result.is_empty = True
        mock_result.confidence = 0.95
        mock_result.difference_percent = 0.5
        mock_result.message = "Plate appears empty"
        mock_result.needs_calibration = False
        mock_result.debug_image = None
        mock_result.to_dict.return_value = {
            "is_empty": True,
            "confidence": 0.95,
            "difference_percent": 0.5,
            "message": "Plate appears empty",
            "has_debug_image": False,
            "needs_calibration": False,
        }

        # Mock PlateDetector for reference count
        mock_detector = MagicMock()
        mock_detector.get_calibration_count.return_value = 0
        mock_detector.MAX_REFERENCES = 5

        with (
            patch("backend.app.services.plate_detection.is_plate_detection_available", return_value=True),
            patch("backend.app.services.plate_detection.check_plate_empty", new_callable=AsyncMock) as mock_check,
            patch("backend.app.services.plate_detection.PlateDetector", return_value=mock_detector),
        ):
            mock_check.return_value = mock_result
            response = await async_client.get(f"/api/v1/printers/{printer.id}/camera/check-plate")

        assert response.status_code == 200
        result = response.json()
        assert "is_empty" in result
        assert "confidence" in result
        assert "message" in result

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_calibrate_plate_printer_not_found(self, async_client: AsyncClient):
        """Verify 404 when calibrating plate for non-existent printer."""
        response = await async_client.post("/api/v1/printers/99999/camera/plate-detection/calibrate")

        assert response.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_calibrate_plate_success_structure(self, async_client: AsyncClient, printer_factory):
        """Verify calibrate endpoint responds with proper structure."""
        printer = await printer_factory()

        # Mock calibrate_plate at the source module to avoid camera timeout
        with (
            patch("backend.app.services.plate_detection.is_plate_detection_available", return_value=True),
            patch("backend.app.services.plate_detection.calibrate_plate", new_callable=AsyncMock) as mock_calibrate,
        ):
            mock_calibrate.return_value = (True, "Calibration saved (1/5 references)", 0)
            response = await async_client.post(f"/api/v1/printers/{printer.id}/camera/plate-detection/calibrate")

        assert response.status_code == 200
        result = response.json()
        assert result["success"] is True
        assert "index" in result

    # ------------------------------------------------------------------
    # Regression: #1359 — the manual UI check/calibrate routes must derive
    # use_external from the printer's external_camera_enabled setting when
    # the caller omits the flag. Otherwise the UI calibrates against the
    # built-in camera while the runtime auto-check at print start uses the
    # external one, producing a permanent "build plate not empty".
    # ------------------------------------------------------------------

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_check_plate_defaults_use_external_when_external_camera_enabled(
        self, async_client: AsyncClient, printer_factory
    ):
        """Omitting use_external on a printer with external camera enabled
        must call the service with use_external=True."""
        printer = await printer_factory(
            external_camera_enabled=True,
            external_camera_url="http://192.168.1.50/mjpeg",
            external_camera_type="mjpeg",
        )

        mock_result = MagicMock()
        mock_result.to_dict.return_value = {
            "is_empty": True,
            "confidence": 0.95,
            "difference_percent": 0.5,
            "message": "Plate appears empty",
            "has_debug_image": False,
            "needs_calibration": False,
        }
        mock_result.debug_image = None

        mock_detector = MagicMock()
        mock_detector.get_calibration_count.return_value = 0
        mock_detector.MAX_REFERENCES = 5

        with (
            patch("backend.app.services.plate_detection.is_plate_detection_available", return_value=True),
            patch("backend.app.services.plate_detection.check_plate_empty", new_callable=AsyncMock) as mock_check,
            patch("backend.app.services.plate_detection.PlateDetector", return_value=mock_detector),
        ):
            mock_check.return_value = mock_result
            response = await async_client.get(f"/api/v1/printers/{printer.id}/camera/check-plate")

        assert response.status_code == 200
        assert mock_check.await_args.kwargs["use_external"] is True

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_check_plate_defaults_use_external_false_when_external_camera_disabled(
        self, async_client: AsyncClient, printer_factory
    ):
        """Omitting use_external on a printer without an external camera
        must call the service with use_external=False (built-in)."""
        printer = await printer_factory()  # external_camera_enabled defaults to False

        mock_result = MagicMock()
        mock_result.to_dict.return_value = {
            "is_empty": True,
            "confidence": 0.95,
            "difference_percent": 0.5,
            "message": "Plate appears empty",
            "has_debug_image": False,
            "needs_calibration": False,
        }
        mock_result.debug_image = None

        mock_detector = MagicMock()
        mock_detector.get_calibration_count.return_value = 0
        mock_detector.MAX_REFERENCES = 5

        with (
            patch("backend.app.services.plate_detection.is_plate_detection_available", return_value=True),
            patch("backend.app.services.plate_detection.check_plate_empty", new_callable=AsyncMock) as mock_check,
            patch("backend.app.services.plate_detection.PlateDetector", return_value=mock_detector),
        ):
            mock_check.return_value = mock_result
            response = await async_client.get(f"/api/v1/printers/{printer.id}/camera/check-plate")

        assert response.status_code == 200
        assert mock_check.await_args.kwargs["use_external"] is False

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_calibrate_plate_defaults_use_external_when_external_camera_enabled(
        self, async_client: AsyncClient, printer_factory
    ):
        """Calibrating with use_external omitted on an external-camera-enabled
        printer captures the reference from the external camera — matching
        what the runtime check at print start will compare against (#1359)."""
        printer = await printer_factory(
            external_camera_enabled=True,
            external_camera_url="http://192.168.1.50/mjpeg",
            external_camera_type="mjpeg",
        )

        with (
            patch("backend.app.services.plate_detection.is_plate_detection_available", return_value=True),
            patch("backend.app.services.plate_detection.calibrate_plate", new_callable=AsyncMock) as mock_calibrate,
        ):
            mock_calibrate.return_value = (True, "Calibration saved (1/5 references)", 0)
            response = await async_client.post(f"/api/v1/printers/{printer.id}/camera/plate-detection/calibrate")

        assert response.status_code == 200
        assert mock_calibrate.await_args.kwargs["use_external"] is True

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_calibrate_plate_explicit_use_external_false_overrides_default(
        self, async_client: AsyncClient, printer_factory
    ):
        """An explicit use_external=false from the caller still wins even
        when the printer has an external camera configured, so power users
        can force a built-in-camera reference if they ever need to."""
        printer = await printer_factory(
            external_camera_enabled=True,
            external_camera_url="http://192.168.1.50/mjpeg",
            external_camera_type="mjpeg",
        )

        with (
            patch("backend.app.services.plate_detection.is_plate_detection_available", return_value=True),
            patch("backend.app.services.plate_detection.calibrate_plate", new_callable=AsyncMock) as mock_calibrate,
        ):
            mock_calibrate.return_value = (True, "Calibration saved (1/5 references)", 0)
            response = await async_client.post(
                f"/api/v1/printers/{printer.id}/camera/plate-detection/calibrate?use_external=false"
            )

        assert response.status_code == 200
        assert mock_calibrate.await_args.kwargs["use_external"] is False

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_delete_calibration_printer_not_found(self, async_client: AsyncClient):
        """Verify 404 when deleting calibration for non-existent printer."""
        response = await async_client.delete("/api/v1/printers/99999/camera/plate-detection/calibrate")

        assert response.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_delete_calibration_success(self, async_client: AsyncClient, printer_factory):
        """Verify delete calibration returns proper structure."""
        printer = await printer_factory()

        with patch("backend.app.services.plate_detection.is_plate_detection_available", return_value=True):
            response = await async_client.delete(f"/api/v1/printers/{printer.id}/camera/plate-detection/calibrate")

        assert response.status_code == 200
        result = response.json()
        assert "success" in result
        assert "message" in result

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_references_printer_not_found(self, async_client: AsyncClient):
        """Verify 404 when getting references for non-existent printer."""
        response = await async_client.get("/api/v1/printers/99999/camera/plate-detection/references")

        assert response.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_references_opencv_not_available(self, async_client: AsyncClient, printer_factory):
        """Verify get references returns unavailable when OpenCV not installed."""
        printer = await printer_factory()

        with patch("backend.app.services.plate_detection.OPENCV_AVAILABLE", False):
            response = await async_client.get(f"/api/v1/printers/{printer.id}/camera/plate-detection/references")

        assert response.status_code == 503

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_references_success(self, async_client: AsyncClient, printer_factory):
        """Verify get references returns proper structure."""
        printer = await printer_factory()

        # Mock OpenCV availability and PlateDetector
        mock_detector = MagicMock()
        mock_detector.get_references.return_value = []
        mock_detector.MAX_REFERENCES = 5

        with (
            patch("backend.app.services.plate_detection.is_plate_detection_available", return_value=True),
            patch("backend.app.services.plate_detection.PlateDetector", return_value=mock_detector),
        ):
            response = await async_client.get(f"/api/v1/printers/{printer.id}/camera/plate-detection/references")

        assert response.status_code == 200
        result = response.json()
        assert "references" in result
        assert "max_references" in result
        assert isinstance(result["references"], list)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_reference_label_printer_not_found(self, async_client: AsyncClient):
        """Verify 404 when updating reference label for non-existent printer."""
        response = await async_client.put(
            "/api/v1/printers/99999/camera/plate-detection/references/0", json={"label": "New Label"}
        )

        assert response.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_delete_reference_printer_not_found(self, async_client: AsyncClient):
        """Verify 404 when deleting reference for non-existent printer."""
        response = await async_client.delete("/api/v1/printers/99999/camera/plate-detection/references/0")

        assert response.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_reference_thumbnail_printer_not_found(self, async_client: AsyncClient):
        """Verify 404 when getting reference thumbnail for non-existent printer."""
        response = await async_client.get("/api/v1/printers/99999/camera/plate-detection/references/0/thumbnail")

        assert response.status_code == 404

    # ========================================================================
    # USB Camera Endpoint
    # ========================================================================

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_list_usb_cameras_returns_list(self, async_client: AsyncClient):
        """Verify USB cameras endpoint returns a list of cameras."""
        response = await async_client.get("/api/v1/printers/usb-cameras")

        assert response.status_code == 200
        result = response.json()
        assert "cameras" in result
        assert isinstance(result["cameras"], list)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_list_usb_cameras_structure(self, async_client: AsyncClient):
        """Verify USB cameras endpoint returns proper structure for each camera."""
        with patch("backend.app.services.external_camera.list_usb_cameras") as mock_list:
            mock_list.return_value = [
                {"device": "/dev/video0", "name": "Logitech Webcam C920", "index": 0},
                {"device": "/dev/video2", "name": "USB Camera", "index": 2},
            ]

            response = await async_client.get("/api/v1/printers/usb-cameras")

        assert response.status_code == 200
        result = response.json()
        assert len(result["cameras"]) == 2
        assert result["cameras"][0]["device"] == "/dev/video0"
        assert result["cameras"][0]["name"] == "Logitech Webcam C920"
        assert result["cameras"][1]["device"] == "/dev/video2"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_list_usb_cameras_empty_on_non_linux(self, async_client: AsyncClient):
        """Verify USB cameras endpoint returns empty list on non-Linux systems."""
        with patch("backend.app.services.external_camera.list_usb_cameras") as mock_list:
            # Simulate non-Linux system (no /dev/video* devices)
            mock_list.return_value = []

            response = await async_client.get("/api/v1/printers/usb-cameras")

        assert response.status_code == 200
        result = response.json()
        assert result["cameras"] == []


class TestCameraGridStreamValidation:
    """Tests for /api/v1/printers/camera/grid-stream input validation."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_rejects_nan_scale(self, async_client: AsyncClient):
        response = await async_client.get("/api/v1/printers/camera/grid-stream", params={"ids": "1", "scale": "NaN"})
        assert response.status_code == 422

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_rejects_inf_scale(self, async_client: AsyncClient):
        response = await async_client.get(
            "/api/v1/printers/camera/grid-stream", params={"ids": "1", "scale": "Infinity"}
        )
        assert response.status_code == 422

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_rejects_non_integer_ids(self, async_client: AsyncClient):
        response = await async_client.get(
            "/api/v1/printers/camera/grid-stream", params={"ids": "abc,def", "scale": "0.5"}
        )
        assert response.status_code == 400
        assert "integers" in response.json()["detail"].lower()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_rejects_empty_ids(self, async_client: AsyncClient):
        response = await async_client.get("/api/v1/printers/camera/grid-stream", params={"ids": "", "scale": "0.5"})
        assert response.status_code == 400
        assert "no printer" in response.json()["detail"].lower()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_rejects_more_than_30_unique_ids(self, async_client: AsyncClient):
        ids = ",".join(str(i) for i in range(1, 32))  # 31 unique IDs
        response = await async_client.get("/api/v1/printers/camera/grid-stream", params={"ids": ids, "scale": "0.5"})
        assert response.status_code == 400
        assert "30" in response.json()["detail"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_deduplicates_ids(self, async_client: AsyncClient):
        """Verify duplicate IDs are deduplicated before reaching get_existing_batch."""
        captured_ids = []

        async def mock_batch(printer_ids):
            captured_ids.extend(printer_ids)
            return {}, printer_ids  # All missing

        with patch("backend.app.api.routes.camera._hub.get_existing_batch", side_effect=mock_batch):
            await async_client.get("/api/v1/printers/camera/grid-stream", params={"ids": "1,2,1,2,1", "scale": "0.5"})

        assert captured_ids == [1, 2]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_dedup_before_limit_check(self, async_client: AsyncClient):
        """35 IDs with only 25 unique should pass the 30-ID limit check."""
        base_ids = list(range(1, 26))  # 25 unique
        ids_with_dupes = base_ids + base_ids[:10]  # 35 total, 25 unique
        ids_str = ",".join(str(i) for i in ids_with_dupes)

        captured_ids = []

        async def mock_batch(printer_ids):
            captured_ids.extend(printer_ids)
            return {}, printer_ids

        with patch("backend.app.api.routes.camera._hub.get_existing_batch", side_effect=mock_batch):
            response = await async_client.get(
                "/api/v1/printers/camera/grid-stream", params={"ids": ids_str, "scale": "0.5"}
            )

        # Should NOT get 400 "Maximum 30" — dedup happened first
        assert response.status_code != 400


class TestCameraStreamValidation:
    """Tests for single-stream scale validation at /{id}/camera/stream."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_rejects_nan_scale(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()
        response = await async_client.get(f"/api/v1/printers/{printer.id}/camera/stream", params={"scale": "NaN"})
        assert response.status_code == 422

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_rejects_inf_scale(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()
        response = await async_client.get(f"/api/v1/printers/{printer.id}/camera/stream", params={"scale": "Infinity"})
        assert response.status_code == 422


class TestCameraEndpointAuth:
    """Tests that snapshot and thumbnail endpoints have auth dependencies."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_snapshot_has_auth_dependency(self, async_client: AsyncClient, printer_factory):
        """With auth disabled (default test config), snapshot should work (503 from mock, not 401)."""
        printer = await printer_factory()
        with patch("backend.app.api.routes.camera.capture_camera_frame", new_callable=AsyncMock) as mock_capture:
            mock_capture.return_value = False
            with patch("pathlib.Path.exists", return_value=False), patch("pathlib.Path.unlink"):
                response = await async_client.get(f"/api/v1/printers/{printer.id}/camera/snapshot")
        # 503 means we got past auth (it would be 401/403 if auth blocked us)
        assert response.status_code == 503

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_thumbnail_has_auth_dependency(self, async_client: AsyncClient, printer_factory):
        """With auth disabled, thumbnail should work (404 from missing reference, not 401)."""
        printer = await printer_factory()
        with patch("backend.app.services.plate_detection.is_plate_detection_available", return_value=True):
            response = await async_client.get(
                f"/api/v1/printers/{printer.id}/camera/plate-detection/references/0/thumbnail"
            )
        # 404 means we got past auth
        assert response.status_code == 404


class TestCameraEndpointAuthEnabled:
    """Tests that camera endpoints enforce auth when auth is enabled."""

    @pytest.fixture
    async def _enable_auth(self, async_client: AsyncClient):
        """Enable auth and create an admin user. Returns auth token."""
        response = await async_client.post(
            "/api/v1/auth/setup",
            json={
                "auth_enabled": True,
                "admin_username": "camtest",
                "admin_password": "TestPass1!",
            },
        )
        assert response.status_code == 200
        # Login to get token
        login = await async_client.post(
            "/api/v1/auth/login",
            json={"username": "camtest", "password": "TestPass1!"},
        )
        return login.json().get("access_token")

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_grid_stream_unauthenticated(self, async_client: AsyncClient, _enable_auth):
        """Verify unauthenticated GET /camera/grid-stream returns 401/403."""
        response = await async_client.get("/api/v1/printers/camera/grid-stream", params={"ids": "1"})
        assert response.status_code in (401, 403)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_stream_unauthenticated(self, async_client: AsyncClient, printer_factory, _enable_auth):
        """Verify unauthenticated GET /{id}/camera/stream returns 401/403."""
        printer = await printer_factory()
        response = await async_client.get(f"/api/v1/printers/{printer.id}/camera/stream")
        assert response.status_code in (401, 403)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_snapshot_unauthenticated(self, async_client: AsyncClient, printer_factory, _enable_auth):
        """Verify unauthenticated GET /{id}/camera/snapshot returns 401/403."""
        printer = await printer_factory()
        response = await async_client.get(f"/api/v1/printers/{printer.id}/camera/snapshot")
        assert response.status_code in (401, 403)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_grid_stream_authenticated(self, async_client: AsyncClient, _enable_auth):
        """Verify authenticated GET /camera/grid-stream passes auth (returns 400 for missing printers, not 401)."""
        token = _enable_auth
        response = await async_client.get(
            "/api/v1/printers/camera/grid-stream",
            params={"ids": "99999"},
            headers={"Authorization": f"Bearer {token}"},
        )
        # Should pass auth — expect 400 (no printer IDs found) or similar, not 401
        assert response.status_code not in (401, 403)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_camera_snapshot_authenticated(self, async_client: AsyncClient, printer_factory, _enable_auth):
        """Verify authenticated snapshot request passes auth via camera stream token."""
        token = _enable_auth
        printer = await printer_factory()
        # The snapshot endpoint requires a camera stream token (?token=xxx), not a Bearer JWT.
        # Obtain one using the regular Bearer token first.
        stream_token_resp = await async_client.post(
            "/api/v1/printers/camera/stream-token",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert stream_token_resp.status_code == 200
        stream_token = stream_token_resp.json()["token"]
        with patch("backend.app.api.routes.camera.capture_camera_frame", new_callable=AsyncMock) as mock_capture:
            mock_capture.return_value = False
            with patch("pathlib.Path.exists", return_value=False), patch("pathlib.Path.unlink"):
                response = await async_client.get(
                    f"/api/v1/printers/{printer.id}/camera/snapshot",
                    params={"token": stream_token},
                )
        # 503 means we got past auth
        assert response.status_code == 503
