"""A stop that loses the race against the print finishing (user-approved behavior change, T-032).

The row flips to "completed" from a second session between the route's status read and its write.
"""

import pytest
from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.sql import Select

from backend.app.api.routes import print_queue as pq
from backend.app.core.printer_scope import PrinterScope
from backend.app.models.print_queue import PrintQueueItem
from backend.app.services import print_control


class _FinishingSession:
    """Delegates to a real session; after the first print_queue SELECT, the item completes."""

    def __init__(self, session: AsyncSession, flip_session: AsyncSession, item_id: int):
        self._session, self._flip, self._id, self._done = session, flip_session, item_id, False

    def __getattr__(self, name):
        return getattr(self._session, name)

    async def execute(self, stmt, *args, **kwargs):
        result = await self._session.execute(stmt, *args, **kwargs)
        if not self._done and isinstance(stmt, Select) and "FROM print_queue" in str(stmt):
            self._done = True
            await self._flip.execute(
                update(PrintQueueItem).where(PrintQueueItem.id == self._id).values(status="completed")
            )
            await self._flip.commit()
        return result


@pytest.fixture
async def printing_item(db_session, printer_factory, archive_factory):
    printer = await printer_factory()
    archive = await archive_factory(printer.id)
    item = PrintQueueItem(printer_id=printer.id, archive_id=archive.id, status="printing", position=1)
    db_session.add(item)
    await db_session.commit()
    return item.id


@pytest.fixture
async def route_session(test_engine):
    async with async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)() as session:
        yield session


@pytest.fixture
def stop_calls(monkeypatch):
    calls = []
    monkeypatch.setattr(print_control, "stop_print_by_user", lambda *a, **k: calls.append((a, k)) or True)
    return calls


async def _row(db_session, item_id):
    db_session.expire_all()
    return (await db_session.execute(select(PrintQueueItem).where(PrintQueueItem.id == item_id))).scalar_one()


@pytest.mark.asyncio
async def test_stop_lost_race_returns_409_and_keeps_completed(printing_item, db_session, route_session, stop_calls):
    racing = _FinishingSession(route_session, db_session, printing_item)
    with pytest.raises(HTTPException) as exc:
        await pq.stop_queue_item(printing_item, db=racing, auth_result=(None, True), printer_scope=PrinterScope())
    assert exc.value.status_code == 409
    row = await _row(db_session, printing_item)
    assert (row.status, row.completed_at, row.error_message) == ("completed", None, None)
    # The stop command is sent before the write, as it always was.
    assert len(stop_calls) == 1


@pytest.mark.asyncio
async def test_stop_normal_path_unchanged(printing_item, db_session, route_session, stop_calls):
    out = await pq.stop_queue_item(
        printing_item, db=route_session, auth_result=(None, True), printer_scope=PrinterScope()
    )
    assert out == {"message": "Print stopped"}
    row = await _row(db_session, printing_item)
    assert (row.status, row.error_message) == ("cancelled", "Stopped by user")
    assert row.completed_at is not None
