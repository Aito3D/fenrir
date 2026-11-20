"""Firmware update service: prerequisite checks and the SD-card upload flow (no network, no FTP, no printer)."""

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.app.services import firmware_update as fu
from backend.app.services.firmware_update import (
    PRINTER_BUSY_ERROR,
    FirmwareUpdateService,
    FirmwareUploadStatus,
    get_firmware_update_service,
    get_upload_state,
    reset_upload_state,
    upload_in_progress,
)

MB = 1024 * 1024


@pytest.fixture(autouse=True)
def _clean_states():
    fu._upload_states.clear()
    yield
    fu._upload_states.clear()


def _client(state="IDLE", sdcard=True, version="01.00.00.00"):
    return SimpleNamespace(state=SimpleNamespace(state=state, sdcard=sdcard, firmware_version=version))


def _fw_service(update=True, latest="01.09.00.00", file_info=None, unreachable=False):
    svc = MagicMock()
    svc.check_for_update = AsyncMock(return_value={"update_available": update, "latest_version": latest})
    svc.get_latest_version = AsyncMock(return_value=SimpleNamespace(version=latest) if latest else None)
    svc.get_firmware_file_info = AsyncMock(
        return_value={"filename": "fw.bin"} if file_info is None else (file_info or None)
    )
    svc.download_page_unreachable = unreachable
    return svc


async def _prepare(db, printer_id, client, fw, free=500 * MB, storage_exc=None, target=None):
    pm = MagicMock()
    pm.get_client.return_value = client
    storage = AsyncMock(return_value={"free_bytes": free}, side_effect=storage_exc)
    with (
        patch.object(fu, "printer_manager", pm),
        patch.object(fu, "get_firmware_service", return_value=fw),
        patch.object(fu, "get_storage_info_async", storage),
    ):
        return await FirmwareUpdateService().prepare_update(printer_id, db, target_version=target), storage


class TestUploadStateHelpers:
    def test_get_creates_idle_and_reset_replaces(self):
        s = get_upload_state(1)
        assert s.status == FirmwareUploadStatus.IDLE
        s.progress = 50
        reset_upload_state(1)
        assert get_upload_state(1).progress == 0

    def test_upload_in_progress(self):
        assert upload_in_progress(7) is False
        for status, expected in [
            (FirmwareUploadStatus.PREPARING, True),
            (FirmwareUploadStatus.DOWNLOADING, True),
            (FirmwareUploadStatus.UPLOADING, True),
            (FirmwareUploadStatus.COMPLETE, False),
            (FirmwareUploadStatus.ERROR, False),
        ]:
            get_upload_state(7).status = status
            assert upload_in_progress(7) is expected

    def test_singleton(self):
        assert get_firmware_update_service() is get_firmware_update_service()

    def test_printer_idle(self):
        pm = MagicMock()
        with patch.object(fu, "printer_manager", pm):
            pm.get_client.return_value = None
            assert fu._printer_idle(1) is False
            pm.get_client.return_value = _client("RUNNING")
            assert fu._printer_idle(1) is False
            pm.get_client.return_value = _client("FINISH")
            assert fu._printer_idle(1) is True


class TestPrepareUpdate:
    @pytest.mark.asyncio
    async def test_unknown_printer(self, db_session):
        result, _ = await _prepare(db_session, 9999, _client(), _fw_service())
        assert result["can_proceed"] is False
        assert result["errors"] == ["Printer not found"]

    @pytest.mark.asyncio
    async def test_offline_printer(self, db_session, printer_factory):
        p = await printer_factory()
        result, _ = await _prepare(db_session, p.id, None, _fw_service())
        assert result["errors"] == ["Printer not connected"]
        assert result["can_proceed"] is False

    @pytest.mark.asyncio
    async def test_busy_printer_rejected(self, db_session, printer_factory):
        p = await printer_factory()
        result, _ = await _prepare(db_session, p.id, _client("RUNNING"), _fw_service())
        assert PRINTER_BUSY_ERROR in result["errors"]
        assert result["can_proceed"] is False

    @pytest.mark.asyncio
    async def test_no_sd_card(self, db_session, printer_factory):
        p = await printer_factory()
        result, storage = await _prepare(db_session, p.id, _client(sdcard=False), _fw_service())
        assert "No SD card inserted in printer" in result["errors"]
        assert result["sd_card_present"] is False and result["can_proceed"] is False
        storage.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_happy_path(self, db_session, printer_factory):
        p = await printer_factory(model="X1C")
        result, storage = await _prepare(db_session, p.id, _client(), _fw_service())
        assert result["can_proceed"] is True
        assert result["errors"] == []
        assert result["current_version"] == "01.00.00.00"
        assert result["latest_version"] == "01.09.00.00"
        assert result["firmware_filename"] == "fw.bin"
        assert result["firmware_size"] == 100 * MB
        assert result["space_sufficient"] is True
        assert storage.await_args.kwargs == {"printer_model": "X1C"}

    @pytest.mark.asyncio
    async def test_unknown_model_falls_back_to_unknown(self, db_session, printer_factory):
        p = await printer_factory(model=None)
        fw = _fw_service()
        await _prepare(db_session, p.id, _client(), fw)
        fw.check_for_update.assert_awaited_once_with("Unknown", "01.00.00.00")
        fw.get_firmware_file_info.assert_awaited_once_with("Unknown", version=None)

    @pytest.mark.asyncio
    async def test_already_up_to_date(self, db_session, printer_factory):
        p = await printer_factory()
        result, _ = await _prepare(db_session, p.id, _client(), _fw_service(update=False))
        assert "Firmware is already up to date" in result["errors"]
        assert result["can_proceed"] is False

    @pytest.mark.asyncio
    async def test_unknown_current_version_assumes_update(self, db_session, printer_factory):
        p = await printer_factory()
        fw = _fw_service()
        result, _ = await _prepare(db_session, p.id, _client(version=None), fw)
        fw.get_latest_version.assert_awaited_once_with("X1C")
        assert result["update_available"] is True and result["latest_version"] == "01.09.00.00"
        assert result["can_proceed"] is True

    @pytest.mark.asyncio
    async def test_unknown_current_version_and_no_latest(self, db_session, printer_factory):
        p = await printer_factory()
        result, _ = await _prepare(db_session, p.id, _client(version=None), _fw_service(latest=None))
        assert result["update_available"] is False
        assert "Firmware is already up to date" in result["errors"]

    @pytest.mark.asyncio
    async def test_insufficient_space(self, db_session, printer_factory):
        p = await printer_factory()
        result, _ = await _prepare(db_session, p.id, _client(), _fw_service(), free=150 * MB)
        assert result["space_sufficient"] is False
        assert "Insufficient SD card space. Need 200MB, have 150MB" in result["errors"]
        assert result["can_proceed"] is False

    @pytest.mark.asyncio
    async def test_storage_failure_assumes_sufficient(self, db_session, printer_factory):
        p = await printer_factory()
        result, _ = await _prepare(db_session, p.id, _client(), _fw_service(), storage_exc=OSError("ftp down"))
        assert result["sd_card_free_space"] == -1
        assert result["space_sufficient"] is True and result["can_proceed"] is True

    @pytest.mark.asyncio
    async def test_target_version_allows_reinstall(self, db_session, printer_factory):
        p = await printer_factory()
        fw = _fw_service(update=False)
        result, _ = await _prepare(db_session, p.id, _client(), fw, target="01.00.00.00")
        fw.get_firmware_file_info.assert_awaited_once_with("X1C", version="01.00.00.00")
        assert result["target_version"] == "01.00.00.00"
        assert result["update_available"] is True and result["can_proceed"] is True

    @pytest.mark.asyncio
    async def test_target_version_without_file(self, db_session, printer_factory):
        p = await printer_factory()
        result, _ = await _prepare(db_session, p.id, _client(), _fw_service(file_info={}), target="01.02.03.04")
        assert result["errors"] == ["Firmware file for 01.02.03.04 is not available from Bambu Lab"]
        assert result["update_available"] is False and result["can_proceed"] is False

    @pytest.mark.asyncio
    async def test_target_version_download_page_unreachable(self, db_session, printer_factory):
        p = await printer_factory()
        fw = _fw_service(file_info={}, unreachable=True)
        result, _ = await _prepare(db_session, p.id, _client(), fw, target="01.02.03.04")
        assert any("Could not reach Bambu Lab's firmware download page" in e for e in result["errors"])
        assert result["can_proceed"] is False


def _spawn_capture():
    """Replace spawn_background_task, closing the coroutine so it never runs or warns."""
    spawned = []

    def _spawn(coro, name=None):
        spawned.append(name)
        coro.close()

    return spawned, _spawn


class TestStartUpload:
    @pytest.mark.asyncio
    async def test_already_in_progress(self, db_session, printer_factory):
        p = await printer_factory()
        get_upload_state(p.id).status = FirmwareUploadStatus.UPLOADING
        spawned, spawn = _spawn_capture()
        with patch.object(fu, "spawn_background_task", spawn):
            assert await FirmwareUpdateService().start_upload(p.id, db_session) is False
        assert spawned == []
        assert get_upload_state(p.id).status == FirmwareUploadStatus.UPLOADING

    @pytest.mark.asyncio
    async def test_unknown_printer_records_error(self, db_session):
        spawned, spawn = _spawn_capture()
        with patch.object(fu, "spawn_background_task", spawn):
            assert await FirmwareUpdateService().start_upload(4242, db_session) is False
        state = get_upload_state(4242)
        assert state.status == FirmwareUploadStatus.ERROR and state.error == "Printer not found"
        assert spawned == []

    @pytest.mark.asyncio
    async def test_starts_background_task(self, db_session, printer_factory):
        p = await printer_factory()
        get_upload_state(p.id).error = "stale"
        spawned, spawn = _spawn_capture()
        with patch.object(fu, "spawn_background_task", spawn):
            assert await FirmwareUpdateService().start_upload(p.id, db_session, target_version="01.02") is True
        assert spawned == [f"firmware-upload-{p.id}"]
        state = get_upload_state(p.id)
        assert state.status == FirmwareUploadStatus.PREPARING
        assert state.error is None and state.message == "Preparing firmware update..."


async def _run_upload(fw, *, idle=True, retry=(True, 3, 2, 30), target=None, upload_ok=True, upload_exc=None):
    pm = MagicMock()
    pm.get_client.return_value = _client("IDLE" if idle else "RUNNING")
    upload = AsyncMock(return_value=upload_ok, side_effect=upload_exc)
    retry_wrapper = AsyncMock(return_value=upload_ok, side_effect=upload_exc)
    with (
        patch.object(fu, "printer_manager", pm),
        patch.object(fu, "get_firmware_service", return_value=fw),
        patch.object(fu, "get_ftp_retry_settings", AsyncMock(return_value=retry)),
        patch.object(fu, "upload_file_async", upload),
        patch.object(fu, "with_ftp_retry", retry_wrapper),
    ):
        await FirmwareUpdateService()._do_upload(5, "10.0.0.5", "code", "X1C", target_version=target)
    return pm, upload, retry_wrapper


def _dl_service(path=Path("/tmp/fw-x.bin")):
    svc = _fw_service()
    svc.download_firmware = AsyncMock(return_value=path)
    return svc


class TestDoUpload:
    @pytest.mark.asyncio
    async def test_success_with_retry(self):
        fw = _dl_service()
        pm, upload, retry = await _run_upload(fw)
        state = get_upload_state(5)
        assert state.status == FirmwareUploadStatus.COMPLETE and state.progress == 100
        assert state.firmware_filename == "fw-x.bin" and state.firmware_version == "01.09.00.00"
        assert "uploaded successfully" in state.message
        pm.uploading.assert_called_once_with(5)
        upload.assert_not_awaited()
        args = retry.await_args
        assert args.args[0] is upload
        assert args.args[1:3] == ("10.0.0.5", "code") and args.args[4] == "/fw-x.bin"
        assert args.kwargs["max_retries"] == 3 and args.kwargs["respect_handshake_cooloff"] is False

    @pytest.mark.asyncio
    async def test_success_without_retry_uses_target_version(self):
        fw = _dl_service()
        _, upload, retry = await _run_upload(fw, retry=(False, 0, 0, 45), target="01.02.03.04")
        state = get_upload_state(5)
        assert state.status == FirmwareUploadStatus.COMPLETE
        assert state.firmware_version == "01.02.03.04"
        fw.download_firmware.assert_awaited_once_with("X1C", version="01.02.03.04")
        fw.get_latest_version.assert_not_awaited()
        retry.assert_not_awaited()
        assert upload.await_args.kwargs["socket_timeout"] == 45

    @pytest.mark.asyncio
    async def test_download_failure(self):
        fw = _dl_service(path=None)
        _, upload, retry = await _run_upload(fw)
        state = get_upload_state(5)
        assert state.status == FirmwareUploadStatus.ERROR and state.error == "Failed to download firmware"
        assert state.message == "Firmware upload failed: Failed to download firmware"
        upload.assert_not_awaited()
        retry.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_printer_busy_after_download(self):
        _, upload, retry = await _run_upload(_dl_service(), idle=False)
        state = get_upload_state(5)
        assert state.status == FirmwareUploadStatus.ERROR and state.error == PRINTER_BUSY_ERROR
        upload.assert_not_awaited()
        retry.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_ftp_returns_false(self):
        await _run_upload(_dl_service(), upload_ok=False)
        state = get_upload_state(5)
        assert state.status == FirmwareUploadStatus.ERROR
        assert state.error == "Failed to upload firmware to printer"
        assert state.progress != 100

    @pytest.mark.asyncio
    async def test_ftp_raises(self):
        await _run_upload(_dl_service(), retry=(False, 0, 0, 30), upload_exc=OSError("connection reset"))
        state = get_upload_state(5)
        assert state.status == FirmwareUploadStatus.ERROR and state.error == "connection reset"

    @pytest.mark.asyncio
    async def test_progress_callback_caps_at_99(self):
        fw = _dl_service()
        seen = []

        async def fake_retry(_fn, *_a, progress_callback, **_kw):
            for up, total in [(0, 0), (50, 100), (30, 100), (100, 100)]:
                progress_callback(up, total)
                seen.append(get_upload_state(5).progress)
            return True

        pm = MagicMock()
        pm.get_client.return_value = _client()
        with (
            patch.object(fu, "printer_manager", pm),
            patch.object(fu, "get_firmware_service", return_value=fw),
            patch.object(fu, "get_ftp_retry_settings", AsyncMock(return_value=(True, 1, 1, 30))),
            patch.object(fu, "with_ftp_retry", fake_retry),
        ):
            await FirmwareUpdateService()._do_upload(5, "ip", "code", "X1C")
        assert seen == [0, 50, 50, 99]
        assert get_upload_state(5).progress == 100
