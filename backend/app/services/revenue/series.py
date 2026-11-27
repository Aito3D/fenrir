"""The revenue dashboard's read model: bucket keys, ranges and French labels (the series builder follows)."""

import math
import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from typing import Literal, get_args

from backend.app.services.revenue.customers import RevenueCustomerFacts, segment_of
from backend.app.services.revenue.dates import (
    add_days,
    all_days,
    days_between,
    days_in_month,
    is_valid_day,
    iso_week,
    iso_week1_monday,
    utc_to_day,
)
from backend.app.services.revenue.production import ProductionCosts
from backend.app.services.revenue.scope import (
    RevenueDecision,
    ScopeItem,
    ScopeVerdict,
    brand_key,
    classify_revenue_item,
    is_service_item,
    item_display_name,
    matches_kind,
)

Granularity = Literal["day", "week", "month", "quarter", "year"]
RangePresetId = Literal["this-year", "last-12-months", "all"]
RANGE_PRESETS: tuple[str, ...] = get_args(RangePresetId)

_DAY_MS = 86_400_000
# Hard-coded to equal Intl.DateTimeFormat("fr-FR", {month: "short"}); no locale dependency.
_FR_MONTHS = ("janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc.")


def _parse_week_key(key: str) -> tuple[int, int]:
    y, w = key.split("-W")
    return int(y), int(w)


def bucket_key_for(day: str, g: Granularity) -> str:
    if g == "day":
        return day
    if g == "week":
        year, week = iso_week(day)
        return f"{year}-W{week:02d}"
    if g == "quarter":
        return f"{day[:4]}-Q{(int(day[5:7]) + 2) // 3}"
    return day[:7] if g == "month" else day[:4]


def bucket_range(key: str, g: Granularity) -> tuple[str, str]:
    if g == "day":
        return key, key
    if g == "week":
        year, week = _parse_week_key(key)
        start = iso_week1_monday(year) + (week - 1) * 7 * _DAY_MS
        return utc_to_day(start), utc_to_day(start + 6 * _DAY_MS)
    if g == "month":
        y, m = (int(p) for p in key.split("-"))
        return f"{key}-01", f"{key}-{days_in_month(y, m):02d}"
    if g == "quarter":
        y, last = int(key[:4]), int(key[6]) * 3
        return f"{y}-{last - 2:02d}-01", f"{y}-{last:02d}-{days_in_month(y, last):02d}"
    return f"{key}-01-01", f"{key}-12-31"


def _fmt_day(day: str, *, year: bool = True) -> str:
    y, m, d = day.split("-")
    return f"{int(d)} {_FR_MONTHS[int(m) - 1]}" + (f" {y}" if year else "")


def bucket_label(key: str, g: Granularity) -> str:
    start, end = bucket_range(key, g)
    if g == "day":
        return _fmt_day(key)
    if g == "week":
        _, week = _parse_week_key(key)
        if start[:7] == end[:7]:
            left = str(int(start[8:]))
        else:
            left = _fmt_day(start, year=start[:4] != end[:4])
        return f"S{week:02d} · {left}–{_fmt_day(end)}"
    if g == "month":
        return f"{_FR_MONTHS[int(start[5:7]) - 1]} {start[:4]}"
    if g == "quarter":
        return f"T{key[6]} {key[:4]}"
    return key


def shift_bucket_year(key: str, g: Granularity, delta: int) -> str | None:
    """The same bucket `delta` years away, or None when it does not exist (ISO week 53)."""
    if g == "day":
        y, m, d = (int(p) for p in key.split("-"))
        year = y + delta
        return f"{year}-{m:02d}-{min(d, days_in_month(year, m)):02d}"
    if g == "week":
        year, week = _parse_week_key(key)
        target = year + delta
        # A year has 53 ISO weeks when 28 December falls in week 53.
        return None if week > iso_week(f"{target}-12-28")[1] else f"{target}-W{week:02d}"
    if g == "month":
        y, m = key.split("-")
        return f"{int(y) + delta}-{m}"
    if g == "quarter":
        return f"{int(key[:4]) + delta}{key[4:]}"
    return str(int(key) + delta)


def is_bucket_key(key: str, g: Granularity) -> bool:
    if g == "day":
        return is_valid_day(key)
    pattern = {"week": r"\d{4}-W\d{2}", "month": r"\d{4}-\d{2}", "quarter": r"\d{4}-Q[1-4]", "year": r"\d{4}"}[g]
    return re.fullmatch(pattern, key, re.ASCII) is not None


def clamp_range(from_: str, to: str, history_start: str, today: str) -> tuple[str, str]:
    a = history_start if from_ < history_start else today if from_ > today else from_
    b = today if to > today else history_start if to < history_start else to
    return (b, a) if a > b else (a, b)


def range_preset(id: RangePresetId, today: str, history_start: str) -> tuple[str, str]:
    if id == "this-year":
        return clamp_range(f"{today[:4]}-01-01", today, history_start, today)
    if id == "last-12-months":
        year, m, d = int(today[:4]) - 1, int(today[5:7]), int(today[8:])
        back = f"{year}-{m:02d}-{min(d, days_in_month(year, m)):02d}"
        return clamp_range(add_days(back, 1), today, history_start, today)
    return history_start, today


def default_range(g: Granularity, today: str, history_start: str) -> tuple[str, str]:
    if g == "day":
        return clamp_range(add_days(today, -59), today, history_start, today)
    if g == "week":
        monday = bucket_range(bucket_key_for(today, "week"), "week")[0]
        return clamp_range(add_days(monday, -25 * 7), today, history_start, today)
    return range_preset("all", today, history_start)


def snap_to_bucket_end(to: str, g: Granularity, today: str) -> str:
    """The route's effective `to`: the end of the bucket holding it, never past today."""
    end = bucket_range(bucket_key_for(to, g), g)[1]
    return min(end, today)


def series_line_range(g: Granularity, from_: str, to: str, history_start: str) -> tuple[str, str]:
    """The lines the series must read: the first bucket's whole start, one year back for year-ago."""
    first_start = bucket_range(bucket_key_for(from_, g), g)[0]
    back = shift_bucket_year(bucket_key_for(first_start, g), g, -1)
    start = bucket_range(back, g)[0] if back else add_days(first_start, -366)
    return max(start, history_start), to


NO_NATURE = "Sans nature"
NO_BRAND = "Sans marque"
MARGIN_DIMS = ("nature", "brand", "segment", "kind")
KIND_KEY = {True: "Services", False: "Biens"}
UNALLOCATED = {"nature": NO_NATURE, "brand": NO_BRAND, "segment": "inconnu", "kind": "Services"}
# Below this share of last year's bucket reached at the same point, the seasonal ratio is noise.
SEASONAL_MIN_SHARE = 0.1


def js_round(x: float) -> int:
    """Math.round: halves round toward +infinity (Python's round() is banker's)."""
    return math.floor(x + 0.5)


@dataclass(frozen=True)
class RevenueLine:
    day: str
    item_id: str
    customer_id: str
    name: str
    sku: str
    quantity: float
    amount: float
    # The item's cost and tax rate when the day was fetched; None on days cached before they were kept.
    unit_cost: float | None = None
    tax_percentage: float | None = None


@dataclass(frozen=True)
class LineFilters:
    item_ids: frozenset[str] | None = None
    brands: frozenset[str] | None = None
    kind: str | None = None
    segment: str | None = None


def is_filtered(f: LineFilters) -> bool:
    return bool(f.item_ids is not None or f.brands is not None or f.kind or f.segment)


def ttc_of(line: RevenueLine, item: ScopeItem | None) -> tuple[float, bool]:
    tax = line.tax_percentage if line.tax_percentage is not None else item.tax_percentage if item else None
    return (line.amount, True) if tax is None else (line.amount * (1 + tax / 100), False)


def unit_cost_for(line: RevenueLine, item: ScopeItem | None) -> float | None:
    return line.unit_cost if line.unit_cost is not None else item.unit_cost if item else None


def in_scope_lines(
    lines: Iterable[RevenueLine],
    items: dict[str, ScopeItem],
    decisions: Iterable[RevenueDecision],
    item_ids: frozenset[str] | None = None,
) -> Iterator[tuple[RevenueLine, ScopeItem | None, ScopeVerdict]]:
    decision_by_id = {d.item_id: d for d in decisions}
    for line in lines:
        if item_ids is not None and line.item_id not in item_ids:
            continue
        item = items.get(line.item_id)
        verdict = classify_revenue_item(item, decision_by_id.get(line.item_id))
        if verdict.included:
            yield line, item, verdict


@dataclass(frozen=True)
class MatchedLine:
    line: RevenueLine
    item: ScopeItem | None
    verdict: ScopeVerdict
    segment: str


def matching_lines(
    lines: Iterable[RevenueLine],
    items: dict[str, ScopeItem],
    decisions: Iterable[RevenueDecision],
    customers: dict[str, RevenueCustomerFacts] | None,
    filters: LineFilters,
) -> Iterator[MatchedLine]:
    """The one place the series and the item rows decide which lines count."""
    for line, item, verdict in in_scope_lines(lines, items, decisions, filters.item_ids):
        if filters.brands is not None and brand_key(item.brand if item else None) not in filters.brands:
            continue
        if not matches_kind(item, filters.kind):
            continue
        facts = customers.get(line.customer_id) if customers and line.customer_id else None
        segment = segment_of(line.customer_id, facts)
        if filters.segment and filters.segment != segment:
            continue
        yield MatchedLine(line, item, verdict, segment)


class _Acc:
    def __init__(self) -> None:
        self.ht = self.ttc = self.goods = self.services = self.goods_ttc = self.services_ttc = 0.0
        self.cost = self.costed_ht = self.quantity = 0.0
        # Margin per split key: lines with a Zoho cost carry their own; service lines costed by the
        # print log share the bucket's production cost pro rata of their HT (`pool`).
        self.prod_cost = 0.0
        # The goods' part of the fixed costs: charged to the goods, never shared among the service lines.
        self.goods_fixed = 0.0
        self.prod_parts: dict[str, float] = {}
        self.margin: dict[str, dict[str, float]] = {d: {} for d in MARGIN_DIMS}
        self.pool: dict[str, dict[str, float]] = {d: {} for d in MARGIN_DIMS}
        self.ttc_approx = False
        self.splits: dict[str, dict[str, float]] = {
            k: {} for k in ("nature", "brand", "item", "nature_ttc", "brand_ttc", "item_ttc", "segment", "segment_ttc")
        }

    def margin_split(self) -> dict[str, dict[str, int]]:
        return _margin_split(self)

    def add(self, line: RevenueLine, item: ScopeItem | None, segment: str, production_from: str | None = None) -> None:
        amount = line.amount
        ttc, approx = ttc_of(line, item)
        unit_cost = unit_cost_for(line, item)
        nature = item.nature if item and item.nature is not None else NO_NATURE
        brand = item.brand if item and item.brand is not None else NO_BRAND
        name = item_display_name(item, line.name)
        keys = {"nature": nature, "brand": brand, "segment": segment, "kind": KIND_KEY[is_service_item(item)]}
        if unit_cost is not None:
            line_cost = line.quantity * unit_cost
            self.cost += line_cost
            self.costed_ht += amount
            for dim, key in keys.items():
                self.margin[dim][key] = self.margin[dim].get(key, 0) + amount - line_cost
        elif production_from is not None and line.day >= production_from and is_service_item(item):
            # Its cost is the print log's, added per bucket in build_revenue_series.
            self.costed_ht += amount
            for dim, key in keys.items():
                self.pool[dim][key] = self.pool[dim].get(key, 0) + amount
        self.ht += amount
        self.ttc += ttc
        self.ttc_approx = self.ttc_approx or approx
        self.quantity += line.quantity
        if is_service_item(item):
            self.services += amount
            self.services_ttc += ttc
        else:
            self.goods += amount
            self.goods_ttc += ttc
        for split, key, value in (
            ("segment", segment, amount),
            ("segment_ttc", segment, ttc),
            ("nature", nature, amount),
            ("brand", brand, amount),
            ("item", name, amount),
            ("nature_ttc", nature, ttc),
            ("brand_ttc", brand, ttc),
            ("item_ttc", name, ttc),
        ):
            d = self.splits[split]
            d[key] = d.get(key, 0) + value


def _margin_split(acc: "_Acc") -> dict[str, dict[str, int]]:
    out = {}
    for dim in MARGIN_DIMS:
        merged = dict(acc.margin[dim])
        pool = acc.pool[dim]
        total = sum(pool.values())
        for key, ht in pool.items():
            share = acc.prod_cost * ht / total if total else 0.0
            merged[key] = merged.get(key, 0) + ht - share
        if acc.prod_cost and not pool:
            # Printing with no service sold in the bucket: nobody to charge it to.
            key = UNALLOCATED[dim]
            merged[key] = merged.get(key, 0) - acc.prod_cost
        if acc.goods_fixed:
            key = KIND_KEY[False] if dim == "kind" else UNALLOCATED[dim]
            merged[key] = merged.get(key, 0) - acc.goods_fixed
        out[dim] = _round_record(merged)
    return out


def _round_record(r: dict[str, float]) -> dict[str, int]:
    return {k: js_round(v) for k, v in r.items()}


def _evolution(cur: float, prev: float | None) -> float | None:
    return None if prev is None or prev <= 0 else (cur - prev) / prev


def project_bucket(
    cur: tuple[float, float],
    elapsed_days: int,
    total_days: int,
    year_ago_to_date: tuple[float, float] | None,
    year_ago_full: tuple[float, float] | None,
) -> tuple[dict[str, int], str]:
    """Seasonal when last year's bucket is fully known and was far enough along, else linear; never below the figure made."""
    if (
        year_ago_to_date
        and year_ago_full
        and year_ago_full[0] > 0
        and year_ago_to_date[0] >= SEASONAL_MIN_SHARE * year_ago_full[0]
    ):
        ratio = max(1, year_ago_full[0] / year_ago_to_date[0])
        method = "seasonal"
    else:
        ratio = max(1, total_days / max(1, elapsed_days))
        method = "linear"
    return {"ht": js_round(cur[0] * ratio), "ttc": js_round(cur[1] * ratio)}, method


def build_revenue_series(
    *,
    lines: Iterable[RevenueLine],
    fetched_days: Iterable[str],
    items: dict[str, ScopeItem],
    decisions: Iterable[RevenueDecision],
    granularity: Granularity,
    from_: str,
    to: str,
    today: str,
    history_start: str,
    filters: LineFilters | None = None,
    customers: dict[str, RevenueCustomerFacts] | None = None,
    production: ProductionCosts | None = None,
) -> list[dict]:
    g = granularity
    filters = filters or LineFilters()
    # Printing costs belong to the services as a whole: no item, brand or customer slice can claim them. The fixed
    # costs alone are split: their goods part is the only production cost a goods view carries.
    fixed_goods = production.fixed_goods_by_day if production and filters.kind != "services" else {}
    if filters.item_ids is not None or filters.brands is not None or filters.segment:
        production, fixed_goods = None, {}
    elif filters.kind == "goods":
        production = None
    production_from = production.first_day if production else None
    totals: dict[str, _Acc] = {}
    per_day: dict[str, list[float]] = {}
    for m in matching_lines(lines, items, decisions, customers, filters):
        d = per_day.setdefault(m.line.day, [0.0, 0.0])
        d[0] += m.line.amount
        d[1] += ttc_of(m.line, m.item)[0]
        totals.setdefault(bucket_key_for(m.line.day, g), _Acc()).add(m.line, m.item, m.segment, production_from)
    print_hours: dict[str, float] = {}
    if production:
        for day, hours in production.hours_by_day.items():
            key = bucket_key_for(day, g)
            print_hours[key] = print_hours.get(key, 0.0) + hours
        for day, parts in production.by_day.items():
            acc = totals.setdefault(bucket_key_for(day, g), _Acc())
            goods = production.fixed_goods_by_day.get(day, {})
            for part, cost in parts.items():
                cost -= goods.get(part, 0)
                if cost:
                    acc.prod_cost += cost
                    acc.prod_parts[part] = acc.prod_parts.get(part, 0) + cost
    for day, parts in fixed_goods.items():
        acc = totals.setdefault(bucket_key_for(day, g), _Acc())
        for part, cost in parts.items():
            acc.goods_fixed += cost
            acc.prod_parts[part] = acc.prod_parts.get(part, 0) + cost

    keys: list[str] = []
    for day in all_days(from_, to):
        key = bucket_key_for(day, g)
        if not keys or keys[-1] != key:
            keys.append(key)

    fetched = set(fetched_days)

    def sum_range(a: str, b: str) -> tuple[int, int] | None:
        if a < history_start:
            return None
        days = all_days(a, b)
        if not days or not all(d in fetched for d in days):
            return None
        ht = ttc = 0.0
        for d in days:
            if d in per_day:
                ht += per_day[d][0]
                ttc += per_day[d][1]
        return js_round(ht), js_round(ttc)

    def money(m: tuple[int, int] | None) -> dict[str, int] | None:
        return None if m is None else {"ht": m[0], "ttc": m[1]}

    def comparison_range(cmp_key: str, elapsed: int | None) -> tuple[str, str]:
        start, end = bucket_range(cmp_key, g)
        clipped = end if elapsed is None else add_days(start, elapsed - 1)
        return start, min(clipped, end)

    show_items = filters.item_ids is not None or filters.brands is not None
    out: list[dict] = []
    cum_ht = cum_ttc = 0
    for key in keys:
        acc = totals.get(key) or _Acc()
        sp = acc.splits
        start, end = bucket_range(key, g)
        ht, ttc = js_round(acc.ht), js_round(acc.ttc)
        cum_ht += ht
        cum_ttc += ttc
        partial = end >= today
        elapsed = days_between(start, today) if partial else None
        back = shift_bucket_year(key, g, -1)
        year_ago = sum_range(*comparison_range(back, elapsed)) if back else None
        prev_key = bucket_key_for(add_days(start, -1), g)
        prev_sum = sum_range(*comparison_range(prev_key, elapsed))
        count_from = max(start, history_start)
        count_to = min(end, today)
        missing = sum(1 for d in all_days(count_from, count_to) if d not in fetched)
        projection = projection_method = None
        if partial and elapsed is not None and g != "day" and missing == 0:
            year_ago_full = sum_range(*bucket_range(back, g)) if back else None
            projection, projection_method = project_bucket(
                (ht, ttc), elapsed, days_between(start, end), year_ago, year_ago_full
            )
        out.append(
            {
                "key": key,
                "label": bucket_label(key, g),
                "start": start,
                "end": end,
                "ht": ht,
                "ttc": ttc,
                "goods": js_round(acc.goods),
                "services": js_round(acc.services),
                "byNature": _round_record(sp["nature"]),
                "byBrand": _round_record(sp["brand"]),
                **({"byItem": _round_record(sp["item"])} if show_items else {}),
                "goodsTtc": js_round(acc.goods_ttc),
                "servicesTtc": js_round(acc.services_ttc),
                "byNatureTtc": _round_record(sp["nature_ttc"]),
                "byBrandTtc": _round_record(sp["brand_ttc"]),
                **({"byItemTtc": _round_record(sp["item_ttc"])} if show_items else {}),
                "bySegment": _round_record(sp["segment"]),
                "bySegmentTtc": _round_record(sp["segment_ttc"]),
                "cost": js_round(acc.cost + acc.prod_cost + acc.goods_fixed),
                "marginSplit": acc.margin_split(),
                # What the cost is made of: Zoho item costs, then the services' print and labour costs.
                "costParts": _round_record({"items": acc.cost, **acc.prod_parts}),
                # The part of `fixed` + `fixedEstimated` that weighs on the goods: not the service lines' to share.
                "fixedGoods": js_round(acc.goods_fixed),
                "costedHt": js_round(acc.costed_ht),
                # Null before the print log began: no data, not zero hours.
                **(
                    {"printHours": round(print_hours.get(key, 0.0), 1) if end >= production_from else None}
                    if production_from
                    else {}
                ),
                "projection": projection,
                "projectionMethod": projection_method,
                "quantity": acc.quantity,
                "evolution": {
                    "ht": _evolution(ht, prev_sum[0] if prev_sum else None),
                    "ttc": _evolution(ttc, prev_sum[1] if prev_sum else None),
                },
                "yearAgo": money(year_ago),
                # The whole previous bucket, for a window that starts at this one (« Année précédente » with one column).
                "previousTotal": money(sum_range(*bucket_range(prev_key, g))) if key == keys[0] else None,
                "elapsedDays": elapsed,
                "cumulative": {"ht": cum_ht, "ttc": cum_ttc},
                "partial": partial,
                "missingDays": missing,
                "ttcApprox": acc.ttc_approx,
            }
        )
    return out


def item_breakdown(
    lines: Iterable[RevenueLine],
    items: dict[str, ScopeItem],
    decisions: Iterable[RevenueDecision],
    customers: dict[str, RevenueCustomerFacts] | None,
    filters: LineFilters,
) -> list[dict]:
    rows: dict[str, dict] = {}
    for m in matching_lines(lines, items, decisions, customers, filters):
        line, item = m.line, m.item
        row = rows.get(line.item_id)
        if row is None:
            row = rows[line.item_id] = {
                "itemId": line.item_id,
                "name": item_display_name(item, line.name),
                "sku": line.sku,
                "quantity": 0,
                "ht": 0,
                "ttc": 0.0,
                "cost": None,
                "costedHt": 0.0,
                "nature": item.nature if item else None,
                "brand": item.brand if item else None,
                "kind": "service" if is_service_item(item) else "goods",
                "reason": m.verdict.reason,
            }
        row["quantity"] += line.quantity
        row["ht"] += line.amount
        row["ttc"] += ttc_of(line, item)[0]
        unit_cost = unit_cost_for(line, item)
        if unit_cost is not None:
            row["cost"] = (row["cost"] or 0.0) + line.quantity * unit_cost
            row["costedHt"] += line.amount
    result = [
        {
            **r,
            "ht": js_round(r["ht"]),
            "ttc": js_round(r["ttc"]),
            "cost": None if r["cost"] is None else js_round(r["cost"]),
            "costedHt": js_round(r["costedHt"]),
        }
        for r in rows.values()
    ]
    # localeCompare is ICU collation; casefold is the closest stdlib order.
    return sorted(result, key=lambda r: (-r["ht"], r["name"].casefold()))
