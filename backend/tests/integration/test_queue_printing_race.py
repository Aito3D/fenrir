"""A cancel or delete that loses the race against the scheduler's pending -> printing move.

The row flips to "printing" from a second session between the route's status read and its write
(user-approved behavior change, T-012).
"""

import pytest
from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.sql import Select

from backend.app.api.routes import print_queue as pq
from backend.app.core.printer_scope import PrinterScope
from backend.app.models.print_queue import PrintQueueItem


class _RacingSession:
    """Delegates to a real session; after the first print_queue SELECT, the given ids start printing."""

    def __init__(self, session: AsyncSession, flip_session: AsyncSession, ids: list[int]):
        self._session, self._flip, self._ids, self._done = session, flip_session, ids, False

    def __getattr__(self, name):
        return getattr(self._session, name)

    async def execute(self, stmt, *args, **kwargs):
        result = await self._session.execute(stmt, *args, **kwargs)
        if not self._done and isinstance(stmt, Select) and "FROM print_queue" in str(stmt):
            self._done = True
            await self._flip.execute(
                update(PrintQueueItem).where(PrintQueueItem.id.in_(self._ids)).values(status="printing")
            )
            await self._flip.commit()
        return result


@pytest.fixture
async def make_item(db_session, printer_factory, archive_factory):
    printer = await printer_factory()
    archive = await archive_factory(printer.id)

    async def _make(**kwargs):
        item = PrintQueueItem(printer_id=printer.id, archive_id=archive.id, status="pending", position=1, **kwargs)
        db_session.add(item)
        await db_session.commit()
        return item.id

    return _make


@pytest.fixture
async def route_session(test_engine):
    async with async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)() as session:
        yield session


async def _status(db_session, item_id):
    db_session.expire_all()
    return (
        await db_session.execute(select(PrintQueueItem.status).where(PrintQueueItem.id == item_id))
    ).scalar_one_or_none()


@pytest.mark.asyncio
async def test_cancel_lost_race_returns_409(make_item, db_session, route_session):
    item_id = await make_item()
    racing = _RacingSession(route_session, db_session, [item_id])
    with pytest.raises(HTTPException) as exc:
        await pq.cancel_queue_item(item_id, db=racing, auth_result=(None, True), printer_scope=PrinterScope())
    assert exc.value.status_code == 409
    assert "already printing" in exc.value.detail
    assert await _status(db_session, item_id) == "printing"


@pytest.mark.asyncio
async def test_cancel_normal_path_unchanged(make_item, db_session, route_session):
    item_id = await make_item()
    out = await pq.cancel_queue_item(item_id, db=route_session, auth_result=(None, True), printer_scope=PrinterScope())
    assert out == {"message": "Queue item cancelled"}
    assert await _status(db_session, item_id) == "cancelled"
    row = (await db_session.execute(select(PrintQueueItem).where(PrintQueueItem.id == item_id))).scalar_one()
    assert row.completed_at is not None


@pytest.mark.asyncio
async def test_delete_lost_race_returns_409_and_keeps_row(make_item, db_session, route_session):
    item_id = await make_item()
    racing = _RacingSession(route_session, db_session, [item_id])
    with pytest.raises(HTTPException) as exc:
        await pq.delete_queue_item(item_id, db=racing, auth_result=(None, True), printer_scope=PrinterScope())
    assert exc.value.status_code == 409
    assert "already printing" in exc.value.detail
    assert await _status(db_session, item_id) == "printing"


@pytest.mark.asyncio
async def test_delete_normal_path_unchanged(make_item, db_session, route_session):
    item_id = await make_item()
    await pq.delete_queue_item(item_id, db=route_session, auth_result=(None, True), printer_scope=PrinterScope())
    assert await _status(db_session, item_id) is None


@pytest.mark.asyncio
async def test_cancel_batch_skips_row_that_started_printing(
    printer_factory, archive_factory, db_session, route_session
):
    from backend.app.models.print_batch import PrintBatch

    printer = await printer_factory()
    archive = await archive_factory(printer.id)
    batch = PrintBatch(name="b", archive_id=archive.id, quantity=2, status="active")
    db_session.add(batch)
    await db_session.commit()
    ids = []
    for pos in (1, 2):
        item = PrintQueueItem(
            printer_id=printer.id, archive_id=archive.id, status="pending", position=pos, batch_id=batch.id
        )
        db_session.add(item)
        await db_session.commit()
        ids.append(item.id)
    racing = _RacingSession(route_session, db_session, ids[:1])
    out = await pq.cancel_batch(batch.id, db=racing, current_user=None, printer_scope=PrinterScope())
    assert out == {"message": "Batch cancelled, 1 pending items cancelled"}
    assert await _status(db_session, ids[0]) == "printing"
    assert await _status(db_session, ids[1]) == "cancelled"
