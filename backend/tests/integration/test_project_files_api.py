"""Project files API (spec §8)."""

import io
import zipfile

import pytest
from httpx import AsyncClient

from backend.app.services import project_storage


@pytest.fixture(autouse=True)
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(project_storage, "projects_root", lambda: tmp_path)
    return tmp_path


async def _project(client):
    return (await client.post("/api/v1/projects/", json={"name": "Support caméra"})).json()


async def _item(client, project_id, section="modelisation", name="Support"):
    response = await client.post(f"/api/v1/projects/{project_id}/items", json={"section": section, "name": name})
    assert response.status_code == 201, response.text
    return response.json()


async def _upload(client, item_id, *files, **form):
    return await client.post(
        f"/api/v1/projects/items/{item_id}/revisions",
        files=[("files", (name, data, "application/octet-stream")) for name, data in files],
        data={k: str(v) for k, v in form.items()},
    )


@pytest.mark.asyncio
@pytest.mark.integration
async def test_full_flow_tree_status_download(async_client: AsyncClient, root):
    project = await _project(async_client)
    item = await _item(async_client, project["id"])
    response = await _upload(async_client, item["id"], ("a.step", b"geo"), ("b.step", b"geo2"), note="v1")
    assert response.status_code == 201, response.text
    rev = response.json()["revision"]
    assert rev["number"] == 1 and len(rev["files"]) == 2
    patched = await async_client.patch(f"/api/v1/projects/revisions/{rev['id']}", json={"status": "valide"})
    assert patched.json()["status"] == "valide"
    tree = (await async_client.get(f"/api/v1/projects/{project['id']}/tree")).json()
    assert tree["code"] == project["code"]
    assert tree["sections"][1]["items"][0]["revisions"][0]["status"] == "valide"
    one = await async_client.get(
        f"/api/v1/projects/revisions/{rev['id']}/download", params={"file_id": rev["files"][0]["id"]}
    )
    assert one.status_code == 200 and one.content == b"geo"
    zipped = await async_client.get(f"/api/v1/projects/revisions/{rev['id']}/download")
    assert sorted(zipfile.ZipFile(io.BytesIO(zipped.content)).namelist()) == ["a.step", "b.step"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_errors_map_to_http(async_client: AsyncClient):
    project = await _project(async_client)
    item = await _item(async_client, project["id"])
    assert (
        await async_client.post(
            f"/api/v1/projects/{project['id']}/items", json={"section": "modelisation", "name": "support"}
        )
    ).status_code == 409
    assert (
        await async_client.post(f"/api/v1/projects/{project['id']}/items", json={"section": "garage", "name": "x"})
    ).status_code == 422
    assert (await async_client.get("/api/v1/projects/999999/tree")).status_code == 404
    assert (await async_client.patch("/api/v1/projects/revisions/999999", json={"note": "x"})).status_code == 404
    assert (await _upload(async_client, item["id"])).status_code in (400, 422)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_rename_fork_delete_and_files(async_client: AsyncClient, root):
    project = await _project(async_client)
    item = await _item(async_client, project["id"])
    rev = (await _upload(async_client, item["id"], ("a.step", b"x"))).json()["revision"]
    renamed = await async_client.patch(f"/api/v1/projects/items/{item['id']}", json={"name": "Support v2"})
    assert renamed.json()["name"] == "Support v2"
    added = await async_client.post(
        f"/api/v1/projects/revisions/{rev['id']}/files", files=[("files", ("b.step", b"x", "application/octet-stream"))]
    )
    # same bytes as a.step but in the SAME revision: warnings only compare other revisions
    assert added.status_code == 200 and added.json()["warnings"] == []
    tree = (await async_client.get(f"/api/v1/projects/{project['id']}/tree")).json()
    files = tree["sections"][1]["items"][0]["revisions"][0]["files"]
    removed = await async_client.delete(f"/api/v1/projects/revisions/{rev['id']}/files/{files[0]['id']}")
    assert removed.status_code == 204
    forked = await async_client.post(
        f"/api/v1/projects/items/{item['id']}/fork", json={"revision_id": rev["id"], "name": "Variante B"}
    )
    assert forked.status_code == 201 and forked.json()["forked_from"]["number"] == 1
    assert (await async_client.delete(f"/api/v1/projects/revisions/{rev['id']}")).status_code == 204
    assert (await async_client.delete(f"/api/v1/projects/items/{item['id']}")).status_code == 204


@pytest.mark.asyncio
@pytest.mark.integration
async def test_tree_isolated_per_project(async_client: AsyncClient):
    a = await _project(async_client)
    b = (await async_client.post("/api/v1/projects/", json={"name": "Autre"})).json()
    item = await _item(async_client, a["id"])
    await _upload(async_client, item["id"], ("a.step", b"x"))
    tree_b = (await async_client.get(f"/api/v1/projects/{b['id']}/tree")).json()
    assert all(section["items"] == [] for section in tree_b["sections"])
