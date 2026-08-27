"""Tests for matching a filament profile to a Zoho catalogue item.

Pure: no database, no network. This is the half of the price sync that can
silently write a wrong number, so it carries the weight of the testing.
"""

import pytest

from backend.app.services.zoho_filaments import FilamentProduct, match_profile


def product(brand="Polymaker", material="PETG", colour="Electric Blue", price=19.9, has_price=True, name=None):
    return FilamentProduct(
        item_id=f"{brand}-{material}-{colour}",
        name=name or f"{brand} - {material} - {colour} - 1.75mm - 1kg",
        sku="SKU",
        brand=brand,
        material=material,
        colour=colour,
        spool_weight_kg=1.0,
        weight_inferred=False,
        dealer_price=price,
        cost_per_kg=price,
        has_price=has_price,
    )


def test_exact_match_is_confident():
    catalogue = [product()]
    result = match_profile(catalogue, "Polymaker", "PETG", "Electric Blue")
    assert result.outcome == "matched"
    assert result.product is not None
    assert result.product.cost_per_kg == 19.9


def test_brand_mismatch_is_no_match():
    catalogue = [product(brand="Polymaker")]
    result = match_profile(catalogue, "eSUN", "PETG", "Electric Blue")
    assert result.outcome == "no_match"
    assert result.product is None
    assert result.candidates == []
    assert result.candidates_total == 0


def test_material_mismatch_is_no_match():
    catalogue = [product(material="PETG")]
    result = match_profile(catalogue, "Polymaker", "PLA", "Electric Blue")
    assert result.outcome == "no_match"


def test_colour_disambiguates_two_same_brand_and_material():
    catalogue = [product(colour="Red", price=17.0), product(colour="Electric Blue", price=19.9)]
    result = match_profile(catalogue, "Polymaker", "PETG", "Electric Blue")
    assert result.outcome == "matched"
    assert result.product.cost_per_kg == 19.9


def test_two_items_surviving_colour_narrowing_is_ambiguous():
    catalogue = [
        product(colour="Electric Blue", name="A - PETG - Electric Blue"),
        product(colour="Electric Blue", name="B - PETG - Electric Blue"),
    ]
    result = match_profile(catalogue, "Polymaker", "PETG", "Electric Blue")
    assert result.outcome == "ambiguous"
    assert result.product is None
    assert result.candidates == ["A - PETG - Electric Blue", "B - PETG - Electric Blue"]
    # Two collisions, no cap needed: the reported count equals the true one.
    assert result.candidates_total == 2


def test_colour_that_matches_nothing_leaves_the_collision_ambiguous():
    # Two brand+material candidates, neither in the requested colour: reporting
    # the collision is right, silently picking one is not.
    catalogue = [
        product(colour="Red", name="A - PETG - Red"),
        product(colour="Green", name="B - PETG - Green"),
    ]
    result = match_profile(catalogue, "Polymaker", "PETG", "Electric Blue")
    assert result.outcome == "ambiguous"
    assert result.candidates == ["A - PETG - Red", "B - PETG - Green"]
    assert result.candidates_total == 2


def test_ambiguous_collision_over_the_cap_is_truncated_with_a_true_total():
    # T-010: an operator with many hand-typed colours that never appear in
    # Zoho must not get every colliding item name back — just the first 5
    # plus the true collision size so nothing is silently hidden.
    catalogue = [product(colour=f"Colour {i}", name=f"Item {i} - PETG - Colour {i}") for i in range(7)]
    result = match_profile(catalogue, "Polymaker", "PETG", "Electric Blue")
    assert result.outcome == "ambiguous"
    assert result.candidates == [f"Item {i} - PETG - Colour {i}" for i in range(5)]
    assert len(result.candidates) == 5
    assert result.candidates_total == 7


def test_ambiguous_collision_at_the_cap_is_not_truncated():
    catalogue = [product(colour=f"Colour {i}", name=f"Item {i} - PETG - Colour {i}") for i in range(5)]
    result = match_profile(catalogue, "Polymaker", "PETG", "Electric Blue")
    assert result.outcome == "ambiguous"
    assert len(result.candidates) == 5
    assert result.candidates_total == 5


def test_sole_candidate_matches_even_when_the_colour_differs():
    # DELIBERATE: price per kg does not vary by colour within a brand+material,
    # so a lone candidate is priced even if that exact colour is not stocked.
    # Pinned so it stays a decision rather than becoming an accident.
    catalogue = [product(colour="Red", price=17.0)]
    result = match_profile(catalogue, "Polymaker", "PETG", "Electric Blue")
    assert result.outcome == "matched"
    assert result.product.cost_per_kg == 17.0


def test_unpriced_item_is_its_own_outcome():
    catalogue = [product(price=0.0, has_price=False)]
    result = match_profile(catalogue, "Polymaker", "PETG", "Electric Blue")
    assert result.outcome == "no_price"
    assert result.product is not None  # the caller can name it in the report
    assert result.candidates == [catalogue[0].name]
    assert result.candidates_total == 1


def test_missing_brand_or_material_never_matches():
    catalogue = [product()]
    assert match_profile(catalogue, "", "PETG", "Electric Blue").outcome == "no_match"
    assert match_profile(catalogue, "Polymaker", "", "Electric Blue").outcome == "no_match"


@pytest.mark.parametrize(
    ("brand", "material", "colour"),
    [
        ("  polymaker  ", "petg", "electric blue"),
        ("POLYMAKER", "PETG", "ELECTRIC BLUE"),
        ("Poly-maker", "PET-G", "Electric  Blue"),
    ],
)
def test_normalisation_ignores_case_whitespace_and_punctuation(brand, material, colour):
    catalogue = [product()]
    assert match_profile(catalogue, brand, material, colour).outcome == "matched"


def test_empty_catalogue_is_no_match():
    assert match_profile([], "Polymaker", "PETG", "Electric Blue").outcome == "no_match"
