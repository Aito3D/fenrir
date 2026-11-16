import json

import pytest
from sqlalchemy import select

from backend.app.models.filament_profile import FilamentPreset
from backend.app.models.filament_tree import FilamentTree, FilamentTreeColor, FilamentTreeLeaf, FilamentTreeOverride
from backend.app.schemas.filament_profile import _CONTENT_MAX_LENGTH
from backend.app.services import filament_tree_pull as pull, filament_tree_store as store
from backend.app.services.filament_tree_pull import LeafState, plan_pull

_SYNCED = object()


def leaf(name="T - Red @H2S 0.4", generated=None, baseline=_SYNCED, is_source=False, color_id=1):
    """baseline defaults to a copy of generated: a leaf already synced with Orca."""
    gen = generated or {"nozzle_temperature": ["246"], "filament_start_gcode": ["M900 K0.04"], "name": name}
    return LeafState(1, "H2S", "0.4", color_id, name, gen, dict(gen) if baseline is _SYNCED else baseline, is_source)


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


def test_plan_pull_same_value_both_sides_refreshes_baseline_only():
    lf = leaf(generated={"nozzle_temperature": ["250"]}, baseline={"nozzle_temperature": ["246"]})
    p = plan_pull([orca("T - Red @H2S 0.4", nozzle_temperature=["250"])], [lf], set())
    assert p.conflicts == [] and p.applied == []
    assert p.refresh[0]["keys"] == ["nozzle_temperature"]


def test_plan_pull_orca_metadata_is_never_applied():
    meta = dict.fromkeys(("setting_id", "base_id", "filament_id", "user_id", "updated_time", "instantiation"), "x")
    meta |= {
        "is_custom_defined": "0",
        "compatible_printers_condition": "",
        "compatible_prints": [],
        "compatible_prints_condition": "",
    }
    p = plan_pull([orca("T - Red @H2S 0.4", **meta)], [leaf()], set())
    assert p.applied == [] and p.conflicts == [] and p.refresh == []


def test_plan_pull_key_missing_from_orca_is_ignored():
    lf = leaf(
        baseline={"nozzle_temperature": ["246"], "gone": ["1"]},
        generated={"nozzle_temperature": ["246"], "gone": ["1"]},
    )
    p = plan_pull([orca("T - Red @H2S 0.4", nozzle_temperature=["246"])], [lf], set())
    assert p.ignored == 1 and p.applied == []


def test_plan_pull_source_edit_goes_to_deepest_owning_node():
    lf = leaf(is_source=True)
    lf.owned_at = {"nozzle_temperature": "machine", "filament_density": "node"}
    e = orca("T - Red @H2S 0.4", nozzle_temperature=["250"], filament_density=["1.3"], filament_cost=["30"])
    p = plan_pull([e], [lf], set())
    assert {a["target"]: sorted(a["values"]) for a in p.applied} == {
        "machine": ["nozzle_temperature"],
        "node": ["filament_density"],
        "root": ["filament_cost"],
    }


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
    exported = leaf(name="exported", baseline=None)
    exported.exported = True
    assert plan_pull([], [lf, leaf(name="other", baseline=None), exported], set()).missing == [lf.name, "exported"]


def test_plan_pull_no_baseline_equal_stores_orca_content():
    lf = leaf(baseline=None)
    e = orca(lf.name, nozzle_temperature=["246"], filament_start_gcode=["M900 K0.04"])
    p = plan_pull([e], [lf], set())
    assert p.applied == [] and p.conflicts == [] and p.refresh == []
    assert p.baselines == [{"tree_id": 1, "machine": "H2S", "nozzle": "0.4", "color_id": 1, "content": e["content"]}]


def test_plan_pull_no_baseline_difference_is_conflict_not_applied():
    lf = leaf(baseline=None)
    e = orca(lf.name, nozzle_temperature=["250"], filament_start_gcode=["M900 K0.04"], fan_min_speed=["40"])
    p = plan_pull([e], [lf], set())
    assert p.applied == [] and p.refresh == [] and len(p.baselines) == 1
    assert {(c["key"], str(c["fenrir_value"]), str(c["orca_value"])) for c in p.conflicts} == {
        ("nozzle_temperature", "['246']", "['250']"),
        ("fan_min_speed", "None", "['40']"),
    }


def _vals(lf):
    return {k: v for k, v in lf.generated.items() if k != "name"}


async def _mark_synced(db):
    """Pretend every leaf was already seen in Orca as generated."""
    for link, preset in (await db.execute(select(FilamentTreeLeaf, FilamentPreset).join(FilamentPreset))).all():
        link.baseline_content = preset.content
    await db.commit()


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
    # first sight: Orca's content becomes the baseline
    await pull.apply_pull(db_session, plan_pull([orca(target.name, **_vals(target))], leaves, names))
    leaves, _ = await pull.collect_leaf_states(db_session)
    target = next(lf for lf in leaves if lf.name == target.name)
    assert target.baseline is not None
    plan = plan_pull([orca(target.name, **{**_vals(target), "nozzle_temperature": ["255"]})], leaves, names)
    await pull.apply_pull(db_session, plan)
    leaves, _ = await pull.collect_leaf_states(db_session)
    after = next(lf for lf in leaves if lf.name == target.name)
    assert after.generated["nozzle_temperature"] == ["255"] == after.baseline["nozzle_temperature"]
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
    refused = await pull.apply_pull(db_session, plan)
    assert refused == {(tree.id, "H2S", "0.4", 2): {"pressure_advance"}}
    assert plan.ignored == before + 1  # pressure_advance refused on root, filament_diameter applied
    leaves, _ = await pull.collect_leaf_states(db_session)
    after = next(lf for lf in leaves if lf.name == name)
    assert after.baseline["nozzle_temperature"] == ["246"] and after.generated["nozzle_temperature"] == ["250"]
    assert after.generated["filament_diameter"] == ["1.7"]
    await pull.resolve_conflict(db_session, tree.id, "H2S", "0.4", 2, "nozzle_temperature", ["240"], ["240"])
    leaves, _ = await pull.collect_leaf_states(db_session)
    after = next(lf for lf in leaves if lf.name == name)
    assert after.generated["nozzle_temperature"] == after.baseline["nozzle_temperature"] == ["240"]


@pytest.mark.asyncio
async def test_source_leaf_owned_key_and_is_source_flags(db_session):
    tree = await _tree(db_session)
    await store.set_node_values(db_session, tree.id, "H2S", None, None, {"nozzle_temperature": ["240"]}, [])
    await _mark_synced(db_session)
    leaves, _ = await pull.collect_leaf_states(db_session)
    by = {lf.name: lf for lf in leaves}
    src = by["Polymaker PETG - Red @H2S 0.4"]
    assert src.is_source and src.owned_at == {"nozzle_temperature": "machine"}
    assert not by["Polymaker PETG - Blue @H2S 0.4"].is_source
    plan = plan_pull([orca(src.name, nozzle_temperature=["245"])], leaves, set())
    await pull.apply_pull(db_session, plan)
    leaves, _ = await pull.collect_leaf_states(db_session)
    assert next(lf for lf in leaves if lf.name == src.name).generated["nozzle_temperature"] == ["245"]
    assert next(lf for lf in leaves if lf.name == "Polymaker PETG - Blue @H2S 0.6").generated["nozzle_temperature"] == [
        "245"
    ]


@pytest.mark.asyncio
async def test_same_value_pull_and_resolve_write_no_override(db_session):
    tree = await _tree(db_session)
    await store.set_node_values(db_session, tree.id, "H2S", "0.4", 2, {"nozzle_temperature": ["250"]}, [])
    leaves, names = await pull.collect_leaf_states(db_session)
    name = "Polymaker PETG - Blue @H2S 0.4"
    row = (
        await db_session.execute(
            select(FilamentTreeLeaf).where(
                FilamentTreeLeaf.color_id == 2, FilamentTreeLeaf.machine == "H2S", FilamentTreeLeaf.nozzle == "0.4"
            )
        )
    ).scalar_one()
    row.baseline_content = json.dumps({"nozzle_temperature": ["246"]})
    await db_session.commit()
    leaves, names = await pull.collect_leaf_states(db_session)
    plan = plan_pull([orca(name, nozzle_temperature=["250"])], leaves, names)
    assert plan.applied == [] and plan.refresh
    await pull.apply_pull(db_session, plan)
    leaves, _ = await pull.collect_leaf_states(db_session)
    assert next(lf for lf in leaves if lf.name == name).baseline["nozzle_temperature"] == ["250"]
    # resolve with the Fenrir value: baseline records Orca's value, override row untouched
    row.baseline_content = json.dumps({"nozzle_temperature": ["246"]})
    await db_session.commit()
    before = (await db_session.execute(select(FilamentTreeOverride.values))).scalars().all()
    await pull.resolve_conflict(db_session, tree.id, "H2S", "0.4", 2, "nozzle_temperature", ["250"], ["240"])
    assert (await db_session.execute(select(FilamentTreeOverride.values))).scalars().all() == before
    await db_session.refresh(row)
    assert json.loads(row.baseline_content)["nozzle_temperature"] == ["240"]
    # next SYNC, Orca still holds 240: Fenrir changed only -> nothing applied, no conflict
    leaves, names = await pull.collect_leaf_states(db_session)
    plan = plan_pull([orca(name, nozzle_temperature=["240"])], leaves, names)
    assert plan.applied == [] and plan.conflicts == [] and plan.refresh == []


@pytest.mark.asyncio
async def test_apply_pull_refresh_key_absent_from_generated(db_session):
    """Orca holds null for a key Fenrir cleared: the baseline drops it instead of raising KeyError."""
    tree = await _tree(db_session)
    await _mark_synced(db_session)
    leaves, names = await pull.collect_leaf_states(db_session)
    lf = next(x for x in leaves if x.name == "Polymaker PETG - Blue @H2S 0.4")
    link, _ = await pull._leaf_preset(db_session, tree.id, "H2S", "0.4", lf.color_id)
    link.baseline_content = json.dumps({**lf.generated, "fan_min_speed": ["40"]})
    await db_session.commit()
    leaves, names = await pull.collect_leaf_states(db_session)
    plan = plan_pull([orca(lf.name, fan_min_speed=None)], leaves, names)
    assert plan.refresh and plan.refresh[0]["keys"] == ["fan_min_speed"]
    await pull.apply_pull(db_session, plan)
    await db_session.refresh(link)
    assert "fan_min_speed" not in json.loads(link.baseline_content)


@pytest.mark.asyncio
async def test_apply_pull_rolls_back_a_tree_whose_regeneration_fails(db_session):
    await _tree(db_session)
    await _mark_synced(db_session)
    leaves, names = await pull.collect_leaf_states(db_session)
    lf = next(x for x in leaves if x.name == "Polymaker PETG - Blue @H2S 0.4")
    huge = "x" * (_CONTENT_MAX_LENGTH + 1)
    plan = plan_pull([orca(lf.name, nozzle_temperature=["255"], filament_notes=huge)], leaves, names)
    assert plan.applied and plan.ignored == 0
    refused = await pull.apply_pull(db_session, plan)
    assert refused == {(lf.tree_id, lf.machine, lf.nozzle, lf.color_id): {"nozzle_temperature", "filament_notes"}}
    assert plan.ignored == 2  # both keys of the refused tree
    leaves, _ = await pull.collect_leaf_states(db_session)
    after = next(x for x in leaves if x.name == lf.name)
    assert after.generated == lf.generated and after.baseline == lf.baseline
    overrides = (await db_session.execute(select(FilamentTreeOverride))).scalars().all()
    assert overrides == []


@pytest.mark.asyncio
async def test_first_sight_conflict_kept_absent_in_fenrir(db_session):
    """NULL baseline: an Orca-only key is a conflict; keeping Fenrir's absence (None) writes nothing."""
    tree = await _tree(db_session)
    leaves, names = await pull.collect_leaf_states(db_session)
    lf = next(x for x in leaves if x.name == "Polymaker PETG - Blue @H2S 0.4")
    plan = plan_pull([orca(lf.name, **_vals(lf), fan_min_speed=["40"])], leaves, names)
    assert [c["key"] for c in plan.conflicts] == ["fan_min_speed"] and plan.applied == []
    await pull.apply_pull(db_session, plan)
    await pull.resolve_conflict(db_session, tree.id, "H2S", "0.4", lf.color_id, "fan_min_speed", None, ["40"])
    leaves, names = await pull.collect_leaf_states(db_session)
    after = next(x for x in leaves if x.name == lf.name)
    assert "fan_min_speed" not in after.generated and after.baseline["fan_min_speed"] == ["40"]
    again = plan_pull([orca(lf.name, **_vals(lf), fan_min_speed=["40"])], leaves, names)
    assert again.conflicts == [] and again.applied == []


def test_plan_pull_missing_list_is_sorted():
    leaves = [leaf(name=n, baseline={"nozzle_temperature": ["246"]}) for n in ("zeta", "alpha", "mid")]
    assert plan_pull([], leaves, set()).missing == ["alpha", "mid", "zeta"]


@pytest.mark.asyncio
async def test_leaf_preset_missing_preset_names_the_leaf(db_session, monkeypatch):
    tree = await _tree(db_session)
    leaves, _ = await pull.collect_leaf_states(db_session)
    lf = next(x for x in leaves if x.name == "Polymaker PETG - Blue @H2S 0.4")
    real_get = db_session.get

    async def get(model, *args, **kwargs):
        return None if model is FilamentPreset else await real_get(model, *args, **kwargs)

    monkeypatch.setattr(db_session, "get", get)
    with pytest.raises(LookupError, match=rf"preset \d+ of leaf H2S 0\.4 \(colour {lf.color_id}\) is missing"):
        await pull._leaf_preset(db_session, tree.id, "H2S", "0.4", lf.color_id)
