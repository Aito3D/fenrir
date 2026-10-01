"""`run_migrations` adds `client_push_pending` to an existing `aito_projects`
table: a plain additive ALTER, NOT NULL with a false default, the same shape
as `quote_status_confirmed` (whose migration test supplies the engines)."""

import pytest
from sqlalchemy import text

from backend.app.core.database import run_migrations
from backend.tests.unit.test_aito_quote_status_confirmed_migration import _make_engine, _seed


async def _make_pre_feature_engine():
    engine = await _make_engine()
    async with engine.begin() as conn:
        await conn.execute(text("ALTER TABLE aito_projects DROP COLUMN client_push_pending"))
    return engine


@pytest.mark.asyncio
async def test_the_column_is_added_to_an_existing_table_and_defaults_false():
    engine = await _make_pre_feature_engine()
    try:
        async with engine.begin() as conn:
            columns = {row[1] for row in (await conn.execute(text("PRAGMA table_info(aito_projects)"))).all()}
            assert "client_push_pending" not in columns
            project_id = await _seed(conn, "Piece preexistante")

        async with engine.begin() as conn:
            await run_migrations(conn)

        async with engine.connect() as conn:
            info = {row[1]: row for row in (await conn.execute(text("PRAGMA table_info(aito_projects)"))).all()}
            flag = (
                await conn.execute(
                    text("SELECT client_push_pending FROM aito_projects WHERE id = :p"), {"p": project_id}
                )
            ).scalar_one()
        assert "client_push_pending" in info
        assert info["client_push_pending"][3] == 1  # NOT NULL
        assert flag == 0
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_a_second_boot_keeps_a_set_flag():
    engine = await _make_engine()
    try:
        async with engine.begin() as conn:
            project_id = await _seed(conn, "Piece transferee")
            await conn.execute(
                text("UPDATE aito_projects SET client_push_pending = 1 WHERE id = :p"), {"p": project_id}
            )

        async with engine.begin() as conn:
            await run_migrations(conn)

        async with engine.connect() as conn:
            flag = (
                await conn.execute(
                    text("SELECT client_push_pending FROM aito_projects WHERE id = :p"), {"p": project_id}
                )
            ).scalar_one()
        assert flag == 1
    finally:
        await engine.dispose()
