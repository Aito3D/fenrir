"""Pure resolver: filament tree (root > machine > nozzle > colour) -> full Orca filament preset JSON per leaf."""

import json
import re
from collections.abc import Callable
from dataclasses import dataclass

NOZZLE_BOUND_KEYS = frozenset(
    {"filament_max_volumetric_speed", "pressure_advance", "enable_pressure_advance", "filament_start_gcode"}
)
IDENTITY_KEYS = frozenset(
    {
        "name",
        "filament_settings_id",
        "from",
        "inherits",
        "version",
        "filament_vendor",
        "default_filament_colour",
        "compatible_printers",
    }
)
# Orca-side metadata that is never a tree value
SKIP_KEYS = IDENTITY_KEYS | {
    "type",
    "setting_id",
    "base_id",
    "filament_id",
    "user_id",
    "updated_time",
    "instantiation",
    "is_custom_defined",
    "compatible_printers_condition",
    "compatible_prints",
    "compatible_prints_condition",
}
# Keys of a Bambu base preset that describe the base itself: a flattened leaf must not carry them
_BASE_ONLY_KEYS = (SKIP_KEYS - {"filament_id"}) | {"include", "description", "renamed_from", "alias"}
DEFAULT_TARGETS = {"machines": ["X2D", "H2S", "H2D", "H2C"], "nozzles": ["0.2", "0.4", "0.6", "0.8"]}

_ABRASIVE = re.compile(r"(CF|GF)\b", re.IGNORECASE)
_INHERITS = re.compile(r"^(?P<fam>.+?) @(?:base|BBL (?P<m>\S+)(?: (?P<n>\S+) nozzle)?)$")


@dataclass(frozen=True)
class TreeData:
    name: str
    brand: str
    version: str
    base_family: str
    fallback_inherits: str
    own: dict
    colors: dict[int, tuple[str, str]]  # id -> (name, hex)
    overrides: dict[tuple[str, str, int], dict]  # (machine, nozzle, color_id)
    source: tuple[str, str, int | None]
    skip_02: bool | None
    material: str


def is_abrasive(tree: TreeData) -> bool:
    if tree.skip_02 is not None:
        return tree.skip_02
    return bool(_ABRASIVE.search(tree.material) or _ABRASIVE.search(tree.name))


def leaf_targets(tree: TreeData, targets: dict) -> list[tuple[str, str, int]]:
    skip_02 = is_abrasive(tree)
    return [
        (m, n, c)
        for m in targets["machines"]
        for n in targets["nozzles"]
        if not (skip_02 and n == "0.2")
        for c in tree.colors
    ]


def leaf_groups(tree: TreeData, targets: dict, base_names: set[str]) -> list[tuple[str, str, int]]:
    """The leaves as generated. With ``merge_nozzles``, nozzles of one machine and colour whose presets would be
    identical (same values, same Bambu base) share one leaf whose nozzle reads "0.6+0.8"."""
    if not targets.get("merge_nozzles"):
        return leaf_targets(tree, targets)
    groups: dict[tuple, list[str]] = {}
    for m, n, c in leaf_targets(tree, targets):
        values = {k: v for k, (v, _) in resolve_with_sources(tree, m, n, c).items()}
        base = match_base(tree.base_family, m, n, base_names, tree.fallback_inherits)
        groups.setdefault((m, c, json.dumps([values, base], sort_keys=True, default=str)), []).append(n)
    return [(m, "+".join(nozzles), c) for (m, c, _), nozzles in groups.items()]


def leaf_name(tree: TreeData, machine: str, nozzle: str, color_id: int) -> str:
    return f"{tree.name} - {tree.colors[color_id][0]} @{machine} {nozzle}"


def target_machine(machine: str, machines: list[str]) -> str | None:
    """The target that covers ``machine``: itself, or the joined target ("H2C+H2D") it is part of."""
    return next((t for t in machines if machine in t.split("+")), None)


def match_base(base_family: str, machine: str, nozzle: str, base_names: set[str], fallback: str) -> str:
    machine = machine.split("+")[0]  # joined printers share one preset: the first one gives the Bambu base
    for cand in (
        f"{base_family} @BBL {machine} {nozzle} nozzle",
        f"{base_family} @BBL {machine}",
        f"{base_family} @base",
    ):
        if cand in base_names:
            return cand
    return fallback


def parse_inherits(inherits: str) -> tuple[str, str | None, str | None]:
    m = _INHERITS.match(inherits)
    return (m["fam"], m["m"], m["n"]) if m else (inherits, None, None)


def resolve_with_sources(
    tree: TreeData, machine: str | None, nozzle: str | None, color_id: int | None
) -> dict[str, tuple[object, str]]:
    """Every key a node receives or owns -> (value, level); the deepest level that sets a key wins.

    (None, None, cid) is the colour-wide node: that colour on every machine and nozzle.
    """
    layers: list[tuple[str, dict]] = [("root", {k: v for k, v in tree.own.items() if k not in NOZZLE_BOUND_KEYS})]
    if machine is not None:
        layers.append(("machine", tree.overrides.get((machine, "", 0), {})))
        if nozzle is not None:
            layers.append(("nozzle", tree.overrides.get((machine, nozzle, 0), {})))
    if color_id is not None and (machine is None or nozzle is not None):
        colorwide = tree.overrides.get(("", "", color_id), {})
        layers.append(("colorwide", {k: v for k, v in colorwide.items() if k not in NOZZLE_BOUND_KEYS}))
        if machine is not None:
            layers.append(("color", tree.overrides.get((machine, nozzle or "", color_id), {})))
    out: dict[str, tuple[object, str]] = {}
    for level, values in layers:
        for k, v in values.items():
            if k not in IDENTITY_KEYS:
                out[k] = (v, level)
    return out


def resolve_leaf(
    tree: TreeData,
    machine: str,
    nozzle: str,
    color_id: int,
    base_names: set[str],
    base_values: Callable[[str], dict] | None = None,
) -> dict:
    name = leaf_name(tree, machine, nozzle, color_id)
    first = nozzle.split("+")[0]  # merged nozzles hold the same values and base: any of them speaks for all
    inherits = match_base(tree.base_family, machine, first, base_names, tree.fallback_inherits)
    # Bambu Studio only gives a custom filament a short name (no "@X2D 0.4" in its lists, and the same filament
    # followed across a printer switch) when it has no parent: so the leaf carries the base's values itself,
    # filament_id included (a child got it from its parent). A base that cannot be read keeps the parent link.
    base = {k: v for k, v in (base_values(inherits) if base_values else {}).items() if k not in _BASE_ONLY_KEYS}
    leaf = base | {k: v for k, (v, _) in resolve_with_sources(tree, machine, first, color_id).items()}
    leaf.update(
        {
            "name": name,
            "filament_settings_id": [name],
            "from": "User",
            "inherits": "" if base else inherits,
            "version": tree.version,
            "filament_vendor": [tree.brand],
            "default_filament_colour": [tree.colors[color_id][1]],
            "compatible_printers": [f"Bambu Lab {m} {n} nozzle" for m in machine.split("+") for n in nozzle.split("+")],
        }
    )
    return leaf
