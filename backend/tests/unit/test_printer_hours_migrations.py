"""The Hours tab's new columns are added to old databases, and calibrated_at is backfilled."""

from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.database import _migrate_printer_hours_columns

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
