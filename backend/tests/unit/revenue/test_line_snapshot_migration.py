"""run_migrations adds the frozen cost and tax rate columns to a revenue_day_lines table that predates them."""

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.database import Base, load_all_models, run_migrations

COLUMNS = ("unit_cost", "tax_percentage")


@pytest.fixture(autouse=True)
def force_sqlite_dialect(monkeypatch):
    from backend.app.core import database, db_dialect

    monkeypatch.setattr(db_dialect, "is_sqlite", lambda: True)
    monkeypatch.setattr(db_dialect, "is_postgres", lambda: False)
    monkeypatch.setattr(database, "is_sqlite", lambda: True)


async def test_migration_adds_the_nullable_columns_and_is_idempotent():
    load_all_models()
    eng = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with eng.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            for name in COLUMNS:
                await conn.execute(text(f"ALTER TABLE revenue_day_lines DROP COLUMN {name}"))
        for _ in range(2):
            async with eng.begin() as conn:
                await run_migrations(conn)
        async with eng.connect() as conn:
            cols = {r[1]: (r[2], r[3]) for r in await conn.execute(text("PRAGMA table_info(revenue_day_lines)"))}
        for name in COLUMNS:
            assert cols[name] == ("FLOAT", 0)
    finally:
        await eng.dispose()
