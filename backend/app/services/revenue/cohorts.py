"""Customer cohorts by month of first purchase, their 12-month value, and customers gone quiet.

Fed with identified customers only: a walk-in sale has nobody to come back.
"""

import statistics
from collections import defaultdict

from backend.app.services.revenue.customers import CUSTOMER_SEGMENTS
from backend.app.services.revenue.dates import add_days, days_between
from backend.app.services.revenue.series import js_round

COHORT_MONTHS = 12
LTV_DAYS = 365
RISK_MIN_DAYS = 3
RISK_FACTOR = 1.5
RISK_ROWS = 20


def _months_after(month: str, other: str) -> int:
    return (int(other[:4]) - int(month[:4])) * 12 + int(other[5:7]) - int(month[5:7])


def _shift(month: str, delta: int) -> str:
    n = int(month[:4]) * 12 + int(month[5:7]) - 1 + delta
    return f"{n // 12:04d}-{n % 12 + 1:02d}"


def build_cohorts(
    purchases: list[tuple[str, str, float]], segments: dict[str, str], names: dict[str, str], today: str
) -> dict:
    """`purchases`: (customer id, day, HT) per in-scope line. A purchase day is a day that nets above zero."""
    by_day: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for customer, day, amount in purchases:
        by_day[customer][day] += amount
    this_month = today[:7]
    year_ago = add_days(today, -LTV_DAYS)
    months = [_shift(this_month, d) for d in range(1 - COHORT_MONTHS, 1)]
    cohorts = {m: {"size": 0, "back": [0] * COHORT_MONTHS, "revenue": 0.0} for m in months}
    ltv: dict[str, list[float]] = defaultdict(list)
    at_risk = []
    for customer, amounts in by_day.items():
        days = sorted(d for d, a in amounts.items() if a > 0)
        if not days:
            continue
        first = days[0]
        cohort = cohorts.get(first[:7])
        if cohort is not None:
            cohort["size"] += 1
            cohort["revenue"] += sum(a for d, a in amounts.items() if d >= first)
            for k in {_months_after(first[:7], d[:7]) for d in days} - {0}:
                cohort["back"][k - 1] += 1
        if first <= year_ago:
            end = add_days(first, LTV_DAYS)
            ltv[segments.get(customer, "inconnu")].append(sum(a for d, a in amounts.items() if first <= d < end))
        if len(days) >= RISK_MIN_DAYS:
            gap = statistics.median(days_between(a, b) - 1 for a, b in zip(days, days[1:], strict=False))
            since = days_between(days[-1], today) - 1
            if gap >= 1 and since > RISK_FACTOR * gap:
                at_risk.append(
                    {
                        "customerName": names.get(customer, customer),
                        "lastDay": days[-1],
                        "usualGapDays": js_round(gap),
                        "daysSince": since,
                        "revenue12m": js_round(sum(a for d, a in amounts.items() if d > year_ago)),
                    }
                )
    at_risk.sort(key=lambda r: (-r["revenue12m"], r["customerName"].casefold()))
    return {
        "cohorts": [
            {
                "month": m,
                "size": c["size"],
                "retention": [
                    round(c["back"][k] / c["size"] * 100, 1) if c["size"] and _shift(m, k + 1) <= this_month else None
                    for k in range(COHORT_MONTHS)
                ],
                "revenuePerCustomer": js_round(c["revenue"] / c["size"]) if c["size"] else 0,
            }
            for m, c in cohorts.items()
        ],
        "ltv": [
            {"segment": s, "customers": len(ltv[s]), "ltv12": js_round(sum(ltv[s]) / len(ltv[s]))}
            for s in CUSTOMER_SEGMENTS
            if ltv.get(s)
        ],
        "atRisk": at_risk[:RISK_ROWS],
    }
