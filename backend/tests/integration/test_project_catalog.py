"""The Projects catalog (design 2026-10-31): folders and the browser list endpoint."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient
from sqlalchemy import update

from backend.app.models.aito_project import AitoProject
from backend.app.models.project import Project
from backend.app.models.project_item import ProjectRevision
from backend.tests.integration.test_project_slice import roots  # noqa: F401  # projects root under tmp_path
from backend.tests.project_fixtures import make_order, make_task, threemf_bytes

API = "/api/v1/projects"


async def _project(client: AsyncClient, name: str) -> dict:
    res = await client.post(f"{API}/", json={"name": name})
    assert res.status_code in (200, 201), res.text
    return res.json()


async def _item_with_file(client: AsyncClient, project_id: int, name: str, filename: str) -> dict:
    item = (await client.post(f"{API}/{project_id}/items", json={"section": "impression", "name": name})).json()
    up = await client.post(
        f"{API}/items/{item['id']}/revisions",
        files=[("files", (filename, threemf_bytes(), "application/octet-stream"))],
    )
    assert up.status_code == 201, up.text
    return up.json()["revision"]


async def _mark_sliced(db, revision_id: int, *, status: str | None = None, printer: str = "Bambu Lab X1C") -> None:
    values: dict = {
        "print_profile": {
            "sliced": True,
            "printer_model": printer,
            "nozzle_diameter": "0.4",
            "filament_types": ["PETG"],
        }
    }
    if status:
        values["status"] = status
    await db.execute(update(ProjectRevision).where(ProjectRevision.id == revision_id).values(**values))
    await db.commit()


async def _folder(client: AsyncClient, name: str, parent_id: int | None = None) -> dict:
    res = await client.post(f"{API}/folders", json={"name": name, "parent_id": parent_id})
    assert res.status_code == 201, res.text
    return res.json()


async def _catalog(client: AsyncClient, **params) -> list[dict]:
    res = await client.get(f"{API}/catalog", params=params)
    assert res.status_code == 200, res.text
    return res.json()["items"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_folders_tree_counts_and_delete_moves_contents_up(async_client: AsyncClient, db_session):
    car = await _folder(async_client, "Car")
    caps = await _folder(async_client, "Wheel cap", car["id"])
    p1 = await _project(async_client, "350Z 60mm WheelCap")
    p2 = await _project(async_client, "Toyota Wheel Cap")
    for p in (p1, p2):
        res = await async_client.patch(f"{API}/{p['id']}/folder", json={"folder_id": caps["id"]})
        assert res.status_code == 200, res.text
        assert res.json() == {"id": p["id"], "folder_id": caps["id"]}
    order = await make_order(db_session, commit=True)
    await make_task(db_session, order, linked_project_id=p1["id"], commit=True)

    folders = {f["name"]: f for f in (await async_client.get(f"{API}/folders")).json()["folders"]}
    assert folders["Car"]["parent_id"] is None and folders["Wheel cap"]["parent_id"] == car["id"]
    assert (folders["Car"]["project_count"], folders["Car"]["in_production_count"]) == (2, 1)  # subtree
    assert (folders["Wheel cap"]["project_count"], folders["Wheel cap"]["in_production_count"]) == (2, 1)

    renamed = await async_client.patch(f"{API}/folders/{caps['id']}", json={"name": "  Wheel  caps "})
    assert renamed.status_code == 200 and renamed.json()["name"] == "Wheel caps"

    # Deleting the middle folder moves its projects up to Car; deleting Car leaves them unfiled.
    assert (await async_client.delete(f"{API}/folders/{caps['id']}")).status_code == 204
    items = {i["id"]: i for i in await _catalog(async_client)}
    assert items[p1["id"]]["folder_id"] == car["id"] and items[p2["id"]]["folder_id"] == car["id"]
    assert (await async_client.delete(f"{API}/folders/{car['id']}")).status_code == 204
    items = {i["id"]: i for i in await _catalog(async_client)}
    assert items[p1["id"]]["folder_id"] is None
    assert (await async_client.get(f"{API}/folders")).json() == {"folders": []}


@pytest.mark.asyncio
@pytest.mark.integration
async def test_folder_moves_are_checked(async_client: AsyncClient):
    car = await _folder(async_client, "Car")
    caps = await _folder(async_client, "Wheel cap", car["id"])
    assert (await async_client.patch(f"{API}/folders/{car['id']}", json={"parent_id": caps["id"]})).status_code == 409
    assert (await async_client.patch(f"{API}/folders/{car['id']}", json={"parent_id": car["id"]})).status_code == 409
    assert (await async_client.patch(f"{API}/folders/{caps['id']}", json={"parent_id": 999_999})).status_code == 404
    moved = await async_client.patch(f"{API}/folders/{caps['id']}", json={"parent_id": None})
    assert moved.status_code == 200 and moved.json()["parent_id"] is None
    assert (await async_client.post(f"{API}/folders", json={"name": "   "})).status_code in (400, 422)
    p = await _project(async_client, "Sarbacane")
    assert (await async_client.patch(f"{API}/{p['id']}/folder", json={"folder_id": 999_999})).status_code == 404
    assert (await async_client.patch(f"{API}/999999/folder", json={"folder_id": None})).status_code == 404


@pytest.mark.asyncio
@pytest.mark.integration
async def test_catalog_facts(async_client: AsyncClient, db_session):
    ready = await _project(async_client, "PS5 Slim Stand")
    r1 = await _item_with_file(async_client, ready["id"], "Stand", "stand.3mf")
    r2 = await _item_with_file(async_client, ready["id"], "Clip", "clip.3mf")
    await _mark_sliced(db_session, r1["id"], status="valide", printer="Bambu Lab X2D")
    await _mark_sliced(db_session, r2["id"])  # newer but not approved: the approved one wins
    unsliced = await _project(async_client, "Cache Néiman")
    await _item_with_file(async_client, unsliced["id"], "Cache", "cache.3mf")
    empty = await _project(async_client, "Scan portière")
    order = await make_order(db_session, commit=True)
    await make_task(db_session, order, linked_project_id=ready["id"], commit=True)
    done = await make_order(db_session, commit=True)
    await db_session.execute(update(AitoProject).where(AitoProject.id == done.id).values(board_column="done"))
    await db_session.commit()
    await make_task(db_session, done, linked_project_id=ready["id"], commit=True)

    items = {i["id"]: i for i in await _catalog(async_client)}
    one = items[ready["id"]]
    assert one["files_count"] == 2 and one["has_unsliced_only"] is False
    assert one["recommended"]["item_name"] == "Stand" and one["recommended"]["status"] == "valide"
    assert one["recommended"]["printer_model"] == "Bambu Lab X2D"
    assert one["recommended"]["filament_types"] == ["PETG"]
    assert one["client_names"] == ["ACME"]
    assert one["open_orders"] == [{"order_id": order.id, "client_name": "ACME"}]  # the done order is not open
    assert one["printed_count"] == 0 and one["target_count"] is None
    assert one["last_activity"] >= ready["created_at"]
    assert items[unsliced["id"]]["has_unsliced_only"] is True and items[unsliced["id"]]["recommended"] is None
    assert items[empty["id"]]["files_count"] == 0 and items[empty["id"]]["has_unsliced_only"] is False
    # Latest activity first: the stamps are whole seconds on SQLite, so age the other two projects
    # by an hour instead of sleeping; the revision added to ``ready`` now is its newest activity.
    aged = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=1)
    await db_session.execute(
        update(Project).where(Project.id.in_([unsliced["id"], empty["id"]])).values(created_at=aged, updated_at=aged)
    )
    await db_session.execute(update(Project).where(Project.id == ready["id"]).values(created_at=aged, updated_at=aged))
    await db_session.execute(update(ProjectRevision).values(created_at=aged))
    await db_session.commit()
    await _item_with_file(async_client, ready["id"], "Foot", "foot.3mf")
    assert [i["id"] for i in await _catalog(async_client)][0] == ready["id"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_catalog_search_reaches_every_field(async_client: AsyncClient, db_session):
    car = await _folder(async_client, "Car")
    caps = await _folder(async_client, "Wheel cap", car["id"])
    nissan = await _project(async_client, "350Z 60mm WheelCap")
    await async_client.patch(f"{API}/{nissan['id']}/folder", json={"folder_id": caps["id"]})
    await _item_with_file(async_client, nissan["id"], "Cap body", "cap_body_v3.3mf")
    other = await _project(async_client, "Sarbacane")
    order = await make_order(db_session, commit=True)
    await make_task(db_session, order, linked_project_id=nissan["id"], commit=True)

    async def ids(q: str) -> set[int]:
        return {i["id"] for i in await _catalog(async_client, q=q)}

    assert await ids("wheelcap") == {nissan["id"]}  # title
    assert await ids("cap body") == {nissan["id"]}  # item name, two terms
    assert await ids("cap_body_v3") == {nissan["id"]}  # file name
    assert await ids("car") == {nissan["id"]}  # ancestor folder name
    assert await ids("acme") == {nissan["id"]}  # client
    assert await ids(f"#{order.id}") == {nissan["id"]}  # order number
    assert await ids("sarbacane") == {other["id"]}
    assert await ids("nothing-like-this") == set()
    assert {i["id"] for i in await _catalog(async_client, status="archived")} == set()
