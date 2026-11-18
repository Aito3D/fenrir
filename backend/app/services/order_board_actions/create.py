"""Create a counter (walk-in) sales order in Books and put it on the board at once."""

import asyncio
import logging
import math
import re
from datetime import date

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.services import order_board_sync as sync
from backend.app.services.order_board_actions._common import OrderActionRefused, _best_effort_refresh, _log, _num
from backend.app.services.zoho import zoho_service

logger = logging.getLogger(__name__)

_DISCOUNT = re.compile(r"(\d+(?:\.\d+)?)(%?)")
_KEEP_REFS = 200
# shortcut: in-memory dedupe, lost on restart; upgrade to a stored marker if restarts mid-sale matter
# shortcut: a create that times out after Books saved it is not remembered, so a retry makes a second order the
# operator voids; upgrade by searching Books for the ref before creating if that happens in practice
_created: dict[str, str] = {}
_ref_locks: dict[str, list] = {}  # client_ref -> [lock, callers using it]


def _discount(raw: str | None) -> tuple[float, bool] | None:
    """(value, is_percent) of a line discount, or None when there is none."""
    if raw is None or raw == "":
        return None
    match = _DISCOUNT.fullmatch(raw)
    if match is None:
        raise OrderActionRefused("bad_discount")
    value, percent = float(match[1]), bool(match[2])
    if percent and value > 100:
        raise OrderActionRefused("bad_discount")
    return value, percent


async def create_counter_order(
    db: AsyncSession, customer_id: str, lines: list[dict], client_ref: str, *, by: str | None
) -> str:
    """Create, confirm and store a counter order; returns its ``salesorder_id``. The same ``client_ref`` twice
    returns the first order instead of creating another. Prices are the Books items' own (tax inclusive); a line
    discount is "N%" (0 to 100) or an amount up to the line total."""
    if sync.zoho_busy():
        raise sync.ZohoBusy(client_ref)
    if client_ref in _created:
        return _created[client_ref]
    entry = _ref_locks.setdefault(client_ref, [asyncio.Lock(), 0])
    entry[1] += 1  # callers holding or waiting on the lock; the last one out drops it
    try:
        async with entry[0]:
            if client_ref in _created:  # a concurrent duplicate finished while this one waited
                return _created[client_ref]
            salesorder_id = await _create(db, customer_id, lines, by)
            _created[client_ref] = salesorder_id
            while len(_created) > _KEEP_REFS:
                del _created[next(iter(_created))]
            return salesorder_id
    finally:
        entry[1] -= 1
        if entry[1] == 0:
            _ref_locks.pop(client_ref, None)


async def _create(db: AsyncSession, customer_id: str, lines: list[dict], by: str | None) -> str:
    wanted: dict[str, tuple[float, str | None, tuple[float, bool] | None]] = {}
    for entry in lines:
        q = entry.get("quantity")
        if not isinstance(q, int | float) or not math.isfinite(q) or q <= 0 or round(q, 3) != q:
            raise OrderActionRefused("bad_quantity")
        item_id = entry.get("item_id")
        if not item_id or item_id in wanted:
            raise OrderActionRefused("unknown_item")
        raw = entry.get("discount")
        wanted[item_id] = (q, raw, _discount(raw))
    if not wanted:
        raise OrderActionRefused("bad_quantity")
    with sync._busy_on_rate_limit(customer_id):
        found = await zoho_service.list_items_by_ids(db, list(wanted))
    items = {item.get("item_id"): item for item in found}
    if any(i not in items or (items[i].get("product_type") or "").endswith("service") for i in wanted):
        raise OrderActionRefused("unknown_item")
    body_lines = []
    for item_id, (q, raw, discount) in wanted.items():
        rate = float(_num(items[item_id].get("rate")))
        if discount is not None and not discount[1] and discount[0] > q * rate + 1e-9:
            raise OrderActionRefused("bad_discount")
        body_lines.append({"item_id": item_id, "quantity": q, "rate": rate, **({"discount": raw} if discount else {})})
    payload = {
        "customer_id": customer_id,
        "date": date.today().isoformat(),
        "reference_number": "Comptoir",
        "is_inclusive_tax": True,
        "discount_type": "item_level",
        "is_discount_before_tax": True,
        "line_items": body_lines,
    }
    with sync._busy_on_rate_limit(customer_id):
        created = await zoho_service.create_salesorder(db, payload)
    salesorder_id = created["salesorder_id"]
    number = created.get("salesorder_number") or salesorder_id
    logger.info("Order board write: order=%s step=create", number)
    sync.note_write(salesorder_id)  # no pass may store a copy fetched before the confirm
    try:
        await zoho_service.mark_salesorder_open(db, salesorder_id)
    except Exception as e:
        logger.warning("Order board: confirming the new order %s failed (%s)", number, type(e).__name__)
        try:  # nothing half-made may stay in Books
            await zoho_service.void_salesorder(db, salesorder_id)
        except Exception as void_error:
            logger.error("Order board: voiding the draft %s failed (%s)", number, type(void_error).__name__)
        raise OrderActionRefused("create_failed") from e
    finally:
        sync.note_write(salesorder_id)
    doc = await sync.find_stored(db, salesorder_id)  # a pass may have listed it already
    if doc is None:
        db.add(OrderBoardDoc(kind="salesorder", zoho_id=salesorder_id, header=created, pending=True))
        try:
            await db.commit()
        except IntegrityError:  # a pass stored it between the check and the insert: use its copy
            await db.rollback()
            doc = await sync.find_stored(db, salesorder_id)
    if doc is not None:
        doc.pending = True
        await db.commit()
    await _best_effort_refresh(db, salesorder_id, number)  # a failure leaves it pending for the next pass
    await _log(db, salesorder_id, "order.created", by)
    return salesorder_id
