from backend.app.services.revenue.analysis import abc_analysis, dormant_items, dormant_ranges, margin_by


def row(item_id, ht, **over):
    return {
        "itemId": item_id,
        "name": item_id,
        "sku": "",
        "quantity": 1,
        "ht": ht,
        "ttc": ht,
        "cost": None,
        "nature": None,
        "brand": None,
        "kind": "goods",
        "reason": "nature",
        **over,
    }


def test_classes_the_item_crossing_80_percent_as_a_the_next_up_to_95_percent_as_b_the_tail_as_c_and_skips_refunds():
    r = abc_analysis([row("a", 70), row("b", 20), row("c", 6), row("d", 4), row("z", -5)], 200)
    assert r["total"] == 100
    assert [[x["itemId"], x["cls"]] for x in r["rows"]] == [["a", "A"], ["b", "A"], ["c", "B"], ["d", "C"]]
    assert r["classes"] == {"A": {"count": 2, "ht": 90}, "B": {"count": 1, "ht": 6}, "C": {"count": 1, "ht": 4}}
    assert abs(r["rows"][1]["cumShare"] - 0.9) < 1e-9


def test_sums_margin_over_the_costed_items_only_and_reports_the_coverage():
    rows = margin_by(
        [row("a", 100, brand="SUNLU", cost=60), row("b", 100, brand="SUNLU"), row("c", 50, brand=None, cost=10)],
        "brand",
    )
    assert rows == [
        # Equal margins: the heavier HT first.
        {"key": "SUNLU", "ht": 200, "costedHt": 100, "cost": 60, "margin": 40, "rate": 0.4, "coverage": 0.5},
        {"key": "Sans marque", "ht": 50, "costedHt": 50, "cost": 10, "margin": 40, "rate": 0.8, "coverage": 1},
    ]


def test_lists_former_sellers_with_no_sale_in_the_recent_window_best_first():
    out = dormant_items(
        [row("a", 50), row("b", 300), row("c", 100), row("r", -10)], [row("c", 5)], {"b": "2026-06-02"}, 50
    )
    assert [[x["itemId"], x["lastDay"]] for x in out] == [["b", "2026-06-02"], ["a", ""]]


def test_splits_the_year_into_the_lookback_and_the_last_90_days():
    assert dormant_ranges("2026-11-17") == {
        "before": {"from": "2025-11-17", "to": "2026-08-18"},
        "recent": {"from": "2026-08-19", "to": "2026-11-17"},
    }


def test_an_item_costed_on_part_of_its_lines_counts_only_that_part_as_costed():
    rows = margin_by([row("a", 100, brand="SUNLU", cost=30, costedHt=40)], "brand")

    assert rows == [
        {"key": "SUNLU", "ht": 100, "costedHt": 40, "cost": 30, "margin": 10, "rate": 0.25, "coverage": 0.4}
    ]
