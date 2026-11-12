"""The test database's replayed schema is the one create_all builds.

conftest's test_engine runs create_all once per worker and replays the DDL it
read back for every later test. A replay that dropped or changed anything
would make every database test run on a schema the app never has.
"""

import pytest
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.database import Base, load_all_models
from backend.tests import conftest

_SCHEMA = "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name"


async def _schema_of(engine) -> list[tuple]:
    async with engine.connect() as conn:
        return [tuple(row) for row in await conn.exec_driver_sql(_SCHEMA)]


@pytest.mark.sqlite_only
async def test_replayed_schema_matches_create_all(monkeypatch):
    load_all_models()
    monkeypatch.setattr(conftest, "_sqlite_schema", {})
    built = create_async_engine(conftest.TEST_DATABASE_URL)
    replayed = create_async_engine(conftest.TEST_DATABASE_URL)
    reference = create_async_engine(conftest.TEST_DATABASE_URL)
    try:
        await conftest._create_sqlite_test_schema(built)  # create_all, fills the cache
        await conftest._create_sqlite_test_schema(replayed)  # the replay
        async with reference.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

        expected = await _schema_of(reference)
        assert len(expected) > len(Base.metadata.tables)  # tables and their indexes
        assert await _schema_of(built) == expected
        assert await _schema_of(replayed) == expected
    finally:
        for engine in (built, replayed, reference):
            await engine.dispose()
