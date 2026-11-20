"""The "Check printer firmware" setting is enforced by the API, not only the UI.

The printers page asked before its settings had loaded, so with the check
switched off Fenrir still went out to bambulab.com once per printer on every
page load. Off has to mean no request at all.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient

from backend.app.models.settings import Settings

UPDATE = {
    "update_available": True,
    "latest_version": "01.09.00.00",
    "download_url": "https://example.com/fw.bin",
    "release_notes": None,
    "available_versions": [],
}


def _service() -> MagicMock:
    service = MagicMock()
    service.check_for_update = AsyncMock(return_value=UPDATE)
    return service


async def _switch_off(db) -> None:
    db.add(Settings(key="check_printer_firmware", value="false"))
    await db.commit()


@pytest.mark.integration
class TestFirmwareCheckSetting:
    @pytest.mark.asyncio
    async def test_on_by_default(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()
        service = _service()
        with patch("backend.app.api.routes.firmware.get_firmware_service", return_value=service):
            r = await async_client.get(f"/api/v1/firmware/updates/{printer.id}")
        assert r.status_code == 200, r.text
        assert r.json()["update_available"] is True
        service.check_for_update.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_off_asks_nobody(self, async_client: AsyncClient, db_session, printer_factory):
        printer = await printer_factory(name="Garage")
        await _switch_off(db_session)
        service = _service()
        with patch("backend.app.api.routes.firmware.get_firmware_service", return_value=service):
            r = await async_client.get(f"/api/v1/firmware/updates/{printer.id}")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["printer_id"] == printer.id and body["printer_name"] == "Garage"
        assert body["update_available"] is False and body["latest_version"] is None
        service.check_for_update.assert_not_called()

    @pytest.mark.asyncio
    async def test_off_still_404s_an_unknown_printer(self, async_client: AsyncClient, db_session):
        await _switch_off(db_session)
        assert (await async_client.get("/api/v1/firmware/updates/9999")).status_code == 404

    @pytest.mark.asyncio
    async def test_off_covers_the_all_printers_check(self, async_client: AsyncClient, db_session, printer_factory):
        await printer_factory()
        await printer_factory()
        await _switch_off(db_session)
        service = _service()
        with patch("backend.app.api.routes.firmware.get_firmware_service", return_value=service):
            r = await async_client.get("/api/v1/firmware/updates")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["updates_available"] == 0
        assert len(body["updates"]) == 2
        assert all(u["update_available"] is False for u in body["updates"])
        service.check_for_update.assert_not_called()


def _update_service(prepare: dict, started: bool = True) -> MagicMock:
    service = MagicMock()
    service.prepare_update = AsyncMock(return_value=prepare)
    service.start_upload = AsyncMock(return_value=started)
    return service


_OK_PREPARE = {"can_proceed": True, "errors": []}


@pytest.mark.integration
class TestStartFirmwareUploadRoute:
    URL = "/api/v1/firmware/updates/{}/upload"

    @pytest.mark.asyncio
    async def test_prepare_endpoint_returns_service_result(self, async_client: AsyncClient):
        result = {
            "can_proceed": True,
            "sd_card_present": True,
            "sd_card_free_space": 1,
            "firmware_size": 2,
            "space_sufficient": True,
            "update_available": True,
            "current_version": "1",
            "latest_version": "2",
            "target_version": "2",
            "firmware_filename": "fw.bin",
            "errors": [],
        }
        service = _update_service(result)
        with patch("backend.app.api.routes.firmware.get_firmware_update_service", return_value=service):
            r = await async_client.get("/api/v1/firmware/updates/3/prepare?version=2")
        assert r.status_code == 200, r.text
        assert r.json()["firmware_filename"] == "fw.bin"
        service.prepare_update.assert_awaited_once()
        assert service.prepare_update.await_args.kwargs == {"target_version": "2"}

    @pytest.mark.asyncio
    async def test_cannot_proceed_is_400_with_joined_errors(self, async_client: AsyncClient):
        service = _update_service({"can_proceed": False, "errors": ["No SD card", "Busy"]})
        with patch("backend.app.api.routes.firmware.get_firmware_update_service", return_value=service):
            r = await async_client.post(self.URL.format(3))
        assert r.status_code == 400
        assert r.json()["detail"] == "No SD card; Busy"
        service.start_upload.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_cannot_proceed_without_errors_uses_default_detail(self, async_client: AsyncClient):
        service = _update_service({"can_proceed": False})
        with patch("backend.app.api.routes.firmware.get_firmware_update_service", return_value=service):
            r = await async_client.post(self.URL.format(3))
        assert r.status_code == 400
        assert r.json()["detail"] == "Cannot proceed with firmware upload"

    @pytest.mark.asyncio
    async def test_started(self, async_client: AsyncClient):
        service = _update_service(_OK_PREPARE)
        with patch("backend.app.api.routes.firmware.get_firmware_update_service", return_value=service):
            r = await async_client.post(self.URL.format(3) + "?version=01.02")
        assert r.status_code == 200, r.text
        assert r.json()["started"] is True
        assert service.start_upload.await_args.kwargs == {"target_version": "01.02"}

    @pytest.mark.asyncio
    async def test_not_started_while_downloading_is_200_false(self, async_client: AsyncClient):
        from backend.app.services.firmware_update import FirmwareUploadStatus, get_upload_state

        state = get_upload_state(31)
        state.status = FirmwareUploadStatus.DOWNLOADING
        service = _update_service(_OK_PREPARE, started=False)
        try:
            with patch("backend.app.api.routes.firmware.get_firmware_update_service", return_value=service):
                r = await async_client.post(self.URL.format(31))
        finally:
            state.status = FirmwareUploadStatus.IDLE
        assert r.status_code == 200, r.text
        assert r.json() == {"started": False, "message": "Firmware upload already in progress"}

    @pytest.mark.asyncio
    async def test_not_started_otherwise_is_500_with_state_error(self, async_client: AsyncClient):
        from backend.app.services.firmware_update import FirmwareUploadStatus, get_upload_state

        state = get_upload_state(32)
        state.status, state.error = FirmwareUploadStatus.ERROR, "Printer not found"
        service = _update_service(_OK_PREPARE, started=False)
        try:
            with patch("backend.app.api.routes.firmware.get_firmware_update_service", return_value=service):
                r = await async_client.post(self.URL.format(32))
        finally:
            state.status, state.error = FirmwareUploadStatus.IDLE, None
        assert r.status_code == 500
        assert r.json()["detail"] == "Printer not found"

    @pytest.mark.asyncio
    async def test_not_started_without_error_uses_default_detail(self, async_client: AsyncClient):
        service = _update_service(_OK_PREPARE, started=False)
        with patch("backend.app.api.routes.firmware.get_firmware_update_service", return_value=service):
            r = await async_client.post(self.URL.format(33))
        assert r.status_code == 500
        assert r.json()["detail"] == "Failed to start firmware upload"
