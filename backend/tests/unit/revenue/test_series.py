import pytest

from backend.app.services.revenue.config import REVENUE_SERVICE_ACCOUNT_ID as ACC
from backend.app.services.revenue.customers import RevenueCustomerFacts
from backend.app.services.revenue.dates import all_days, is_valid_day
from backend.app.services.revenue.production import ProductionCosts
from backend.app.services.revenue.scope import RevenueDecision, ScopeItem
from backend.app.services.revenue.series import (
    SEASONAL_MIN_SHARE,
    LineFilters,
    RevenueLine,
    build_revenue_series,
    in_scope_lines,
    is_bucket_key,
    is_filtered,
    item_breakdown,
    js_round,
    matching_lines,
    project_bucket,
    ttc_of,
)
from backend.tests.unit.revenue.fixtures import bucket

ITEMS = {
    "pla": ScopeItem("pla", "SUNLU PLA", brand="SUNLU", nature="Filaments", tax_percentage=16),
    "print": ScopeItem("print", "Impression3D", brand="Aito3D", nature=None, account_id=ACC, tax_percentage=13),
    "hobie": ScopeItem("hobie", "Hobie T1", brand="Hobie", nature="Hobie Sailing", tax_percentage=16),
    "notax": ScopeItem("notax", "Pre-migration", brand="eSUN", nature=None, tax_percentage=None),
}
FETCHED_ALL = all_days("2025-08-01", "2026-10-15")


def line(day, item_id, amount, quantity=1, customer_id=""):
    return RevenueLine(day, item_id, customer_id, item_id, "", quantity, amount)


def decision(item_id, included):
    return RevenueDecision(item_id, included, "")


def series(**over):
    args = {
        "lines": [],
        "fetched_days": all_days("2026-09-01", "2026-10-15"),
        "items": ITEMS,
        "decisions": [],
        "granularity": "month",
        "from_": "2026-09-01",
        "to": "2026-10-15",
        "today": "2026-10-15",
        "history_start": "2024-01-01",
        "filters": LineFilters(),
        "customers": None,
    }
    return build_revenue_series(**{**args, **over})


def has(actual, expected):
    for k, v in expected.items():
        assert actual[k] == v, k


def test_sums_in_scope_lines_per_bucket_with_ht_per_item_ttc_goods_services_and_the_two_breakdowns():
    b = series(
        lines=[
            line("2026-09-03", "pla", 1000, 2),
            line("2026-09-20", "print", 2000),
            line("2026-09-21", "hobie", 99999),
            line("2026-10-01", "print", -11681, 2),
            line("2026-10-02", "pla", 500),
        ]
    )
    assert [x["key"] for x in b] == ["2026-09", "2026-10"]
    has(
        b[0],
        {
            "label": "sept. 2026",
            "ht": 3000,
            "ttc": 1160 + 2260,
            "goods": 1000,
            "services": 2000,
            "byNature": {"Filaments": 1000, "Sans nature": 2000},
            "byBrand": {"SUNLU": 1000, "Aito3D": 2000},
            "quantity": 3,
            "partial": False,
            "missingDays": 0,
            "ttcApprox": False,
        },
    )
    has(b[1], {"ht": -11181, "ttc": js_round(-11681 * 1.13 + 500 * 1.16), "partial": True})


def test_bucket_has_exactly_loki_keys_in_camel_case():
    [b] = series(from_="2026-09-01", to="2026-09-30", lines=[line("2026-09-03", "pla", 1000)])
    assert set(b) == set(bucket())


def test_evolution_vs_previous_bucket_null_when_none_or_previous_le_0_cumulative_from_the_first_displayed_bucket():
    b = series(lines=[line("2026-09-10", "pla", 1000), line("2026-10-10", "pla", 1500)])
    assert b[0]["evolution"] == {"ht": None, "ttc": None}
    assert b[1]["evolution"]["ht"] == pytest.approx(0.5)
    assert b[1]["evolution"]["ttc"] == pytest.approx(0.5)
    assert b[0]["cumulative"] == {"ht": 1000, "ttc": 1160}
    assert b[1]["cumulative"] == {"ht": 2500, "ttc": 2900}


def test_a_negative_previous_bucket_yields_a_null_evolution():
    b = series(lines=[line("2026-09-10", "pla", -100), line("2026-10-10", "pla", 300)])
    assert b[1]["evolution"] == {"ht": None, "ttc": None}


def test_year_ago_reads_the_same_bucket_one_year_earlier_from_the_lines_given_null_before_history_start():
    b = series(
        lines=[line("2025-10-05", "pla", 700), line("2026-10-05", "pla", 900)],
        fetched_days=[*all_days("2025-09-01", "2025-10-31"), *all_days("2026-09-01", "2026-10-15")],
    )
    assert b[1]["yearAgo"] == {"ht": 700, "ttc": 812}
    assert b[0]["yearAgo"] == {"ht": 0, "ttc": 0}
    early = series(
        from_="2024-01-01", to="2024-02-29", fetched_days=all_days("2024-01-01", "2024-02-29"), today="2026-10-15"
    )
    assert early[0]["yearAgo"] is None


def test_year_ago_is_null_while_the_year_ago_range_is_not_fully_fetched():
    b = series(
        from_="2026-09-01",
        to="2026-09-30",
        lines=[line("2025-09-05", "pla", 700), line("2026-09-05", "pla", 900)],
        fetched_days=[*all_days("2025-09-01", "2025-09-15"), *all_days("2026-01-01", "2026-10-15")],
    )
    assert b[0]["yearAgo"] is None


def test_year_ago_is_set_when_the_year_ago_range_is_fully_fetched():
    b = series(
        from_="2026-09-01",
        to="2026-09-30",
        lines=[line("2025-09-05", "pla", 700), line("2026-09-05", "pla", 900)],
        fetched_days=[*all_days("2025-09-01", "2025-09-30"), *all_days("2026-01-01", "2026-10-15")],
    )
    assert b[0]["yearAgo"]["ht"] == 700


def test_empty_buckets_still_appear_missing_days_counts_unfetched_days_up_to_today_only_and_never_before_history_start():
    b = series(
        granularity="week", from_="2026-10-05", to="2026-10-15", fetched_days=all_days("2026-10-05", "2026-10-13")
    )
    assert [x["key"] for x in b] == ["2026-W41", "2026-W42"]
    has(b[0], {"ht": 0, "missingDays": 0, "partial": False})
    has(b[1], {"missingDays": 2, "partial": True})
    early = series(
        granularity="week",
        from_="2024-01-03",
        to="2024-01-07",
        fetched_days=all_days("2024-01-03", "2024-01-07"),
        history_start="2024-01-03",
    )
    assert early[0]["missingDays"] == 0


def test_an_item_with_unknown_tax_contributes_its_ht_to_the_ttc_and_flags_ttc_approx():
    b = series(lines=[line("2026-09-10", "notax", 1000)])
    has(b[0], {"ht": 1000, "ttc": 1000, "ttcApprox": True})


def test_decisions_change_the_scope_an_excluded_filament_drops_out_an_included_hobie_item_counts():
    b = series(
        lines=[line("2026-09-10", "pla", 1000), line("2026-09-11", "hobie", 50)],
        decisions=[decision("pla", False), decision("hobie", True)],
    )
    assert b[0]["ht"] == 50


def test_accumulates_each_lines_own_ttc_into_the_nature_brand_kind_splits_unknown_rate_ht():
    [b] = series(
        from_="2026-09-01",
        to="2026-09-30",
        lines=[line("2026-09-03", "pla", 1000), line("2026-09-03", "print", -1000), line("2026-09-04", "notax", 200)],
    )
    has(
        b,
        {
            "ht": 200,
            "ttc": 1160 - 1130 + 200,
            "goodsTtc": 1160 + 200,
            "servicesTtc": -1130,
            "byNatureTtc": {"Filaments": 1160, "Sans nature": -1130 + 200},
            "byBrandTtc": {"SUNLU": 1160, "Aito3D": -1130, "eSUN": 200},
            "ttcApprox": True,
        },
    )
    assert "byItemTtc" not in b
    assert sum(b["byNatureTtc"].values()) == b["ttc"]


def test_carries_by_item_ttc_exactly_when_by_item_is_present():
    [b] = series(
        from_="2026-09-01",
        to="2026-09-30",
        filters=LineFilters(item_ids=frozenset({"pla"})),
        lines=[line("2026-09-03", "pla", 1000)],
    )
    assert b["byItem"] == {"SUNLU PLA": 1000}
    assert b["byItemTtc"] == {"SUNLU PLA": 1160}


def test_a_credit_note_day_lowers_ht_and_shows_as_a_negative_by_brand_entry():
    [b] = series(
        from_="2026-09-01",
        to="2026-09-30",
        lines=[line("2026-09-03", "pla", 8000), line("2026-09-04", "pla", -5000)],
    )
    assert b["ht"] == 3000
    assert series(from_="2026-09-01", to="2026-09-30", lines=[line("2026-09-04", "pla", -5000)])[0]["byBrand"] == {
        "SUNLU": -5000
    }


def test_an_empty_item_id_set_gives_all_zero_buckets():
    b = series(filters=LineFilters(item_ids=frozenset()), lines=[line("2026-09-05", "pla", 1000)])
    assert all(x["ht"] == 0 and x["ttc"] == 0 and x["byItem"] == {} for x in b)


def test_item_breakdown_lists_in_scope_items_with_their_reason_ht_desc():
    rows = item_breakdown(
        [
            line("2026-09-03", "pla", 1000, 2),
            line("2026-09-04", "pla", 200),
            line("2026-09-20", "print", 2000),
            line("2026-09-21", "hobie", 99999),
        ],
        ITEMS,
        [],
        None,
        LineFilters(),
    )
    assert rows == [
        {
            "itemId": "print",
            "name": "Impression3D",
            "sku": "",
            "quantity": 1,
            "ht": 2000,
            "ttc": 2260,
            "cost": None,
            "costedHt": 0,
            "nature": None,
            "brand": "Aito3D",
            "kind": "service",
            "reason": "brand",
        },
        {
            "itemId": "pla",
            "name": "SUNLU PLA",
            "sku": "",
            "quantity": 3,
            "ht": 1200,
            "ttc": 1392,
            "cost": None,
            "costedHt": 0,
            "nature": "Filaments",
            "brand": "SUNLU",
            "kind": "goods",
            "reason": "nature",
        },
    ]


def test_evolution_uses_only_the_first_elapsed_days_days_of_the_previous_bucket():
    b = series(
        fetched_days=FETCHED_ALL,
        lines=[line("2026-09-10", "pla", 1000), line("2026-09-20", "pla", 9000), line("2026-10-05", "pla", 1500)],
    )
    assert b[1]["partial"] is True
    assert b[1]["elapsedDays"] == 15
    assert b[1]["evolution"]["ht"] == pytest.approx(0.5)
    assert b[0]["elapsedDays"] is None


def test_year_ago_uses_only_the_first_elapsed_days_days_of_the_year_ago_bucket():
    b = series(
        fetched_days=FETCHED_ALL,
        lines=[line("2025-10-05", "pla", 700), line("2025-10-25", "pla", 5000), line("2026-10-05", "pla", 900)],
    )
    assert b[1]["yearAgo"] == {"ht": 700, "ttc": 812}


def test_a_non_partial_bucket_keeps_the_whole_bucket_comparison():
    b = series(
        from_="2026-08-01",
        to="2026-09-30",
        fetched_days=FETCHED_ALL,
        lines=[
            line("2026-08-05", "pla", 1000),
            line("2026-08-25", "pla", 1000),
            line("2026-09-20", "pla", 3000),
            line("2025-09-28", "pla", 400),
        ],
    )
    assert b[1]["elapsedDays"] is None
    assert b[1]["partial"] is False
    assert b[1]["evolution"]["ht"] == pytest.approx(0.5)
    assert b[1]["yearAgo"]["ht"] == 400


def test_the_first_displayed_bucket_gets_an_evolution_when_its_previous_bucket_is_fetched_within_history():
    b = series(
        from_="2026-10-01",
        to="2026-10-15",
        fetched_days=FETCHED_ALL,
        lines=[line("2026-09-05", "pla", 1000), line("2026-10-05", "pla", 2000)],
    )
    assert len(b) == 1
    assert b[0]["evolution"]["ht"] == pytest.approx(1)


def test_evolution_is_null_when_the_previous_range_is_not_fetched():
    b = series(
        from_="2026-10-01",
        to="2026-10-15",
        fetched_days=all_days("2026-10-01", "2026-10-15"),
        lines=[line("2026-09-05", "pla", 1000)],
    )
    assert b[0]["evolution"] == {"ht": None, "ttc": None}


def test_restricts_the_series_to_the_selected_items_and_splits_each_bucket_by_item():
    lines = [line("2026-09-05", "pla", 1000, 2), line("2026-09-06", "print", 2000), line("2026-10-02", "pla", 500)]
    everything = series(fetched_days=FETCHED_ALL, lines=lines)
    assert everything[0]["ht"] == 3000
    assert "byItem" not in everything[0]
    only = series(fetched_days=FETCHED_ALL, lines=lines, filters=LineFilters(item_ids=frozenset({"pla"})))
    assert only[0]["ht"] == 1000
    assert only[0]["quantity"] == 2
    assert only[0]["byItem"] == {"SUNLU PLA": 1000}
    assert only[0]["byNature"] == {"Filaments": 1000}
    assert only[1]["ht"] == 500
    assert only[1]["cumulative"]["ht"] == 1500
    assert only[1]["evolution"]["ht"] == pytest.approx(-0.5, abs=1e-5)


def test_two_selected_products_sharing_a_name_merge_into_one_by_item_series():
    twins = {
        "a": ScopeItem("a", "Support", brand="Aito3D", account_id=ACC, tax_percentage=13),
        "b": ScopeItem("b", "Support", brand="Aito3D", account_id=ACC, tax_percentage=13),
    }
    [sep, *_] = series(
        fetched_days=FETCHED_ALL,
        items=twins,
        lines=[line("2026-09-05", "a", 1000), line("2026-09-06", "b", 2500)],
        filters=LineFilters(item_ids=frozenset({"a", "b"})),
    )
    assert sep["ht"] == 3500
    assert sep["byItem"] == {"Support": 3500}


def test_an_empty_selection_yields_an_empty_series_not_the_whole_book():
    b = series(
        fetched_days=FETCHED_ALL, lines=[line("2026-09-05", "pla", 1000)], filters=LineFilters(item_ids=frozenset())
    )
    assert b[0]["ht"] == 0
    assert b[0]["byItem"] == {}


def test_restricts_the_series_to_the_selected_brands_case_folded_and_splits_each_bucket_by_item():
    lines = [line("2026-09-05", "pla", 1000, 2), line("2026-09-06", "print", 2000), line("2026-09-07", "notax", 300)]
    only = series(fetched_days=FETCHED_ALL, lines=lines, filters=LineFilters(brands=frozenset({"sunlu", "esun"})))
    assert only[0]["ht"] == 1300
    assert only[0]["quantity"] == 3
    assert only[0]["byBrand"] == {"SUNLU": 1000, "eSUN": 300}
    assert only[0]["byItem"] == {"SUNLU PLA": 1000, "Pre-migration": 300}


def test_a_brand_filter_and_a_basket_compose_as_an_intersection():
    lines = [line("2026-09-05", "pla", 1000), line("2026-09-06", "print", 2000), line("2026-09-07", "notax", 300)]
    both = series(
        fetched_days=FETCHED_ALL,
        lines=lines,
        filters=LineFilters(brands=frozenset({"sunlu", "esun"}), item_ids=frozenset({"notax", "print"})),
    )
    assert both[0]["ht"] == 300
    assert both[0]["byItem"] == {"Pre-migration": 300}


def test_a_brandless_item_never_matches_a_brand_filter():
    no_brand = {**ITEMS, "snap": ScopeItem("snap", "Snap Maker", nature="Filaments")}
    b = series(
        fetched_days=FETCHED_ALL,
        items=no_brand,
        lines=[line("2026-09-05", "snap", 1000)],
        filters=LineFilters(brands=frozenset({"sunlu"})),
    )
    assert b[0]["ht"] == 0


def test_item_breakdown_restricted_to_the_selected_brands_composed_with_the_basket():
    lines = [line("2026-09-05", "pla", 1000), line("2026-09-06", "print", 2000), line("2026-09-07", "notax", 300)]

    def ids(f):
        return [r["itemId"] for r in item_breakdown(lines, ITEMS, [], None, f)]

    assert ids(LineFilters(brands=frozenset({"sunlu", "esun"}))) == ["pla", "notax"]
    assert ids(LineFilters(item_ids=frozenset({"pla", "print"}), brands=frozenset({"sunlu"}))) == ["pla"]


def test_kind_keeps_goods_or_services_only_an_item_of_unknown_type_counts_as_goods():
    lines = [line("2026-09-05", "pla", 1000), line("2026-09-06", "print", 2000), line("2026-09-07", "notax", 300)]
    goods = series(fetched_days=FETCHED_ALL, lines=lines, filters=LineFilters(kind="goods"))
    assert goods[0]["ht"] == 1300
    assert goods[0]["services"] == 0
    services = series(fetched_days=FETCHED_ALL, lines=lines, filters=LineFilters(kind="services"))
    assert services[0]["ht"] == 2000
    assert services[0]["goods"] == 0
    assert series(fetched_days=FETCHED_ALL, lines=lines, filters=LineFilters(kind=None))[0]["ht"] == 3300


def test_item_breakdown_restricted_by_kind_composed_with_brands():
    lines = [line("2026-09-05", "pla", 1000), line("2026-09-06", "print", 2000), line("2026-09-07", "notax", 300)]

    def ids(f):
        return [r["itemId"] for r in item_breakdown(lines, ITEMS, [], None, f)]

    assert ids(LineFilters(kind="services")) == ["print"]
    assert ids(LineFilters(brands=frozenset({"esun", "aito3d"}), kind="goods")) == ["notax"]


def test_item_breakdown_restricted_to_the_selected_items():
    lines = [line("2026-09-05", "pla", 1000), line("2026-09-06", "print", 2000)]

    def ids(f):
        return [r["itemId"] for r in item_breakdown(lines, ITEMS, [], None, f)]

    assert ids(LineFilters(item_ids=frozenset({"print"}))) == ["print"]
    assert ids(LineFilters()) == ["print", "pla"]


LINES4 = [
    line("2026-03-01", "pla", 10),
    line("2026-03-01", "hobie", 20),
    line("2026-03-02", "ghost", 30),
    line("2026-03-03", "print", 40),
]


def test_keeps_in_scope_lines_each_with_its_item_or_undefined():
    out = list(in_scope_lines(LINES4, ITEMS, [RevenueDecision("ghost", True, "x")]))
    assert [x[0].item_id for x in out] == ["pla", "ghost", "print"]
    assert out[0][1] is ITEMS["pla"]
    assert out[1][1] is None
    assert out[1][2].included is True and out[1][2].reason == "decision-include"


def test_applies_the_selection_before_the_scope_rule_an_empty_selection_yields_nothing():
    assert [x[0].item_id for x in in_scope_lines(LINES4, ITEMS, [], frozenset({"pla", "hobie"}))] == ["pla"]
    assert list(in_scope_lines(LINES4, ITEMS, [], frozenset())) == []


def test_an_item_missing_from_the_catalogue_falls_into_the_no_nature_no_brand_buckets_and_item_breakdown_reads_null_nature_and_brand():
    inc = [RevenueDecision("ghost", True, "2026-10-06")]
    b = series(lines=[line("2026-10-05", "ghost", 1000)], decisions=inc)
    assert len(b[1]["byNature"]) == 1
    assert len(b[1]["byBrand"]) == 1
    rows = item_breakdown([line("2026-10-05", "ghost", -400)], ITEMS, inc, None, LineFilters())
    assert len(rows) == 1
    has(rows[0], {"itemId": "ghost", "nature": None, "brand": None, "ht": -400, "quantity": 1})


def test_item_breakdown_breaks_an_equal_ht_tie_by_name():
    rows = item_breakdown(
        [line("2026-10-05", "pla", 500), line("2026-10-05", "print", 500)], ITEMS, [], None, LineFilters()
    )
    assert [r["name"] for r in rows] == ["Impression3D", "SUNLU PLA"]


def test_clips_the_previous_range_comparison_to_the_shorter_previous_month():
    b = series(
        from_="2026-03-01",
        to="2026-03-31",
        today="2026-03-31",
        fetched_days=all_days("2025-01-01", "2026-03-31"),
        lines=[line("2026-02-10", "pla", 1000), line("2026-03-10", "pla", 2000)],
    )
    assert b[0]["partial"] is True
    assert b[0]["elapsedDays"] == 31
    assert b[0]["evolution"]["ht"] == pytest.approx(1)


def test_a_partial_week_53_has_no_year_ago_counterpart_so_its_year_ago_evolution_is_null():
    b = series(
        granularity="week",
        from_="2026-12-28",
        to="2026-12-30",
        today="2026-12-30",
        fetched_days=all_days("2025-01-01", "2026-12-30"),
        lines=[line("2026-12-29", "pla", 1000)],
    )
    assert b[0]["key"] == "2026-W53"
    assert b[0]["partial"] is True
    assert b[0]["yearAgo"] is None


CUSTOMERS = {
    "biz": RevenueCustomerFacts("biz", "Coco Dive", "Coco Dive", "business"),
    "ind": RevenueCustomerFacts("ind", "Bea", "", "individual"),
    "66407000001237340": RevenueCustomerFacts(
        "66407000001237340", "Client de passage", "Client de passage", "business"
    ),
}
CLINES = [
    line("2026-09-05", "pla", 1000, customer_id="biz"),
    line("2026-09-06", "print", 2000, customer_id="ind"),
    line("2026-09-07", "pla", 300, customer_id="66407000001237340"),
    line("2026-09-08", "pla", 50, customer_id=""),
    line("2026-09-09", "pla", 70, customer_id="ghost"),
]


def test_splits_each_bucket_by_segment_business_pro_individual_particulier_the_walk_in_account_passage_the_rest_non_identifie():
    [sep, *_] = series(lines=CLINES, customers=CUSTOMERS)
    assert sep["bySegment"] == {"pro": 1000, "particulier": 2000, "passage": 300, "inconnu": 120}


def test_the_segment_filter_keeps_one_segment_and_composes_with_kind():
    assert series(lines=CLINES, customers=CUSTOMERS, filters=LineFilters(segment="pro"))[0]["ht"] == 1000
    f = LineFilters(segment="particulier", kind="goods")
    assert series(lines=CLINES, customers=CUSTOMERS, filters=f)[0]["ht"] == 0
    rows = item_breakdown(CLINES, ITEMS, [], CUSTOMERS, LineFilters(segment="passage"))
    assert [r["ht"] for r in rows] == [300]


def test_margin_covers_only_the_lines_whose_item_has_a_unit_cost_credit_notes_included():
    costed = {
        **ITEMS,
        "pla": ScopeItem(
            "pla",
            "SUNLU PLA",
            brand="SUNLU",
            nature="Filaments",
            tax_percentage=16,
            unit_cost=400,
        ),
    }
    [sep, *_] = series(
        items=costed,
        lines=[
            line("2026-09-05", "pla", 1000, 2, "biz"),
            line("2026-09-06", "pla", -500, -1, "biz"),
            line("2026-09-07", "print", 2000, 1, "ind"),
        ],
    )
    assert sep["cost"] == 400
    assert sep["costedHt"] == 500
    rows = item_breakdown([line("2026-09-05", "pla", 1000, 2, "biz")], costed, [], None, LineFilters())
    assert [r["cost"] for r in rows] == [800]


def test_projects_a_partial_month_seasonal_from_last_years_shape_else_linear_never_for_a_complete_one():
    fetched = all_days("2025-10-01", "2026-10-15")
    ly = [line("2025-10-05", "pla", 1000), line("2025-10-25", "pla", 3000)]
    seasonal = series(fetched_days=fetched, from_="2026-10-01", lines=[*ly, line("2026-10-10", "pla", 500)])
    assert seasonal[-1]["partial"] is True
    assert seasonal[-1]["projectionMethod"] == "seasonal"
    assert seasonal[-1]["projection"]["ht"] == 2000
    linear = series(from_="2026-10-01", lines=[line("2026-10-10", "pla", 1500)])
    assert linear[-1]["projectionMethod"] == "linear"
    assert linear[-1]["projection"]["ht"] == js_round(1500 * 31 / 15)
    assert series(lines=[line("2026-09-10", "pla", 1000)])[0]["projection"] is None


def test_js_round_rounds_half_up_like_math_round():
    assert [js_round(x) for x in (2.5, -2.5, 0.5, -0.5, 1.4999, -1.6)] == [3, -2, 1, 0, 1, -2]


def test_ttc_of_unknown_rate_is_ht_and_flagged_approx():
    assert ttc_of(line("2026-09-01", "pla", 1000), ITEMS["pla"]) == (1160.0, False)
    assert ttc_of(line("2026-09-01", "pla", 1000), None) == (1000, True)


def test_is_filtered_and_seasonal_threshold():
    assert not is_filtered(LineFilters())
    assert is_filtered(LineFilters(item_ids=frozenset()))
    assert SEASONAL_MIN_SHARE == 0.1
    assert project_bucket((100, 100), 10, 30, (5, 5), (100, 100))[1] == "linear"


def test_matching_lines_yields_the_segment():
    out = list(matching_lines(CLINES, ITEMS, [], CUSTOMERS, LineFilters(segment="pro")))
    assert [(x.line.customer_id, x.segment) for x in out] == [("biz", "pro")]


def test_arabic_indic_digits_are_not_bucket_keys_or_days():
    assert not is_bucket_key("٢٠٢٦-١٠", "month")
    assert not is_bucket_key("٢٠٢٦", "year")
    assert not is_bucket_key("٢٠٢٦-W٤٢", "week")
    assert not is_valid_day("٢٠٢٦-١٠-١٥")


def test_print_costs_cost_the_services_from_the_first_logged_day_and_skip_sliced_views():
    prod = ProductionCosts(
        by_day={"2026-09-10": {"filament": 100.0, "labor": 200.0}, "2026-10-02": {"wear": 50.0}}, first_day="2026-09-10"
    )
    lines = [line("2026-09-05", "print", 1000), line("2026-09-20", "print", 2000), line("2026-10-03", "pla", 700)]
    sep, oct_ = series(lines=lines, production=prod)
    # The 09-05 sale predates the log, so only the 09-20 one counts as costed.
    has(sep, {"cost": 300, "costedHt": 2000, "costParts": {"items": 0, "filament": 100, "labor": 200}})
    has(oct_, {"cost": 50, "costedHt": 0})
    for f in (LineFilters(kind="goods"), LineFilters(brands=frozenset({"aito3d"})), LineFilters(segment="pro")):
        assert series(lines=lines, production=prod, filters=f)[0]["cost"] == 0
    assert series(lines=lines, production=prod, filters=LineFilters(kind="services"))[0]["cost"] == 300


def test_print_hours_sum_per_bucket_and_are_null_before_the_log():
    prod = ProductionCosts(
        by_day={"2026-09-10": {"wear": 1.0}},
        first_day="2026-09-10",
        hours_by_day={"2026-09-10": 1.5, "2026-09-20": 2.0, "2026-10-05": 0.5},
    )
    aug, sep, oct_ = series(
        lines=[line("2026-09-05", "print", 1000)], production=prod, from_="2026-08-01", to="2026-10-31"
    )
    assert (aug["printHours"], sep["printHours"], oct_["printHours"]) == (None, 3.5, 0.5)
    assert "printHours" not in series(lines=[line("2026-09-05", "print", 1000)])[0]


def test_margin_split_charges_zoho_costs_per_line_and_print_costs_pro_rata_of_service_ht():
    items = {
        **ITEMS,
        "pla": ScopeItem("pla", "SUNLU PLA", brand="SUNLU", nature="Filaments", unit_cost=300),
    }
    prod = ProductionCosts(
        by_day={"2026-09-10": {"wear": 600.0}, "2026-10-05": {"energy": 80.0}}, first_day="2026-09-01"
    )
    lines = [
        line("2026-09-03", "pla", 1000, 2),
        line("2026-09-20", "print", 2000, customer_id="c1"),
        line("2026-09-21", "print", 1000),
    ]
    customers = {"c1": RevenueCustomerFacts("c1", name="Acme", sub_type="business")}
    sep, oct_ = series(lines=lines, items=items, production=prod, customers=customers)
    sp = sep["marginSplit"]
    # PLA: 1000 − 2 × 300; prints: 3000 − 600, shared 2/3 – 1/3.
    assert sp["nature"] == {"Filaments": 400, "Sans nature": 2400}
    assert sp["kind"] == {"Biens": 400, "Services": 2400}
    assert sp["segment"] == {"inconnu": 400 + 800, "pro": 1600}
    assert sum(sp["brand"].values()) == sep["costedHt"] - sep["cost"]
    assert sep["costParts"] == {"items": 600, "wear": 600}
    # No service sold: the print cost lands on the unallocated keys.
    assert oct_["marginSplit"]["nature"] == {"Sans nature": -80}


def test_a_line_uses_its_frozen_cost_and_tax_rate_and_falls_back_to_the_items_current_ones_when_none():
    costed = {
        **ITEMS,
        "pla": ScopeItem(
            "pla",
            "SUNLU PLA",
            brand="SUNLU",
            nature="Filaments",
            tax_percentage=16,
            unit_cost=400,
        ),
    }
    frozen = RevenueLine("2026-09-05", "pla", "", "pla", "", 2, 1000, unit_cost=300, tax_percentage=13)
    cached_before = line("2026-09-06", "pla", 1000, 2)
    [sep, *_] = series(items=costed, lines=[frozen, cached_before])
    assert sep["cost"] == 600 + 800
    assert sep["ttc"] == 1130 + 1160
    [row] = item_breakdown([frozen, cached_before], costed, [], None, LineFilters())
    assert (row["cost"], row["ttc"]) == (1400, 2290)
    # The item lost its cost since: the frozen line still counts its own.
    [row] = item_breakdown([frozen], ITEMS, [], None, LineFilters())
    assert row["cost"] == 600


def test_previous_total_is_the_whole_previous_bucket_on_the_first_column_only():
    b = series(
        granularity="year",
        from_="2026-01-01",
        to="2026-10-15",
        lines=[line("2025-03-05", "pla", 700), line("2025-12-20", "pla", 300), line("2026-02-05", "pla", 900)],
        fetched_days=all_days("2025-01-01", "2026-10-15"),
    )
    assert b[0]["previousTotal"] == {"ht": 1000, "ttc": 1160}
    two = series(lines=[line("2026-08-10", "pla", 400)], fetched_days=all_days("2026-08-01", "2026-10-15"))
    assert two[0]["previousTotal"]["ht"] == 400
    assert two[1]["previousTotal"] is None


def test_fixed_costs_follow_the_goods_or_services_filter():
    prod = ProductionCosts(
        by_day={"2026-09-10": {"fixed": 900.0, "fixedEstimated": 90.0, "labor": 500.0}},
        first_day="2026-09-10",
        fixed_goods_by_day={"2026-09-10": {"fixed": 300.0, "fixedEstimated": 30.0}},
    )
    lines = [line("2026-09-20", "print", 2000), line("2026-09-21", "notax", 700)]
    parts = lambda f=None: series(lines=lines, production=prod, filters=f)[0]  # noqa: E731
    both = parts()
    assert both["costParts"] == {"items": 0, "fixed": 900, "fixedEstimated": 90, "labor": 500}
    assert both["cost"] == 1490
    # Named apart: the journal must not share it among the service lines.
    assert (both["fixedGoods"], parts(LineFilters(kind="services"))["fixedGoods"]) == (330, 0)
    # The goods' share of the fixed costs weighs on the goods, the rest on the services sold.
    assert both["marginSplit"]["kind"] == {"Biens": -330, "Services": 2000 - 1160}
    services = parts(LineFilters(kind="services"))
    assert services["costParts"] == {"items": 0, "fixed": 600, "fixedEstimated": 60, "labor": 500}
    assert services["cost"] == 1160
    goods = parts(LineFilters(kind="goods"))
    assert goods["costParts"] == {"items": 0, "fixed": 300, "fixedEstimated": 30}
    assert (goods["cost"], goods["costedHt"]) == (330, 0)
    assert "printHours" not in goods
    for f in (
        LineFilters(brands=frozenset({"aito3d"})),
        LineFilters(segment="pro"),
        LineFilters(kind="goods", segment="pro"),
    ):
        sliced = parts(f)
        assert sliced["cost"] == 0 and sliced["costParts"] == {"items": 0}
