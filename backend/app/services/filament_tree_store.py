"""Persistence for filament trees; every mutation regenerates one filament_presets row per leaf."""

import asyncio
import json
import re
import weakref
from collections.abc import AsyncIterator, Iterable
from contextlib import asynccontextmanager
from typing import Any

from sqlalchemy import delete, or_, select
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
    leaf_name,
    leaf_targets,
    resolve_leaf,
)

TARGETS_KEY = "filament_tree_targets"
_UNSET = object()

# One lock per (event loop, tree): asyncio locks bind to a loop, and each test runs its own.
_tree_locks: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, dict[int, asyncio.Lock]]" = (
    weakref.WeakKeyDictionary()
)


@asynccontextmanager
async def _tree_write_lock(tree_ids: Iterable[int]) -> AsyncIterator[None]:
    """Serialize read-modify-write of tree nodes. Take it in the route, before any read of the tree, never inside
    set_node_values (not re-entrant). Several ids are taken in sorted order so two callers cannot deadlock."""
    locks = _tree_locks.setdefault(asyncio.get_running_loop(), {})
    held: list[asyncio.Lock] = []
    try:
        for tree_id in sorted(set(tree_ids)):
            lock = locks.setdefault(tree_id, asyncio.Lock())
            await lock.acquire()
            held.append(lock)
        yield
    finally:
        for lock in reversed(held):
            lock.release()


def _validate_targets(targets: dict) -> dict:
    out = {}
    for key in ("machines", "nozzles"):
        vals = targets.get(key)
        if not isinstance(vals, list) or not vals or not all(isinstance(v, str) and v.strip() for v in vals):
            raise ValueError(f"{key} must be a non-empty list of non-empty strings")
        out[key] = [v.strip() for v in vals]
    if not all(re.match(r"^\d\.\d$", n) for n in out["nozzles"]):
        raise ValueError("nozzles must look like 0.4")
    return out


async def get_targets(db: AsyncSession) -> dict:
    raw = await get_setting(db, TARGETS_KEY)
    return json.loads(raw) if raw else {k: list(v) for k, v in DEFAULT_TARGETS.items()}


async def set_targets(db: AsyncSession, targets: dict, *, commit: bool = True) -> dict:
    """commit=False leaves the write in the caller's transaction (e.g. to regenerate the trees first)."""
    clean = _validate_targets(targets)
    await set_setting(db, TARGETS_KEY, json.dumps(clean))
    if commit:
        await db.commit()
    return clean


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


async def regenerate_tree(db: AsyncSession, tree_id: int) -> dict:
    """Upsert one preset per target leaf and drop leaves (and presets) that are no longer targets."""
    tree = await load_tree(db, tree_id)
    meta = await _get_tree(db, tree_id)
    targets = leaf_targets(tree, await get_targets(db))
    bases = await base_names(db)
    existing = {
        (lf.machine, lf.nozzle, lf.color_id): lf
        for lf in (await db.execute(select(FilamentTreeLeaf).where(FilamentTreeLeaf.tree_id == tree_id))).scalars()
    }
    counts = {"created": 0, "updated": 0, "deleted": 0}
    for key in targets:
        machine, nozzle, color_id = key
        name = leaf_name(tree, *key)
        color_name, color_hex = tree.colors[color_id]
        content = json.dumps(resolve_leaf(tree, machine, nozzle, color_id, bases), indent=4)
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
            preset = (await db.execute(select(FilamentPreset).where(FilamentPreset.id == link.preset_id))).scalar_one()
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


async def add_color(db: AsyncSession, tree_id: int, name: str, hex: str) -> int:
    await _get_tree(db, tree_id)
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
