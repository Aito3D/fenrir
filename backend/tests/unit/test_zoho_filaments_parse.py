"""Tests for parsing Zoho filament item names.

Zoho's own ``weight`` field is empty for every filament item, so spool weight
exists only inside the name string. Every name below is real production data.
"""

import pytest

from backend.app.services.zoho_filaments import parse_filament_name


@pytest.mark.parametrize(
    ("name", "brand", "material", "colour", "weight", "inferred"),
    [
        (
            "Bambu Lab - ABS-GF - Bleu (Blue) - 1.75mm - 1kg",
            "Bambu Lab",
            "ABS-GF",
            "Bleu (Blue)",
            1.0,
            False,
        ),
        (
            "Bambu Lab - ASA Aero - Blanc (White) - 1.75mm - 0.9kg",
            "Bambu Lab",
            "ASA Aero",
            "Blanc (White)",
            0.9,
            False,
        ),
        (
            "Bambu Lab - PA6-CF - Noir (Black) - 1.75mm - 0.5kg",
            "Bambu Lab",
            "PA6-CF",
            "Noir (Black)",
            0.5,
            False,
        ),
        (
            "Polymaker - PolyMax PC - Blanc (White) - 1.75mm - 0.75kg",
            "Polymaker",
            "PolyMax PC",
            "Blanc (White)",
            0.75,
            False,
        ),
        (
            "Polymaker - Fiberon PA612-CF15 - Noir (Black) - 1.75mm - 0.5kg",
            "Polymaker",
            "Fiberon PA612-CF15",
            "Noir (Black)",
            0.5,
            False,
        ),
    ],
)
def test_parses_standard_names(name, brand, material, colour, weight, inferred):
    parsed = parse_filament_name(name)
    assert parsed.brand == brand
    assert parsed.material == material
    assert parsed.colour == colour
    assert parsed.spool_weight_kg == weight
    assert parsed.weight_inferred is inferred


def test_doubled_suffix_uses_the_last_weight():
    """This real Refill item repeats '- 1.75mm - 1kg'; the last match wins."""
    parsed = parse_filament_name("Bambu Lab - ABS - Argent (Silver) - 1.75mm - 1kg Refill - 1.75mm - 1kg")
    assert parsed.brand == "Bambu Lab"
    assert parsed.material == "ABS"
    assert parsed.colour == "Argent (Silver)"
    assert parsed.spool_weight_kg == 1.0
    assert parsed.weight_inferred is False


def test_missing_weight_defaults_to_one_kg_and_is_flagged():
    parsed = parse_filament_name("SUNLU - PETG - Gris Argent (Silver)")
    assert parsed.brand == "SUNLU"
    assert parsed.material == "PETG"
    assert parsed.colour == "Gris Argent (Silver)"
    assert parsed.spool_weight_kg == 1.0
    assert parsed.weight_inferred is True


def test_diameter_in_mm_is_never_read_as_a_weight():
    """'1.75mm' must not be mistaken for a weight when no kg appears."""
    parsed = parse_filament_name("eSUN - PLA - Rouge - 1.75mm")
    assert parsed.spool_weight_kg == 1.0
    assert parsed.weight_inferred is True


def test_empty_name_is_safe():
    parsed = parse_filament_name("")
    assert parsed.brand == ""
    assert parsed.material == ""
    assert parsed.colour == ""
    assert parsed.spool_weight_kg == 1.0
    assert parsed.weight_inferred is True
