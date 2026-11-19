import json

import pytest
from sqlalchemy import func, select

from backend.app.models.filament_profile import FilamentPreset
from backend.app.models.filament_tree import FilamentTree, FilamentTreeColor, FilamentTreeLeaf
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
    assert "Polymaker PETG @H2S 0.4" in names  # a colour without own values shares the colour-less leaf
    assert await store.regenerate_tree(db_session, tree.id) == {"created": 0, "updated": 16, "deleted": 0}


async def test_regenerate_removes_orphan_leaves(db_session):
    tree, _ = await _make_tree(db_session)
    blue = await store.add_color(db_session, tree.id, "Blue", "#0000FF")
    await store.set_node_values(db_session, tree.id, None, None, blue, {"nozzle_temperature": ["250"]}, [])
    assert len(await _presets(db_session)) == 32  # Blue holds a value of its own: it gets its own leaves
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
    assert len(hit) == 1 and all(json.loads(r.content)["filament_start_gcode"] == gcode for r in hit)
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
    assert await store.set_targets(db_session, t) == t | {"merge_nozzles": False}
    assert await store.get_targets(db_session) == t | {"merge_nozzles": False}


async def test_targets_rejects_bad_nozzle(db_session):
    with pytest.raises(ValueError):
        await store.set_targets(db_session, {"machines": ["H2S"], "nozzles": ["0.40"]})
    with pytest.raises(ValueError):
        await store.set_targets(db_session, {"machines": [], "nozzles": ["0.4"]})


async def test_regenerate_never_touches_baseline_content(db_session):
    tree, _ = await _make_tree(db_session)
    await store.regenerate_tree(db_session, tree.id)
    leaf = (
        await db_session.execute(
            select(FilamentTreeLeaf).where(FilamentTreeLeaf.machine == "H2S", FilamentTreeLeaf.nozzle == "0.4")
        )
    ).scalar_one()
    assert leaf.baseline_content is None
    leaf.baseline_content = "synced"
    await db_session.commit()
    before = (await db_session.get(FilamentPreset, leaf.preset_id)).content
    await store.set_node_values(db_session, tree.id, "H2S", "0.4", None, {"filament_start_gcode": ["M900 K0.04"]}, [])
    await db_session.refresh(leaf)
    assert leaf.baseline_content == "synced"
    assert (await db_session.get(FilamentPreset, leaf.preset_id)).content != before


async def test_colourwide_node_values_and_refusals(db_session):
    tree, color = await _make_tree(db_session, source_machine="H2S", source_nozzle="0.4")
    blue = await store.add_color(db_session, tree.id, "Blue", "#0000FF")
    tree.source_color_id = color.id
    await db_session.commit()
    with pytest.raises(ValueError, match="root"):
        await store.set_node_values(db_session, tree.id, None, None, color.id, {"nozzle_temperature": ["250"]}, [])
    with pytest.raises(ValueError, match="nozzle-bound"):
        await store.set_node_values(db_session, tree.id, None, None, blue, {"pressure_advance": ["0.1"]}, [])
    await store.set_node_values(db_session, tree.id, None, None, blue, {"nozzle_temperature": ["250"]}, [])
    rows = (await db_session.execute(select(FilamentPreset))).scalars().all()
    temps = {r.name: json.loads(r.content).get("nozzle_temperature") for r in rows}
    assert all(v == ["250"] for n, v in temps.items() if " - Blue @" in n)
    assert not any(v == ["250"] for n, v in temps.items() if " - Red @" in n)
    assert json.loads((await db_session.get(FilamentTree, tree.id)).own_values) == {}
    with pytest.raises(ValueError, match="colour values"):
        await store.update_tree(db_session, tree.id, source=("X2D", "0.8", blue))


def _lock_map():
    import asyncio

    return store._tree_locks.get(asyncio.get_running_loop(), {})


async def test_tree_write_lock_map_empty_after_use():
    async with store.tree_write_lock([999_001, 1, 1]):
        assert set(_lock_map()) == {1, 999_001}
    assert _lock_map() == {}
    with pytest.raises(RuntimeError):
        async with store.tree_write_lock([5]):
            raise RuntimeError("boom")
    assert _lock_map() == {}


async def test_tree_write_lock_excludes_three_overlapping_holders():
    import asyncio

    inside = 0
    peak = 0
    seen_locks = []

    async def holder():
        nonlocal inside, peak
        async with store.tree_write_lock([7]):
            seen_locks.append(_lock_map()[7][0])
            inside += 1
            peak = max(peak, inside)
            await asyncio.sleep(0.01)
            inside -= 1

    await asyncio.gather(holder(), holder(), holder())
    assert peak == 1
    assert len({id(lock) for lock in seen_locks}) == 1  # waiters share the holder's lock object
    assert _lock_map() == {}


async def test_tree_write_lock_cancelled_waiter_leaves_no_entry():
    import asyncio

    async with store.tree_write_lock([3]):
        waiter = asyncio.create_task(store.tree_write_lock([3]).__aenter__())
        await asyncio.sleep(0)
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
        assert _lock_map()[3][1] == 1
    assert _lock_map() == {}


async def test_tree_write_lock_opposite_id_orders_do_not_deadlock():
    """[1, 2] and [2, 1] both take the ids in sorted order: the second waits for the first, no deadlock."""
    import asyncio

    first_in, release = asyncio.Event(), asyncio.Event()
    order = []

    async def first():
        async with store.tree_write_lock([1, 2]):
            order.append("first")
            first_in.set()
            await release.wait()

    async def second():
        await first_in.wait()
        async with store.tree_write_lock([2, 1]):
            order.append("second")

    tasks = [asyncio.create_task(first()), asyncio.create_task(second())]
    while _lock_map().get(1, [None, 0])[1] < 2:  # the second caller queued on id 1 (users counts holder + waiter)
        await asyncio.sleep(0)
    assert order == ["first"]
    release.set()
    await asyncio.wait_for(asyncio.gather(*tasks), timeout=5)
    assert order == ["first", "second"]
    assert _lock_map() == {}


async def test_regenerate_all_trees_rewrites_stale_presets(db_session):
    """A preset left behind by older code is rebuilt and flagged for export; a second pass changes nothing."""
    from contextlib import asynccontextmanager

    tree, _ = await _make_tree(db_session)
    await store.regenerate_tree(db_session, tree.id)
    await db_session.execute(FilamentTreeLeaf.__table__.update().values(export_pending=False))
    stale = (await db_session.execute(select(FilamentPreset).limit(1))).scalar_one()
    fresh = stale.content
    stale.content = json.dumps({"inherits": "old parent"})
    await db_session.commit()

    @asynccontextmanager
    async def factory():
        yield db_session

    assert await store.regenerate_all_trees(factory) == 1
    await db_session.refresh(stale)
    assert stale.content == fresh
    assert await store.regenerate_all_trees(factory) == 0


async def test_values_every_colour_shares_move_up_without_changing_a_leaf(db_session):
    tree, red = await _make_tree(db_session)
    blue = await store.add_color(db_session, tree.id, "Blue", "#0000FF")
    await store.set_node_values(db_session, tree.id, "H2S", "0.4", red.id, {"fan_min_speed": ["40"]}, [])
    # one colour alone: nothing moves
    assert await db_session.scalar(select(func.count()).select_from(store.FilamentTreeOverride)) == 1
    both = {"fan_min_speed": ["40"], "nozzle_temperature": ["250"]}
    await store.set_node_values(db_session, tree.id, "H2S", "0.4", red.id, {"nozzle_temperature": ["250"]}, [])
    await store.set_node_values(db_session, tree.id, "H2S", "0.4", blue, both | {"fan_max_speed": ["90"]}, [])
    await store.set_node_values(db_session, tree.id, None, None, red.id, {"filament_shrink": ["99%"]}, [])
    await store.set_node_values(db_session, tree.id, None, None, blue, {"filament_shrink": ["99%"]}, [])

    rows = {
        (o.machine, o.nozzle, o.color_id): json.loads(o.values)
        for o in (await db_session.execute(select(store.FilamentTreeOverride))).scalars()
    }
    assert rows == {("H2S", "0.4", 0): both, ("H2S", "0.4", blue): {"fan_max_speed": ["90"]}}
    await db_session.refresh(tree)
    assert json.loads(tree.own_values)["filament_shrink"] == ["99%"]
    # Red no longer needs its own leaves; its values reach it through the shared one
    names = await _presets(db_session)
    assert not any(" - Red " in n for n in names) and "Polymaker PETG - Blue @H2S 0.4" in names
    shared = (
        await db_session.execute(select(FilamentPreset).where(FilamentPreset.name == "Polymaker PETG @H2S 0.4"))
    ).scalar_one()
    assert all(json.loads(shared.content)[k] == v for k, v in both.items())
