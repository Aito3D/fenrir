"""Integration tests for /api/v1/filament-trees and the managed-row lock on /filament-profiles."""

import asyncio
import io
import json
import zipfile

import pytest
from sqlalchemy import func, select

from backend.app.api.routes import filament_trees as routes
from backend.app.models.filament_profile import BaseFilamentPreset, FilamentPreset
from backend.app.models.filament_tree import FilamentTree, FilamentTreeColor, FilamentTreeLeaf
from backend.app.schemas.filament_profile import _CONTENT_MAX_LENGTH
from backend.app.services import filament_tree_push as push_service, filament_tree_store as store
from backend.app.services.orca_cloud import OrcaCloudAuthError, OrcaCloudError
from backend.app.services.orca_cloud_codec import encode_content
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
    def __init__(self, entries, scope="sync:read"):
        self.entries = entries
        self.scope = scope
        self.closed = False
        self.pushed = []
        self.push_error = None

    async def introspect(self):
        return {"scope": f"external_app:connect {self.scope}"}

    async def delete_profiles(self, ids):
        self.deleted = ids
        self.entries[:] = [e for e in self.entries if e["id"] not in ids or e["id"] == "stuck"]

    async def push_profile(self, **kw):
        if self.push_error:
            raise self.push_error
        self.pushed.append(kw)
        return {"updated_time": 2}

    async def list_profiles(self):
        return self.entries

    async def get_profile(self, profile_id):
        return next(e for e in self.entries if e["id"] == profile_id)

    async def close(self):
        self.closed = True


def _stub_orca(monkeypatch, entries, scope="sync:read"):
    stub = _StubOrca(entries, scope)

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
        {"id": white.id, "name": "White", "hex": "#FFFFFF", "spools": 0, "price": None},
        {"id": red.id, "name": "Red", "hex": "#FF0000", "spools": 0, "price": None},
    ]
    assert row["export_pending"] == 32
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
            return {
                "name": name,
                "type": "filament",
                "nozzle_temperature": ["240"],
                "cool_plate_temp": ["35"],
                "filament_max_volumetric_speed": ["18"],
                "filament_extruder_variant": ["Direct Drive Standard", "Direct Drive High Flow"],
                "filament_flow_ratio": ["0.95", "0.98"],
            }

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
        "variants": None,
    }
    assert (rows["hot_plate_temp"]["value"], rows["hot_plate_temp"]["source"]) == (["72"], "colorwide")
    assert rows["hot_plate_temp"]["own"] is False
    assert (rows["pressure_advance"]["source"], rows["pressure_advance"]["own"]) == ("nozzle", False)
    assert rows["cool_plate_temp"]["source"] == "bambu"
    assert rows["cool_plate_temp"]["source_label"] == "Generic PETG @BBL H2S 0.4 nozzle"
    assert "name" not in rows and "type" not in rows
    # a per-variant array names the extruder variant of each entry
    assert rows["filament_flow_ratio"]["variants"] == ["Direct Drive Standard", "Direct Drive High Flow"]
    assert rows["cool_plate_temp"]["variants"] is None

    # colour-wide node: own hot_plate_temp, inherited from the root
    r = await async_client.get(f"{API}/{tree.id}/node", params={"color_id": red.id})
    rows = {row["key"]: row for row in r.json()}
    assert rows["hot_plate_temp"]["own"] is True and rows["hot_plate_temp"]["source"] == "colorwide"
    assert (rows["hot_plate_temp"]["inherited_value"], rows["hot_plate_temp"]["inherited_source"]) == (["70"], "root")
    # above the nozzle level the Bambu parent is the calibration source's preset (H2S 0.4)
    assert (rows["cool_plate_temp"]["source"], rows["cool_plate_temp"]["value"]) == ("bambu", ["35"])

    # root: an own value shows the Bambu parent value it replaces
    r = await async_client.get(f"{API}/{tree.id}/node")
    temp = {row["key"]: row for row in r.json()}["nozzle_temperature"]
    assert (temp["own"], temp["inherited_value"], temp["inherited_source"]) == (True, ["240"], "bambu")
    assert temp["source_label"] == "Generic PETG @BBL H2S 0.4 nozzle"
    # a nozzle-bound key cannot be set at the root, but its Bambu default still shows
    speed = {row["key"]: row for row in r.json()}["filament_max_volumetric_speed"]
    assert (speed["value"], speed["source"], speed["own"]) == (["18"], "bambu", False)

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


@pytest.mark.parametrize("node", [{}, {"color_id": "red"}, {"machine": "H2S", "nozzle": "0.4", "color_id": "red"}])
async def test_overlapping_node_puts_keep_both_edits(async_client, db_session, node):
    """Two saves of the same node racing (NodePanel saves per field) must both survive, also with no override row yet."""
    tree, _, red = await _tree(db_session)
    body = {k: red.id if v == "red" else v for k, v in node.items()}
    keys = ["hot_plate_temp", "cool_plate_temp"]
    rs = await asyncio.gather(
        *(async_client.put(f"{API}/{tree.id}/node", json={**body, "set": {k: ["60"]}}) for k in keys)
    )
    assert [r.status_code for r in rs] == [200, 200]
    r = await async_client.get(f"{API}/{tree.id}/node", params=body)
    own = {row["key"] for row in r.json() if row["own"]}
    assert set(keys) <= own


async def test_sync_applies_and_returns_plan(async_client, db_session, monkeypatch):
    tree, _, red = await _tree(db_session)
    r = await async_client.post(f"{API}/export", json={"tree_id": tree.id})
    await async_client.post(f"{API}/export/confirm", json={"token": r.headers["x-export-token"]})
    preset = (
        await db_session.execute(select(FilamentPreset).where(FilamentPreset.name == "Polymaker PETG - Red @H2S 0.4"))
    ).scalar_one()
    imported = json.loads(preset.content) | {"type": "filament"}
    entries = [
        {"id": "a", "name": preset.name, "content": imported},
        {"id": "b", "name": "eSUN PLA+ - Blue", "content": {"type": "filament", "from": "User"}},
    ]
    stub = _stub_orca(monkeypatch, entries)
    # first SYNC after the import only records what Orca holds (export never writes the baseline)
    r = await async_client.post(f"{API}/sync")
    assert r.status_code == 200, r.text
    assert r.json()["applied"] == [] and r.json()["conflicts"] == []

    entries[0]["content"] = imported | {"nozzle_temperature": ["255"]}
    preview = (await async_client.get(f"{API}/sync")).json()
    assert preview["pull"] == [
        {"name": preset.name, "changes": {"nozzle_temperature": [imported["nozzle_temperature"], ["255"]]}}
    ]
    assert preview["conflicts"] == [] and preview["writable"] is False  # the stub pairing is read-only
    # every leaf Orca does not hold yet, flagged as new there
    assert preview["push"] and all(p["new"] and p["name"] != preset.name for p in preview["push"])
    r = await async_client.get(f"{API}/{tree.id}/node", params={"machine": "H2S", "nozzle": "0.4", "color_id": red.id})
    assert {row["key"]: row["value"] for row in r.json()}["nozzle_temperature"] != ["255"]  # the preview wrote nothing
    r = await async_client.post(f"{API}/sync")
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"applied", "conflicts", "candidates", "legacy", "missing", "ignored", "refresh", "push"}
    [applied] = body["applied"]
    assert applied["target"] == "color" and applied["values"] == {"nozzle_temperature": ["255"]}
    assert [c["orca_id"] for c in body["candidates"]] == ["b"]
    assert stub.closed
    r = await async_client.get(f"{API}/{tree.id}/node", params={"machine": "H2S", "nozzle": "0.4", "color_id": red.id})
    assert {row["key"]: row["value"] for row in r.json()}["nozzle_temperature"] == ["255"]


async def test_sync_fingerprint_matching_syncs_and_stale_is_409(async_client, db_session, monkeypatch):
    tree, _, red = await _tree(db_session)
    r = await async_client.post(f"{API}/export", json={"tree_id": tree.id})
    await async_client.post(f"{API}/export/confirm", json={"token": r.headers["x-export-token"]})
    preset = (
        await db_session.execute(select(FilamentPreset).where(FilamentPreset.name == "Polymaker PETG - Red @H2S 0.4"))
    ).scalar_one()
    imported = json.loads(preset.content) | {"type": "filament"}
    entries = [{"id": "a", "name": preset.name, "content": imported}]
    _stub_orca(monkeypatch, entries)
    assert (await async_client.post(f"{API}/sync")).status_code == 200  # records the baseline

    entries[0]["content"] = imported | {"nozzle_temperature": ["255"]}
    stale = (await async_client.get(f"{API}/sync")).json()["fingerprint"]
    entries[0]["content"] = imported | {"nozzle_temperature": ["260"]}  # Orca changed after the preview
    node = {"machine": "H2S", "nozzle": "0.4", "color_id": red.id}

    async def temp():
        r = await async_client.get(f"{API}/{tree.id}/node", params=node)
        return {row["key"]: row["value"] for row in r.json()}["nozzle_temperature"]

    before = await temp()
    r = await async_client.post(f"{API}/sync", params={"fingerprint": stale})
    assert r.status_code == 409
    assert await temp() == before  # nothing was pulled
    fresh = (await async_client.get(f"{API}/sync")).json()["fingerprint"]
    assert fresh != stale
    r = await async_client.post(f"{API}/sync", params={"fingerprint": fresh})
    assert r.status_code == 200, r.text
    assert await temp() == ["260"]


async def test_sync_fingerprint_ignores_orca_listing_order(async_client, db_session, monkeypatch):
    await _tree(db_session)
    presets = (await db_session.execute(select(FilamentPreset).order_by(FilamentPreset.id))).scalars().all()[:2]
    assert len(presets) == 2
    imported = [json.loads(p.content) | {"type": "filament"} for p in presets]
    entries = [
        {"id": str(i), "name": p.name, "content": c} for i, (p, c) in enumerate(zip(presets, imported, strict=True))
    ]
    _stub_orca(monkeypatch, entries)
    assert (await async_client.post(f"{API}/sync")).status_code == 200  # records the baselines

    for e, c, temp in zip(
        entries, imported, ("255", "260"), strict=True
    ):  # distinct values, so the order shows in the hash
        e["content"] = c | {"nozzle_temperature": [temp]}
    first = (await async_client.get(f"{API}/sync")).json()["fingerprint"]
    entries.reverse()
    assert (await async_client.get(f"{API}/sync")).json()["fingerprint"] == first


async def test_sync_pushes_changed_leaves(async_client, db_session, monkeypatch, tmp_path):
    monkeypatch.setattr(push_service, "_snapshot_dir", lambda: tmp_path)
    await _tree(db_session)
    rows = (await db_session.execute(select(FilamentTreeLeaf, FilamentPreset).join(FilamentPreset))).all()
    same, edited = rows[0][1], rows[1][1]
    entries = [
        {
            "id": "same",
            "name": same.name,
            "updated_time": 1,
            "content": encode_content(json.loads(same.content) | {"type": "filament"}),
        },
        # first sight with a difference: a conflict, so this leaf must wait for the user
        {
            "id": "edit",
            "name": edited.name,
            "content": encode_content(json.loads(edited.content) | {"type": "filament", "x": ["1"]}),
        },
    ]
    # a read-only pairing pushes nothing and says so
    stub = _stub_orca(monkeypatch, entries)
    push = (await async_client.post(f"{API}/sync")).json()["push"]
    assert push["needs_write_scope"] and push["remaining"] == len(rows) - 2 and not stub.pushed

    stub = _stub_orca(monkeypatch, entries, scope="sync:write")
    r = await async_client.post(f"{API}/sync")
    assert r.status_code == 200, r.text
    push = r.json()["push"]
    assert push["pushed"] == len(rows) - 2 and push["failed"] == []
    # the progress any page can poll: the run is over, and it counted every leaf it had to send
    progress = (await async_client.get(f"{API}/sync/progress")).json()
    assert progress == {
        "running": False,
        "done": len(rows) - 3,
        "total": len(rows) - 2,
        "phase": "clean",
        "name": "",
        "stop": False,
    }
    # a page that lost the response can still read the result
    assert (await async_client.get(f"{API}/sync/last")).json()["push"]["pushed"] == len(rows) - 2
    assert {p["name"] for p in stub.pushed} == {preset.name for _, preset in rows} - {same.name, edited.name}
    assert all(p["content"]["type"] == "filament" and p["original_updated_time"] is None for p in stub.pushed)
    assert json.loads((tmp_path / push["snapshot"]).read_text()) == entries  # Orca as it was before the push
    # Orca Cloud holds one string per setting: a JSON list crashes OrcaSlicer at startup
    assert all(isinstance(v, str) for p in stub.pushed for v in p["content"].values())

    # Orca now holds what was pushed: nothing left to send
    entries += [{"id": p["profile_id"], "name": p["name"], "content": p["content"]} for p in stub.pushed]
    stub = _stub_orca(monkeypatch, entries, scope="sync:write")
    assert (await async_client.post(f"{API}/sync")).json()["push"]["pushed"] == 0 and not stub.pushed

    # a profile the first push release sent as JSON lists is sent again, even though its values match
    entries[0]["content"] = json.loads(same.content) | {"type": "filament"}
    stub = _stub_orca(monkeypatch, entries, scope="sync:write")
    assert (await async_client.post(f"{API}/sync")).json()["push"]["pushed"] == 1
    assert stub.pushed[0]["profile_id"] == "same"
    entries[0]["content"] = stub.pushed[0]["content"]

    # identity keys are no tree values, but Fenrir still owns them: Orca holding another colour or printer list
    # (a colour hex edit here, a re-save in OrcaSlicer there) is sent again
    for key in ("default_filament_colour", "compatible_printers"):
        entries[0]["content"] = stub.pushed[0]["content"] | {key: "other"}
        stub = _stub_orca(monkeypatch, entries, scope="sync:write")
        assert (await async_client.post(f"{API}/sync")).json()["push"]["pushed"] == 1, key
        entries[0]["content"] = stub.pushed[0]["content"]

    # a Fenrir edit goes out as an update of the existing Orca profiles; the conflict shown earlier and left
    # unanswered no longer holds its leaf back (Fenrir is the master)
    tree_id = rows[0][0].tree_id
    r = await async_client.put(f"{API}/{tree_id}/node", json={"set": {"hot_plate_temp": ["75"]}})
    assert r.status_code == 200, r.text
    assert (await async_client.post(f"{API}/sync")).json()["push"]["pushed"] == len(rows)
    by_id = {p["profile_id"]: p for p in stub.pushed}
    assert by_id["same"]["original_updated_time"] == 1 and "edit" in by_id


async def test_sync_does_not_push_a_leaf_whose_orca_edit_was_refused(async_client, db_session, monkeypatch, tmp_path):
    monkeypatch.setattr(push_service, "_snapshot_dir", lambda: tmp_path)
    tree, _, _ = await _tree(db_session)
    r = await async_client.post(f"{API}/export", json={"tree_id": tree.id})
    await async_client.post(f"{API}/export/confirm", json={"token": r.headers["x-export-token"]})
    preset = (
        await db_session.execute(select(FilamentPreset).where(FilamentPreset.name == "Polymaker PETG - Red @H2S 0.4"))
    ).scalar_one()
    imported = json.loads(preset.content) | {"type": "filament"}
    entries = [{"id": "a", "name": preset.name, "updated_time": 1, "content": encode_content(imported)}]
    _stub_orca(monkeypatch, entries, scope="sync:write")
    assert (await async_client.post(f"{API}/sync")).status_code == 200  # records the baseline

    # the OrcaSlicer edit makes the regenerated preset too large: the pull refuses it
    huge = "x" * (_CONTENT_MAX_LENGTH + 1)
    entries[0]["content"] = encode_content(imported | {"nozzle_temperature": [huge]})
    stub = _stub_orca(monkeypatch, entries, scope="sync:write")
    body = (await async_client.post(f"{API}/sync")).json()
    assert body["ignored"] == 1
    assert "a" not in {p["profile_id"] for p in stub.pushed}  # Orca keeps the edit
    assert body["push"]["pushed"] == len(stub.pushed)
    assert body["push"]["held"] == [{"name": preset.name, "keys": ["nozzle_temperature"]}]
    entries[0]["content"] = encode_content(imported)  # a clean listing holds nothing
    assert (await async_client.post(f"{API}/sync")).json()["push"]["held"] == []


async def test_sync_push_stops_after_repeated_failures(async_client, db_session, monkeypatch, tmp_path):
    monkeypatch.setattr(push_service, "_snapshot_dir", lambda: tmp_path)
    await _tree(db_session)
    total = (await db_session.execute(select(func.count()).select_from(FilamentTreeLeaf))).scalar_one()
    stub = _stub_orca(monkeypatch, [], scope="sync:write")
    stub.push_error = OrcaCloudError("Orca Cloud push failed (429): slow down")
    push = (await async_client.post(f"{API}/sync")).json()["push"]
    assert push["pushed"] == 0 and len(push["failed"]) == 5 and push["remaining"] == total - 5


async def test_sync_auth_error_mid_push_keeps_the_baselines_already_pushed(
    async_client, db_session, monkeypatch, tmp_path
):
    monkeypatch.setattr(push_service, "_snapshot_dir", lambda: tmp_path)
    await _tree(db_session)
    stub = _stub_orca(monkeypatch, [], scope="sync:write")
    ok_push = stub.push_profile

    async def push(**kw):
        if len(stub.pushed) == 2:
            raise OrcaCloudAuthError("token expired")
        return await ok_push(**kw)

    stub.push_profile = push
    r = await async_client.post(f"{API}/sync")
    assert r.status_code == 401 and r.json()["detail"] == "token expired"
    assert len(stub.pushed) == 2

    db_session.expire_all()
    rows = (await db_session.execute(select(FilamentTreeLeaf, FilamentPreset).join(FilamentPreset))).all()
    done = [(link, preset) for link, preset in rows if link.baseline_content is not None]
    assert {preset.name for _, preset in done} == {p["name"] for p in stub.pushed}
    for link, preset in done:
        assert link.exported_at is not None and link.export_pending is False
        assert json.loads(link.baseline_content) == json.loads(preset.content)
    assert len(done) == 2
    assert all(link.export_pending is not False for link, _ in rows if link.baseline_content is None)  # the rest wait


async def test_orca_cleanup_deletes_only_stray_filaments(async_client, db_session, monkeypatch, tmp_path):
    monkeypatch.setattr(push_service, "_snapshot_dir", lambda: tmp_path)
    await _tree(db_session)
    leaf = (await db_session.execute(select(FilamentPreset).join(FilamentTreeLeaf))).scalars().first()
    entries = [
        {"id": "leaf", "name": leaf.name, "content": {"type": "filament"}},
        {"id": "old", "name": "Polymaker PETG - Red", "content": {"type": "filament"}},
        {"id": "stuck", "name": "eSUN PLA+ - Blue", "content": {"type": "filament"}},
        {"id": "proc", "name": "0.20mm Standard", "content": {"type": "print"}},
    ]
    stub = _stub_orca(monkeypatch, entries)
    r = await async_client.get(f"{API}/orca-cleanup")
    assert r.json() == {"count": 2, "names": ["Polymaker PETG - Red", "eSUN PLA+ - Blue"], "writable": False}
    seen = ["Polymaker PETG - Red", "eSUN PLA+ - Blue"]
    # read-only pairing, or names the user never saw (even with the same count): refused before anything is deleted
    assert (await async_client.post(f"{API}/orca-cleanup", json={"names": seen})).status_code == 400
    stub = _stub_orca(monkeypatch, entries, scope="sync:write")
    assert (await async_client.post(f"{API}/orca-cleanup", json={"names": [*seen, "extra"]})).status_code == 400
    r = await async_client.post(f"{API}/orca-cleanup", json={"names": [seen[0], "Some Other Profile"]})
    assert r.status_code == 400 and "Orca Cloud changed" in r.json()["detail"]
    assert not hasattr(stub, "deleted") and not list(tmp_path.iterdir())

    r = await async_client.post(f"{API}/orca-cleanup", json={"names": seen})
    assert r.status_code == 200, r.text
    body = r.json()
    assert stub.deleted == ["old", "stuck"]  # never the leaf, never the process profile
    assert (body["deleted"], body["failed"]) == (1, 1)  # counted from a fresh listing, not from Orca's reply
    assert body["snapshot"].startswith("cleanup-")
    assert len(json.loads((tmp_path / body["snapshot"]).read_text())) == 3  # every filament as it was before


@pytest.mark.parametrize(("error", "status"), [(OrcaCloudError("5xx"), 200), (OrcaCloudAuthError("expired"), 401)])
async def test_orca_cleanup_failed_delete_batch(async_client, db_session, monkeypatch, tmp_path, error, status):
    monkeypatch.setattr(push_service, "_snapshot_dir", lambda: tmp_path)
    await _tree(db_session)
    entries = [{"id": "old", "name": "Polymaker PETG - Red", "content": {"type": "filament"}}]
    stub = _stub_orca(monkeypatch, entries, scope="sync:write")

    async def fail(_ids):
        raise error

    stub.delete_profiles = fail
    r = await async_client.post(f"{API}/orca-cleanup", json={"names": ["Polymaker PETG - Red"]})
    assert r.status_code == status, r.text
    if status == 200:  # the run continues to the final listing: counts and snapshot name still come back
        body = r.json()
        assert (body["deleted"], body["failed"]) == (0, 1)
        assert (tmp_path / body["snapshot"]).exists()


@pytest.mark.parametrize(("error", "status"), [(OrcaCloudError("network"), 200), (OrcaCloudAuthError("expired"), 401)])
async def test_orca_cleanup_failed_final_listing(async_client, db_session, monkeypatch, tmp_path, error, status):
    monkeypatch.setattr(push_service, "_snapshot_dir", lambda: tmp_path)
    await _tree(db_session)
    entries = [{"id": "old", "name": "Polymaker PETG - Red", "content": {"type": "filament"}}]
    stub = _stub_orca(monkeypatch, entries, scope="sync:write")
    list_ok = stub.list_profiles
    calls = []

    async def list_profiles():
        calls.append(1)
        if len(calls) > 1:  # the check after the delete
            raise error
        return await list_ok()

    stub.list_profiles = list_profiles
    r = await async_client.post(f"{API}/orca-cleanup", json={"names": ["Polymaker PETG - Red"]})
    assert r.status_code == status, r.text
    assert stub.deleted == ["old"]
    if status == 200:  # deleted: the count is unknown, the snapshot name still comes back
        body = r.json()
        assert body["deleted"] is None and body["failed"] is None
        assert (tmp_path / body["snapshot"]).exists()


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


async def test_export_requires_update_permission(async_client, db_session):
    tree, _, _ = await _tree(db_session)
    admin = await _setup_admin(async_client, username="ftadmin_export")
    token = await _create_user_with_perms(async_client, admin, username="ft_read_only", permissions=["filaments:read"])
    r = await async_client.post(
        f"{API}/export", json={"tree_id": tree.id}, headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 403
    token = await _create_user_with_perms(
        async_client, admin, username="ft_updater", permissions=["filaments:read", "filaments:update"]
    )
    r = await async_client.post(
        f"{API}/export", json={"tree_id": tree.id}, headers={"Authorization": f"Bearer {token}"}
    )
    assert r.status_code == 200


@pytest.mark.parametrize(
    "bad",
    [
        "not-a-dict",
        ["x"],
        {"id": "m1", "name": "A", "content": "text"},
        {"id": "m2", "name": "A", "content": ["list"]},
        {"id": "m3", "name": None, "content": {"type": "filament"}},
        {"id": "m4", "name": 7, "content": {"type": "filament"}},
    ],
)
async def test_sync_ignores_malformed_orca_entries(async_client, db_session, monkeypatch, bad):
    await _tree(db_session)
    _stub_orca(monkeypatch, [bad])
    r = await async_client.post(f"{API}/sync")
    assert r.status_code == 200, r.text
    assert r.json()["ignored"] == 1


async def test_export_returns_zip(async_client, db_session):
    tree, _, _ = await _tree(db_session)
    r = await async_client.post(f"{API}/export", json={"tree_id": tree.id})
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    assert r.headers["content-disposition"] == 'attachment; filename="fenrir-filaments.zip"'
    assert len(zipfile.ZipFile(io.BytesIO(r.content)).namelist()) == 32
    assert (await async_client.post(f"{API}/export", json={})).status_code == 200
    assert (await async_client.post(f"{API}/export", json={"tree_id": 9999})).status_code == 404
    assert (await async_client.post(f"{API}/export/confirm", json={"token": "nope"})).status_code == 404


async def test_export_confirm_requires_update_permission(async_client, db_session):
    tree, _, _ = await _tree(db_session)
    admin = await _setup_admin(async_client, username="ftadmin_confirm")
    r = await async_client.post(
        f"{API}/export", json={"tree_id": tree.id}, headers={"Authorization": f"Bearer {admin}"}
    )
    body = {"token": r.headers["x-export-token"]}
    ro = await _create_user_with_perms(async_client, admin, username="ft_ro_c", permissions=["filaments:read"])
    r = await async_client.post(f"{API}/export/confirm", json=body, headers={"Authorization": f"Bearer {ro}"})
    assert r.status_code == 403
    rw = await _create_user_with_perms(
        async_client, admin, username="ft_rw_c", permissions=["filaments:read", "filaments:update"]
    )
    r = await async_client.post(f"{API}/export/confirm", json=body, headers={"Authorization": f"Bearer {rw}"})
    assert r.status_code == 200 and r.json() == {"confirmed": 32}


async def test_concurrent_migrate_of_one_group_loses_with_400(async_client, db_session, monkeypatch):
    from backend.app.services import filament_tree_migration as migration

    row = FilamentPreset(
        name="Polymaker PETG - White",
        brand="Polymaker",
        material="PETG",
        color="White",
        content=json.dumps(
            {"name": "Polymaker PETG - White", "inherits": "Bambu PETG Basic @BBL H2S", "nozzle_temperature": ["245"]}
        ),
    )
    db_session.add(row)
    db_session.add(BaseFilamentPreset(name="Bambu PETG Basic @BBL H2S", filename="b.json"))
    await db_session.commit()
    body = {"groups": [{"prefix": "Polymaker PETG", "source_preset_id": row.id, "machine": "H2S", "nozzle": "0.4"}]}

    # both requests read the group as unmanaged; the second only carries on once the first has finished
    arrived = 0
    both_in = asyncio.Event()
    first_done = asyncio.Event()
    real = migration.managed_preset_ids

    async def gate(db):
        nonlocal arrived
        managed = await real(db)
        arrived += 1
        mine = arrived
        if mine == 2:
            both_in.set()
        await both_in.wait()
        if mine == 2:
            await first_done.wait()
        return managed

    async def post():
        r = await async_client.post(f"{API}/migrate", json=body)
        first_done.set()
        return r

    monkeypatch.setattr(migration, "managed_preset_ids", gate)
    first, second = await asyncio.gather(post(), post())
    assert sorted([first.status_code, second.status_code]) == [200, 400], (first.text, second.text)
    loser = first if first.status_code == 400 else second
    assert loser.json()["detail"] == "group already migrated"


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
    assert r.status_code == 400 and "run Sync base first" in r.json()["detail"]
    db_session.add(BaseFilamentPreset(name="Bambu PETG Basic @BBL H2S", filename="b.json"))
    await db_session.commit()
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

    old_name = tree.name
    r = await async_client.patch(f"{API}/{tree.id}", json={"brand": "Inslogic", "material": "PLA"})
    assert r.status_code == 200, r.text
    await db_session.refresh(tree)
    assert (tree.name, tree.brand, tree.material) == ("Inslogic PLA", "Inslogic", "PLA")
    names = (await db_session.execute(select(FilamentPreset.name))).scalars().all()
    assert names and all(n.startswith("Inslogic PLA - ") for n in names)
    r = await async_client.patch(
        f"{API}/{tree.id}", json={"brand": old_name.split()[0], "material": old_name.split()[1]}
    )
    assert r.status_code == 200, r.text

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


@pytest.mark.parametrize(
    ("error", "status", "detail"),
    [
        (OrcaCloudAuthError("token expired"), 401, "token expired"),
        (OrcaCloudError("Profile c1 not found"), 404, "Profile c1 not found"),
        (OrcaCloudError("boom"), 502, "boom"),
    ],
)
async def test_orca_errors_map_to_http_and_close_service(async_client, monkeypatch, error, status, detail):
    stub = _stub_orca(monkeypatch, [])

    async def fail(_profile_id):
        raise error

    stub.get_profile = fail
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
    assert r.status_code == status, r.text
    assert r.json()["detail"] == detail
    assert stub.closed is True


@pytest.mark.parametrize("path", ["", "/targets", "/unmanaged"])
async def test_reads_need_auth(async_client, path):
    await _setup_admin(async_client, username="ftadmin_r")
    assert (await async_client.get(f"{API}{path}")).status_code == 401


@pytest.mark.parametrize(
    "body",
    [
        {"set": {"Nozzle": ["1"]}},  # key pattern
        {"set": {"k" * 101: ["1"]}},  # key length
        {"set": {f"k{i}": ["1"] for i in range(201)}},  # key count
        {"clear": ["a"] * 201},
        {"set": {"a": {"nested": 1}}},
        {"set": {"a": [["1"]]}},
        {"set": {"a": ["1"] * 17}},
        {"set": {"a": None}},
    ],
)
async def test_node_put_ill_shaped_body_422(async_client, db_session, body):
    tree, _, _ = await _tree(db_session)
    assert (await async_client.put(f"{API}/{tree.id}/node", json=body)).status_code == 422


async def test_conflict_value_ill_shaped_422(async_client, db_session):
    tree, _, red = await _tree(db_session)
    body = {"tree_id": tree.id, "machine": "H2S", "nozzle": "0.4", "color_id": red.id, "key": "a", "value": {"x": 1}}
    assert (await async_client.post(f"{API}/conflicts/resolve", json=body)).status_code == 422


async def _first_red_leaf(db, tree_id, red_id):
    return (
        (
            await db.execute(
                select(FilamentTreeLeaf)
                .where(FilamentTreeLeaf.tree_id == tree_id, FilamentTreeLeaf.color_id == red_id)
                .order_by(FilamentTreeLeaf.id)
            )
        )
        .scalars()
        .first()
    )


async def test_conflict_resolve_success_writes_value_and_baseline(async_client, db_session):
    tree, _, red = await _tree(db_session)
    leaf = await _first_red_leaf(db_session, tree.id, red.id)
    body = {
        "tree_id": tree.id,
        "machine": leaf.machine,
        "nozzle": leaf.nozzle,
        "color_id": red.id,
        "key": "fan_min_speed",
        "value": ["40"],
        "orca_value": ["35"],
    }
    r = await async_client.post(f"{API}/conflicts/resolve", json=body)
    assert r.status_code == 200, r.text
    assert r.json() == {"success": True}
    await db_session.refresh(leaf)
    preset = await db_session.get(FilamentPreset, leaf.preset_id)
    await db_session.refresh(preset)
    assert json.loads(preset.content)["fan_min_speed"] == ["40"]
    assert json.loads(leaf.baseline_content)["fan_min_speed"] == ["35"]


async def test_conflict_resolve_unknown_tree_404(async_client, db_session):
    body = {
        "tree_id": 987654,
        "machine": "H2S",
        "nozzle": "0.4",
        "color_id": 1,
        "key": "a",
        "value": ["1"],
        "orca_value": ["1"],
    }
    r = await async_client.post(f"{API}/conflicts/resolve", json=body)
    assert r.status_code == 404
    assert r.json()["detail"] == "filament tree 987654 not found"


async def test_conflict_resolve_unknown_leaf_404(async_client, db_session):
    tree, _, red = await _tree(db_session)
    body = {
        "tree_id": tree.id,
        "machine": "NOPE",
        "nozzle": "0.4",
        "color_id": red.id,
        "key": "a",
        "value": ["1"],
        "orca_value": ["1"],
    }
    r = await async_client.post(f"{API}/conflicts/resolve", json=body)
    assert r.status_code == 404
    assert r.json()["detail"] == f"leaf NOPE 0.4 (colour {red.id}) of tree {tree.id} not found"


async def test_node_put_refuses_orca_metadata_keys(async_client, db_session):
    tree, _, _ = await _tree(db_session)
    r = await async_client.put(f"{API}/{tree.id}/node", json={"set": {"setting_id": "x"}})
    assert r.status_code == 400 and "setting_id" in r.json()["detail"]


async def test_regenerate_refuses_oversize_leaf(async_client, db_session):
    tree, _, _ = await _tree(db_session)
    huge = "x" * (_CONTENT_MAX_LENGTH + 1)
    r = await async_client.put(f"{API}/{tree.id}/node", json={"set": {"filament_notes": huge}})
    assert r.status_code == 400 and "larger than" in r.json()["detail"]
    await db_session.refresh(tree)
    assert "filament_notes" not in json.loads(tree.own_values)  # rolled back
    with pytest.raises(ValueError, match="larger than"):
        await store.set_node_values(db_session, tree.id, None, None, None, {"filament_notes": huge}, [])


async def test_regenerate_refuses_path_shaped_names(db_session):
    tree, _, _ = await _tree(db_session)
    tree.name = "../evil"  # e.g. a migrated preset prefix
    await db_session.commit()
    with pytest.raises(ValueError, match="file name"):
        await store.regenerate_tree(db_session, tree.id)


async def test_unsafe_names_rejected(async_client, db_session):
    tree, _, _ = await _tree(db_session)
    r = await async_client.post(f"{API}/{tree.id}/colors", json={"name": "x/../a", "hex": "#000000"})
    assert r.status_code == 422
    r = await async_client.put(f"{API}/targets", json={"machines": ["../X"], "nozzles": ["0.4"]})
    assert r.status_code == 422
    r = await async_client.put(f"{API}/targets", json={"machines": [f"M{i}" for i in range(13)], "nozzles": ["0.4"]})
    assert r.status_code == 422
    r = await async_client.put(f"{API}/targets", json={"machines": ["H2S"], "nozzles": ["0.4\n"]})
    assert r.status_code == 422


async def test_put_targets_failed_regeneration_keeps_old_targets(async_client, db_session, monkeypatch):
    await _tree(db_session)

    async def boom(_db, _tree_id):
        raise ValueError("regeneration failed")

    monkeypatch.setattr(routes.store, "regenerate_tree", boom)
    r = await async_client.put(f"{API}/targets", json={"machines": ["H2S", "H2D"], "nozzles": ["0.4"]})
    assert r.status_code == 400
    monkeypatch.undo()
    assert (await async_client.get(f"{API}/targets")).json()["machines"] == ["X2D", "H2S", "H2D", "H2C"]


async def test_candidate_refuses_existing_tree_name(async_client, db_session, monkeypatch):
    await _tree(db_session)  # "Polymaker PETG"
    _stub_orca(monkeypatch, [{"id": "c1", "name": "Polymaker PETG - Blue", "content": {"type": "filament"}}])
    body = {
        "orca_id": "c1",
        "name": "Polymaker PETG - Blue",
        "brand": "Polymaker",
        "material": "PETG",
        "color_name": "Blue",
        "color_hex": "#0000FF",
        "machine": "H2S",
        "nozzle": "0.4",
    }
    r = await async_client.post(f"{API}/candidates", json=body)
    assert r.status_code == 400 and "already exists" in r.json()["detail"]
    assert await db_session.scalar(select(func.count()).select_from(FilamentTree)) == 1


async def test_node_put_empty_machine_cannot_reach_source_colour(async_client, db_session):
    tree, white, _ = await _tree(db_session)
    body = {"machine": "", "nozzle": "", "color_id": white.id, "set": {"hot_plate_temp": ["80"]}}
    assert (await async_client.put(f"{API}/{tree.id}/node", json=body)).status_code == 422
    with pytest.raises(ValueError, match="calibration source colour"):
        await store.set_node_values(db_session, tree.id, "", "", white.id, {"hot_plate_temp": ["80"]}, [])


async def test_create_duplicate_and_bulk(async_client, db_session):
    body = {
        "brand": "eSun",
        "material": "PLA",
        "base_family": "Generic PLA",
        "color_name": "Black",
        "color_hex": "#000000",
        "machine": "H2S",
        "nozzle": "0.4",
    }
    r = await async_client.post(API, json=body)
    assert r.status_code == 200, r.text
    first = r.json()["tree_id"]
    assert (await async_client.post(API, json=body)).status_code == 400  # same name
    assert (await async_client.post(API, json={**body, "brand": "X", "machine": "NOPE"})).status_code == 400
    assert await db_session.scalar(select(func.count()).select_from(FilamentTree)) == 1  # the refused one rolled back

    await async_client.put(f"{API}/{first}/node", json={"machine": "H2S", "set": {"hot_plate_temp": ["60"]}})
    r = await async_client.post(f"{API}/{first}/duplicate", json={"name": "Sunlu PLA", "brand": "Sunlu"})
    assert r.status_code == 200, r.text
    second = r.json()["tree_id"]
    rows = (await async_client.get(f"{API}/{second}/node", params={"machine": "H2S"})).json()
    assert {row["key"]: row["value"] for row in rows}["hot_plate_temp"] == ["60"]
    trees = {t["id"]: t for t in (await async_client.get(API)).json()}
    assert (
        trees[second]["brand"] == "Sunlu" and trees[second]["source"]["color_id"] != trees[first]["source"]["color_id"]
    )

    r = await async_client.post(f"{API}/bulk", json={"tree_ids": [first, second], "set": {"fan_min_speed": ["30"]}})
    assert r.status_code == 200, r.text
    for tid in (first, second):
        rows = (await async_client.get(f"{API}/{tid}/node")).json()
        assert {row["key"]: row["value"] for row in rows}["fan_min_speed"] == ["30"]
    # all or nothing: an unknown tree undoes the write on the first
    r = await async_client.post(f"{API}/bulk", json={"tree_ids": [first, 9999], "set": {"fan_min_speed": ["99"]}})
    assert r.status_code == 404
    rows = (await async_client.get(f"{API}/{first}/node")).json()
    assert {row["key"]: row["value"] for row in rows}["fan_min_speed"] == ["30"]


async def test_history_revert_and_export_changed_only(async_client, db_session):
    tree, _, _ = await _tree(db_session)
    r = await async_client.post(f"{API}/export", json={})
    assert (await async_client.get(API)).json()[0]["export_pending"] == 32  # not confirmed yet
    r = await async_client.post(f"{API}/export/confirm", json={"token": r.headers["x-export-token"]})
    assert r.json() == {"confirmed": 32}
    assert (await async_client.get(API)).json()[0]["export_pending"] == 0

    await async_client.put(f"{API}/{tree.id}/node", json={"machine": "H2S", "set": {"hot_plate_temp": ["75"]}})
    await async_client.put(f"{API}/{tree.id}/node", json={"machine": "H2S", "set": {"hot_plate_temp": ["75"]}})  # no-op
    assert (await async_client.get(API)).json()[0]["export_pending"] == 8  # H2S: 4 nozzles x 2 colours
    r = await async_client.post(f"{API}/export", json={"changed_only": True})
    assert len(zipfile.ZipFile(io.BytesIO(r.content)).namelist()) == 8
    assert (await async_client.get(API)).json()[0]["export_pending"] == 8
    await async_client.post(f"{API}/export/confirm", json={"token": r.headers["x-export-token"]})
    assert (await async_client.get(API)).json()[0]["export_pending"] == 0

    history = (await async_client.get(f"{API}/{tree.id}/history")).json()
    assert [(c["machine"], c["key"], c["old_value"], c["new_value"]) for c in history] == [
        ("H2S", "hot_plate_temp", None, ["75"])
    ]
    r = await async_client.post(f"{API}/{tree.id}/history/{history[0]['id']}/revert")
    assert r.status_code == 200, r.text
    rows = (await async_client.get(f"{API}/{tree.id}/node", params={"machine": "H2S"})).json()
    assert {row["key"]: row for row in rows}["hot_plate_temp"]["own"] is False
    assert len((await async_client.get(f"{API}/{tree.id}/history")).json()) == 2
    assert (await async_client.post(f"{API}/{tree.id}/history/9999/revert")).status_code == 404


async def test_put_targets_refuses_duplicates(async_client):
    for body in (
        {"machines": ["H2S", "H2S"], "nozzles": ["0.4"]},
        {"machines": ["H2S", " H2S"], "nozzles": ["0.4"]},
        {"machines": ["H2S"], "nozzles": ["0.4", "0.4"]},
    ):
        r = await async_client.put(f"{API}/targets", json=body)
        assert r.status_code == 400 and "duplicates" in r.json()["detail"]
    ok = await async_client.put(f"{API}/targets", json={"machines": ["H2S", "H2D"], "nozzles": ["0.4", "0.2"]})
    assert ok.status_code == 200


async def test_duplicate_colour_names_refused(async_client, db_session):
    tree, white, red = await _tree(db_session)
    r = await async_client.post(f"{API}/{tree.id}/colors", json={"name": "white", "hex": "#FFFFFF"})
    assert r.status_code == 400 and "already has a colour" in r.json()["detail"]
    r = await async_client.patch(f"{API}/{tree.id}/colors/{red.id}", json={"name": "WHITE"})
    assert r.status_code == 400
    # own name (hex-only change, or same name) and a free name still work
    r = await async_client.patch(f"{API}/{tree.id}/colors/{red.id}", json={"name": "Red", "hex": "#EE0000"})
    assert r.status_code == 200, r.text
    r = await async_client.patch(f"{API}/{tree.id}/colors/{red.id}", json={"name": "Crimson"})
    assert r.status_code == 200, r.text
    r = await async_client.post(f"{API}/{tree.id}/colors", json={"name": "Blue", "hex": "#0000FF"})
    assert r.status_code == 200, r.text


async def test_missing_preset_is_a_domain_lookup_error(db_session, monkeypatch):
    tree, _, _ = await _tree(db_session)
    real_get = db_session.get

    async def get(model, *args, **kwargs):
        return None if model is FilamentPreset else await real_get(model, *args, **kwargs)

    monkeypatch.setattr(db_session, "get", get)
    with pytest.raises(LookupError, match="preset .* is missing"):
        await store.regenerate_tree(db_session, tree.id)


async def test_put_targets_validates_before_source_check(async_client, db_session):
    await _tree(db_session)
    r = await async_client.put(f"{API}/targets", json={"machines": [" H2S "], "nozzles": ["0.4"]})
    assert r.status_code == 200 and r.json()["machines"] == ["H2S"]
    r = await async_client.put(f"{API}/targets", json={"machines": ["H2S"], "nozzles": []})
    assert r.status_code == 400 and "non-empty list" in r.json()["detail"]
    r = await async_client.put(f"{API}/targets", json={"machines": ["H2S"], "nozzles": ["x"]})
    assert r.status_code == 400 and "look like 0.4" in r.json()["detail"]
    r = await async_client.put(f"{API}/targets", json={"machines": ["H2D"], "nozzles": ["0.4"]})
    assert r.status_code == 400 and "must stay a target" in r.json()["detail"]


async def test_tree_patch_refuses_explicit_null_source(async_client, db_session):
    tree, _, red = await _tree(db_session)
    for key in ("source_machine", "source_nozzle", "source_color_id"):
        r = await async_client.patch(f"{API}/{tree.id}", json={key: None})
        assert r.status_code == 400 and key in r.json()["detail"]
    r = await async_client.patch(f"{API}/{tree.id}", json={"skip_02": None})
    assert r.status_code == 200, r.text
    r = await async_client.patch(f"{API}/{tree.id}", json={"source_color_id": red.id})
    assert r.status_code == 200, r.text


async def test_colour_removal_waits_for_node_save_in_flight(async_client, db_session, monkeypatch):
    """put_node holds the tree lock across its check and write; remove_color must queue behind it (no orphan row)."""
    from backend.app.models.filament_tree import FilamentTreeOverride

    tree, _white, red = await _tree(db_session)
    tree_id, red_id = tree.id, red.id
    entered, release = asyncio.Event(), asyncio.Event()
    real = store.set_node_values

    async def slow(*args, **kwargs):
        entered.set()
        await release.wait()
        return await real(*args, **kwargs)

    monkeypatch.setattr(store, "set_node_values", slow)
    save = asyncio.create_task(
        async_client.put(f"{API}/{tree_id}/node", json={"color_id": red_id, "set": {"nozzle_temperature": ["250"]}})
    )
    await entered.wait()
    remove = asyncio.create_task(async_client.delete(f"{API}/{tree_id}/colors/{red_id}"))
    await asyncio.sleep(0.05)
    assert not remove.done()
    release.set()
    assert (await save).status_code == 200
    assert (await remove).status_code == 200
    db_session.expire_all()
    orphans = (
        await db_session.execute(
            select(func.count()).select_from(FilamentTreeOverride).where(FilamentTreeOverride.color_id == red_id)
        )
    ).scalar_one()
    assert orphans == 0
    assert (
        await async_client.post(f"{API}/{tree_id}/duplicate", json={"name": "Copy", "brand": "Polymaker"})
    ).status_code == 200
    assert store._tree_locks.get(asyncio.get_running_loop(), {}) == {}


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("patch", "", {"skip_02": True}),
        ("post", "/colors", {"name": "Blue", "hex": "#0000FF"}),
        ("patch", "/colors/{red}", {"name": "Crimson"}),
        ("post", "/duplicate", {"name": "Copy", "brand": "Polymaker"}),
        ("delete", "", None),
    ],
)
async def test_tree_writers_queue_behind_the_tree_lock(async_client, db_session, method, path, body):
    tree, _white, red = await _tree(db_session)
    kw = {} if body is None else {"json": body}
    async with store.tree_write_lock([tree.id]):
        task = asyncio.create_task(getattr(async_client, method)(f"{API}/{tree.id}{path.format(red=red.id)}", **kw))
        await asyncio.sleep(0.05)
        assert not task.done()
    assert (await task).status_code == 200


async def test_put_targets_queues_behind_the_tree_lock(async_client, db_session):
    tree, _white, _red = await _tree(db_session)
    targets = (await async_client.get(f"{API}/targets")).json()
    async with store.tree_write_lock([tree.id]):
        task = asyncio.create_task(async_client.put(f"{API}/targets", json=targets))
        await asyncio.sleep(0.05)
        assert not task.done()
    assert (await task).status_code == 200


async def _leaf_count(db):
    db.expire_all()
    return (await db.execute(select(func.count()).select_from(FilamentTreeLeaf))).scalar_one()


async def _perm_headers(async_client, username, permissions, admin=None):
    admin = admin or await _setup_admin(async_client, username=f"{username}_admin")
    token = await _create_user_with_perms(async_client, admin, username=username, permissions=permissions)
    return {"Authorization": f"Bearer {token}"}


async def test_targets_removing_a_leaf_needs_delete_permission(async_client, db_session):
    tree, _, _ = await _tree(db_session)
    tree_id = tree.id
    before = await _leaf_count(db_session)
    targets = (await async_client.get(f"{API}/targets")).json()
    narrower = {**targets, "nozzles": [n for n in targets["nozzles"] if n != "0.2"]}
    wider = {**targets, "nozzles": [*targets["nozzles"], "1.0"]}
    assert len(narrower["nozzles"]) < len(targets["nozzles"])

    admin = await _setup_admin(async_client, username="ft_tg_admin")
    update_only = await _perm_headers(async_client, "ft_tg_update", ["filaments:update", "filaments:read"], admin)
    r = await async_client.put(f"{API}/targets", json=narrower, headers=update_only)
    assert r.status_code == 403 and "filaments:delete" in r.json()["detail"]
    assert await _leaf_count(db_session) == before
    assert (await async_client.get(f"{API}/targets", headers=update_only)).json() == targets

    r = await async_client.put(f"{API}/targets", json=wider, headers=update_only)
    assert r.status_code == 200, r.text
    assert await _leaf_count(db_session) > before

    full = await _perm_headers(
        async_client, "ft_tg_full", ["filaments:update", "filaments:delete", "filaments:read"], admin
    )
    r = await async_client.put(f"{API}/targets", json=narrower, headers=full)
    assert r.status_code == 200, r.text
    assert await _leaf_count(db_session) < before
    assert tree_id


async def test_skip_02_removing_a_leaf_needs_delete_permission(async_client, db_session):
    tree, _, _ = await _tree(db_session)
    tree_id = tree.id
    before = await _leaf_count(db_session)
    admin = await _setup_admin(async_client, username="ft_skip_admin")
    update_only = await _perm_headers(async_client, "ft_skip_update", ["filaments:update", "filaments:read"], admin)
    r = await async_client.patch(f"{API}/{tree_id}", json={"skip_02": True}, headers=update_only)
    assert r.status_code == 403 and "filaments:delete" in r.json()["detail"]
    assert await _leaf_count(db_session) == before

    # nothing to remove (already off the current value): update alone is enough
    r = await async_client.patch(f"{API}/{tree_id}", json={"skip_02": False}, headers=update_only)
    assert r.status_code == 200, r.text

    full = await _perm_headers(
        async_client, "ft_skip_full", ["filaments:update", "filaments:delete", "filaments:read"], admin
    )
    r = await async_client.patch(f"{API}/{tree_id}", json={"skip_02": True}, headers=full)
    assert r.status_code == 200, r.text
    after_skip = await _leaf_count(db_session)
    assert after_skip < before

    # turning it back on only adds leaves
    r = await async_client.patch(f"{API}/{tree_id}", json={"skip_02": False}, headers=update_only)
    assert r.status_code == 200, r.text
    assert await _leaf_count(db_session) == before


async def test_rename_that_flips_auto_skip_02_needs_delete_permission(async_client, db_session):
    tree, _, _ = await _tree(db_session)
    tree_id = tree.id
    before = await _leaf_count(db_session)
    admin = await _setup_admin(async_client, username="ft_ren_admin")
    update_only = await _perm_headers(async_client, "ft_ren_update", ["filaments:update", "filaments:read"], admin)
    r = await async_client.patch(f"{API}/{tree_id}", json={"material": "PETG-CF"}, headers=update_only)
    assert r.status_code == 403 and "filaments:delete" in r.json()["detail"]
    assert await _leaf_count(db_session) == before
    await db_session.refresh(tree)
    assert (tree.material, tree.name) == ("PETG", "Polymaker PETG")

    # a rename that changes no leaf set needs only update
    r = await async_client.patch(f"{API}/{tree_id}", json={"material": "PLA"}, headers=update_only)
    assert r.status_code == 200, r.text
    assert await _leaf_count(db_session) == before

    # skip_02 pinned off: the CF name drops nothing
    r = await async_client.patch(f"{API}/{tree_id}", json={"skip_02": False}, headers=update_only)
    assert r.status_code == 200, r.text
    r = await async_client.patch(f"{API}/{tree_id}", json={"material": "PLA-CF"}, headers=update_only)
    assert r.status_code == 200, r.text
    assert await _leaf_count(db_session) == before

    r = await async_client.patch(f"{API}/{tree_id}", json={"skip_02": None}, headers=update_only)
    assert r.status_code == 403
    full = await _perm_headers(
        async_client, "ft_ren_full", ["filaments:update", "filaments:delete", "filaments:read"], admin
    )
    r = await async_client.patch(f"{API}/{tree_id}", json={"skip_02": None}, headers=full)
    assert r.status_code == 200, r.text
    assert await _leaf_count(db_session) < before


async def test_rename_dropping_the_source_leaf_is_400(async_client, db_session):
    tree, _, _ = await _tree(db_session)
    tree_id = tree.id
    r = await async_client.patch(f"{API}/{tree_id}", json={"source_nozzle": "0.2"})
    assert r.status_code == 200, r.text
    before = await _leaf_count(db_session)
    r = await async_client.patch(f"{API}/{tree_id}", json={"material": "PETG-GF"})
    assert r.status_code == 400 and "not a leaf" in r.json()["detail"]
    await db_session.refresh(tree)
    assert tree.material == "PETG"
    assert await _leaf_count(db_session) == before


async def _queued_behind_lock(tree_id, users=2):
    """Wait until a second caller has joined the tree's lock (users counts the holder plus its waiters)."""

    async def joined():
        while store._tree_locks.get(asyncio.get_running_loop(), {}).get(tree_id, [None, 0])[1] < users:
            await asyncio.sleep(0)

    await asyncio.wait_for(joined(), timeout=10)


async def _request_waits_for_lock(tree_id, send):
    """Hold the tree lock, start the request, prove it queued without finishing, then release and return its response."""
    async with store.tree_write_lock([tree_id]):
        task = asyncio.create_task(send())
        await _queued_behind_lock(tree_id)
        assert not task.done()
    return await asyncio.wait_for(task, timeout=10)


async def _own_values(async_client, tree_id, **params):
    rows = (await async_client.get(f"{API}/{tree_id}/node", params=params)).json()
    return {row["key"]: row["value"] for row in rows if row["own"]}


async def test_bulk_waits_for_the_tree_lock_then_writes(async_client, db_session):
    tree, _, _ = await _tree(db_session)
    r = await _request_waits_for_lock(
        tree.id,
        lambda: async_client.post(f"{API}/bulk", json={"tree_ids": [tree.id], "set": {"fan_min_speed": ["30"]}}),
    )
    assert r.status_code == 200, r.text
    assert (await _own_values(async_client, tree.id))["fan_min_speed"] == ["30"]


async def test_sync_waits_for_the_tree_lock_then_applies(async_client, db_session, monkeypatch):
    tree, _, red = await _tree(db_session)
    r = await async_client.post(f"{API}/export", json={"tree_id": tree.id})
    await async_client.post(f"{API}/export/confirm", json={"token": r.headers["x-export-token"]})
    preset = (
        await db_session.execute(select(FilamentPreset).where(FilamentPreset.name == "Polymaker PETG - Red @H2S 0.4"))
    ).scalar_one()
    imported = json.loads(preset.content) | {"type": "filament"}
    entries = [{"id": "a", "name": preset.name, "content": imported}]
    _stub_orca(monkeypatch, entries)
    assert (await async_client.post(f"{API}/sync")).status_code == 200  # records the baseline
    entries[0]["content"] = imported | {"nozzle_temperature": ["255"]}

    r = await _request_waits_for_lock(tree.id, lambda: async_client.post(f"{API}/sync"))
    assert r.status_code == 200, r.text
    [applied] = r.json()["applied"]
    assert applied["values"] == {"nozzle_temperature": ["255"]}
    own = await _own_values(async_client, tree.id, machine="H2S", nozzle="0.4", color_id=red.id)
    assert own["nozzle_temperature"] == ["255"]


async def test_sync_waits_for_a_running_orca_run_then_lists_orca(async_client, db_session, monkeypatch, tmp_path):
    monkeypatch.setattr(push_service, "_snapshot_dir", lambda: tmp_path)
    await _tree(db_session)
    entries: list[dict] = []
    stub = _stub_orca(monkeypatch, entries, scope="sync:write")
    # a running SYNC or cleanup holds the Orca-run lock (id -1): the second run lists Orca only after it ends
    async with routes._orca_run_lock():
        task = asyncio.create_task(async_client.post(f"{API}/sync"))
        await _queued_behind_lock(-1)
        assert not task.done() and not stub.pushed
        entries.append({"id": "late", "name": "eSUN PLA+ - Blue", "content": {"type": "filament"}})
    r = await asyncio.wait_for(task, timeout=10)
    assert r.status_code == 200, r.text
    assert [c["orca_id"] for c in r.json()["candidates"]] == ["late"]  # it saw Orca as the first run left it


async def test_orca_cleanup_waits_for_a_running_orca_run(async_client, db_session, monkeypatch, tmp_path):
    monkeypatch.setattr(push_service, "_snapshot_dir", lambda: tmp_path)
    await _tree(db_session)
    entries = [{"id": "old", "name": "Polymaker PETG - Red", "content": {"type": "filament"}}]
    stub = _stub_orca(monkeypatch, entries, scope="sync:write")
    r = await _request_waits_for_lock(
        -1, lambda: async_client.post(f"{API}/orca-cleanup", json={"names": ["Polymaker PETG - Red"]})
    )
    assert r.status_code == 200, r.text
    assert stub.deleted == ["old"]


async def test_conflict_resolve_waits_for_the_tree_lock_then_writes(async_client, db_session):
    tree, _, red = await _tree(db_session)
    tree_id, red_id = tree.id, red.id
    leaf = await _first_red_leaf(db_session, tree_id, red_id)
    body = {
        "tree_id": tree_id,
        "machine": leaf.machine,
        "nozzle": leaf.nozzle,
        "color_id": red_id,
        "key": "fan_min_speed",
        "value": ["40"],
        "orca_value": ["35"],
    }
    r = await _request_waits_for_lock(tree_id, lambda: async_client.post(f"{API}/conflicts/resolve", json=body))
    assert r.json() == {"success": True}
    db_session.expire_all()
    leaf = await _first_red_leaf(db_session, tree_id, red_id)
    preset = await db_session.get(FilamentPreset, leaf.preset_id)
    assert json.loads(preset.content)["fan_min_speed"] == ["40"]
    assert json.loads(leaf.baseline_content)["fan_min_speed"] == ["35"]


async def test_revert_waits_for_the_tree_lock_then_restores(async_client, db_session):
    tree, _, _ = await _tree(db_session)
    node = {"machine": "H2S"}
    await async_client.put(f"{API}/{tree.id}/node", json={**node, "set": {"hot_plate_temp": ["75"]}})
    [change] = (await async_client.get(f"{API}/{tree.id}/history")).json()
    r = await _request_waits_for_lock(
        tree.id, lambda: async_client.post(f"{API}/{tree.id}/history/{change['id']}/revert")
    )
    assert r.status_code == 200, r.text
    assert "hot_plate_temp" not in await _own_values(async_client, tree.id, **node)
    assert len((await async_client.get(f"{API}/{tree.id}/history")).json()) == 2


async def test_export_confirm_waits_for_the_tree_lock_then_clears_pending(async_client, db_session):
    tree, _, _ = await _tree(db_session)
    r = await async_client.post(f"{API}/export", json={"tree_id": tree.id})
    body = {"token": r.headers["x-export-token"]}
    r = await _request_waits_for_lock(tree.id, lambda: async_client.post(f"{API}/export/confirm", json=body))
    assert r.status_code == 200 and r.json() == {"confirmed": 32}
    assert (await async_client.get(API)).json()[0]["export_pending"] == 0


async def test_overlapping_bulk_and_node_put_keep_both_edits(async_client, db_session):
    tree, _, _ = await _tree(db_session)
    rs = await asyncio.gather(
        async_client.post(f"{API}/bulk", json={"tree_ids": [tree.id], "set": {"fan_min_speed": ["30"]}}),
        async_client.put(f"{API}/{tree.id}/node", json={"set": {"cool_plate_temp": ["55"]}}),
    )
    assert [r.status_code for r in rs] == [200, 200]
    own = await _own_values(async_client, tree.id)
    assert own["fan_min_speed"] == ["30"] and own["cool_plate_temp"] == ["55"]


async def test_overlapping_revert_and_node_put_both_take_effect(async_client, db_session):
    tree, _, _ = await _tree(db_session)
    node = {"machine": "H2S"}
    await async_client.put(f"{API}/{tree.id}/node", json={**node, "set": {"hot_plate_temp": ["75"]}})
    [change] = (await async_client.get(f"{API}/{tree.id}/history")).json()
    rs = await asyncio.gather(
        async_client.post(f"{API}/{tree.id}/history/{change['id']}/revert"),
        async_client.put(f"{API}/{tree.id}/node", json={**node, "set": {"cool_plate_temp": ["55"]}}),
    )
    assert [r.status_code for r in rs] == [200, 200]
    own = await _own_values(async_client, tree.id, **node)
    assert "hot_plate_temp" not in own and own["cool_plate_temp"] == ["55"]


async def test_sync_stops_before_the_next_leaf_when_asked(async_client, db_session, monkeypatch, tmp_path):
    monkeypatch.setattr(push_service, "_snapshot_dir", lambda: tmp_path)
    await _tree(db_session)
    stub = _stub_orca(
        monkeypatch, [{"id": "stray", "name": "Ghost", "content": {"type": "filament"}}], scope="sync:write"
    )
    sent = stub.push_profile

    async def push_then_stop(**kw):  # the operator presses Stop while the first leaf is on its way
        await sent(**kw)
        assert (await async_client.post(f"{API}/sync/stop")).json()["stop"] is True

    stub.push_profile = push_then_stop
    push = (await async_client.post(f"{API}/sync")).json()["push"]
    assert push["stopped"] and push["pushed"] == 1 and push["remaining"] > 0 and push["failed"] == []
    assert not hasattr(stub, "deleted")  # stopped means stopped: no cleanup either
    # the stop does not carry over to the next run
    stub = _stub_orca(monkeypatch, [], scope="sync:write")
    assert (await async_client.post(f"{API}/sync")).json()["push"]["stopped"] is False


async def test_sync_preview_lists_conflicts_to_settle_before_the_run(async_client, db_session, monkeypatch):
    tree, _, _ = await _tree(db_session)
    r = await async_client.post(f"{API}/export", json={"tree_id": tree.id})
    await async_client.post(f"{API}/export/confirm", json={"token": r.headers["x-export-token"]})
    preset = (
        await db_session.execute(select(FilamentPreset).where(FilamentPreset.name == "Polymaker PETG - Red @H2S 0.4"))
    ).scalar_one()
    content = json.loads(preset.content)
    # never synced and Orca holds another value: nobody knows who changed it
    _stub_orca(
        monkeypatch,
        [{"id": "a", "name": preset.name, "content": content | {"type": "filament", "nozzle_temperature": ["255"]}}],
    )
    [conflict] = (await async_client.get(f"{API}/sync")).json()["conflicts"]
    assert conflict["name"] == preset.name and conflict["key"] == "nozzle_temperature"
    assert conflict["fenrir_value"] == content["nozzle_temperature"] and conflict["orca_value"] == ["255"]


async def test_sync_removes_orca_filaments_that_are_no_leaf(async_client, db_session, monkeypatch, tmp_path):
    monkeypatch.setattr(push_service, "_snapshot_dir", lambda: tmp_path)
    await _tree(db_session)
    entries = [
        {"id": "stray", "name": "Ghost PLA - Red @H2D 0.4", "content": {"type": "filament"}},
        # made in OrcaSlicer: offered for adoption, never deleted
        {"id": "new", "name": "My new filament", "content": {"type": "filament", "from": "User"}},
        {"id": "printer", "name": "My H2D", "content": {"type": "machine"}},
    ]
    stub = _stub_orca(monkeypatch, entries, scope="sync:write")
    assert (await async_client.get(f"{API}/sync")).json()["remove"] == ["Ghost PLA - Red @H2D 0.4"]
    assert not hasattr(stub, "deleted")  # the preview deletes nothing
    # the operator unticked the deletion: the stray stays
    assert (await async_client.post(f"{API}/sync", params={"remove": "false"})).json()["push"]["removed"][
        "deleted"
    ] == 0
    assert not hasattr(stub, "deleted")

    r = await async_client.post(f"{API}/sync")
    assert r.status_code == 200, r.text
    removed = r.json()["push"]["removed"]
    assert stub.deleted == ["stray"] and removed["deleted"] == 1 and removed["failed"] == 0
    assert (tmp_path / removed["snapshot"]).exists()
    assert [c["name"] for c in r.json()["candidates"]] == ["My new filament"]

    # a read-only pairing deletes nothing
    entries.append({"id": "stray2", "name": "Ghost PLA - Red @H2D 0.6", "content": {"type": "filament"}})
    stub = _stub_orca(monkeypatch, entries)
    assert (await async_client.post(f"{API}/sync")).json()["push"]["removed"]["deleted"] == 0
    assert not hasattr(stub, "deleted")
