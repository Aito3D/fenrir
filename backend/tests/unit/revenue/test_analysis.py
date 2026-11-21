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


def pv(item_id, quantity, ht):
    return row(item_id, ht, quantity=quantity)


def _pvm(cur, prev, **kw):
    from backend.app.services.revenue.analysis import price_volume_mix

    return price_volume_mix(cur, prev, **kw)


def _parts(r):
    return {k: r[k] for k in ("previous", "volume", "mix", "price", "new", "lost", "current")}


def test_pvm_a_price_rise_alone_is_a_price_effect():
    r = _pvm([pv("a", 10, 1200)], [pv("a", 10, 1000)])
    assert _parts(r) == {"previous": 1000, "volume": 0, "mix": 0, "price": 200, "new": 0, "lost": 0, "current": 1200}


def test_pvm_more_units_at_the_same_price_is_a_volume_effect():
    r = _pvm([pv("a", 15, 1500)], [pv("a", 10, 1000)])
    assert _parts(r) == {"previous": 1000, "volume": 500, "mix": 0, "price": 0, "new": 0, "lost": 0, "current": 1500}


def test_pvm_the_same_units_moved_to_a_dearer_item_is_a_mix_effect():
    r = _pvm([pv("a", 5, 500), pv("b", 15, 3000)], [pv("a", 10, 1000), pv("b", 10, 2000)])
    assert _parts(r) == {"previous": 3000, "volume": 0, "mix": 500, "price": 0, "new": 0, "lost": 0, "current": 3500}


def test_pvm_items_sold_in_one_period_only_are_new_or_lost():
    r = _pvm([pv("a", 10, 1000), pv("c", 3, 300)], [pv("a", 10, 1000), pv("d", 4, 400)])
    assert (r["new"], r["lost"]) == (300, -400)
    assert {(i["name"], i["kind"], i["effect"]) for i in r["items"]} == {("c", "new", 300), ("d", "lost", -400)}


def test_pvm_a_line_without_quantity_counts_as_new_and_lost_not_as_a_price():
    # A credit note this period (no quantity) against a real sale before.
    r = _pvm([pv("e", 0, -50)], [pv("e", 2, 80)])
    assert _parts(r) == {"previous": 80, "volume": 0, "mix": 0, "price": 0, "new": -50, "lost": -80, "current": -50}


def test_pvm_items_are_ranked_by_the_size_of_their_effect_and_capped():
    cur = [pv("a", 10, 1100), pv("b", 10, 3000), pv("c", 1, 10)]
    prev = [pv("a", 10, 1000), pv("b", 10, 1000), pv("d", 1, 500)]
    r = _pvm(cur, prev, shown=2)
    assert [(i["name"], i["effect"], i["volume"], i["price"]) for i in r["items"]] == [
        ("b", 2000, 0, 2000),
        ("d", -500, 0, 0),
    ]


def test_pvm_parts_always_sum_to_the_change():
    from hypothesis import given, strategies as st

    rows = st.lists(
        st.tuples(st.sampled_from("abcdef"), st.integers(-5, 50), st.integers(-100_000, 1_000_000)),
        max_size=6,
        unique_by=lambda t: t[0],
    )

    @given(rows, rows)
    def check(cur, prev):
        r = _pvm([pv(*x) for x in cur], [pv(*x) for x in prev])
        assert r["previous"] + r["volume"] + r["mix"] + r["price"] + r["new"] + r["lost"] == r["current"]
        assert r["current"] == sum(x[2] for x in cur) and r["previous"] == sum(x[2] for x in prev)

    check()
