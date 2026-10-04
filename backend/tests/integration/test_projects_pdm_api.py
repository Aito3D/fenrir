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


@pytest.mark.asyncio
@pytest.mark.integration
async def test_patch_new_names_only_keeps_existing_tags(async_client: AsyncClient):
    created = (await async_client.post("/api/v1/projects/", json={"name": "K", "new_tag_names": ["un"]})).json()
    body = (await async_client.patch(f"/api/v1/projects/{created['id']}", json={"new_tag_names": ["deux"]})).json()
    assert [t["name"] for t in body["tag_list"]] == ["deux", "un"]
    assert body["tags"] == "deux, un"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_patch_empty_tag_ids_clears_tags(async_client: AsyncClient):
    created = (await async_client.post("/api/v1/projects/", json={"name": "C", "new_tag_names": ["un"]})).json()
    body = (await async_client.patch(f"/api/v1/projects/{created['id']}", json={"tag_ids": []})).json()
    assert body["tag_list"] == []
    assert not body["tags"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_patch_unknown_tag_id_leaves_tags_unchanged(async_client: AsyncClient):
    created = (await async_client.post("/api/v1/projects/", json={"name": "U", "new_tag_names": ["un"]})).json()
    response = await async_client.patch(f"/api/v1/projects/{created['id']}", json={"tag_ids": [4242]})
    assert response.status_code == 400
    body = (await async_client.get(f"/api/v1/projects/{created['id']}")).json()
    assert [t["name"] for t in body["tag_list"]] == ["un"]
    assert body["tags"] == "un"


async def _make(client, name, **extra):
    return (await client.post("/api/v1/projects/", json={"name": name, **extra})).json()


@pytest.mark.asyncio
@pytest.mark.integration
async def test_search_matches_code_title_description_and_tag(async_client: AsyncClient):
    a = await _make(async_client, "Support caméra", description="pour drone FPV")
    b = await _make(async_client, "Boîtier", new_tag_names=["Électronique"])
    await _make(async_client, "Autre")

    async def ids(q):
        body = (await async_client.get("/api/v1/projects/search", params={"q": q})).json()
        return {item["id"] for item in body["items"]}

    assert await ids("caméra") == {a["id"]}
    assert await ids("fpv") == {a["id"]}
    assert await ids(a["code"].lower()) == {a["id"]}
    assert await ids("Électronique") == {b["id"]}


@pytest.mark.asyncio
@pytest.mark.integration
async def test_search_accented_title_raw_case(async_client: AsyncClient):
    target = await _make(async_client, "Électronique embarquée")
    body = (await async_client.get("/api/v1/projects/search", params={"q": "Électronique"})).json()
    assert [i["id"] for i in body["items"]] == [target["id"]]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_search_escapes_like_wildcards(async_client: AsyncClient):
    hit = await _make(async_client, "Remise 50% client")
    await _make(async_client, "Remise 500 client")
    body = (await async_client.get("/api/v1/projects/search", params={"q": "50%"})).json()
    assert [i["id"] for i in body["items"]] == [hit["id"]]
    underscore = (await async_client.get("/api/v1/projects/search", params={"q": "_"})).json()
    assert underscore["total"] == 0


@pytest.mark.asyncio
@pytest.mark.integration
async def test_search_tag_filter_any_and_all(async_client: AsyncClient):
    both = await _make(async_client, "Both", new_tag_names=["x", "y"])
    only_x = await _make(async_client, "OnlyX", new_tag_names=["x"])
    tag_ids = {t["name"]: t["id"] for t in both["tag_list"]}
    params = [("tag_ids", tag_ids["x"]), ("tag_ids", tag_ids["y"])]
    any_ids = {i["id"] for i in (await async_client.get("/api/v1/projects/search", params=params)).json()["items"]}
    all_ids = {
        i["id"]
        for i in (await async_client.get("/api/v1/projects/search", params=[*params, ("tag_mode", "all")])).json()[
            "items"
        ]
    }
    assert any_ids == {both["id"], only_x["id"]}
    assert all_ids == {both["id"]}


@pytest.mark.asyncio
@pytest.mark.integration
async def test_search_pagination_and_status(async_client: AsyncClient):
    for n in range(5):
        await _make(async_client, f"Page {n}")
    archived = await _make(async_client, "Archivé")
    await async_client.patch(f"/api/v1/projects/{archived['id']}", json={"status": "archived"})
    page = (
        await async_client.get("/api/v1/projects/search", params={"limit": 2, "offset": 2, "status": "active"})
    ).json()
    assert page["total"] == 5
    assert len(page["items"]) == 2
    only_archived = (await async_client.get("/api/v1/projects/search", params={"status": "archived"})).json()
    assert [i["id"] for i in only_archived["items"]] == [archived["id"]]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_search_excludes_templates(async_client: AsyncClient):
    source = await _make(async_client, "Source")
    await async_client.post(f"/api/v1/projects/{source['id']}/create-template")
    body = (await async_client.get("/api/v1/projects/search", params={"q": "Source"})).json()
    assert [i["id"] for i in body["items"]] == [source["id"]]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_project_tags_catalogue_counts(async_client: AsyncClient):
    await _make(async_client, "A", new_tag_names=["commun", "seul"])
    await _make(async_client, "B", new_tag_names=["commun"])
    rows = {r["name"]: r["project_count"] for r in (await async_client.get("/api/v1/projects/tags")).json()}
    assert rows["commun"] == 2
    assert rows["seul"] == 1
