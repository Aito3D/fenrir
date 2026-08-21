"""Edges of the export translator the main suite leaves untested: the
``is_foreign`` ownership matrix, vente round-tripping, the impression
rate/quantity arithmetic at its corners, discount string emission, and the
shipping-echo behaviour when a real shipment displaces a hand-typed line.

Pure functions only — no DB, no HTTP (mirrors test_aito_quote_export.py).
"""

from backend.app.services.aito_quote_export import (
    Catalogue,
    ExportShipping,
    ExportTask,
    build_line_items,
    is_foreign,
    rate_quantity,
)
from backend.app.services.aito_quote_import import build_preview

CATALOGUE = Catalogue(
    scan_item_id="ITEM-SCAN",
    modelisation_item_id="ITEM-MOD",
    impression_item_id="ITEM-IMP",
    usinage_item_id="ITEM-USI",
    tax_id="TAX-1",
    shipping={"tuamotu": "ITEM-SHIP-T", "marquises": "ITEM-SHIP-M"},
)


def _task(**overrides) -> ExportTask:
    fields = {
        "title": "Piece",
        "scan_cost": None,
        "modelisation_cost": None,
        "usinage_cost": None,
        "impression_cost": None,
        "impression_quantity": None,
        "impression_weight_g": None,
        "impression_time_min": None,
        "impression_color": None,
        "material": None,
    }
    fields.update(overrides)
    return ExportTask(**fields)


# ---------------------------------------------------------------------------
# is_foreign: the full ownership matrix
# ---------------------------------------------------------------------------


def test_header_row_is_never_foreign_even_with_unknown_item_and_sku():
    line = {"line_item_category": "header", "item_id": "MYSTERY", "sku": "L3DIMP-01"}
    assert is_foreign(line, CATALOGUE) is False


def test_our_item_id_with_a_foreign_sku_is_ours():
    """The documented catalogue-override case: a zoho_item_*_id setting may
    point at a Books item whose SKU has no Aito prefix. The id check must win,
    or our own echoed line would duplicate on every push."""
    line = {"item_id": "ITEM-IMP", "sku": "CUSTOM-2026"}
    assert is_foreign(line, CATALOGUE) is False


def test_unknown_item_id_with_an_aito_sku_prefix_is_ours():
    """The other half of the disagreement: the SKU alone claims the line."""
    line = {"item_id": "SOMETHING-ELSE", "sku": "P3DIMP-XL"}
    assert is_foreign(line, CATALOGUE) is False


def test_shipping_item_ids_are_ours():
    assert is_foreign({"item_id": "ITEM-SHIP-T", "sku": ""}, CATALOGUE) is False
    assert is_foreign({"item_id": "ITEM-SHIP-M", "sku": None}, CATALOGUE) is False


def test_laser_and_legacy_skus_are_foreign():
    """L3DIMP (laser) and P3D2024 (legacy generic) deliberately map to no
    service; with an unknown item id the lines are foreign and get preserved
    by line_item_id, never re-emitted."""
    assert is_foreign({"item_id": "ITEM-LASER", "sku": "L3DIMP-05"}, CATALOGUE) is True
    assert is_foreign({"item_id": "ITEM-2024", "sku": "P3D2024"}, CATALOGUE) is True


def test_unknown_item_with_missing_or_empty_sku_is_foreign():
    assert is_foreign({"item_id": "ITEM-RETAIL"}, CATALOGUE) is True
    assert is_foreign({"item_id": "ITEM-RETAIL", "sku": ""}, CATALOGUE) is True
    assert is_foreign({"item_id": "ITEM-RETAIL", "sku": "   "}, CATALOGUE) is True


# ---------------------------------------------------------------------------
# Vente: U3DIMP-VENTE round-trips out as a usinage line
# ---------------------------------------------------------------------------


def test_vente_line_imports_as_usinage_and_exports_on_the_usinage_item():
    estimate = {
        "estimate_id": "E1",
        "estimate_number": "DEV26-1",
        "is_inclusive_tax": True,
        "line_items": [
            {
                "line_item_id": "L1",
                "item_id": "ITEM-VENTE",
                "sku": "U3DIMP-VENTE",
                "name": "Vente pièce",
                "rate": 12000,
                "quantity": 1,
                "item_order": 1,
                "description": "Usinage: Support moteur",
            }
        ],
    }
    preview = build_preview(estimate, None, "https://books.example/E1")
    assert len(preview["tasks"]) == 1
    task = preview["tasks"][0]
    assert task["usinage_cost"] == 12000
    assert task["title"] == "Support moteur"

    exported = build_line_items([_task(title=task["title"], usinage_cost=task["usinage_cost"])], [], CATALOGUE)
    assert len(exported) == 1
    assert exported[0]["item_id"] == "ITEM-USI"
    assert exported[0]["rate"] == 12000


# ---------------------------------------------------------------------------
# impression_rate_quantity at its corners
# ---------------------------------------------------------------------------


def test_quantity_zero_none_and_negative_all_clamp_to_one():
    assert rate_quantity(_task(impression_cost=900, impression_quantity=0), "impression") == (900, 1)
    assert rate_quantity(_task(impression_cost=900, impression_quantity=None), "impression") == (900, 1)
    assert rate_quantity(_task(impression_cost=900, impression_quantity=-3), "impression") == (900, 1)


def test_missing_cost_yields_rate_zero():
    assert rate_quantity(_task(impression_cost=None, impression_quantity=4), "impression") == (0, 4)


def test_an_out_of_contract_float_quantity_truncates():
    """ExportTask types the quantity int | None, but a float that sneaks past
    the contract is truncated by int(), not rounded — 1.9 bills as 1 unit."""
    assert rate_quantity(_task(impression_cost=1000, impression_quantity=1.9), "impression") == (1000, 1)


def test_non_dividing_total_rounds_the_per_unit_rate():
    """1000 over 3 units: the rate is the rounded per-unit figure; the
    achievable total (999) is what the caller writes back to the task."""
    rate, quantity = rate_quantity(_task(impression_cost=1000, impression_quantity=3), "impression")
    assert (rate, quantity) == (333, 3)
    assert rate * quantity == 999


def test_halfway_rates_use_bankers_rounding():
    """Python's round() at .5 goes to the even neighbour — pinned so nobody
    'fixes' it to always-up and silently changes real quotes by 1 XPF/unit."""
    assert rate_quantity(_task(impression_cost=250, impression_quantity=100), "impression")[0] == 2  # 2.5 -> 2
    assert rate_quantity(_task(impression_cost=350, impression_quantity=100), "impression")[0] == 4  # 3.5 -> 4


# ---------------------------------------------------------------------------
# Discount string emission
# ---------------------------------------------------------------------------


def _impression_line(task: ExportTask) -> dict:
    (line,) = build_line_items([task], [], CATALOGUE)
    return line


def test_discount_zero_and_none_emit_no_discount_key():
    assert "discount" not in _impression_line(_task(impression_cost=100, impression_discount_pct=None))
    assert "discount" not in _impression_line(_task(impression_cost=100, impression_discount_pct=0))


def test_discount_formats_drop_trailing_zeros_but_keep_real_decimals():
    assert _impression_line(_task(impression_cost=100, impression_discount_pct=10.0))["discount"] == "10%"
    assert _impression_line(_task(impression_cost=100, impression_discount_pct=12.5))["discount"] == "12.5%"
    assert _impression_line(_task(impression_cost=100, impression_discount_pct=0.5))["discount"] == "0.5%"
    assert _impression_line(_task(impression_cost=100, impression_discount_pct=100.0))["discount"] == "100%"


def test_discount_never_lands_on_non_impression_lines():
    task = _task(scan_cost=500, impression_cost=100, impression_discount_pct=10.0)
    lines = build_line_items([task], [], CATALOGUE)
    by_item = {line["item_id"]: line for line in lines}
    assert "discount" not in by_item["ITEM-SCAN"]
    assert by_item["ITEM-IMP"]["discount"] == "10%"


# ---------------------------------------------------------------------------
# Existing-line handling: the corners of the echo rules
# ---------------------------------------------------------------------------


def test_foreign_line_without_a_line_item_id_is_dropped():
    """No id means Books cannot expand it back; echoing a bare {} would be a
    broken line, so the exporter skips it entirely."""
    existing = [{"item_id": "ITEM-RETAIL", "sku": "PB05016", "item_order": 1}]
    lines = build_line_items([_task(scan_cost=100)], existing, CATALOGUE)
    assert all("line_item_id" not in line for line in lines)


def test_attaching_a_shipment_deletes_even_an_unrecognised_island_line():
    """When ``shipping`` is given the whole echo branch is skipped: the fresh
    line replaces ANY existing shipping line, unknown island included —
    otherwise the quote would carry two."""
    existing = [
        {
            "line_item_id": "OLD-SHIP",
            "item_id": "ITEM-SHIP-T",
            "item_order": 5,
            "description": "Nom: X\nÎle: Atlantis",  # island we do not know
        }
    ]
    shipping = ExportShipping(
        service="marquises",
        island_label="Nuku Hiva",
        first_name="Moana",
        last_name="TEMARII",
        phone="+689-87112233",
        price=4500,
    )
    lines = build_line_items([_task(scan_cost=100)], existing, CATALOGUE, shipping)
    assert [line.get("item_id") for line in lines] == ["ITEM-SCAN", "ITEM-SHIP-M"]
    assert all(line.get("line_item_id") != "OLD-SHIP" for line in lines)


def test_lines_with_missing_item_order_sort_as_zero_and_renumber():
    existing = [
        {"line_item_id": "F2", "item_id": "ITEM-RETAIL", "sku": "PB05016", "item_order": 7},
        {"line_item_id": "F1", "item_id": "ITEM-LASER", "sku": "L3DIMP"},  # no item_order
    ]
    lines = build_line_items([_task(scan_cost=100)], existing, CATALOGUE)
    # The order-less line sorts first among the echoes; every line renumbers 1..N.
    assert [line.get("line_item_id") for line in lines] == [None, "F1", "F2"]
    assert [line["item_order"] for line in lines] == [1, 2, 3]
