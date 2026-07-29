"""Quote -> Aito project conversion. Fixtures mirror the live org's payload
shape and formatting quirks with invented customers."""

import json
from pathlib import Path

from backend.app.services.aito_quote_import import (
    group_lines,
    parse_description,
    parse_lines,
    parse_time_min,
    parse_weight_g,
    service_for_sku,
)

_FIXTURES = Path(__file__).parent.parent / "fixtures" / "zoho_estimates"


def load_estimate(name: str) -> dict:
    return json.loads((_FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def test_fixtures_load():
    assert load_estimate("dev-2461-three-services")["estimate_number"] == "DEV26-2461"
    assert len(load_estimate("dev-2462-two-tasks")["line_items"]) == 3


def test_parse_description_splits_labels_from_free_text():
    labels, free = parse_description(
        "Projet: Tapis souple X4 bloc\nMatériau: TPU 95 A --- 1.5mm\nPoids: 210 gr\nTemps: 13h\nCouleur: NOIR"
    )
    assert labels == {
        "projet": "Tapis souple X4 bloc",
        "materiau": "TPU 95 A --- 1.5mm",
        "poids": "210 gr",
        "temps": "13h",
        "couleur": "NOIR",
    }
    assert free == ()


def test_parse_description_drops_boilerplate_and_keeps_free_text():
    labels, free = parse_description(
        "Info: Logo F170\n*Fichier non cédé*\nCouleur Noir de face.\nFaire plusieurs pièce"
    )
    assert labels == {"info": "Logo F170"}
    # "Couleur Noir de face." has no colon, so it is free text, not a label.
    assert free == ("Couleur Noir de face.", "Faire plusieurs pièce")


def test_parse_description_treats_unfilled_placeholders_as_empty():
    labels, free = parse_description("Projet: [TITLE]\nMatériau: [MATERIAL]\nPoids: [WEIGHT]")
    assert labels == {"projet": "", "materiau": "", "poids": ""}
    assert free == ()


def test_parse_description_keeps_first_value_when_a_label_repeats():
    labels, _free = parse_description("Info: first\nInfo: second")
    assert labels["info"] == "first"


def test_parse_description_handles_empty_input():
    assert parse_description("") == ({}, ())
    assert parse_description(None) == ({}, ())


def test_parse_weight_g_units():
    assert parse_weight_g("210 gr") == 210
    assert parse_weight_g("30gr") == 30
    assert parse_weight_g("2g") == 2
    assert parse_weight_g("1,5 kg") == 1500
    assert parse_weight_g("0.25kg") == 250
    assert parse_weight_g("45") == 45  # bare number = grams
    assert parse_weight_g("") is None
    assert parse_weight_g("à définir") is None


def test_parse_time_min_units():
    assert parse_time_min("13h") == 780
    assert parse_time_min("26min") == 26
    assert parse_time_min("2h30") == 150
    assert parse_time_min("1j 4h") == 1680
    assert parse_time_min("2h 15 min") == 135
    assert parse_time_min("90") == 90  # bare number = minutes
    assert parse_time_min("") is None
    assert parse_time_min("à définir") is None


def test_service_for_sku_matches_by_prefix():
    assert service_for_sku("P3DSCAN") == "scan"
    assert service_for_sku("P3DMOD") == "modelisation"
    assert service_for_sku("P3DIMP") == "impression"
    assert service_for_sku("U3DIMP") == "usinage"
    # The -VENTE variant rides the same prefix.
    assert service_for_sku("U3DIMP-VENTE") == "usinage"
    assert service_for_sku(" p3dimp ") == "impression"
    # Laser, the legacy generic, retail and blank SKUs are not Aito services.
    assert service_for_sku("L3DIMP") is None
    assert service_for_sku("P3D2024") is None
    assert service_for_sku("PB05016") is None
    assert service_for_sku("") is None


def test_parse_lines_amounts_are_ttc_when_the_quote_is_inclusive():
    lines, skipped = parse_lines(load_estimate("dev-2462-two-tasks"))
    assert skipped == []
    assert [line.service for line in lines] == ["modelisation", "impression", "impression"]
    # rate x quantity: 800 x 3. item_total (2124) is the pre-tax figure.
    assert lines[1].amount == 2400
    assert lines[1].quantity == 3
    assert lines[0].amount == 3000


def test_parse_lines_amounts_add_tax_when_the_quote_is_exclusive():
    lines, _skipped = parse_lines(load_estimate("dev-2448-vente"))
    # item_total 4000 + tax 520
    assert [line.amount for line in lines] == [4520, 4520]


def test_parse_lines_reports_unrecognised_lines():
    lines, skipped = parse_lines(load_estimate("dev-2463-retail"))
    assert lines == []
    assert [s["sku"] for s in skipped] == ["PB05016", "L3DIMP"]
    assert skipped[0]["amount"] == 8000  # 4000 x 2, tax-inclusive quote
    assert skipped[1]["name"].startswith("Découpe")


def test_group_lines_merges_a_strictly_rising_run():
    lines, _skipped = parse_lines(load_estimate("dev-2461-three-services"))
    groups = group_lines(lines)
    assert len(groups) == 1
    assert [line.service for line in groups[0]] == ["scan", "modelisation", "impression"]


def test_group_lines_starts_a_new_group_on_a_repeated_service():
    lines, _skipped = parse_lines(load_estimate("dev-2462-two-tasks"))
    groups = group_lines(lines)
    assert [[line.service for line in g] for g in groups] == [
        ["modelisation", "impression"],
        ["impression"],
    ]


def test_group_lines_merges_all_four_services():
    lines, _skipped = parse_lines(load_estimate("dev-2467-template"))
    groups = group_lines(lines)
    assert len(groups) == 1
    assert [line.service for line in groups[0]] == ["scan", "modelisation", "impression", "usinage"]


def test_group_lines_merges_a_gap_in_the_run():
    lines, _skipped = parse_lines(load_estimate("dev-2448-vente"))
    # modelisation (rank 1) then usinage (rank 3) still rises, so one task.
    assert len(group_lines(lines)) == 1
