"""Keeps the revenue cache filled from Zoho, one bounded batch at a time, on its own paced lane.

Lazy: the loop starts on a revenue read and exits after `idle_after_s` without one. One salesbyitem report per
org day; each batch then names a few customers the cache does not know yet. Every Zoho call goes through `_paced`,
which keeps call starts 0.7 s apart, waits while the shared per-minute meter is at this lane's ceiling (below the Order Board's), and
stops the batch when Books' daily budget runs low.
"""

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from backend.app.core import database
from backend.app.core.tasks import spawn_background_task
from backend.app.services.revenue import cash, store
from backend.app.services.revenue.config import REVENUE_HISTORY_START, REVENUE_LINE_FORMAT, SYNC
from backend.app.services.revenue.dates import days_between, org_today
from backend.app.services.revenue.series import RevenueLine
from backend.app.services.revenue.sync_plan import (
    count_legacy_days,
    merge_day_rows,
    month_window,
    plan_month_check,
    plan_revenue_sync,
)
from backend.app.services.zoho import (
    ZohoNotConfiguredError,
    ZohoNotFound,
    ZohoRateLimited,
    ZohoUnreachable,
    ZohoUpstreamError,
    zoho_service,
)

logger = logging.getLogger(__name__)

# shortcut: a day of the shop's sales is a few hundred lines (1–2 pages); a runaway has_more stops here, not at 200
DAY_PAGE_CAP = 20
ITEM_PAGE_CAP = 100
MONTH_PAGE_CAP = 20  # ungrouped: one row per item sold in the month
CEILING_POLL_S = 1.0
DAY_RETRY_CAP_S = 6 * 3600
FAILED_DAYS_SHOWN = 5
CASH_PAGE_CAP = 10  # 2 000 payments a run; a capped run resumes from the cursor
UNPAID_STATUSES = ("unpaid", "overdue", "partially_paid")  # Books' statuses overlap: their union is safe


@dataclass(frozen=True)
class DayFailure:
    attempts: int
    next_retry: float  # monotonic
    next_retry_at: str  # wall clock, for the banner
    error: str


_sleep = asyncio.sleep
_inflight: asyncio.Task | None = None
_last_batch_at: str | None = None
_last_error: str | None = None
_last_read_at = float("-inf")
_last_call_at = float("-inf")
_loop_task: asyncio.Task | None = None
_lane = asyncio.Lock()
_day_failures: dict[str, DayFailure] = {}
_cash_at = float("-inf")
_cash_error: str | None = None


class _BudgetLow(Exception):
    """Books' daily budget is below the floor: the batch stops, nothing is marked fetched."""


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


def _mark_day_failed(day: str, exc: BaseException) -> None:
    attempts = (_day_failures[day].attempts if day in _day_failures else 0) + 1
    wait = min(SYNC.error_backoff_s * 2 ** (attempts - 1), DAY_RETRY_CAP_S)
    _day_failures[day] = DayFailure(
        attempts=attempts,
        next_retry=time.monotonic() + wait,
        next_retry_at=(_utcnow() + timedelta(seconds=wait)).isoformat(),
        error=_public_error(exc),
    )


def _in_back_off(day: str) -> bool:
    f = _day_failures.get(day)
    return f is not None and f.next_retry > time.monotonic()


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
    raise ZohoUpstreamError(f"Zoho sales report for {day} has more than {DAY_PAGE_CAP} pages")


async def _check_month(db, month: str) -> None:
    """Zoho's salesbyitem total for the month's cached window against the cache's sum of every line."""
    from_date, to_date = month_window(month, REVENUE_HISTORY_START)
    zoho_amount = 0.0
    for page in range(1, MONTH_PAGE_CAP + 1):
        rows, more = await _paced(zoho_service.sales_by_item_range, db, from_date, to_date, page)
        # Read like the daily rows, so a row the cache would skip is skipped here too.
        zoho_amount += sum(m["amount"] for m in merge_day_rows([{"sales": rows}])[0])
        if not more:
            break
    else:
        raise ZohoUpstreamError(f"Zoho sales report for {month} has more than {MONTH_PAGE_CAP} pages")
    await store.save_month_check(db, month, zoho_amount, await store.month_line_sum(db, month), _utcnow())


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


def _payment_row(p: dict) -> dict:
    return {
        "payment_id": str(p["payment_id"]),
        "customer_id": str(p.get("customer_id") or ""),
        "date": p.get("date") or "",
        "amount": _num(p.get("amount")) or 0.0,
        "unapplied": _num(p.get("unused_amount")) or 0.0,
        "last_modified_time": p.get("last_modified_time") or "",
    }


def _invoice_row(i: dict) -> dict:
    return {
        "invoice_id": str(i["invoice_id"]),
        "number": i.get("invoice_number") or "",
        "customer_id": str(i.get("customer_id") or ""),
        "customer_name": i.get("customer_name") or "",
        "date": i.get("date") or "",
        "due_date": i.get("due_date") or "",
        "total": _num(i.get("total")) or 0.0,
        "balance": _num(i.get("balance")) or 0.0,
    }


async def _refresh_cash(db) -> None:
    """Payments since the cursor, the unpaid invoices' balances, then a bounded number of detail reads."""
    today = org_today()
    async with store.snapshot() as conn:
        since = await store.get_setting(conn, store.PAYMENTS_SINCE_KEY) or cash.cursor_start(today)
    for page in range(1, CASH_PAGE_CAP + 1):
        rows, more = await _paced(zoho_service.list_customer_payments_page, db, since, page)
        rows = [r for r in rows if r.get("payment_id")]
        cursor = rows[-1].get("last_modified_time") if rows else None
        await store.save_payments(db, [_payment_row(r) for r in rows], cursor, _utcnow())
        if not more:
            break
    unpaid: dict[str, dict] = {}
    truncated = False
    for status in UNPAID_STATUSES:
        for page in range(1, CASH_PAGE_CAP + 1):
            rows, more = await _paced(zoho_service.list_unpaid_invoices_page, db, status, page)
            unpaid.update((str(r["invoice_id"]), _invoice_row(r)) for r in rows if r.get("invoice_id"))
            if not more:
                break
        else:
            truncated = True
    await store.save_unpaid_invoices(db, list(unpaid.values()), not truncated, _utcnow())

    window_start = f"{cash.last_months(today)[0]}-01"
    async with store.snapshot() as conn:
        items = await store.read_scope_items(conn)
        decisions = await store.read_decisions(conn)
        classes = cash.classify_customers(await store.customer_item_pairs(conn), items, decisions)
        payments = await store.read_payments(conn, window_start)
        invoices = await store.read_invoice_shares(conn)
    payment_ids, invoice_ids = cash.detail_queue(payments, invoices, classes, window_start)
    payment_ids = payment_ids[: SYNC.cash_detail_budget]
    for payment_id in payment_ids:
        try:
            p = await _paced(zoho_service.get_customer_payment, db, payment_id)
        except ZohoNotFound:
            await store.delete_payment(db, payment_id)
            continue
        applications = [
            {"invoiceId": str(a.get("invoice_id") or ""), "amount": _num(a.get("amount_applied")) or 0.0}
            for a in p.get("invoices") or []
        ]
        await store.save_payment_applications(
            db, payment_id, applications, _num(p.get("unused_amount")) or 0.0, _utcnow()
        )
    for invoice_id in invoice_ids[: SYNC.cash_detail_budget - len(payment_ids)]:
        try:
            inv = await _paced(zoho_service.get_invoice_raw, db, invoice_id)
            row = {
                **_invoice_row({**inv, "invoice_id": invoice_id}),
                "share": cash.invoice_share(inv.get("line_items") or [], items, decisions),
            }
        except ZohoNotFound:
            row = {**_invoice_row({"invoice_id": invoice_id}), "share": 0.0}  # gone from Books: stop asking
        await store.save_invoice_detail(db, row, _utcnow())
    await store.save_cash_synced(db, _utcnow())


async def _refresh_cash_on_its_own(db) -> None:
    """A cash failure is kept for /cash and retried after the TTL; it never fails the day batch nor reaches the banner."""
    global _cash_at, _cash_error
    _cash_at = time.monotonic()
    try:
        await _refresh_cash(db)
    except (ZohoUpstreamError, ZohoNotConfiguredError) as exc:
        message = _public_error(exc)
        if message != _cash_error:
            logger.warning("Revenue cash refresh failed: %s", message)
        _cash_error = message
        return
    _cash_error = None


def cash_error() -> str | None:
    return _cash_error


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
                _day_failures.clear()
            now = _utcnow()
            async with store.snapshot() as conn:
                index = await store.read_day_index(conn)
                items = await store.read_scope_items(conn)
                checks = {c["month"]: c["checkedAt"] for c in await store.read_month_checks(conn)}
            planned = plan_revenue_sync(
                days=index,
                today=org_today(now),
                now=now,
                history_start=REVENUE_HISTORY_START,
                format=REVENUE_LINE_FORMAT,
                live_ttl_s=SYNC.live_ttl_s,
                recent_days=SYNC.recent_days,
                recent_ttl_s=SYNC.recent_ttl_s,
            )
            plan = [d for d in planned if not _in_back_off(d)]
            days: list[str] = []
            unknown: list[str] = []
            looked_up = 0
            checked = None
            try:
                for day in plan[: SYNC.day_batch_size]:
                    # Read before the request: a day that ends mid-fetch stays open, the report may predate its close.
                    today_at_fetch = org_today()
                    try:
                        merged, malformed = merge_day_rows(await _fetch_day(db, day))
                    except (ZohoRateLimited, ZohoUnreachable):
                        raise
                    except ZohoUpstreamError as exc:
                        # This day's report itself fails: it waits out its own back-off so the queue moves on.
                        _mark_day_failed(day, exc)
                        raise
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
                            unit_cost=items[m["itemId"]].unit_cost if m["itemId"] in items else None,
                            tax_percentage=items[m["itemId"]].tax_percentage if m["itemId"] in items else None,
                        )
                        for m in merged
                    ]
                    await store.write_day(db, day, day_lines, day < today_at_fetch, _utcnow(), REVENUE_LINE_FORMAT)
                    _day_failures.pop(day, None)
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
                # Only on a complete cache (no day left, none waiting out a back-off): a gap must mean Zoho differs.
                if len(days) == len(planned):
                    async with store.snapshot() as conn:
                        index = await store.read_day_index(conn)
                    month = plan_month_check(
                        days=index,
                        checks=checks,
                        today=org_today(),
                        now=_utcnow(),
                        history_start=REVENUE_HISTORY_START,
                    )
                    if month:
                        await _check_month(db, month)
                        checked = month
                    if time.monotonic() - _cash_at >= SYNC.cash_ttl_s:
                        await _refresh_cash_on_its_own(db)
            except _BudgetLow:
                pass
        _last_batch_at = _utcnow().isoformat()
        _last_error = None
        return {
            "fetched": len(days),
            "pending": len(plan) - len(days) + len(unknown) - looked_up,
            "days": days,
            "customers": looked_up,
            "checked": checked,
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
    cached = {d.day for d in index}
    waiting = sum(
        1 for d in _day_failures if d not in cached and REVENUE_HISTORY_START <= d <= today and _in_back_off(d)
    )
    failed = sorted(_day_failures.items(), reverse=True)[:FAILED_DAYS_SHOWN]
    return {
        "running": _inflight is not None,
        "fetchedDays": len(index),
        "totalDays": total,
        "missingDays": missing,
        "backfilling": missing - waiting > 0,
        "legacyDays": count_legacy_days(index, REVENUE_LINE_FORMAT),
        "lastBatchAt": _last_batch_at,
        "lastError": _last_error,
        "failedDays": [
            {"day": d, "attempts": f.attempts, "nextRetryAt": f.next_retry_at, "error": f.error} for d, f in failed
        ],
        "failedCount": len(_day_failures),
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
    global \
        _inflight, \
        _last_batch_at, \
        _last_error, \
        _last_read_at, \
        _last_call_at, \
        _loop_task, \
        _lane, \
        _cash_at, \
        _cash_error
    if _loop_task is not None and not _loop_task.done():
        _loop_task.cancel()
    _inflight = _last_batch_at = _last_error = _loop_task = _cash_error = None
    _last_read_at = _last_call_at = _cash_at = float("-inf")
    _lane = asyncio.Lock()
    _day_failures.clear()
