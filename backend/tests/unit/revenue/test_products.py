import pytest

from backend.app.services.revenue.config import REVENUE_SERVICE_ACCOUNT_ID as ACC
from backend.app.services.revenue.products import (
    BRANDS_PARAM_ERROR,
    ITEMS_PARAM_ERROR,
    KIND_PARAM_ERROR,
    SEGMENT_PARAM_ERROR,
    FilterError,
    build_product_list,
    parse_brands,
    parse_item_ids,
    parse_series_filters,
)
from backend.app.services.revenue.scope import ITEM_ID_RE, RevenueDecision, ScopeItem
from backend.app.services.revenue.series import LineFilters


def sitem(item_id, name, brand, nature, account_id, tax):
    return ScopeItem(item_id=item_id, name=name, brand=brand, nature=nature, account_id=account_id, tax_percentage=tax)


ITEMS = {
    "mini": sitem("mini", "Starlink - Support Mini", "Aito3D", None, ACC, 13),
    "v3": sitem("v3", "Starlink - Support v3&4", "Aito3D", None, ACC, 13),
    "hobie": sitem("hobie", "Hobie T1", "Hobie", "Hobie Sailing", None, 16),
    "snap": sitem("snap", "Snap Maker", None, None, None, 16),
}


def total(item_id, name, total_ht, sku=""):
    return {"itemId": item_id, "name": name, "sku": sku, "totalHt": total_ht, "quantity": 1, "lastDay": "2026-10-01"}


def dec(item_id, included):
    return RevenueDecision(item_id, included, "2026-10-15T00:00:00.000Z")


def test_lists_the_in_scope_products_sold_heaviest_first_with_the_substrates_name_and_the_caches_sku():
    rows = build_product_list(
        [
            total("mini", "Starlink Mini (old name)", 11504, "STL-MINI"),
            total("v3", "Starlink - Support v3&4", 39822),
            total("hobie", "Hobie T1", 5_000_000),
        ],
        ITEMS,
        [],
    )
    assert rows == [
        {"itemId": "v3", "name": "Starlink - Support v3&4", "sku": "", "brand": "Aito3D", "kind": "service",
         "totalHt": 39822, "quantity": 1, "lastDay": "2026-10-01"},
        {"itemId": "mini", "name": "Starlink - Support Mini", "sku": "STL-MINI", "brand": "Aito3D", "kind": "service",
         "totalHt": 11504, "quantity": 1, "lastDay": "2026-10-01"},
    ]  # fmt: skip


def test_a_decision_wins_both_ways_an_included_unclassified_item_appears_an_excluded_in_scope_one_does_not():
    rows = build_product_list(
        [total("snap", "Snap Maker", 596983), total("v3", "Starlink - Support v3&4", 39822)],
        ITEMS,
        [dec("snap", True), dec("v3", False)],
    )
    assert [p["itemId"] for p in rows] == ["snap"]
    assert rows[0]["brand"] is None


def test_ranks_by_absolute_total_so_a_credit_heavy_product_is_not_buried():
    rows = build_product_list(
        [total("mini", "Starlink - Support Mini", 100), total("v3", "Starlink - Support v3&4", -5000)], ITEMS, []
    )
    assert [p["itemId"] for p in rows] == ["v3", "mini"]


def test_splits_a_comma_list_trims_dedupes_and_refuses_a_malformed_id():
    assert parse_item_ids("a, b,a,,c") == {"a", "b", "c"}
    assert parse_item_ids("") is None
    assert parse_item_ids(None) is None
    for bad in ("ok,bad id", "x" * 65, "ab\nc"):
        with pytest.raises(FilterError, match=ITEMS_PARAM_ERROR):
            parse_item_ids(bad)


def test_item_id_re_rejects_a_trailing_newline():
    assert ITEM_ID_RE.fullmatch("abc")
    assert not ITEM_ID_RE.fullmatch("abc\n")
    assert not ITEM_ID_RE.match("abc\n")


def test_folds_each_repeated_value_drops_blanks_and_dedupes():
    assert parse_brands(["Bambu Lab", " esun ", "", "ESUN"]) == {"bambu lab", "esun"}


def test_is_null_when_absent_or_all_blank_no_filter():
    assert parse_brands([]) is None
    assert parse_brands(["", "  "]) is None


def test_is_malformed_on_a_name_over_64_characters_or_more_than_50_names():
    with pytest.raises(FilterError, match=BRANDS_PARAM_ERROR):
        parse_brands(["x" * 65])
    with pytest.raises(FilterError, match=BRANDS_PARAM_ERROR):
        parse_brands([f"b{i}" for i in range(51)])


def err(*args):
    with pytest.raises(FilterError) as e:
        parse_series_filters(*args)
    return e.value.message


def test_pins_the_exact_422_messages():
    assert BRANDS_PARAM_ERROR == "brand must be repeated names of at most 64 characters, 50 at most"
    assert ITEMS_PARAM_ERROR == "items must be a comma-separated list of item ids"
    assert KIND_PARAM_ERROR == "kind must be goods or services"
    assert SEGMENT_PARAM_ERROR == "segment must be one of pro, particulier, passage, inconnu"


def test_returns_both_parsed_sets_null_when_absent():
    assert parse_series_filters(None, [], None, None) == LineFilters()
    assert parse_series_filters("123", ["ESUN"], None, None) == LineFilters(
        item_ids=frozenset({"123"}), brands=frozenset({"esun"})
    )


def test_reads_kind_goods_services_an_empty_kind_as_no_filter_anything_else_as_a_422():
    assert parse_series_filters(None, [], "goods", None) == LineFilters(kind="goods")
    assert parse_series_filters(None, [], "services", None) == LineFilters(kind="services")
    assert parse_series_filters(None, [], "", None) == LineFilters()
    assert err(None, [], "biens", None) == KIND_PARAM_ERROR
    assert err(None, ["x" * 65], "biens", None) == BRANDS_PARAM_ERROR


def test_reads_segment_refusing_anything_but_a_customer_segment_after_kind():
    assert parse_series_filters(None, [], None, "pro") == LineFilters(segment="pro")
    assert err(None, [], None, "vip") == SEGMENT_PARAM_ERROR
    assert err(None, [], "x", "vip") == KIND_PARAM_ERROR
    assert parse_series_filters(None, ["SUNLU"], "goods", "passage") == LineFilters(
        brands=frozenset({"sunlu"}), kind="goods", segment="passage"
    )


def test_refuses_items_first_then_brands():
    assert err("bad id", ["x" * 65], None, None) == ITEMS_PARAM_ERROR
    assert err(None, ["x" * 65], None, None) == BRANDS_PARAM_ERROR
