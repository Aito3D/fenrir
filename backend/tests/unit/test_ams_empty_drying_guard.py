"""An AMS with no spool in it must never be heated.

Reported against an AMS-HT sitting empty on a printer: auto-drying kept firing
on it every time the humidity reading drifted over the threshold. An empty dry
box has nothing to dry, so the cycle is pure wasted power and wear, and it
holds the printer's drying power budget away from a unit that does have
filament in it.

The gate is one shared helper, ``has_filament_loaded``, applied at all three
places a drying command is published:

* the scheduler's auto-drying pass (queue / ambient / mid-print),
* the scheduler's dispatch of a scheduled drying row,
* the immediate ``POST /printers/{id}/drying/start`` endpoint.

The helper reads the firmware's own presence signal in priority order — see its
docstring. The ordering matters here rather than being a detail: an AMS-HT that
has had its spool pulled keeps echoing the old ``tray_type`` (#2670), so a
``tray_type`` check alone reads that unit as loaded forever, which is exactly
the reported bug.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.app.services.print_scheduler import PrintScheduler
from backend.app.utils.ams_drying import has_filament_loaded


class TestHasFilamentLoaded:
    """Which firmware signal wins, and why that order."""

    def test_per_tray_exists_flag_says_loaded(self):
        assert has_filament_loaded({"tray": [{"id": 0, "exists": True, "tray_type": "PLA"}]}) is True

    def test_per_tray_exists_flag_says_empty(self):
        assert has_filament_loaded({"tray": [{"id": 0, "exists": False, "tray_type": ""}]}) is False

    def test_exists_flag_beats_a_stale_tray_type(self):
        """The reported AMS-HT: spool pulled, firmware still echoing its type (#2670)."""
        ht_emptied = {
            "id": 128,
            "module_type": "n3s",
            "tray": [{"id": 0, "exists": False, "tray_type": "PLA"}],
        }
        assert has_filament_loaded(ht_emptied) is False

    def test_exists_flag_beats_a_bitmask_set_by_another_unit(self):
        """``tray_exist_bits`` is one bitmask for the whole printer, not per unit.

        A loaded AMS-A next to an empty HT-A leaves it non-zero, so reading it
        off an individual unit's dict reports every unit as loaded. The per-tray
        ``exists`` flags are that same bitmask already resolved per slot by
        ``apply_tray_exist_bits`` — including the HT's bit-16 layout — so they
        are the signal to trust when they are there.
        """
        empty_ht_on_a_printer_with_a_loaded_ams = {
            "id": 128,
            "tray_exist_bits": "1",
            "tray": [{"id": 0, "exists": False, "tray_type": "PLA"}],
        }
        assert has_filament_loaded(empty_ht_on_a_printer_with_a_loaded_ams) is False

    def test_one_loaded_slot_is_enough(self):
        four_slot = {
            "tray": [
                {"id": 0, "exists": False},
                {"id": 1, "exists": False},
                {"id": 2, "exists": True, "tray_type": "PETG"},
                {"id": 3, "exists": False},
            ]
        }
        assert has_filament_loaded(four_slot) is True

    def test_bitmask_is_used_when_no_slot_is_annotated(self):
        """Before ``apply_tray_exist_bits`` has run there are no ``exists`` flags."""
        assert has_filament_loaded({"tray_exist_bits": "0"}) is False
        assert has_filament_loaded({"tray_exist_bits": "ed"}) is True

    def test_bitmask_still_beats_a_stale_tray_type(self):
        """Without ``exists`` the bitmask is still better evidence than a tray_type."""
        assert has_filament_loaded({"tray_exist_bits": "0", "tray": [{"id": 0, "tray_type": "PLA"}]}) is False

    def test_tray_type_is_the_last_resort(self):
        assert has_filament_loaded({"tray": [{"id": 0, "tray_type": "ABS"}]}) is True
        assert has_filament_loaded({"tray": [{"id": 0, "tray_type": ""}]}) is False

    def test_no_signal_at_all_reads_as_empty(self):
        """An early-pushall shape carries no evidence — don't guess "loaded" and heat it."""
        assert has_filament_loaded({}) is False

    def test_malformed_input_does_not_raise(self):
        assert has_filament_loaded(None) is False
        assert has_filament_loaded("ams") is False
        assert has_filament_loaded({"tray": [None, "junk", 42]}) is False
        assert has_filament_loaded({"tray_exist_bits": "garbage", "tray": [{"tray_type": "PETG"}]}) is True


def _make_setting(value):
    s = MagicMock()
    s.value = value
    return s


def _drying_settings_db():
    """A db whose settings turn ambient auto-drying on for one active printer."""
    settings_map = {
        "queue_drying_enabled": _make_setting("false"),
        "ambient_drying_enabled": _make_setting("true"),
        "print_drying_enabled": _make_setting("false"),
        "drying_no_auto_stop": _make_setting("false"),
        "ams_humidity_fair": _make_setting("60"),
        "queue_drying_block": _make_setting("false"),
        "drying_presets": None,
        "ams_humidity_thresholds": None,
    }

    async def side_effect(stmt):
        result = MagicMock()
        try:
            param_values = list(stmt.compile(compile_kwargs={"literal_binds": False}).params.values())
        except Exception:
            param_values = []
        for key, val in settings_map.items():
            if key in param_values:
                result.scalar_one_or_none.return_value = val
                return result
        if "printer" in str(stmt).lower():
            printer = MagicMock()
            printer.id = 1
            printer.is_active = True
            printer.name = "P1S"
            scalars_mock = MagicMock()
            scalars_mock.__iter__ = MagicMock(return_value=iter([printer]))
            result.scalars.return_value = scalars_mock
        else:
            result.scalar_one_or_none.return_value = None
        return result

    db = AsyncMock()
    db.execute = AsyncMock(side_effect=side_effect)
    return db


def _state_with_ams(ams_unit):
    state = MagicMock()
    state.state = "IDLE"
    state.firmware_version = "01.09.00.00"
    state.raw_data = {"ams": [ams_unit]}
    return state


EMPTY_HT = {
    "id": 128,
    "module_type": "n3s",
    "dry_time": 0,
    "humidity_raw": "75",
    "dry_sf_reason": [],
    # Spool pulled: firmware clears the presence bit but keeps echoing the type.
    "tray": [{"id": 0, "exists": False, "tray_type": "PLA"}],
}

LOADED_HT = {
    "id": 128,
    "module_type": "n3s",
    "dry_time": 0,
    "humidity_raw": "75",
    "dry_sf_reason": [],
    "tray": [{"id": 0, "exists": True, "tray_type": "PLA"}],
}


class TestAutoDryingSkipsEmptyUnits:
    @pytest.fixture
    def scheduler(self):
        return PrintScheduler()

    @pytest.mark.asyncio
    @patch("backend.app.services.print_scheduler.printer_manager")
    @patch("backend.app.services.print_scheduler.supports_drying", return_value=True)
    async def test_empty_ht_is_not_heated(self, _mock_supports, mock_pm, scheduler):
        mock_pm.get_status.return_value = _state_with_ams(EMPTY_HT)
        mock_pm.is_connected.return_value = True
        mock_pm.get_model.return_value = "P1S"
        mock_pm.send_drying_command.return_value = True
        scheduler._is_printer_idle = MagicMock(return_value=True)

        await scheduler._check_auto_drying(_drying_settings_db(), [], set())

        mock_pm.send_drying_command.assert_not_called()
        assert 1 not in scheduler._drying_in_progress

    @pytest.mark.asyncio
    @patch("backend.app.services.print_scheduler.printer_manager")
    @patch("backend.app.services.print_scheduler.supports_drying", return_value=True)
    async def test_a_loaded_ht_still_dries(self, _mock_supports, mock_pm, scheduler):
        """The guard must not cost the feature its actual job."""
        mock_pm.get_status.return_value = _state_with_ams(LOADED_HT)
        mock_pm.is_connected.return_value = True
        mock_pm.get_model.return_value = "P1S"
        mock_pm.send_drying_command.return_value = True
        scheduler._is_printer_idle = MagicMock(return_value=True)

        await scheduler._check_auto_drying(_drying_settings_db(), [], set())

        mock_pm.send_drying_command.assert_called_once()

    @pytest.mark.asyncio
    @patch("backend.app.services.print_scheduler.printer_manager")
    @patch("backend.app.services.print_scheduler.supports_drying", return_value=True)
    async def test_emptying_a_unit_forgets_its_drying_history(self, _mock_supports, mock_pm, scheduler):
        """Pulling the spool resets the unit's cooldown and unproductive-cycle count.

        That history is a judgement about a specific spool — "drying this is not
        moving the reading". It says nothing about the next one, and leaving a
        suspension in place would silently deny drying to the spool the user
        loads next.
        """
        mock_pm.get_status.return_value = _state_with_ams(EMPTY_HT)
        mock_pm.is_connected.return_value = True
        mock_pm.get_model.return_value = "P1S"
        scheduler._is_printer_idle = MagicMock(return_value=True)
        scheduler._auto_dry_units[(1, 128)] = {"unproductive": 3, "suspended": True, "ended_at": None}

        await scheduler._check_auto_drying(_drying_settings_db(), [], set())

        assert (1, 128) not in scheduler._auto_dry_units

    @pytest.mark.asyncio
    @patch("backend.app.services.print_scheduler.printer_manager")
    @patch("backend.app.services.print_scheduler.supports_drying", return_value=True)
    async def test_a_cycle_already_running_on_an_empty_unit_is_left_alone(self, _mock_supports, mock_pm, scheduler):
        """Somebody started this by hand. Not ours to tear down.

        The guard decides whether to START heating; a running cycle still has to
        be tracked so the queue's own stop paths can reach it.
        """
        running = {**EMPTY_HT, "dry_time": 300}
        mock_pm.get_status.return_value = _state_with_ams(running)
        mock_pm.is_connected.return_value = True
        mock_pm.get_model.return_value = "P1S"
        scheduler._is_printer_idle = MagicMock(return_value=True)

        await scheduler._check_auto_drying(_drying_settings_db(), [], set())

        assert 1 in scheduler._drying_in_progress
        mock_pm.send_drying_command.assert_not_called()


class TestScheduledDryingWaitsForASpool:
    """A row scheduled hours ago, on a box the user has since emptied."""

    @pytest.fixture
    def scheduler(self):
        return PrintScheduler()

    @staticmethod
    async def _due_row(db_session, printer_factory, ams_id=128):
        from datetime import datetime, timedelta, timezone

        from backend.app.models.scheduled_drying import ScheduledDrying

        printer = await printer_factory()
        row = ScheduledDrying(
            printer_id=printer.id,
            ams_id=ams_id,
            temp=65,
            duration_hours=8,
            start_after=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=1),
        )
        db_session.add(row)
        await db_session.commit()
        await db_session.refresh(row)
        return row

    @pytest.mark.asyncio
    async def test_empty_unit_holds_the_row_pending(self, scheduler, db_session, printer_factory):
        """Pending, not failed: load a spool later and the run still happens.

        Same shape as the power-adapter and retract-filament waits — the user
        does one thing at the printer and the scheduled run picks itself up.
        Failing the row would make an emptied AMS cost them the schedule.
        """
        row = await self._due_row(db_session, printer_factory)
        with (
            patch("backend.app.services.print_scheduler.printer_manager") as mock_pm,
            patch.object(scheduler, "_is_printer_idle", return_value=True),
        ):
            mock_pm.get_status.return_value = _state_with_ams(EMPTY_HT)
            mock_pm.send_drying_command.return_value = True
            await scheduler._check_scheduled_dryings(db_session)

        mock_pm.send_drying_command.assert_not_called()
        await db_session.refresh(row)
        assert row.status == "pending"
        assert row.waiting_reason == "ams_empty"

    @pytest.mark.asyncio
    async def test_a_loaded_unit_still_dispatches(self, scheduler, db_session, printer_factory):
        row = await self._due_row(db_session, printer_factory)
        with (
            patch("backend.app.services.print_scheduler.printer_manager") as mock_pm,
            patch.object(scheduler, "_is_printer_idle", return_value=True),
        ):
            mock_pm.get_status.return_value = _state_with_ams(LOADED_HT)
            mock_pm.send_drying_command.return_value = True
            await scheduler._check_scheduled_dryings(db_session)

        mock_pm.send_drying_command.assert_called_once()
        await db_session.refresh(row)
        assert row.status == "running"


class TestStartDryingEndpointRefusesAnEmptyUnit:
    @pytest.mark.asyncio
    async def test_empty_unit_is_a_conflict(self, async_client, printer_factory):
        printer = await printer_factory(model="X1C")
        with patch("backend.app.api.routes.printers.printer_manager") as mock_pm:
            mock_pm.get_status.return_value = _state_with_ams(EMPTY_HT)
            mock_pm.send_drying_command.return_value = True
            resp = await async_client.post(f"/api/v1/printers/{printer.id}/drying/start?ams_id=128&temp=65&duration=8")

        assert resp.status_code == 409
        assert "empty" in resp.json()["detail"].lower()
        mock_pm.send_drying_command.assert_not_called()

    @pytest.mark.asyncio
    async def test_a_loaded_unit_still_starts(self, async_client, printer_factory):
        printer = await printer_factory(model="X1C")
        with patch("backend.app.api.routes.printers.printer_manager") as mock_pm:
            mock_pm.get_status.return_value = _state_with_ams(LOADED_HT)
            mock_pm.send_drying_command.return_value = True
            resp = await async_client.post(f"/api/v1/printers/{printer.id}/drying/start?ams_id=128&temp=65&duration=8")

        assert resp.status_code == 200, resp.text
        mock_pm.send_drying_command.assert_called_once()

    @pytest.mark.asyncio
    async def test_an_unknown_unit_is_left_to_the_firmware(self, async_client, printer_factory):
        """No unit in live state is not evidence of an empty one.

        A printer that has not pushed its AMS list yet would otherwise start
        refusing drying the user asked for by hand, which is a new failure mode
        rather than the fix.
        """
        printer = await printer_factory(model="X1C")
        with patch("backend.app.api.routes.printers.printer_manager") as mock_pm:
            mock_pm.get_status.return_value = _state_with_ams(LOADED_HT)
            mock_pm.send_drying_command.return_value = True
            resp = await async_client.post(f"/api/v1/printers/{printer.id}/drying/start?ams_id=0&temp=65&duration=8")

        assert resp.status_code == 200, resp.text
