"""Regression test for the missing-runs PrintLogEntry backfill (run_migrations Step 3).

Older builds of the external-print completion path dropped ``write_log_entry``
for slicer-started prints, leaving finished archives with no PrintLogEntry row.
Every statistics surface aggregates PrintLogEntry, so those prints were
invisible in stats (571 finished archives on the reporter's DB) even though
they showed on the Archives page.

Step 3 of the print-log backfill inserts one entry per finished archive that
has none, dated at the print's own completion time, and is one-shot gated by
the ``print_log_missing_runs_backfilled`` settings key so it never resurrects
entries the user cleared via DELETE /print-log/.
"""

from __future__ import annotations

from datetime import datetime

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.database import run_migrations


@pytest.fixture(autouse=True)
def force_sqlite_dialect(monkeypatch):
    """Force the SQLite branch in run_migrations regardless of test env settings."""
    from backend.app.core import db_dialect

    monkeypatch.setattr(db_dialect, "is_sqlite", lambda: True)
    monkeypatch.setattr(db_dialect, "is_postgres", lambda: False)
    from backend.app.core import database as database_module

    monkeypatch.setattr(database_module, "is_sqlite", lambda: True)


def _register_all_models():
    """Import every model so Base.metadata knows the full schema.

    backend.app.models.__init__ covers most models; the second import pulls in
    the submodules it doesn't re-export (print_log itself among them).
    """
    import backend.app.models  # noqa: F401
    from backend.app.models import (  # noqa: F401
        external_link,
        print_log,
        print_queue,
        project_bom,
        slot_preset,
        virtual_printer,
    )


STARTED = datetime(2026, 3, 10, 12, 0, 0)
COMPLETED = datetime(2026, 3, 10, 13, 30, 0)


@pytest.fixture
async def engine_with_orphan_archives():
    """Fresh schema + three archives: a finished one with NO log entry (the
    dropped external print), one still printing, and a finished one whose run
    was logged normally. Only the first must gain an entry from the backfill."""
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from backend.app.core.database import Base
    from backend.app.models.archive import PrintArchive
    from backend.app.models.printer import Printer

    _register_all_models()

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    SessionLocal = async_sessionmaker(engine, expire_on_commit=False)
    async with SessionLocal() as session:
        session.add(Printer(id=1, name="X1C05", serial_number="S1", ip_address="10.0.0.1", access_code="123"))
        session.add(
            PrintArchive(
                id=1,
                filename="slicer_print.gcode.3mf",
                file_path="/x/slicer_print.gcode.3mf",
                file_size=100,
                print_name="slicer_print",
                printer_id=1,
                status="failed",
                started_at=STARTED,
                completed_at=COMPLETED,
                filament_type="PETG",
                filament_used_grams=25.0,
                cost=4.25,
                energy_kwh=0.42,
            )
        )
        session.add(
            PrintArchive(
                id=2,
                filename="running.gcode.3mf",
                file_path="/x/running.gcode.3mf",
                file_size=100,
                print_name="running",
                printer_id=1,
                status="printing",
            )
        )
        session.add(
            PrintArchive(
                id=3,
                filename="logged.gcode.3mf",
                file_path="/x/logged.gcode.3mf",
                file_size=100,
                print_name="logged",
                printer_id=1,
                status="completed",
            )
        )
        # Finished but with no timestamps at all — duration must stay NULL and
        # created_at must fall back to the archive's own created_at.
        session.add(
            PrintArchive(
                id=4,
                filename="no_timestamps.gcode.3mf",
                file_path="/x/no_timestamps.gcode.3mf",
                file_size=100,
                print_name="no_timestamps",
                printer_id=1,
                status="aborted",
            )
        )
        await session.commit()

    async with engine.begin() as conn:
        await conn.execute(
            text("""
                INSERT INTO print_log_entries
                    (id, archive_id, print_name, printer_id, status, created_at)
                VALUES (1, 3, 'logged', 1, 'completed', '2026-03-11 09:00:00')
            """)
        )

    yield engine
    await engine.dispose()


async def test_backfill_creates_entry_for_unlogged_finished_archive(engine_with_orphan_archives):
    async with engine_with_orphan_archives.begin() as conn:
        await run_migrations(conn)

    async with engine_with_orphan_archives.connect() as conn:
        result = await conn.execute(
            text("""
                SELECT print_name, printer_name, printer_id, status, duration_seconds,
                       filament_type, filament_used_grams, cost, energy_kwh, created_at
                FROM print_log_entries WHERE archive_id = 1
            """)
        )
        rows = result.all()

    assert len(rows) == 1
    (print_name, printer_name, printer_id, status, duration, ftype, grams, cost, kwh, created_at) = rows[0]
    assert print_name == "slicer_print"
    assert printer_name == "X1C05"  # joined from printers, archives carry no name
    assert printer_id == 1
    assert status == "failed"
    assert duration == 5400  # 12:00 → 13:30
    assert (ftype, grams, cost, kwh) == ("PETG", 25.0, 4.25, 0.42)
    # Dated at the print's completion so date-ranged stats bucket it correctly.
    assert created_at.startswith("2026-03-10 13:30:00")


async def test_backfill_handles_archives_without_timestamps(engine_with_orphan_archives):
    """No started_at/completed_at → NULL duration, created_at falls back to the
    archive's own created_at (never NULL — the column has a server default)."""
    async with engine_with_orphan_archives.begin() as conn:
        await run_migrations(conn)

    async with engine_with_orphan_archives.connect() as conn:
        result = await conn.execute(
            text("""
                SELECT l.status, l.duration_seconds, l.created_at, a.created_at
                FROM print_log_entries l JOIN print_archives a ON a.id = l.archive_id
                WHERE l.archive_id = 4
            """)
        )
        rows = result.all()

    assert len(rows) == 1
    status, duration, entry_created_at, archive_created_at = rows[0]
    assert status == "aborted"
    assert duration is None
    assert entry_created_at == archive_created_at


async def test_backfill_skips_printing_and_already_logged_archives(engine_with_orphan_archives):
    async with engine_with_orphan_archives.begin() as conn:
        await run_migrations(conn)

    async with engine_with_orphan_archives.connect() as conn:
        result = await conn.execute(
            text("SELECT archive_id, count(*) FROM print_log_entries GROUP BY archive_id ORDER BY archive_id")
        )
        rows = result.all()

    # archives 1 and 4 backfilled once each, archive 2 (printing) untouched,
    # archive 3 keeps its single pre-existing entry.
    assert rows == [(1, 1), (3, 1), (4, 1)]


async def test_backfill_is_one_shot_and_never_resurrects_cleared_entries(engine_with_orphan_archives):
    async with engine_with_orphan_archives.begin() as conn:
        await run_migrations(conn)

    # User clears the print log (DELETE /print-log/ semantics: entries only).
    async with engine_with_orphan_archives.begin() as conn:
        await conn.execute(text("DELETE FROM print_log_entries"))

    async with engine_with_orphan_archives.begin() as conn:
        await run_migrations(conn)

    async with engine_with_orphan_archives.connect() as conn:
        count = (await conn.execute(text("SELECT count(*) FROM print_log_entries"))).scalar()
        marker = (
            await conn.execute(text("SELECT value FROM settings WHERE key = 'print_log_missing_runs_backfilled'"))
        ).scalar_one_or_none()

    assert count == 0  # cleared entries stay cleared
    assert marker == "1"
