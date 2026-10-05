"""Projects hold printing files only, always in Impression (user decision 2026-10-05).

Scan / Modélisation / Usinage / Docs are disabled, not deleted: items already in
them keep working (rename, delete), but nothing new goes in."""

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.library import LibraryFile
from backend.app.models.project_item import ProjectItem
from backend.app.services import project_storage


@pytest.fixture(autouse=True)
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(project_storage, "projects_root", lambda: tmp_path)
    return tmp_path


async def _project(client):
    return (await client.post("/api/v1/projects/", json={"name": "Support caméra"})).json()


async def _upload(client, item_id, *names):
    return await client.post(
        f"/api/v1/projects/items/{item_id}/revisions",
        files=[("files", (name, b"x", "application/octet-stream")) for name in names],
    )


async def _impression_item(client, project_id, name="Pièce"):
    response = await client.post(f"/api/v1/projects/{project_id}/items", json={"section": "impression", "name": name})
    assert response.status_code == 201, response.text
    return response.json()


def _files_on_disk(root):
    return [p for p in root.rglob("*") if p.is_file()]


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize("section", ["scan", "modelisation", "usinage", "docs"])
async def test_create_item_in_a_disabled_section_is_400(async_client: AsyncClient, section):
    project = await _project(async_client)
    response = await async_client.post(
        f"/api/v1/projects/{project['id']}/items", json={"section": section, "name": "Mesh"}
    )
    assert response.status_code == 400
    assert section in response.json()["detail"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_upload_with_a_non_printable_file_is_400_and_writes_nothing(async_client: AsyncClient, db_session, root):
    project = await _project(async_client)
    item = await _impression_item(async_client, project["id"])
    before = _files_on_disk(root)
    response = await _upload(async_client, item["id"], "ok.3mf", "mesh.stl", "plan.pdf")
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert "mesh.stl" in detail and "plan.pdf" in detail and "ok.3mf" not in detail
    assert _files_on_disk(root) == before
    assert (
        await db_session.execute(select(LibraryFile).where(LibraryFile.project_id == project["id"]))
    ).first() is None
    tree = (await async_client.get(f"/api/v1/projects/{project['id']}/tree")).json()
    impression = next(s for s in tree["sections"] if s["section"] == "impression")
    assert impression["items"][0]["revisions"] == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_upload_printable_files_is_ok(async_client: AsyncClient):
    project = await _project(async_client)
    item = await _impression_item(async_client, project["id"])
    response = await _upload(async_client, item["id"], "plate.gcode.3mf", "plate.gcode", "plate.bgcode", "p.3mf")
    assert response.status_code == 201, response.text
    assert len(response.json()["revision"]["files"]) == 4


@pytest.mark.asyncio
@pytest.mark.integration
async def test_adding_a_non_printable_file_to_a_revision_is_400(async_client: AsyncClient):
    project = await _project(async_client)
    item = await _impression_item(async_client, project["id"])
    rev = (await _upload(async_client, item["id"], "p.3mf")).json()["revision"]
    response = await async_client.post(
        f"/api/v1/projects/revisions/{rev['id']}/files",
        files=[("files", ("notes.txt", b"x", "application/octet-stream"))],
    )
    assert response.status_code == 400
    assert "notes.txt" in response.json()["detail"]


async def _linked_task(client, db):
    order = AitoProject(description="Commande", board_column="devis", status="active", client_id="C1")
    db.add(order)
    await db.commit()
    task = AitoTask(project_id=order.id, title="Support")
    db.add(task)
    await db.commit()
    project = await _project(client)
    linked = await client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})
    assert linked.status_code == 200, linked.text
    return task, project


async def _drop(client, task_id, *names):
    return await client.post(
        f"/api/v1/aito/tasks/{task_id}/files",
        files=[("files", (name, b"x", "application/octet-stream")) for name in names],
    )


@pytest.mark.asyncio
@pytest.mark.integration
async def test_dropping_a_pdf_on_a_task_is_400(async_client: AsyncClient, db_session, root):
    task, project = await _linked_task(async_client, db_session)
    response = await _drop(async_client, task.id, "devis.pdf")
    assert response.status_code == 400
    assert "devis.pdf" in response.json()["detail"]
    assert (
        await db_session.execute(select(ProjectItem).where(ProjectItem.project_id == project["id"]))
    ).first() is None


@pytest.mark.asyncio
@pytest.mark.integration
async def test_a_mixed_drop_is_rejected_whole(async_client: AsyncClient, db_session, root):
    task, project = await _linked_task(async_client, db_session)
    response = await _drop(async_client, task.id, "a.3mf", "a.stl")
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert "a.stl" in detail and "a.3mf" not in detail
    assert (
        await db_session.execute(select(ProjectItem).where(ProjectItem.project_id == project["id"]))
    ).first() is None
    assert _files_on_disk(root) == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_dropping_a_3mf_goes_to_impression(async_client: AsyncClient, db_session):
    task, _project_out = await _linked_task(async_client, db_session)
    response = await _drop(async_client, task.id, "Support.3mf", "Support.gcode")
    assert response.status_code == 201, response.text
    results = response.json()["results"]
    assert {r["section"] for r in results} == {"impression"}
    assert len({r["item_id"] for r in results}) == 1


@pytest.mark.asyncio
@pytest.mark.integration
async def test_an_existing_docs_item_can_still_be_renamed_and_deleted(async_client: AsyncClient, db_session):
    project = await _project(async_client)
    legacy = ProjectItem(project_id=project["id"], section="docs", name="Plan", name_key="plan")
    db_session.add(legacy)
    await db_session.commit()
    tree = (await async_client.get(f"/api/v1/projects/{project['id']}/tree")).json()
    docs = next(s for s in tree["sections"] if s["section"] == "docs")
    assert [i["name"] for i in docs["items"]] == ["Plan"]
    renamed = await async_client.patch(f"/api/v1/projects/items/{legacy.id}", json={"name": "Plan v2"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "Plan v2" and renamed.json()["section"] == "docs"
    assert (await async_client.delete(f"/api/v1/projects/items/{legacy.id}")).status_code == 204
