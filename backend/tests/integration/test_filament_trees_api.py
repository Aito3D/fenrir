"""Integration tests for /api/v1/filament-trees and the managed-row lock on /filament-profiles."""

import io
import json
import zipfile

import pytest
from sqlalchemy import func, select

from backend.app.api.routes import filament_trees as routes
from backend.app.models.filament_profile import BaseFilamentPreset, FilamentPreset
from backend.app.models.filament_tree import FilamentTree, FilamentTreeColor, FilamentTreeLeaf
from backend.app.services import filament_tree_store as store
from backend.tests.integration.test_filament_profiles_api import _create_user_with_perms, _setup_admin

API = "/api/v1/filament-trees"


async def _tree(db, name="Polymaker PETG"):
    tree = FilamentTree(
        name=name,
        brand="Polymaker",
        material="PETG",
        base_family="Generic PETG",
        fallback_inherits="Generic PETG @base",
        own_values=json.dumps({"nozzle_temperature": ["245"], "hot_plate_temp": ["70"]}),
        source_machine="H2S",
        source_nozzle="0.4",
    )
    db.add(tree)
    await db.flush()
    white = FilamentTreeColor(tree_id=tree.id, name="White", hex="#FFFFFF", sort=0)
    red = FilamentTreeColor(tree_id=tree.id, name="Red", hex="#FF0000", sort=1)
    db.add_all([white, red])
    await db.flush()
    tree.source_color_id = white.id
    await db.commit()
    await store.regenerate_tree(db, tree.id)
    await db.commit()
    return tree, white, red


class _StubOrca:
    def __init__(self, entries):
        self.entries = entries
        self.closed = False

    async def list_profiles(self):
        return self.entries

    async def get_profile(self, profile_id):
        return next(e for e in self.entries if e["id"] == profile_id)

    async def close(self):
        self.closed = True


def _stub_orca(monkeypatch, entries):
    stub = _StubOrca(entries)

    async def build(_db, _user, **_kw):
        return stub

    monkeypatch.setattr(routes, "_build_authenticated_service", build)
    return stub


async def test_list_trees_shape(async_client, db_session):
    tree, white, red = await _tree(db_session)
    await store.set_node_values(db_session, tree.id, "H2S", None, None, {"hot_plate_temp": ["75"]}, [])
    await store.set_node_values(db_session, tree.id, "H2S", "0.4", None, {"pressure_advance": ["0.03"]}, [])
    await store.set_node_values(db_session, tree.id, "H2S", "0.6", red.id, {"nozzle_temperature": ["250"]}, [])
    await store.set_node_values(db_session, tree.id, None, None, red.id, {"fan_min_speed": ["40"]}, [])

    r = await async_client.get(API)
    assert r.status_code == 200, r.text
    [row] = r.json()
    assert row["id"] == tree.id and row["name"] == "Polymaker PETG"
    assert (row["brand"], row["material"], row["skip_02"], row["abrasive"]) == ("Polymaker", "PETG", None, False)
    assert row["source"] == {"machine": "H2S", "nozzle": "0.4", "color_id": white.id}
    assert row["colors"] == [
        {"id": white.id, "name": "White", "hex": "#FFFFFF"},
        {"id": red.id, "name": "Red", "hex": "#FF0000"},
    ]
    assert row["own_counts"] == {
        "root": 2,
        "H2S": 1,
        "H2S/0.4": 1,
        f"H2S/0.6/{red.id}": 1,
        f"color:{red.id}": 1,
    }


async def test_node_get_reports_sources_and_inherited(async_client, db_session, monkeypatch):
    tree, _, red = await _tree(db_session)
    await store.set_node_values(db_session, tree.id, "H2S", None, None, {"hot_plate_temp": ["75"]}, [])
    await store.set_node_values(db_session, tree.id, "H2S", "0.4", None, {"pressure_advance": ["0.03"]}, [])
    await store.set_node_values(db_session, tree.id, None, None, red.id, {"hot_plate_temp": ["72"]}, [])
    await store.set_node_values(db_session, tree.id, "H2S", "0.4", red.id, {"nozzle_temperature": ["250"]}, [])
    db_session.add(BaseFilamentPreset(name="Generic PETG @BBL H2S 0.4 nozzle", filename="g.json"))
    await db_session.commit()

    class _Reader:
        def values(self, name):
            assert name == "Generic PETG @BBL H2S 0.4 nozzle"
            return {"name": name, "type": "filament", "nozzle_temperature": ["240"], "cool_plate_temp": ["35"]}

    async def reader(_db):
        return _Reader()

    monkeypatch.setattr(routes, "build_base_reader", reader)

    r = await async_client.get(f"{API}/{tree.id}/node", params={"machine": "H2S", "nozzle": "0.4", "color_id": red.id})
    assert r.status_code == 200, r.text
    rows = {row["key"]: row for row in r.json()}
    assert rows["nozzle_temperature"] == {
        "key": "nozzle_temperature",
        "value": ["250"],
        "source": "color",
        "own": True,
        "inherited_value": ["245"],
        "inherited_source": "root",
        "source_label": None,
    }
    assert (rows["hot_plate_temp"]["value"], rows["hot_plate_temp"]["source"]) == (["72"], "colorwide")
    assert rows["hot_plate_temp"]["own"] is False
    assert (rows["pressure_advance"]["source"], rows["pressure_advance"]["own"]) == ("nozzle", False)
    assert rows["cool_plate_temp"]["source"] == "bambu"
    assert rows["cool_plate_temp"]["source_label"] == "Generic PETG @BBL H2S 0.4 nozzle"
    assert "name" not in rows and "type" not in rows

    # colour-wide node: own hot_plate_temp, inherited from the root
    r = await async_client.get(f"{API}/{tree.id}/node", params={"color_id": red.id})
    rows = {row["key"]: row for row in r.json()}
    assert rows["hot_plate_temp"]["own"] is True and rows["hot_plate_temp"]["source"] == "colorwide"
    assert (rows["hot_plate_temp"]["inherited_value"], rows["hot_plate_temp"]["inherited_source"]) == (["70"], "root")
    assert all(row["source"] != "bambu" for row in rows.values())

    # machine node inherits from the root
    r = await async_client.get(f"{API}/{tree.id}/node", params={"machine": "H2S"})
    rows = {row["key"]: row for row in r.json()}
    hot = rows["hot_plate_temp"]
    assert (hot["value"], hot["own"], hot["inherited_value"], hot["inherited_source"]) == (["75"], True, ["70"], "root")

    assert (await async_client.get(f"{API}/9999/node")).status_code == 404


async def test_node_put_root_nozzle_bound_400(async_client, db_session):
    tree, _, red = await _tree(db_session)
    r = await async_client.put(f"{API}/{tree.id}/node", json={"set": {"pressure_advance": ["0.02"]}})
    assert r.status_code == 400 and "nozzle-bound" in r.json()["detail"]

    r = await async_client.put(
        f"{API}/{tree.id}/node",
        json={"machine": "H2S", "nozzle": "0.4", "color_id": red.id, "set": {"nozzle_temperature": ["250"]}},
    )
    assert r.status_code == 200, r.text
    preset = (
        await db_session.execute(select(FilamentPreset).where(FilamentPreset.name == "Polymaker PETG - Red @H2S 0.4"))
    ).scalar_one()
    await db_session.refresh(preset)
    assert json.loads(preset.content)["nozzle_temperature"] == ["250"]

    r = await async_client.put(f"{API}/{tree.id}/node", json={"color_id": 9999, "set": {"x": ["1"]}})
    assert r.status_code == 404


async def test_sync_applies_and_returns_plan(async_client, db_session, monkeypatch):
    tree, _, red = await _tree(db_session)
    await async_client.post(f"{API}/export", json={"tree_id": tree.id})
    preset = (
        await db_session.execute(select(FilamentPreset).where(FilamentPreset.name == "Polymaker PETG - Red @H2S 0.4"))
    ).scalar_one()
    content = json.loads(preset.content) | {"type": "filament", "nozzle_temperature": ["255"]}
    stub = _stub_orca(
        monkeypatch,
        [
            {"id": "a", "name": preset.name, "content": content},
            {"id": "b", "name": "eSUN PLA+ - Blue", "content": {"type": "filament", "from": "User"}},
        ],
    )

    r = await async_client.post(f"{API}/sync")
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"applied", "conflicts", "candidates", "legacy", "missing", "ignored", "refresh"}
    [applied] = body["applied"]
    assert applied["target"] == "color" and applied["values"] == {"nozzle_temperature": ["255"]}
    assert [c["orca_id"] for c in body["candidates"]] == ["b"]
    assert stub.closed
    r = await async_client.get(f"{API}/{tree.id}/node", params={"machine": "H2S", "nozzle": "0.4", "color_id": red.id})
    assert {row["key"]: row["value"] for row in r.json()}["nozzle_temperature"] == ["255"]


async def test_sync_requires_orca_permission(async_client, db_session, monkeypatch):
    _stub_orca(monkeypatch, [])
    admin = await _setup_admin(async_client, username="ftadmin")
    token = await _create_user_with_perms(
        async_client, admin, username="ft_update_only", permissions=["filaments:update", "filaments:read"]
    )
    r = await async_client.post(f"{API}/sync", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 403
    token = await _create_user_with_perms(
        async_client, admin, username="ft_update_orca", permissions=["filaments:update", "orca_cloud:auth"]
    )
    r = await async_client.post(f"{API}/sync", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, r.text


async def test_export_returns_zip(async_client, db_session):
    tree, _, _ = await _tree(db_session)
    r = await async_client.post(f"{API}/export", json={"tree_id": tree.id})
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    assert r.headers["content-disposition"] == 'attachment; filename="fenrir-filaments.zip"'
    assert len(zipfile.ZipFile(io.BytesIO(r.content)).namelist()) == 32
    assert (await async_client.post(f"{API}/export", json={})).status_code == 200
    assert (await async_client.post(f"{API}/export", json={"tree_id": 9999})).status_code == 404


async def test_migrate_then_list(async_client, db_session):
    ids = {}
    for color in ("White", "Red"):
        name = f"Polymaker PETG - {color}"
        content = {"name": name, "inherits": "Bambu PETG Basic @BBL H2S", "nozzle_temperature": ["245"]}
        row = FilamentPreset(name=name, brand="Polymaker", material="PETG", color=color, content=json.dumps(content))
        db_session.add(row)
        await db_session.flush()
        ids[color] = row.id
    await db_session.commit()

    r = await async_client.get(f"{API}/unmanaged")
    assert r.status_code == 200, r.text
    [group] = r.json()
    assert group["prefix"] == "Polymaker PETG" and group["proposed_source_preset_id"] == ids["White"]

    body = {
        "groups": [{"prefix": "Polymaker PETG", "source_preset_id": ids["White"], "machine": "H2S", "nozzle": "0.4"}]
    }
    r = await async_client.post(f"{API}/migrate", json=body)
    assert r.status_code == 200, r.text
    [tree_id] = r.json()["tree_ids"]
    assert [t["id"] for t in (await async_client.get(API)).json()] == [tree_id]
    assert (await async_client.get(f"{API}/unmanaged")).json() == []
    assert (await async_client.post(f"{API}/migrate", json=body)).status_code == 400


async def test_literal_routes_not_shadowed(async_client, db_session):
    r = await async_client.get(f"{API}/targets")
    assert r.status_code == 200
    assert r.json() == {"machines": ["X2D", "H2S", "H2D", "H2C"], "nozzles": ["0.2", "0.4", "0.6", "0.8"]}
    r = await async_client.put(f"{API}/targets", json={"machines": ["H2S"], "nozzles": ["0.4"]})
    assert r.status_code == 200 and r.json() == {"machines": ["H2S"], "nozzles": ["0.4"]}
    assert (await async_client.put(f"{API}/targets", json={"machines": [], "nozzles": ["0.4"]})).status_code == 400


async def test_patch_managed_preset_is_409(async_client, db_session):
    tree, _, _ = await _tree(db_session)
    [pid] = list(await store.managed_preset_ids(db_session))[:1]
    r = await async_client.patch(f"/api/v1/filament-profiles/{pid}", json={"name": "x"})
    assert r.status_code == 409
    assert r.json()["detail"] == "This profile is managed by a filament tree — edit it on the tree"
    assert (await async_client.post(f"/api/v1/filament-profiles/{pid}/duplicate")).status_code == 409


async def test_delete_managed_preset_is_409(async_client, db_session):
    tree, _, _ = await _tree(db_session)
    [pid] = list(await store.managed_preset_ids(db_session))[:1]
    assert (await async_client.delete(f"/api/v1/filament-profiles/{pid}")).status_code == 409
    assert await db_session.get(FilamentPreset, pid) is not None


async def test_tree_patch_colors_and_delete(async_client, db_session):
    tree, white, red = await _tree(db_session)
    r = await async_client.patch(f"{API}/{tree.id}", json={"skip_02": True})
    assert r.status_code == 200, r.text
    r = await async_client.patch(f"{API}/{tree.id}", json={"source_color_id": red.id})
    assert r.status_code == 200, r.text
    await db_session.refresh(tree)
    assert (tree.skip_02, tree.source_color_id) == (True, red.id)
    assert (await async_client.patch(f"{API}/{tree.id}", json={"source_nozzle": "0.2"})).status_code == 400

    r = await async_client.post(f"{API}/{tree.id}/colors", json={"name": "Blue", "hex": "#0000FF"})
    assert r.status_code == 200, r.text
    blue = r.json()["id"]
    r = await async_client.patch(f"{API}/{tree.id}/colors/{blue}", json={"name": "Navy", "hex": "#000080"})
    assert r.status_code == 200
    assert (await async_client.delete(f"{API}/{tree.id}/colors/{red.id}")).status_code == 400  # source colour
    assert (await async_client.delete(f"{API}/{tree.id}/colors/{blue}")).status_code == 200
    assert (await async_client.delete(f"{API}/{tree.id}/colors/9999")).status_code == 404

    assert (await async_client.delete(f"{API}/{tree.id}")).status_code == 200
    assert await db_session.scalar(select(func.count()).select_from(FilamentPreset)) == 0
    assert await db_session.scalar(select(func.count()).select_from(FilamentTreeLeaf)) == 0
    assert (await async_client.delete(f"{API}/{tree.id}")).status_code == 404


async def test_candidate_becomes_tree(async_client, db_session, monkeypatch):
    content = {
        "type": "filament",
        "from": "User",
        "name": "eSUN PLA+ - Blue",
        "inherits": "Bambu PLA Basic @BBL H2S",
        "setting_id": "xyz",
        "nozzle_temperature": ["215"],
        "filament_max_volumetric_speed": ["18"],
    }
    _stub_orca(monkeypatch, [{"id": "c1", "name": "eSUN PLA+ - Blue", "content": content}])
    body = {
        "orca_id": "c1",
        "name": "eSUN PLA+ - Blue",
        "brand": "eSUN",
        "material": "PLA+",
        "color_name": "Blue",
        "color_hex": "#0000FF",
        "machine": "H2S",
        "nozzle": "0.4",
    }
    r = await async_client.post(f"{API}/candidates", json=body)
    assert r.status_code == 200, r.text
    tree = await db_session.get(FilamentTree, r.json()["tree_id"])
    assert (tree.name, tree.base_family, tree.fallback_inherits) == (
        "eSUN PLA+",
        "Bambu PLA Basic",
        content["inherits"],
    )
    assert json.loads(tree.own_values) == {"nozzle_temperature": ["215"]}
    preset = (
        await db_session.execute(select(FilamentPreset).where(FilamentPreset.name == "eSUN PLA+ - Blue @H2S 0.4"))
    ).scalar_one()
    assert json.loads(preset.content)["filament_max_volumetric_speed"] == ["18"]
    assert "filament_max_volumetric_speed" not in json.loads(
        (await db_session.execute(select(FilamentPreset).where(FilamentPreset.name == "eSUN PLA+ - Blue @H2S 0.6")))
        .scalar_one()
        .content
    )

    bad = body | {"machine": "P1S"}
    assert (await async_client.post(f"{API}/candidates", json=bad)).status_code == 400


@pytest.mark.parametrize("path", ["", "/targets", "/unmanaged"])
async def test_reads_need_auth(async_client, path):
    await _setup_admin(async_client, username="ftadmin_r")
    assert (await async_client.get(f"{API}{path}")).status_code == 401
