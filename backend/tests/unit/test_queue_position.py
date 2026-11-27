"""The queue position lock: PostgreSQL takes an advisory lock, SQLite executes nothing."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from backend.app.services.queue_position import QUEUE_POSITION_LOCK_KEY, lock_queue_positions


def _session(dialect: str) -> MagicMock:
    db = MagicMock()
    db.get_bind.return_value.dialect.name = dialect
    db.execute = AsyncMock()
    return db


@pytest.mark.asyncio
async def test_postgresql_takes_the_advisory_lock_with_the_queue_key():
    db = _session("postgresql")

    await lock_queue_positions(db)

    db.execute.assert_awaited_once()
    statement, params = db.execute.await_args.args
    assert str(statement) == "SELECT pg_advisory_xact_lock(1625, :k)"
    assert params == {"k": QUEUE_POSITION_LOCK_KEY}


@pytest.mark.asyncio
async def test_sqlite_executes_nothing():
    db = _session("sqlite")

    await lock_queue_positions(db)

    db.execute.assert_not_awaited()
