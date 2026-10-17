"""Projects hold one source .3mf per revision, always in Impression (user decision 2026-10-05).

Scan / Modélisation / Usinage / Docs are disabled, not deleted: items already in
them keep working (rename, delete), but nothing new goes in."""

import io
import zipfile
from functools import partial

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.library import LibraryFile
from backend.app.models.project_item import ProjectItem, ProjectRevision
from backend.tests.project_fixtures import api_project, projects_root_fixture, threemf_bytes

root = projects_root_fixture(autouse=True)
_project = partial(api_project, check=False)


async def _upload(client, item_id, *names):
    return await client.post(
        f"/api/v1/projects/items/{item_id}/revisions",
        files=[("files", (name, threemf_bytes(), "application/octet-stream")) for name in names],
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
    response = await _upload(async_client, item["id"], "mesh.stl", "plan.pdf")
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail.startswith("Only Bambu Studio project files")
    assert _files_on_disk(root) == before
    assert (
        await db_session.execute(select(LibraryFile).where(LibraryFile.project_id == project["id"]))
    ).first() is None
    tree = (await async_client.get(f"/api/v1/projects/{project['id']}/tree")).json()
    impression = next(s for s in tree["sections"] if s["section"] == "impression")
    assert impression["items"][0]["revisions"] == []


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
        files=[("files", (name, threemf_bytes(), "application/octet-stream")) for name in names],
    )


@pytest.mark.asyncio
@pytest.mark.integration
async def test_dropping_a_pdf_on_a_task_is_400(async_client: AsyncClient, db_session, root):
    task, project = await _linked_task(async_client, db_session)
    response = await _drop(async_client, task.id, "devis.pdf")
    assert response.status_code == 400
    assert response.json()["detail"].startswith("Only Bambu Studio project files")
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
    assert detail.startswith("Only Bambu Studio project files")
    assert (
        await db_session.execute(select(ProjectItem).where(ProjectItem.project_id == project["id"]))
    ).first() is None
    assert _files_on_disk(root) == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_dropping_a_3mf_goes_to_impression(async_client: AsyncClient, db_session):
    task, _project_out = await _linked_task(async_client, db_session)
    response = await _drop(async_client, task.id, "Support.3mf")
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


# --- source-only uploads (the server slices; users upload the editable project) ---

ONLY_SOURCE = "Only Bambu Studio project files (.3mf) can be added."
ONE_FILE = "A revision holds one .3mf. Upload each part as its own item."


def _zip_bytes(members: dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        for name, data in members.items():
            zf.writestr(name, data)
    return buffer.getvalue()


async def _upload_files(client, item_id, *files):
    return await client.post(
        f"/api/v1/projects/items/{item_id}/revisions",
        files=[("files", (name, data, "application/octet-stream")) for name, data in files],
    )


async def _no_revision_rows(db):
    return (await db.execute(select(ProjectRevision.id))).first() is None and (
        await db.execute(select(LibraryFile.id))
    ).first() is None


async def _empty_tree_item(client):
    project = await _project(client)
    return project, await _impression_item(client, project["id"])


@pytest.mark.asyncio
@pytest.mark.integration
async def test_rejects_gcode_3mf_by_name(async_client: AsyncClient, db_session):
    _p, item = await _empty_tree_item(async_client)
    response = await _upload_files(async_client, item["id"], ("part.gcode.3mf", threemf_bytes()))
    assert response.status_code == 400
    assert "Only Bambu Studio project files" in response.json()["detail"]
    assert await _no_revision_rows(db_session)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_rejects_sliced_content_named_3mf(async_client: AsyncClient, db_session, root):
    project, item = await _empty_tree_item(async_client)
    before = _files_on_disk(root)
    sliced = _zip_bytes({"Metadata/project_settings.config": "{}", "Metadata/plate_1.gcode": "G1"})
    response = await _upload_files(async_client, item["id"], ("part.3mf", sliced))
    assert response.status_code == 400
    assert response.json()["detail"] == ("part.3mf is already sliced. Upload the original .3mf project instead.")
    assert _files_on_disk(root) == before
    assert (
        await db_session.execute(select(LibraryFile).where(LibraryFile.project_id == project["id"]))
    ).first() is None
    tree = (await async_client.get(f"/api/v1/projects/{project['id']}/tree")).json()
    impression = next(s for s in tree["sections"] if s["section"] == "impression")
    assert impression["items"][0]["revisions"] == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_rejects_3mf_without_settings(async_client: AsyncClient, db_session, root):
    _p, item = await _empty_tree_item(async_client)
    before = _files_on_disk(root)
    bare = _zip_bytes({"3D/3dmodel.model": "<model/>"})
    response = await _upload_files(async_client, item["id"], ("bare.3mf", bare))
    assert response.status_code == 400
    assert response.json()["detail"] == (
        "bare.3mf has no printer setup. Open it in Bambu Studio, choose the printer, and save it as a project."
    )
    assert _files_on_disk(root) == before
    assert await _no_revision_rows(db_session)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_rejects_a_3mf_that_is_not_a_zip(async_client: AsyncClient, db_session, root):
    _p, item = await _empty_tree_item(async_client)
    before = _files_on_disk(root)
    response = await _upload_files(async_client, item["id"], ("junk.3mf", b"not a zip"))
    assert response.status_code == 400
    assert ONLY_SOURCE in response.json()["detail"]
    assert _files_on_disk(root) == before
    assert await _no_revision_rows(db_session)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_rejects_two_files(async_client: AsyncClient, db_session, root):
    _p, item = await _empty_tree_item(async_client)
    before = _files_on_disk(root)
    response = await _upload_files(async_client, item["id"], ("a.3mf", threemf_bytes()), ("b.3mf", threemf_bytes()))
    assert response.status_code == 400
    assert response.json()["detail"] == ONE_FILE
    assert _files_on_disk(root) == before
    assert await _no_revision_rows(db_session)


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize("name", ["plate.gcode", "plate.bgcode"])
async def test_rejects_gcode_and_bgcode(async_client: AsyncClient, db_session, name):
    _p, item = await _empty_tree_item(async_client)
    response = await _upload_files(async_client, item["id"], (name, b"G1"))
    assert response.status_code == 400
    assert ONLY_SOURCE in response.json()["detail"]
    assert await _no_revision_rows(db_session)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_add_files_refused_for_new_revisions(async_client: AsyncClient):
    _p, item = await _empty_tree_item(async_client)
    created = await _upload_files(async_client, item["id"], ("p.3mf", threemf_bytes()))
    assert created.status_code == 201, created.text
    rev = created.json()["revision"]
    response = await async_client.post(
        f"/api/v1/projects/revisions/{rev['id']}/files",
        files=[("files", ("q.3mf", threemf_bytes(), "application/octet-stream"))],
    )
    assert response.status_code == 400
    assert response.json()["detail"] == ONE_FILE


@pytest.mark.asyncio
@pytest.mark.integration
async def test_accepts_single_source_3mf(async_client: AsyncClient):
    _p, item = await _empty_tree_item(async_client)
    response = await _upload_files(async_client, item["id"], ("p.3mf", threemf_bytes()))
    assert response.status_code == 201, response.text
    assert len(response.json()["revision"]["files"]) == 1


@pytest.mark.asyncio
@pytest.mark.integration
async def test_drop_of_two_differently_named_3mf_makes_two_items(async_client: AsyncClient, db_session):
    task, project = await _linked_task(async_client, db_session)
    response = await _drop(async_client, task.id, "Support.3mf", "Bracket.3mf")
    assert response.status_code == 201, response.text
    assert len({r["item_id"] for r in response.json()["results"]}) == 2
    tree = (await async_client.get(f"/api/v1/projects/{project['id']}/tree")).json()
    items = next(s for s in tree["sections"] if s["section"] == "impression")["items"]
    assert len(items) == 2
    assert all(len(it["revisions"]) == 1 and len(it["revisions"][0]["files"]) == 1 for it in items)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_drop_of_two_files_for_one_item_is_400_one_file(async_client: AsyncClient, db_session, root):
    task, project = await _linked_task(async_client, db_session)
    response = await _drop(async_client, task.id, "Support.3mf", "support.3mf")
    assert response.status_code == 400
    assert response.json()["detail"] == ONE_FILE
    assert await _no_revision_rows(db_session)
    assert _files_on_disk(root) == []
    assert (
        await db_session.execute(select(ProjectItem).where(ProjectItem.project_id == project["id"]))
    ).first() is None
