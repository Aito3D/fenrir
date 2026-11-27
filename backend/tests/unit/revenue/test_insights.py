from backend.app.services.revenue.config import REVENUE_SERVICE_ACCOUNT_ID as ACC
from backend.app.services.revenue.customers import RevenueCustomerFacts
from backend.app.services.revenue.insights import (
    acquisition_of,
    attach_targets,
    calendar_days,
    compute_movers,
    customer_breakdown,
    first_days_in_scope,
    is_target_month,
    mover_ranges,
    parse_target_amount,
    retention_series,
    yoy_pivot,
)
from backend.app.services.revenue.scope import ScopeItem
from backend.app.services.revenue.series import LineFilters, RevenueLine, item_breakdown
from backend.tests.unit.revenue.fixtures import bucket

ITEMS = {
    "pla": ScopeItem("pla", "SUNLU PLA", brand="SUNLU", nature="Filaments", tax_percentage=16),
    "print": ScopeItem("print", "Impression3D", brand="Aito3D", nature=None, account_id=ACC, tax_percentage=13),
    "esun": ScopeItem("esun", "eSUN PETG", brand="eSUN", nature="Filaments", tax_percentage=16),
}
CUSTOMERS = {
    "biz": RevenueCustomerFacts("biz", "Coco Dive", "Coco Dive", "business"),
    "ind": RevenueCustomerFacts("ind", "Bea", "", "individual"),
    "ind2": RevenueCustomerFacts("ind2", "", "", "individual"),
}
HISTORY_START = "2024-01-01"


def l(day, item_id, amount, customer_id="", quantity=1):  # noqa: E743
    return RevenueLine(day, item_id, customer_id, item_id, "", quantity, amount)


def breakdown(lines, filters=None, first_days=None, from_="2026-10-01"):
    return customer_breakdown(lines, ITEMS, [], CUSTOMERS, filters or LineFilters(), first_days, from_)


def movers(lines, ranges):
    cur = item_breakdown(
        [x for x in lines if ranges["current"]["from"] <= x.day <= ranges["current"]["to"]],
        ITEMS,
        [],
        None,
        LineFilters(),
    )
    prev = item_breakdown(
        [x for x in lines if ranges["previous"]["from"] <= x.day <= ranges["previous"]["to"]],
        ITEMS,
        [],
        None,
        LineFilters(),
    )
    return compute_movers(cur, prev, ranges, 5)


def test_splits_new_first_purchase_inside_the_range_from_returning_customers_and_averages_ht_per_customer_day():
    a = acquisition_of(
        [
            {"customerId": "n", "ht": 300, "activeDays": 1},
            {"customerId": "r", "ht": 700, "activeDays": 4},
            {"customerId": "x", "ht": 0, "activeDays": 0},
        ],
        {"n": "2026-10-03", "r": "2025-01-01"},
        "2026-10-01",
    )
    assert a == {
        "newCount": 1,
        "newHt": 300,
        "returningCount": 2,
        "returningHt": 700,
        "customerDays": 5,
        "avgBasketHt": 200,
    }


LINES = [
    l("2026-10-01", "pla", 1000, "biz"),
    l("2026-10-02", "print", 2000, "biz"),
    l("2026-10-02", "pla", 300, "ind", 3),
    l("2026-10-05", "print", 100, "ind"),
    l("2026-10-03", "pla", 40, ""),
]


def seg(r, name):
    return next(s for s in r["segments"] if s["segment"] == name)


def test_crosses_segments_with_goods_services_and_counts_distinct_customers():
    r = breakdown(LINES)
    assert {k: seg(r, "pro")[k] for k in ("ht", "goods", "services", "customers")} == {
        "ht": 3000,
        "goods": 1000,
        "services": 2000,
        "customers": 1,
    }
    assert {k: seg(r, "particulier")[k] for k in ("ht", "goods", "services", "customers")} == {
        "ht": 400,
        "goods": 300,
        "services": 100,
        "customers": 1,
    }
    assert (seg(r, "inconnu")["ht"], seg(r, "inconnu")["customers"]) == (40, 0)
    assert r["unsplitHt"] == 40


def test_ranks_customers_by_abs_ht_with_their_active_days_last_day_and_name_fallback():
    r = breakdown([*LINES, l("2026-10-04", "pla", 10, "ind2")])
    assert [[c["name"], c["ht"], c["activeDays"], c["lastDay"]] for c in r["customers"]] == [
        ["Coco Dive", 3000, 2, "2026-10-02"],
        ["Bea", 400, 2, "2026-10-05"],
        ["ind2", 10, 1, "2026-10-04"],
    ]
    assert r["customerCount"] == 3


def test_follows_the_filters():
    r = breakdown(LINES, LineFilters(kind="services"))
    assert [c["ht"] for c in r["customers"]] == [2000, 100]


def test_acquisition_is_present_at_the_history_start_and_absent_only_without_first_days():
    assert breakdown(LINES)["acquisition"] is None
    assert breakdown(LINES, first_days={"biz": "2026-10-01"}, from_=HISTORY_START)["acquisition"] is not None
    a = breakdown(LINES, first_days={"biz": "2026-10-01"})["acquisition"]
    assert (a["newCount"], a["returningCount"]) == (1, 1)


def test_compares_a_partial_month_with_the_previous_one_to_the_same_day():
    assert mover_ranges("2026-10", "month", "2026-10-15") == {
        "current": {"from": "2026-10-01", "to": "2026-10-15"},
        "previous": {"from": "2026-09-01", "to": "2026-09-15"},
    }
    assert mover_ranges("2026-09", "month", "2026-10-15")["previous"] == {"from": "2026-08-01", "to": "2026-08-31"}
    # 31 elapsed days never run past a 30-day previous month
    assert mover_ranges("2026-10", "month", "2026-10-31")["previous"]["to"] == "2026-09-30"


def test_ranks_items_and_brands_by_ht_delta_a_new_entry_carrying_a_null_change():
    lines = [
        l("2026-09-02", "pla", 1000),
        l("2026-09-03", "esun", 500),
        l("2026-10-02", "pla", 300),
        l("2026-10-03", "print", 900),
    ]
    r = movers(lines, mover_ranges("2026-10", "month", "2026-10-15"))
    assert r["items"]["up"] == [
        {"key": "print", "label": "Impression3D", "current": 900, "previous": 0, "delta": 900, "change": None}
    ]
    assert [[m["key"], m["delta"]] for m in r["items"]["down"]] == [["pla", -700], ["esun", -500]]
    assert [m["label"] for m in r["brands"]["up"]] == ["Aito3D"]
    assert r["totals"] == {"current": 1200, "previous": 1500}


def test_one_row_per_year_twelve_months_cumulative_stopping_at_the_first_unknown_month():
    rows = yoy_pivot(
        [
            bucket(key="2025-11", ht=10, ttc=11),
            bucket(key="2025-12", ht=20, ttc=22),
            bucket(key="2026-01", ht=5, ttc=6),
            bucket(key="2026-02", ht=7, ttc=8, missingDays=3),
        ]
    )
    assert [r["year"] for r in rows] == [2025, 2026]
    assert rows[0]["ht"][10:] == [10, 20]
    assert rows[0]["cumulativeHt"][11] is None  # January-October unknown: no running total
    assert rows[1]["ht"][:2] == [5, None]
    assert rows[1]["cumulativeHt"][:2] == [5, None]


def test_calendar_days_marks_a_day_with_missing_data_as_not_fetched():
    days = calendar_days([bucket(key="2026-10-01", ht=100, ttc=116), bucket(key="2026-10-02", missingDays=1)])
    assert days == [
        {"day": "2026-10-01", "ht": 100, "ttc": 116, "fetched": True},
        {"day": "2026-10-02", "ht": 0, "ttc": 0, "fetched": False},
    ]


def t(month, amount_ht):
    return {"month": month, "amountHt": amount_ht, "updatedAt": ""}


def test_attaches_a_months_own_target_and_a_years_sum_of_set_months_none_for_days_or_weeks():
    months = attach_targets([bucket(key="2026-10"), bucket(key="2026-11")], "month", [t("2026-10", 1000)])
    assert [b["target"] for b in months] == [1000, None]
    years = attach_targets([bucket(key="2026"), bucket(key="2025")], "year", [t("2026-10", 1000), t("2026-11", 500)])
    assert [b["target"] for b in years] == [1500, None]
    days = [bucket(key="2026-10-01")]
    assert attach_targets(days, "day", [t("2026-10", 1)]) is days


def test_validates_months_and_amounts():
    assert [is_target_month("2026-10"), is_target_month("2026-13"), is_target_month("2026-1")] == [True, False, False]
    assert [
        parse_target_amount(1500.4),
        parse_target_amount(-1),
        parse_target_amount("10"),
        parse_target_amount(float("inf")),
        parse_target_amount(True),
        parse_target_amount(1e12 + 1),
        parse_target_amount(10**400),
    ] == [1500, None, None, None, None, None, None]


PASSAGE = "66407000001237340"


def retention(lines, first_days, g="month", from_="2026-09-01", to="2026-10-31", filters=None):
    return retention_series(lines, ITEMS, [], CUSTOMERS, filters or LineFilters(), first_days, g, from_, to)


def test_retention_splits_each_bucket_into_new_returning_and_unidentified():
    rows = retention(
        [
            l("2026-09-03", "pla", 100, "biz"),
            l("2026-10-04", "pla", 200, "biz"),
            l("2026-10-05", "print", 100, "ind"),
            l("2026-10-06", "pla", 30, PASSAGE),
            l("2026-10-07", "pla", 20),
        ],
        {"biz": "2026-09-03", "ind": "2026-10-05"},
    )
    assert [r["key"] for r in rows] == ["2026-09", "2026-10"]
    sep, oct_ = rows
    assert (sep["newHt"], sep["returningHt"], sep["anonHt"], sep["newCount"], sep["returningCount"]) == (
        100,
        0,
        0,
        1,
        0,
    )
    assert (oct_["newHt"], oct_["returningHt"], oct_["anonHt"]) == (100, 200, 50)
    assert (oct_["newCount"], oct_["returningCount"]) == (1, 1)
    assert oct_["newTtc"] == 113  # 100 at 13 %
    assert (oct_["label"], oct_["start"], oct_["end"]) == ("oct. 2026", "2026-10-01", "2026-10-31")


def test_retention_new_is_judged_on_the_whole_bucket_and_the_edges_are_clipped():
    rows = retention([l("2026-09-20", "pla", 100, "biz")], {"biz": "2026-09-02"}, from_="2026-09-15", to="2026-09-25")
    assert rows == [
        {
            "key": "2026-09",
            "label": "sept. 2026",
            "start": "2026-09-15",
            "end": "2026-09-25",
            "newHt": 100,
            "returningHt": 0,
            "anonHt": 0,
            "newTtc": 116,
            "returningTtc": 0,
            "anonTtc": 0,
            "newCount": 1,
            "returningCount": 0,
        }
    ]


def test_first_days_in_scope_follow_the_page_filters():
    first = [l("2025-01-10", "print", 0, "biz"), l("2026-10-01", "pla", 0, "biz"), l("2026-01-01", "pla", 0, PASSAGE)]
    assert first_days_in_scope(first, ITEMS, [], CUSTOMERS, LineFilters()) == {
        "biz": "2025-01-10",
        PASSAGE: "2026-01-01",
    }
    goods = LineFilters(kind="goods")
    assert first_days_in_scope(first, ITEMS, [], CUSTOMERS, goods) == {"biz": "2026-10-01", PASSAGE: "2026-01-01"}
    # A filament buyer since 2025 on print services is new to filament this month.
    rows = retention([l("2026-10-04", "pla", 200, "biz")], first_days_in_scope(first, ITEMS, [], CUSTOMERS, goods))
    assert rows[1]["newHt"] == 200
