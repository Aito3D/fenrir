"""Pins the candidate 3MF filenames on_print_start tries, in order.

The builder was lifted out of on_print_start verbatim; these cases fix its
exact output (order, dedupe, the space->underscore variants appended last) so
the extraction, and any later edit, cannot reorder the FTP sweep silently.
"""

import pytest

from backend.app.main import _print_3mf_candidate_names


@pytest.mark.parametrize(
    ("subtask_name", "filename", "expected"),
    [
        ("", "", []),
        ("Cube", "", ["Cube.gcode.3mf", "Cube.3mf"]),
        ("", "Cube", ["Cube.gcode.3mf", "Cube.3mf"]),
        # A .3mf filename is tried as-is, and duplicates collapse onto first sight.
        ("Box", "Box.gcode.3mf", ["Box.gcode.3mf", "Box.3mf"]),
        ("Box", "Other.3mf", ["Box.gcode.3mf", "Box.3mf", "Other.3mf"]),
        # A .gcode path drops its directory and its last extension only.
        (
            "Part",
            "/data/Metadata/plate_1.gcode",
            ["Part.gcode.3mf", "Part.3mf", "plate_1.gcode.3mf", "plate_1.3mf"],
        ),
        ("", "a.b.gcode", ["a.b.gcode.3mf", "a.b.3mf"]),
        ("x", "x.gcode", ["x.gcode.3mf", "x.3mf"]),
        # Underscore variants follow every original, in the originals' order.
        (
            "My Part",
            "/data/Metadata/plate 2.gcode",
            [
                "My Part.gcode.3mf",
                "My Part.3mf",
                "plate 2.gcode.3mf",
                "plate 2.3mf",
                "My_Part.gcode.3mf",
                "My_Part.3mf",
                "plate_2.gcode.3mf",
                "plate_2.3mf",
            ],
        ),
        # An underscore variant that equals an original is deduped away.
        ("A B", "A_B.3mf", ["A B.gcode.3mf", "A B.3mf", "A_B.3mf", "A_B.gcode.3mf"]),
        ("A B", "A B.3mf", ["A B.gcode.3mf", "A B.3mf", "A_B.gcode.3mf", "A_B.3mf"]),
    ],
)
def test_candidate_names(subtask_name, filename, expected):
    assert _print_3mf_candidate_names(subtask_name, filename) == expected


def test_returns_a_fresh_list():
    first = _print_3mf_candidate_names("Cube", "")
    first.append("mutated")
    assert _print_3mf_candidate_names("Cube", "") == ["Cube.gcode.3mf", "Cube.3mf"]
