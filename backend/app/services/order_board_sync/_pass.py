"""One bounded sync pass: list Books, reconcile the stored rows, fetch pending details, reload stock."""

import logging
import time
from datetime import datetime, timezone

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.services.aito_poll_watermark import format_books_time
from backend.app.services.inbox import broadcast_pending
from backend.app.services.order_board_payment import quote_number_missing
from backend.app.services.order_board_sync import _common
from backend.app.services.order_board_sync._common import (
    CALL_CEILING,
    ITEM_BATCH,
    MAX_DETAILS_PER_PASS,
    OrderBoardSettings,
    ZohoBusy,
    _find_state,
    _is_candidate,
    _is_finished,
    _now,
    _pass_lock,
    _state,
    _written_at,
    announce_board_change,
    load_settings,
    open_rate_limit_window,
    zoho_busy,
)
from backend.app.services.order_board_sync._events import _observe, _record_fetch_events
from backend.app.services.order_board_sync._finished import (
    _archived,
    _drop_archived_detail,
    _ensure_finished_detail,
    _is_stale,
    _store_quote_number,
)
from backend.app.services.order_board_sync._recompute import recompute
from backend.app.services.order_board_sync._retainers import _retainers
from backend.app.services.zoho import ZohoNotConfiguredError, ZohoRateLimited, ZohoUpstreamError, zoho_service

logger = logging.getLogger(__name__)

# List-row fields whose change means the stored detail is out of date.
_SO_FIELDS = (
    "last_modified_time",
    "status",
    "quantity",
    "quantity_packed",
    "quantity_shipped",
    "quantity_invoiced",
    "paid_status",
    "invoiced_status",
)
_PO_FIELDS = ("last_modified_time", "status", "billed_status", "received_status", "quantity_yet_to_receive")


async def _reconcile_listings(db: AsyncSession, settings: OrderBoardSettings) -> dict[tuple[str, str], OrderBoardDoc]:
    """List Zoho and reconcile the stored rows with it. Returns the stored rows by (kind, id)."""
    listings = (
        ("salesorder", "salesorder_id", _SO_FIELDS, await zoho_service.list_salesorders(db)),
        ("purchaseorder", "purchaseorder_id", _PO_FIELDS, await zoho_service.list_purchaseorders(db)),
    )
    stored = {
        (d.kind, d.zoho_id): d
        for d in (
            await db.execute(select(OrderBoardDoc).where(OrderBoardDoc.kind.in_(("salesorder", "purchaseorder"))))
        )
        .scalars()
        .all()
    }
    # A sales order first listed after a successful pass is news: marked here, it rings when its detail lands, however
    # many passes that takes. No previous success (first load, reset): no marker, no bell.
    state = await _find_state(db)
    mark_new = bool(((state.detail if state else None) or {}).get("last_success_at"))
    marked = set(
        (await db.execute(select(OrderBoardDoc.zoho_id).where(OrderBoardDoc.kind == "alert_new"))).scalars().all()
    )
    listed: set[tuple[str, str]] = set()
    for kind, id_field, fields, headers in listings:
        for header in headers:
            key = (kind, str(header.get(id_field) or ""))
            listed.add(key)
            candidate = _is_candidate(kind, header, settings)
            doc = stored.get(key)
            if doc is None:
                doc = stored[key] = OrderBoardDoc(kind=kind, zoho_id=key[1], header=header, pending=candidate)
                db.add(doc)
                if kind == "salesorder" and mark_new and key[1] not in marked:
                    db.add(OrderBoardDoc(kind="alert_new", zoho_id=key[1], header={}))
                continue
            if not candidate:
                doc.header = header
                if not (kind == "salesorder" and _is_finished(header)) or _drop_archived_detail(doc):
                    doc.detail = None
                doc.pending = False
            elif doc.detail is None or any(doc.header.get(f) != header.get(f) for f in fields):
                doc.pending = True
            doc.header = header
    gone = set(stored) - listed  # deleted in Zoho
    for key in gone:
        await db.delete(stored.pop(key))
    gone_orders = [zoho_id for kind, zoho_id in gone if kind == "salesorder"]
    if gone_orders:  # never fetched, never news
        await db.execute(
            delete(OrderBoardDoc).where(OrderBoardDoc.kind == "alert_new", OrderBoardDoc.zoho_id.in_(gone_orders))
        )
    await db.commit()
    return stored


async def _mark_payment_changes(
    db: AsyncSession, stored: dict[tuple[str, str], OrderBoardDoc], settings: OrderBoardSettings, started: datetime
) -> None:
    # A payment on the customer does not touch the sales order's list row, but
    # it changes the credit stored in the detail: find those customers.
    state = await _state(db)
    since = (state.detail or {}).get("payments_since")
    paid = await zoho_service.list_customer_payments_modified_since(db, since) if since else None
    everyone = paid is None or paid.truncated
    customers = set() if paid is None or everyone else {p.get("customer_id") for p in paid}
    for doc in stored.values():
        if doc.kind != "salesorder" or not (everyone or doc.header.get("customer_id") in customers):
            continue
        if _is_candidate("salesorder", doc.header, settings):
            doc.pending = True
        elif doc.detail is not None and _is_finished(doc.header):
            doc.detail = {**doc.detail, "_stale": True}
    state.detail = {**(state.detail or {}), "payments_since": format_books_time(started)}
    await db.commit()


async def _fetch_pending_details(db: AsyncSession, stored: dict[tuple[str, str], OrderBoardDoc]) -> None:
    # Oldest sales orders first: they are served first, so they matter most.
    pending = sorted(
        (d for d in stored.values() if d.pending),
        key=lambda d: (d.kind != "salesorder", d.header.get("date") or "", d.zoho_id),
    )
    fetched_count = 0
    payments: dict[str, list[dict]] = {}  # each customer's payments, read once this pass
    for doc in pending[:MAX_DETAILS_PER_PASS]:
        if zoho_service.calls_in_last_minute() >= CALL_CEILING:
            logger.info("Order board: Zoho call ceiling reached, the remaining details wait for the next pass")
            break
        fetched_count += 1
        get = zoho_service.get_salesorder if doc.kind == "salesorder" else zoho_service.get_purchaseorder
        began = time.monotonic()
        fetched = await get(db, doc.zoho_id)
        if _written_at.get(doc.zoho_id, -1.0) >= began and doc.kind == "salesorder":
            await db.refresh(doc)  # a write here is newer than this copy: keep it, and the pending mark
            continue
        previous = doc.detail
        retainers = await _retainers(db, fetched, previous, payments) if doc.kind == "salesorder" else {}
        doc.detail = {**fetched, "_fetched_at": _now(), **retainers}
        doc.pending = False
        if doc.kind == "salesorder":
            await _observe(db, doc.zoho_id, _record_fetch_events, doc.zoho_id, previous, fetched)
        await db.commit()  # a later failure must not lose what was fetched
        await broadcast_pending(db)
        if _written_at.get(doc.zoho_id, -1.0) >= began and doc.kind == "salesorder":
            doc.pending = True  # a write began while this copy was being stored: it may predate the write
            await db.commit()

    # Finished orders are served from the copy too. The slots this pass has left fill in the ones with no
    # copy or an out-of-date one, newest first (the ones operators open), so opening one never calls Books.
    finished = sorted(
        (
            d
            for d in stored.values()
            if d.kind == "salesorder"
            and _is_finished(d.header)
            and not _archived(d.header)
            and (d.detail is None or _is_stale(d))
        ),
        key=lambda d: (d.header.get("date") or "", d.zoho_id),
        reverse=True,
    )
    for doc in finished[: max(0, MAX_DETAILS_PER_PASS - fetched_count)]:
        if zoho_busy():
            break
        try:
            await _ensure_finished_detail(db, doc)
        except ZohoBusy:
            break

    # The quote's number is not on the order: read it once, kept with the order from then on.
    for doc in stored.values():
        if doc.kind != "salesorder" or not doc.detail or not quote_number_missing(doc.detail):
            continue
        if zoho_service.calls_in_last_minute() >= CALL_CEILING:
            break
        await _store_quote_number(db, doc)


async def _reload_stock(
    db: AsyncSession, stored: dict[tuple[str, str], OrderBoardDoc], settings: OrderBoardSettings
) -> None:
    # Stock has no change feed in Books, so it is re-read on every pass.
    item_ids = sorted(
        {
            line["item_id"]
            for d in stored.values()
            if d.kind == "salesorder" and d.detail and _is_candidate(d.kind, d.header, settings)
            for line in d.detail.get("line_items") or []
            if line.get("item_id")
        }
    )
    items: list[dict] = []
    for start in range(0, len(item_ids), ITEM_BATCH):
        items += await zoho_service.list_items_by_ids(db, item_ids[start : start + ITEM_BATCH])
    # Update in place: rewriting every row each pass churns the database for stock that rarely moves.
    old = {
        d.zoho_id: d for d in (await db.execute(select(OrderBoardDoc).where(OrderBoardDoc.kind == "item"))).scalars()
    }
    for item in items:
        item_id = str(item.get("item_id") or "")
        doc = old.pop(item_id, None)
        if doc is None:
            db.add(OrderBoardDoc(kind="item", zoho_id=item_id, header=item))
        elif doc.header != item:
            doc.header = item
    for doc in old.values():
        await db.delete(doc)

    state = await _state(db)
    state.detail = {**(state.detail or {}), "stock_loaded_at": _now()}
    await db.flush()
    changed = await recompute(db)
    state.detail = {**(state.detail or {}), "last_success_at": _now(), "last_error": None, "last_error_at": None}
    await db.commit()
    await broadcast_pending(db)
    if changed:
        await announce_board_change(finished=True)


async def _sync(db: AsyncSession) -> None:
    started = datetime.now(timezone.utc)
    settings = await load_settings(db)
    stored = await _reconcile_listings(db, settings)
    await _mark_payment_changes(db, stored, settings, started)
    await _fetch_pending_details(db, stored)
    await _reload_stock(db, stored, settings)


async def run_pass(db: AsyncSession) -> bool:
    """One bounded sync pass. False when nothing ran: another pass is already
    running, or Books asked us to back off and that window is still open.

    A Zoho failure ends the pass, is recorded for the page to show, and leaves
    the stored board as it was.
    """
    # During a 429 back-off even a Refresh click sends nothing: the Kanban
    # shares this budget and freezes while Books is throttling.
    if _pass_lock.locked() or time.monotonic() < _common._rate_limited_until:
        return False
    async with _pass_lock:
        try:
            await _sync(db)
        except (ZohoUpstreamError, ZohoNotConfiguredError) as e:
            await db.rollback()
            if isinstance(e, ZohoRateLimited):
                open_rate_limit_window(e)
            logger.warning("Order board sync pass failed: %s", e)
            state = await _state(db)
            state.detail = {**(state.detail or {}), "last_error": str(e)[:300], "last_error_at": _now()}
            await db.commit()
    return True
