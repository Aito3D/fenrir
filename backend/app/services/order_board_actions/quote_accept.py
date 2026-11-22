"""Accept a product quote and create its sales order in Books, or undo that while nothing has happened to the order.

Books is the dedupe: a sales order POSTed with ``estimate_id`` is linked to the quote, so every entry re-reads the quote
first. A linked open order refuses (``quote_converted``); a linked draft (a half-made earlier attempt) is reused."""

import contextlib
import logging
from datetime import date

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.services import order_board_sync as sync
from backend.app.services.order_board_actions._common import (
    OrderActionRefused,
    OrderNotOnBoard,
    _log,
    _reread,
    writing,
)
from backend.app.services.order_board_actions.create import store_new_order
from backend.app.services.order_board_actions.quotes import QuoteNotStored, _fresh, _owned_quote, _settle
from backend.app.services.order_board_quotes import draft_order_id
from backend.app.services.order_board_sync._recompute import recompute
from backend.app.services.zoho import ZohoRateLimited, zoho_service

logger = logging.getLogger(__name__)

_LINE_KEYS = ("item_id", "name", "description", "rate", "quantity", "discount", "tax_id", "unit", "item_order")
_FLAGS = ("is_inclusive_tax", "discount_type", "is_discount_before_tax")


async def accept_quote(db: AsyncSession, estimate_id: str, *, by: str | None) -> str:
    """Mark the quote accepted (a draft goes through sent, an expired one keeps its dates), then create its order.
    The accepted state is stored before the order step, so a failure there leaves the quote visible as accepted."""
    with writing(estimate_id):
        detail = await _fresh(db, estimate_id)
        status = detail.get("status")
        if status != "accepted":
            sync.note_write(estimate_id)
            with sync._busy_on_rate_limit(estimate_id):
                await zoho_service.advance_estimate_status(db, estimate_id, "accepted", current=status)
            logger.info("Order board write: quote=%s step=accept", estimate_id)
            await _settle(db, estimate_id, "quote.accepted", by)
        return await _order_step(db, estimate_id, detail, by)


async def create_order_from_quote(db: AsyncSession, estimate_id: str, *, by: str | None) -> str:
    """Create the order of a quote already accepted (a retry after a failed order step, or accepted in Books)."""
    with writing(estimate_id):
        detail = await _fresh(db, estimate_id)
        if detail.get("status") != "accepted":
            raise OrderActionRefused("not_accepted")
        return await _order_step(db, estimate_id, detail, by)


async def _order_step(db: AsyncSession, estimate_id: str, detail: dict, by: str | None) -> str:
    """Create (or reuse the linked draft), confirm and store the quote's order; returns its ``salesorder_id``."""
    salesorder_id = draft_order_id(detail)
    made_here = salesorder_id is None  # only a draft this call created may be deleted
    created = {"salesorder_id": salesorder_id}
    if salesorder_id is None:
        with sync._busy_on_rate_limit(estimate_id):
            prefill = await zoho_service.salesorder_prefill_from_estimate(db, estimate_id)
        lines = [
            {k: raw[k] for k in _LINE_KEYS if raw.get(k) not in (None, "")} for raw in prefill.get("line_items") or []
        ]
        if not lines:
            raise OrderActionRefused("create_failed")
        payload = {
            "customer_id": detail.get("customer_id"),
            "estimate_id": estimate_id,
            "date": date.today().isoformat(),
            "reference_number": detail.get("estimate_number"),
            "line_items": lines,
        }
        # The flags are mirrored, not forced: the order must price exactly as the quote the customer accepted, which
        # may predate the board's tax-inclusive rule. A flag neither side states is left to Books, never sent as null.
        for k in _FLAGS:
            value = prefill.get(k)
            if value is None:
                value = detail.get(k)
            if value is not None:
                payload[k] = value
        # A timeout here may still have made the order: the retry's fresh read finds it as the linked draft.
        with sync._busy_on_rate_limit(estimate_id):
            created = await zoho_service.create_salesorder(db, payload)
        salesorder_id = str(created["salesorder_id"])
        logger.info("Order board write: quote=%s order=%s step=create", estimate_id, salesorder_id)
    sync.note_write(salesorder_id)
    try:
        await zoho_service.mark_salesorder_open(db, salesorder_id)
    except ZohoRateLimited as e:  # the draft stays linked: the retry reuses it (a void would keep the quote converted)
        logger.warning("Order board: confirming order %s of quote %s hit a 429", salesorder_id, estimate_id)
        sync.open_rate_limit_window(e)
        raise sync.ZohoBusy(estimate_id) from e
    except Exception as e:
        logger.warning("Order board: confirming the new order %s failed (%s)", salesorder_id, type(e).__name__)
        if made_here:
            try:  # deleting (not voiding) releases the quote; if it fails, the retry reuses the draft
                await zoho_service.delete_salesorder(db, salesorder_id)
            except Exception as delete_error:
                logger.error(
                    "Order board: deleting %s failed (%s), a draft order is left in Books",
                    salesorder_id,
                    type(delete_error).__name__,
                )
        raise OrderActionRefused("create_failed") from e
    finally:
        sync.note_write(salesorder_id)
    logger.info("Order board write: order=%s step=open", salesorder_id)
    await store_new_order(db, created)  # its re-read rebuilds the board
    await _log(db, salesorder_id, "order.created", by)
    await _settle(db, estimate_id, None, by)  # converted now: the quote leaves the rows
    return salesorder_id


async def undo_accept(db: AsyncSession, estimate_id: str, salesorder_id: str, *, by: str | None) -> None:
    """Delete the quote's order in Books and mark the quote sent again, while Books shows nothing done on the order."""
    with writing(estimate_id), writing(salesorder_id):
        await _owned_quote(db, estimate_id)
        if await sync.find_stored(db, salesorder_id) is None:
            raise OrderNotOnBoard(salesorder_id)
        if sync.zoho_busy():
            raise sync.ZohoBusy(salesorder_id)
        order = await _reread(db, salesorder_id)  # Books as it is now decides, not the stored copy
        if order.get("estimate_id") != estimate_id:
            raise OrderActionRefused("not_this_quote")
        row = await sync.find_board_row(db, salesorder_id)
        if row is None or _started(row):
            raise OrderActionRefused("undo_too_late")
        # Whatever happens from here (timeout, crash), the next pass re-reads the quote: a DELETE that went through
        # leaves it accepted with no order, and a stored copy still naming the order would hide it.
        if (quote := await sync.find_quote(db, estimate_id)) is None:  # a pass dropped it: refuse before sending
            raise QuoteNotStored(estimate_id)
        quote.pending = True
        await db.commit()
        deleted = False
        try:
            sync.note_write(salesorder_id)
            with sync._busy_on_rate_limit(salesorder_id):
                await zoho_service.delete_salesorder(db, salesorder_id)
            deleted = True
            logger.info("Order board write: quote=%s order=%s step=delete", estimate_id, salesorder_id)
            if (doc := await sync.find_stored(db, salesorder_id)) is not None:
                await db.delete(doc)
            await recompute(db)
            await db.commit()
            sync.note_write(estimate_id)
            with sync._busy_on_rate_limit(estimate_id):
                await zoho_service.set_estimate_status(db, estimate_id, "sent")
            logger.info("Order board write: quote=%s step=unaccept", estimate_id)
        finally:  # after any DELETE attempt: store the quote as Books has it now
            await _settle(db, estimate_id, "quote.accept_undone" if deleted else None, by)
            if not deleted:  # an unconfirmed DELETE may still land: the next pass re-reads the quote once more
                with contextlib.suppress(Exception):
                    if (quote := await sync.find_quote(db, estimate_id)) is not None:
                        quote.pending = True
                        await db.commit()


def _started(row: dict) -> bool:
    """Anything packed, shipped, invoiced or paid. ``unpaid`` means nothing paid, retainer and advance included."""
    payment = row.get("payment") or {}
    return (
        any(
            line.get("packed_waiting") or line.get("shipped") or line.get("invoiced") for line in row.get("lines") or []
        )
        or bool(payment.get("invoices"))
        or payment.get("state", "unpaid") != "unpaid"
    )
