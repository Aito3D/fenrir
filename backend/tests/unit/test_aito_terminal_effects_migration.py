"""T-059: `run_migrations` adds `effects_pending_at` to `aito_terminal_payments`
— a plain additive, nullable `ALTER TABLE` with no backfill, so every row that
existed before reads NULL ("no effects owed") and is never re-driven.

The pre-feature shape is the table exactly as `run_migrations`' own
`CREATE TABLE IF NOT EXISTS aito_terminal_payments` builds it, which is what a
database that ran every earlier migration holds."""

import pytest
from sqlalchemy import text


async def _columns(conn):
    return {row[1] for row in (await conn.execute(text("PRAGMA table_info(aito_terminal_payments)"))).all()}


@pytest.mark.asyncio
async def test_the_migration_adds_effects_pending_at_to_a_pre_feature_table(test_engine):
    from backend.app.core.database import run_migrations

    async with test_engine.begin() as conn:
        await conn.execute(text("DROP TABLE aito_terminal_payments"))
    async with test_engine.begin() as conn:
        await run_migrations(conn)  # re-creates the pre-feature table, then adds the column
        assert "effects_pending_at" in await _columns(conn)
        await conn.execute(
            text(
                "INSERT INTO aito_terminal_payments (project_id, document_kind, document_id, document_number,"
                " idempotency_key, amount, status, settled_at)"
                " VALUES (1, 'quote', 'est-1', 'DEV26-0001', 'k-old', 5000, 'paid', '2026-09-20 10:00:00')"
            )
        )
    async with test_engine.begin() as conn:
        await run_migrations(conn)  # a second boot: the duplicate column is swallowed
        owed = (await conn.execute(text("SELECT effects_pending_at FROM aito_terminal_payments"))).scalars().all()
    assert owed == [None]
