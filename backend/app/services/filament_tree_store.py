"""Persistence for filament trees; every mutation regenerates one filament_presets row per leaf."""

import asyncio
import json
import logging
import re
import weakref
from collections.abc import AsyncIterator, Iterable
from contextlib import asynccontextmanager
from typing import Any

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.settings import get_setting, set_setting
from backend.app.models.filament_profile import BaseFilamentPreset, FilamentPreset
from backend.app.models.filament_tree import (
    FilamentTree,
    FilamentTreeChange,
    FilamentTreeColor,
    FilamentTreeLeaf,
    FilamentTreeOverride,
)
from backend.app.schemas.filament_profile import _CONTENT_MAX_LENGTH, _validate_bare_filename
from backend.app.services.filament_tree import (
    DEFAULT_TARGETS,
    NOZZLE_BOUND_KEYS,
    SKIP_KEYS,
    TreeData,
    leaf_groups,
    leaf_name,
    leaf_targets,
    resolve_leaf,
    resolve_with_sources,
)
from backend.app.services.filament_tree_base import build_base_reader

logger = logging.getLogger(__name__)

TARGETS_KEY = "filament_tree_targets"
_UNSET = object()

# One [lock, users] entry per (event loop, tree) while someone holds or awaits it: asyncio locks bind to a loop, and
# each test runs its own. `users` counts holders plus waiters; the entry is dropped when it reaches zero.
_tree_locks: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, dict[int, list]]" = weakref.WeakKeyDictionary()


@asynccontextmanager
async def tree_write_lock(tree_ids: Iterable[int]) -> AsyncIterator[None]:
    """Serialize read-modify-write of tree nodes. Take it in the route, before any read of the tree, never inside
    set_node_values (not re-entrant). Several ids are taken in sorted order so two callers cannot deadlock."""
    locks = _tree_locks.setdefault(asyncio.get_running_loop(), {})
    joined: list[tuple[int, list]] = []
    acquired: list[asyncio.Lock] = []
    try:
        for tree_id in sorted(set(tree_ids)):
            entry = locks.setdefault(tree_id, [asyncio.Lock(), 0])
            entry[1] += 1
            joined.append((tree_id, entry))
            await entry[0].acquire()
            acquired.append(entry[0])
        yield
    finally:
        for lock in reversed(acquired):
            lock.release()
        for tree_id, entry in joined:
            entry[1] -= 1
            if not entry[1]:
                locks.pop(tree_id, None)


def validate_targets(targets: dict) -> dict:
    out = {}
    for key in ("machines", "nozzles"):
        vals = targets.get(key)
        if not isinstance(vals, list) or not vals or not all(isinstance(v, str) and v.strip() for v in vals):
            raise ValueError(f"{key} must be a non-empty list of non-empty strings")
        out[key] = [v.strip() for v in vals]
        if len(set(out[key])) != len(out[key]):
            raise ValueError(f"{key} must not contain duplicates")
    parts = [p for m in out["machines"] for p in m.split("+")]
    if "" in parts or len(set(parts)) != len(parts):
        raise ValueError("a printer can be in one machine target only (joined targets look like H2C+H2D)")
    if not all(re.match(r"^\d\.\d$", n) for n in out["nozzles"]):
        raise ValueError("nozzles must look like 0.4")
    out["merge_nozzles"] = bool(targets.get("merge_nozzles"))
    return out


async def get_targets(db: AsyncSession) -> dict:
    raw = await get_setting(db, TARGETS_KEY)
    return json.loads(raw) if raw else {k: list(v) for k, v in DEFAULT_TARGETS.items()}


async def set_targets(db: AsyncSession, targets: dict, *, commit: bool = True) -> dict:
    """commit=False leaves the write in the caller's transaction (e.g. to regenerate the trees first)."""
    clean = validate_targets(targets)
    await set_setting(db, TARGETS_KEY, json.dumps(clean))
    if commit:
        await db.commit()
    return clean


async def join_machines(db: AsyncSession, tree_ids: Iterable[int], old: dict, new: dict) -> None:
    """A new target "A+B" joins printers that share one preset per nozzle and colour (compatible with both; A gives
    the Bambu base). The first joined printer that was a target hands its values, leaves and history to the joined
    name. Refused while the joined printers resolve to different values: nothing is merged away silently."""
    for token in new["machines"]:
        parts = token.split("+")
        if len(parts) < 2 or token in old["machines"]:
            continue
        live = [p for p in parts if p in old["machines"]]
        for tree_id in tree_ids:
            tree = await load_tree(db, tree_id)

            def values(machine: str, tree: TreeData = tree) -> list[dict]:
                return [
                    {k: v for k, (v, _) in resolve_with_sources(tree, machine, nozzle, color).items()}
                    for nozzle in [None, *old["nozzles"]]
                    for color in [None, *tree.colors]
                ]

            for other in live[1:]:
                differing = sorted(
                    {
                        k
                        for a, b in zip(values(live[0]), values(other), strict=True)
                        for k in a | b
                        if a.get(k) != b.get(k)
                    }
                )
                if differing:
                    raise ValueError(
                        f"{tree.name}: {live[0]} and {other} hold different values ({', '.join(differing[:5])}); "
                        "make them equal before joining them"
                    )
            keep = live[0] if live else None
            rows = (
                await db.execute(
                    select(FilamentTreeOverride).where(
                        FilamentTreeOverride.tree_id == tree_id, FilamentTreeOverride.machine.in_(parts)
                    )
                )
            ).scalars()
            for row in rows:
                if row.machine == keep:
                    row.machine = token
                else:
                    await db.delete(row)
            # the kept printer's leaves carry on (preset row, sync baseline); the others' are dropped by the regeneration
            leaves = (
                await db.execute(
                    select(FilamentTreeLeaf).where(
                        FilamentTreeLeaf.tree_id == tree_id, FilamentTreeLeaf.machine == keep
                    )
                )
            ).scalars()
            for leaf in leaves:
                leaf.machine = token
            await db.execute(
                update(FilamentTreeChange)
                .where(FilamentTreeChange.tree_id == tree_id, FilamentTreeChange.machine.in_(parts))
                .values(machine=token)
            )
            meta = await _get_tree(db, tree_id)
            if meta.source_machine in parts:
                meta.source_machine = token
            await db.flush()


async def _get_tree(db: AsyncSession, tree_id: int) -> FilamentTree:
    tree = await db.get(FilamentTree, tree_id)
    if tree is None:
        raise LookupError(f"filament tree {tree_id} not found")
    return tree


async def load_tree(db: AsyncSession, tree_id: int) -> TreeData:
    tree = await _get_tree(db, tree_id)
    colors = (
        await db.execute(
            select(FilamentTreeColor)
            .where(FilamentTreeColor.tree_id == tree_id)
            .order_by(FilamentTreeColor.sort, FilamentTreeColor.id)
        )
    ).scalars()
    overrides = (
        await db.execute(select(FilamentTreeOverride).where(FilamentTreeOverride.tree_id == tree_id))
    ).scalars()
    return TreeData(
        name=tree.name,
        brand=tree.brand,
        version=tree.version,
        base_family=tree.base_family,
        fallback_inherits=tree.fallback_inherits,
        own=json.loads(tree.own_values),
        colors={c.id: (c.name, c.hex) for c in colors},
        overrides={(o.machine, o.nozzle, o.color_id): json.loads(o.values) for o in overrides},
        source=(tree.source_machine, tree.source_nozzle, tree.source_color_id),
        skip_02=tree.skip_02,
        material=tree.material,
    )


async def base_names(db: AsyncSession) -> set[str]:
    return set((await db.execute(select(BaseFilamentPreset.name))).scalars())


async def managed_preset_ids(db: AsyncSession) -> set[int]:
    return set((await db.execute(select(FilamentTreeLeaf.preset_id))).scalars())


async def hoist_shared_colour_values(db: AsyncSession, tree_id: int) -> None:
    """A key every colour holds with one value moves up a level (colour node -> nozzle node, colour-wide -> root).
    No leaf changes, but the colours stop needing leaves of their own. OrcaSlicer edits pulled from colour leaves
    land on each colour, so this runs on every regeneration. A one-colour tree is left alone: nothing to save, and a
    colour added later would otherwise inherit the value."""
    color_ids = set(
        (await db.execute(select(FilamentTreeColor.id).where(FilamentTreeColor.tree_id == tree_id))).scalars()
    )
    if len(color_ids) < 2:
        return
    rows = (await db.execute(select(FilamentTreeOverride).where(FilamentTreeOverride.tree_id == tree_id))).scalars()
    parents: dict[tuple[str, str], FilamentTreeOverride] = {}
    by_node: dict[tuple[str, str], list[FilamentTreeOverride]] = {}
    for row in rows:
        if row.color_id == 0:
            parents[(row.machine, row.nozzle)] = row
        elif row.color_id in color_ids:
            by_node.setdefault((row.machine, row.nozzle), []).append(row)
    for (machine, nozzle), colour_rows in by_node.items():
        if len(colour_rows) != len(color_ids):
            continue
        values = [json.loads(r.values) for r in colour_rows]
        shared = {
            k: v
            for k, v in values[0].items()
            if all(k in x and x[k] == v for x in values[1:]) and (machine or k not in NOZZLE_BOUND_KEYS)
        }
        if not shared:
            continue
        if machine:
            parent = parents.get((machine, nozzle))
            if parent is None:
                parent = FilamentTreeOverride(tree_id=tree_id, machine=machine, nozzle=nozzle, color_id=0, values="{}")
                db.add(parent)
            parent.values = json.dumps(json.loads(parent.values) | shared)
        else:  # colour-wide: the root (nozzle-bound keys never reach a leaf from there, so they stay put)
            meta = await _get_tree(db, tree_id)
            meta.own_values = json.dumps(json.loads(meta.own_values) | shared)
        for row, own in zip(colour_rows, values, strict=True):
            rest = {k: v for k, v in own.items() if k not in shared}
            if rest:
                row.values = json.dumps(rest)
            else:
                await db.delete(row)
    await db.flush()


async def regenerate_tree(db: AsyncSession, tree_id: int) -> dict:
    """Upsert one preset per target leaf and drop leaves (and presets) that are no longer targets."""
    await hoist_shared_colour_values(db, tree_id)
    tree = await load_tree(db, tree_id)
    meta = await _get_tree(db, tree_id)
    bases = await base_names(db)
    reader = await build_base_reader(db)
    targets = leaf_groups(tree, await get_targets(db), bases)
    existing = {
        (lf.machine, lf.nozzle, lf.color_id): lf
        for lf in (await db.execute(select(FilamentTreeLeaf).where(FilamentTreeLeaf.tree_id == tree_id))).scalars()
    }
    # a regrouped set of nozzles ("0.6" -> "0.6+0.8") takes over a leaf that covered one of them, so the preset
    # row and whatever links to it live on under the new name
    for key in targets:
        if key not in existing:
            donor = next(
                (
                    k
                    for k in existing
                    if k not in targets
                    and (k[0], k[2]) == (key[0], key[2])
                    and set(k[1].split("+")) & set(key[1].split("+"))
                ),
                None,
            )
            if donor:
                existing[key] = existing.pop(donor)
                existing[key].nozzle = key[1]
    counts = {"created": 0, "updated": 0, "deleted": 0}
    for key in targets:
        machine, nozzle, color_id = key
        name = leaf_name(tree, *key)
        color_name, color_hex = tree.colors.get(color_id, ("", ""))  # 0: the colour-less leaf
        content = json.dumps(resolve_leaf(tree, machine, nozzle, color_id, bases, reader.values), indent=4)
        if len(content) > _CONTENT_MAX_LENGTH:
            raise ValueError(f"{name}: the generated preset is larger than {_CONTENT_MAX_LENGTH} bytes")
        try:
            _validate_bare_filename(f"{name}.json")
        except ValueError as e:
            raise ValueError(f"{name!r} cannot be a preset file name") from e
        fields = {
            "name": name,
            "brand": meta.brand,
            "material": meta.material,
            "color": color_name,
            "color_hex": color_hex,
            "filename": f"{name}.json",
            "content": content,
        }
        link = existing.pop(key, None)
        if link is None:
            preset = FilamentPreset(**fields)
            db.add(preset)
            await db.flush()
            db.add(
                FilamentTreeLeaf(
                    tree_id=tree_id,
                    machine=machine,
                    nozzle=nozzle,
                    color_id=color_id,
                    preset_id=preset.id,
                )
            )
            counts["created"] += 1
        else:
            preset = await get_leaf_preset(db, link)
            if preset.content != content:
                link.export_pending = True
            for k, v in fields.items():
                setattr(preset, k, v)
            counts["updated"] += 1
    for link in existing.values():
        await db.execute(delete(FilamentTreeLeaf).where(FilamentTreeLeaf.id == link.id))
        await db.execute(delete(FilamentPreset).where(FilamentPreset.id == link.preset_id))
        counts["deleted"] += 1
    await db.flush()
    return counts


async def set_node_values(
    db: AsyncSession,
    tree_id: int,
    machine: str | None,
    nozzle: str | None,
    color_id: int | None,
    set_values: dict,
    clear: list[str],
    *,
    regenerate: bool = True,
    actor: str = "",
) -> None:
    """regenerate=False only flushes: the caller batches several writes, then regenerates and commits once.

    Every value that really changes is logged as a FilamentTreeChange (actor "" = sync or auth disabled).
    """
    machine, nozzle = machine or None, nozzle or None  # "" must not pass as "no machine" past the guards below
    tree = await _get_tree(db, tree_id)
    colorwide = machine is None and nozzle is None and color_id is not None
    if not colorwide and ((machine is None and nozzle is not None) or (nozzle is None and color_id is not None)):
        raise ValueError("a node needs its ancestors: machine, then nozzle, then colour")
    bad = SKIP_KEYS & set(set_values)
    if bad:
        raise ValueError(f"identity and Orca metadata keys are not tree values: {sorted(bad)}")
    if machine is None and NOZZLE_BOUND_KEYS & set(set_values):
        where = "a colour-wide node" if colorwide else "the root"
        raise ValueError(f"nozzle-bound keys cannot live on {where}: {sorted(NOZZLE_BOUND_KEYS & set(set_values))}")
    if colorwide and color_id == tree.source_color_id:
        raise ValueError("the calibration source colour holds no colour-wide values; edit the root instead")
    if color_id is not None and (machine, nozzle, color_id) == (
        tree.source_machine,
        tree.source_nozzle,
        tree.source_color_id,
    ):
        raise ValueError("the calibration source leaf holds no colour values; edit the root instead")

    def log(before: dict) -> None:
        for k in [*set_values, *clear]:
            old, new = before.get(k), None if k in clear else set_values[k]
            if old != new:
                db.add(
                    FilamentTreeChange(
                        tree_id=tree_id,
                        machine=machine or "",
                        nozzle=nozzle or "",
                        color_id=color_id or 0,
                        key=k,
                        old_value=None if old is None else json.dumps(old),
                        new_value=None if new is None else json.dumps(new),
                        actor=actor,
                    )
                )

    if machine is None and color_id is None:
        values = json.loads(tree.own_values)
        log(values)
        values.update(set_values)
        for k in clear:
            values.pop(k, None)
        tree.own_values = json.dumps(values)
    else:
        row = (
            await db.execute(
                select(FilamentTreeOverride).where(
                    FilamentTreeOverride.tree_id == tree_id,
                    FilamentTreeOverride.machine == (machine or ""),
                    FilamentTreeOverride.nozzle == (nozzle or ""),
                    FilamentTreeOverride.color_id == (color_id or 0),
                )
            )
        ).scalar_one_or_none()
        values = json.loads(row.values) if row else {}
        log(values)
        values.update(set_values)
        for k in clear:
            values.pop(k, None)
        if row is None and values:
            db.add(
                FilamentTreeOverride(
                    tree_id=tree_id,
                    machine=machine or "",
                    nozzle=nozzle or "",
                    color_id=color_id or 0,
                    values=json.dumps(values),
                )
            )
        elif row is not None and values:
            row.values = json.dumps(values)
        elif row is not None:
            await db.delete(row)
    await db.flush()
    if regenerate:
        await regenerate_tree(db, tree_id)
        await db.commit()


async def _check_color_name_free(db: AsyncSession, tree_id: int, name: str, except_id: int | None = None) -> None:
    """Colour names become leaf preset names, so two colours of a tree may not share one (casefolded, as spools are)."""
    rows = (await db.execute(select(FilamentTreeColor).where(FilamentTreeColor.tree_id == tree_id))).scalars().all()
    if any(c.id != except_id and c.name.casefold() == name.casefold() for c in rows):
        raise ValueError(f"this tree already has a colour named {name!r}")


async def add_color(db: AsyncSession, tree_id: int, name: str, hex: str) -> int:
    await _get_tree(db, tree_id)
    await _check_color_name_free(db, tree_id, name)
    last = (
        (
            await db.execute(
                select(FilamentTreeColor.sort)
                .where(FilamentTreeColor.tree_id == tree_id)
                .order_by(FilamentTreeColor.sort.desc())
            )
        )
        .scalars()
        .first()
    )
    color = FilamentTreeColor(tree_id=tree_id, name=name, hex=hex, sort=0 if last is None else last + 1)
    db.add(color)
    await db.flush()
    await regenerate_tree(db, tree_id)
    await db.commit()
    return color.id


async def rename_color(db: AsyncSession, tree_id: int, color_id: int, name: str, hex: str | None = None) -> None:
    color = await db.get(FilamentTreeColor, color_id)
    if color is None or color.tree_id != tree_id:
        raise LookupError(f"colour {color_id} not found")
    await _check_color_name_free(db, tree_id, name, color_id)
    color.name = name
    if hex is not None:
        color.hex = hex
    await db.flush()
    await regenerate_tree(db, tree_id)
    await db.commit()


async def remove_color(db: AsyncSession, tree_id: int, color_id: int) -> None:
    tree = await _get_tree(db, tree_id)
    color = await db.get(FilamentTreeColor, color_id)
    if color is None or color.tree_id != tree_id:
        raise LookupError(f"colour {color_id} not found")
    if tree.source_color_id == color_id:
        raise ValueError("the calibration source colour cannot be removed")
    await db.execute(
        delete(FilamentTreeOverride).where(
            FilamentTreeOverride.tree_id == tree_id, FilamentTreeOverride.color_id == color_id
        )
    )
    await db.delete(color)
    await db.flush()
    await regenerate_tree(db, tree_id)
    await db.commit()


async def get_leaf_preset(db: AsyncSession, link: FilamentTreeLeaf) -> FilamentPreset:
    preset = await db.get(FilamentPreset, link.preset_id)
    if preset is None:
        raise LookupError(
            f"preset {link.preset_id} of leaf {link.machine} {link.nozzle} (colour {link.color_id}) is missing"
        )
    return preset


async def update_tree(
    db: AsyncSession,
    tree_id: int,
    *,
    skip_02: Any = _UNSET,
    source: Any = _UNSET,
    brand: str | None = None,
    material: str | None = None,
) -> None:
    """skip_02: True/False/None (auto); source: (machine, nozzle, color_id); brand/material rename the tree."""
    tree = await _get_tree(db, tree_id)
    if brand or material:
        tree.brand, tree.material = brand or tree.brand, material or tree.material
        name = f"{tree.brand} {tree.material}"
        taken = await db.scalar(select(FilamentTree.id).where(FilamentTree.name == name, FilamentTree.id != tree_id))
        if taken is not None:
            raise ValueError(f"a filament tree named {name!r} already exists")
        tree.name = name
    if skip_02 is not _UNSET:
        tree.skip_02 = skip_02
    if source is not _UNSET:
        machine, nozzle, color_id = source
        clash = (
            (
                await db.execute(
                    select(FilamentTreeOverride).where(
                        FilamentTreeOverride.tree_id == tree_id,
                        FilamentTreeOverride.color_id == color_id,
                        or_(
                            (FilamentTreeOverride.machine == machine) & (FilamentTreeOverride.nozzle == nozzle),
                            (FilamentTreeOverride.machine == "") & (FilamentTreeOverride.nozzle == ""),
                        ),
                    )
                )
            )
            .scalars()
            .first()
        )
        if color_id is not None and clash is not None:
            raise ValueError(
                "that leaf or its colour already has colour values; clear them before making it the source"
            )
        tree.source_machine, tree.source_nozzle, tree.source_color_id = machine, nozzle, color_id
    await db.flush()
    await regenerate_tree(db, tree_id)
    await db.commit()


async def create_tree(
    db: AsyncSession,
    *,
    name: str,
    brand: str,
    material: str,
    base_family: str,
    color_name: str,
    color_hex: str,
    machine: str,
    nozzle: str,
    own_values: dict | None = None,
) -> int:
    """A new one-colour tree calibrated at (machine, nozzle); flushes and regenerates, the caller commits."""
    if await db.scalar(select(FilamentTree.id).where(FilamentTree.name == name)) is not None:
        raise ValueError(f"a filament tree named {name!r} already exists")
    tree = FilamentTree(
        name=name,
        brand=brand,
        material=material,
        base_family=base_family,
        fallback_inherits=f"{base_family} @base",
        own_values=json.dumps(own_values or {}),
        source_machine=machine,
        source_nozzle=nozzle,
    )
    db.add(tree)
    await db.flush()
    color = FilamentTreeColor(tree_id=tree.id, name=color_name, hex=color_hex)
    db.add(color)
    await db.flush()
    tree.source_color_id = color.id
    await db.flush()
    if (machine, nozzle, color.id) not in leaf_targets(await load_tree(db, tree.id), await get_targets(db)):
        raise ValueError(f"{machine} {nozzle} is not a target leaf")
    await regenerate_tree(db, tree.id)
    return tree.id


async def duplicate_tree(db: AsyncSession, tree_id: int, name: str, brand: str) -> int:
    """Copy a tree (values, colours, overrides) under a new name/brand; the caller commits."""
    src = await _get_tree(db, tree_id)
    if await db.scalar(select(FilamentTree.id).where(FilamentTree.name == name)) is not None:
        raise ValueError(f"a filament tree named {name!r} already exists")
    copy = FilamentTree(
        name=name,
        brand=brand,
        material=src.material,
        base_family=src.base_family,
        fallback_inherits=src.fallback_inherits,
        version=src.version,
        own_values=src.own_values,
        source_machine=src.source_machine,
        source_nozzle=src.source_nozzle,
        skip_02=src.skip_02,
    )
    db.add(copy)
    await db.flush()
    color_ids = {0: 0}
    colors = await db.execute(
        select(FilamentTreeColor)
        .where(FilamentTreeColor.tree_id == tree_id)
        .order_by(FilamentTreeColor.sort, FilamentTreeColor.id)
    )
    for c in colors.scalars().all():
        new = FilamentTreeColor(tree_id=copy.id, name=c.name, hex=c.hex, sort=c.sort)
        db.add(new)
        await db.flush()
        color_ids[c.id] = new.id
    copy.source_color_id = color_ids.get(src.source_color_id or 0) or None
    overrides = await db.execute(select(FilamentTreeOverride).where(FilamentTreeOverride.tree_id == tree_id))
    for o in overrides.scalars().all():
        db.add(
            FilamentTreeOverride(
                tree_id=copy.id, machine=o.machine, nozzle=o.nozzle, color_id=color_ids[o.color_id], values=o.values
            )
        )
    await db.flush()
    await regenerate_tree(db, copy.id)
    return copy.id


async def regenerate_all_trees(session_factory) -> int:
    """Rebuild every tree's presets with the running code; returns how many presets now differ and await an export.

    Stored presets are only rewritten when their tree is edited, so a release that changes what a leaf contains would
    otherwise leave the old content in place. One transaction per tree: a tree that fails is logged and skipped.
    """
    async with session_factory() as db:
        tree_ids = (await db.execute(select(FilamentTree.id))).scalars().all()
        changed = 0
        for tree_id in tree_ids:
            try:
                async with tree_write_lock([tree_id]):
                    pending = select(func.count()).where(
                        FilamentTreeLeaf.tree_id == tree_id, FilamentTreeLeaf.export_pending
                    )
                    before = await db.scalar(pending)
                    await regenerate_tree(db, tree_id)
                    changed += await db.scalar(pending) - before
                    await db.commit()
            except Exception:
                await db.rollback()
                logger.exception("Filament tree %s could not be regenerated", tree_id)
        return changed
