"""Orca Cloud stores what OrcaSlicer's serialize() returns; these pairs are copied from profiles Orca uploaded."""

import pytest

from backend.app.services.orca_cloud_codec import decode_content, encode_content, is_wire_format

PAIRS = [
    ("name", "Inslogic PETG - Grey", "Inslogic PETG - Grey"),
    ("inherits", "Bambu PETG Basic @BBL H2S", "Bambu PETG Basic @BBL H2S"),
    ("nozzle_temperature", ["260"], "260"),
    ("enable_pressure_advance", ["1"], "1"),
    ("filament_flow_ratio", ["0.95", "1.024", "nil"], "0.95,1.024,nil"),
    ("filament_z_hop_types", ["Auto Lift", "nil"], "Auto Lift,nil"),
    ("filament_vendor", ["Inslogic"], "Inslogic"),
    ("filament_type", ["PLA Pro"], '"PLA Pro"'),
    ("filament_settings_id", ["Inslogic PETG - Grey"], '"Inslogic PETG - Grey"'),
    (
        "compatible_printers",
        ["Bambu Lab H2S 0.4 nozzle", "Bambu Lab H2D 0.4 nozzle"],
        '"Bambu Lab H2S 0.4 nozzle";"Bambu Lab H2D 0.4 nozzle"',
    ),
    ("compatible_printers", [], ""),
    ("default_filament_colour", [""], '""'),
    ("filament_start_gcode", ["M900 L1000 M10\nM900 K0.02"], '"M900 L1000 M10\\nM900 K0.02"'),
    ("filament_end_gcode", ['; end "x" \\ \n'], '"; end \\"x\\" \\\\ \\n"'),
]


@pytest.mark.parametrize(("key", "local", "wire"), PAIRS)
def test_round_trip(key, local, wire):
    assert encode_content({key: local}) == {key: wire}
    assert decode_content({key: wire}) == {key: local}


def test_lists_pass_through_decode_and_are_flagged():
    broken = {"type": "filament", "enable_pressure_advance": ["1"]}
    assert decode_content(broken) == broken
    assert not is_wire_format(broken)
    assert is_wire_format(encode_content(broken))


def test_unreadable_string_vector_is_kept_whole():
    assert decode_content({"filament_notes": '"open'}) == {"filament_notes": ['"open']}
