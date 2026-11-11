"""The Order Board's local stamps: prep sheet printed, client contacted."""

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.services import order_board_sync as sync
from backend.app.services.order_board_actions._common import _log, _row


def _prep_query(salesorder_id: str):
    return select(OrderBoardDoc).where(OrderBoardDoc.kind == "prep", OrderBoardDoc.zoho_id == salesorder_id)


async def stamp_print(db: AsyncSession, salesorder_id: str, by: str, picklist: str | None = None) -> dict:
    await _row(db, salesorder_id)
    stamp = {"at": sync._now(), "by": by}
    doc = (await db.execute(_prep_query(salesorder_id))).scalar_one_or_none()
    if doc is None:
        db.add(OrderBoardDoc(kind="prep", zoho_id=salesorder_id, header=stamp))
    else:
        doc.header = stamp
    try:
        await db.commit()
    except IntegrityError:  # a simultaneous first stamp won the unique key: update theirs
        await db.rollback()
        doc = (await db.execute(_prep_query(salesorder_id))).scalar_one()
        doc.header = stamp
        await db.commit()
    await _log(db, salesorder_id, "prep.printed", by, picklist=picklist)
    await sync.announce_board_change()
    return await _row(db, salesorder_id)


async def stamp_contact(db: AsyncSession, salesorder_id: str, by: str) -> dict:
    """Record that the client got the pickup SMS. The first stamp is kept, so a resend does not reset
    how long the client has been waiting."""
    row = await _row(db, salesorder_id)
    query = select(OrderBoardDoc).where(OrderBoardDoc.kind == "contact", OrderBoardDoc.zoho_id == salesorder_id)
    if (await db.execute(query)).scalar_one_or_none() is None:
        db.add(OrderBoardDoc(kind="contact", zoho_id=salesorder_id, header={"at": sync._now(), "by": by}))
        try:
            await db.commit()
        except IntegrityError:  # a simultaneous first stamp won the unique key: keep theirs
            await db.rollback()
        else:
            await sync.announce_board_change()
    contact = row.get("contact") or {}  # the number only, never the message
    await _log(db, salesorder_id, "sms.sent", by, to=contact.get("mobile") or contact.get("phone") or "")
    return await _row(db, salesorder_id)
