"""Collected and owed money, cut to the 3D share.

Zoho payments and balances are per invoice, not per item, and the org is shared with a non-3D business. A customer
whose cached lines are all in scope counts in full, one with none in scope counts zero; anyone else (both kinds, or
unknown to the cache) waits for the invoice itself, whose share is its in-scope HT over its whole HT. Nothing is guessed:
money whose share is not known yet goes in its own `unknown` bucket.
"""

from collections.abc import Iterable
from datetime import datetime
from zoneinfo import ZoneInfo

from backend.app.services.aito_poll_watermark import format_books_time
from backend.app.services.revenue.config import ORG_TIME_ZONE
from backend.app.services.revenue.dates import _month_shift, days_between
from backend.app.services.revenue.scope import RevenueDecision, ScopeItem, classify_revenue_item
from backend.app.services.revenue.series import RevenueLine, in_scope_lines, js_round, ttc_of

ONLY_3D, NO_3D, MIXED = "only3d", "none", "mixed"
CASH_MONTHS = 12
TOP_OVERDUE = 5
# The cash forecast: what falls due within FORECAST_DAYS, and overdue money still young enough to expect.
FORECAST_DAYS = 30
STALE_OVERDUE_DAYS = 90


def last_months(today: str, n: int = CASH_MONTHS) -> list[str]:
    """The n months ending with today's, oldest first."""
    return [_month_shift(today[:7], -i) for i in range(n - 1, -1, -1)]


def cursor_start(today: str) -> str:
    """Where the payment listing starts on a first fill: the 1st of the month 12 months back, org time, Books' spelling."""
    month = _month_shift(today[:7], -CASH_MONTHS)
    return format_books_time(datetime(int(month[:4]), int(month[5:7]), 1, tzinfo=ZoneInfo(ORG_TIME_ZONE)))


def classify_customers(
    pairs: Iterable[tuple[str, str]], items: dict[str, ScopeItem], decisions: Iterable[RevenueDecision]
) -> dict[str, str]:
    """(customer_id, item_id) pairs from the whole cache → only3d / none / mixed. A customer absent from the result is
    unknown to the cache and needs the documents, like a mixed one."""
    decision_by_id = {d.item_id: d for d in decisions}
    seen: dict[str, set[bool]] = {}
    for customer_id, item_id in pairs:
        if customer_id:
            verdict = classify_revenue_item(items.get(item_id), decision_by_id.get(item_id))
            seen.setdefault(customer_id, set()).add(verdict.included)
    return {c: MIXED if len(v) == 2 else ONLY_3D if True in v else NO_3D for c, v in seen.items()}


def customer_share(kind: str | None) -> float | None:
    """1 or 0 when the customer's class settles it; None when only the invoice can."""
    return 1.0 if kind == ONLY_3D else 0.0 if kind == NO_3D else None


def _lenient_float(v) -> float:
    # Lenient on purpose: NaN/inf pass and bool counts (True is 1), unlike sync_plan._strict_amount.
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def invoice_share(line_items: list[dict], items: dict[str, ScopeItem], decisions: Iterable[RevenueDecision]) -> float:
    """In-scope item_total over every line's item_total; a line without item_id only counts below the bar."""
    decision_by_id = {d.item_id: d for d in decisions}
    total = in_scope = 0.0
    for li in line_items:
        amount = _lenient_float(li.get("item_total"))
        total += amount
        item_id = li.get("item_id") or ""
        if item_id and classify_revenue_item(items.get(item_id), decision_by_id.get(item_id)).included:
            in_scope += amount
    return in_scope / total if total else 0.0


def detail_queue(
    payments: list[dict], invoices: list[dict], classes: dict[str, str], window_start: str
) -> tuple[list[str], list[str]]:
    """Payment ids needing their applications, then invoice ids needing their share, newest first. Only customers
    the cache cannot settle ever need one."""

    def unsettled(customer_id: str) -> bool:
        return customer_share(classes.get(customer_id)) is None

    pays = sorted(
        (p for p in payments if p["date"] >= window_start and unsettled(p["customerId"])),
        key=lambda p: p["date"],
        reverse=True,
    )
    by_id = {i["invoiceId"]: i for i in invoices}
    wanted: dict[str, str] = {
        i["invoiceId"]: i["date"]
        for i in invoices
        if i["balance"] > 0 and i["share"] is None and unsettled(i["customerId"])
    }
    for p in pays:
        for a in p["applications"] or []:
            inv = by_id.get(a["invoiceId"])
            if inv is None or inv["share"] is None:
                wanted.setdefault(a["invoiceId"], inv["date"] if inv else p["date"])
    return (
        [p["paymentId"] for p in pays if p["applications"] is None],
        sorted(wanted, key=lambda i: wanted[i], reverse=True),
    )


def collected_by_month(
    payments: list[dict], shares: dict[str, float | None], classes: dict[str, str], months: list[str]
) -> tuple[dict[str, dict[str, float]], float, float]:
    """Per month {collected, unknown}, plus the raw amounts whose share is known and unknown (for coverage)."""
    out = {m: {"collected": 0.0, "unknown": 0.0} for m in months}
    known = unknown = 0.0
    for p in payments:
        bucket = out.get(p["date"][:7])
        if bucket is None:
            continue
        share = customer_share(classes.get(p["customerId"]))
        apps = p["applications"]
        if share is not None:
            bucket["collected"] += p["amount"] * share
            known += p["amount"]
            continue
        if apps is None:
            bucket["unknown"] += p["amount"]
            unknown += p["amount"]
            continue
        for a in apps:
            s = shares.get(a["invoiceId"])
            if s is None:
                bucket["unknown"] += a["amount"]
                unknown += a["amount"]
            else:
                bucket["collected"] += a["amount"] * s
                known += a["amount"]
        # Money not applied to an invoice yet (an advance) has no share to apply.
        unapplied = max(p["amount"] - sum(a["amount"] for a in apps), 0.0)
        bucket["unknown"] += unapplied
        unknown += unapplied
    return out, known, unknown


def outstanding(invoices: list[dict], classes: dict[str, str], today: str) -> tuple[dict, list[dict], float]:
    """{total, overdue, invoices, unknown} (3D share applied), the most overdue invoices, and the raw known balance."""
    total = overdue = unknown = known = 0.0
    due_soon = late_recent = late_old = 0.0
    count = 0
    late: list[dict] = []
    for inv in invoices:
        balance = inv["balance"]
        if balance <= 0:
            continue
        share = customer_share(classes.get(inv["customerId"]))
        if share is None:
            share = inv["share"]
        if share is None:
            unknown += balance
            count += 1
            continue
        known += balance
        if share == 0:
            continue
        part = balance * share
        total += part
        count += 1
        due = inv["dueDate"]
        if not due or (due >= today and days_between(today, due) - 1 <= FORECAST_DAYS):
            due_soon += part  # no due date reads as due on receipt
        if due and due < today:
            overdue += part
            if days_between(due, today) - 1 > STALE_OVERDUE_DAYS:
                late_old += part
            else:
                late_recent += part
            late.append(
                {
                    "number": inv["number"],
                    "customerName": inv["customerName"],
                    "dueDate": inv["dueDate"],
                    "daysOverdue": days_between(inv["dueDate"], today) - 1,
                    "balance": js_round(part),
                }
            )
    late.sort(key=lambda r: (-r["balance"], r["dueDate"]))
    owed = {
        "total": js_round(total),
        "overdue": js_round(overdue),
        "invoices": count,
        "unknown": js_round(unknown),
        "dueSoon": js_round(due_soon),
        "lateRecent": js_round(late_recent),
        "lateOld": js_round(late_old),
    }
    return owed, late[:TOP_OVERDUE], known


def invoiced_ttc_by_month(
    lines: Iterable[RevenueLine], items: dict[str, ScopeItem], decisions: Iterable[RevenueDecision]
) -> dict[str, float]:
    """In-scope TTC per month, unfiltered: the same lines and tax rule as the series."""
    out: dict[str, float] = {}
    for line, item, _verdict in in_scope_lines(lines, items, decisions):
        out[line.day[:7]] = out.get(line.day[:7], 0.0) + ttc_of(line, item)[0]
    return out


def build_cash(
    *,
    payments: list[dict],
    invoices: list[dict],
    classes: dict[str, str],
    invoiced_ttc: dict[str, float],
    months: list[str],
    today: str,
    synced_at: str | None,
    error: str | None,
) -> dict:
    shares = {i["invoiceId"]: i["share"] for i in invoices}
    collected, paid_known, paid_unknown = collected_by_month(payments, shares, classes, months)
    owed, top, owed_known = outstanding(invoices, classes, today)
    return {
        "months": [
            {
                "month": m,
                "invoicedTtc": js_round(invoiced_ttc.get(m, 0.0)),
                "collected": js_round(collected[m]["collected"]),
                "collectedUnknown": js_round(collected[m]["unknown"]),
            }
            for m in months
        ],
        "outstanding": owed,
        "topOverdue": top,
        "coverage": {
            "known": js_round(paid_known + owed_known),
            "unknown": js_round(paid_unknown) + owed["unknown"],
        },
        "syncedAt": synced_at,
        "error": error,
    }
