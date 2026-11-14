import json

import pytest
from sqlalchemy import func, select

from backend.app.models.filament_profile import FilamentPreset
from backend.app.models.filament_tree import FilamentTree, FilamentTreeColor
from backend.app.services import filament_tree_store as store


async def _make_tree(db, **kw):
    tree = FilamentTree(name="Polymaker PETG", brand="Polymaker", material="PETG", base_family="Generic PETG", **kw)
    db.add(tree)
    await db.flush()
    color = FilamentTreeColor(tree_id=tree.id, name="Red", hex="#FF0000")
    db.add(color)
    await db.flush()
    await db.commit()
    return tree, color


async def _presets(db):
    return list((await db.execute(select(FilamentPreset.name))).scalars())


async def test_regenerate_creates_all_leaves(db_session):
    tree, _ = await _make_tree(db_session)
    counts = await store.regenerate_tree(db_session, tree.id)
    assert counts == {"created": 16, "updated": 0, "deleted": 0}
    names = await _presets(db_session)
    assert len(names) == 16
    assert "Polymaker PETG - Red @H2S 0.4" in names
    assert await store.regenerate_tree(db_session, tree.id) == {"created": 0, "updated": 16, "deleted": 0}


async def test_regenerate_removes_orphan_leaves(db_session):
    tree, _ = await _make_tree(db_session)
    blue = await store.add_color(db_session, tree.id, "Blue", "#0000FF")
    assert len(await _presets(db_session)) == 32
    await store.remove_color(db_session, tree.id, blue)
    assert len(await _presets(db_session)) == 16
    await store.update_tree(db_session, tree.id, skip_02=True)
    names = await _presets(db_session)
    assert len(names) == 12 and not any(" 0.2" in n for n in names)
    assert len(await store.managed_preset_ids(db_session)) == 12


async def test_root_refuses_nozzle_bound(db_session):
    tree, _ = await _make_tree(db_session)
    with pytest.raises(ValueError):
        await store.set_node_values(db_session, tree.id, None, None, None, {"pressure_advance": ["0.1"]}, [])
    with pytest.raises(ValueError):
        await store.set_node_values(db_session, tree.id, None, None, None, {"inherits": "x"}, [])


async def test_source_leaf_refuses_colour_values(db_session):
    tree, color = await _make_tree(db_session, source_machine="H2S", source_nozzle="0.4")
    tree.source_color_id = color.id
    await db_session.commit()
    with pytest.raises(ValueError, match="root"):
        await store.set_node_values(db_session, tree.id, "H2S", "0.4", color.id, {"nozzle_temperature": ["250"]}, [])
    with pytest.raises(ValueError):
        await store.remove_color(db_session, tree.id, color.id)


async def test_node_edit_flows_to_children(db_session):
    tree, _ = await _make_tree(db_session)
    await store.add_color(db_session, tree.id, "Blue", "#0000FF")
    gcode = ["M900 K0.04"]
    await store.set_node_values(db_session, tree.id, "H2S", "0.4", None, {"filament_start_gcode": gcode}, [])
    rows = (await db_session.execute(select(FilamentPreset))).scalars().all()
    hit = [r for r in rows if "@H2S 0.4" in r.name]
    assert len(hit) == 2 and all(json.loads(r.content)["filament_start_gcode"] == gcode for r in hit)
    assert all("filament_start_gcode" not in json.loads(r.content) for r in rows if "@H2S 0.6" in r.name)
    # clearing removes the empty override row and the key
    await store.set_node_values(db_session, tree.id, "H2S", "0.4", None, {}, ["filament_start_gcode"])
    assert all(
        "filament_start_gcode" not in json.loads(r.content)
        for r in (await db_session.execute(select(FilamentPreset))).scalars()
    )
    assert await db_session.scalar(select(func.count()).select_from(store.FilamentTreeOverride)) == 0


async def test_targets_default_and_roundtrip(db_session):
    assert await store.get_targets(db_session) == {
        "machines": ["X2D", "H2S", "H2D", "H2C"],
        "nozzles": ["0.2", "0.4", "0.6", "0.8"],
    }
    t = {"machines": ["H2S"], "nozzles": ["0.4"]}
    assert await store.set_targets(db_session, t) == t
    assert await store.get_targets(db_session) == t


async def test_targets_rejects_bad_nozzle(db_session):
    with pytest.raises(ValueError):
        await store.set_targets(db_session, {"machines": ["H2S"], "nozzles": ["0.40"]})
    with pytest.raises(ValueError):
        await store.set_targets(db_session, {"machines": [], "nozzles": ["0.4"]})
