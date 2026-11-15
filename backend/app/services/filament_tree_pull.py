"""Pull planner: fold edits made in OrcaSlicer (fetched from Orca Cloud) back into filament trees.

Phase 1 is pull only. A Fenrir change is never overwritten: a key changed on both sides becomes a conflict.
"""

import json
import re
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.filament_profile import FilamentPreset
from backend.app.models.filament_tree import FilamentTree, FilamentTreeColor, FilamentTreeLeaf, FilamentTreeOverride
from backend.app.services.filament_tree import IDENTITY_KEYS, NOZZLE_BOUND_KEYS
from backend.app.services.filament_tree_store import set_node_values

_LEAF_SUFFIX = re.compile(r" @\S+ \d\.\d$")
# Orca-side metadata that is never a tree value
_SKIP_KEYS = IDENTITY_KEYS | {
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
    owned_at: dict[str, str] = field(default_factory=dict)  # source leaf only: key -> "node" | "machine" (else root)


@dataclass
class PullPlan:
    applied: list[dict] = field(default_factory=list)
    conflicts: list[dict] = field(default_factory=list)
    candidates: list[dict] = field(default_factory=list)
    legacy: int = 0
    missing: list[str] = field(default_factory=list)
    ignored: int = 0
    refresh: list[dict] = field(default_factory=list)  # leaves whose baseline must follow generated for some keys


def _target(is_source: bool, key: str, owned_at: dict[str, str]) -> str:
    if not is_source:
        return "color"
    return "node" if key in NOZZLE_BOUND_KEYS else owned_at.get(key, "root")


def _node(target: str, machine: str, nozzle: str, color_id: int) -> tuple[str | None, str | None, int | None]:
    return {"root": (None, None, None), "machine": (machine, None, None), "node": (machine, nozzle, None)}.get(
        target, (machine, nozzle, color_id)
    )


async def _owned_at(db: AsyncSession, tree_id: int, machine: str, nozzle: str) -> dict[str, str]:
    """Deepest node on the source path that already owns each key (nozzle beats machine)."""
    rows = (
        await db.execute(
            select(FilamentTreeOverride).where(
                FilamentTreeOverride.tree_id == tree_id,
                FilamentTreeOverride.color_id == 0,
                FilamentTreeOverride.machine == machine,
                FilamentTreeOverride.nozzle.in_(["", nozzle]),
            )
        )
    ).scalars()
    out: dict[str, str] = {}
    for row in sorted(rows, key=lambda r: r.nozzle != ""):  # machine first, nozzle overwrites
        out.update(dict.fromkeys(json.loads(row.values), "node" if row.nozzle else "machine"))
    return out


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
    refresh: list[str] = []
    for key, value in orca.items():
        if key in _SKIP_KEYS or value == baseline.get(key):
            continue
        gen = leaf.generated.get(key)
        if gen == value:  # coincidence: pinning it would block ancestor edits; just move the baseline
            refresh.append(key)
        elif gen != baseline.get(key):
            plan.conflicts.append({**where, "key": key, "fenrir_value": gen, "orca_value": value})
        else:
            grouped.setdefault(_target(leaf.is_source, key, leaf.owned_at), {})[key] = value
    if refresh:
        plan.refresh.append({**where, "keys": refresh})
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
    groups: dict[tuple, dict] = {}
    leaf_keys: dict[tuple, dict[tuple, set[str]]] = {}  # leaf -> {node: keys written there}
    for e in plan.applied:
        leaf = (e["tree_id"], e["machine"], e["nozzle"], e["color_id"])
        node = (e["tree_id"], *_node(e["target"], e["machine"], e["nozzle"], e["color_id"]))
        groups.setdefault(node, {}).update(e["values"])
        leaf_keys.setdefault(leaf, {}).setdefault(node, set()).update(e["values"])
    refresh = {(r["tree_id"], r["machine"], r["nozzle"], r["color_id"]): set(r["keys"]) for r in plan.refresh}
    old: dict[tuple, dict] = {}  # reference each leaf had before the writes (generated when never synced)
    for leaf in leaf_keys.keys() | refresh.keys():
        link, preset = await _leaf_preset(db, *leaf)
        old[leaf] = json.loads(link.baseline_content or preset.content)
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
                    for by_node in leaf_keys.values():
                        by_node.get(node, set()).discard(k)
    for leaf, baseline in old.items():
        link, preset = await _leaf_preset(db, *leaf)
        current = json.loads(preset.content)
        for keys in [*leaf_keys.get(leaf, {}).values(), refresh.get(leaf, set())]:
            for k in keys:
                baseline[k] = current[k]
        link.baseline_content = json.dumps(baseline, indent=4)
    await db.commit()


async def resolve_conflict(
    db: AsyncSession, tree_id: int, machine: str, nozzle: str, color_id: int, key: str, value
) -> None:
    tree = await db.get(FilamentTree, tree_id)
    if tree is None:
        raise LookupError(f"filament tree {tree_id} not found")
    link, preset = await _leaf_preset(db, tree_id, machine, nozzle, color_id)
    if json.loads(preset.content).get(key) != value:  # choosing Fenrir's own value writes nothing
        is_source = (machine, nozzle, color_id) == (tree.source_machine, tree.source_nozzle, tree.source_color_id)
        owned = await _owned_at(db, tree_id, machine, nozzle) if is_source else {}
        await set_node_values(
            db, tree_id, *_node(_target(is_source, key, owned), machine, nozzle, color_id), {key: value}, []
        )
        await db.refresh(preset)
    current = json.loads(preset.content)
    baseline = json.loads(link.baseline_content) if link.baseline_content else dict(current)
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
        is_source = (link.machine, link.nozzle, link.color_id) == (t.source_machine, t.source_nozzle, t.source_color_id)
        leaves.append(
            LeafState(
                tree_id=link.tree_id,
                machine=link.machine,
                nozzle=link.nozzle,
                color_id=link.color_id,
                name=preset.name,
                generated=json.loads(preset.content),
                baseline=json.loads(link.baseline_content) if link.baseline_content else None,
                is_source=is_source,
                owned_at=await _owned_at(db, link.tree_id, link.machine, link.nozzle) if is_source else {},
            )
        )
    names = {f"{trees[c.tree_id].name} - {c.name}" for c in colours.values()}
    return leaves, names
