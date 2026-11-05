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
from dataclasses import dataclass
from datetime import date, datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import async_session
from backend.app.core.tasks import spawn_background_task
from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.services.order_board import age_days, compute_board
from backend.app.services.zoho import ZohoNotConfiguredError, ZohoRateLimited, ZohoUpstreamError, zoho_service

logger = logging.getLogger(__name__)

MAX_DETAILS_PER_PASS = 20
CALL_CEILING = 30
ITEM_BATCH = 50
PENDING_PAUSE_SECONDS = 60
DEFAULT_CORE_BRANDS = ["Bambu Lab", "eSUN", "SUNLU", "Polymaker", "Inslogic", "Magigoo"]

# List-row fields whose change means the stored detail is out of date.
_SO_FIELDS = ("last_modified_time", "status", "quantity", "quantity_packed", "quantity_shipped", "quantity_invoiced")
_PO_FIELDS = ("last_modified_time", "status", "billed_status", "received_status", "quantity_yet_to_receive")

_pass_lock = asyncio.Lock()
# time.monotonic() before which Books asked us not to call again (429).
_rate_limited_until = 0.0


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
    await recompute(db)
    await db.commit()


async def _state(db: AsyncSession) -> OrderBoardDoc:
    state = (
        await db.execute(select(OrderBoardDoc).where(OrderBoardDoc.kind == "state", OrderBoardDoc.zoho_id == "board"))
    ).scalar_one_or_none()
    if state is None:
        state = OrderBoardDoc(kind="state", zoho_id="board", header={}, detail={})
        db.add(state)
    return state


async def _pending_count(db: AsyncSession) -> int:
    return (
        await db.execute(select(func.count()).select_from(OrderBoardDoc).where(OrderBoardDoc.pending.is_(True)))
    ).scalar_one()


async def read_board(db: AsyncSession) -> dict:
    """The stored board and the sync status: one local read, no Zoho call."""
    state = (await _state(db)).detail or {}
    return {
        "rows": state.get("rows") or [],
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


async def recompute(db: AsyncSession) -> None:
    """Rebuild the board from the local copy.

    Does nothing until the first complete load: a board built from half the
    documents, or against no stock, would read as fact and be wrong.
    """
    state = await _state(db)
    current = state.detail or {}
    if not current.get("stock_loaded_at") or (not current.get("computed_at") and await _pending_count(db)):
        return
    settings = await load_settings(db)
    docs = (await db.execute(select(OrderBoardDoc).where(OrderBoardDoc.kind != "state"))).scalars().all()
    rows = compute_board(
        [d.detail for d in docs if d.kind == "salesorder" and d.detail],
        [d.detail for d in docs if d.kind == "purchaseorder" and d.detail],
        {d.zoho_id: d.header for d in docs if d.kind == "item"},
        date.today(),
        max_age_days=settings.max_age_days,
        core_brands=settings.core_brands,
    )
    try:
        url_base = await zoho_service.books_salesorder_url_base(db)
    except ZohoNotConfiguredError:
        url_base = None
    for row in rows:
        row["zoho_url"] = f"{url_base}{row['id']}" if url_base else None
    state.detail = {**current, "rows": rows, "computed_at": _now()}


def _is_candidate(kind: str, header: dict, settings: OrderBoardSettings) -> bool:
    """Whether a document can matter to the board, judged from its list row alone."""
    if kind == "purchaseorder":
        return header.get("status") in ("open", "partially_billed")
    if header.get("status") in ("draft", "void"):
        return False
    if float(header.get("quantity_shipped") or 0) >= float(header.get("quantity") or 0):
        return False
    return not settings.max_age_days or age_days(header.get("date") or "", date.today()) <= settings.max_age_days


async def _sync(db: AsyncSession) -> None:
    settings = await load_settings(db)
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
                doc.detail, doc.pending = None, False
            elif doc.detail is None or any(doc.header.get(f) != header.get(f) for f in fields):
                doc.pending = True
            doc.header = header
    for key in set(stored) - listed:  # deleted in Zoho
        await db.delete(stored.pop(key))
    await db.commit()

    # Oldest sales orders first: they are served first, so they matter most.
    pending = sorted(
        (d for d in stored.values() if d.pending),
        key=lambda d: (d.kind != "salesorder", d.header.get("date") or "", d.zoho_id),
    )
    for doc in pending[:MAX_DETAILS_PER_PASS]:
        if zoho_service.calls_in_last_minute() >= CALL_CEILING:
            logger.info("Order board: Zoho call ceiling reached, the remaining details wait for the next pass")
            break
        get = zoho_service.get_salesorder if doc.kind == "salesorder" else zoho_service.get_purchaseorder
        doc.detail = await get(db, doc.zoho_id)
        doc.pending = False
        await db.commit()  # a later failure must not lose what was fetched

    # Stock has no change feed in Books, so it is re-read on every pass.
    item_ids = sorted(
        {
            line["item_id"]
            for d in stored.values()
            if d.kind == "salesorder" and d.detail
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
    await recompute(db)
    state.detail = {**(state.detail or {}), "last_success_at": _now(), "last_error": None, "last_error_at": None}
    await db.commit()


async def run_pass(db: AsyncSession) -> bool:
    """One bounded sync pass. False when another pass is already running.

    A Zoho failure ends the pass, is recorded for the page to show, and leaves
    the stored board as it was.
    """
    global _rate_limited_until
    if _pass_lock.locked():
        return False
    async with _pass_lock:
        try:
            await _sync(db)
        except (ZohoUpstreamError, ZohoNotConfiguredError) as e:
            await db.rollback()
            if isinstance(e, ZohoRateLimited):
                _rate_limited_until = time.monotonic() + (e.retry_after or PENDING_PAUSE_SECONDS)
            logger.warning("Order board sync pass failed: %s", e)
            state = await _state(db)
            state.detail = {**(state.detail or {}), "last_error": str(e)[:300], "last_error_at": _now()}
            await db.commit()
    return True


async def run_loop() -> None:
    """Run passes forever. Cancellation is the only way out.

    Every iteration takes its own session and swallows its own errors: one bad
    pass must not end syncing until the next restart.
    """
    while True:
        delay = float(PENDING_PAUSE_SECONDS)
        try:
            async with async_session() as db:
                settings = await load_settings(db)
                delay = settings.sync_minutes * 60.0
                if settings.sync_enabled and await zoho_service.is_configured(db):
                    await run_pass(db)
                    if await _pending_count(db):
                        delay = float(PENDING_PAUSE_SECONDS)
        except Exception:
            logger.exception("Order board sync loop iteration failed")
        await asyncio.sleep(max(delay, _rate_limited_until - time.monotonic()))


def start_order_board_sync() -> None:
    spawn_background_task(run_loop(), name="order-board-sync")
