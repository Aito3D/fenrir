"""Unit tests for the printer hours service (Maintenance → Hours tab)."""

from datetime import date, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from backend.app.models.maintenance import (
    HourEvent,
    HourMachine,
    HourReading,
    MaintenanceHistory,
    MaintenanceType,
    PrinterMaintenance,
)
from backend.app.services import printer_hours
from backend.app.services.printer_hours import (
    SOURCE_AUTO,
    SOURCE_MANUAL,
    calibrate_machine,
    current_hours,
    ensure_hour_machines,
    machine_for_printer,
    next_service_hours,
    recalibrate_printer,
    snapshot_today,
    sync_events,
    trust_state,
    upsert_reading,
)


def test_current_hours_adds_runtime_and_offset():
    assert current_hours(7200, 10.5) == pytest.approx(12.5)
    assert current_hours(None, None) == 0.0


def test_recalibrate_sets_offset_and_never_goes_negative():
    class P:
        runtime_seconds = 3600 * 100
        print_hours_offset = 0.0

    p = P()
    assert recalibrate_printer(p, 4102.0) == pytest.approx(100.0)
    assert p.print_hours_offset == pytest.approx(4002.0)
    recalibrate_printer(p, 50.0)
    assert p.print_hours_offset == 0.0


@pytest.mark.asyncio
async def test_ensure_creates_one_machine_per_printer_and_syncs_names(db_session, printer_factory):
    p = await printer_factory(name="X1C04", model="X1C")
    machines = await ensure_hour_machines(db_session)
    assert [(m.printer_id, m.name, m.model, m.retired) for m in machines] == [(p.id, "X1C04", "X1C", False)]

    p.name = "X1C04-renamed"
    await db_session.commit()
    machines = await ensure_hour_machines(db_session)
    assert len(machines) == 1
    assert machines[0].name == "X1C04-renamed"


@pytest.mark.asyncio
async def test_ensure_retires_machine_of_deleted_printer(db_session, printer_factory):
    p = await printer_factory(name="H2S02", model="H2S")
    [m] = await ensure_hour_machines(db_session)
    await db_session.delete(p)
    await db_session.commit()

    machines = await ensure_hour_machines(db_session)
    assert [(x.id, x.printer_id, x.retired) for x in machines] == [(m.id, None, True)]


@pytest.mark.asyncio
async def test_ensure_retires_on_serial_mismatch_instead_of_hijacking(db_session, printer_factory):
    """SQLite may hand a deleted printer's id to the next printer; the serial guards the link."""
    p = await printer_factory(name="Old", serial_number="SERIAL-OLD")
    [old] = await ensure_hour_machines(db_session)
    p.serial_number = "SERIAL-NEW"  # same id, different physical printer
    p.name = "New"
    await db_session.commit()

    machines = await ensure_hour_machines(db_session)
    by_name = {m.name: m for m in machines}
    assert by_name["Old"].id == old.id and by_name["Old"].retired and by_name["Old"].printer_id is None
    assert by_name["New"].printer_id == p.id and not by_name["New"].retired


@pytest.mark.asyncio
async def test_ensure_recovers_from_concurrent_insert(db_session, printer_factory, monkeypatch):
    await printer_factory(name="A101", model="A1")
    real_sync = printer_hours._sync_machines
    calls = {"n": 0}

    async def flaky_sync(db):
        calls["n"] += 1
        if calls["n"] == 1:
            raise IntegrityError("INSERT", {}, Exception("UNIQUE constraint failed: hour_machines.printer_id"))
        await real_sync(db)

    monkeypatch.setattr(printer_hours, "_sync_machines", flaky_sync)
    machines = await ensure_hour_machines(db_session)
    assert [m.name for m in machines] == ["A101"]
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_upsert_inserts_replaces_and_deletes(db_session):
    m = HourMachine(name="X1C01", model="X1C", retired=True)
    db_session.add(m)
    await db_session.commit()
    d = date(2026, 4, 25)

    await upsert_reading(db_session, m.id, d, SOURCE_MANUAL, 4102.0)
    await upsert_reading(db_session, m.id, d, SOURCE_MANUAL, 4103.0)
    await upsert_reading(db_session, m.id, d, SOURCE_AUTO, 3000.0)
    await db_session.commit()
    rows = (await db_session.execute(select(HourReading).order_by(HourReading.source))).scalars().all()
    assert [(r.source, r.hours) for r in rows] == [("auto", 3000.0), ("manual", 4103.0)]

    await upsert_reading(db_session, m.id, d, SOURCE_MANUAL, None)
    await db_session.commit()
    rows = (await db_session.execute(select(HourReading))).scalars().all()
    assert [(r.source, r.hours) for r in rows] == [("auto", 3000.0)]


@pytest.mark.asyncio
async def test_snapshot_today_is_idempotent_and_skips_retired(db_session, printer_factory):
    p = await printer_factory(name="X1C05", model="X1C")
    p.runtime_seconds = 3600 * 10
    p.print_hours_offset = 100.0
    db_session.add(HourMachine(name="X1C01", model="X1C", retired=True))
    await db_session.commit()
    today = date(2026, 10, 4)

    assert await snapshot_today(db_session, today) == 1
    p.runtime_seconds = 3600 * 12
    await db_session.commit()
    assert await snapshot_today(db_session, today) == 1

    rows = (await db_session.execute(select(HourReading))).scalars().all()
    assert [(r.reading_date, r.source, r.hours) for r in rows] == [(today, "auto", 112.0)]


@pytest.mark.asyncio
async def test_scheduler_snapshots_and_survives_errors(monkeypatch):
    import asyncio
    from contextlib import asynccontextmanager

    from backend.app.core import database as _database

    calls: list[str] = []

    async def fake_snapshot(_db):
        calls.append("snap")
        if len(calls) == 1:
            raise RuntimeError("transient")
        return 3

    @asynccontextmanager
    async def fake_session():
        yield object()

    monkeypatch.setattr(printer_hours, "snapshot_today", fake_snapshot)
    monkeypatch.setattr(_database, "async_session", fake_session)
    service = printer_hours.PrinterHoursService()
    service._startup_delay = 0
    service._check_interval = 0.01
    await service.start_scheduler()
    await asyncio.sleep(0.1)
    service.stop_scheduler()
    assert len(calls) >= 2  # the first failure did not kill the loop


@pytest.mark.asyncio
async def test_calibrate_first_time_stores_no_drift(db_session, printer_factory):
    p = await printer_factory(name="X1C10", runtime_seconds=3600 * 100)
    machine = await machine_for_printer(db_session, p.id)
    today = date(2026, 11, 1)
    actual = await calibrate_machine(db_session, machine, p, 3803.0, today)
    await db_session.commit()

    assert actual == pytest.approx(3803.0)
    assert machine.calibrated_at is not None
    assert machine.last_drift_hours is None
    auto = (await db_session.execute(select(HourReading).where(HourReading.source == SOURCE_AUTO))).scalar_one()
    assert (auto.reading_date, auto.hours, auto.raw_hours) == (today, 3803.0, pytest.approx(100.0))
    events = (await db_session.execute(select(HourEvent))).scalars().all()
    assert [(e.machine_id, e.kind, e.label, e.event_date) for e in events] == [
        (machine.id, "calibrated", "3803 h", today)
    ]


@pytest.mark.asyncio
async def test_calibrate_again_stores_drift(db_session, printer_factory):
    p = await printer_factory(name="X1C11", runtime_seconds=3600 * 100, print_hours_offset=3765.0)
    machine = await machine_for_printer(db_session, p.id)
    machine.calibrated_at = datetime(2026, 10, 1)
    await db_session.commit()

    await calibrate_machine(db_session, machine, p, 3803.0, date(2026, 11, 1))
    assert machine.last_drift_hours == pytest.approx(62.0)
    assert p.print_hours_offset == pytest.approx(3703.0)


@pytest.mark.asyncio
async def test_calibrate_clamped_offset_records_actual_counter(db_session, printer_factory):
    p = await printer_factory(name="X1C12", runtime_seconds=3600 * 100)
    machine = await machine_for_printer(db_session, p.id)
    actual = await calibrate_machine(db_session, machine, p, 50.0, date(2026, 11, 1))
    assert actual == pytest.approx(100.0)
    assert p.print_hours_offset == 0.0


@pytest.mark.asyncio
async def test_snapshot_writes_raw_hours(db_session, printer_factory):
    await printer_factory(name="X1C13", runtime_seconds=3600 * 100, print_hours_offset=20.0)
    await snapshot_today(db_session, date(2026, 11, 1))
    row = (await db_session.execute(select(HourReading))).scalar_one()
    assert row.hours == 120.0
    assert row.raw_hours == pytest.approx(100.0)


@pytest.mark.asyncio
async def test_calibrate_from_status_creates_machine_row(db_session, printer_factory):
    p = await printer_factory(name="X1C14")
    assert (await db_session.execute(select(HourMachine))).scalars().all() == []
    machine = await machine_for_printer(db_session, p.id)
    assert machine.printer_id == p.id


def test_trust_state_rules():
    retired = HourMachine(retired=True, calibrated_at=datetime(2026, 1, 1), last_drift_hours=5.0)
    assert trust_state(retired, 100.0) == (None, None)
    assert trust_state(HourMachine(retired=False, calibrated_at=None), 100.0) == ("uncalibrated", None)

    def machine(drift):
        return HourMachine(retired=False, calibrated_at=datetime(2026, 1, 1), last_drift_hours=drift)

    assert trust_state(machine(10.0), 3803.0) == ("calibrated", 10.0)
    assert trust_state(machine(100.0), 3803.0) == ("drifting", 100.0)
    assert trust_state(machine(-100.0), 3803.0) == ("drifting", -100.0)
    assert trust_state(machine(30.0), 500.0) == ("drifting", 30.0)  # the 24 h floor beats 2 %
    assert trust_state(machine(30.0), None) == ("drifting", 30.0)
    assert trust_state(machine(None), 500.0) == ("calibrated", None)


@pytest.mark.asyncio
async def test_sync_events_mirrors_maintenance_history_once(db_session, printer_factory):
    p = await printer_factory(name="X1C20")
    machines = await ensure_hour_machines(db_session)
    mtype = MaintenanceType(name="Lubricate rails", default_interval_hours=300.0)
    db_session.add(mtype)
    await db_session.flush()
    item = PrinterMaintenance(printer_id=p.id, maintenance_type_id=mtype.id, enabled=True, custom_interval_hours=300.0)
    db_session.add(item)
    await db_session.flush()
    hist = MaintenanceHistory(printer_maintenance_id=item.id, performed_at=datetime(2026, 5, 4, 10, 0))
    db_session.add(hist)
    await db_session.commit()

    await sync_events(db_session, machines)
    await sync_events(db_session, machines)

    events = (await db_session.execute(select(HourEvent).where(HourEvent.kind == "maintenance"))).scalars().all()
    assert [(e.machine_id, e.source_id, e.label, e.event_date) for e in events] == [
        (machines[0].id, hist.id, "Lubricate rails", date(2026, 5, 4))
    ]
    added = (await db_session.execute(select(HourEvent).where(HourEvent.kind == "added"))).scalars().all()
    assert len(added) == 1


@pytest.mark.asyncio
async def test_sync_events_added_uses_first_reading_when_older_than_printer(db_session, printer_factory):
    p = await printer_factory(name="X1C21")
    p.created_at = datetime(2026, 3, 9, 12, 0)
    machines = await ensure_hour_machines(db_session)
    await upsert_reading(db_session, machines[0].id, date(2024, 7, 19), SOURCE_MANUAL, 120.0)
    await upsert_reading(db_session, machines[0].id, date(2025, 1, 2), SOURCE_MANUAL, 900.0)
    await db_session.commit()

    await sync_events(db_session, machines)

    [added] = (await db_session.execute(select(HourEvent).where(HourEvent.kind == "added"))).scalars().all()
    assert added.event_date == date(2024, 7, 19)


@pytest.mark.asyncio
async def test_sync_events_added_for_retired_machine_without_printer(db_session, printer_factory):
    p = await printer_factory(name="X1C22")
    [m] = await ensure_hour_machines(db_session)
    await upsert_reading(db_session, m.id, date(2025, 2, 3), SOURCE_MANUAL, 50.0)
    await db_session.delete(p)
    await db_session.commit()
    machines = await ensure_hour_machines(db_session)

    await sync_events(db_session, machines)

    added = (await db_session.execute(select(HourEvent).where(HourEvent.kind == "added"))).scalars().all()
    assert [a.event_date for a in added] == [date(2025, 2, 3)]


@pytest.mark.asyncio
async def test_sync_events_no_added_without_any_date(db_session):
    machine = HourMachine(printer_id=None, name="Ghost", retired=True)
    db_session.add(machine)
    await db_session.commit()

    await sync_events(db_session, [machine])

    assert (await db_session.execute(select(HourEvent))).scalars().all() == []


@pytest.mark.asyncio
async def test_retiring_a_machine_writes_event_and_clears_calibration(db_session, printer_factory):
    p = await printer_factory(name="H2S09", model="H2S")
    [m] = await ensure_hour_machines(db_session)
    m.calibrated_at = datetime(2026, 10, 1)
    m.last_drift_hours = 12.0
    await db_session.commit()

    await db_session.delete(p)
    await db_session.commit()
    [m] = await ensure_hour_machines(db_session)
    await ensure_hour_machines(db_session)  # already retired: no second event

    assert m.retired is True
    assert m.calibrated_at is None
    assert m.last_drift_hours is None
    events = (await db_session.execute(select(HourEvent).where(HourEvent.kind == "retired"))).scalars().all()
    assert [(e.machine_id, e.label, e.event_date) for e in events] == [(m.id, "H2S09", date.today())]


async def _disable_default_items(db_session, printer_id):
    """The overview auto-creates enabled items for every system type; switch them off so a test owns the set."""
    await next_service_hours(db_session, printer_id)
    for item in (
        (await db_session.execute(select(PrinterMaintenance).where(PrinterMaintenance.printer_id == printer_id)))
        .scalars()
        .all()
    ):
        item.enabled = False
    await db_session.commit()


@pytest.mark.asyncio
async def test_next_service_hours_takes_earliest_enabled_hours_item(db_session, printer_factory):
    p = await printer_factory(name="X1C23", runtime_seconds=3600 * 250)
    await _disable_default_items(db_session, p.id)
    types = [MaintenanceType(name=f"T{i}", default_interval_hours=100.0) for i in range(3)]
    db_session.add_all(types)
    await db_session.flush()
    db_session.add_all(
        [
            PrinterMaintenance(
                printer_id=p.id, maintenance_type_id=types[0].id, enabled=True, custom_interval_hours=300.0
            ),
            PrinterMaintenance(
                printer_id=p.id, maintenance_type_id=types[1].id, enabled=True, custom_interval_hours=1000.0
            ),
            PrinterMaintenance(
                printer_id=p.id, maintenance_type_id=types[2].id, enabled=False, custom_interval_hours=260.0
            ),
        ]
    )
    await db_session.commit()

    assert await next_service_hours(db_session, p.id) == pytest.approx(300.0)


@pytest.mark.asyncio
async def test_next_service_hours_none_without_hours_items(db_session, printer_factory):
    p = await printer_factory(name="X1C24")
    await _disable_default_items(db_session, p.id)
    assert await next_service_hours(db_session, p.id) is None


def test_due_machine_ids_flags_stale_or_missing_manual_readings():
    from types import SimpleNamespace

    from backend.app.services.printer_hours import due_machine_ids

    def machine(mid, retired=False):
        return SimpleNamespace(id=mid, retired=retired)

    def reading(mid, d, source="manual"):
        return SimpleNamespace(machine_id=mid, reading_date=d, source=source)

    today = date(2026, 11, 1)
    machines = [machine(1), machine(2), machine(3), machine(4), machine(5, retired=True)]
    readings = [
        reading(1, date(2026, 10, 1)),  # 31 days: fresh
        reading(2, date(2026, 7, 1)),  # 123 days: stale
        reading(2, date(2026, 10, 30), source="auto"),  # auto never counts
        reading(3, date(2026, 8, 3)),  # exactly 90 days: not yet due
    ]
    assert due_machine_ids(machines, readings, 90, today) == [2, 4]


@pytest.mark.asyncio
async def test_reading_interval_days_defaults_and_parses(db_session):
    from backend.app.models.settings import Settings
    from backend.app.services.printer_hours import reading_interval_days

    assert await reading_interval_days(db_session) == 90
    db_session.add(Settings(key="hours_reading_interval_days", value="30"))
    await db_session.commit()
    assert await reading_interval_days(db_session) == 30
    row = (await db_session.execute(select(Settings))).scalars().one()
    row.value = "soon"
    await db_session.commit()
    assert await reading_interval_days(db_session) == 90
