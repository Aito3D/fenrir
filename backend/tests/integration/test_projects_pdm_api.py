"""Projects as a PDM, phase 1 API."""

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.models.library import LibraryTag
from backend.app.models.project_tag import ProjectTag


@pytest.mark.asyncio
@pytest.mark.integration
async def test_create_with_tag_ids_and_new_names(async_client: AsyncClient, db_session):
    tag = LibraryTag(name="Drone", name_key="drone")
    db_session.add(tag)
    await db_session.commit()
    response = await async_client.post(
        "/api/v1/projects/", json={"name": "Support", "tag_ids": [tag.id], "new_tag_names": ["pièce auto"]}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["code"].startswith("P-")
    assert [t["name"] for t in body["tag_list"]] == ["Drone", "pièce auto"]
    assert body["tags"] == "Drone, pièce auto"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_legacy_tags_string_still_works(async_client: AsyncClient):
    created = (await async_client.post("/api/v1/projects/", json={"name": "Legacy", "tags": "a, B"})).json()
    assert [t["name"] for t in created["tag_list"]] == ["a", "B"]
    updated = (await async_client.patch(f"/api/v1/projects/{created['id']}", json={"tags": "c"})).json()
    assert [t["name"] for t in updated["tag_list"]] == ["c"]
    assert updated["tags"] == "c"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_update_unknown_tag_id_is_400(async_client: AsyncClient):
    created = (await async_client.post("/api/v1/projects/", json={"name": "X"})).json()
    response = await async_client.patch(f"/api/v1/projects/{created['id']}", json={"tag_ids": [4242]})
    assert response.status_code == 400


@pytest.mark.asyncio
@pytest.mark.integration
async def test_get_project_returns_code_and_tags(async_client: AsyncClient):
    created = (await async_client.post("/api/v1/projects/", json={"name": "Y", "new_tag_names": ["t1"]})).json()
    body = (await async_client.get(f"/api/v1/projects/{created['id']}")).json()
    assert body["code"] == created["code"]
    assert [t["name"] for t in body["tag_list"]] == ["t1"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_delete_project_removes_tag_links(async_client: AsyncClient, db_session):
    created = (await async_client.post("/api/v1/projects/", json={"name": "Z", "new_tag_names": ["gone"]})).json()
    assert (await async_client.delete(f"/api/v1/projects/{created['id']}")).status_code == 200
    links = (await db_session.execute(select(ProjectTag).where(ProjectTag.project_id == created["id"]))).all()
    assert links == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_library_tag_rename_refreshes_project_mirror(async_client: AsyncClient, db_session):
    created = (await async_client.post("/api/v1/projects/", json={"name": "R", "new_tag_names": ["old"]})).json()
    tag_id = created["tag_list"][0]["id"]
    assert (await async_client.patch(f"/api/v1/library/tags/{tag_id}", json={"name": "new"})).status_code == 200
    body = (await async_client.get(f"/api/v1/projects/{created['id']}")).json()
    assert body["tags"] == "new"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_library_tag_delete_refreshes_project_mirror(async_client: AsyncClient):
    created = (await async_client.post("/api/v1/projects/", json={"name": "D", "new_tag_names": ["a", "b"]})).json()
    tag_a = next(t["id"] for t in created["tag_list"] if t["name"] == "a")
    assert (await async_client.delete(f"/api/v1/library/tags/{tag_a}")).status_code == 204
    body = (await async_client.get(f"/api/v1/projects/{created['id']}")).json()
    assert body["tags"] == "b"
    assert [t["name"] for t in body["tag_list"]] == ["b"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_template_copy_carries_tags(async_client: AsyncClient):
    created = (await async_client.post("/api/v1/projects/", json={"name": "T", "new_tag_names": ["gabarit"]})).json()
    template = (await async_client.post(f"/api/v1/projects/{created['id']}/create-template")).json()
    copy = (await async_client.post(f"/api/v1/projects/from-template/{template['id']}")).json()
    assert copy["code"] not in (created["code"], template["code"])
    body = (await async_client.get(f"/api/v1/projects/{copy['id']}")).json()
    assert [t["name"] for t in body["tag_list"]] == ["gabarit"]
