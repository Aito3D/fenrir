import json

import pytest
from sqlalchemy import func, select

from backend.app.models.filament_profile import BaseFilamentPreset, FilamentPreset
from backend.app.models.filament_tree import FilamentTree, FilamentTreeColor, FilamentTreeLeaf, FilamentTreeSnapshot
from backend.app.services.filament_tree_migration import apply_migration

COMPAT = [f"Bambu Lab {m} 0.4 nozzle" for m in ("H2S", "H2D", "H2C", "X2D")]


async def _seed(db, red_inherits="Bambu PETG Basic @BBL H2S", index=True):
    ids = {}
    if index:  # the Bambu base index (Sync base) the colours inherit from
        for i, base in enumerate(sorted({red_inherits, "Bambu PETG Basic @BBL H2S"})):
            db.add(BaseFilamentPreset(name=base, filename=f"base{i}.json"))
    for color, k in (("White", "0.035"), ("Red", "0.030"), ("Black", "0.035")):
        name = f"Polymaker PETG - {color}"
        content = {
            "name": name,
            "inherits": red_inherits if color == "Red" else "Bambu PETG Basic @BBL H2S",
            "compatible_printers": COMPAT,
            "filament_start_gcode": [f"M900 L1000 M10\nM900 K{k}"],
            "filament_max_volumetric_speed": ["24"],
            "nozzle_temperature": ["245"],
        }
        row = FilamentPreset(name=name, brand="Polymaker", material="PETG", color=color, content=json.dumps(content))
        db.add(row)
        await db.flush()
        ids[color] = row.id
    await db.commit()
    return ids


async def test_apply_migration_snapshots_first_and_keeps_ids(db_session):
    ids = await _seed(db_session)
    choice = {"prefix": "Polymaker PETG", "source_preset_id": ids["White"], "machine": "H2S", "nozzle": "0.4"}
    [tree_id] = await apply_migration(db_session, [choice])

    [snap] = (await db_session.execute(select(FilamentTreeSnapshot))).scalars().all()
    assert snap.kind == "migration"
    originals = json.loads(snap.payload)
    assert sorted(o["id"] for o in originals) == sorted(ids.values())
    assert all(o["name"].startswith("Polymaker PETG - ") and "M900" in o["content"] for o in originals)

    red = (await db_session.execute(select(FilamentTreeColor).where(FilamentTreeColor.name == "Red"))).scalar_one()
    link = (
        await db_session.execute(select(FilamentTreeLeaf).where(FilamentTreeLeaf.preset_id == ids["Red"]))
    ).scalar_one()
    assert (link.tree_id, link.machine, link.nozzle, link.color_id) == (tree_id, "H2S", "0.4", red.id)
    preset = await db_session.get(FilamentPreset, ids["Red"])
    assert preset.name == "Polymaker PETG - Red @H2S 0.4"
    assert json.loads(preset.content)["filament_start_gcode"] == ["M900 L1000 M10\nM900 K0.030"]
    assert await db_session.scalar(select(func.count()).select_from(FilamentTreeLeaf)) == 48
    assert await db_session.scalar(select(func.count()).select_from(FilamentPreset)) == 48
    baselines = (await db_session.execute(select(FilamentTreeLeaf.baseline_content))).scalars().all()
    assert all(b is None for b in baselines)


async def test_apply_migration_source_pair_outside_compat(db_session):
    ids = await _seed(db_session)
    choice = {"prefix": "Polymaker PETG", "source_preset_id": ids["White"], "machine": "H2S", "nozzle": "0.6"}
    await apply_migration(db_session, [choice])
    for color, k in (("White", "0.035"), ("Red", "0.030")):
        preset = await db_session.get(FilamentPreset, ids[color])
        assert preset.name == f"Polymaker PETG - {color} @H2S 0.6"
        content = json.loads(preset.content)
        assert content["filament_start_gcode"] == [f"M900 L1000 M10\nM900 K{k}"]
        assert content["filament_max_volumetric_speed"] == ["24"]


async def _assert_nothing_written(db, ids):
    assert await db.scalar(select(func.count()).select_from(FilamentTreeSnapshot)) == 0
    assert await db.scalar(select(func.count()).select_from(FilamentTree)) == 0
    assert await db.scalar(select(func.count()).select_from(FilamentTreeLeaf)) == 0
    names = (await db.execute(select(FilamentPreset.name))).scalars().all()
    assert sorted(names) == sorted(f"Polymaker PETG - {c}" for c in ids)


async def test_apply_migration_refuses_mixed_families(db_session):
    ids = await _seed(db_session, red_inherits="Bambu PETG HF @BBL H2S")
    choice = {"prefix": "Polymaker PETG", "source_preset_id": ids["White"], "machine": "H2S", "nozzle": "0.4"}
    with pytest.raises(ValueError, match="Red"):
        await apply_migration(db_session, [choice])
    await _assert_nothing_written(db_session, ids)


async def test_apply_migration_rejects_source_outside_targets(db_session):
    ids = await _seed(db_session)
    choice = {"prefix": "Polymaker PETG", "source_preset_id": ids["White"], "machine": "P1S", "nozzle": "0.4"}
    with pytest.raises(ValueError):
        await apply_migration(db_session, [choice])
    await _assert_nothing_written(db_session, ids)


async def test_apply_migration_refuses_unindexed_base(db_session):
    ids = await _seed(db_session, index=False)
    choice = {"prefix": "Polymaker PETG", "source_preset_id": ids["White"], "machine": "H2S", "nozzle": "0.4"}
    with pytest.raises(ValueError, match="not indexed for: Bambu PETG Basic @BBL H2S .* run Sync base first"):
        await apply_migration(db_session, [choice])
    await _assert_nothing_written(db_session, ids)
