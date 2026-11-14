from dataclasses import replace

from backend.app.services.filament_tree import (
    DEFAULT_TARGETS,
    TreeData,
    leaf_targets,
    match_base,
    parse_inherits,
    resolve_leaf,
    resolve_with_sources,
)

RED, BLACK = 1, 2
BASES = {"Bambu PETG Basic @BBL H2S 0.4 nozzle", "Bambu PETG Basic @BBL H2S", "Bambu PETG Basic @base"}
OWN = {
    "nozzle_temperature": ["246"],
    "filament_flow_ratio": ["0.970"],
    "filament_cost": ["1976"],
    "filament_extruder_variant": ["Direct Drive Standard", "Direct Drive High Flow"],
}
TREE = TreeData(
    name="Polymaker PETG",
    brand="Polymaker",
    version="2.4.0.8",
    base_family="Bambu PETG Basic",
    fallback_inherits="Generic PETG",
    own=OWN,
    colors={RED: ("Red", "#C23320"), BLACK: ("Black", "#000000")},
    overrides={},
    source=("H2S", "0.4", None),
    skip_02=None,
    material="PETG",
)


def test_leaf_name_and_compat():
    leaf = resolve_leaf(TREE, "H2S", "0.4", RED, BASES)
    assert leaf["name"] == "Polymaker PETG - Red @H2S 0.4"
    assert leaf["filament_settings_id"] == ["Polymaker PETG - Red @H2S 0.4"]
    assert leaf["compatible_printers"] == ["Bambu Lab H2S 0.4 nozzle"]
    assert leaf["default_filament_colour"] == ["#C23320"]
    assert leaf["filament_vendor"] == ["Polymaker"]
    assert leaf["from"] == "User"
    assert leaf["inherits"] == "Bambu PETG Basic @BBL H2S 0.4 nozzle"
    assert leaf["version"] == "2.4.0.8"
    assert leaf["nozzle_temperature"] == ["246"]


def test_match_base_prefers_nozzle_then_machine_then_base():
    bases = {"Bambu PETG Basic @BBL H2C 0.8 nozzle", "Bambu PETG Basic @BBL H2C", "Bambu PETG Basic @base"}
    assert match_base("Bambu PETG Basic", "H2C", "0.8", bases, "x") == "Bambu PETG Basic @BBL H2C 0.8 nozzle"
    assert match_base("Bambu PETG Basic", "H2C", "0.6", bases, "x") == "Bambu PETG Basic @BBL H2C"
    assert match_base("Bambu PETG Basic", "X2D", "0.4", bases, "x") == "Bambu PETG Basic @base"
    assert match_base("Nope", "X2D", "0.4", bases, "Generic PC") == "Generic PC"


def test_root_nozzle_bound_never_copied():
    tree = replace(TREE, own={**OWN, "filament_max_volumetric_speed": ["12"], "name": ["evil"]})
    leaf = resolve_leaf(tree, "H2S", "0.2", RED, BASES)
    assert "filament_max_volumetric_speed" not in leaf
    assert leaf["name"] == "Polymaker PETG - Red @H2S 0.2"


def test_nozzle_bound_kept_from_lower_levels():
    tree = replace(TREE, overrides={("H2S", "0.4", 0): {"pressure_advance": ["0.03"]}})
    assert resolve_leaf(tree, "H2S", "0.4", RED, BASES)["pressure_advance"] == ["0.03"]
    assert "pressure_advance" not in resolve_leaf(tree, "H2S", "0.6", RED, BASES)


def test_order_colour_beats_nozzle_beats_machine_beats_root():
    ov = {
        ("H2S", "", 0): {"nozzle_temperature": ["1"]},
        ("H2S", "0.4", 0): {"nozzle_temperature": ["2"]},
        ("H2S", "0.4", RED): {"nozzle_temperature": ["3"]},
    }
    tree = replace(TREE, overrides=ov)
    assert resolve_leaf(tree, "H2S", "0.4", RED, BASES)["nozzle_temperature"] == ["3"]
    assert resolve_leaf(tree, "H2S", "0.4", BLACK, BASES)["nozzle_temperature"] == ["2"]
    assert resolve_leaf(tree, "H2S", "0.6", BLACK, BASES)["nozzle_temperature"] == ["1"]
    assert resolve_leaf(tree, "H2D", "0.6", BLACK, BASES)["nozzle_temperature"] == ["246"]


def test_order_leaf_beats_colourwide_beats_nozzle():
    ov = {
        ("H2S", "0.4", 0): {"nozzle_temperature": ["2"]},
        ("", "", RED): {"nozzle_temperature": ["4"], "pressure_advance": ["9"]},
        ("H2S", "0.6", RED): {"nozzle_temperature": ["5"]},
    }
    tree = replace(TREE, overrides=ov)
    assert resolve_leaf(tree, "H2S", "0.4", RED, BASES)["nozzle_temperature"] == ["4"]
    assert resolve_leaf(tree, "H2S", "0.6", RED, BASES)["nozzle_temperature"] == ["5"]
    assert resolve_leaf(tree, "X2D", "0.8", RED, BASES)["nozzle_temperature"] == ["4"]
    assert resolve_leaf(tree, "H2S", "0.4", BLACK, BASES)["nozzle_temperature"] == ["2"]
    # nozzle-bound keys are dropped at colour-wide, like at the root
    assert "pressure_advance" not in resolve_leaf(tree, "H2S", "0.4", RED, BASES)
    node = resolve_with_sources(tree, None, None, RED)
    assert node["nozzle_temperature"] == (["4"], "colorwide")
    assert node["filament_cost"] == (["1976"], "root")
    assert "pressure_advance" not in node
    assert resolve_with_sources(tree, "H2S", "0.4", RED)["nozzle_temperature"] == (["4"], "colorwide")


def test_own_value_survives_root_change():
    tree = replace(TREE, overrides={("H2S", "0.4", RED): {"filament_flow_ratio": ["0.9"]}})
    changed = replace(tree, own={**OWN, "filament_flow_ratio": ["1.0"]})
    assert resolve_leaf(changed, "H2S", "0.4", RED, BASES)["filament_flow_ratio"] == ["0.9"]
    assert resolve_leaf(changed, "H2S", "0.4", BLACK, BASES)["filament_flow_ratio"] == ["1.0"]


PA6 = replace(TREE, name="SUNLU PA6-CF", material="PA6-CF")


def test_abrasive_skips_02():
    assert ("H2S", "0.2", BLACK) not in leaf_targets(PA6, DEFAULT_TARGETS)
    assert ("H2S", "0.2", BLACK) in leaf_targets(replace(PA6, skip_02=False), DEFAULT_TARGETS)
    assert len(leaf_targets(TREE, DEFAULT_TARGETS)) == 16 * len(TREE.colors)


def test_resolve_with_sources_labels():
    tree = replace(TREE, overrides={("H2S", "0.4", 0): {"pressure_advance": ["0.03"]}})
    src = resolve_with_sources(tree, "H2S", "0.4", None)
    assert src["nozzle_temperature"] == (["246"], "root")
    assert src["pressure_advance"] == (["0.03"], "nozzle")
    assert "pressure_advance" not in resolve_with_sources(tree, "H2S", None, None)
    root = resolve_with_sources(replace(tree, own={**OWN, "pressure_advance": ["1"]}), None, None, None)
    assert "pressure_advance" not in root


def test_parse_inherits():
    assert parse_inherits("Bambu PETG Basic @BBL H2S 0.6 nozzle") == ("Bambu PETG Basic", "H2S", "0.6")
    assert parse_inherits("Generic PP @base") == ("Generic PP", None, None)
    assert parse_inherits("Generic PC") == ("Generic PC", None, None)
