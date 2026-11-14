"""Filament profile tree tables: cascade and per-node uniqueness."""

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from backend.app.models.filament_profile import FilamentPreset
from backend.app.models.filament_tree import (
    FilamentTree,
    FilamentTreeColor,
    FilamentTreeLeaf,
    FilamentTreeOverride,
)


def _tree() -> FilamentTree:
    return FilamentTree(
        name="Acme PETG",
        brand="Acme",
        material="PETG",
        base_family="Bambu PETG Basic",
        fallback_inherits="Generic PETG",
        source_machine="",
        source_nozzle="",
    )


@pytest.mark.asyncio
async def test_tree_defaults(db_session):
    tree = _tree()
    db_session.add(tree)
    await db_session.commit()
    await db_session.refresh(tree)
    assert tree.version == "2.4.0.8" and tree.own_values == "{}"
    assert tree.source_color_id is None and tree.skip_02 is None
    assert tree.created_at is not None and tree.updated_at is not None


@pytest.mark.asyncio
async def test_tree_cascade_deletes_children(db_session):
    tree = _tree()
    preset = FilamentPreset(name="p")
    db_session.add_all([tree, preset])
    await db_session.flush()
    db_session.add_all(
        [
            FilamentTreeColor(tree_id=tree.id, name="Red", hex="#ff0000", sort=0),
            FilamentTreeOverride(tree_id=tree.id, machine="X1C", nozzle="", color_id=0, values="{}"),
            FilamentTreeLeaf(tree_id=tree.id, machine="X1C", nozzle="0.4", color_id=1, preset_id=preset.id),
        ]
    )
    await db_session.commit()

    await db_session.delete(tree)
    await db_session.commit()

    for model in (FilamentTreeColor, FilamentTreeOverride, FilamentTreeLeaf):
        assert (await db_session.execute(select(model))).scalars().all() == []
    assert (await db_session.execute(select(FilamentPreset))).scalars().all() != []


@pytest.mark.asyncio
async def test_deleting_preset_deletes_its_leaf(db_session):
    tree = _tree()
    preset = FilamentPreset(name="p")
    db_session.add_all([tree, preset])
    await db_session.flush()
    db_session.add(FilamentTreeLeaf(tree_id=tree.id, machine="X1C", nozzle="0.4", color_id=1, preset_id=preset.id))
    await db_session.commit()

    await db_session.delete(preset)
    await db_session.commit()

    assert (await db_session.execute(select(FilamentTreeLeaf))).scalars().all() == []


@pytest.mark.asyncio
async def test_override_unique_per_node(db_session):
    tree = _tree()
    db_session.add(tree)
    await db_session.flush()
    node = {"tree_id": tree.id, "machine": "X1C", "nozzle": "0.4", "color_id": 0, "values": "{}"}
    db_session.add_all([FilamentTreeOverride(**node), FilamentTreeOverride(**node)])
    with pytest.raises(IntegrityError):
        await db_session.commit()
