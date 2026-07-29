"""Aito project -> Zoho line items. Pure functions, no DB and no HTTP.

The formatters are written against the importer's parsers: whatever this
module writes, `aito_quote_import` must read back unchanged.
"""

from backend.app.services.aito_quote_export import (
    SERVICES,
    ExportTask,
    build_description,
    cost_of,
    enabled_services,
    format_time,
    format_weight,
)
from backend.app.services.aito_quote_import import parse_time_min, parse_weight_g


def task(**overrides) -> ExportTask:
    """An ExportTask with everything off, overridden per test."""
    base = {
        "title": "Helice grise",
        "description": None,
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
    base.update(overrides)
    return ExportTask(**base)


def test_format_weight_round_trips_through_the_importer():
    assert format_weight(210) == "210 gr"
    assert format_weight(1.5) == "1.5 gr"
    assert format_weight(None) is None
    for grams in (2, 210, 1.5, 950):
        assert parse_weight_g(format_weight(grams)) == grams


def test_format_weight_survives_high_precision_and_large_values():
    # ':g' caps at 6 significant digits and flips to scientific notation past
    # 1e6 -- both silently corrupt the round trip through parse_weight_g,
    # whose regex has no exponent support. These are the exact failure modes
    # from the review finding.
    for grams in (1234.5678, 100000.5, 1_000_000):
        assert parse_weight_g(format_weight(grams)) == grams


def test_format_time_round_trips_through_the_importer():
    assert format_time(26) == "26min"
    assert format_time(780) == "13h"
    assert format_time(150) == "2h30"
    assert format_time(125) == "2h05"
    assert format_time(None) is None
    for minutes in (1, 26, 59, 60, 125, 150, 780, 1680):
        assert parse_time_min(format_time(minutes)) == minutes


def test_scan_description_is_the_catalogue_template():
    assert build_description("scan", task(), include_free_text=False) == "Info: Helice grise\n*Fichier non cédé*"


def test_impression_description_drops_rows_with_no_value():
    text = build_description(
        "impression",
        task(impression_weight_g=210, impression_time_min=780),
        include_free_text=False,
    )
    assert text == "Projet: Helice grise\nPoids: 210 gr\nTemps: 13h"
    assert "Matériau:" not in text
    assert "Couleur:" not in text


def test_impression_description_full():
    text = build_description(
        "impression",
        task(material="PETG", impression_weight_g=210, impression_time_min=780, impression_color="Gris"),
        include_free_text=False,
    )
    assert text == "Projet: Helice grise\nMatériau: PETG\nPoids: 210 gr\nTemps: 13h\nCouleur: Gris"


def test_free_text_is_appended_only_when_asked():
    t = task(description="Livrer avant vendredi")
    assert build_description("usinage", t, include_free_text=False) == "Usinage: Helice grise"
    assert build_description("usinage", t, include_free_text=True) == ("Usinage: Helice grise\nLivrer avant vendredi")


def test_placeholders_are_never_emitted():
    text = build_description("impression", task(title=None), include_free_text=False)
    assert "[" not in text
    assert "Projet:" not in text


def test_cost_of_treats_zero_as_enabled_and_free():
    # 0 must stay meaningful as "free" -- a truthiness check would collapse it
    # into "disabled", same as None, and silently drop the quote line.
    t = task(scan_cost=0, modelisation_cost=None, impression_cost=15.5, usinage_cost=None)
    assert cost_of(t, "scan") == 0
    assert cost_of(t, "modelisation") is None
    assert cost_of(t, "impression") == 15.5
    assert cost_of(t, "usinage") is None


def test_enabled_services_includes_zero_cost_and_excludes_none():
    t = task(scan_cost=0, modelisation_cost=None, impression_cost=15.5, usinage_cost=None)
    assert enabled_services(t) == ("scan", "impression")
    # Every service enabled, canonical order preserved.
    all_on = task(scan_cost=0, modelisation_cost=0, impression_cost=0, usinage_cost=0)
    assert enabled_services(all_on) == SERVICES
    # Nothing enabled.
    assert enabled_services(task()) == ()


from backend.app.services.aito_quote_export import (  # noqa: E402
    Catalogue,
    build_line_items,
    impression_rate_quantity,
)

CATALOGUE = Catalogue(
    scan_item_id="ITEM_SCAN",
    modelisation_item_id="ITEM_MOD",
    impression_item_id="ITEM_IMP",
    usinage_item_id="ITEM_USI",
    tax_id="TAX",
)


def test_single_task_gets_no_header():
    lines = build_line_items([task(scan_cost=5000)], [], CATALOGUE)
    assert [line.get("line_item_category") for line in lines] == [None]
    assert lines[0]["item_id"] == "ITEM_SCAN"
    assert lines[0]["rate"] == 5000
    assert lines[0]["quantity"] == 1
    assert lines[0]["tax_id"] == "TAX"
    assert lines[0]["unit"] == "Projet"
    assert lines[0]["item_order"] == 1


def test_multiple_tasks_get_headers_named_after_them():
    lines = build_line_items(
        [task(title="Premiere", scan_cost=1000), task(title="Deuxieme", usinage_cost=2000)],
        [],
        CATALOGUE,
    )
    assert [line.get("name") for line in lines if line.get("line_item_category") == "header"] == [
        "Premiere",
        "Deuxieme",
    ]
    assert [line["item_order"] for line in lines] == [1, 2, 3, 4]


def test_services_are_emitted_in_canonical_order():
    lines = build_line_items(
        [task(usinage_cost=4, impression_cost=3, modelisation_cost=2, scan_cost=1)],
        [],
        CATALOGUE,
    )
    assert [line["item_id"] for line in lines] == ["ITEM_SCAN", "ITEM_MOD", "ITEM_IMP", "ITEM_USI"]


def test_zero_cost_is_a_line_but_none_is_not():
    lines = build_line_items([task(scan_cost=0, modelisation_cost=None)], [], CATALOGUE)
    assert len(lines) == 1
    assert lines[0]["rate"] == 0


def test_free_text_lands_on_the_first_service_line_only():
    lines = build_line_items(
        [task(description="Note interne", scan_cost=1, impression_cost=2)],
        [],
        CATALOGUE,
    )
    assert "Note interne" in lines[0]["description"]
    assert "Note interne" not in lines[1]["description"]


def test_impression_rate_is_the_total_divided_by_quantity():
    assert impression_rate_quantity(task(impression_cost=2400, impression_quantity=2)) == (1200, 2)
    assert impression_rate_quantity(task(impression_cost=2401, impression_quantity=2)) == (1200, 2)
    assert impression_rate_quantity(task(impression_cost=500, impression_quantity=None)) == (500, 1)


def test_foreign_lines_are_preserved_by_id_after_the_aito_block():
    existing = [
        {"line_item_id": "L1", "sku": "P3DSCAN", "item_order": 1},
        {"line_item_id": "L2", "sku": "", "name": "Bobine PETG", "item_order": 2},
        {"line_item_id": "L3", "line_item_category": "header", "name": "old header", "item_order": 3},
        {"line_item_id": "L4", "sku": "L3DIMP", "name": "Decoupe laser", "item_order": 4},
    ]
    lines = build_line_items([task(scan_cost=1000)], existing, CATALOGUE)
    assert lines[-2:] == [
        {"line_item_id": "L2", "item_order": 2},
        {"line_item_id": "L4", "item_order": 3},
    ]


def test_a_task_with_no_service_produces_nothing_not_even_a_header():
    lines = build_line_items([task(title="Vide"), task(title="Reelle", scan_cost=1)], [], CATALOGUE)
    assert [line.get("line_item_category") for line in lines] == [None]
    assert lines[0]["item_id"] == "ITEM_SCAN"


def test_catalogue_override_to_a_non_matching_sku_does_not_duplicate_our_own_line():
    """The `zoho_item_*_id` settings are documented as overridable to a Books
    item whose SKU does not follow the usual P3DIMP-style prefix. Before this
    fix, `is_foreign` classified purely on SKU prefix, so Books echoing our
    own overridden-item line back (as `existing_line_items`, from the
    estimate the previous push wrote) would be judged "foreign" and both kept
    AND have a fresh line re-emitted from the task — a duplicate that grows
    on every single push.
    """
    catalogue = Catalogue(
        scan_item_id="ITEM_SCAN",
        modelisation_item_id="ITEM_MOD",
        impression_item_id="ITEM_IMP_CUSTOM",  # overridden away from any P3DIMP-prefixed SKU
        usinage_item_id="ITEM_USI",
        tax_id="TAX",
    )
    existing = [
        {"line_item_id": "L1", "item_id": "ITEM_IMP_CUSTOM", "sku": "CUSTOM-NOT-A-KNOWN-PREFIX", "item_order": 1},
    ]
    lines = build_line_items([task(impression_cost=1000, impression_quantity=1)], existing, catalogue)
    impression_lines = [line for line in lines if line.get("item_id") == "ITEM_IMP_CUSTOM"]
    assert len(impression_lines) == 1
    # The survivor must be the freshly-built line (no line_item_id), not the
    # old one echoed back as if it were foreign.
    assert "line_item_id" not in impression_lines[0]
    assert not any(line.get("line_item_id") == "L1" for line in lines)


from backend.app.services.aito_quote_import import build_preview  # noqa: E402

_SKU_FOR_ITEM = {
    "ITEM_SCAN": "P3DSCAN",
    "ITEM_MOD": "P3DMOD",
    "ITEM_IMP": "P3DIMP",
    "ITEM_USI": "U3DIMP",
}


def as_estimate(lines: list[dict]) -> dict:
    """Wrap built lines in the estimate shape Books would return them in.

    Books echoes the catalogue item's `sku`, which the importer classifies on;
    the exporter sends `item_id`. Mapping one to the other is what makes the
    two modules composable in a test.
    """
    return {
        "estimate_id": "e1",
        "estimate_number": "DEV26-9999",
        "date": "2026-07-29",
        "status": "draft",
        "currency_code": "XPF",
        "is_inclusive_tax": True,
        "price_precision": 0,
        "total": 0,
        "line_items": [{**line, "sku": _SKU_FOR_ITEM.get(line.get("item_id"), "")} for line in lines],
    }


def test_round_trip_preserves_task_boundaries_and_fields():
    original = [
        task(title="Helice grise", scan_cost=5000, modelisation_cost=3000),
        task(
            title="Support moteur",
            description="Livrer avant vendredi",
            impression_cost=2400,
            impression_quantity=2,
            impression_weight_g=210,
            impression_time_min=150,
            impression_color="Gris",
            material="PETG",
        ),
    ]
    preview = build_preview(as_estimate(build_line_items(original, [], CATALOGUE)), None, "https://x")

    assert preview["skipped_lines"] == []
    assert len(preview["tasks"]) == 2
    first, second = preview["tasks"]
    assert first["title"] == "Helice grise"
    assert (first["scan_cost"], first["modelisation_cost"]) == (5000, 3000)
    assert second["title"] == "Support moteur"
    assert second["impression_cost"] == 2400
    assert second["impression_quantity"] == 2
    assert second["impression_weight_g"] == 210
    assert second["impression_time_min"] == 150
    assert second["impression_color"] == "Gris"
    assert "Livrer avant vendredi" in (second["description"] or "")


def test_round_trip_keeps_rising_rank_tasks_apart():
    """[scan] then [modelisation] rises across the boundary — only the header
    row keeps the importer from merging them into one task."""
    original = [task(title="Une", scan_cost=1000), task(title="Deux", modelisation_cost=2000)]
    preview = build_preview(as_estimate(build_line_items(original, [], CATALOGUE)), None, "https://x")
    assert [t["title"] for t in preview["tasks"]] == ["Une", "Deux"]
