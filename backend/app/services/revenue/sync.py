"""Keeps the revenue cache filled from Zoho, one bounded batch at a time, on its own paced lane.

Lazy: the loop starts on a revenue read and exits after `idle_after_s` without one. One salesbyitem report per
org day; each batch then names a few customers the cache does not know yet. Every Zoho call goes through `_paced`,
which keeps call starts 0.7 s apart, waits while the shared per-minute meter is at this lane's ceiling (below the Order Board's), and
stops the batch when Books' daily budget runs low.
"""

import asyncio
import logging
import time
from datetime import datetime, timezone

from backend.app.core import database
from backend.app.core.tasks import spawn_background_task
from backend.app.services.revenue import store
from backend.app.services.revenue.config import REVENUE_HISTORY_START, REVENUE_LINE_FORMAT, SYNC
from backend.app.services.revenue.dates import days_between, org_today
from backend.app.services.revenue.series import RevenueLine
from backend.app.services.revenue.sync_plan import count_legacy_days, merge_day_rows, plan_revenue_sync
from backend.app.services.zoho import (
    ZohoNotConfiguredError,
    ZohoNotFound,
    ZohoRateLimited,
    ZohoRequestRejected,
    ZohoUpstreamError,
    zoho_service,
)

logger = logging.getLogger(__name__)

# shortcut: a day of the shop's sales is a few hundred lines (1–2 pages); a runaway has_more stops here, not at 200
DAY_PAGE_CAP = 20
ITEM_PAGE_CAP = 100
CEILING_POLL_S = 1.0

_sleep = asyncio.sleep
_inflight: asyncio.Task | None = None
_last_batch_at: str | None = None
_last_error: str | None = None
_last_read_at = float("-inf")
_last_call_at = float("-inf")
_loop_task: asyncio.Task | None = None
_lane = asyncio.Lock()


class _BudgetLow(Exception):
    """Books' daily budget is below the floor: the batch stops, nothing is marked fetched."""


class _DayTooLong(ZohoUpstreamError):
    """One day's report runs past the page cap."""


# Failures tied to one day's report: that day is skipped for this pass, the rest of the batch goes on.
_DAY_ERRORS = (ZohoRequestRejected, ZohoNotFound, _DayTooLong, AttributeError, KeyError, TypeError, ValueError)


class RevenueRebuildRefused(Exception):
    """A full rebuild cannot refill the cache right now, so nothing is cleared."""


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _budget_low() -> bool:
    remaining = zoho_service.daily_remaining
    return remaining is not None and remaining < SYNC.daily_budget_floor


def _public_error(exc: BaseException) -> str:
    if isinstance(exc, ZohoUpstreamError | ZohoNotConfiguredError):
        return str(exc)
    return exc.__class__.__name__


def _record_error(exc: BaseException) -> None:
    global _last_error
    message = _public_error(exc)
    if message != _last_error:
        logger.warning("Revenue sync failed: %s", message)
    _last_error = message


async def _paced(fn, *args):
    global _last_call_at
    gap = _last_call_at + SYNC.min_call_gap_s - time.monotonic()
    if gap > 0:
        await _sleep(gap)
    while zoho_service.calls_in_last_minute() >= SYNC.call_ceiling:
        await _sleep(CEILING_POLL_S)
    if _budget_low():
        raise _BudgetLow
    _last_call_at = time.monotonic()
    return await fn(*args)


async def _fetch_day(db, day: str) -> list[dict]:
    groups: list[dict] = []
    for page in range(1, DAY_PAGE_CAP + 1):
        rows, more = await _paced(zoho_service.sales_by_item_by_customer, db, day, page)
        groups.extend(rows)
        if not more:
            return groups
    raise _DayTooLong(f"Zoho sales report for {day} has more than {DAY_PAGE_CAP} pages")


def _num(v) -> float | None:
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _item_row(it: dict) -> dict:
    return {
        "item_id": it["item_id"],
        "name": it.get("name") or "",
        "sku": it.get("sku") or "",
        "brand": it.get("brand"),
        "nature": it.get("cf_nature_du_produit"),
        "item_type": it.get("item_type"),
        "tax_percentage": _num(it.get("tax_percentage")),
        "purchase_rate": _num(it.get("purchase_rate")),
        "dealer_price": _num(it.get("cf_prix_dealer_usd_unformatted")),
        "status": it.get("status"),
    }


async def refresh_revenue_items(db, now: datetime) -> bool:
    """Full item sweep, then swaps the item table. An empty listing keeps the current rows (returns False)."""
    items: list[dict] = []
    for page in range(1, ITEM_PAGE_CAP + 1):
        rows, more = await _paced(zoho_service.list_items_page_all, db, page)
        items.extend(rows)
        if not more:
            break
    else:
        raise ZohoUpstreamError(f"Zoho item listing has more than {ITEM_PAGE_CAP} pages")
    # A listing that shifts between pages can repeat an item; the last copy wins.
    rows = list({it["item_id"]: _item_row(it) for it in items if it.get("item_id")}.values())
    if not rows:
        return False
    await store.replace_items(db, rows, now)
    return True


async def _execute_batch(full: bool) -> dict:
    global _last_batch_at, _last_error
    try:
        async with database.async_session() as db:
            if full:
                await store.clear_revenue_cache(db)
            now = _utcnow()
            async with store.snapshot() as conn:
                index = await store.read_day_index(conn)
            plan = plan_revenue_sync(
                days=index,
                today=org_today(now),
                now=now,
                history_start=REVENUE_HISTORY_START,
                format=REVENUE_LINE_FORMAT,
                live_ttl_s=SYNC.live_ttl_s,
                recent_days=SYNC.recent_days,
                recent_ttl_s=SYNC.recent_ttl_s,
            )
            days: list[str] = []
            unknown: list[str] = []
            looked_up = 0
            day_error: Exception | None = None
            try:
                for day in plan[: SYNC.day_batch_size]:
                    # Read before the request: a day that ends mid-fetch stays open, the report may predate its close.
                    today_at_fetch = org_today()
                    try:
                        merged, malformed = merge_day_rows(await _fetch_day(db, day))
                    except _DAY_ERRORS as exc:
                        _record_error(exc)
                        day_error = exc
                        continue
                    if malformed:
                        logger.warning("Revenue sync: %d malformed report rows on %s", malformed, day)
                    day_lines = [
                        RevenueLine(
                            day=day,
                            item_id=m["itemId"],
                            customer_id=m["customerId"],
                            name=m["name"],
                            sku=m["sku"],
                            quantity=m["quantity"],
                            amount=m["amount"],
                        )
                        for m in merged
                    ]
                    await store.write_day(db, day, day_lines, day < today_at_fetch, _utcnow(), REVENUE_LINE_FORMAT)
                    days.append(day)
                unknown = await store.unknown_customer_ids(db)
                for customer_id in unknown[: SYNC.customer_lookups]:
                    try:
                        c = await _paced(zoho_service.get_contact, db, customer_id)
                        facts = {
                            "name": c.get("name") or "",
                            "company_name": c.get("company_name") or "",
                            "sub_type": c.get("customer_sub_type") or None,
                        }
                    except ZohoNotFound:
                        facts = None
                    await store.save_customer(db, customer_id, facts, _utcnow())
                    looked_up += 1
            except _BudgetLow:
                pass
        _last_batch_at = _utcnow().isoformat()
        _last_error = _public_error(day_error) if day_error else None
        return {
            "fetched": len(days),
            "pending": len(plan) - len(days) + len(unknown) - looked_up,
            "days": days,
            "customers": looked_up,
        }
    except Exception as exc:
        _record_error(exc)
        raise


async def _check_rebuild_possible() -> None:
    async with database.async_session() as db:
        if not await zoho_service.is_configured(db):
            raise RevenueRebuildRefused("Zoho credentials are not configured")
    if _budget_low():
        raise RevenueRebuildRefused("Zoho's daily API budget is too low to rebuild; try again after it resets")


async def _after(previous: asyncio.Task | None, full: bool) -> dict:
    if previous is not None:
        await asyncio.wait([previous])  # its failure must not poison the chained full rebuild
    async with _lane:
        if full:
            await _check_rebuild_possible()
        return await _execute_batch(full)


async def run_revenue_sync_batch(*, full: bool = False) -> dict:
    """Concurrent callers share one in-flight batch; `full` chains behind it, then clears and rebuilds."""
    global _inflight
    if _inflight is not None and not full:
        return await asyncio.shield(_inflight)
    task = asyncio.get_running_loop().create_task(_after(_inflight, full))
    _inflight = task

    def _clear(t: asyncio.Task) -> None:
        global _inflight
        if _inflight is t:
            _inflight = None

    task.add_done_callback(_clear)
    return await asyncio.shield(task)


async def get_revenue_sync_status(conn, now: datetime) -> dict:
    today = org_today(now)
    total = days_between(REVENUE_HISTORY_START, today)
    index = [d for d in await store.read_day_index(conn) if REVENUE_HISTORY_START <= d.day <= today]
    missing = max(0, total - len(index))
    return {
        "running": _inflight is not None,
        "fetchedDays": len(index),
        "totalDays": total,
        "missingDays": missing,
        "backfilling": missing > 0,
        "legacyDays": count_legacy_days(index, REVENUE_LINE_FORMAT),
        "lastBatchAt": _last_batch_at,
        "lastError": _last_error,
    }


async def _refresh_items_if_stale() -> None:
    now = _utcnow()
    async with store.snapshot() as conn:
        synced_at = await store.items_synced_at(conn)
    if synced_at and (now - datetime.fromisoformat(synced_at)).total_seconds() < SYNC.items_ttl_s:
        return
    async with _lane, database.async_session() as db:
        try:
            await refresh_revenue_items(db, now)
        except _BudgetLow:
            pass


async def _loop() -> None:
    while time.monotonic() - _last_read_at <= SYNC.idle_after_s:
        if _budget_low():
            await _sleep(SYNC.idle_interval_s)
            continue
        try:
            item_error = None
            try:
                await _refresh_items_if_stale()
            except ZohoRateLimited:
                raise
            except Exception as exc:  # a persistent /items failure must not stop today's figures
                _record_error(exc)
                item_error = exc
            result = await run_revenue_sync_batch()
            if item_error is not None:
                global _last_error
                _last_error = _public_error(item_error)  # the batch cleared it; a batch failure raises instead
            wait = SYNC.batch_pause_s if result["pending"] else SYNC.idle_interval_s
        except Exception as exc:
            _record_error(exc)
            wait = max(SYNC.error_backoff_s, getattr(exc, "retry_after", None) or 0)
        await _sleep(wait)


def ensure_revenue_sync_loop() -> None:
    """Records a read and starts the loop if none is alive; called by every authorised revenue read."""
    global _last_read_at, _loop_task
    _last_read_at = time.monotonic()
    if _loop_task is None or _loop_task.done():
        _loop_task = spawn_background_task(_loop(), name="revenue-sync")


def reset_revenue_sync_state_for_tests() -> None:
    global _inflight, _last_batch_at, _last_error, _last_read_at, _last_call_at, _loop_task, _lane
    if _loop_task is not None and not _loop_task.done():
        _loop_task.cancel()
    _inflight = _last_batch_at = _last_error = _loop_task = None
    _last_read_at = _last_call_at = float("-inf")
    _lane = asyncio.Lock()
