"""Pure resolver: filament tree (root > machine > nozzle > colour) -> full Orca filament preset JSON per leaf."""

import re
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


def leaf_name(tree: TreeData, machine: str, nozzle: str, color_id: int) -> str:
    return f"{tree.name} - {tree.colors[color_id][0]} @{machine} {nozzle}"


def match_base(base_family: str, machine: str, nozzle: str, base_names: set[str], fallback: str) -> str:
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


def resolve_leaf(tree: TreeData, machine: str, nozzle: str, color_id: int, base_names: set[str]) -> dict:
    name = leaf_name(tree, machine, nozzle, color_id)
    leaf = {k: v for k, (v, _) in resolve_with_sources(tree, machine, nozzle, color_id).items()}
    leaf.update(
        {
            "name": name,
            "filament_settings_id": [name],
            "from": "User",
            "inherits": match_base(tree.base_family, machine, nozzle, base_names, tree.fallback_inherits),
            "version": tree.version,
            "filament_vendor": [tree.brand],
            "default_filament_colour": [tree.colors[color_id][1]],
            "compatible_printers": [f"Bambu Lab {machine} {nozzle} nozzle"],
        }
    )
    return leaf
