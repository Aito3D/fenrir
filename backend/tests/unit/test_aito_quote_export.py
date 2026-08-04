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
    t = task(scan_description="Pièce fissurée à re-scanner")
    assert build_description("scan", t) == "Info: Pièce fissurée à re-scanner\n*Fichier non cédé*"


def test_no_description_emits_no_info_row():
    # No description -> no bare "Info:" row; scan/model still carry the boilerplate.
    assert build_description("scan", task()) == "*Fichier non cédé*"
    assert build_description("usinage", task()) == ""


def test_title_never_appears_in_any_line_description():
    t = task(
        title="Helice grise",
        material="PETG",
        impression_weight_g=210,
        impression_time_min=780,
        impression_color="Gris",
    )
    for service in SERVICES:
        assert "Helice grise" not in build_description(service, t)


def test_impression_description_closes_with_its_info_row():
    # Info LAST on impression: only the first physical line of a description
    # sits behind the `Info:` prefix, so a continuation line is re-read as a
    # top-level row on import. First-occurrence-wins then hands the field to
    # whichever row came first — so the canonical rows must come first, or a
    # note reading "Poids: à définir" would overwrite the real weight.
    t = task(
        impression_description="Support moteur, tolérance serrée",
        material="PETG",
        impression_weight_g=210,
        impression_time_min=780,
        impression_color="Gris",
    )
    assert build_description("impression", t) == (
        "Matériau: PETG\nPoids: 210 gr\nTemps: 13h\nCouleur: Gris\nInfo: Support moteur, tolérance serrée"
    )


def test_a_description_that_looks_like_labels_cannot_outrank_the_real_fields():
    t = task(
        impression_description="Poids: à définir\nTemps: à définir",
        material="PETG",
        impression_weight_g=210,
        impression_time_min=780,
        impression_color="NOIR",
    )
    text = build_description("impression", t)
    # The canonical rows are ahead of every line of the note, so the importer's
    # first-value-wins gives the fields the real values.
    assert text.index("Poids: 210 gr") < text.index("Info:")
    assert text.index("Temps: 13h") < text.index("Info:")


def test_impression_description_drops_rows_with_no_value():
    text = build_description("impression", task(impression_weight_g=210, impression_time_min=780))
    assert text == "Poids: 210 gr\nTemps: 13h"
    assert "Info:" not in text
    assert "Matériau:" not in text


def test_usinage_description_is_its_info_row():
    assert build_description("usinage", task(usinage_description="Percer 4 trous M3")) == "Info: Percer 4 trous M3"


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


def test_single_task_gets_a_header_too():
    # The title lives ONLY in the header now, so even the only task on the
    # quote carries one — otherwise a single-task quote names its job nowhere.
    lines = build_line_items([task(title="Helice grise", scan_cost=5000)], [], CATALOGUE)
    assert len(lines) == 1
    assert lines[0]["header_name"] == "Helice grise"
    assert lines[0]["item_id"] == "ITEM_SCAN"
    assert lines[0]["rate"] == 5000
    assert lines[0]["item_order"] == 1


def test_blank_title_emits_no_header():
    lines = build_line_items([task(title="   ", scan_cost=5000)], [], CATALOGUE)
    assert "header_name" not in lines[0]


def test_a_line_carries_the_catalogue_defaults():
    lines = build_line_items([task(scan_cost=5000)], [], CATALOGUE)
    assert [line.get("line_item_category") for line in lines] == [None]
    assert lines[0]["quantity"] == 1
    assert lines[0]["tax_id"] == "TAX"
    assert lines[0]["unit"] == "Projet"


def test_multiple_tasks_get_headers_named_after_them():
    """Books has no standalone header ROW: a header is ``header_name`` stamped
    on the item lines it groups (reference: quote DEV26-2506). A separate
    ``{"line_item_category": "header"}`` entry is stored by Books as a broken
    item line instead — the bug this test pins down."""
    lines = build_line_items(
        [task(title="Premiere", scan_cost=1000, impression_cost=500), task(title="Deuxieme", usinage_cost=2000)],
        [],
        CATALOGUE,
    )
    assert all(line.get("line_item_category") != "header" for line in lines)
    assert [line.get("header_name") for line in lines] == ["Premiere", "Premiere", "Deuxieme"]
    assert [line["item_order"] for line in lines] == [1, 2, 3]


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


def test_each_service_line_carries_only_its_own_description():
    lines = build_line_items(
        [task(scan_description="A scanner", impression_description="A imprimer", scan_cost=1, impression_cost=2)],
        [],
        CATALOGUE,
    )
    assert lines[0]["description"] == "Info: A scanner\n*Fichier non cédé*"
    assert lines[1]["description"] == "Info: A imprimer"


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
    assert len(lines) == 1
    # The serviceless task contributes nothing at all; the survivor keeps its own.
    assert lines[0]["header_name"] == "Reelle"
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


def test_impression_discount_is_written_as_a_percent_string():
    """The shop's Books org discounts at item level (see quote DEV26-2469,
    where 10% sits on each line as `discount: "10.00%"`), so the impression
    line carries the task's discount in that same form. Only the impression
    line: the discount is a printing-service concept."""
    lines = build_line_items(
        [task(scan_cost=500, impression_cost=1000, impression_discount_pct=10)],
        [],
        CATALOGUE,
    )
    scan_line, impression_line = lines
    assert "discount" not in scan_line
    assert impression_line["discount"] == "10%"


def test_no_discount_emits_no_discount_key():
    """An absent discount must not even write `discount: "0%"` — Books would
    display a pointless 0% column on the PDF."""
    lines = build_line_items([task(impression_cost=1000)], [], CATALOGUE)
    assert "discount" not in lines[0]


def test_round_trip_preserves_the_discount():
    original = [task(impression_cost=2400, impression_quantity=2, impression_discount_pct=15)]
    preview = build_preview(as_estimate(build_line_items(original, [], CATALOGUE)), None, "https://x")
    assert preview["tasks"][0]["impression_discount_pct"] == 15
    # The stored cost stays PRE-discount: rate x quantity, exactly what the
    # exporter derived it from — the discount lives in its own field.
    assert preview["tasks"][0]["impression_cost"] == 2400


def test_round_trip_preserves_task_boundaries_and_fields():
    original = [
        task(title="Helice grise", scan_cost=5000, modelisation_cost=3000),
        task(
            title="Support moteur",
            impression_description="Livrer avant vendredi",
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
    # An Aito task has no material field (the importer cannot map a bare type
    # back onto a brand-prefixed inventory row), so the Matériau row is
    # preserved as text under the service that priced it — as it always was.
    assert second["impression_description"] == "Livrer avant vendredi\nMatériau: PETG"


def test_round_trip_preserves_title_and_service_descriptions():
    original = [
        task(title="Helice grise", scan_cost=5000, scan_description="Scanner l'ancienne pièce", modelisation_cost=3000),
        task(
            title="Support moteur",
            impression_cost=2400,
            impression_quantity=2,
            impression_weight_g=210,
            impression_time_min=150,
            impression_color="Gris",
            material="PETG",
            impression_description="Livrer avant vendredi",
            usinage_cost=500,
            usinage_description="Taraudage M4",
        ),
    ]
    preview = build_preview(as_estimate(build_line_items(original, [], CATALOGUE)), None, "https://x")

    assert preview["skipped_lines"] == []
    first, second = preview["tasks"]
    assert first["title"] == "Helice grise"
    assert first["scan_description"] == "Scanner l'ancienne pièce"
    assert first["modelisation_description"] is None
    assert second["title"] == "Support moteur"
    # Matériau tags along: it has no field to be consumed into, so it is
    # preserved on the description of the line that carried it.
    assert second["impression_description"] == "Livrer avant vendredi\nMatériau: PETG"
    assert second["usinage_description"] == "Taraudage M4"
    assert second["impression_weight_g"] == 210
    assert second["impression_color"] == "Gris"


def test_round_trip_survives_a_description_whose_lines_look_like_labels():
    """A description is free text: a user may well type "Poids: à définir" in
    it. Only its first physical line hides behind the `Info:` prefix, so the
    rest is re-read as top-level rows — and must not be able to overwrite the
    weight, time or colour the task actually holds."""
    original = [
        task(
            title="Helice grise",
            impression_cost=1000,
            impression_quantity=1,
            impression_weight_g=210,
            impression_time_min=780,
            impression_color="NOIR",
            material="PETG",
            impression_description="Poids: à définir\nTemps: à définir\nCouleur: peu importe",
        )
    ]
    preview = build_preview(as_estimate(build_line_items(original, [], CATALOGUE)), None, "https://x")
    imported = preview["tasks"][0]
    assert imported["impression_weight_g"] == 210
    assert imported["impression_time_min"] == 780
    assert imported["impression_color"] == "NOIR"
    # And nothing the note said vanished.
    for row in ("Poids: à définir", "Temps: à définir", "Couleur: peu importe"):
        assert row in imported["impression_description"]


def test_round_trip_single_task_keeps_its_title():
    # Only possible because the single task now exports a header.
    original = [task(title="Helice grise", scan_cost=5000)]
    preview = build_preview(as_estimate(build_line_items(original, [], CATALOGUE)), None, "https://x")
    assert preview["tasks"][0]["title"] == "Helice grise"


def test_round_trip_keeps_rising_rank_tasks_apart():
    """[scan] then [modelisation] rises across the boundary — only the header
    row keeps the importer from merging them into one task."""
    original = [task(title="Une", scan_cost=1000), task(title="Deux", modelisation_cost=2000)]
    preview = build_preview(as_estimate(build_line_items(original, [], CATALOGUE)), None, "https://x")
    assert [t["title"] for t in preview["tasks"]] == ["Une", "Deux"]


from backend.app.services.aito_quote_export import (  # noqa: E402
    Catalogue,
    ExportShipping,
    build_line_items,
    build_shipping_description,
    is_foreign,
)

# A distinct name from the module-level CATALOGUE above: that fixture's ids
# ("ITEM_SCAN", ...) are matched against _SKU_FOR_ITEM by the round-trip
# tests below, and Catalogue(...)'s ids here ("S", "M", ...) exist purely to
# make the shipping-id assertions easy to read. Reusing the name CATALOGUE
# would rebind the same global and silently break every earlier test that
# reads it.
SHIPPING_CATALOGUE = Catalogue(
    scan_item_id="S",
    modelisation_item_id="M",
    impression_item_id="I",
    usinage_item_id="U",
    tax_id="T",
    shipping={"tuamotu": "SHIP-TU", "societe": "SHIP-SO"},
)

SHIPPING = ExportShipping(
    service="tuamotu",
    island_label="Rangiroa",
    first_name="Jean-Pierre",
    last_name="DUPONT",
    phone="+689-89645864",
    price=3200.0,
)


def test_shipping_description_uses_the_exporters_label_convention():
    assert build_shipping_description(SHIPPING) == ("Nom: Jean-Pierre DUPONT\nTéléphone: +689-89645864\nÎle: Rangiroa")


def test_shipping_ids_are_ours_not_foreign():
    assert SHIPPING_CATALOGUE.item_ids() == frozenset({"S", "M", "I", "U", "SHIP-TU", "SHIP-SO"})
    assert is_foreign({"item_id": "SHIP-TU", "sku": "LIV-TU"}, SHIPPING_CATALOGUE) is False


def test_shipping_line_comes_after_the_tasks_and_carries_no_header():
    lines = build_line_items([task(scan_cost=5000)], [], SHIPPING_CATALOGUE, shipping=SHIPPING)
    assert [line["item_id"] for line in lines] == ["S", "SHIP-TU"]
    ship = lines[-1]
    assert "header_name" not in ship, "the shipping line belongs to no task"
    assert ship["rate"] == 3200.0
    assert ship["quantity"] == 1
    assert ship["tax_id"] == "T"
    assert ship["item_order"] == 2


def test_shipping_line_precedes_preserved_foreign_lines():
    existing = [{"line_item_id": "F1", "sku": "RETAIL", "item_order": 1}]
    lines = build_line_items([task(scan_cost=5000)], existing, SHIPPING_CATALOGUE, shipping=SHIPPING)
    assert [line.get("item_id") or line["line_item_id"] for line in lines] == ["S", "SHIP-TU", "F1"]


def test_no_shipping_emits_no_shipping_line():
    lines = build_line_items([task(scan_cost=5000)], [], SHIPPING_CATALOGUE)
    assert [line["item_id"] for line in lines] == ["S"]


def test_an_unowned_shipping_line_is_echoed_rather_than_deleted():
    # The project carries no shipping, but the quote already has a shipping
    # line — imported, or typed by hand in Books. Omitting it would DELETE it.
    existing = [{"line_item_id": "L9", "item_id": "SHIP-TU", "item_order": 5}]
    lines = build_line_items([task(scan_cost=5000)], existing, SHIPPING_CATALOGUE)
    assert lines[-1] == {"line_item_id": "L9", "item_order": 2}


def test_the_projects_own_shipping_replaces_any_existing_shipping_line():
    # One project, one shipping line — never two.
    existing = [{"line_item_id": "L9", "item_id": "SHIP-TU", "item_order": 5}]
    lines = build_line_items([task(scan_cost=5000)], existing, SHIPPING_CATALOGUE, shipping=SHIPPING)
    assert [line.get("item_id") or line["line_item_id"] for line in lines] == ["S", "SHIP-TU"]


def test_shipping_item_id_raises_for_an_unresolved_service():
    import pytest

    with pytest.raises(KeyError):
        SHIPPING_CATALOGUE.shipping_item_id("marquises")
