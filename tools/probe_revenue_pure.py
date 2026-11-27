"""Golden probe (RV1): the Revenue page's pure backend logic on fixed inputs.

Calls services/revenue/* directly (no DB, no HTTP): calendar arithmetic, bucket keys/labels/
ranges/presets, scope verdicts, the sync and month-check planners, report-row merging, cash
aggregation, ABC/margin/dormant analysis, movers/yoy/calendar/targets, customer breakdown and
retention, production costs, the order-book pipeline, ETag + payload stripping, and the full
series builder on every granularity with and without filters. "today" and "now" are literals;
the one wall-clock reader (dates.org_today with no argument) is never called without one.
Every call goes through `call`, so an exception is recorded as data, not a crash.

Invoked by PROBES.json as `./venv/bin/python3 tools/probe_revenue_pure.py`. Loop tooling, not app code.
"""

import dataclasses
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.getcwd())

from backend.app.services.revenue import (  # noqa: E402
    analysis,
    cash,
    customers,
    dates,
    insights,
    memo,
    pipeline,
    production,
    products,
    scope,
    series,
    sync_plan,
)
from backend.app.services.revenue.customers import RevenueCustomerFacts  # noqa: E402
from backend.app.services.revenue.production import FilamentPrices, MachineRate, Run  # noqa: E402
from backend.app.services.revenue.scope import RevenueDecision, ScopeItem  # noqa: E402
from backend.app.services.revenue.series import LineFilters, RevenueLine  # noqa: E402
from backend.app.services.revenue.sync_plan import DayRow  # noqa: E402

TODAY = "2026-03-11"
NOW = datetime(2026, 3, 11, 20, 0, tzinfo=timezone.utc)
HISTORY = "2024-01-01"
OUT: dict = {}


def plain(v):
    if dataclasses.is_dataclass(v) and not isinstance(v, type):
        return {"__type__": type(v).__name__, **{f.name: plain(getattr(v, f.name)) for f in dataclasses.fields(v)}}
    if isinstance(v, dict):
        return {str(k): plain(x) for k, x in v.items()}
    if isinstance(v, (frozenset, set)):
        return sorted((plain(x) for x in v), key=json.dumps)
    if isinstance(v, (list, tuple)):
        return [plain(x) for x in v]
    if isinstance(v, float) and v != v:
        return "NaN"
    if isinstance(v, (str, int, float, bool)) or v is None:
        return v
    return repr(v)


def call(fn, *a, **k):
    try:
        v = fn(*a, **k)
        if hasattr(v, "__next__"):
            v = list(v)
        return plain(v)
    except Exception as e:  # noqa: BLE001 - the exception is the observed behaviour
        return {"__threw__": f"{type(e).__name__}: {e}"}


GRANS = ("day", "week", "month", "year")

# --- dates ---------------------------------------------------------------------
OUT["dates"] = {
    "org_today": [call(dates.org_today, datetime(2026, 3, 11, 9, 59, tzinfo=timezone.utc)),
                  call(dates.org_today, datetime(2026, 3, 11, 10, 0, tzinfo=timezone.utc)),
                  call(dates.org_today, NOW)],
    "is_valid_day": {d: call(dates.is_valid_day, d) for d in ["2026-02-28", "2026-02-29", "2024-02-29", "2026-1-01", "x", ""]},
    "day_to_utc": [call(dates.day_to_utc, d) for d in ["2026-03-11", "1970-01-01", "bad"]],
    "utc_to_day": [call(dates.utc_to_day, ms) for ms in [0, 1773187200000, 1773273599999]],
    "add_days": [call(dates.add_days, "2026-02-27", n) for n in (-60, -1, 0, 1, 2, 365)],
    "days_between": [call(dates.days_between, a, b) for a, b in [("2026-01-01", "2026-03-11"), ("2026-03-11", "2026-01-01"), ("2024-02-28", "2024-03-01")]],
    "all_days": call(dates.all_days, "2024-02-27", "2024-03-02"),
    "days_in_month": [call(dates.days_in_month, y, m) for y, m in [(2024, 2), (2026, 2), (2026, 12), (2026, 4)]],
    "iso_week": [call(dates.iso_week, d) for d in ["2026-01-01", "2025-12-29", "2027-01-03", "2026-03-11", "2020-12-31"]],
    "iso_week1_monday": [call(dates.iso_week1_monday, y) for y in (2020, 2025, 2026, 2027)],
}

# --- series helpers --------------------------------------------------------------
DAYS = ["2024-01-01", "2025-12-29", "2026-01-01", "2026-02-28", "2026-03-11", "2026-12-31"]
OUT["series_helpers"] = {g: {
    "bucket_key_for": {d: call(series.bucket_key_for, d, g) for d in DAYS},
    # dict outputs are key-sorted by json.dumps, so set iteration order never reaches the golden
    "bucket_range": {k: call(series.bucket_range, k, g) for k in {series.bucket_key_for(d, g) for d in DAYS}},
    "bucket_label": {k: call(series.bucket_label, k, g) for k in {series.bucket_key_for(d, g) for d in DAYS}},
    "shift_bucket_year": {k: [call(series.shift_bucket_year, k, g, n) for n in (-1, 1)] for k in {series.bucket_key_for(d, g) for d in DAYS}},
    "is_bucket_key": {k: call(series.is_bucket_key, k, g) for k in ["2026", "2026-03", "2026-03-11", "2026-W10", "2026-W53", "2026-13", "x"]},
    "default_range": call(series.default_range, g, TODAY, HISTORY),
    "snap_to_bucket_end": [call(series.snap_to_bucket_end, t, g, TODAY) for t in ["2026-03-11", "2026-02-02", "2025-06-15"]],
    "series_line_range": call(series.series_line_range, g, "2025-02-01", "2026-03-11", HISTORY),
} for g in GRANS}
OUT["clamp_range"] = [call(series.clamp_range, a, b, HISTORY, TODAY) for a, b in [("2020-01-01", "2030-01-01"), ("2025-01-01", "2025-02-01"), ("2026-04-01", "2026-05-01")]]
OUT["range_preset"] = {p: call(series.range_preset, p, TODAY, HISTORY) for p in [*series.RANGE_PRESETS, "nope"]}
OUT["js_round"] = [call(series.js_round, x) for x in (0.5, 1.5, 2.5, -0.5, -1.5, 1.49999, 1e9 + 0.5)]
OUT["project_bucket"] = [
    call(series.project_bucket, (1000.0, 1160.0), 10, 31, (800.0, 900.0), (2500.0, 2800.0)),
    call(series.project_bucket, (1000.0, 1160.0), 10, 31, None, None),
    call(series.project_bucket, (0.0, 0.0), 0, 31, None, None),
    call(series.project_bucket, (500.0, 580.0), 10, 31, (0.0, 0.0), (2500.0, 2800.0)),
]

# --- scope / customers / products ---------------------------------------------------
ITEMS = {
    "pla": ScopeItem("pla", "SUNLU PLA", sku="PLA-1", brand="SUNLU", nature="Filaments", tax_percentage=16, unit_cost=1200),
    "x1": ScopeItem("x1", "Bambu X1C", sku="X1C", brand="Bambu Lab", nature=None, tax_percentage=16, unit_cost=150000),
    "print": ScopeItem("print", "Impression 3D", sku="SRV", brand="Aito3D", nature=None, tax_percentage=13),
    "kayak": ScopeItem("kayak", "Kayak", sku="K", brand="Ocean", nature="Boats", tax_percentage=16, unit_cost=50000),
    "glue": ScopeItem("glue", "Magigoo stick", sku="MG", brand="magigoo ", nature="3D Printer Adhesives", tax_percentage=None, unit_cost=None),
    "odd": ScopeItem("odd", "", sku="", brand=None, nature=None),
}
DECISIONS = [RevenueDecision("kayak", True, "2026-01-01T00:00:00"), RevenueDecision("glue", False, "2026-01-02T00:00:00")]
DEC = {d.item_id: d for d in DECISIONS}
OUT["scope"] = {
    "fold": [call(scope.fold, s) for s in ["Écolé ÀÏ", "  MiXed  ", None, ""]],
    "brand_key": [call(scope.brand_key, s) for s in ["Bambu Lab", "bambu  lab", "SUNLU", None, "Ünknown"]],
    "classify": {k: call(scope.classify_revenue_item, ITEMS.get(k), DEC.get(k)) for k in [*ITEMS, "ghost"]},
    "classify_include_unknown": call(scope.classify_revenue_item, None, RevenueDecision("ghost", True, "t")),
    "is_service": {k: call(scope.is_service_item, v) for k, v in ITEMS.items()},
    "matches_kind": {k: [call(scope.matches_kind, v, kd) for kd in (None, "goods", "services", "bogus")] for k, v in ITEMS.items()},
    "display_name": {k: call(scope.item_display_name, ITEMS.get(k), "fallback") for k in [*ITEMS, "ghost"]},
    "unit_cost_of": [call(scope.unit_cost_of, a, b) for a, b in [(10, 20), (None, 20), (0, 0), ("x", None), (float("nan"), 5), (None, None)]],
}
TOTALS = [
    {"itemId": k, "name": ITEMS[k].name if k in ITEMS else "Ghost", "sku": "", "quantity": q, "totalHt": a, "lastDay": "2026-03-01"}
    for k, q, a in [("pla", 10, 12000), ("x1", 1, 180000), ("print", 3, 9000), ("kayak", 1, 60000), ("glue", 2, 1400), ("odd", 1, 10), ("ghost", 1, 5)]
]
OUT["review_list"] = call(scope.build_review_list, TOTALS, ITEMS, DECISIONS)
OUT["product_list"] = call(products.build_product_list, TOTALS, ITEMS, DECISIONS)
OUT["parse_brands"] = [call(products.parse_brands, r) for r in [[], ["SUNLU"], ["Bambu Lab", "bambu lab", ""], ["x" * 200]]]
OUT["parse_item_ids"] = [call(products.parse_item_ids, r) for r in [None, "", "pla", "pla,x1,pla", "bad id", ",".join(f"i{n}" for n in range(300))]]
OUT["parse_series_filters"] = [call(products.parse_series_filters, *a) for a in [(None, [], None, None), ("pla", ["SUNLU"], "goods", "pro"), (None, [], "bogus", None), (None, [], None, "bogus")]]
CUSTS = {
    "c-pro": RevenueCustomerFacts("c-pro", name="Lycée", company_name="Lycée Gauguin", sub_type="business"),
    "c-ind": RevenueCustomerFacts("c-ind", name="Hina", company_name=None, sub_type="individual"),
    "66407000001237340": RevenueCustomerFacts("66407000001237340", name="Client de passage", sub_type="individual"),
    "c-named": RevenueCustomerFacts("c-named", name="CLIENT DE PASSAGE", sub_type="business"),
}
OUT["customers"] = {
    "segment_of": {repr(k): call(customers.segment_of, k, CUSTS.get(k)) for k in [*CUSTS, "c-none", "", None]},
    "display_name": {k: call(customers.customer_display_name, k, CUSTS.get(k)) for k in [*CUSTS, "c-none"]},
}

# --- series builder ------------------------------------------------------------------
def line(day, item, cust, qty, amount, cost=None, tax=None):
    return RevenueLine(day=day, item_id=item, customer_id=cust, name=ITEMS[item].name if item in ITEMS else item, sku="", quantity=qty, amount=amount, unit_cost=cost, tax_percentage=tax)


LINES = [
    line("2025-03-03", "pla", "c-pro", 4, 4800, 1100, 16),
    line("2025-03-20", "print", "c-ind", 1, 3000),
    line("2025-12-30", "x1", "c-pro", 1, 180000, 150000, 16),
    line("2026-01-05", "pla", "c-ind", 2, 2400),
    line("2026-01-05", "kayak", "c-pro", 1, 60000, 50000, 16),
    line("2026-02-14", "glue", "c-ind", 1, 700),
    line("2026-02-27", "print", "66407000001237340", 2, 6000, None, 13),
    line("2026-03-02", "pla", "c-named", -1, -1200, 1200, 16),
    line("2026-03-03", "ghost", "c-pro", 1, 50),
    line("2026-03-10", "print", "c-pro", 1, 4500),
    line("2026-03-11", "pla", "", 3, 3600),
]
FETCHED = sorted({ln.day for ln in LINES} | {"2026-03-04", "2026-03-05"})
PROD = production.ProductionCosts(
    by_day={"2026-02-27": {"filament": 300.0, "energy": 50.0, "wear": 80.0, "labor": 1000.0}, "2026-03-10": {"filament": 120.0, "energy": 20.0}},
    first_day="2026-01-01",
    hours_by_day={"2026-02-27": 5.5, "2026-03-10": 2.0},
)
FILTERS = {
    "none": None,
    "items": LineFilters(item_ids=frozenset({"pla", "print"})),
    "brand": LineFilters(brands=frozenset({"sunlu"})),
    "goods": LineFilters(kind="goods"),
    "services": LineFilters(kind="services"),
    "pro": LineFilters(segment="pro"),
    "passage": LineFilters(segment="passage"),
}
RANGES = {"day": ("2026-02-25", "2026-03-11"), "week": ("2026-01-26", "2026-03-15"), "month": ("2025-01-01", "2026-03-31"), "year": ("2024-01-01", "2026-12-31")}
OUT["build_revenue_series"] = {}
for g in GRANS:
    f, t = RANGES[g]
    for name, flt in FILTERS.items():
        if g != "month" and name not in ("none", "goods"):
            continue
        OUT["build_revenue_series"][f"{g}/{name}"] = call(
            series.build_revenue_series, lines=LINES, fetched_days=FETCHED, items=ITEMS, decisions=DECISIONS,
            granularity=g, from_=f, to=t, today=TODAY, history_start=HISTORY, filters=flt, customers=CUSTS,
            production=PROD if name == "none" else None,
        )
OUT["item_breakdown"] = {n: call(series.item_breakdown, LINES, ITEMS, DECISIONS, CUSTS, flt or LineFilters()) for n, flt in FILTERS.items()}
OUT["in_scope_lines"] = call(series.in_scope_lines, LINES, ITEMS, DECISIONS)
OUT["ttc_of"] = [call(series.ttc_of, ln, ITEMS.get(ln.item_id)) for ln in LINES]
OUT["unit_cost_for"] = [call(series.unit_cost_for, ln, ITEMS.get(ln.item_id)) for ln in LINES]

# --- insights -------------------------------------------------------------------------
month_buckets = OUT["build_revenue_series"]["month/none"]
day_buckets = OUT["build_revenue_series"]["day/none"]
OUT["insights"] = {
    "yoy_pivot": call(insights.yoy_pivot, month_buckets) if isinstance(month_buckets, list) else month_buckets,
    "calendar_days": call(insights.calendar_days, day_buckets) if isinstance(day_buckets, list) else day_buckets,
    "is_target_month": [call(insights.is_target_month, v) for v in ["2026-03", "2026-13", "2026-3", 202603, None]],
    "parse_target_amount": [call(insights.parse_target_amount, v) for v in [5000, 5000.4, "5000", -1, 0, True, None, 1e13]],
    "attach_targets": {g: call(insights.attach_targets, [{"key": k} for k in keys], g, [{"month": "2026-03", "amountHt": 9000}, {"month": "2026-01", "amountHt": 3100}])
                       for g, keys in {"month": ["2026-01", "2026-02", "2026-03"], "year": ["2026"], "week": ["2026-W10"], "day": ["2026-03-11"]}.items()},
    "mover_ranges": {f"{g}:{k}": call(insights.mover_ranges, k, g, TODAY) for g, k in [("day", "2026-03-11"), ("week", "2026-W11"), ("month", "2026-03"), ("month", "2026-02"), ("year", "2026"), ("year", "2024")]},
}
first = call(insights.first_days_in_scope, LINES, ITEMS, DECISIONS, CUSTS, LineFilters())
OUT["insights"]["first_days_in_scope"] = first
OUT["insights"]["customer_breakdown"] = call(insights.customer_breakdown, LINES, ITEMS, DECISIONS, CUSTS, LineFilters(), first, "2026-01-01")
OUT["insights"]["customer_breakdown_pro"] = call(insights.customer_breakdown, LINES, ITEMS, DECISIONS, CUSTS, LineFilters(segment="pro"), None, "2026-01-01")
OUT["insights"]["retention_series"] = {g: call(insights.retention_series, LINES, ITEMS, DECISIONS, CUSTS, LineFilters(), first, g, *RANGES[g]) for g in GRANS}
OUT["insights"]["customer_totals"] = call(insights.customer_totals, LINES, ITEMS, DECISIONS, CUSTS, LineFilters())
OUT["insights"]["acquisition_of"] = call(insights.acquisition_of, [{"customerId": "c-pro", "ht": 100, "activeDays": 2}, {"customerId": "c-ind", "ht": 50, "activeDays": 1}, {"customerId": "c-new", "ht": 10, "activeDays": 1}], {"c-pro": "2025-03-03", "c-ind": "2026-01-05"}, "2026-01-01")
cur_rows = OUT["item_breakdown"]["none"] if isinstance(OUT["item_breakdown"]["none"], list) else []
prev_rows = [dict(r, ht=r.get("ht", 0) // 2 + 100) for r in cur_rows[:3]]
ranges = insights.mover_ranges("2026-03", "month", TODAY)
OUT["insights"]["compute_movers"] = call(insights.compute_movers, cur_rows, prev_rows, ranges, 3)
OUT["insights"]["compute_movers_customers"] = call(insights.compute_movers, cur_rows, prev_rows, ranges, 3, ({"c-pro": ("Lycée", 900.0), "c-ind": ("Hina", 10.0)}, {"c-pro": ("Lycée", 100.0), "c-gone": ("Gone", 50.0)}))

# --- analysis ---------------------------------------------------------------------------
def arow(item, ht, **o):
    return {"itemId": item, "name": item, "sku": "", "quantity": 1, "ht": ht, "ttc": ht, "cost": None, "nature": None, "brand": None, "kind": "goods", "reason": "nature", **o}


AROWS = [arow("a", 5000, cost=3000, brand="SUNLU", nature="Filaments"), arow("b", 2500, cost=None, brand="SUNLU"), arow("c", 1500, cost=1600, brand="Bambu Lab", nature="3D Printers"),
         arow("d", 600), arow("e", 300, kind="services"), arow("f", -200), arow("g", 0)]
OUT["analysis"] = {
    "abc": call(analysis.abc_analysis, AROWS), "abc_shown2": call(analysis.abc_analysis, AROWS, 2), "abc_empty": call(analysis.abc_analysis, []),
    "margin_brand": call(analysis.margin_by, AROWS, "brand"), "margin_nature": call(analysis.margin_by, AROWS, "nature"),
    "dormant_ranges": call(analysis.dormant_ranges, TODAY),
    "dormant_items": call(analysis.dormant_items, AROWS, [arow("a", 10)], {"b": "2025-10-01", "c": "2025-06-30", "d": "2025-12-01"}),
}

# --- cash -----------------------------------------------------------------------------------
def pay(pid, cust, day, amount, applications=None):
    return {"paymentId": pid, "customerId": cust, "date": day, "amount": amount, "unapplied": 0, "applications": applications}


def inv(iid, cust, balance, share=None, due="2026-03-30", day="2026-03-01", name="Client"):
    return {"invoiceId": iid, "number": f"INV-{iid}", "customerId": cust, "customerName": name, "date": day, "dueDate": due, "total": balance, "balance": balance, "share": share}


pairs = [("c-pro", "pla"), ("c-pro", "x1"), ("c-ind", "kayak"), ("c-ind", "pla"), ("c-boat", "kayak"), ("c-mix", "pla"), ("c-mix", "odd"), ("", "pla")]
classes = cash.classify_customers(pairs, ITEMS, DECISIONS)
PAYS = [pay("p1", "c-pro", "2026-03-02", 5000), pay("p2", "c-mix", "2026-02-10", 1000, [{"invoiceId": "i3", "amount": 1000}]),
        pay("p3", "c-boat", "2026-01-15", 9000), pay("p4", "c-unknown", "2025-04-01", 300), pay("p5", "c-mix", "2026-03-10", 400)]
INVS = [inv("i1", "c-pro", 2000, due="2026-03-20"), inv("i2", "c-pro", 1500, due="2026-01-10", day="2025-12-01"), inv("i3", "c-mix", 800, share=0.25, due="2025-10-01", day="2025-09-01"),
        inv("i4", "c-mix", 600, due="2026-02-25"), inv("i5", "c-boat", 7000, due="2026-02-01"), inv("i6", "c-unknown", 100, due="2026-03-14")]
months = cash.last_months(TODAY)
OUT["cash"] = {
    "last_months": [call(cash.last_months, TODAY), call(cash.last_months, "2026-01-31", 3)],
    "cursor_start": [call(cash.cursor_start, TODAY), call(cash.cursor_start, "2024-02-29")],
    "classify_customers": plain(classes),
    "customer_share": [call(cash.customer_share, k) for k in ("only3d", "mixed", "none", None, "bogus")],
    "invoice_share": [call(cash.invoice_share, li, ITEMS, DECISIONS) for li in [
        [{"item_id": "pla", "item_total": 300}, {"item_id": "kayak", "item_total": "500"}, {"item_id": "", "item_total": 200}],
        [{"item_id": "glue", "item_total": 100}], [], [{"item_id": "pla", "item_total": "x"}]]],
    "detail_queue": call(cash.detail_queue, PAYS, INVS, classes, months[0] + "-01"),
    "collected_by_month": call(cash.collected_by_month, PAYS, {"p2": 0.5}, classes, months),
    "outstanding": call(cash.outstanding, INVS, classes, TODAY),
    "invoiced_ttc_by_month": call(cash.invoiced_ttc_by_month, LINES, ITEMS, DECISIONS),
    "build_cash": call(cash.build_cash, payments=PAYS, invoices=INVS, classes=classes, invoiced_ttc=cash.invoiced_ttc_by_month(LINES, ITEMS, DECISIONS),
                       months=months, today=TODAY, synced_at="2026-03-11T19:00:00+00:00", error=None),
    "build_cash_empty": call(cash.build_cash, payments=[], invoices=[], classes={}, invoiced_ttc={}, months=months, today=TODAY, synced_at=None, error="boom"),
}

# --- sync planners ----------------------------------------------------------------------------
T0 = datetime(2026, 3, 11, 20, 0)


def fetched(day, age_s, closed=True, fmt=2):
    from datetime import timedelta

    return DayRow(day, closed, (T0 - timedelta(seconds=age_s)).isoformat(), fmt)


H, D = 3600, 86400
IDX = [fetched("2026-03-11", 30, closed=False), fetched("2026-03-10", 13 * H), fetched("2026-03-09", H, closed=False),
       fetched("2026-03-05", 20 * D, fmt=1), fetched("2026-03-02", 3 * D), fetched("2026-02-27", 40 * D), fetched("2026-03-12", 1)]
OUT["sync_plan"] = {
    "plan": call(sync_plan.plan_revenue_sync, days=IDX, today=TODAY, now=T0, history_start="2026-02-25", format=2, live_ttl_s=60, recent_days=7, recent_ttl_s=12 * H),
    "plan_fresh_today": call(sync_plan.plan_revenue_sync, days=[fetched("2026-03-11", 10, closed=False)], today=TODAY, now=T0, history_start="2026-03-11", format=2, live_ttl_s=60, recent_days=7, recent_ttl_s=12 * H),
    "month_window": [call(sync_plan.month_window, m, HISTORY) for m in ["2026-02", "2024-01", "2023-12", "2026-13"]],
    "count_legacy_days": [call(sync_plan.count_legacy_days, IDX, f) for f in (1, 2, 3)],
}
feb = [fetched(d, 30 * D) for d in dates.all_days("2026-02-01", "2026-02-28")]
jan = [fetched(d, 30 * D) for d in dates.all_days("2026-01-01", "2026-01-31")]
OUT["sync_plan"]["month_check"] = [
    call(sync_plan.plan_month_check, days=jan + feb, checks=c, today=TODAY, now=T0, history_start="2026-01-01", skip=s)
    for c, s in [({}, frozenset()), ({"2026-02": "2026-03-11T19:00:00"}, frozenset()), ({"2026-02": "2026-01-01T00:00:00"}, frozenset()),
                 ({}, frozenset({"2026-02"})), ({"2026-02": "2026-03-11T19:00:00", "2026-01": "2026-03-11T19:00:00"}, frozenset())]
]
OUT["sync_plan"]["month_check_gap"] = call(sync_plan.plan_month_check, days=feb[:-3], checks={}, today=TODAY, now=T0, history_start="2026-02-01")


def srow(item_id="i1", **o):
    return {"item_id": item_id, "item_name": "A", "quantity_sold": 1, "amount": 10, "item": {"sku": "S"}, **o}


OUT["sync_plan"]["merge_day_rows"] = call(sync_plan.merge_day_rows, [
    {"group_name": "", "sales": [srow("i1", quantity_sold=2, amount=100), srow("i2", item_name=None, quantity_sold=-1, amount=-3097, item={}), srow("i1", amount=50)]},
    {"group_name": "Lycée", "customer_id": "c-pro", "sales": [srow("i1", quantity_sold=None, amount="12.5"), srow("", amount=5), srow("i3", quantity_sold="3", amount="garbage")]},
    {"customer_id": "c-x", "sales": [srow("i4", amount=float("nan"))]},
])

# --- production -------------------------------------------------------------------------------
RATE = MachineRate(watts=150, wear_per_hour=1.2)
runs = [
    Run(started_at=datetime(2026, 3, 1, 20), printer_id=1, seconds=3600, grams=100, cost=None, energy_cost=None, wear_cost=None, material="PLA"),
    Run(started_at=datetime(2026, 3, 2, 9, 59), printer_id=1, seconds=7200, grams=None, cost=55, energy_cost=4, wear_cost=None, material="PETG"),
    Run(started_at=datetime(2026, 3, 2, 10, 1), printer_id=2, seconds=1800, grams=20, cost=None, energy_cost=None, wear_cost=2, material="TPU, PLA"),
    Run(started_at=datetime(2025, 6, 1), printer_id=None, seconds=600, grams=5, cost=None, energy_cost=None, wear_cost=None, material=None),
]
prices = FilamentPrices([("PLA", 2500), ("pla", 2200), ("PETG", 3000), ("TPU 95A", 4000), ("PPS-CF", 30000), ("", 10), ("ABS", 0)])
OUT["production"] = {
    "per_g": {m: call(prices.per_g, m) for m in ["PLA", "petg", "TPU", "TPU, PLA", "Nylon", "", None]},
    "per_g_empty": call(FilamentPrices([]).per_g, "PLA"),
    "match_rate": [call(production.match_rate, m, n, {"X1C": RATE, "A1": MachineRate(80, 0.5), "A1 mini": MachineRate(60, 0.4)}) for m, n in [("X1C", "x"), (None, "A1 mini #2"), (None, "A1-03"), (None, "P1S"), ("H2D", "A1")]],
    "org_day": [call(production.org_day, d) for d in [datetime(2026, 3, 2, 9, 59), datetime(2026, 3, 2, 10, 0), datetime(2026, 3, 2, 10, 0, tzinfo=timezone.utc)]],
    "run_cost": [call(production.run_cost, r, RATE, 30, prices.per_g(r.material)) for r in runs] + [call(production.run_cost, runs[0], None, 30, None)],
    "costs_by_day": call(production.costs_by_day, runs, {1: RATE}, 30, prices, since="2026-01-01"),
    "labor_by_day": call(production.labor_by_day, [{"name": "A", "hourlyRate": 1500, "hoursPerDay": 8, "daysPerWeek": 5, "since": "2026-03-02"},
                                                   {"name": "B", "hourlyRate": 1000, "hoursPerDay": 4, "daysPerWeek": 6, "since": "2026-03-07"},
                                                   {"name": "C", "hourlyRate": 1000, "hoursPerDay": 4, "daysPerWeek": 7, "since": "2026-04-01"}], TODAY, "2026-03-01"),
}

# --- pipeline / memo -----------------------------------------------------------------------------
class Card:
    def __init__(self, col, status, invoiced, total, retainer, sent):
        self.board_column, self.quote_status, self.quote_invoiced, self.quote_total, self.retainer_paid_total, self.quote_sent_at = col, status, invoiced, total, retainer, sent


CARDS = [Card("print", "accepted", False, 800.4, 200, None), Card("print", "accepted", False, None, None, None), Card("done", "accepted", True, 999, 0, None),
         Card("devis", "sent", False, 200, None, datetime(2026, 2, 1, 8)), Card("devis", "viewed", False, None, None, datetime(2026, 3, 10, 8)),
         Card("mystery", "accepted", False, 50.5, 10.5, None), Card("devis", "declined", False, 70, None, None)]
OUT["pipeline"] = [call(pipeline.build_pipeline, CARDS, datetime(2026, 3, 11, 20)), call(pipeline.build_pipeline, [], datetime(2026, 3, 11, 20))]
PAYLOAD = {"buckets": [{"key": "2026-03", "ht": 10, "cost": 5, "costedHt": 10, "marginSplit": {}, "costParts": {}, "printHours": 1, "bySegment": {"pro": 1}, "bySegmentTtc": {}, "customerName": "X",
                        "customers": [{"name": "Y"}], "topOverdue": [1]}], "marginByBrand": [], "customerId": "c"}
OUT["memo"] = {
    "etag": [call(memo.revenue_etag, "s1", "/api/v1/revenue?granularity=month"), call(memo.revenue_etag, "s2", "/api/v1/revenue?granularity=month"), call(memo.revenue_etag, "s1", "/api/v1/revenue")],
    "etag_matches": [call(memo.etag_matches, h, '"abc"') for h in [None, '"abc"', 'W/"abc"', '"x", "abc"', "*", '"abd"', ""]],
    "strip": {f"c{int(c)}m{int(m)}": call(memo.strip_payload, PAYLOAD, memo.CallerFlags(customers=c, margin=m)) for c in (False, True) for m in (False, True)},
    "caller_flags_none": call(memo.caller_flags, None),
}

print(json.dumps(plain(OUT), indent=1, sort_keys=True, ensure_ascii=False))
