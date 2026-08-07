"""Regression test for the "one quote, one active project" partial unique
index migration (2026-07-29 follow-up, review B-4).

`backend/tests/conftest.py` builds its schema with `Base.metadata.create_all`
and never calls `run_migrations`, and the index is not part of
`AitoProject.__table_args__` — so none of `test_aito_routes.py`'s route-level
tests exercise the index at all; a predicate drifting out of sync with
`_reject_duplicate_quote`'s WHERE clause (the exact hazard the original task
brief called out) would turn a would-be 409 into an uncaught 500 with nothing
in the suite able to catch it. This file builds the schema, runs the real
migration, and asserts the index itself — on both fresh and legacy-with-a-
pre-existing-duplicate schemas — following the pattern in
`test_vp_mode_rename_migration.py:144-147` for idempotency.
"""

from __future__ import annotations

import logging

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from backend.app.core.database import run_migrations


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


async def _insert_project(conn, *, id: int, board_column: str, status: str, quote_id: str | None) -> None:
    await conn.execute(
        text(
            "INSERT INTO aito_projects (id, description, board_column, position, status, quote_id) "
            "VALUES (:id, 'x', :board_column, 0, :status, :quote_id)"
        ),
        {"id": id, "board_column": board_column, "status": status, "quote_id": quote_id},
    )


@pytest.mark.asyncio
async def test_the_index_is_created_on_a_fresh_schema(engine):
    """No pre-existing rows: the index must build, and re-running the whole
    migration set (every boot) must be a no-op — `IF NOT EXISTS` covers this,
    but the assertion is on real behaviour, not just the SQL's own idempotency
    keyword."""
    async with engine.begin() as conn:
        await run_migrations(conn)
    async with engine.begin() as conn:
        await run_migrations(conn)  # second run: must not raise

    async with engine.connect() as conn:
        result = await conn.execute(
            text("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'uq_aito_project_active_quote'")
        )
        assert result.scalar() == "uq_aito_project_active_quote"


@pytest.mark.asyncio
async def test_a_second_active_project_for_the_same_quote_is_rejected_by_the_index(engine):
    """The index, not just the route guard, is what makes the rule true under
    concurrent writers. Insert one active project holding a quote, run the
    migration to build the index, then attempt to insert a second active
    project on the same quote directly — bypassing the route entirely — and
    confirm the database itself refuses it."""
    async with engine.begin() as conn:
        await _insert_project(conn, id=1, board_column="devis", status="active", quote_id="EST-9")

    async with engine.begin() as conn:
        await run_migrations(conn)

    with pytest.raises(IntegrityError):
        async with engine.begin() as conn:
            await _insert_project(conn, id=2, board_column="devis", status="active", quote_id="EST-9")


@pytest.mark.asyncio
async def test_a_trashed_project_sharing_a_quote_with_an_active_one_is_not_rejected(engine):
    """The index is partial on status = 'active': a soft-deleted sibling must
    stay legal, or the "trashing frees the quote for re-import" workflow the
    whole task exists for would be blocked at the database layer even after
    the route guard allows it."""
    async with engine.begin() as conn:
        await _insert_project(conn, id=1, board_column="devis", status="active", quote_id="EST-9")

    async with engine.begin() as conn:
        await run_migrations(conn)

    async with engine.begin() as conn:
        # Must not raise.
        await _insert_project(conn, id=2, board_column="devis", status="deleted", quote_id="EST-9")

    async with engine.connect() as conn:
        result = await conn.execute(text("SELECT COUNT(*) FROM aito_projects WHERE quote_id = 'EST-9'"))
        assert result.scalar() == 2


@pytest.mark.asyncio
async def test_a_pre_existing_duplicate_is_skipped_not_fatal(engine, caplog):
    """B-3: this rule is new, so a board that already carries two active
    projects sharing a quote (perfectly legal before this migration) must not
    make the whole application fail to boot. Seed the illegal state directly
    (bypassing the route guard, exactly as old data would have), then assert
    `run_migrations` completes without raising and the index is simply
    absent — not that the illegal rows get silently deleted or repaired."""
    async with engine.begin() as conn:
        await _insert_project(conn, id=1, board_column="devis", status="active", quote_id="EST-9")
        await _insert_project(conn, id=2, board_column="devis", status="active", quote_id="EST-9")

    with caplog.at_level(logging.ERROR, logger="backend.app.core.database"):
        async with engine.begin() as conn:
            await run_migrations(conn)  # must not raise

    assert "uq_aito_project_active_quote" in caplog.text
    assert "EST-9" in caplog.text

    async with engine.connect() as conn:
        result = await conn.execute(
            text("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'uq_aito_project_active_quote'")
        )
        assert result.scalar() is None  # skipped, not created over illegal data

        rows = await conn.execute(text("SELECT COUNT(*) FROM aito_projects WHERE quote_id = 'EST-9'"))
        assert rows.scalar() == 2  # untouched — no silent repair


@pytest.fixture
async def migrated_session(engine):
    """A session bound to a schema that has actually run `run_migrations` —
    unlike `conftest.py`'s `db_session`/`async_client` fixtures (built via
    `Base.metadata.create_all`, see the module docstring), so
    `uq_aito_project_active_quote` genuinely exists underneath it."""
    async with engine.begin() as conn:
        await run_migrations(conn)
    session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_maker() as session:
        yield session


async def _bypass_precheck(monkeypatch):
    """Patch `_reject_duplicate_quote` to a no-op, reproducing the window a
    genuine concurrent request would hit: both requests pass the SELECT
    pre-check and race each other into the unique index at commit."""
    from backend.app.api.routes import aito as aito_routes

    async def _noop(db, quote_id, exclude_id=None):
        return None

    monkeypatch.setattr(aito_routes, "_reject_duplicate_quote", _noop)
    return aito_routes


@pytest.mark.asyncio
async def test_a_concurrent_create_race_on_the_index_is_a_409_not_a_500(migrated_session, monkeypatch):
    """T-001: `_reject_duplicate_quote` (aito.py's SELECT pre-check) is TOCTOU
    — two concurrent creates for the same quote can both pass it and then
    race each other into `uq_aito_project_active_quote` at commit
    (aito.py:744). Bypassing the pre-check reproduces exactly that race; the
    commit must map the resulting IntegrityError to the SAME 409 the
    pre-check itself raises, not let it escape as an unhandled 500."""
    from backend.app.api.routes import aito as aito_routes
    from backend.app.schemas.aito import AitoProjectCreate

    payload = AitoProjectCreate(
        description="Helice",
        client_id="C1",
        client_name="Client",
        quote_id="EST-9",
        quote_number="QT-9",
    )
    first = await aito_routes.create_project(payload=payload, db=migrated_session, current_user=None)
    assert first.quote_id == "EST-9"

    await _bypass_precheck(monkeypatch)

    with pytest.raises(HTTPException) as exc_info:
        await aito_routes.create_project(payload=payload, db=migrated_session, current_user=None)
    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == aito_routes._DUPLICATE_QUOTE_DETAIL


@pytest.mark.asyncio
async def test_a_concurrent_restore_race_on_the_index_is_a_409_not_a_500(migrated_session, monkeypatch):
    """T-001, the restore side (aito.py:1726-1730 in the evidence trail): a
    project is trashed to free its quote, a second project claims that quote,
    then the first is restored. If the restore's own pre-check is bypassed —
    exactly what a genuine concurrent restore would race past — the real
    partial unique index, not the pre-check, must be what turns this into a
    409 rather than an unhandled 500."""
    from backend.app.api.routes import aito as aito_routes
    from backend.app.schemas.aito import AitoProjectCreate

    payload = AitoProjectCreate(
        description="Helice",
        client_id="C1",
        client_name="Client",
        quote_id="EST-9",
        quote_number="QT-9",
    )
    first = await aito_routes.create_project(payload=payload, db=migrated_session, current_user=None)
    await aito_routes.delete_project(project_id=first.id, db=migrated_session, current_user=None)
    await aito_routes.create_project(payload=payload, db=migrated_session, current_user=None)  # claims the quote

    await _bypass_precheck(monkeypatch)

    with pytest.raises(HTTPException) as exc_info:
        await aito_routes.restore_project(project_id=first.id, db=migrated_session, current_user=None)
    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == aito_routes._DUPLICATE_QUOTE_DETAIL
