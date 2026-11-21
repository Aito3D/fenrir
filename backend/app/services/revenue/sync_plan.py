import math
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from backend.app.services.revenue.dates import _month_shift, add_days, all_days, days_in_month


@dataclass(frozen=True)
class DayRow:
    day: str
    closed: bool
    fetched_at: str
    format: int


def plan_revenue_sync(
    *,
    days: list[DayRow],
    today: str,
    now: datetime,
    history_start: str,
    format: int,
    live_ttl_s: float,
    recent_days: int,
    recent_ttl_s: float,
) -> list[str]:
    """Org days to fetch next: missing (newest first), then stale, then older-format days; never after today."""
    by_day = {d.day: d for d in days}
    recent_floor = add_days(today, -recent_days)
    missing: list[str] = []
    stale: list[str] = []
    upgrade: list[str] = []
    for day in reversed(all_days(history_start, today)):
        row = by_day.get(day)
        if row is None:
            missing.append(day)
            continue
        age = (now - datetime.fromisoformat(row.fetched_at)).total_seconds()
        if day == today:
            if age > live_ttl_s:
                stale.append(day)
        elif not row.closed or (day >= recent_floor and age > recent_ttl_s):
            stale.append(day)
        elif row.format < format:
            upgrade.append(day)
    return [*missing, *stale, *upgrade]


MONTH_RECHECK_AFTER = timedelta(hours=24)


def month_window(month: str, history_start: str) -> tuple[str, str]:
    """The days of a month the cache holds: from the month start, or the history start inside it, to the month end."""
    end = f"{month}-{days_in_month(int(month[:4]), int(month[5:7])):02d}"
    return max(f"{month}-01", history_start), end


def plan_month_check(
    *,
    days: list[DayRow],
    checks: dict[str, str],
    today: str,
    now: datetime,
    history_start: str,
    skip: frozenset[str] = frozenset(),
) -> str | None:
    """The closed, fully cached month to check against Zoho next: never checked (newest first), then one with a day
    re-fetched since its check, then last month again once its check is a day old. `checks` maps month to checked_at."""
    by_day = {d.day: d for d in days}
    complete: dict[str, list[DayRow]] = {}
    month = history_start[:7]
    while month < today[:7]:
        window = all_days(*month_window(month, history_start))
        rows = [by_day[d] for d in window if d in by_day and by_day[d].closed]
        if len(rows) == len(window) and month not in skip:  # skip: months whose check Zoho refuses, for now
            complete[month] = rows
        month = _month_shift(month, 1)
    newest = sorted(complete, reverse=True)
    for m in newest:
        if m not in checks:
            return m
    for m in newest:
        at = datetime.fromisoformat(checks[m])
        if any(datetime.fromisoformat(r.fetched_at) > at for r in complete[m]):
            return m
    previous = _month_shift(today[:7], -1)
    if previous in complete and now - datetime.fromisoformat(checks[previous]) > MONTH_RECHECK_AFTER:
        return previous
    return None


def count_legacy_days(days: list[DayRow], format: int) -> int:
    return sum(1 for d in days if d.format < format)


def _strict_amount(v: Any) -> tuple[float, bool]:
    """(value, well-formed): a number or numeric string; anything else or non-finite reads as 0."""
    if v is None or isinstance(v, bool):
        return 0.0, False
    try:
        n = float(v)
    except (TypeError, ValueError):
        return 0.0, False
    return (n, True) if math.isfinite(n) else (0.0, False)


def merge_day_rows(groups: list[dict]) -> tuple[list[dict], int]:
    """Customer-grouped report rows as line inputs, one per (item, customer) with repeats summed, and the
    count of malformed rows coerced or skipped (the caller logs one warning per call)."""
    out: dict[tuple[str, str], dict] = {}
    malformed = 0
    for g in groups:
        customer_id = g.get("group_name") or ""
        for r in g.get("sales") or []:
            item_id = r.get("item_id")
            if not item_id:
                malformed += 1
                continue
            quantity, quantity_ok = _strict_amount(r.get("quantity_sold"))
            amount, amount_ok = _strict_amount(r.get("amount"))
            name = r.get("item_name")
            if not (quantity_ok and amount_ok) or name is None:
                malformed += 1
            cur = out.get((item_id, customer_id))
            if cur:
                cur["quantity"] += quantity
                cur["amount"] += amount
            else:
                sku = (r.get("item") or {}).get("sku") or ""
                out[(item_id, customer_id)] = {
                    "itemId": item_id,
                    "customerId": customer_id,
                    "name": name or "",
                    "sku": sku,
                    "quantity": quantity,
                    "amount": amount,
                }
    return list(out.values()), malformed
