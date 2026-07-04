"""Tests for on_print_start catch-up mode (#1304 follow-up).

The #1304 guard suppresses on_print_start on the first RUNNING push after
Bambuddy startup so a restart mid-print doesn't re-run the plate check
(pausing the live print) or duplicate the archive. But that also meant a
print started while Bambuddy was down NEVER got an archive row — the
restart-recovery hook only captured a timelapse baseline.

on_print_running_observed now calls ``on_print_start(catch_up=True)``, which:

- skips the plate check and every genuine-start side effect (start
  notification, WS print_start broadcast, MQTT relay, usage-tracker seeding,
  smart-plug power-on),
- reattaches to an existing "printing" archive when one matches (keeping
  #1304's no-duplicate guarantee),
- creates the archive (3MF download, or the no-3MF fallback row) when none
  exists — restoring pre-#1304 archiving of externally-started prints.

Also covers the stale expected-print fix: an ``_expected_prints`` entry whose
archive row was deleted must fall through to archive creation instead of
returning without creating anything.
"""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.app.main import (
    _active_prints,
    _expected_print_creators,
    _expected_print_registered_at,
    _expected_prints,
    _print_ams_mappings,
    _timelapse_baselines,
    register_expected_print,
)
from backend.app.models.archive import PrintArchive


@pytest.fixture(autouse=True)
def _clear_dicts():
    _expected_prints.clear()
    _expected_print_registered_at.clear()
    _expected_print_creators.clear()
    _print_ams_mappings.clear()
    _active_prints.clear()
    _timelapse_baselines.clear()
    yield
    _expected_prints.clear()
    _expected_print_registered_at.clear()
    _expected_print_creators.clear()
    _print_ams_mappings.clear()
    _active_prints.clear()
    _timelapse_baselines.clear()


def _make_printer(printer_id: int = 1, plate_detection: bool = False) -> MagicMock:
    printer = MagicMock()
    printer.id = printer_id
    printer.auto_archive = True
    printer.plate_detection_enabled = plate_detection
    printer.external_camera_enabled = False
    printer.external_camera_url = None
    printer.name = "TestP1S"
    printer.ip_address = "192.168.1.100"
    printer.access_code = "12345678"
    printer.model = "P1S"
    return printer


def _make_session(execute_router) -> AsyncMock:
    session = AsyncMock()
    session.__aenter__ = AsyncMock(return_value=session)
    session.__aexit__ = AsyncMock()
    session.execute = AsyncMock(side_effect=execute_router)
    session.commit = AsyncMock()
    session.refresh = AsyncMock()
    session.add = MagicMock()
    return session


def _router(printer, archive=None):
    """Route mock DB queries by table: printers → printer, archives → archive."""

    def execute_router(stmt, *args, **kwargs):
        sql = str(stmt).lower()
        if "from printers" in sql or "from printer " in sql:
            return MagicMock(
                scalar_one_or_none=MagicMock(return_value=printer),
                scalars=MagicMock(return_value=MagicMock(all=MagicMock(return_value=[printer]))),
            )
        if "from print_archives" in sql or "from print_archive" in sql:
            return MagicMock(
                scalar_one_or_none=MagicMock(return_value=archive),
                scalars=MagicMock(return_value=MagicMock(all=MagicMock(return_value=[archive] if archive else []))),
            )
        return MagicMock(
            scalar_one_or_none=MagicMock(return_value=None),
            scalars=MagicMock(return_value=MagicMock(all=MagicMock(return_value=[]))),
        )

    return execute_router


@pytest.mark.asyncio
async def test_catch_up_skips_plate_check_and_start_side_effects():
    """catch_up=True must never pause a live print (the original #1304 bug)
    nor replay genuine-start side effects: start notification, WS print_start
    broadcast, MQTT relay, usage-tracker seeding, smart-plug power-on."""
    printer = _make_printer(plate_detection=True)

    archive = MagicMock()
    archive.id = 42
    archive.filename = "Benchy.gcode.3mf"
    archive.subtask_id = None
    archive.print_time_seconds = None
    archive.created_by_id = None
    archive.printer_id = 1
    archive.print_name = "Benchy"
    archive.status = "printing"
    archive.file_path = "/tmp/fake.3mf"  # nosec B108 — mock path; nothing ever writes to it
    archive.energy_start_kwh = None
    archive.timelapse_path = None

    register_expected_print(1, "Benchy.gcode.3mf", archive_id=42, ams_mapping=None)

    mock_session = _make_session(_router(printer, archive))

    with (
        patch("backend.app.main.async_session") as mock_session_maker,
        patch("backend.app.main.smart_plug_manager") as mock_plug,
        patch("backend.app.main.ws_manager") as mock_ws,
        patch("backend.app.main.printer_manager") as mock_pm,
        patch("backend.app.main.mqtt_relay") as mock_relay,
        patch("backend.app.main._record_energy_start", new_callable=AsyncMock),
        patch("backend.app.main._load_objects_from_archive"),
        patch("backend.app.main._store_spoolman_print_data", new_callable=AsyncMock),
        patch("backend.app.main._send_print_start_notification", new_callable=AsyncMock) as mock_notif,
        patch("backend.app.main._capture_timelapse_baseline_at_start", new_callable=AsyncMock),
        patch("backend.app.services.plate_detection.check_plate_empty", new_callable=AsyncMock) as mock_plate,
    ):
        mock_session_maker.return_value = mock_session
        mock_plug.on_print_start = AsyncMock()
        mock_ws.send_print_start = AsyncMock()
        mock_ws.send_archive_updated = AsyncMock()
        mock_relay.on_print_start = AsyncMock()
        mock_pm.get_client = MagicMock(return_value=None)
        mock_pm.get_status = MagicMock(return_value=None)

        from backend.app.main import on_print_start

        await on_print_start(
            1,
            {"filename": "Benchy.gcode.3mf", "subtask_name": "Benchy", "raw_data": {}},
            catch_up=True,
        )

        mock_plate.assert_not_awaited()
        mock_ws.send_print_start.assert_not_called()
        mock_plug.on_print_start.assert_not_awaited()
        mock_relay.on_print_start.assert_not_awaited()
        mock_notif.assert_not_awaited()

        # The expected archive was still promoted to the active print.
        assert archive.status == "printing"
        assert _active_prints[(1, "Benchy.gcode.3mf")] == 42


@pytest.mark.asyncio
async def test_catch_up_reattaches_by_name_to_existing_printing_archive():
    """Restart mid-print: the pre-restart process left a "printing" archive.
    Catch-up must reattach to it — not create a duplicate (#1304's other
    symptom)."""
    printer = _make_printer()

    existing = MagicMock()
    existing.id = 77
    existing.filename = "Benchy.gcode.3mf"
    existing.subtask_id = None
    existing.print_time_seconds = 3600
    existing.created_by_id = None
    existing.printer_id = 1
    existing.print_name = "Benchy"
    existing.status = "printing"
    existing.file_path = "/tmp/fake.3mf"  # nosec B108 — mock path; nothing ever writes to it
    existing.energy_start_kwh = 0.5
    existing.created_at = datetime.now(timezone.utc).replace(tzinfo=None)

    mock_session = _make_session(_router(printer, existing))

    with (
        patch("backend.app.main.async_session") as mock_session_maker,
        patch("backend.app.main.ws_manager") as mock_ws,
        patch("backend.app.main.printer_manager") as mock_pm,
        patch("backend.app.main._record_energy_start", new_callable=AsyncMock),
        patch("backend.app.main._load_objects_from_archive") as mock_load_objects,
        patch("backend.app.main._send_print_start_notification", new_callable=AsyncMock) as mock_notif,
    ):
        mock_session_maker.return_value = mock_session
        mock_ws.send_print_start = AsyncMock()
        mock_pm.get_status = MagicMock(return_value=None)  # progress unknown → resume

        from backend.app.main import on_print_start

        await on_print_start(
            1,
            {"filename": "/data/Metadata/plate_1.gcode", "subtask_name": "Benchy", "raw_data": {}},
            catch_up=True,
        )

        # Reattached, not duplicated.
        assert _active_prints[(1, "Benchy.gcode.3mf")] == 77
        mock_session.add.assert_not_called()
        mock_load_objects.assert_called_once()
        # No late "print started" notification mid-print.
        mock_notif.assert_not_awaited()


@pytest.mark.asyncio
async def test_catch_up_creates_fallback_archive_when_none_exists():
    """The print started while Bambuddy was down — no archive row anywhere.
    Catch-up must create one (no-3MF fallback here: FTP finds nothing), which
    is exactly what #1304 broke for externally-started prints."""
    printer = _make_printer()

    mock_session = _make_session(_router(printer, archive=None))

    with (
        patch("backend.app.main.async_session") as mock_session_maker,
        patch("backend.app.main.ws_manager") as mock_ws,
        patch("backend.app.main.printer_manager") as mock_pm,
        patch("backend.app.main.mqtt_relay") as mock_relay,
        patch("backend.app.main._record_energy_start", new_callable=AsyncMock),
        patch("backend.app.main._store_spoolman_print_data", new_callable=AsyncMock),
        patch("backend.app.main._send_print_start_notification", new_callable=AsyncMock) as mock_notif,
        patch("backend.app.main._maybe_start_layer_timelapse"),
        patch("backend.app.main.get_cached_3mf", return_value=None),
        patch("backend.app.main.get_ftp_retry_settings", new=AsyncMock(return_value=(False, 3, 5.0, 10.0))),
        patch("backend.app.main.download_file_async", new=AsyncMock(return_value=False)),
        patch("backend.app.services.bambu_ftp.list_files_async", new=AsyncMock(return_value=[])),
    ):
        mock_session_maker.return_value = mock_session
        mock_ws.send_archive_created = AsyncMock()
        mock_relay.on_archive_created = AsyncMock()
        mock_pm.get_status = MagicMock(return_value=None)

        from backend.app.main import on_print_start

        await on_print_start(
            1,
            {
                "filename": "/data/Metadata/plate_1.gcode",
                "subtask_name": "Benchy",
                "remaining_time": 3600,
                "raw_data": {},
                "ams_mapping": None,
            },
            catch_up=True,
        )

        mock_session.add.assert_called_once()
        created = mock_session.add.call_args[0][0]
        assert isinstance(created, PrintArchive)
        assert created.status == "printing"
        assert created.print_name == "Benchy"
        mock_ws.send_archive_created.assert_awaited_once()
        # Catch-up never sends a start notification.
        mock_notif.assert_not_awaited()


@pytest.mark.asyncio
async def test_stale_expected_print_with_deleted_archive_falls_through():
    """Regression: an _expected_prints entry whose archive row was deleted
    used to hit a `return` outside the `if archive:` block and skip archive
    creation entirely. It must fall through and create the archive."""
    printer = _make_printer()

    # Expected print registered, but its archive row no longer exists.
    register_expected_print(1, "Benchy.gcode.3mf", archive_id=42, ams_mapping=None)

    mock_session = _make_session(_router(printer, archive=None))

    with (
        patch("backend.app.main.async_session") as mock_session_maker,
        patch("backend.app.main.notification_service") as mock_notif_svc,
        patch("backend.app.main.smart_plug_manager") as mock_plug,
        patch("backend.app.main.ws_manager") as mock_ws,
        patch("backend.app.main.printer_manager") as mock_pm,
        patch("backend.app.main.mqtt_relay") as mock_relay,
        patch("backend.app.main._record_energy_start", new_callable=AsyncMock),
        patch("backend.app.main._store_spoolman_print_data", new_callable=AsyncMock),
        patch("backend.app.main._send_print_start_notification", new_callable=AsyncMock),
        patch("backend.app.main._maybe_start_layer_timelapse"),
        patch("backend.app.main.notify_missing_spool_assignments_on_print_start", new_callable=AsyncMock),
        patch("backend.app.main.get_cached_3mf", return_value=None),
        patch("backend.app.main.get_ftp_retry_settings", new=AsyncMock(return_value=(False, 3, 5.0, 10.0))),
        patch("backend.app.main.download_file_async", new=AsyncMock(return_value=False)),
        patch("backend.app.services.bambu_ftp.list_files_async", new=AsyncMock(return_value=[])),
    ):
        mock_session_maker.return_value = mock_session
        mock_notif_svc.on_print_start = AsyncMock()
        mock_plug.on_print_start = AsyncMock()
        mock_ws.send_print_start = AsyncMock()
        mock_ws.send_archive_created = AsyncMock()
        mock_relay.on_print_start = AsyncMock()
        mock_relay.on_archive_created = AsyncMock()
        mock_pm.get_printer = MagicMock(return_value=MagicMock(name="Test", serial_number="TEST123"))
        mock_pm.get_status = MagicMock(return_value=None)
        mock_pm.get_client = MagicMock(return_value=None)

        from backend.app.main import on_print_start

        await on_print_start(
            1,
            {
                "filename": "Benchy.gcode.3mf",
                "subtask_name": "Benchy",
                "remaining_time": 3600,
                "raw_data": {},
                "ams_mapping": None,
            },
        )

        # Fell through to creation despite the stale expected entry.
        mock_session.add.assert_called_once()
        created = mock_session.add.call_args[0][0]
        assert isinstance(created, PrintArchive)
        assert created.status == "printing"
        assert created.print_name == "Benchy"
