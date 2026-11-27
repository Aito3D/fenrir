"""POST /queue/ caps the copy count at 999 (T-013); zero or less still means one copy."""

import pytest
from sqlalchemy import func, select

from backend.app.models.print_queue import PrintQueueItem

pytestmark = [pytest.mark.asyncio, pytest.mark.integration]


async def _count(db_session):
    return await db_session.scalar(select(func.count()).select_from(PrintQueueItem))


async def test_more_than_999_copies_is_rejected(async_client, db_session, printer_factory, archive_factory):
    printer = await printer_factory()
    archive = await archive_factory(printer.id)

    response = await async_client.post(
        "/api/v1/queue/", json={"archive_id": archive.id, "printer_id": printer.id, "quantity": 1000}
    )

    assert response.status_code == 422
    assert await _count(db_session) == 0


@pytest.mark.parametrize("quantity", [0, -5])
async def test_zero_or_less_is_still_one_copy(async_client, db_session, printer_factory, archive_factory, quantity):
    printer = await printer_factory()
    archive = await archive_factory(printer.id)

    response = await async_client.post(
        "/api/v1/queue/", json={"archive_id": archive.id, "printer_id": printer.id, "quantity": quantity}
    )

    assert response.status_code == 200, response.text
    assert await _count(db_session) == 1
