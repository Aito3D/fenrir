"""Pins the three ``.gcode.3mf`` suffix strippers (reslice output name, filing item name,
storage extension split) to their outputs before T-264 routed them through one helper."""

import pytest

from backend.app.services.project_filing import item_name_for_filename
from backend.app.services.project_reslice import output_filename
from backend.app.services.project_storage import _split_extension, split_gcode_3mf

# (input, reslice output_filename, filing item_name_for_filename, storage _split_extension)
CASES = [
    ("a.gcode.3mf", "a.gcode.3mf", "a", ("a", ".gcode.3mf")),
    ("A.GCODE.3MF", "A.gcode.3mf", "A", ("A", ".GCODE.3MF")),
    ("a.3mf", "a.gcode.3mf", "a", ("a", ".3mf")),
    ("a.3MF", "a.gcode.3mf", "a", ("a", ".3MF")),
    (".gcode.3mf", "tranche.gcode.3mf", ".gcode.3mf", (".gcode", ".3mf")),
    (".3mf", "tranche.gcode.3mf", ".3mf", (".3mf", "")),
    ("a.gcode", "a.gcode.gcode.3mf", "a", ("a", ".gcode")),
    ("a.stl", "a.stl.gcode.3mf", "a", ("a", ".stl")),
    ("a.b.gcode.3mf", "a.b.gcode.3mf", "a.b", ("a.b", ".gcode.3mf")),
    ("a.gcode.3mf ", "a.gcode.3mf .gcode.3mf", "a", ("a.gcode.3mf ", "")),
    ("", "tranche.gcode.3mf", "", ("", "")),
    (" .gcode.3mf", " .gcode.3mf", ".gcode.3mf", (" ", ".gcode.3mf")),
    ("a.Gcode.3mf", "a.gcode.3mf", "a", ("a", ".Gcode.3mf")),
    (".GCODE.3MF", "tranche.gcode.3mf", ".GCODE.3MF", (".GCODE", ".3MF")),
    ("gcode.3mf", "gcode.gcode.3mf", "gcode", ("gcode", ".3mf")),
    ("a .gcode.3mf", "a .gcode.3mf", "a ", ("a ", ".gcode.3mf")),
    ("  ", "  .gcode.3mf", "", ("  ", "")),
    ("a.", "a..gcode.3mf", "a", ("a.", "")),
    ("noext", "noext.gcode.3mf", "noext", ("noext", "")),
    (".hidden", ".hidden.gcode.3mf", ".hidden", (".hidden", "")),
    ("x.gcode.3mf.3mf", "x.gcode.3mf.gcode.3mf", "x.gcode.3mf", ("x.gcode.3mf", ".3mf")),
    ("x.3mf.gcode", "x.3mf.gcode.gcode.3mf", "x.3mf", ("x.3mf", ".gcode")),
    ("İ.gcode.3mf", "İ.gcode.3mf", "İ", ("İ", ".gcode.3mf")),
    ("a.tar.gz", "a.tar.gz.gcode.3mf", "a.tar", ("a.tar", ".gz")),
    ("a.bad ext", "a.bad ext.gcode.3mf", "a", ("a.bad ext", "")),
]


@pytest.mark.parametrize("name,reslice,item,split", CASES)
def test_suffix_strippers_keep_their_outputs(name, reslice, item, split):
    assert output_filename(name) == reslice
    assert item_name_for_filename(name) == item
    assert _split_extension(name) == split


@pytest.mark.parametrize(
    "name,expected",
    [
        ("a.gcode.3mf", ("a", ".gcode.3mf")),
        ("A.GCODE.3MF", ("A", ".GCODE.3MF")),
        (".gcode.3mf", ("", ".gcode.3mf")),
        ("a.3mf", ("a.3mf", "")),
        ("a.gcode.3mf ", ("a.gcode.3mf ", "")),
        ("", ("", "")),
    ],
)
def test_split_gcode_3mf(name, expected):
    assert split_gcode_3mf(name) == expected
