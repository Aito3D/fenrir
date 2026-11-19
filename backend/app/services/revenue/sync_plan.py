import math
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from backend.app.services.revenue.dates import add_days, all_days


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


def count_legacy_days(days: list[DayRow], format: int) -> int:
    return sum(1 for d in days if d.format < format)


def _finite_number(v: Any) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v)


def _amount(v: Any) -> tuple[float, bool]:
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
            quantity_ok = _finite_number(r.get("quantity_sold"))
            quantity = r["quantity_sold"] if quantity_ok else 0
            amount, amount_ok = _amount(r.get("amount"))
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
