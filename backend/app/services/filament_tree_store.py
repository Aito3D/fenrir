"""Persistence for filament trees; every mutation regenerates one filament_presets row per leaf."""

import json
import re
from typing import Any

from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.settings import get_setting, set_setting
from backend.app.models.filament_profile import BaseFilamentPreset, FilamentPreset
from backend.app.models.filament_tree import (
    FilamentTree,
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
            preset = await db.get(FilamentPreset, link.preset_id)
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
) -> None:
    """regenerate=False only flushes: the caller batches several writes, then regenerates and commits once."""
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

    if machine is None and color_id is None:
        values = json.loads(tree.own_values)
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


async def update_tree(db: AsyncSession, tree_id: int, *, skip_02: Any = _UNSET, source: Any = _UNSET) -> None:
    """skip_02: True/False/None (auto); source: (machine, nozzle, color_id)."""
    tree = await _get_tree(db, tree_id)
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
