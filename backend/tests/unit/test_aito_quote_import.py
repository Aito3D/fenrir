"""Quote -> Aito project conversion. Fixtures mirror the live org's payload
shape and formatting quirks with invented customers."""

import json
from pathlib import Path

from backend.app.services.aito_quote_import import (
    parse_description,
    parse_time_min,
    parse_weight_g,
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
