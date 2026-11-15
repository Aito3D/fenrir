"""One-time migration: flat `BRAND MATERIAL - COLOR` presets -> filament trees, snapshot first."""

import json
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.filament_profile import FilamentPreset
from backend.app.models.filament_tree import (
    FilamentTree,
    FilamentTreeColor,
    FilamentTreeLeaf,
    FilamentTreeOverride,
    FilamentTreeSnapshot,
)
from backend.app.services.filament_tree import (
    IDENTITY_KEYS,
    NOZZLE_BOUND_KEYS,
    leaf_targets,
    parse_inherits,
)
from backend.app.services.filament_tree_base import build_base_reader
from backend.app.services.filament_tree_store import get_targets, load_tree, managed_preset_ids, regenerate_tree

logger = logging.getLogger(__name__)
_COMPAT = re.compile(r"^Bambu Lab (\S+) (\d\.\d) nozzle$")
_SKIP = IDENTITY_KEYS | NOZZLE_BOUND_KEYS
_MISSING = object()


@dataclass
class MigrationGroup:
    prefix: str
    preset_ids: list[int]
    proposed_source_preset_id: int
    proposed_machine: str
    proposed_nozzle: str
    warnings: list[str] = field(default_factory=list)


def _prefix(name: str) -> str:
    return name.split(" - ", 1)[0]


def _raw_color_name(preset: dict) -> str:
    return (preset["name"].split(" - ", 1)[1] if " - " in preset["name"] else preset["color"]).strip()


def _color_name(preset: dict) -> str:
    return _raw_color_name(preset) or f"Colour {preset['id']}"


def _compat_pairs(content: dict) -> list[tuple[str, str]]:
    return [(m[1], m[2]) for e in content.get("compatible_printers") or [] if (m := _COMPAT.match(e))]


def propose_groups(presets: list[dict], exclude_ids: frozenset[int] | set[int] = frozenset()) -> list[MigrationGroup]:
    """Group unmanaged presets by name prefix and propose a calibration source for each group."""
    groups: dict[str, list[dict]] = {}
    for p in sorted(presets, key=lambda p: p["name"]):
        if p["id"] not in exclude_ids:
            groups.setdefault(_prefix(p["name"]), []).append(p)
    out = []
    for prefix, rows in groups.items():
        contents = {p["id"]: json.loads(p["content"]) for p in rows}
        source = next((p for p in rows if _color_name(p).strip().lower() == "white"), rows[0])
        src = contents[source["id"]]
        _, machine, nozzle = parse_inherits(src.get("inherits", ""))
        first_m, first_n = next(iter(_compat_pairs(src)), (None, None))
        warnings = []
        if len({c.get("inherits", "") for c in contents.values()}) > 1:
            warnings.append("colours in this group have different inherits (base presets)")
        warnings += [
            f"{p['name']} has no compatible_printers; treated as calibrated on the source machine/nozzle"
            for p in rows
            if not contents[p["id"]].get("compatible_printers")
        ]
        out.append(
            MigrationGroup(
                prefix=prefix,
                preset_ids=[p["id"] for p in rows],
                proposed_source_preset_id=source["id"],
                proposed_machine=machine or first_m or "H2S",
                proposed_nozzle=nozzle or first_n or "0.4",
                warnings=warnings,
            )
        )
    return out


def plan_tree(
    group_presets: list[dict],
    source_preset_id: int,
    machine: str,
    nozzle: str,
    base_values: Callable[[str], dict],
) -> dict:
    """Split a group into root own values + node/colour overrides; colour keys are preset ids (0 = node)."""
    contents = {p["id"]: json.loads(p["content"]) for p in group_presets}
    if source_preset_id not in contents:
        raise ValueError(f"source preset {source_preset_id} is not in the group")
    families = {p["name"]: parse_inherits(contents[p["id"]].get("inherits", ""))[0] for p in group_presets}
    if len(set(families.values())) > 1:
        detail = ", ".join(f"{name} ({fam})" for name, fam in sorted(families.items()))
        raise ValueError(f"colours inherit from different base families, split the group first: {detail}")
    source = next(p for p in group_presets if p["id"] == source_preset_id)
    ordered = [source] + [p for p in group_presets if p["id"] != source_preset_id]
    src = contents[source_preset_id]
    root = {k: v for k, v in src.items() if k not in _SKIP}
    overrides: dict[tuple[str, str, int], dict] = {}
    warnings: list[str] = [
        f"preset {p['id']} has no colour name; named {_color_name(p)!r}" for p in ordered if not _raw_color_name(p)
    ]

    def put(m: str, n: str, c: int, values: dict) -> None:
        overrides.setdefault((m, n, c), {}).update(values)

    def base_value(preset: dict, key: str):
        base = base_values(contents[preset["id"]].get("inherits", ""))
        if key not in base:
            warnings.append(f"{preset['name']}: no base value for {key}, left inherited from the root")
            return _MISSING
        return base[key]

    # A colour's material differences go on its colour-wide node ("", "", colour).
    for p in ordered[1:]:
        c = contents[p["id"]]
        own = {k: v for k, v in c.items() if k not in _SKIP and root.get(k, _MISSING) != v}
        for k in root.keys() - c.keys():
            v = base_value(p, k)
            if v is not _MISSING and v != root[k]:
                own[k] = v
        if own:
            put("", "", p["id"], own)

    def compat(pid: int) -> list[tuple[str, str]]:
        # Every old row becomes the leaf at (machine, nozzle), so that pair always keeps its values.
        pairs = _compat_pairs(contents[pid])
        return pairs if (machine, nozzle) in pairs else [*pairs, (machine, nozzle)]

    for k in sorted(NOZZLE_BOUND_KEYS):
        vals = {pid: c.get(k, _MISSING) for pid, c in contents.items()}
        src_val = vals[source_preset_id]
        shared = all(v == src_val for v in vals.values()) and all(
            c.get("compatible_printers") == src.get("compatible_printers") for c in contents.values()
        )
        if shared:
            if src_val is not _MISSING:
                for m, n in compat(source_preset_id):
                    put(m, n, 0, {k: src_val})
            continue
        for p in ordered:
            pid = p["id"]
            if vals[pid] is _MISSING:
                # the source's value sits on its node; a colour that never had one keeps its base value there
                if pid != source_preset_id and src_val is not _MISSING:
                    v = base_value(p, k)
                    if v is not _MISSING:
                        put(machine, nozzle, pid, {k: v})
                continue
            for m, n in compat(pid):
                on_node = pid == source_preset_id and (m, n) == (machine, nozzle)
                put(m, n, 0 if on_node else pid, {k: vals[pid]})

    inherits = src.get("inherits", "")
    return {
        "tree": {
            "name": _prefix(source["name"]),
            "brand": source["brand"],
            "material": source["material"],
            "version": src.get("version") or "2.4.0.8",
            "base_family": parse_inherits(inherits)[0],
            "fallback_inherits": inherits,
            "own": root,
            "source_machine": machine,
            "source_nozzle": nozzle,
        },
        "colors": [(p["id"], _color_name(p), p["color_hex"]) for p in ordered],
        "overrides": overrides,
        "warnings": warnings,
    }


def row_dict(row: FilamentPreset) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "brand": row.brand,
        "material": row.material,
        "color": row.color,
        "color_hex": row.color_hex,
        "content": row.content,
    }


async def apply_migration(db: AsyncSession, choices: list[dict]) -> list[int]:
    """Snapshot the originals, build one tree per choice, turn each old row into a leaf; one transaction."""
    try:
        managed = await managed_preset_ids(db)
        rows = (await db.execute(select(FilamentPreset).order_by(FilamentPreset.name))).scalars().all()
        by_prefix: dict[str, list[FilamentPreset]] = {}
        for r in rows:
            if r.id not in managed:
                by_prefix.setdefault(_prefix(r.name), []).append(r)
        if len({ch["prefix"] for ch in choices}) != len(choices):
            raise ValueError("each group can be migrated once")
        picked = []
        for ch in choices:
            group = by_prefix.get(ch["prefix"])
            if not group or ch["source_preset_id"] not in {r.id for r in group}:
                raise ValueError(f"no unmanaged group {ch['prefix']!r} with preset {ch['source_preset_id']}")
            picked.append((ch, group))

        originals = [{"id": r.id, "name": r.name, "content": r.content} for _, group in picked for r in group]
        db.add(FilamentTreeSnapshot(kind="migration", payload=json.dumps(originals)))
        await db.flush()

        targets = await get_targets(db)
        reader = await build_base_reader(db)
        tree_ids = []
        for ch, group in picked:
            machine, nozzle, source_id = ch["machine"], ch["nozzle"], ch["source_preset_id"]
            plan = plan_tree([row_dict(r) for r in group], source_id, machine, nozzle, reader.values)
            for warning in plan["warnings"]:
                logger.warning("filament tree migration %s: %s", ch["prefix"], warning)
            t = plan["tree"]
            tree = FilamentTree(
                name=t["name"],
                brand=t["brand"],
                material=t["material"],
                version=t["version"],
                base_family=t["base_family"],
                fallback_inherits=t["fallback_inherits"],
                own_values=json.dumps(t["own"]),
                source_machine=machine,
                source_nozzle=nozzle,
            )
            db.add(tree)
            await db.flush()
            color_ids = {}
            for sort, (pid, name, hex_) in enumerate(plan["colors"]):
                color = FilamentTreeColor(tree_id=tree.id, name=name, hex=hex_, sort=sort)
                db.add(color)
                await db.flush()
                color_ids[pid] = color.id
            tree.source_color_id = color_ids[source_id]
            for (m, n, pid), values in plan["overrides"].items():
                db.add(
                    FilamentTreeOverride(
                        tree_id=tree.id, machine=m, nozzle=n, color_id=color_ids.get(pid, 0), values=json.dumps(values)
                    )
                )
            # The old row becomes the colour's leaf at the source machine/nozzle, so its id (and references) survive.
            for pid, color_id in color_ids.items():
                db.add(
                    FilamentTreeLeaf(tree_id=tree.id, machine=machine, nozzle=nozzle, color_id=color_id, preset_id=pid)
                )
            await db.flush()
            if (machine, nozzle, tree.source_color_id) not in leaf_targets(await load_tree(db, tree.id), targets):
                raise ValueError(f"{machine} {nozzle} is not a target leaf for {t['name']}")
            await regenerate_tree(db, tree.id)
            tree_ids.append(tree.id)
        await db.commit()
        return tree_ids
    except Exception:
        await db.rollback()
        raise
