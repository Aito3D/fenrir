import json

import pytest
from sqlalchemy import select

from backend.app.models.filament_tree import FilamentTree, FilamentTreeColor, FilamentTreeLeaf
from backend.app.services import filament_tree_pull as pull, filament_tree_store as store
from backend.app.services.filament_tree_pull import LeafState, plan_pull


def leaf(name="T - Red @H2S 0.4", generated=None, baseline=None, is_source=False, color_id=1):
    gen = generated or {"nozzle_temperature": ["246"], "filament_start_gcode": ["M900 K0.04"], "name": name}
    return LeafState(1, "H2S", "0.4", color_id, name, gen, baseline, is_source)


def orca(name, **vals):
    return {"id": "x", "name": name, "content": {"type": "filament", "name": name, **vals}}


def test_plan_pull_leaf_edit_lands_on_colour():
    p = plan_pull([orca("T - Red @H2S 0.4", nozzle_temperature=["250"])], [leaf()], set())
    assert p.applied == [
        {
            "tree_id": 1,
            "machine": "H2S",
            "nozzle": "0.4",
            "color_id": 1,
            "target": "color",
            "values": {"nozzle_temperature": ["250"]},
        }
    ]


def test_plan_pull_source_leaf_edit_lands_on_root_and_node():
    e = orca("T - Red @H2S 0.4", nozzle_temperature=["250"], filament_start_gcode=["M900 K0.1"])
    p = plan_pull([e], [leaf(is_source=True)], set())
    assert {a["target"]: a["values"] for a in p.applied} == {
        "root": {"nozzle_temperature": ["250"]},
        "node": {"filament_start_gcode": ["M900 K0.1"]},
    }


def test_plan_pull_conflict_when_both_changed():
    lf = leaf(generated={"nozzle_temperature": ["250"]}, baseline={"nozzle_temperature": ["246"]})
    p = plan_pull([orca("T - Red @H2S 0.4", nozzle_temperature=["240"])], [lf], set())
    assert p.applied == []
    assert p.conflicts[0]["key"] == "nozzle_temperature"
    assert (p.conflicts[0]["fenrir_value"], p.conflicts[0]["orca_value"]) == (["250"], ["240"])


def test_plan_pull_same_value_both_sides_is_not_conflict():
    lf = leaf(generated={"nozzle_temperature": ["250"]}, baseline={"nozzle_temperature": ["246"]})
    p = plan_pull([orca("T - Red @H2S 0.4", nozzle_temperature=["250"])], [lf], set())
    assert p.conflicts == []


def test_plan_pull_legacy_copy_not_candidate():
    p = plan_pull([orca("T - Red", **{"from": "User"})], [], {"T - Red"})
    assert p.legacy == 1 and p.candidates == []


def test_plan_pull_new_profile_is_candidate():
    p = plan_pull([orca("Fresh PLA", **{"from": "user"}), orca("Other @BBL X1C", **{"from": "system"})], [], set())
    assert [c["name"] for c in p.candidates] == ["Fresh PLA"] and p.ignored == 1


def test_plan_pull_skips_non_filament():
    e = {"id": "1", "name": "Fresh PLA", "content": {"type": "process"}}
    p = plan_pull([e], [], set())
    assert p.candidates == [] and p.ignored == 0


def test_plan_pull_missing_leaf_reported():
    lf = leaf(baseline={"nozzle_temperature": ["246"]})
    assert plan_pull([], [lf, leaf(name="other")], set()).missing == [lf.name]


def test_plan_pull_no_baseline_uses_generated():
    p = plan_pull([orca("T - Red @H2S 0.4", nozzle_temperature=["246"])], [leaf()], set())
    assert p.applied == [] and p.conflicts == []


async def _tree(db):
    tree = FilamentTree(
        name="Polymaker PETG",
        brand="Polymaker",
        material="PETG",
        base_family="Generic PETG",
        source_machine="H2S",
        source_nozzle="0.4",
    )
    db.add(tree)
    await db.flush()
    db.add_all(
        [
            FilamentTreeColor(tree_id=tree.id, name="Red", hex="#FF0000"),
            FilamentTreeColor(tree_id=tree.id, name="Blue", hex="#0000FF"),
        ]
    )
    await db.flush()
    tree.source_color_id = (
        (await db.execute(select(FilamentTreeColor.id).order_by(FilamentTreeColor.id))).scalars().first()
    )
    await db.commit()
    await store.regenerate_tree(db, tree.id)
    await db.commit()
    return tree


@pytest.mark.asyncio
async def test_apply_pull_writes_and_sets_baseline(db_session):
    tree = await _tree(db_session)
    leaves, names = await pull.collect_leaf_states(db_session)
    target = next(lf for lf in leaves if lf.name == "Polymaker PETG - Blue @H2S 0.4")
    assert "Polymaker PETG - Blue" in names and target.baseline is None
    plan = plan_pull([orca(target.name, nozzle_temperature=["255"])], leaves, names)
    await pull.apply_pull(db_session, plan)
    leaves, _ = await pull.collect_leaf_states(db_session)
    after = next(lf for lf in leaves if lf.name == target.name)
    assert after.generated["nozzle_temperature"] == ["255"] and after.baseline == after.generated
    other = next(lf for lf in leaves if lf.name == "Polymaker PETG - Blue @H2D 0.4")
    assert "nozzle_temperature" not in other.generated  # colour edit does not leak to siblings
    assert tree.id == after.tree_id


@pytest.mark.asyncio
async def test_apply_pull_keeps_conflict_held_and_skips_refused_key(db_session):
    tree = await _tree(db_session)
    await store.set_node_values(db_session, tree.id, "H2S", "0.4", 2, {"nozzle_temperature": ["250"]}, [])
    leaves, names = await pull.collect_leaf_states(db_session)
    name = "Polymaker PETG - Blue @H2S 0.4"
    base = {"nozzle_temperature": ["246"]}
    row = (
        await db_session.execute(
            select(FilamentTreeLeaf).where(
                FilamentTreeLeaf.color_id == 2, FilamentTreeLeaf.machine == "H2S", FilamentTreeLeaf.nozzle == "0.4"
            )
        )
    ).scalar_one()
    row.baseline_content = json.dumps({**next(lf for lf in leaves if lf.name == name).generated, **base})
    await db_session.commit()
    leaves, names = await pull.collect_leaf_states(db_session)
    plan = plan_pull(
        [orca(name, nozzle_temperature=["240"], filament_diameter=["1.7"], **{"from": "User"})], leaves, names
    )
    assert len(plan.conflicts) == 1
    plan.applied.append(
        {
            **{k: plan.conflicts[0][k] for k in ("tree_id", "machine", "nozzle", "color_id")},
            "target": "root",
            "values": {"pressure_advance": ["0.1"], "filament_diameter": ["1.7"]},
        }
    )
    before = plan.ignored
    await pull.apply_pull(db_session, plan)
    assert plan.ignored == before + 1  # pressure_advance refused on root, filament_diameter applied
    leaves, _ = await pull.collect_leaf_states(db_session)
    after = next(lf for lf in leaves if lf.name == name)
    assert after.baseline["nozzle_temperature"] == ["246"] and after.generated["nozzle_temperature"] == ["250"]
    assert after.generated["filament_diameter"] == ["1.7"]
    await pull.resolve_conflict(db_session, tree.id, "H2S", "0.4", 2, "nozzle_temperature", ["240"])
    leaves, _ = await pull.collect_leaf_states(db_session)
    after = next(lf for lf in leaves if lf.name == name)
    assert after.generated["nozzle_temperature"] == after.baseline["nozzle_temperature"] == ["240"]
