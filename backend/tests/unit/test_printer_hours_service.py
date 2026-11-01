"""Unit tests for the printer hours service (Maintenance → Hours tab)."""

from datetime import date, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from backend.app.models.maintenance import HourEvent, HourMachine, HourReading
from backend.app.services import printer_hours
from backend.app.services.printer_hours import (
    SOURCE_AUTO,
    SOURCE_MANUAL,
    calibrate_machine,
    current_hours,
    ensure_hour_machines,
    machine_for_printer,
    recalibrate_printer,
    snapshot_today,
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
