"""Create a counter (walk-in) sales order in Books and put it on the board at once."""

import asyncio
import logging
import math
import re
from collections.abc import Awaitable, Callable
from datetime import date

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.services import order_board_sync as sync
from backend.app.services.order_board_actions._common import OrderActionRefused, _best_effort_refresh, _log, _num
from backend.app.services.order_board_sync import _common as sync_common
from backend.app.services.zoho import ZohoRateLimited, zoho_service

logger = logging.getLogger(__name__)

_DISCOUNT = re.compile(r"(\d+(?:\.\d+)?)(%?)")
_KEEP_REFS = 200
# shortcut: in-memory dedupe, lost on restart; upgrade to a stored marker if restarts mid-sale matter
# shortcut: a create that times out after Books saved it is not remembered, so a retry makes a second order the
# operator voids; upgrade by searching Books for the ref before creating if that happens in practice
_created: dict[str, tuple[str, str]] = {}  # client_ref -> (fingerprint, salesorder_id)
_ref_locks: dict[str, list] = {}  # client_ref -> [lock, callers using it]


def _fingerprint(customer_id: str, lines: list[dict]) -> str:
    """What a retry must repeat: the client and the lines, in any order."""
    return repr(
        (customer_id, sorted(repr((e.get("item_id"), e.get("quantity"), e.get("discount") or None)) for e in lines))
    )


def _remembered(client_ref: str, fingerprint: str) -> str | None:
    """The order a stored ``client_ref`` made; a retry that changed the client or lines is refused."""
    if client_ref not in _created:
        return None
    stored_fingerprint, salesorder_id = _created[client_ref]
    if stored_fingerprint != fingerprint:
        raise OrderActionRefused("ref_reused")
    return salesorder_id


def checked_quantity(q):
    """A line quantity: positive, finite, at most three decimals."""
    if not isinstance(q, int | float) or not math.isfinite(q) or q <= 0 or round(q, 3) != q:
        raise OrderActionRefused("bad_quantity")
    return q


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
    fingerprint = _fingerprint(customer_id, lines)
    return await once_per_ref(
        client_ref, fingerprint, lambda: _create(db, customer_id, lines, client_ref, by, fingerprint)
    )


async def once_per_ref(client_ref: str, fingerprint: str, make: Callable[[], Awaitable[str]]) -> str:
    """Run ``make`` once per ``client_ref`` and return the id it made: a retry with the same fingerprint gets the first
    id back without a Books call, one with another fingerprint is refused ``ref_reused``."""
    if (known := _remembered(client_ref, fingerprint)) is not None:  # before the busy check: no Books call
        return known
    if sync.zoho_busy():
        raise sync.ZohoBusy(client_ref)
    entry = _ref_locks.setdefault(client_ref, [asyncio.Lock(), 0])
    entry[1] += 1  # callers holding or waiting on the lock; the last one out drops it
    try:
        async with entry[0]:
            if (known := _remembered(client_ref, fingerprint)) is not None:  # a concurrent duplicate finished
                return known
            made = await make()
            remember(client_ref, fingerprint, made)
            return made
    finally:
        entry[1] -= 1
        if entry[1] == 0:
            _ref_locks.pop(client_ref, None)


def remember(client_ref: str, fingerprint: str, made_id: str) -> None:
    """Record what ``client_ref`` made; ``make`` calls this itself as soon as Books holds it, before local writes."""
    _created[client_ref] = (fingerprint, made_id)
    while len(_created) > _KEEP_REFS:
        del _created[next(iter(_created))]


async def priced_lines(db: AsyncSession, key: str, lines: list[dict]) -> list[dict]:
    """The Books ``line_items`` for ``lines`` ({item_id, quantity, discount?}): goods only, each item once, at the
    item's own rate."""
    wanted: dict[str, tuple[float, str | None, tuple[float, bool] | None]] = {}
    for entry in lines:
        q = checked_quantity(entry.get("quantity"))
        item_id = entry.get("item_id")
        if not item_id or item_id in wanted:
            raise OrderActionRefused("unknown_item")
        raw = entry.get("discount")
        wanted[item_id] = (q, raw, _discount(raw))
    if not wanted:
        raise OrderActionRefused("bad_quantity")
    with sync._busy_on_rate_limit(key):
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
    return body_lines


async def _create(
    db: AsyncSession, customer_id: str, lines: list[dict], client_ref: str, by: str | None, fingerprint: str
) -> str:
    body_lines = await priced_lines(db, customer_id, lines)
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
    if created.get("is_inclusive_tax") is not True:  # shelf prices are TTC; a Books org can override the flag
        logger.warning(
            "Order board: new order %s is not tax inclusive (is_inclusive_tax=%r)",
            number,
            created.get("is_inclusive_tax"),
        )
    sync.note_write(salesorder_id)  # no pass may store a copy fetched before the confirm
    try:
        await zoho_service.mark_salesorder_open(db, salesorder_id)
    except Exception as e:
        logger.warning("Order board: confirming the new order %s failed (%s)", number, type(e).__name__)
        if isinstance(e, ZohoRateLimited):
            sync.open_rate_limit_window(e)
            sync_common._pending_voids[salesorder_id] = number  # a void now would meet the same 429; a pass sends it
            raise sync.ZohoBusy(customer_id) from e
        try:  # nothing half-made may stay in Books
            await zoho_service.void_salesorder(db, salesorder_id)
        except Exception as void_error:
            logger.error(
                "Order board: voiding %s failed (%s), a draft order is left in Books",
                number,
                type(void_error).__name__,
            )
        raise OrderActionRefused("create_failed") from e
    finally:
        sync.note_write(salesorder_id)
    # Remembered before any local write: a retry after a database failure must not confirm a second order.
    remember(client_ref, fingerprint, salesorder_id)
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
