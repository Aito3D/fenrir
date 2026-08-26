"""Tests for writing a synced price into a preset's JSON.

Pure: no database. The formatting assertions are not cosmetic — the frontend
writes these files with `JSON.stringify(out, null, 4)`, and a mismatch here
would rewrite every preset's whole file on the first sync.
"""

import json

from backend.app.services.filament_profile_pricing import apply_filament_cost


def test_writes_the_array_of_one_string_form():
    content = json.dumps({"name": "X"}, indent=4)
    updated, outcome = apply_filament_cost(content, 19.9)
    assert outcome == "written"
    assert json.loads(updated)["filament_cost"] == ["19.90"]


def test_overwrites_an_existing_cost():
    content = json.dumps({"filament_cost": ["12.00"]}, indent=4)
    updated, outcome = apply_filament_cost(content, 19.9)
    assert outcome == "written"
    assert json.loads(updated)["filament_cost"] == ["19.90"]


def test_reports_no_change_when_the_price_already_matches():
    content = json.dumps({"filament_cost": ["19.90"]}, indent=4)
    updated, outcome = apply_filament_cost(content, 19.9)
    assert outcome == "unchanged"
    assert updated == content  # byte-identical: an unchanged preset is not rewritten


def test_tolerates_a_bare_scalar_cost():
    # Imported presets vary; the frontend's own reader accepts both shapes.
    content = json.dumps({"filament_cost": "19.90"}, indent=4)
    _, outcome = apply_filament_cost(content, 19.9)
    assert outcome == "unchanged"


def test_preserves_every_other_key():
    content = json.dumps({"name": "X", "filament_vendor": ["Polymaker"], "custom": {"a": 1}}, indent=4)
    updated, _ = apply_filament_cost(content, 19.9)
    data = json.loads(updated)
    assert data["name"] == "X"
    assert data["filament_vendor"] == ["Polymaker"]
    assert data["custom"] == {"a": 1}


def test_uses_four_space_indent_like_the_frontend():
    content = json.dumps({"name": "X"}, indent=4)
    updated, _ = apply_filament_cost(content, 19.9)
    assert '\n    "name"' in updated


def test_malformed_json_is_unwritable():
    updated, outcome = apply_filament_cost("{not json", 19.9)
    assert outcome == "unwritable"
    assert updated == "{not json"


def test_non_object_json_is_unwritable():
    updated, outcome = apply_filament_cost("[1, 2]", 19.9)
    assert outcome == "unwritable"
    assert updated == "[1, 2]"


def test_empty_content_is_unwritable():
    updated, outcome = apply_filament_cost("", 19.9)
    assert outcome == "unwritable"
    assert updated == ""


def test_rounds_to_two_decimals():
    content = json.dumps({}, indent=4)
    updated, _ = apply_filament_cost(content, 19.899999)
    assert json.loads(updated)["filament_cost"] == ["19.90"]
