"""Pull planner: fold edits made in OrcaSlicer (fetched from Orca Cloud) back into filament trees.

Phase 1 is pull only. A Fenrir change is never overwritten: a key changed on both sides becomes a conflict.
"""

import json
import re
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.filament_profile import FilamentPreset
from backend.app.models.filament_tree import FilamentTree, FilamentTreeColor, FilamentTreeLeaf
from backend.app.services.filament_tree import IDENTITY_KEYS, NOZZLE_BOUND_KEYS
from backend.app.services.filament_tree_store import set_node_values

_LEAF_SUFFIX = re.compile(r" @\S+ \d\.\d$")
_SKIP_KEYS = IDENTITY_KEYS | {"type", "setting_id"}  # Orca-side metadata that is never a tree value


@dataclass
class LeafState:
    tree_id: int
    machine: str
    nozzle: str
    color_id: int
    name: str
    generated: dict
    baseline: dict | None
    is_source: bool


@dataclass
class PullPlan:
    applied: list[dict] = field(default_factory=list)
    conflicts: list[dict] = field(default_factory=list)
    candidates: list[dict] = field(default_factory=list)
    legacy: int = 0
    missing: list[str] = field(default_factory=list)
    ignored: int = 0


def _target(is_source: bool, key: str) -> str:
    if not is_source:
        return "color"
    return "node" if key in NOZZLE_BOUND_KEYS else "root"


def _node(target: str, machine: str, nozzle: str, color_id: int) -> tuple[str | None, str | None, int | None]:
    return {"root": (None, None, None), "node": (machine, nozzle, None)}.get(target, (machine, nozzle, color_id))


def plan_pull(orca_entries: list[dict], leaves: list[LeafState], tree_colour_names: set[str]) -> PullPlan:
    plan = PullPlan()
    by_name = {lf.name: lf for lf in leaves}
    seen: set[str] = set()
    for entry in orca_entries:
        content = entry.get("content") or {}
        if content.get("type") != "filament":
            continue
        name = entry.get("name", "")
        seen.add(name)
        leaf = by_name.get(name)
        if leaf is not None:
            _plan_leaf(plan, leaf, content)
        elif name in tree_colour_names:
            plan.legacy += 1
        elif not _LEAF_SUFFIX.search(name) and content.get("from") in ("User", "user", None):
            plan.candidates.append({"orca_id": entry.get("id"), "name": name, "content": content})
        else:
            plan.ignored += 1
    plan.missing = [lf.name for lf in leaves if lf.baseline is not None and lf.name not in seen]
    return plan


def _plan_leaf(plan: PullPlan, leaf: LeafState, orca: dict) -> None:
    baseline = leaf.baseline if leaf.baseline is not None else leaf.generated
    where = {"tree_id": leaf.tree_id, "machine": leaf.machine, "nozzle": leaf.nozzle, "color_id": leaf.color_id}
    plan.ignored += sum(1 for k in baseline if k not in _SKIP_KEYS and k not in orca)
    grouped: dict[str, dict] = {}
    for key, value in orca.items():
        if key in _SKIP_KEYS or value == baseline.get(key):
            continue
        gen = leaf.generated.get(key)
        if gen != baseline.get(key) and gen != value:
            plan.conflicts.append({**where, "key": key, "fenrir_value": gen, "orca_value": value})
        else:
            grouped.setdefault(_target(leaf.is_source, key), {})[key] = value
    for target, values in grouped.items():
        plan.applied.append({**where, "target": target, "values": values})


async def _leaf_preset(db: AsyncSession, tree_id: int, machine: str, nozzle: str, color_id: int):
    link = (
        await db.execute(
            select(FilamentTreeLeaf).where(
                FilamentTreeLeaf.tree_id == tree_id,
                FilamentTreeLeaf.machine == machine,
                FilamentTreeLeaf.nozzle == nozzle,
                FilamentTreeLeaf.color_id == color_id,
            )
        )
    ).scalar_one()
    preset = await db.get(FilamentPreset, link.preset_id)
    await db.refresh(preset)
    return link, preset


async def apply_pull(db: AsyncSession, plan: PullPlan) -> None:
    held: dict[tuple, dict[str, object]] = {}  # leaf -> {conflict key: baseline value to keep}
    touched: dict[tuple, dict] = {}  # leaf -> baseline before any write
    groups: dict[tuple, dict] = {}
    for e in plan.applied:
        leaf = (e["tree_id"], e["machine"], e["nozzle"], e["color_id"])
        if leaf not in touched:
            link, preset = await _leaf_preset(db, *leaf)
            touched[leaf] = json.loads(link.baseline_content) if link.baseline_content else json.loads(preset.content)
        node = (e["tree_id"], *_node(e["target"], e["machine"], e["nozzle"], e["color_id"]))
        groups.setdefault(node, {}).update(e["values"])
    for c in plan.conflicts:
        held.setdefault((c["tree_id"], c["machine"], c["nozzle"], c["color_id"]), {})[c["key"]] = None
    for node, values in groups.items():
        try:
            await set_node_values(db, *node, values, [])
        except ValueError:
            # the store refuses some keys (e.g. identity-adjacent); keep the rest of the pull
            for k, v in values.items():
                try:
                    await set_node_values(db, *node, {k: v}, [])
                except ValueError:
                    plan.ignored += 1
    for leaf, old in touched.items():
        link, preset = await _leaf_preset(db, *leaf)
        new = json.loads(preset.content)
        for k in held.get(leaf, {}):  # keep the old reference so the conflict is still a conflict next pull
            if k in old:
                new[k] = old[k]
            else:
                new.pop(k, None)
        link.baseline_content = json.dumps(new, indent=4)
    await db.commit()


async def resolve_conflict(
    db: AsyncSession, tree_id: int, machine: str, nozzle: str, color_id: int, key: str, value
) -> None:
    tree = await db.get(FilamentTree, tree_id)
    if tree is None:
        raise LookupError(f"filament tree {tree_id} not found")
    is_source = (machine, nozzle, color_id) == (tree.source_machine, tree.source_nozzle, tree.source_color_id)
    node = _node(_target(is_source, key), machine, nozzle, color_id)
    await set_node_values(db, tree_id, *node, {key: value}, [])
    link, preset = await _leaf_preset(db, tree_id, machine, nozzle, color_id)
    baseline = json.loads(link.baseline_content) if link.baseline_content else json.loads(preset.content)
    baseline[key] = value
    link.baseline_content = json.dumps(baseline, indent=4)
    await db.commit()


async def collect_leaf_states(db: AsyncSession) -> tuple[list[LeafState], set[str]]:
    trees = {t.id: t for t in (await db.execute(select(FilamentTree))).scalars()}
    colours = {c.id: c for c in (await db.execute(select(FilamentTreeColor))).scalars()}
    rows = (await db.execute(select(FilamentTreeLeaf, FilamentPreset).join(FilamentPreset))).all()
    leaves = []
    for link, preset in rows:
        t = trees[link.tree_id]
        leaves.append(
            LeafState(
                tree_id=link.tree_id,
                machine=link.machine,
                nozzle=link.nozzle,
                color_id=link.color_id,
                name=preset.name,
                generated=json.loads(preset.content),
                baseline=json.loads(link.baseline_content) if link.baseline_content else None,
                is_source=(link.machine, link.nozzle, link.color_id)
                == (t.source_machine, t.source_nozzle, t.source_color_id),
            )
        )
    names = {f"{trees[c.tree_id].name} - {c.name}" for c in colours.values()}
    return leaves, names
