"""The revenue dashboard's secondary read models: customers, movers, year over year, calendar days and targets."""

import re
from collections.abc import Iterable

from backend.app.services.revenue.customers import CUSTOMER_SEGMENTS, RevenueCustomerFacts, customer_display_name
from backend.app.services.revenue.dates import add_days, all_days, days_between
from backend.app.services.revenue.scope import RevenueDecision, ScopeItem, brand_key, is_service_item
from backend.app.services.revenue.series import (
    NO_BRAND,
    Granularity,
    LineFilters,
    RevenueLine,
    bucket_key_for,
    bucket_label,
    bucket_range,
    js_round,
    matching_lines,
    ttc_of,
)

TOP_CUSTOMERS = 50
MOVERS_SHOWN = 5

_SEGMENT_KEYS = ("ht", "ttc", "goods", "services", "goodsTtc", "servicesTtc")


def acquisition_of(rows: Iterable[dict], first_days: dict[str, str], from_: str) -> dict:
    """New = first purchase (`first_days_in_scope`) falls in the range; basket = HT per customer-day."""
    a = {"newCount": 0, "newHt": 0, "returningCount": 0, "returningHt": 0, "customerDays": 0, "avgBasketHt": None}
    ht = 0
    for r in rows:
        first = first_days.get(r["customerId"])
        side = "new" if first is not None and first >= from_ else "returning"
        a[f"{side}Count"] += 1
        a[f"{side}Ht"] += r["ht"]
        a["customerDays"] += r["activeDays"]
        ht += r["ht"]
    a["avgBasketHt"] = js_round(ht / a["customerDays"]) if a["customerDays"] > 0 else None
    return a


def customer_breakdown(
    lines: Iterable,
    items: dict[str, ScopeItem],
    decisions: Iterable[RevenueDecision],
    customers: dict[str, RevenueCustomerFacts],
    filters: LineFilters,
    first_days: dict[str, str] | None,
    from_: str,
) -> dict:
    """`acquisition` is None only without first-purchase days; the history-start caveat is the client's."""
    seg = {s: {**dict.fromkeys(_SEGMENT_KEYS, 0.0), "ids": set()} for s in CUSTOMER_SEGMENTS}
    rows: dict[str, dict] = {}
    unsplit = 0.0
    for m in matching_lines(lines, items, decisions, customers, filters):
        line = m.line
        ttc = ttc_of(line, m.item)[0]
        kind = "services" if is_service_item(m.item) else "goods"
        s = seg[m.segment]
        s["ht"] += line.amount
        s["ttc"] += ttc
        s[kind] += line.amount
        s[f"{kind}Ttc"] += ttc
        if not line.customer_id:
            unsplit += line.amount
            continue
        s["ids"].add(line.customer_id)
        row = rows.get(line.customer_id)
        if row is None:
            row = rows[line.customer_id] = {
                "customerId": line.customer_id,
                "name": customer_display_name(line.customer_id, customers.get(line.customer_id)),
                "segment": m.segment,
                "ht": 0.0,
                "ttc": 0.0,
                "goods": 0.0,
                "services": 0.0,
                "quantity": 0,
                "days": set(),
                "lastDay": line.day,
            }
        row["ht"] += line.amount
        row["ttc"] += ttc
        row[kind] += line.amount
        row["quantity"] += line.quantity
        row["days"].add(line.day)
        row["lastDay"] = max(row["lastDay"], line.day)
    everyone = [
        {
            **{k: v for k, v in r.items() if k != "days"},
            "ht": js_round(r["ht"]),
            "ttc": js_round(r["ttc"]),
            "goods": js_round(r["goods"]),
            "services": js_round(r["services"]),
            "activeDays": len(r["days"]),
        }
        for r in rows.values()
    ]
    everyone.sort(key=lambda r: (-abs(r["ht"]), r["name"].casefold()))
    return {
        "segments": [
            {"segment": k, **{f: js_round(seg[k][f]) for f in _SEGMENT_KEYS}, "customers": len(seg[k]["ids"])}
            for k in CUSTOMER_SEGMENTS
        ],
        "customers": everyone[:TOP_CUSTOMERS],
        "customerCount": len(everyone),
        "unsplitHt": js_round(unsplit),
        "acquisition": acquisition_of(everyone, first_days, from_) if first_days is not None else None,
    }


def first_days_in_scope(
    first_lines: Iterable[RevenueLine],
    items: dict[str, ScopeItem],
    decisions: Iterable[RevenueDecision],
    customers: dict[str, RevenueCustomerFacts],
    filters: LineFilters,
) -> dict[str, str]:
    """Each customer's first purchase of what the page shows (3D scope, then the page's filters), from per-item first days."""
    out: dict[str, str] = {}
    for m in matching_lines(first_lines, items, decisions, customers, filters):
        c = m.line.customer_id
        out[c] = min(out.get(c, m.line.day), m.line.day)
    return out


def retention_series(
    lines: Iterable[RevenueLine],
    items: dict[str, ScopeItem],
    decisions: Iterable[RevenueDecision],
    customers: dict[str, RevenueCustomerFacts],
    filters: LineFilters,
    first_days: dict[str, str],
    g: Granularity,
    from_: str,
    to: str,
) -> list[dict]:
    """Per bucket: sales from customers whose first purchase falls in it (new), before it (returning), or unidentified."""
    starts = {k: bucket_range(k, g)[0] for k in dict.fromkeys(bucket_key_for(d, g) for d in all_days(from_, to))}
    acc = {
        k: {"new": 0.0, "returning": 0.0, "anon": 0.0, "newTtc": 0.0, "returningTtc": 0.0, "anonTtc": 0.0}
        for k in starts
    }
    ids: dict[str, dict[str, set[str]]] = {k: {"new": set(), "returning": set()} for k in starts}
    for m in matching_lines(lines, items, decisions, customers, filters):
        key = bucket_key_for(m.line.day, g)
        if key not in acc:
            continue
        c = m.line.customer_id
        if not c or m.segment == "passage":
            side = "anon"
        else:
            side = "returning" if first_days.get(c, m.line.day) < starts[key] else "new"
            ids[key][side].add(c)
        acc[key][side] += m.line.amount
        acc[key][f"{side}Ttc"] += ttc_of(m.line, m.item)[0]
    return [
        {
            "key": k,
            "label": bucket_label(k, g),
            "start": max(start, from_),
            "end": min(bucket_range(k, g)[1], to),
            **{f"{side}Ht": js_round(acc[k][side]) for side in ("new", "returning", "anon")},
            **{f"{side}Ttc": js_round(acc[k][f"{side}Ttc"]) for side in ("new", "returning", "anon")},
            "newCount": len(ids[k]["new"]),
            "returningCount": len(ids[k]["returning"]),
        }
        for k, start in starts.items()
    ]


def mover_ranges(key: str, g: Granularity, today: str) -> dict:
    """The bucket (to today when partial) against the one before it, clipped to the same number of days."""
    start, end = bucket_range(key, g)
    cur_to = min(end, today)
    elapsed = days_between(start, cur_to)
    prev_start, prev_end = bucket_range(bucket_key_for(add_days(start, -1), g), g)
    prev_to = add_days(prev_start, elapsed - 1) if end > today else prev_end
    return {"current": {"from": start, "to": cur_to}, "previous": {"from": prev_start, "to": min(prev_to, prev_end)}}


def _totals_by(rows: list[dict], by: str) -> dict[str, tuple[str, float]]:
    out: dict[str, tuple[str, float]] = {}
    for r in rows:
        key, label = (r["itemId"], r["name"]) if by == "item" else (brand_key(r["brand"]), r["brand"] or NO_BRAND)
        out[key] = (out[key][0] if key in out else label, (out[key][1] if key in out else 0) + r["ht"])
    return out


def _rank_movers(cur: dict, prev: dict, n: int) -> dict:
    all_: list[dict] = []
    for key in dict.fromkeys([*cur, *prev]):
        c = cur[key][1] if key in cur else 0
        p = prev[key][1] if key in prev else 0
        delta = js_round(c - p)
        if delta == 0:
            continue
        label = cur[key][0] if key in cur else prev[key][0]
        all_.append(
            {
                "key": key,
                "label": label,
                "current": js_round(c),
                "previous": js_round(p),
                "delta": delta,
                "change": (c - p) / p if p > 0 else None,
            }
        )
    # Stable sorts: label first, then delta (down mirrors loki's reversed comparator: label descending too).
    up = sorted((m for m in all_ if m["delta"] > 0), key=lambda m: m["label"].casefold())
    up.sort(key=lambda m: -m["delta"])
    down = sorted((m for m in all_ if m["delta"] < 0), key=lambda m: m["label"].casefold(), reverse=True)
    down.sort(key=lambda m: m["delta"])
    return {"up": up[:n], "down": down[:n]}


def compute_movers(
    current_rows: list[dict], previous_rows: list[dict], ranges: dict, shown: int = MOVERS_SHOWN
) -> dict:
    """Rows are `item_breakdown` output over each range."""
    return {
        **ranges,
        "items": _rank_movers(_totals_by(current_rows, "item"), _totals_by(previous_rows, "item"), shown),
        "brands": _rank_movers(_totals_by(current_rows, "brand"), _totals_by(previous_rows, "brand"), shown),
        "totals": {
            "current": sum(r["ht"] for r in current_rows),
            "previous": sum(r["ht"] for r in previous_rows),
        },
    }


def yoy_pivot(month_buckets: list[dict]) -> list[dict]:
    """One row per year, twelve months; a month with missing days is None and stops the running totals."""
    years: dict[int, dict] = {}
    for b in month_buckets:
        y, m = (int(p) for p in b["key"].split("-"))
        row = years.setdefault(
            y,
            {
                "year": y,
                "ht": [None] * 12,
                "ttc": [None] * 12,
                "cumulativeHt": [None] * 12,
                "cumulativeTtc": [None] * 12,
            },
        )
        if b["missingDays"] > 0:
            continue
        row["ht"][m - 1] = b["ht"]
        row["ttc"][m - 1] = b["ttc"]
    for row in years.values():
        ht = ttc = 0
        for i in range(12):
            if row["ht"][i] is None:
                break
            ht += row["ht"][i]
            ttc += row["ttc"][i]
            row["cumulativeHt"][i] = ht
            row["cumulativeTtc"][i] = ttc
    return sorted(years.values(), key=lambda r: r["year"])


def calendar_days(day_buckets: list[dict]) -> list[dict]:
    return [{"day": b["key"], "ht": b["ht"], "ttc": b["ttc"], "fetched": b["missingDays"] == 0} for b in day_buckets]


_MONTH_RE = re.compile(r"\d{4}-(0[1-9]|1[0-2])", re.ASCII)


def is_target_month(v: object) -> bool:
    return isinstance(v, str) and _MONTH_RE.fullmatch(v) is not None


def parse_target_amount(v: object) -> int | None:
    """A number in 0..10^12 (the range test rejects nan, inf and huge ints without overflowing), rounded; None otherwise (bool is not a number here)."""
    if isinstance(v, bool) or not isinstance(v, int | float) or not 0 <= v <= 1e12:
        return None
    return js_round(v)


def attach_targets(buckets: list[dict], g: Granularity, targets: list[dict]) -> list[dict]:
    """Targets are `{"month", "amountHt"}`; a year sums its months that have one. New dicts, day/week returned as is."""
    if g not in ("month", "year"):
        return buckets
    by_month = {t["month"]: t["amountHt"] for t in targets}
    out = []
    for b in buckets:
        if g == "month":
            target = by_month.get(b["key"])
        else:
            months = [v for k, v in by_month.items() if k.startswith(f"{b['key']}-")]
            target = sum(months) if months else None
        out.append({**b, "target": target})
    return out
