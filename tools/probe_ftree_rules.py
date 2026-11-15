"""Filament-tree campaign (F1) golden probe: the pure rules on fixed inputs.

  resolver   key sets, resolve_with_sources / resolve_leaf / leaf_name / match_base /
             parse_inherits / is_abrasive / leaf_targets
  pull       plan_pull: colour edit, source-leaf edit (root / machine / node), conflict,
             coincident value, never-synced leaf, legacy, candidates, ignored, missing
  migration  propose_groups and plan_tree: source pick, targets, warnings, colour-wide
             differences, nozzle-bound splits, base fallbacks, the refusals
  base       BaseValueReader over a temp bundle folder: inherits chain, cycle, bad file
  schemas    request models: what they accept, what they refuse (error type + location)

No database, no network. Exceptions are part of the contract and printed as such.
"""
import json
import os
import sys
from dataclasses import asdict, is_dataclass, replace

sys.path.insert(0, "tools")
import probe_ftree_lib as lib  # noqa: E402  (temp DATA_DIR before the app is imported)

from pydantic import ValidationError  # noqa: E402

from backend.app.core.config import settings  # noqa: E402
from backend.app.schemas import filament_tree as schemas  # noqa: E402
from backend.app.services import filament_tree as ft  # noqa: E402
from backend.app.services.filament_tree_base import BaseValueReader  # noqa: E402
from backend.app.services.filament_tree_migration import plan_tree, propose_groups  # noqa: E402
from backend.app.services.filament_tree_pull import LeafState, plan_pull  # noqa: E402


def plain(v):
    if is_dataclass(v) and not isinstance(v, type):
        return plain(asdict(v))
    if isinstance(v, dict):
        return {("|".join(map(str, k)) if isinstance(k, tuple) else str(k)): plain(x) for k, x in v.items()}
    if isinstance(v, (set, frozenset)):
        return sorted(plain(x) for x in v)
    if isinstance(v, (list, tuple)):
        return [plain(x) for x in v]
    return v


def show(label, fn):
    try:
        out = plain(fn())
    except Exception as e:  # the refusal is the behaviour
        out = {"__raised__": f"{type(e).__name__}: {e}"}
    print(f"--- {label}")
    print(json.dumps(out, indent=1, sort_keys=True, ensure_ascii=False))


# ---------------------------------------------------------------- resolver
print("=== resolver")
show("key sets", lambda: {"IDENTITY_KEYS": ft.IDENTITY_KEYS, "SKIP_KEYS": ft.SKIP_KEYS, "NOZZLE_BOUND_KEYS": ft.NOZZLE_BOUND_KEYS, "DEFAULT_TARGETS": ft.DEFAULT_TARGETS})

RED, BLACK = 1, 2
BASES = {"Bambu PETG Basic @BBL H2S 0.4 nozzle", "Bambu PETG Basic @BBL H2S", "Bambu PETG Basic @base"}
TREE = ft.TreeData(
    name="Polymaker PETG",
    brand="Polymaker",
    version="2.4.0.8",
    base_family="Bambu PETG Basic",
    fallback_inherits="Generic PETG",
    own={
        "nozzle_temperature": ["246"],
        "filament_flow_ratio": ["0.970"],
        "filament_cost": ["1976"],
        "filament_extruder_variant": ["Direct Drive Standard", "Direct Drive High Flow"],
        "pressure_advance": ["0.01"],  # nozzle-bound: never read from the root
        "name": "must never leak",  # identity: never a tree value
    },
    colors={RED: ("Red", "#C23320"), BLACK: ("Black", "#000000")},
    overrides={
        ("H2S", "", 0): {"hot_plate_temp": ["75"], "nozzle_temperature": ["247"]},
        ("H2S", "0.4", 0): {"pressure_advance": ["0.03"], "filament_start_gcode": ["M900 K0.03"], "inherits": "leak"},
        ("H2D", "0.6", 0): {"filament_max_volumetric_speed": ["20"]},
        ("", "", BLACK): {"fan_min_speed": ["40"], "nozzle_temperature": ["250"], "filament_max_volumetric_speed": ["9"]},
        ("H2S", "0.4", BLACK): {"nozzle_temperature": ["252"], "pressure_advance": ["0.05"]},
        ("H2S", "", BLACK): {"hot_plate_temp": ["99"]},
    },
    source=("H2S", "0.4", RED),
    skip_02=None,
    material="PETG",
)
NODES = [
    (None, None, None), ("H2S", None, None), ("H2S", "0.4", None), ("H2D", "0.6", None), ("X2D", "0.8", None),
    (None, None, RED), (None, None, BLACK), ("H2S", None, BLACK), ("H2S", "0.4", RED), ("H2S", "0.4", BLACK),
    ("H2D", "0.6", BLACK), (None, "0.4", None), (None, "0.4", BLACK), ("H2S", "0.4", 99),
]
for node in NODES:
    show(f"resolve_with_sources {node}", lambda node=node: ft.resolve_with_sources(TREE, *node))
for node in [("H2S", "0.4", RED), ("H2S", "0.4", BLACK), ("H2S", "0.6", BLACK), ("X2D", "0.2", RED), ("H2S", "0.4", 99)]:
    show(f"resolve_leaf {node}", lambda node=node: ft.resolve_leaf(TREE, *node, BASES))
    show(f"leaf_name {node}", lambda node=node: ft.leaf_name(TREE, *node))
show("resolve_leaf no bases -> fallback", lambda: ft.resolve_leaf(TREE, "H2S", "0.4", RED, set()))
for args in [
    ("Bambu PETG Basic", "H2S", "0.4", BASES, "FB"), ("Bambu PETG Basic", "H2S", "0.6", BASES, "FB"),
    ("Bambu PETG Basic", "X2D", "0.4", BASES, "FB"), ("Generic PLA", "H2S", "0.4", BASES, "FB"),
    ("Generic PLA", "H2S", "0.4", set(), ""), ("", "", "", {" @BBL  "}, "FB"),
]:
    show(f"match_base {args[:3]} bases={len(args[3])} fallback={args[4]!r}", lambda args=args: ft.match_base(*args))
for s in ["Bambu PETG Basic @BBL H2S 0.4 nozzle", "Bambu PETG Basic @BBL H2S", "Bambu PETG Basic @base", "Generic PETG",
          "", "A @B @base", "X @BBL H2S 0.4", "X @BBL H2S 0.4 nozzle extra", "X @BBL", " @base", "Fam @BBL A1M 0.2 nozzle"]:
    show(f"parse_inherits {s!r}", lambda s=s: ft.parse_inherits(s))
for skip in (None, True, False):
    for material, name in [("PETG", "Polymaker PETG"), ("PA6-CF", "SUNLU PA6-CF"), ("PLA-GF", "X"), ("pla-cf", "x"), ("PETG", "Fiberon PET CF"),
                           ("CFX", "X CFX"), ("PA6-CF15", "Y"), ("GF", "GF"), ("", "")]:
        t = replace(TREE, skip_02=skip, material=material, name=name)
        show(f"is_abrasive skip_02={skip} material={material!r} name={name!r}", lambda t=t: ft.is_abrasive(t))
show("leaf_targets default", lambda: ft.leaf_targets(TREE, ft.DEFAULT_TARGETS))
show("leaf_targets abrasive (no 0.2)", lambda: ft.leaf_targets(replace(TREE, material="PA6-CF"), ft.DEFAULT_TARGETS))
show("leaf_targets skip_02 False on CF", lambda: ft.leaf_targets(replace(TREE, material="PA6-CF", skip_02=False), {"machines": ["H2S"], "nozzles": ["0.2", "0.4"]}))
show("leaf_targets no colours", lambda: ft.leaf_targets(replace(TREE, colors={}), ft.DEFAULT_TARGETS))
show("leaf_targets missing key", lambda: ft.leaf_targets(TREE, {"machines": ["H2S"]}))

# ---------------------------------------------------------------- pull planner
print("=== pull")
_SYNCED = object()


def leaf(name="T - Red @H2S 0.4", generated=None, baseline=_SYNCED, is_source=False, color_id=1, **kw):
    gen = generated or {"nozzle_temperature": ["246"], "filament_start_gcode": ["M900 K0.04"], "name": name, "hot_plate_temp": ["70"]}
    return LeafState(1, "H2S", "0.4", color_id, name, gen, dict(gen) if baseline is _SYNCED else baseline, is_source, **kw)


def orca(name, **vals):
    return {"id": "x-" + name, "name": name, "content": {"type": "filament", "name": name, **vals}}


N = "T - Red @H2S 0.4"
PULL = {
    "nothing from orca": ([], [leaf()], set()),
    "unchanged leaf": ([orca(N, nozzle_temperature=["246"], filament_start_gcode=["M900 K0.04"], hot_plate_temp=["70"])], [leaf()], set()),
    "leaf edit lands on colour": ([orca(N, nozzle_temperature=["250"], filament_start_gcode=["M900 K0.1"])], [leaf()], set()),
    "source leaf edit: root and node": ([orca(N, nozzle_temperature=["250"], filament_start_gcode=["M900 K0.1"])], [leaf(is_source=True)], set()),
    "source leaf edit: owned at machine / node": (
        [orca(N, nozzle_temperature=["250"], hot_plate_temp=["80"], fan_min_speed=["10"])],
        [leaf(is_source=True, owned_at={"nozzle_temperature": "machine", "hot_plate_temp": "node"})], set()),
    "conflict: both sides changed": ([orca(N, nozzle_temperature=["240"])], [leaf(generated={"nozzle_temperature": ["250"]}, baseline={"nozzle_temperature": ["246"]})], set()),
    "coincident: both changed to the same": ([orca(N, nozzle_temperature=["250"], hot_plate_temp=["71"])],
                                             [leaf(generated={"nozzle_temperature": ["250"], "hot_plate_temp": ["70"]}, baseline={"nozzle_temperature": ["246"], "hot_plate_temp": ["70"]})], set()),
    "never synced: every difference is a conflict": ([orca(N, nozzle_temperature=["250"], hot_plate_temp=["70"], setting_id="abc", extra_key="1")], [leaf(baseline=None)], set()),
    "skip keys and orca metadata ignored": ([orca(N, nozzle_temperature=["246"], filament_start_gcode=["M900 K0.04"], hot_plate_temp=["70"], setting_id="s", updated_time=5, inherits="x", filament_vendor=["Z"])], [leaf()], set()),
    "key dropped in orca counts as ignored": ([orca(N, nozzle_temperature=["246"])], [leaf()], set()),
    "new key in orca": ([orca(N, nozzle_temperature=["246"], filament_start_gcode=["M900 K0.04"], hot_plate_temp=["70"], brand_new=["1"])], [leaf()], set()),
    "non-filament entry skipped": ([{"id": "p", "name": N, "content": {"type": "process", "nozzle_temperature": ["1"]}}, {"id": "q", "name": "No content"}], [leaf()], set()),
    "legacy colour name": ([orca("T - Red")], [leaf()], {"T - Red"}),
    "candidates and ignored": (
        [orca("eSUN PLA+ - Blue", **{"from": "User"}), orca("Lower - Case", **{"from": "user"}), orca("No From"), orca("System One", **{"from": "system"}),
         orca("Other - Red @H2S 0.4", **{"from": "User"}), orca("Other @X1C 0.4", **{"from": "User"}), {"name": "No Id", "content": {"type": "filament"}}, {"id": "n", "content": {"type": "filament"}}],
        [leaf()], set()),
    "missing: exported or synced leaves orca no longer has": (
        [], [leaf(), leaf(name="T - Blue @H2S 0.4", baseline=None, color_id=2), leaf(name="T - Green @H2S 0.4", baseline=None, color_id=3, exported=True)], set()),
    "two leaves, one entry each": (
        [orca(N, nozzle_temperature=["250"]), orca("T - Blue @H2S 0.4", nozzle_temperature=["251"])],
        [leaf(is_source=True), leaf(name="T - Blue @H2S 0.4", color_id=2)], set()),
    "value removed on fenrir side": ([orca(N, nozzle_temperature=["250"])], [leaf(generated={"hot_plate_temp": ["70"]}, baseline={"nozzle_temperature": ["246"], "hot_plate_temp": ["70"]})], set()),
}
for label, args in PULL.items():
    show(f"plan_pull: {label}", lambda args=args: plan_pull(*args))

# ---------------------------------------------------------------- migration planner
print("=== migration")
COMPAT = [f"Bambu Lab {m} 0.4 nozzle" for m in ("H2S", "H2D", "H2C", "X2D")]


def preset(pid, color, k="0.035", prefix="Polymaker PETG", drop=(), **extra):
    content = {
        "name": f"{prefix} - {color}",
        "inherits": "Bambu PETG Basic @BBL H2S",
        "from": "User",
        "version": "2.4.0.8",
        "filament_settings_id": [f"{prefix} - {color}"],
        "compatible_printers": COMPAT,
        "filament_start_gcode": [f"M900 L1000 M10\nM900 K{k}"],
        "filament_max_volumetric_speed": ["24"],
        "nozzle_temperature": ["245"],
        **extra,
    }
    for key in drop:
        content.pop(key, None)
    return {"id": pid, "name": f"{prefix} - {color}", "brand": prefix.split(" ")[0], "material": "PETG", "color": color, "color_hex": "#FFFFFF", "content": json.dumps(content)}


def group(red_k="0.035", **black_extra):
    return [preset(1, "Black", **black_extra), preset(2, "Red", k=red_k, fan_max_speed=["60"]), preset(3, "White", fan_max_speed=["60"])]


def named(p, name):
    return {**p, "name": name}


PROPOSE = {
    "white is the source, machine from inherits": (group(),),
    "no white: first by name": ([preset(1, "Black"), preset(2, "Red")],),
    "two groups + excluded ids": (group() + [preset(7, "Blue", prefix="eSUN PLA"), preset(8, "white", prefix="eSUN PLA")], {2}),
    "nozzle from compat": ([preset(9, "Black", prefix="SUNLU PA6-GF", inherits="Bambu PA6-GF @BBL H2S", compatible_printers=["Bambu Lab H2S 0.6 nozzle"])],),
    "inherits machine outside targets": ([preset(9, "White", inherits="Bambu ASA @BBL X1C 0.4 nozzle")],),
    "custom targets": (group(), frozenset(), {"machines": ["A1"], "nozzles": ["0.8"]}),
    "nothing matches: H2S / 0.4 default": ([preset(9, "White", inherits="Generic PETG", compatible_printers=[])],),
    "warnings: different inherits, no compatible_printers": ([preset(1, "Black", inherits="Other @base"), preset(3, "White", drop=("compatible_printers",))],),
    "name without ' - ', and an '@' suffix": ([named(preset(1, "Black"), "Loose"), named(preset(2, "White"), "Polymaker PETG - White @BBL H2S 0.4mm")],),
    "empty": ([],),
}
for label, args in PROPOSE.items():
    show(f"propose_groups: {label}", lambda args=args: propose_groups(*args))

BASE = {"Bambu PETG Basic @BBL H2S": {"fan_max_speed": ["90"], "filament_start_gcode": ["; base"], "cool_plate_temp": ["35"]}}


def base(inherits):
    return BASE.get(inherits, {})


PLAN = {
    "identical colours": (group(), 3, "H2S", "0.4", base),
    "red has its own K": (group(red_k="0.05"), 3, "H2S", "0.4", base),
    "colour-wide difference": (group(nozzle_temperature=["250"], extra_black=["1"]), 3, "H2S", "0.4", base),
    "colour lacks a root key: base value / no base value": (group(), 2, "H2S", "0.4", base),
    "colour lacks a root key, empty base": (group(), 2, "H2S", "0.4", lambda _i: {}),
    "colour lacks a nozzle-bound key": ([preset(1, "Black", drop=("filament_start_gcode",)), preset(3, "White")], 3, "H2S", "0.4", base),
    "colour lacks a nozzle-bound key, empty base": ([preset(1, "Black", drop=("filament_start_gcode",)), preset(3, "White")], 3, "H2S", "0.4", lambda _i: {}),
    "source lacks a nozzle-bound key": ([preset(1, "Black"), preset(3, "White", drop=("filament_start_gcode",))], 3, "H2S", "0.4", base),
    "different compatible_printers per colour": ([preset(1, "Black", compatible_printers=["Bambu Lab H2D 0.6 nozzle"]), preset(3, "White")], 3, "H2S", "0.4", base),
    "source machine not in its compat": (group(), 3, "A1", "0.8", base),
    "no compatible_printers at all": ([preset(1, "Black", drop=("compatible_printers",)), preset(3, "White", drop=("compatible_printers",))], 3, "H2S", "0.4", base),
    "single preset": ([preset(3, "White")], 3, "H2S", "0.4", base),
    "missing colour name": ([named({**preset(1, ""), "color": ""}, "Polymaker PETG - "), preset(3, "White")], 3, "H2S", "0.4", base),
    "no version, no inherits": ([preset(3, "White", drop=("version", "inherits"))], 3, "H2S", "0.4", base),
    "refused: source not in the group": (group(), 99, "H2S", "0.4", base),
    "refused: mixed base families": ([preset(1, "Black", inherits="Bambu PLA Basic @BBL H2S"), preset(3, "White")], 3, "H2S", "0.4", base),
    "refused: unindexed base": (group(), 3, "H2S", "0.4", base, {"Something else"}),
    "known bases all indexed": (group(), 3, "H2S", "0.4", base, {"Bambu PETG Basic @BBL H2S"}),
}
for label, args in PLAN.items():
    show(f"plan_tree: {label}", lambda args=args: plan_tree(*args))

# ---------------------------------------------------------------- base reader
print("=== base")
bundle = os.path.join(lib.ROOT, "bundle")
os.makedirs(bundle)
settings.bambu_studio_bundle_dir = bundle
FILES = {
    "base.json": {"name": "F @base", "a": ["1"], "b": ["1"], "c": ["1"]},
    "mid.json": {"name": "F @BBL H2S", "inherits": "F @base", "b": ["2"]},
    "leaf.json": {"name": "F @BBL H2S 0.4 nozzle", "inherits": "F @BBL H2S", "c": ["3"]},
    "loop-a.json": {"name": "Loop A", "inherits": "Loop B", "x": ["a"]},
    "loop-b.json": {"name": "Loop B", "inherits": "Loop A", "x": ["b"], "y": ["b"]},
    "orphan.json": {"name": "Orphan", "inherits": "Not indexed", "o": ["1"]},
    "bad-parent.json": {"name": "Bad parent", "inherits": "Broken", "p": ["1"]},
}
for fn, data in FILES.items():
    with open(os.path.join(bundle, fn), "w") as f:
        json.dump(data, f)
with open(os.path.join(bundle, "broken.json"), "w") as f:
    f.write("{not json")
reader = BaseValueReader({
    "F @base": "base.json", "F @BBL H2S": "mid.json", "F @BBL H2S 0.4 nozzle": "leaf.json", "Loop A": "loop-a.json", "Loop B": "loop-b.json",
    "Orphan": "orphan.json", "Bad parent": "bad-parent.json", "Broken": "broken.json", "Gone": "gone.json", "Escape": "../x.json",
})
for name in ["F @base", "F @BBL H2S", "F @BBL H2S 0.4 nozzle", "F @BBL H2S 0.4 nozzle", "Loop A", "Loop B", "Orphan", "Bad parent", "Broken", "Gone", "Escape", "Unknown", ""]:
    show(f"BaseValueReader.values {name!r}", lambda name=name: reader.values(name))

# ---------------------------------------------------------------- request schemas
print("=== schemas")


def validate(model, data):
    try:
        return getattr(schemas, model).model_validate(data).model_dump()
    except ValidationError as e:
        return {"__refused__": sorted(f"{'.'.join(map(str, err['loc']))}: {err['type']}" for err in e.errors())}


CREATE = {"brand": "Acme", "material": "PETG", "base_family": "Generic PETG", "color_name": "White", "machine": "H2S", "nozzle": "0.4"}
SCHEMAS = [
    ("TreeCreate", CREATE), ("TreeCreate", {**CREATE, "color_hex": "#FFFFFF"}), ("TreeCreate", {**CREATE, "brand": "a/b"}), ("TreeCreate", {**CREATE, "brand": "a\\b"}),
    ("TreeCreate", {**CREATE, "material": ".."}), ("TreeCreate", {**CREATE, "color_name": "x\ny"}), ("TreeCreate", {**CREATE, "brand": ""}), ("TreeCreate", {**CREATE, "brand": "x" * 201}),
    ("TreeCreate", {**CREATE, "machine": "x" * 33}), ("TreeCreate", {**CREATE, "color_hex": "x" * 33}), ("TreeCreate", {}),
    ("TreeDuplicate", {"name": "A B", "brand": "A"}), ("TreeDuplicate", {"name": "A/B", "brand": ""}),
    ("Targets", {"machines": ["H2S"], "nozzles": ["0.4"]}), ("Targets", {"machines": [], "nozzles": []}), ("Targets", {"machines": ["m"] * 13, "nozzles": ["0.4"] * 9}), ("Targets", {"machines": [""], "nozzles": ["a/b"]}),
    ("NodeUpdate", {}), ("NodeUpdate", {"set": {"nozzle_temperature": ["245"]}, "clear": ["x"]}), ("NodeUpdate", {"set_values": {"a": 1, "b": 1.5, "c": True, "d": "s", "e": ["s", 1, 1.5]}}),
    ("NodeUpdate", {"set": {"Bad-Key": "1"}}), ("NodeUpdate", {"set": {"k": None}}), ("NodeUpdate", {"set": {"k": {"nested": 1}}}), ("NodeUpdate", {"set": {"k": [True]}}), ("NodeUpdate", {"set": {"k": ["x"] * 17}}),
    ("NodeUpdate", {"clear": ["UPPER"]}), ("NodeUpdate", {"machine": "", "nozzle": "0.4"}), ("NodeUpdate", {"machine": "H2S", "nozzle": "0.4", "color_id": "7"}),
    ("BulkNodeUpdate", {"tree_ids": [1, 2], "machine": "H2S", "set": {"k": "v"}}), ("BulkNodeUpdate", {"tree_ids": []}), ("BulkNodeUpdate", {"tree_ids": list(range(201))}),
    ("TreeUpdate", {}), ("TreeUpdate", {"skip_02": None, "brand": "B", "source_machine": "H2D"}), ("TreeUpdate", {"brand": "", "material": "a/b"}),
    ("ColorCreate", {"name": "Red"}), ("ColorCreate", {"name": "", "hex": "x" * 33}), ("ColorUpdate", {"name": "Red"}), ("ColorUpdate", {"name": "R/ed", "hex": "#fff"}),
    ("MigrateRequest", {"groups": []}), ("MigrateRequest", {"groups": [{"prefix": "P", "source_preset_id": 1, "machine": "H2S", "nozzle": "0.4"}]}), ("MigrateRequest", {"groups": [{"prefix": "", "source_preset_id": "x", "machine": "", "nozzle": ""}]}),
    ("ExportRequest", {}), ("ExportRequest", {"tree_id": 3, "changed_only": True}),
    ("ConflictResolveRequest", {"tree_id": 1, "machine": "H2S", "nozzle": "0.4", "color_id": 1, "key": "k", "value": None, "orca_value": ["1"]}),
    ("ConflictResolveRequest", {"tree_id": 1, "machine": "H2S", "nozzle": "0.4", "color_id": 1, "key": "K", "value": {"a": 1}}),
    ("CandidateRequest", {"orca_id": "c1", "name": "eSUN PLA+ - Blue", "brand": "eSUN", "material": "PLA+", "color_name": "Blue", "color_hex": "#00F", "machine": "H2S", "nozzle": "0.4"}),
    ("CandidateRequest", {"orca_id": "", "name": "a/b", "brand": "..", "material": "", "color_name": "x", "color_hex": "", "machine": "H2S", "nozzle": "0.4"}),
]
for model, data in SCHEMAS:
    shown = json.dumps(data, sort_keys=True)
    show(f"{model} {shown if len(shown) < 160 else shown[:157] + '...'}", lambda model=model, data=data: validate(model, data))
