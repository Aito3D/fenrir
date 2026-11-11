"""The Order Board's local copy of Zoho Books and the pass that keeps it fresh.

Read-only towards Books: GETs only. One bounded pass lists every sales order
and purchase order (three calls today), fetches the detail of at most
``MAX_DETAILS_PER_PASS`` documents whose list row changed, re-reads stock for
the items on open order lines, then recomputes and stores the board. Opening
the page therefore costs one local read (``read_board``), never a Zoho call.

Two rules shape everything here:

* An empty or half-built board must never look like a verified answer:
  nothing is computed until a pass has ended with no document pending and
  stock loaded. After that, a failed pass leaves the stored board untouched.
* The Aito Kanban shares Zoho's per-minute call budget and stops its own
  background work at 50 calls in the last minute. This pass stops fetching
  details at ``CALL_CEILING``, well below that.
"""

import asyncio
import json
import logging
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import async_session
from backend.app.core.tasks import spawn_background_task
from backend.app.core.websocket import ws_manager
from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.services.aito_poll_watermark import format_books_time
from backend.app.services.order_board import age_days, compute_board, order_row
from backend.app.services.order_board_payment import order_payment, quote_number_missing
from backend.app.services.zoho import ZohoNotConfiguredError, ZohoRateLimited, ZohoUpstreamError, zoho_service

logger = logging.getLogger(__name__)

MAX_DETAILS_PER_PASS = 20
CALL_CEILING = 30
ITEM_BATCH = 50
PENDING_PAUSE_SECONDS = 60
# Books also caps calls per day. Below this many left, the loop stops running
# passes on its own (Refresh still works): the same floor at which the Kanban's
# change pass gives up its cadence (aito_quote_sync.DAILY_BUDGET_FLOOR).
DAILY_BUDGET_FLOOR = 5000
DEFAULT_CORE_BRANDS = ["Bambu Lab", "eSUN", "SUNLU", "Polymaker", "Inslogic", "Magigoo"]

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

_pass_lock = asyncio.Lock()
# shortcut: one lock per finished order ever opened, never pruned; a few hundred entries, revisit past 10k orders
_detail_locks: dict[str, asyncio.Lock] = {}
# time.monotonic() before which Books asked us not to call again (429).
_rate_limited_until = 0.0
# Set to cut the loop's sleep short (settings saved). Created by the loop
# itself, so it belongs to the loop's event loop.
_wake: asyncio.Event | None = None
# time.monotonic() of the last write to each sales order here: a pass that began fetching
# an order before that instant holds a copy older than the write and must not store it.
_written_at: dict[str, float] = {}
# Orders written to Books here whose re-read has not succeeded yet: the stored copy may not show the write.
_unconfirmed: set[str] = set()


class OrderNotFinished(Exception):
    """The order is unknown, or not a finished one."""


class OrderNotStored(Exception):
    """No local copy of that sales order."""


class ZohoBusy(Exception):
    """Books is throttling us, or the shared call budget is spent: try again shortly."""


@dataclass
class OrderBoardSettings:
    sync_enabled: bool
    sync_minutes: int
    max_age_days: int  # 0 keeps every order
    core_brands: list[str]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def load_settings(db: AsyncSession) -> OrderBoardSettings:
    from backend.app.api.routes.settings import get_setting

    async def number(key: str, default: int) -> int:
        try:
            return int(await get_setting(db, key) or default)
        except ValueError:
            return default

    try:
        brands = json.loads(await get_setting(db, "order_board_core_brands") or "null")
    except ValueError:
        brands = None
    return OrderBoardSettings(
        sync_enabled=(await get_setting(db, "order_board_sync_enabled") or "true").strip().lower()
        not in ("false", "0", "no"),
        sync_minutes=await number("order_board_sync_minutes", 15),
        max_age_days=await number("order_board_max_age_days", 365),
        core_brands=brands if isinstance(brands, list) else list(DEFAULT_CORE_BRANDS),
    )


async def save_settings(db: AsyncSession, settings: OrderBoardSettings) -> None:
    """Store the settings and rebuild the board from the local copy (no Zoho call)."""
    from backend.app.api.routes.settings import set_setting

    await set_setting(db, "order_board_sync_enabled", "true" if settings.sync_enabled else "false")
    await set_setting(db, "order_board_sync_minutes", str(settings.sync_minutes))
    await set_setting(db, "order_board_max_age_days", str(settings.max_age_days))
    await set_setting(db, "order_board_core_brands", json.dumps(settings.core_brands))
    changed = await recompute(db)
    await db.commit()
    if changed:
        await announce_board_change()
    # Sync switched on, or the age limit raised: run a pass now rather than
    # leave the page loading until the interval ends.
    if _wake is not None:
        _wake.set()


async def _find_state(db: AsyncSession) -> OrderBoardDoc | None:
    return (
        await db.execute(
            select(OrderBoardDoc)
            .where(OrderBoardDoc.kind == "state", OrderBoardDoc.zoho_id == "board")
            .execution_options(
                populate_existing=True
            )  # never a copy a running pass loaded before another session's commit
        )
    ).scalar_one_or_none()


def _stored_query(salesorder_id: str):
    return (
        select(OrderBoardDoc)
        .where(OrderBoardDoc.kind == "salesorder", OrderBoardDoc.zoho_id == salesorder_id)
        .execution_options(populate_existing=True)
    )


async def _state(db: AsyncSession) -> OrderBoardDoc:
    """The state row, created on first use. Only a sync pass may call this:
    passes run one at a time, so the row cannot be inserted twice. Reads and
    settings saves go through ``_find_state`` and never create it."""
    state = await _find_state(db)
    if state is None:
        state = OrderBoardDoc(kind="state", zoho_id="board", header={}, detail={})
        db.add(state)
    return state


async def _pending_count(db: AsyncSession) -> int:
    return (
        await db.execute(select(func.count()).select_from(OrderBoardDoc).where(OrderBoardDoc.pending.is_(True)))
    ).scalar_one()


def zoho_busy() -> bool:
    """Books is throttling us, or the shared call budget is spent."""
    return time.monotonic() < _rate_limited_until or zoho_service.calls_in_last_minute() >= CALL_CEILING


async def _rows_with_prep(db: AsyncSession, state: dict) -> list[dict]:
    """The stored rows, each with its print stamp and its pickup-SMS stamp (``{"at", "by"}`` or None)."""
    stamps: dict[str, dict[str, dict]] = {"prep": {}, "contact": {}}
    query = select(OrderBoardDoc).where(OrderBoardDoc.kind.in_(stamps))
    for d in (await db.execute(query)).scalars():
        stamps[d.kind][d.zoho_id] = d.header
    return [
        {**r, "prep": stamps["prep"].get(r["id"]), "contacted": stamps["contact"].get(r["id"])}
        for r in state.get("rows") or []
    ]


async def find_board_row(db: AsyncSession, salesorder_id: str) -> dict | None:
    row = await _find_state(db)
    return next(
        (r for r in await _rows_with_prep(db, (row.detail if row else None) or {}) if r["id"] == salesorder_id), None
    )


def note_write(salesorder_id: str) -> None:
    """A Books write on this order is starting or has just ended: drop any pass fetch that began before now,
    and treat the stored copy as unconfirmed until a refresh succeeds."""
    _written_at[salesorder_id] = time.monotonic()
    _unconfirmed.add(salesorder_id)


def needs_refresh(salesorder_id: str) -> bool:
    return salesorder_id in _unconfirmed


def open_rate_limit_window(e: ZohoRateLimited) -> None:
    global _rate_limited_until
    _rate_limited_until = time.monotonic() + (e.retry_after or PENDING_PAUSE_SECONDS)


@contextmanager
def _busy_on_rate_limit(key: str) -> Iterator[None]:
    """A Books 429 inside the block opens the back-off window and surfaces as ZohoBusy(key)."""
    try:
        yield
    except ZohoRateLimited as e:
        open_rate_limit_window(e)
        raise ZohoBusy(key) from e


async def refresh_order(db: AsyncSession, salesorder_id: str) -> None:
    """Re-read one order from Books after a write here, store it and rebuild the board."""
    doc = (await db.execute(_stored_query(salesorder_id))).scalar_one_or_none()
    if doc is None:
        raise OrderNotStored(salesorder_id)
    fetched = await zoho_service.get_salesorder(db, salesorder_id)
    _written_at[salesorder_id] = time.monotonic()
    doc.detail = {**fetched, "_fetched_at": _now()}
    doc.pending = True  # the next pass re-reads it once the list row has caught up
    changed = await recompute(db)
    await db.commit()
    _unconfirmed.discard(salesorder_id)
    if changed:
        await announce_board_change()


async def announce_board_change() -> None:
    """Tell the open Order Board pages to refetch: a bare ping, the board itself stays behind its permission.
    Best effort: polling is the fallback."""
    try:
        await ws_manager.broadcast({"type": "order_board_updated"})
    except Exception:
        logger.warning("Order board: the live update broadcast failed", exc_info=True)


async def read_board(db: AsyncSession) -> dict:
    """The stored board and the sync status: one local read, no Zoho call."""
    row = await _find_state(db)
    state = (row.detail if row else None) or {}
    return {
        "rows": await _rows_with_prep(db, state),
        "computed_at": state.get("computed_at"),
        "stock_loaded_at": state.get("stock_loaded_at"),
        "sync": {
            "enabled": (await load_settings(db)).sync_enabled,
            "configured": await zoho_service.is_configured(db),
            "running": _pass_lock.locked(),
            "pending": await _pending_count(db),
            "last_error": state.get("last_error"),
            "last_error_at": state.get("last_error_at"),
            "last_success_at": state.get("last_success_at"),
        },
    }


async def _add_links(db: AsyncSession, rows: list[dict]) -> None:
    """Books deep links on the rows; all None when Zoho is not configured. One lookup per call, not per row."""
    try:
        order_base = await zoho_service.books_salesorder_url_base(db)
        invoice_base = await zoho_service.books_invoice_url(db, "")
        quote_base = await zoho_service.books_app_url(db, "")
    except ZohoNotConfiguredError:
        order_base = invoice_base = quote_base = None
    store = await _shopify_store(db) if any(r["facts"]["shopify_order"] for r in rows) else ""
    for row in rows:
        row["zoho_url"] = f"{order_base}{row['id']}" if order_base else None
        facts = row["facts"]
        if store and facts["shopify_order"] and not facts["shopify_url"]:
            facts["shopify_url"] = f"https://admin.shopify.com/store/{store}/orders?query={facts['shopify_order']}"
        for invoice in (row.get("payment") or {}).get("invoices", []):
            invoice["url"] = f"{invoice_base}{invoice['id']}" if invoice_base and invoice["id"] else None
        facts = row["facts"]
        facts["quote_url"] = f"{quote_base}{facts['estimate_id']}" if quote_base and facts["estimate_id"] else None


async def _shopify_store(db: AsyncSession) -> str:
    """The shop's Shopify store handle, as Books' Shopify sync writes it on the orders it creates."""
    docs = (await db.execute(select(OrderBoardDoc.detail).where(OrderBoardDoc.kind == "salesorder"))).scalars()
    return next((d["account_identifier"] for d in docs if d and d.get("account_identifier")), "")


_PAID_FLAGS = {"paid": "paid", "partially_paid": "partial", "unpaid": "unpaid"}
# Header fields that, once they differ from the stored detail's, say the detail is out of date.
_FRESHNESS_FIELDS = ("last_modified_time", "paid_status", "invoiced_status")


def _is_stale(doc: OrderBoardDoc) -> bool:
    detail = doc.detail or {}
    return bool(detail.get("_stale")) or any(doc.header.get(f) != detail.get(f) for f in _FRESHNESS_FIELDS)


def _snapshot(doc: OrderBoardDoc) -> tuple | None:
    detail = doc.detail
    return None if detail is None else (detail.get("_fetched_at"), bool(detail.get("_stale")))


async def _finished_docs(db: AsyncSession) -> list[OrderBoardDoc]:
    """Sales orders that count as finished, judged from stored rows only. A candidate with a stored
    detail that the stored board does not show has shipped since the board was computed."""
    state = await _find_state(db)
    current = (state.detail if state else None) or {}
    # shortcut: before the first computed board nothing is "off the board" yet, so only list-row shipping counts
    computed_at: str = current.get("computed_at") or ""
    on_board = {r["id"] for r in current.get("rows") or []} if computed_at else None
    settings = await load_settings(db)
    docs = (await db.execute(select(OrderBoardDoc).where(OrderBoardDoc.kind == "salesorder"))).scalars().all()
    return [
        d
        for d in docs
        if _is_finished(d.header)
        or (
            on_board is not None
            and d.detail is not None
            and d.zoho_id not in on_board
            # fetched after the board was computed (a pass that failed before recompute): not shipped, just new
            and (d.detail.get("_fetched_at") or "~") <= computed_at
            and _is_candidate(d.kind, d.header, settings)
        )
    ]


async def read_finished(db: AsyncSession) -> dict:
    """Finished orders, newest first, from stored list rows: no Zoho call."""
    try:
        base = await zoho_service.books_salesorder_url_base(db)
    except ZohoNotConfiguredError:
        base = None
    today = date.today()
    docs = sorted(
        await _finished_docs(db),
        key=lambda d: (d.header.get("date") or "", d.header.get("salesorder_number") or ""),
        reverse=True,
    )
    rows = [
        {
            "id": d.zoho_id,
            "number": d.header.get("salesorder_number"),
            "customer": d.header.get("customer_name"),
            "date": d.header.get("date"),
            "total": d.header.get("total"),
            "currency": d.header.get("currency_code"),
            "reference": d.header.get("reference_number") or "",
            "paid_flag": _PAID_FLAGS.get(d.header.get("paid_status") or ""),
            "payment": order_payment(d.detail, today) if d.detail and not _is_stale(d) else None,
            "zoho_url": f"{base}{d.zoho_id}" if base else None,
        }
        for d in docs
    ]
    return {"rows": rows}


async def read_finished_order(db: AsyncSession, salesorder_id: str) -> dict:
    """One finished order in full. Fetched from Zoho only when no current copy is stored; then kept."""
    doc = next((d for d in await _finished_docs(db) if d.zoho_id == salesorder_id), None)
    if doc is None:
        raise OrderNotFinished(salesorder_id)
    await _ensure_finished_detail(db, doc)
    rows = [order_row(doc.detail or {}, {}, date.today())]
    await _add_links(db, rows)
    return rows[0]


async def _ensure_finished_detail(db: AsyncSession, doc: OrderBoardDoc) -> None:
    """Fetch the finished order's detail when none is stored or the copy is out of date; otherwise nothing.

    One fetch per order at a time: operators opening the same order together, or an open racing the pass,
    share the first fetch instead of each calling Zoho. The re-read after the wait sees what it stored.
    """
    if doc.detail is not None and not _is_stale(doc):
        return
    async with _detail_locks.setdefault(doc.zoho_id, asyncio.Lock()):
        await db.refresh(doc)
        if doc.detail is None or _is_stale(doc):
            await _fetch_finished_detail(db, doc)


async def _store_quote_number(db: AsyncSession, doc: OrderBoardDoc) -> None:
    quote = await zoho_service.get_estimate(db, str((doc.detail or {}).get("estimate_id") or ""))
    await db.refresh(doc)
    doc.detail = {**(doc.detail or {}), "estimate_number": quote.get("estimate_number") or ""}
    await db.commit()


async def _fetch_finished_detail(db: AsyncSession, doc: OrderBoardDoc) -> None:
    salesorder_id = doc.zoho_id
    if time.monotonic() < _rate_limited_until or zoho_service.calls_in_last_minute() >= CALL_CEILING:
        raise ZohoBusy(salesorder_id)
    before = _snapshot(doc)
    try:
        fetched = await zoho_service.get_salesorder(db, salesorder_id)
    except ZohoRateLimited as e:
        open_rate_limit_window(e)
        raise ZohoBusy(salesorder_id) from e
    # No pass lock here (a pass can run long): if a pass wrote this row meanwhile, its mark or newer detail
    # must not be lost, so the fetched copy goes in marked stale and the next open fetches again.
    await db.refresh(doc)
    detail = {**fetched, "_fetched_at": _now(), **({"_stale": True} if _snapshot(doc) != before else {})}
    doc.detail = detail
    doc.pending = False
    await db.commit()
    if quote_number_missing(detail) and zoho_service.calls_in_last_minute() < CALL_CEILING:
        await _store_quote_number(db, doc)


async def recompute(db: AsyncSession) -> bool:
    """Rebuild the board from the local copy; True when its rows changed (the caller announces it after its commit).

    Does nothing until the first complete load: a board built from half the
    documents, or against no stock, would read as fact and be wrong.
    """
    state = await _find_state(db)
    current = (state.detail if state else None) or {}
    if state is None or not current.get("stock_loaded_at"):
        return False
    if not current.get("computed_at") and await _pending_count(db):
        return False
    settings = await load_settings(db)
    docs = (
        (
            await db.execute(
                select(OrderBoardDoc).where(OrderBoardDoc.kind != "state").execution_options(populate_existing=True)
            )
        )
        .scalars()
        .all()
    )
    rows = compute_board(
        [d.detail for d in docs if d.kind == "salesorder" and d.detail and _is_candidate(d.kind, d.header, settings)],
        [d.detail for d in docs if d.kind == "purchaseorder" and d.detail],
        {d.zoho_id: d.header for d in docs if d.kind == "item"},
        date.today(),
        max_age_days=settings.max_age_days,
        core_brands=settings.core_brands,
    )
    await _add_links(db, rows)
    state.detail = {**current, "rows": rows, "computed_at": _now()}
    return rows != current.get("rows")


def _is_finished(header: dict) -> bool:
    """A sales order that has fully shipped. Its detail is kept for the finished-orders list."""
    quantity = float(header.get("quantity") or 0)
    return header.get("status") not in ("draft", "void") and 0 < quantity <= float(header.get("quantity_shipped") or 0)


def _is_candidate(kind: str, header: dict, settings: OrderBoardSettings) -> bool:
    """Whether a document can matter to the board, judged from its list row alone."""
    if kind == "purchaseorder":
        return header.get("status") in ("open", "partially_billed")
    if header.get("status") in ("draft", "void"):
        return False
    if float(header.get("quantity_shipped") or 0) >= float(header.get("quantity") or 0):
        return False
    return not settings.max_age_days or age_days(header.get("date") or "", date.today()) <= settings.max_age_days


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
                continue
            if not candidate:
                if not (kind == "salesorder" and _is_finished(header)):
                    doc.detail = None
                doc.pending = False
            elif doc.detail is None or any(doc.header.get(f) != header.get(f) for f in fields):
                doc.pending = True
            doc.header = header
    for key in set(stored) - listed:  # deleted in Zoho
        await db.delete(stored.pop(key))
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
        doc.detail = {**fetched, "_fetched_at": _now()}
        doc.pending = False
        await db.commit()  # a later failure must not lose what was fetched
        if _written_at.get(doc.zoho_id, -1.0) >= began and doc.kind == "salesorder":
            doc.pending = True  # a write began while this copy was being stored: it may predate the write
            await db.commit()

    # Finished orders are served from the copy too. The slots this pass has left fill in the ones with no
    # copy or an out-of-date one, newest first (the ones operators open), so opening one never calls Books.
    finished = sorted(
        (
            d
            for d in stored.values()
            if d.kind == "salesorder" and _is_finished(d.header) and (d.detail is None or _is_stale(d))
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
    for old in (await db.execute(select(OrderBoardDoc).where(OrderBoardDoc.kind == "item"))).scalars().all():
        await db.delete(old)
    await db.flush()
    db.add_all(OrderBoardDoc(kind="item", zoho_id=str(i.get("item_id") or ""), header=i) for i in items)

    state = await _state(db)
    state.detail = {**(state.detail or {}), "stock_loaded_at": _now()}
    await db.flush()
    changed = await recompute(db)
    state.detail = {**(state.detail or {}), "last_success_at": _now(), "last_error": None, "last_error_at": None}
    await db.commit()
    if changed:
        await announce_board_change()


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
    if _pass_lock.locked() or time.monotonic() < _rate_limited_until:
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


async def _iteration(db: AsyncSession) -> float:
    """One loop turn: a pass when allowed. Returns the seconds until the next."""
    settings = await load_settings(db)
    if not (settings.sync_enabled and await zoho_service.is_configured(db)):
        # Look again soon: Zoho may be connected from another settings card.
        return float(PENDING_PAUSE_SECONDS)
    remaining = zoho_service.daily_remaining
    if remaining is not None and remaining < DAILY_BUDGET_FLOOR:
        return settings.sync_minutes * 60.0
    await run_pass(db)
    return float(PENDING_PAUSE_SECONDS) if await _pending_count(db) else settings.sync_minutes * 60.0


async def run_loop() -> None:
    """Run passes forever. Cancellation is the only way out.

    Every iteration takes its own session and swallows its own errors: one bad
    pass must not end syncing until the next restart. The sleep between turns
    ends early when settings are saved.
    """
    global _wake
    _wake = asyncio.Event()
    while True:
        delay = float(PENDING_PAUSE_SECONDS)
        try:
            async with async_session() as db:
                delay = await _iteration(db)
        except Exception:
            logger.exception("Order board sync loop iteration failed")
        try:
            await asyncio.wait_for(_wake.wait(), timeout=max(delay, _rate_limited_until - time.monotonic()))
        except TimeoutError:
            pass
        _wake.clear()


def start_order_board_sync() -> None:
    spawn_background_task(run_loop(), name="order-board-sync")
