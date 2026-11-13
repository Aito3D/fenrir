"""Shared by every part of the Order Board sync: the constants, the exceptions, the settings, the module state
(back-off window, locks, write marks, loop wake) and the helpers the parts have in common."""

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

from backend.app.core.websocket import ws_manager
from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.services.order_board import age_days
from backend.app.services.zoho import ZohoRateLimited, zoho_service

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
    scan_enabled: bool = False  # a barcode scan fills the parcel check


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
        scan_enabled=(await get_setting(db, "order_board_scan_enabled") or "").strip().lower() == "true",
    )


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


async def announce_board_change(*, finished: bool = False) -> None:
    """Tell the open Order Board pages to refetch: a bare ping, the board itself stays behind its permission.
    ``finished`` also refetches the finished list (a pass, or an order that left the board). Best effort:
    polling is the fallback."""
    try:
        await ws_manager.broadcast({"type": "order_board_updated", "finished": finished})
    except Exception:
        logger.warning("Order board: the live update broadcast failed", exc_info=True)


def _naive_utc(text: str) -> datetime | None:
    """A Books time or date, or our own ISO stamp, as the naive UTC the event table stores."""
    try:
        parsed = datetime.fromisoformat(text)
    except (TypeError, ValueError):
        return None
    return parsed.astimezone(timezone.utc).replace(tzinfo=None) if parsed.tzinfo else parsed


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
