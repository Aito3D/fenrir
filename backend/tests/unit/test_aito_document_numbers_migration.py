"""`run_migrations` adds the nullable `document_numbers` column to an
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
            await conn.execute(text("ALTER TABLE aito_projects DROP COLUMN document_numbers"))
            project_id = await _seed(conn, "Piece preexistante")

        async with engine.begin() as conn:
            await run_migrations(conn)
        async with engine.begin() as conn:
            info = {row[1]: row for row in (await conn.execute(text("PRAGMA table_info(aito_projects)"))).all()}
            assert "document_numbers" in info
            assert info["document_numbers"][3] == 0  # nullable
            await conn.execute(
                text("UPDATE aito_projects SET document_numbers = :v WHERE id = :p"),
                {"v": '["INV-1"]', "p": project_id},
            )

        async with engine.begin() as conn:
            await run_migrations(conn)
        async with engine.connect() as conn:
            value = (
                await conn.execute(text("SELECT document_numbers FROM aito_projects WHERE id = :p"), {"p": project_id})
            ).scalar_one()
        assert value == '["INV-1"]'
    finally:
        await engine.dispose()
