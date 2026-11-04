"""The Hours tab's new columns are added to old databases, and calibrated_at is backfilled."""

from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.database import (
    _migrate_hour_events_unique,
    _migrate_hour_machines_retired_printer,
    _migrate_printer_hours_columns,
)

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def engine():
    """In-memory SQLite with the three tables as they were before the columns."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.execute(text("CREATE TABLE printers (id INTEGER PRIMARY KEY, print_hours_offset FLOAT DEFAULT 0)"))
        await conn.execute(
            text("CREATE TABLE hour_machines (id INTEGER PRIMARY KEY, printer_id INTEGER, name VARCHAR(100))")
        )
        await conn.execute(
            text(
                "CREATE TABLE hour_readings (id INTEGER PRIMARY KEY, machine_id INTEGER NOT NULL, "
                "reading_date DATE, hours FLOAT, source VARCHAR(10))"
            )
        )
    try:
        yield engine
    finally:
        await engine.dispose()


async def _seed(conn) -> None:
    await conn.execute(text("INSERT INTO printers (id, print_hours_offset) VALUES (1, 120), (2, 120), (3, 0)"))
    await conn.execute(
        text("INSERT INTO hour_machines (id, printer_id, name) VALUES (1, 1, 'a'), (2, 2, 'b'), (3, 3, 'c')")
    )
    await conn.execute(
        text(
            "INSERT INTO hour_readings (machine_id, reading_date, hours, source) VALUES "
            "(1, '2026-04-25', 120, 'manual'), (1, '2026-03-01', 50, 'manual'), (1, '2026-05-30', 130, 'auto')"
        )
    )


async def _calibrated(conn) -> dict[int, str | None]:
    rows = await conn.execute(text("SELECT id, calibrated_at, last_drift_hours FROM hour_machines ORDER BY id"))
    result = {}
    for machine_id, at, drift in rows:
        assert drift is None
        result[machine_id] = str(at)[:10] if at else None
    return result


async def test_migration_adds_hour_columns(engine):
    async with engine.begin() as conn:
        await _migrate_printer_hours_columns(conn)
        machine_cols = {r[1] for r in await conn.execute(text("PRAGMA table_info(hour_machines)"))}
        reading_cols = {r[1] for r in await conn.execute(text("PRAGMA table_info(hour_readings)"))}
    assert {"calibrated_at", "last_drift_hours", "purchase_price", "purchase_date"} <= machine_cols
    assert "raw_hours" in reading_cols


async def test_migration_backfills_calibrated_at_from_offset(engine):
    async with engine.begin() as conn:
        await _seed(conn)
        await _migrate_printer_hours_columns(conn)
        result = await _calibrated(conn)
    assert result == {1: "2026-04-25", 2: date.today().isoformat(), 3: None}


async def test_migration_is_idempotent(engine):
    async with engine.begin() as conn:
        await _seed(conn)
        await _migrate_printer_hours_columns(conn)
    async with engine.begin() as conn:
        await _migrate_printer_hours_columns(conn)
        result = await _calibrated(conn)
    assert result[1] == "2026-04-25"
    assert result[3] is None


async def _hour_events_with_duplicates(conn) -> None:
    await conn.execute(
        text(
            "CREATE TABLE hour_events (id INTEGER PRIMARY KEY, machine_id INTEGER NOT NULL, event_date DATE, "
            "kind VARCHAR(20), label VARCHAR(200), source_id INTEGER)"
        )
    )
    await conn.execute(
        text(
            "INSERT INTO hour_events (id, machine_id, event_date, kind, label, source_id) VALUES "
            "(1, 1, '2026-01-01', 'added', 'a', NULL), (2, 1, '2026-01-02', 'added', 'a', NULL), "
            "(3, 2, '2026-01-01', 'added', 'b', NULL), "
            "(4, 1, '2026-02-01', 'maintenance', 'm', 7), (5, 1, '2026-02-01', 'maintenance', 'm', 7), "
            "(6, 2, '2026-02-01', 'maintenance', 'm', 7), "
            "(7, 1, '2026-03-01', 'note', 'n', NULL), (8, 1, '2026-03-01', 'note', 'n', NULL)"
        )
    )


async def test_hour_events_unique_deletes_duplicates_keeping_the_lowest_id(engine):
    async with engine.begin() as conn:
        await _hour_events_with_duplicates(conn)
        await _migrate_hour_events_unique(conn)
        ids = [r[0] for r in await conn.execute(text("SELECT id FROM hour_events ORDER BY id"))]
        indexes = {r[1]: r[2] for r in await conn.execute(text("PRAGMA index_list(hour_events)"))}
    assert ids == [1, 3, 4, 6, 7, 8]  # notes are never deduplicated
    assert indexes["uq_hour_events_added"] == 1
    assert indexes["uq_hour_events_maintenance"] == 1


async def test_hour_events_unique_index_rejects_a_second_added(engine):
    from sqlalchemy.exc import IntegrityError

    async with engine.begin() as conn:
        await _hour_events_with_duplicates(conn)
        await _migrate_hour_events_unique(conn)
    async with engine.begin() as conn:
        await _migrate_hour_events_unique(conn)  # idempotent
        await conn.execute(text("INSERT INTO hour_events (machine_id, kind, label) VALUES (1, 'note', 'n')"))
    with pytest.raises(IntegrityError):
        async with engine.begin() as conn:
            await conn.execute(text("INSERT INTO hour_events (machine_id, kind, label) VALUES (1, 'added', 'x')"))
    async with engine.begin() as conn:
        count = (await conn.execute(text("SELECT COUNT(*) FROM hour_events"))).scalar()
    assert count == 7


async def test_retired_printer_column_is_added_once_without_backfill(engine):
    async with engine.begin() as conn:
        await _seed(conn)
        await _migrate_hour_machines_retired_printer(conn)
    async with engine.begin() as conn:
        await _migrate_hour_machines_retired_printer(conn)  # idempotent
        rows = (await conn.execute(text("SELECT id, retired_printer_id FROM hour_machines ORDER BY id"))).all()
    assert [tuple(r) for r in rows] == [(1, None), (2, None), (3, None)]
