"""The Order Board's writes towards Books: print stamp and parcel creation."""

import logging
from contextlib import contextmanager
from datetime import date

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.services import order_board_sync as sync
from backend.app.services.zoho import zoho_service

logger = logging.getLogger(__name__)

_writing: set[str] = set()


class OrderNotOnBoard(Exception):
    """The order has no row on the stored board."""


class OrderBusy(Exception):
    """Another write on this order is still running."""


class OrderActionRefused(Exception):
    """args[0] is one of "nothing_to_pack", "unknown_line", "too_many"."""


@contextmanager
def writing(salesorder_id: str):
    if salesorder_id in _writing:
        raise OrderBusy(salesorder_id)
    _writing.add(salesorder_id)
    try:
        yield
    finally:
        _writing.discard(salesorder_id)


def _prep_query(salesorder_id: str):
    return select(OrderBoardDoc).where(OrderBoardDoc.kind == "prep", OrderBoardDoc.zoho_id == salesorder_id)


async def _row(db: AsyncSession, salesorder_id: str) -> dict:
    row = await sync.find_board_row(db, salesorder_id)
    if row is None:
        raise OrderNotOnBoard(salesorder_id)
    return row


async def stamp_print(db: AsyncSession, salesorder_id: str, by: str) -> dict:
    await _row(db, salesorder_id)
    stamp = {"at": sync._now(), "by": by}
    doc = (await db.execute(_prep_query(salesorder_id))).scalar_one_or_none()
    if doc is None:
        db.add(OrderBoardDoc(kind="prep", zoho_id=salesorder_id, header=stamp))
    else:
        doc.header = stamp
    await db.commit()
    return await _row(db, salesorder_id)


async def create_parcel(db: AsyncSession, salesorder_id: str, quantities: dict[str, float]) -> str:
    """Create a package for the given line quantities; returns Books' package number."""
    row = await _row(db, salesorder_id)
    wanted = {line_id: q for line_id, q in quantities.items() if q > 0}
    if not wanted:
        raise OrderActionRefused("nothing_to_pack")
    packable = {line["id"]: line["packable"] for line in row["lines"]}
    if any(line_id not in packable for line_id in wanted):
        raise OrderActionRefused("unknown_line")
    if any(q > packable[line_id] + 1e-9 for line_id, q in wanted.items()):
        raise OrderActionRefused("too_many")
    if sync.zoho_busy():
        raise sync.ZohoBusy(salesorder_id)
    with writing(salesorder_id):
        package = await zoho_service.create_package(
            db,
            salesorder_id,
            date=date.today().isoformat(),
            line_items=[{"so_line_item_id": line_id, "quantity": q} for line_id, q in wanted.items()],
        )
        await db.execute(
            delete(OrderBoardDoc).where(OrderBoardDoc.kind == "prep", OrderBoardDoc.zoho_id == salesorder_id)
        )
        await db.commit()
        try:
            await sync.refresh_order(db, salesorder_id)
        except Exception as e:
            # The parcel exists in Books: report it, and let the next pass re-read the order.
            logger.warning(
                "Order board: refresh after a parcel failed for %s (%s)", row.get("number"), type(e).__name__
            )
            await db.rollback()
            doc = (
                await db.execute(
                    select(OrderBoardDoc).where(
                        OrderBoardDoc.kind == "salesorder", OrderBoardDoc.zoho_id == salesorder_id
                    )
                )
            ).scalar_one_or_none()
            if doc is not None:
                doc.pending = True
                await db.commit()
    return package["package_number"]
