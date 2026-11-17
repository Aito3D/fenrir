import json

import pytest

from backend.app.services.filament_tree import IDENTITY_KEYS, NOZZLE_BOUND_KEYS, SKIP_KEYS
from backend.app.services.filament_tree_base import BaseValueReader
from backend.app.services.filament_tree_migration import plan_tree, propose_groups

COMPAT = [f"Bambu Lab {m} 0.4 nozzle" for m in ("H2S", "H2D", "H2C", "X2D")]
MACHINES = ("H2S", "H2D", "H2C", "X2D")


def _preset(pid, color, k="0.035", **extra):
    content = {
        "name": f"Polymaker PETG - {color}",
        "inherits": "Bambu PETG Basic @BBL H2S",
        "from": "User",
        "version": "2.4.0.8",
        "filament_settings_id": [f"Polymaker PETG - {color}"],
        "compatible_printers": COMPAT,
        "filament_start_gcode": [f"M900 L1000 M10\nM900 K{k}"],
        "filament_max_volumetric_speed": ["24"],
        "nozzle_temperature": ["245"],
        **extra,
    }
    return {
        "id": pid,
        "name": f"Polymaker PETG - {color}",
        "brand": "Polymaker",
        "material": "PETG",
        "color": color,
        "color_hex": "#FFFFFF",
        "content": json.dumps(content),
    }


def _group(red_k="0.035", **black_extra):
    return [
        _preset(1, "Black", **black_extra),
        _preset(2, "Red", k=red_k, fan_max_speed=["60"]),
        _preset(3, "White", fan_max_speed=["60"]),
    ]


def _plan(presets, base=lambda _inherits: {}):
    return plan_tree(presets, 3, "H2S", "0.4", base)


def test_propose_groups_picks_white_and_inherits_machine():
    [group] = propose_groups(_group())
    assert group.prefix == "Polymaker PETG"
    assert sorted(group.preset_ids) == [1, 2, 3]
    assert group.proposed_source_preset_id == 3
    assert (group.proposed_machine, group.proposed_nozzle) == ("H2S", "0.4")


def test_propose_groups_nozzle_from_compat_when_inherits_has_none():
    row = _preset(9, "Black", compatible_printers=["Bambu Lab H2S 0.6 nozzle"])
    row["name"] = "SUNLU PA6-GF - Black"
    content = json.loads(row["content"])
    content["inherits"] = "Bambu PA6-GF @BBL H2S"
    row["content"] = json.dumps(content)
    [group] = propose_groups([row])
    assert (group.prefix, group.proposed_machine, group.proposed_nozzle) == ("SUNLU PA6-GF", "H2S", "0.6")


def test_propose_groups_ignores_inherits_machine_outside_targets():
    compat = [f"Bambu Lab {m} 0.4 nozzle" for m in ("H2S", "H2D", "H2C", "X2D")]
    row = _preset(9, "White", compatible_printers=compat)
    row["name"] = "Polymaker ASA - White"
    content = json.loads(row["content"])
    content["inherits"] = "Bambu ABS @BBL X1C"
    row["content"] = json.dumps(content)
    [group] = propose_groups([row], targets={"machines": ["X2D", "H2S", "H2D", "H2C"], "nozzles": ["0.4"]})
    assert (group.proposed_machine, group.proposed_nozzle) == ("H2S", "0.4")
    # neither inherits nor compat names a target machine: H2S / 0.4
    [group] = propose_groups([row], targets={"machines": ["P1S"], "nozzles": ["0.6"]})
    assert (group.proposed_machine, group.proposed_nozzle) == ("H2S", "0.4")


def test_colour_name_strips_trailing_at_suffix():
    row = _preset(9, "White")
    row["name"] = "eSUN PLA - White @BBL H2S 0.4mm"
    [group] = propose_groups([row])
    assert group.prefix == "eSUN PLA"
    assert plan_tree([row], 9, "H2S", "0.4", lambda _i: {})["colors"][0][1] == "White"


def test_propose_groups_warns_and_skips_managed():
    rows = _group()
    content = json.loads(rows[0]["content"])
    content["compatible_printers"] = []
    content["inherits"] = "Bambu PETG HF @BBL H2S"
    rows[0]["content"] = json.dumps(content)
    [group] = propose_groups(rows, exclude_ids={2})
    assert sorted(group.preset_ids) == [1, 3]
    assert any("inherits" in w for w in group.warnings)
    assert any("compatible_printers" in w for w in group.warnings)


def test_migration_root_has_no_identity_or_nozzle_keys():
    plan = _plan(_group())
    own = plan["tree"]["own"]
    assert own == {"nozzle_temperature": ["245"], "fan_max_speed": ["60"]}
    assert not (set(own) & (IDENTITY_KEYS | NOZZLE_BOUND_KEYS))
    assert plan["tree"]["name"] == "Polymaker PETG"
    assert plan["tree"]["base_family"] == "Bambu PETG Basic"
    assert plan["colors"][0] == (3, "White", "#FFFFFF")


def test_migration_skips_orca_metadata_keys():
    meta = dict.fromkeys(SKIP_KEYS - IDENTITY_KEYS, "x")
    presets = [{**p, "content": json.dumps({**json.loads(p["content"]), **meta})} for p in _group()]
    own = _plan(presets)["tree"]["own"]
    assert own == {"nozzle_temperature": ["245"], "fan_max_speed": ["60"]}


def test_migration_shared_pa_on_nozzle_nodes():
    plan = _plan(_group(fan_max_speed=["60"]))
    ov = plan["overrides"]
    for m in MACHINES:
        assert ov[(m, "0.4", 0)] == {
            "filament_start_gcode": ["M900 L1000 M10\nM900 K0.035"],
            "filament_max_volumetric_speed": ["24"],
        }
    assert not [k for k in ov if k[2] != 0]


def test_migration_differing_pa_on_colour_leaves():
    plan = _plan(_group(red_k="0.030", fan_max_speed=["60"]))
    ov = plan["overrides"]
    gcode = "filament_start_gcode"
    for m in MACHINES:
        assert ov[(m, "0.4", 2)][gcode] == ["M900 L1000 M10\nM900 K0.030"]
        assert ov[(m, "0.4", 1)][gcode] == ["M900 L1000 M10\nM900 K0.035"]
        # MVS is still shared, so it stays on the node
        assert ov[(m, "0.4", 0)]["filament_max_volumetric_speed"] == ["24"]
    # source leaf (H2S 0.4 White) has no colour values; its PA sits on the node
    assert (("H2S", "0.4", 3)) not in ov
    assert ov[("H2S", "0.4", 0)][gcode] == ["M900 L1000 M10\nM900 K0.035"]
    for m in ("H2D", "H2C", "X2D"):
        assert ov[(m, "0.4", 3)][gcode] == ["M900 L1000 M10\nM900 K0.035"]
        assert gcode not in ov[(m, "0.4", 0)]


def test_migration_colour_missing_root_key_gets_base_value():
    plan = _plan(_group(), base=lambda inherits: {"fan_max_speed": ["80"]})
    ov = plan["overrides"]
    assert ov[("", "", 1)] == {"fan_max_speed": ["80"]}
    assert [k for k in ov if k[2] == 1] == [("", "", 1)]  # not copied onto leaves
    assert not [k for k in ov if k[2] == 2]  # Red matches the root


def test_migration_missing_base_value_warns():
    plan = _plan(_group())
    assert any("fan_max_speed" in w for w in plan["warnings"])
    assert not [k for k in plan["overrides"] if k[2] == 1]


def test_base_reader_walks_inherits(monkeypatch):
    files = {
        "a.json": json.dumps({"name": "A", "inherits": "B", "x": ["1"]}),
        "b.json": json.dumps({"name": "B", "inherits": "A", "x": ["0"], "y": ["2"]}),
    }
    monkeypatch.setattr("backend.app.services.filament_tree_base.read_bundle_preset", files.get)
    reader = BaseValueReader({"A": "a.json", "B": "b.json", "C": "missing.json"})
    assert reader.values("A")["x"] == ["1"] and reader.values("A")["y"] == ["2"]
    assert reader.values("C") == {} and reader.values("nope") == {}


def test_base_value_reader_merges_include_templates(monkeypatch):
    files = {
        "t.json": json.dumps({"name": "T", "filament_extruder_variant": ["Std", "HF"], "x": ["9", "9"]}),
        "a.json": json.dumps({"name": "A", "filament_extruder_variant": ["Std"], "x": ["1"]}),
        "b.json": json.dumps({"name": "B", "inherits": "A", "include": ["T", "gone"], "y": ["2"]}),
    }
    monkeypatch.setattr("backend.app.services.filament_tree_base.read_bundle_preset", files.get)
    values = BaseValueReader({"A": "a.json", "B": "b.json", "T": "t.json"}).values("B")
    assert values["filament_extruder_variant"] == ["Std", "HF"]
    assert values["x"] == ["9", "9"]  # like Bambu Studio: an include overrides what the parent set
    assert values["y"] == ["2"] and values["name"] == "B"  # the preset's own values win over the template


def test_source_pair_outside_compat_keeps_nozzle_values():
    gcode = "filament_start_gcode"
    shared = plan_tree(_group(fan_max_speed=["60"]), 3, "H2S", "0.6", lambda _i: {})["overrides"]
    assert shared[("H2S", "0.6", 0)][gcode] == ["M900 L1000 M10\nM900 K0.035"]
    assert shared[("H2S", "0.6", 0)]["filament_max_volumetric_speed"] == ["24"]
    differ = plan_tree(_group(red_k="0.030", fan_max_speed=["60"]), 3, "H2S", "0.6", lambda _i: {})["overrides"]
    assert differ[("H2S", "0.6", 0)][gcode] == ["M900 L1000 M10\nM900 K0.035"]
    assert differ[("H2S", "0.6", 2)][gcode] == ["M900 L1000 M10\nM900 K0.030"]
    assert differ[("H2S", "0.6", 1)][gcode] == ["M900 L1000 M10\nM900 K0.035"]


def test_plan_refuses_mixed_base_families():
    rows = _group()
    content = json.loads(rows[1]["content"])
    content["inherits"] = "Bambu PETG HF @BBL H2S"
    rows[1]["content"] = json.dumps(content)
    with pytest.raises(ValueError, match="Polymaker PETG - Red"):
        _plan(rows)
    # a different machine/nozzle suffix on the same family is fine
    content["inherits"] = "Bambu PETG Basic @BBL X2D 0.4 nozzle"
    rows[1]["content"] = json.dumps(content)
    _plan(rows)


def test_colour_name_falls_back_to_preset_id():
    rows = _group(fan_max_speed=["60"])
    rows[0]["name"], rows[0]["color"] = "Polymaker PETG", ""
    plan = _plan(rows)
    assert (1, "Colour 1", "#FFFFFF") in plan["colors"]
    assert any("no colour name" in w for w in plan["warnings"])
