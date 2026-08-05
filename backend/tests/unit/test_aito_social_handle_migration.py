"""The two social-handle columns on aito_projects.

`backend/tests/conftest.py`'s `db_session` fixture builds its schema with
`Base.metadata.create_all` and never calls `run_migrations`, so the ORM-level
tests below never execute the two `ALTER TABLE` statements added to
`run_migrations` in `backend/app/core/database.py`. A name or type mismatch
between a migration and its model would pass on a schema built fresh from
metadata and only break on an upgraded one. The migration tests at the bottom
close that gap the same way `test_aito_shipping_migration.py` does: build a
legacy pre-migration schema by hand, drive the real `run_migrations` path, and
assert on the resulting DDL.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.database import Base, run_migrations
from backend.app.models.aito_project import AitoProject

SOCIAL_COLUMNS = ("client_social_network", "client_social_handle")

EXPECTED_TYPES = {
    "client_social_network": "VARCHAR(20)",
    "client_social_handle": "VARCHAR(100)",
}


def test_model_declares_both_social_columns():
    for name in SOCIAL_COLUMNS:
        assert name in AitoProject.__table__.columns, f"{name} missing from the model"
        assert AitoProject.__table__.columns[name].nullable, f"{name} must be nullable"


@pytest.mark.asyncio
async def test_columns_default_to_null(db_session):
    project = AitoProject(description="no social", board_column="devis", position=0)
    db_session.add(project)
    await db_session.commit()
    stored = (await db_session.execute(select(AitoProject).where(AitoProject.id == project.id))).scalar_one()
    for name in SOCIAL_COLUMNS:
        assert getattr(stored, name) is None


@pytest.mark.asyncio
async def test_columns_round_trip(db_session):
    project = AitoProject(
        description="reachable on instagram only",
        board_column="devis",
        position=0,
        client_social_network="instagram",
        client_social_handle="aito.3d",
    )
    db_session.add(project)
    await db_session.commit()
    stored = (await db_session.execute(select(AitoProject).where(AitoProject.id == project.id))).scalar_one()
    assert stored.client_social_network == "instagram"
    assert stored.client_social_handle == "aito.3d"


# --- Migration coverage --------------------------------------------------
# The tests above exercise the ORM model only. These drive `run_migrations`
# itself against a schema built without the two columns, mirroring the legacy
# database every existing installation boots from.


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
    """A schema with the two social columns dropped immediately after creation,
    simulating the pre-migration database (SQLite 3.35+ supports DROP COLUMN,
    the same trick `test_aito_shipping_migration.py` uses)."""
    _register_all_models()

    eng = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        for name in SOCIAL_COLUMNS:
            await conn.execute(text(f"ALTER TABLE aito_projects DROP COLUMN {name}"))
    yield eng
    await eng.dispose()


async def _column_info(conn, table, column):
    result = await conn.execute(text(f"PRAGMA table_info({table})"))
    for _cid, name, col_type, notnull, dflt_value, _pk in result.all():
        if name == column:
            return col_type, notnull, dflt_value
    return None


@pytest.mark.asyncio
async def test_migration_adds_both_columns_to_a_legacy_schema(engine):
    async with engine.begin() as conn:
        await run_migrations(conn)

    async with engine.connect() as conn:
        for name, expected_type in EXPECTED_TYPES.items():
            info = await _column_info(conn, "aito_projects", name)
            assert info is not None, f"{name} was not added by run_migrations"
            col_type, notnull, dflt_value = info
            assert col_type == expected_type, f"{name}: expected {expected_type}, got {col_type}"
            assert notnull == 0, f"{name} must be nullable"
            assert dflt_value is None, f"{name} must have no default"


@pytest.mark.asyncio
async def test_migration_is_idempotent(engine):
    """Every boot re-runs the full migration set; a second pass over an
    already-migrated schema must not raise — `_safe_execute` swallows SQLite's
    'duplicate column name', which is what stops the app crashing on its second
    boot."""
    async with engine.begin() as conn:
        await run_migrations(conn)

    async with engine.begin() as conn:
        await run_migrations(conn)  # second run: must not raise

    async with engine.connect() as conn:
        for name, expected_type in EXPECTED_TYPES.items():
            info = await _column_info(conn, "aito_projects", name)
            assert info is not None
            col_type, notnull, _dflt_value = info
            assert col_type == expected_type
            assert notnull == 0
