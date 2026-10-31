"""The sliced-file display facts shared by the File Manager, project and archive cards."""

from __future__ import annotations

from backend.app.services.print_file_facts import display_facts, extra_display_facts, object_count_of

FULL = {
    "print_time_seconds": 8040,
    "filament_used_grams": 38.4,
    "filament_type": "PETG, PLA",
    "filament_color": "#FF0000,#00FF00",
    "filament_vendor": "SUNLU",
    "sliced_for_model": "X1C",
    "total_layers": 320,
    "layer_height": "0.2",
    "nozzle_diameter": "0.4",
    "printable_objects": {"1": "Stand", "2": "Stand"},
    "print_name": "dropped by the serializers",
}


def test_display_facts_reads_every_card_fact():
    assert display_facts(FULL) == {
        "print_time_seconds": 8040,
        "filament_used_grams": 38.4,
        "filament_type": "PETG, PLA",
        "filament_color": "#FF0000,#00FF00",
        "filament_vendor": "SUNLU",
        "sliced_for_model": "X1C",
        "total_layers": 320,
        "layer_height": 0.2,  # the 3MF's string becomes a number
        "nozzle_diameter": 0.4,
        "object_count": 2,
    }


def test_missing_or_unusable_values_are_none():
    facts = display_facts(
        {
            "print_time_seconds": 0,
            "filament_used_grams": -1,
            "filament_type": "   ",
            "total_layers": True,  # a bool is not a count
            "layer_height": "thick",
            "printable_objects": [],
        }
    )
    assert all(value is None for value in facts.values()), facts
    assert all(value is None for value in display_facts(None).values())
    assert all(value is None for value in display_facts("not a dict").values())  # type: ignore[arg-type]


def test_extra_facts_are_the_six_the_serializers_did_not_read():
    assert set(extra_display_facts(FULL)) == {
        "filament_color",
        "filament_vendor",
        "total_layers",
        "layer_height",
        "nozzle_diameter",
        "object_count",
    }
    assert object_count_of({"printable_objects": {}}) is None
    assert object_count_of({"printable_objects": {"7": "Lid"}}) == 1
