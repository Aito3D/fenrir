"""Edges of the import translator: degenerate estimates, Books-shaped header
payloads, hostile SKUs, discount string corners, tax arithmetic, precision,
and fractional quantities.

Pure functions only, driven from captured-shape fixtures and inline builders
(mirrors test_aito_quote_import.py).
"""

import json
from pathlib import Path

import pytest

from backend.app.services.aito_quote_import import build_preview, group_lines, parse_lines

_FIXTURES = Path(__file__).parent.parent / "fixtures" / "zoho_estimates"


def load_estimate(name: str) -> dict:
    return json.loads((_FIXTURES / f"{name}.json").read_text())


def _line(**overrides) -> dict:
    fields = {
        "line_item_id": "L1",
        "item_order": 1,
        "item_id": "ITEM-X",
        "sku": "P3DIMP",
        "name": "Impression3D",
        "description": "",
        "quantity": 1,
        "rate": 1000,
        "item_total": 885,
        "line_item_taxes": [{"tax_amount": 115}],
    }
    fields.update(overrides)
    return fields


def _estimate(lines: list[dict], **overrides) -> dict:
    estimate = {
        "estimate_id": "E1",
        "estimate_number": "DEV26-9000",
        "is_inclusive_tax": True,
        "price_precision": 0,
        "line_items": lines,
    }
    estimate.update(overrides)
    return estimate


# ---------------------------------------------------------------------------
# Degenerate estimates
# ---------------------------------------------------------------------------


def test_empty_estimate_previews_to_zero_tasks_and_the_number_as_description():
    estimate = load_estimate("dev-2471-empty")
    preview = build_preview(estimate, None, "https://books.example/E")
    assert preview["tasks"] == []
    assert preview["skipped_lines"] == []
    assert preview["shipping"] is None
    assert preview["suggested_description"] == "DEV26-2471"
    assert preview["quote"]["total"] == 0.0


def test_estimate_with_no_line_items_key_at_all_parses_to_nothing():
    estimate = _estimate([])
    del estimate["line_items"]
    assert parse_lines(estimate) == ([], [], None)


def test_shipping_only_estimate_with_a_warm_catalogue_yields_no_tasks_and_a_shipment():
    estimate = load_estimate("dev-2472-shipping-only")
    shipping_ids = {"tuamotu": "66407000007000101"}
    preview = build_preview(estimate, None, "https://books.example/E", shipping_ids)
    assert preview["tasks"] == []
    assert preview["skipped_lines"] == []
    shipping = preview["shipping"]
    assert shipping == {
        "island": "rangiroa",
        "service": "tuamotu",
        "first_name": "Moana",
        "last_name": "TEMARII",
        "phone": "+689-87112233",
        "price": 3200.0,
    }
    # The suggested description degrades to the estimate number: no task titles exist.
    assert preview["suggested_description"] == "DEV26-2472"


def test_shipping_only_estimate_with_a_cold_catalogue_reports_the_line_as_skipped():
    """The documented cold-cache consequence: with no ids to own the line by,
    it falls through to the SKU check and surfaces to the operator."""
    estimate = load_estimate("dev-2472-shipping-only")
    recognised, skipped, shipping = parse_lines(estimate, {})
    assert recognised == []
    assert shipping is None
    assert skipped == [{"sku": "", "name": "Livraison Avion Tuamotu", "amount": 3200.0}]


def test_sixty_line_estimate_groups_into_twenty_tasks():
    lines = []
    for part in range(20):
        for offset, (sku, rate) in enumerate([("P3DSCAN", 1000), ("P3DMOD", 2000), ("P3DIMP", 3000)]):
            lines.append(
                _line(
                    line_item_id=f"L{part}-{offset}",
                    item_order=part * 3 + offset + 1,
                    sku=sku,
                    rate=rate,
                )
            )
    preview = build_preview(_estimate(lines), None, "")
    assert len(preview["tasks"]) == 20
    for task in preview["tasks"]:
        assert (task["scan_cost"], task["modelisation_cost"], task["impression_cost"]) == (1000, 2000, 3000)


# ---------------------------------------------------------------------------
# Books-shaped headers (real header_name + header_id payload)
# ---------------------------------------------------------------------------


def test_books_shaped_headers_split_tasks_even_across_rising_ranks():
    """scan(0) -> impression(2) -> usinage(3) rises the whole way, so the rank
    heuristic alone would read ONE task; the header_id change is what splits
    Hélice bâbord from Hélice tribord."""
    estimate = load_estimate("dev-2470-headers")
    preview = build_preview(estimate, None, "https://books.example/E")
    assert [task["title"] for task in preview["tasks"]] == ["Hélice bâbord", "Hélice tribord"]
    first, second = preview["tasks"]
    assert first["scan_cost"] == 3500
    assert first["impression_cost"] == 12000
    assert first["impression_weight_g"] == 210
    assert first["impression_time_min"] == 780
    assert first["impression_color"] == "Noir"
    # Matériau is NOT one of the consumed impression labels (the material is
    # resolved from the filament on export), so it must be preserved verbatim
    # in the service's description.
    assert first["impression_description"] == "Matériau: ASA"
    assert first["scan_description"] == "Numérisation de l'hélice d'origine."
    assert second["usinage_cost"] == 12000
    assert second["usinage_description"] == "Reprise du moyeu au tour."


def test_headerless_version_of_the_same_lines_reads_as_one_task():
    """The control for the test above: strip the headers and the rising rank
    merges everything into a single task."""
    estimate = load_estimate("dev-2470-headers")
    for line in estimate["line_items"]:
        del line["header_id"]
        del line["header_name"]
    recognised, _, _ = parse_lines(estimate)
    assert len(group_lines(recognised)) == 1


# ---------------------------------------------------------------------------
# Hostile SKUs
# ---------------------------------------------------------------------------


def test_laser_and_retail_lines_are_skipped_beside_a_recognised_service():
    lines = [
        _line(item_order=1, sku="P3DIMP", rate=8000),
        _line(line_item_id="L2", item_order=2, sku="L3DIMP", name="Découpe laser", rate=1500),
        _line(line_item_id="L3", item_order=3, sku="PB05016", name="Bobine PETG", rate=4900),
    ]
    preview = build_preview(_estimate(lines), None, "")
    assert len(preview["tasks"]) == 1
    assert preview["tasks"][0]["impression_cost"] == 8000
    assert [(row["sku"], row["amount"]) for row in preview["skipped_lines"]] == [
        ("L3DIMP", 1500.0),
        ("PB05016", 4900.0),
    ]


def test_legacy_p3d2024_sku_is_skipped_not_guessed():
    _, skipped, _ = parse_lines(_estimate([_line(sku="P3D2024", name="Prestation 2024")]))
    assert skipped == [{"sku": "P3D2024", "name": "Prestation 2024", "amount": 1000.0}]


def test_missing_and_empty_skus_are_skipped_with_an_empty_sku_field():
    no_sku = _line(line_item_id="L1", item_order=1, name="Ligne libre")
    del no_sku["sku"]
    _, skipped, _ = parse_lines(_estimate([no_sku, _line(line_item_id="L2", item_order=2, sku="  ", name="Blanche")]))
    assert [row["sku"] for row in skipped] == ["", "  "]


def test_unknown_item_id_with_an_aito_sku_still_imports():
    """Import ownership is SKU-driven: the item id plays no part here (the id
    check lives on the export side's is_foreign)."""
    recognised, skipped, _ = parse_lines(_estimate([_line(item_id="TOTALLY-UNKNOWN", sku="P3DSCAN", rate=3500)]))
    assert skipped == []
    assert len(recognised) == 1
    assert recognised[0].service == "scan"


# ---------------------------------------------------------------------------
# Discount string corners
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("10.50%", 10.5),
        ("100.00%", 100.0),
        (" 15% ", 15.0),
        ("150%", None),  # out of range
        ("-5%", None),  # negative
        ("0%", None),  # would print a pointless 0% column
        ("0.00%", None),
        ("abc%", None),  # unparseable
        ("", None),
        ("500", None),  # flat amount as a string
        (500, None),  # flat amount as a number
        (None, None),
    ],
)
def test_discount_pct_adoption_matrix(raw, expected):
    recognised, _, _ = parse_lines(_estimate([_line(discount=raw)]))
    assert recognised[0].discount_pct == expected


def test_discount_on_a_non_impression_line_is_parsed_but_never_adopted_by_the_task():
    """ParsedLine carries it, but _build_task only adopts the impression
    line's — a scan discount has no field to live in."""
    lines = [
        _line(item_order=1, sku="P3DSCAN", discount="10.00%"),
        _line(line_item_id="L2", item_order=2, sku="P3DIMP", rate=5000),
    ]
    preview = build_preview(_estimate(lines), None, "")
    assert preview["tasks"][0]["impression_discount_pct"] is None


def test_discount_on_the_shipping_line_does_not_disturb_the_parse():
    estimate = load_estimate("dev-2472-shipping-only")
    estimate["line_items"][0]["discount"] = "10.00%"
    _, _, shipping = parse_lines(estimate, {"tuamotu": "66407000007000101"})
    assert shipping is not None
    assert shipping.price == 3200.0  # the raw rate; ParsedShipping has no discount concept


# ---------------------------------------------------------------------------
# Tax arithmetic and precision
# ---------------------------------------------------------------------------


def test_exclusive_line_sums_every_tax_entry():
    line = _line(item_total=1000, line_item_taxes=[{"tax_amount": 60}, {"tax_amount": 40}])
    recognised, _, _ = parse_lines(_estimate([line], is_inclusive_tax=False))
    assert recognised[0].amount == 1100.0


def test_exclusive_line_with_no_taxes_key_is_just_the_item_total():
    line = _line(item_total=1000)
    del line["line_item_taxes"]
    recognised, _, _ = parse_lines(_estimate([line], is_inclusive_tax=False))
    assert recognised[0].amount == 1000.0


def test_tax_entry_without_a_tax_amount_counts_as_zero():
    line = _line(item_total=1000, line_item_taxes=[{}, {"tax_amount": 50}])
    recognised, _, _ = parse_lines(_estimate([line], is_inclusive_tax=False))
    assert recognised[0].amount == 1050.0


def test_price_precision_decides_the_rounding_of_the_same_line():
    line = _line(rate=3.33, quantity=3)
    at_two, _, _ = parse_lines(_estimate([line], price_precision=2))
    at_zero, _, _ = parse_lines(_estimate([line], price_precision=0))
    assert at_two[0].amount == 9.99
    assert at_zero[0].amount == 10.0


def test_negative_amount_clamps_to_zero():
    """A discount typed as a negative service line must not 422 the import."""
    recognised, _, _ = parse_lines(_estimate([_line(rate=-50)]))
    assert recognised[0].amount == 0.0


# ---------------------------------------------------------------------------
# Fractional quantities
# ---------------------------------------------------------------------------


def test_fractional_quantity_bills_fully_but_rounds_the_task_quantity():
    preview = build_preview(_estimate([_line(rate=1000, quantity=1.5)]), None, "")
    task = preview["tasks"][0]
    assert task["impression_cost"] == 1500.0  # rate x the real 1.5
    assert task["impression_quantity"] == 2  # round(1.5) -> 2 (banker's, to even)


def test_tiny_fractional_quantity_clamps_to_one():
    preview = build_preview(_estimate([_line(rate=1000, quantity=0.4)]), None, "")
    assert preview["tasks"][0]["impression_quantity"] == 1
