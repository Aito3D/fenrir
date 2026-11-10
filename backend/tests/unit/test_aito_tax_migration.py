"""`run_migrations` adds the nullable `tax_id` and `tax_pct` columns to an
existing `aito_projects` table (engines from the quote_status_confirmed test)."""

import pytest
from sqlalchemy import text

from backend.app.core.database import run_migrations
from backend.tests.unit.test_aito_quote_status_confirmed_migration import _make_engine, _seed


@pytest.mark.asyncio
async def test_the_column_is_added_nullable_and_a_second_boot_keeps_values():
    engine = await _make_engine()
    try:
        async with engine.begin() as conn:
            await conn.execute(text("ALTER TABLE aito_projects DROP COLUMN tax_id"))
            await conn.execute(text("ALTER TABLE aito_projects DROP COLUMN tax_pct"))
            project_id = await _seed(conn, "Piece preexistante")

        async with engine.begin() as conn:
            await run_migrations(conn)
        async with engine.begin() as conn:
            info = {row[1]: row for row in (await conn.execute(text("PRAGMA table_info(aito_projects)"))).all()}
            assert "tax_id" in info and "tax_pct" in info
            assert info["tax_id"][3] == 0  # nullable
            await conn.execute(
                text("UPDATE aito_projects SET tax_id = :v WHERE id = :p"),
                {"v": "66407000000068001", "p": project_id},
            )

        async with engine.begin() as conn:
            await run_migrations(conn)
        async with engine.connect() as conn:
            value = (
                await conn.execute(text("SELECT tax_id FROM aito_projects WHERE id = :p"), {"p": project_id})
            ).scalar_one()
        assert value == "66407000000068001"
    finally:
        await engine.dispose()
