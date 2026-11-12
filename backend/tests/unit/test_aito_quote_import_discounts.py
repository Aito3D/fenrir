"""Discounts on an imported quote: the card's total must equal the quote's, or
the import is refused. The two fixtures are synthetic (no captured estimate
carries a discount); their figures follow Books' own arithmetic for a
tax-inclusive quote at precision 0."""

import copy
import dataclasses

import pytest

from backend.app.services.aito_board_rules import summarise
from backend.app.services.aito_quote_export import ExportTask, build_line_items
from backend.app.services.aito_quote_import import build_preview, discount_issues, parse_lines
from backend.tests.unit.test_aito_quote_export import _SKU_FOR_ITEM, CATALOGUE
from backend.tests.unit.test_aito_quote_import import load_estimate


class _Row:
    def __init__(self, fields: dict):
        self.__dict__.update(
            {f"{s}_done": False for s in ("scan", "modelisation", "impression", "usinage", "maindoeuvre")}
        )
        self.__dict__.update(fields)


def _card_total(preview: dict) -> float:
    return summarise(_Row(task) for task in preview["tasks"]).total


def _export_tasks(preview: dict) -> list[ExportTask]:
    names = {f.name for f in dataclasses.fields(ExportTask)}
    return [ExportTask(material=None, **{k: v for k, v in task.items() if k in names}) for task in preview["tasks"]]


def _books_total(lines: list[dict]) -> float:
    """What Books totals a tax-inclusive payload at: each line less its percent."""
    total = 0.0
    for line in lines:
        if "rate" in line:
            pct = float(line.get("discount", "0%").rstrip("%"))
            total += round(line["rate"] * line["quantity"] * (1 - pct / 100))
    return total


def test_flat_line_discounts_import_at_the_quote_total():
    estimate = load_estimate("dev-2480-line-discounts")
    preview = build_preview(estimate, None, "https://x")
    assert preview["discount_issues"] == []
    (task,) = preview["tasks"]
    # 500 off 5 000 is exactly 10%: cost stays pre-discount, the percent carries it.
    assert (task["modelisation_cost"], task["modelisation_discount_pct"]) == (5000, 10)
    assert (task["impression_cost"], task["impression_discount_pct"]) == (2400, 10)
    # Labour has no discount column: the flat 1 500 is baked into the cost.
    assert task["maindoeuvre_cost"] == 4500
    assert _card_total(preview) == pytest.approx(estimate["total"])


def test_flat_line_discounts_round_trip_to_the_same_books_total():
    estimate = load_estimate("dev-2480-line-discounts")
    preview = build_preview(estimate, None, "https://x")
    pushed = build_line_items(_export_tasks(preview), estimate["line_items"], CATALOGUE)
    assert _books_total(pushed) == estimate["total"]
    # And what was pushed reads back as the same tasks.
    again = build_preview(
        {**estimate, "line_items": [{**line, "sku": _SKU_FOR_ITEM.get(line.get("item_id"), "")} for line in pushed]},
        None,
        "https://x",
    )
    assert again["tasks"] == preview["tasks"]
    assert again["discount_issues"] == []


def test_a_flat_discount_the_total_does_not_confirm_is_refused():
    """Same quote, but Books' total says the flat amount meant something else
    (here: taken before tax). Nothing is adopted and the lines are reported."""
    estimate = load_estimate("dev-2480-line-discounts")
    estimate["total"] = 10900
    preview = build_preview(estimate, None, "https://x")
    assert [(i["scope"], i["sku"], i["discount"]) for i in preview["discount_issues"]] == [
        ("line", "P3DMOD", "500"),
        ("line", "PM-CM-D", "1500"),
    ]
    task = preview["tasks"][0]
    assert task["modelisation_discount_pct"] is None
    assert task["maindoeuvre_cost"] == 6000


def test_a_flat_discount_without_a_total_is_refused():
    estimate = load_estimate("dev-2480-line-discounts")
    del estimate["total"]
    assert len(discount_issues(estimate)) == 2


def test_a_flat_discount_that_is_not_an_exact_percent_is_refused():
    """150 off 1 600 is 9.375%: two decimals cannot say it, so it is not rounded."""
    estimate = {
        "is_inclusive_tax": True,
        "price_precision": 0,
        "total": 1450,
        "line_items": [
            {"item_order": 1, "sku": "P3DIMP", "name": "Impression3D", "rate": 1600, "quantity": 1, "discount": 150}
        ],
    }
    (line,), _, _ = parse_lines(estimate)
    assert line.discount_pct is None
    assert [i["scope"] for i in discount_issues(estimate)] == ["line"]


def test_a_flat_discount_on_a_tax_exclusive_quote_needs_the_total_too():
    """Tax-exclusive: the cost is `item_total` + tax as before. Accepted only
    when that sum is the quote's total, i.e. `item_total` is already net."""
    line = {
        "item_order": 1,
        "sku": "P3DMOD",
        "name": "Modelisation3D",
        "rate": 4000,
        "quantity": 1,
        "discount": 400,
        "item_total": 3600,
        "line_item_taxes": [{"tax_amount": 468}],
    }
    estimate = {"is_inclusive_tax": False, "price_precision": 0, "total": 4068, "line_items": [line]}
    assert discount_issues(estimate) == []
    preview = build_preview(estimate, None, "https://x")
    assert preview["tasks"][0]["modelisation_cost"] == 4068
    assert preview["tasks"][0]["modelisation_discount_pct"] is None
    assert len(discount_issues({**estimate, "total": 4520})) == 1


def test_a_whole_quote_discount_is_refused_and_the_tasks_stay_pre_discount():
    estimate = load_estimate("dev-2481-quote-discount")
    preview = build_preview(estimate, None, "https://x")
    assert preview["discount_issues"] == [{"scope": "quote", "sku": "", "name": "", "discount": "10%"}]
    assert preview["quote"]["total"] == 6660
    assert _card_total(preview) == 7400


@pytest.mark.parametrize(
    ("fields", "label"),
    [
        ({"discount": "10.00%", "discount_type": "entity_level", "is_discount_before_tax": False}, "10%"),
        ({"discount": 740, "discount_type": "entity_level", "is_discount_before_tax": True}, "740"),
        ({"discount": "740", "is_discount_before_tax": False}, "740"),
        ({"discount": 0, "discount_type": "entity_level"}, None),
        ({"discount": "0.00%", "discount_type": "entity_level"}, None),
        # An item-level quote's own `discount` is not a whole-quote discount.
        ({"discount": 740, "discount_type": "item_level"}, None),
    ],
)
def test_whole_quote_discount_detection(fields, label):
    estimate = {**load_estimate("dev-2481-quote-discount"), **fields}
    quote_issues = [i["discount"] for i in discount_issues(estimate) if i["scope"] == "quote"]
    assert quote_issues == ([label] if label else [])


def test_a_discount_on_our_shipping_line_is_refused_and_a_foreign_one_is_not():
    estimate = copy.deepcopy(load_estimate("dev-2463-retail"))
    estimate["line_items"][0]["discount"] = 500  # PB05016, a retail item: echoed untouched
    assert discount_issues(estimate) == []
    shipping = load_estimate("dev-2472-shipping-only")
    shipping["line_items"][0]["discount"] = "10.00%"
    item_id = shipping["line_items"][0]["item_id"]
    assert [i["scope"] for i in discount_issues(shipping, {"standard": item_id})] == ["line"]


def test_existing_fixtures_carry_no_discount_issue():
    for name in (
        "dev-2448-vente",
        "dev-2461-three-services",
        "dev-2462-two-tasks",
        "dev-2466-messy",
        "dev-2470-headers",
    ):
        assert discount_issues(load_estimate(name)) == [], name
