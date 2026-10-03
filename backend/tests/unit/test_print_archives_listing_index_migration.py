"""The archive listing (`WHERE deleted_at IS NULL ORDER BY created_at DESC`)
needs a composite index, or SQLite sorts every row through a temp B-tree.
Fresh installs get it from the model (create_all); existing installs from
run_migrations."""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.database import run_migrations

INDEX = "ix_print_archives_deleted_created"


@pytest.fixture(autouse=True)
def force_sqlite_dialect(monkeypatch):
    """Force the SQLite branch regardless of test env settings."""
    from backend.app.core import db_dialect

    monkeypatch.setattr(db_dialect, "is_sqlite", lambda: True)
    monkeypatch.setattr(db_dialect, "is_postgres", lambda: False)
    from backend.app.core import database as database_module

    monkeypatch.setattr(database_module, "is_sqlite", lambda: True)


def _register_all_models():
    """run_migrations touches multiple tables; the full schema must exist."""
    from backend.app.models import (  # noqa: F401
        aito_project,
        aito_task,
        ams_history,
        ams_label,
        api_key,
        archive,
        color_catalog,
        external_link,
        filament,
        group,
        kprofile_note,
        maintenance,
        notification,
        notification_template,
        print_log,
        print_queue,
        printer,
        project,
        project_bom,
        settings,
        slot_preset,
        smart_plug,
        smart_plug_energy_snapshot,
        spool,
        spool_assignment,
        spool_catalog,
        spool_k_profile,
        spool_usage_history,
        spoolbuddy_device,
        user,
        user_email_pref,
        virtual_printer,
    )


@pytest.fixture
async def engine():
    from backend.app.core.database import Base

    _register_all_models()
    eng = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    await eng.dispose()


async def _index_exists(conn) -> bool:
    result = await conn.execute(text("SELECT name FROM sqlite_master WHERE type = 'index' AND name = :n"), {"n": INDEX})
    return result.scalar() == INDEX


@pytest.mark.asyncio
async def test_create_all_builds_the_index(engine):
    async with engine.connect() as conn:
        assert await _index_exists(conn)


@pytest.mark.asyncio
async def test_migration_adds_the_index_to_a_legacy_schema_and_is_idempotent(engine):
    async with engine.begin() as conn:
        await conn.execute(text(f"DROP INDEX IF EXISTS {INDEX}"))
    async with engine.begin() as conn:
        await run_migrations(conn)
    async with engine.begin() as conn:
        await run_migrations(conn)  # every boot re-runs it
    async with engine.connect() as conn:
        assert await _index_exists(conn)


@pytest.mark.asyncio
async def test_listing_query_uses_the_index(engine):
    async with engine.connect() as conn:
        plan = await conn.execute(
            text("EXPLAIN QUERY PLAN SELECT id FROM print_archives WHERE deleted_at IS NULL ORDER BY created_at DESC")
        )
        details = " ".join(str(row[-1]) for row in plan.all())
    assert INDEX in details
    assert "TEMP B-TREE" not in details
