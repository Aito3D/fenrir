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
