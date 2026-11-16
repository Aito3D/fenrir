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
from backend.app.services.filament_tree import NOZZLE_BOUND_KEYS, SKIP_KEYS
from backend.app.services.filament_tree_store import get_leaf_preset, regenerate_tree, set_node_values
from backend.app.services.orca_cloud_codec import decode_content

_LEAF_SUFFIX = re.compile(r" @\S+ \d\.\d$")


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
    exported: bool = False


@dataclass
class PullPlan:
    applied: list[dict] = field(default_factory=list)
    conflicts: list[dict] = field(default_factory=list)
    candidates: list[dict] = field(default_factory=list)
    legacy: int = 0
    missing: list[str] = field(default_factory=list)
    ignored: int = 0
    refresh: list[dict] = field(default_factory=list)  # leaves whose baseline must follow generated for some keys
    baselines: list[dict] = field(default_factory=list)  # never-synced leaves found in Orca: store Orca's content


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
        if not isinstance(entry, dict):
            plan.ignored += 1
            continue
        raw_content = entry.get("content") or {}
        if not isinstance(raw_content, dict):
            plan.ignored += 1
            continue
        content = decode_content(raw_content)
        if content.get("type") != "filament":
            continue
        name = entry.get("name", "")
        if not isinstance(name, str):
            plan.ignored += 1
            continue
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
    plan.missing = sorted(lf.name for lf in leaves if (lf.exported or lf.baseline is not None) and lf.name not in seen)
    return plan


def _plan_leaf(plan: PullPlan, leaf: LeafState, orca: dict) -> None:
    where = {"tree_id": leaf.tree_id, "machine": leaf.machine, "nozzle": leaf.nozzle, "color_id": leaf.color_id}
    if leaf.baseline is None:
        # first sight in Orca: we cannot tell who changed what, so every difference is a conflict
        plan.baselines.append({**where, "content": orca})
        for key, value in orca.items():
            if key not in SKIP_KEYS and value != leaf.generated.get(key):
                plan.conflicts.append(
                    {**where, "key": key, "fenrir_value": leaf.generated.get(key), "orca_value": value}
                )
        return
    baseline = leaf.baseline
    plan.ignored += sum(1 for k in baseline if k not in SKIP_KEYS and k not in orca)
    grouped: dict[str, dict] = {}
    refresh: list[str] = []
    for key, value in orca.items():
        if key in SKIP_KEYS or value == baseline.get(key):
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


_NodeKey = tuple[int, str | None, str | None, int | None]  # (tree_id, machine, nozzle, color_id)


async def _leaf_preset(
    db: AsyncSession, tree_id: int, machine: str, nozzle: str, color_id: int
) -> tuple[FilamentTreeLeaf, FilamentPreset]:
    link = (
        await db.execute(
            select(FilamentTreeLeaf).where(
                FilamentTreeLeaf.tree_id == tree_id,
                FilamentTreeLeaf.machine == machine,
                FilamentTreeLeaf.nozzle == nozzle,
                FilamentTreeLeaf.color_id == color_id,
            )
        )
    ).scalar_one_or_none()
    if link is None:
        raise LookupError(f"leaf {machine} {nozzle} (colour {color_id}) of tree {tree_id} not found")
    preset = await get_leaf_preset(db, link)
    await db.refresh(preset)
    return link, preset


async def apply_pull(db: AsyncSession, plan: PullPlan) -> dict[tuple, set[str]]:
    """One transaction: each tree's writes + regeneration sit in a savepoint, a refused tree is rolled back.

    Returns the leaves (tree_id, machine, nozzle, color_id) with an Orca edit that was refused, with the refused keys."""
    groups: dict[_NodeKey, dict] = {}
    leaf_keys: dict[tuple, dict[_NodeKey, set[str]]] = {}  # leaf -> {node: keys written there}
    for e in plan.applied:
        leaf = (e["tree_id"], e["machine"], e["nozzle"], e["color_id"])
        node: _NodeKey = (e["tree_id"], *_node(e["target"], e["machine"], e["nozzle"], e["color_id"]))
        groups.setdefault(node, {}).update(e["values"])
        leaf_keys.setdefault(leaf, {}).setdefault(node, set()).update(e["values"])
    refresh = {(r["tree_id"], r["machine"], r["nozzle"], r["color_id"]): set(r["keys"]) for r in plan.refresh}
    old: dict[tuple, dict] = {}  # reference each leaf had before the writes (generated when never synced)
    for leaf in leaf_keys.keys() | refresh.keys():
        link, preset = await _leaf_preset(db, *leaf)
        old[leaf] = json.loads(link.baseline_content or preset.content)
    refused_leaves: dict[tuple, set[str]] = {}
    by_tree: dict[int, list[_NodeKey]] = {}
    for node in groups:
        by_tree.setdefault(node[0], []).append(node)
    for tree_id, nodes in by_tree.items():
        written: dict[_NodeKey, set[str]] = {}
        try:
            async with db.begin_nested():
                for node in nodes:
                    written[node] = await _write_node(db, node, groups[node])
                await regenerate_tree(db, tree_id)
        except ValueError:
            written = {node: set() for node in nodes}  # the savepoint dropped all of this tree's writes
        for node in nodes:
            refused = set(groups[node]) - written[node]
            plan.ignored += len(refused)
            for leaf, by_node in leaf_keys.items():
                if hit := by_node.get(node, set()) & refused:
                    refused_leaves.setdefault(leaf, set()).update(hit)
                by_node.get(node, set()).difference_update(refused)
    for leaf, baseline in old.items():
        link, preset = await _leaf_preset(db, *leaf)
        current = json.loads(preset.content)
        for keys in [*leaf_keys.get(leaf, {}).values(), refresh.get(leaf, set())]:
            for k in keys:
                if k in current:
                    baseline[k] = current[k]
                else:  # Orca holds null and Fenrir has no value: nothing to remember
                    baseline.pop(k, None)
        link.baseline_content = json.dumps(baseline, indent=4)
    for b in plan.baselines:
        link, _ = await _leaf_preset(db, b["tree_id"], b["machine"], b["nozzle"], b["color_id"])
        link.baseline_content = json.dumps(b["content"], indent=4)
    await db.commit()
    return refused_leaves


async def _write_node(db: AsyncSession, node: _NodeKey, values: dict) -> set[str]:
    """Write values without regenerating; the store refuses some keys (validation, nothing written) -> skip them."""
    try:
        await set_node_values(db, *node, values, [], regenerate=False)
        return set(values)
    except ValueError:
        kept = set()
        for k, v in values.items():
            try:
                await set_node_values(db, *node, {k: v}, [], regenerate=False)
                kept.add(k)
            except ValueError:
                pass
        return kept


async def resolve_conflict(
    db: AsyncSession, tree_id: int, machine: str, nozzle: str, color_id: int, key: str, value, orca_value
) -> None:
    """Write the chosen value; the baseline always records what Orca holds (orca_value)."""
    tree = await db.get(FilamentTree, tree_id)
    if tree is None:
        raise LookupError(f"filament tree {tree_id} not found")
    link, preset = await _leaf_preset(db, tree_id, machine, nozzle, color_id)
    # choosing Fenrir's own value (or its absence, None) writes nothing
    if value is not None and json.loads(preset.content).get(key) != value:
        is_source = (machine, nozzle, color_id) == (tree.source_machine, tree.source_nozzle, tree.source_color_id)
        owned = await _owned_at(db, tree_id, machine, nozzle) if is_source else {}
        await set_node_values(
            db, tree_id, *_node(_target(is_source, key, owned), machine, nozzle, color_id), {key: value}, []
        )
        await db.refresh(preset)
    current = json.loads(preset.content)
    baseline = json.loads(link.baseline_content) if link.baseline_content else dict(current)
    baseline[key] = orca_value
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
                exported=link.exported_at is not None,
                owned_at=await _owned_at(db, link.tree_id, link.machine, link.nozzle) if is_source else {},
            )
        )
    names = {f"{trees[c.tree_id].name} - {c.name}" for c in colours.values()}
    return leaves, names
