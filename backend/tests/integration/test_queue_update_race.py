"""A single edit that loses the race against the scheduler's pending -> printing move returns 409.

The row flips to "printing" (dispatch claim already cleared) from a second session between the
route's first read and its pre-write re-check (user-approved behavior change, T-033).
"""

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from backend.app.api.routes import print_queue as pq
from backend.app.core.printer_scope import PrinterScope
from backend.app.models.print_queue import PrintQueueItem
from backend.app.schemas.print_queue import PrintQueueItemUpdate
from backend.tests.integration.test_queue_printing_race import (  # noqa: F401  (fixtures)
    _RacingSession,
    route_session,
)


@pytest.mark.asyncio
async def test_update_lost_race_returns_409_and_leaves_the_row_alone(
    printer_factory, archive_factory, db_session, route_session
):
    printer = await printer_factory()
    other = await printer_factory(name="Other", serial_number="00M09A000000099")
    archive = await archive_factory(printer.id)
    item = PrintQueueItem(printer_id=printer.id, archive_id=archive.id, status="pending", position=1)
    db_session.add(item)
    await db_session.commit()
    item_id, printer_id, other_id = item.id, printer.id, other.id

    racing = _RacingSession(route_session, db_session, [item_id])
    with pytest.raises(HTTPException) as exc:
        await pq.update_queue_item(
            item_id,
            PrintQueueItemUpdate(printer_id=other_id),
            db=racing,
            auth_result=(None, True),
            can_read_aito=False,
            printer_scope=PrinterScope(),
            actor=None,
        )
    assert exc.value.status_code == 409
    assert exc.value.detail == "Item is no longer pending — it has already started printing"

    db_session.expire_all()
    row = (await db_session.execute(select(PrintQueueItem).where(PrintQueueItem.id == item_id))).scalar_one()
    assert row.status == "printing"
    assert row.printer_id == printer_id
