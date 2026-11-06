"""`aito_payment_links.deposit` is added to a legacy schema by run_migrations, idempotently."""

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core import database as database_module
from backend.app.core.database import Base, run_migrations
from backend.app.models import aito_payment_link  # noqa: F401


@pytest.mark.asyncio
async def test_migration_adds_a_nullable_deposit_column_idempotently(monkeypatch):
    monkeypatch.setattr(database_module, "is_sqlite", lambda: True)
    eng = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(text("ALTER TABLE aito_payment_links DROP COLUMN deposit"))
    for _ in range(2):  # the second boot must not raise
        async with eng.begin() as conn:
            await run_migrations(conn)
    async with eng.connect() as conn:
        cols = {r[1]: (r[3], r[4]) for r in (await conn.execute(text("PRAGMA table_info(aito_payment_links)"))).all()}
    await eng.dispose()
    assert cols["deposit"] == (0, None)
