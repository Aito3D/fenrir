"""Monthly operating result and break-even, from the month buckets of the series and each month's fixed costs.

A bucket's `costParts` already holds the item costs, the print log's filament/energy/wear, the labour and the daily
share of the fixed costs and of the depreciation; those three are charges here, everything else is variable.
"""

import math

from backend.app.services.revenue.dates import add_days, days_in_month
from backend.app.services.revenue.series import js_round

TRAILING_MONTHS = 3


def _split(bucket: dict) -> tuple[float, float, float, float]:
    """(revenue HT, variable costs, labour, depreciation) of a month bucket."""
    parts = bucket.get("costParts") or {}
    labor, depreciation = parts.get("labor", 0), parts.get("depreciation", 0)
    fixed = parts.get("fixed", 0) + parts.get("fixedEstimated", 0)
    return bucket["ht"], sum(parts.values()) - labor - fixed - depreciation, labor, depreciation


def _break_even(months: list[dict], day_buckets: list[dict], charges: float, gone: int, total: int) -> dict | None:
    ht, variable = _split(months[-1])[:2]
    if ht <= 0:
        # Nothing sold yet this month: the mix of the last closed months stands in.
        closed = [_split(m) for m in months[-1 - TRAILING_MONTHS : -1]]
        ht_ref, variable = sum(c[0] for c in closed), sum(c[1] for c in closed)
    else:
        ht_ref = ht
    rate = (ht_ref - variable) / ht_ref if ht_ref > 0 else 0.0
    if rate <= 0 or charges <= 0:
        return None
    amount = charges / rate
    running, day = 0.0, None
    for d in day_buckets:
        running += d["ht"]
        if running >= amount:
            day = d["start"]
            break
    projected = day is None
    if projected and gone and ht > 0:
        nth = math.ceil(amount / (ht / gone))
        if nth <= total:
            day = add_days(f"{months[-1]['key']}-01", nth - 1)
    return {"amount": js_round(amount), "reached": round(ht / amount, 2), "day": day, "projected": projected}


def build_result(
    month_buckets: list[dict],
    day_buckets: list[dict],
    fixed_by_month: dict[str, tuple[float, float]],
    today: str,
    month_labor: float,
    costs_since: str | None,
    day_share: float = 0.0,
    month_depreciation: float = 0.0,
    month_fixed_goods: float = 0.0,
) -> dict:
    """`month_buckets`: oldest first, the last one is today's month; `day_buckets`: that month's days.

    `fixed_by_month` is each month's whole fixed costs as (entered in the books, usual charges the running month
    still misses): the estimate is always given apart, `fixed` is real only. `month_labor` is the labour of the whole current month (worked days are not spread evenly, so scaling the days
    gone would swing). `costs_since` is the first day print and labour costs exist: months before it are `partial`,
    their result would count services at full margin. `day_share` is the part of today already gone: fixed costs
    grow by the minute. `month_depreciation` is the whole current month's, for the break-even; a row's own comes
    from its bucket. `month_fixed_goods` is the goods' part of the current month's fixed costs, estimate included: every
    other charge is the services'. `coverage` is the share of the HT whose cost is known.
    """
    year, month = int(today[:4]), int(today[5:7])
    total = days_in_month(year, month)
    gone = int(today[8:10]) - 1  # today is not over yet, like labour
    rows = []
    for b in month_buckets:
        ht, variable, labor, depreciation = _split(b)
        share = (gone + day_share) / total if b["key"] == today[:7] else 1.0
        fixed, estimated = (v * share for v in fixed_by_month.get(b["key"], (0.0, 0.0)))
        real = ht - variable - labor - fixed - depreciation
        rows.append(
            {
                "month": b["key"],
                "ht": js_round(ht),
                "variable": js_round(variable),
                "labor": js_round(labor),
                "fixed": js_round(fixed),
                "fixedEstimated": js_round(estimated),
                "depreciation": js_round(depreciation),
                "result": js_round(real - estimated),
                # Without the estimate: what the books say today.
                "resultReal": js_round(real),
                "coverage": round(b.get("costedHt", 0) / ht, 2) if ht > 0 else None,
                "partial": costs_since is None or b["key"] < costs_since[:7],
            }
        )
    current = bool(month_buckets) and month_buckets[-1]["key"] == today[:7]
    month_fixed, month_estimated = fixed_by_month.get(today[:7], (0.0, 0.0))
    fixed_monthly = month_fixed + month_estimated
    return {
        "fixedMonthly": js_round(fixed_monthly),
        "charges": {
            "labor": js_round(month_labor),
            "fixed": js_round(month_fixed),
            "fixedEstimated": js_round(month_estimated),
            "fixedGoods": js_round(month_fixed_goods),
            "depreciation": js_round(month_depreciation),
        },
        "months": rows,
        "costsSince": costs_since,
        "breakEven": _break_even(
            month_buckets, day_buckets, fixed_monthly + month_labor + month_depreciation, gone, total
        )
        if current
        else None,
    }
