"""Aito task ↔ project link routes (spec §1.6, §4)."""

import pytest
from httpx import AsyncClient

from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.services import project_storage


@pytest.fixture(autouse=True)
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(project_storage, "projects_root", lambda: tmp_path)


async def _order(db, *, status="active", client_id="C1", description="Commande"):
    order = AitoProject(
        description=description, board_column="devis", status=status, client_id=client_id, client_name="ACME"
    )
    db.add(order)
    await db.commit()
    return order


async def _task(db, order, title="Support"):
    task = AitoTask(project_id=order.id, title=title)
    db.add(task)
    await db.commit()
    return task


async def _project(client, name="Support caméra"):
    return (await client.post("/api/v1/projects/", json={"name": name})).json()


async def _revision(client, project_id):
    item = (
        await client.post(f"/api/v1/projects/{project_id}/items", json={"section": "impression", "name": "Pièce"})
    ).json()
    response = await client.post(
        f"/api/v1/projects/items/{item['id']}/revisions",
        files=[("files", ("p.3mf", b"x", "application/octet-stream"))],
    )
    assert response.status_code == 201, response.text
    return response.json()["revision"]["id"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_link_unlink_round_trip_and_events(async_client: AsyncClient, db_session):
    order = await _order(db_session)
    task = await _task(db_session, order)
    project = await _project(async_client)

    linked = await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})
    assert linked.status_code == 200, linked.text
    assert linked.json()["project"]["code"] == project["code"]

    unlinked = await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": None})
    assert unlinked.json()["project"] is None

    events = (await async_client.get(f"/api/v1/aito/{order.id}/events", params={"depth": "story"})).json()
    kinds = [e["kind"] for e in events["events"]]
    assert "task.project_linked" in kinds and "task.project_unlinked" in kinds


@pytest.mark.asyncio
@pytest.mark.integration
async def test_link_does_not_mark_quote_pending(async_client: AsyncClient, db_session):
    order = await _order(db_session)
    order.quote_sync_state = "idle"
    version = order.version
    task = await _task(db_session, order)
    project = await _project(async_client)

    response = await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})
    assert response.status_code == 200

    await db_session.refresh(order)
    assert order.quote_sync_state == "idle"
    assert order.version == version


@pytest.mark.asyncio
@pytest.mark.integration
async def test_link_errors(async_client: AsyncClient, db_session):
    order = await _order(db_session)
    task = await _task(db_session, order)
    missing = await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": 99999})
    assert missing.status_code == 404
    unknown_task = await async_client.put("/api/v1/aito/tasks/99999/project", json={"project_id": None})
    assert unknown_task.status_code == 404


@pytest.mark.asyncio
@pytest.mark.integration
async def test_task_of_deleted_order_is_404(async_client: AsyncClient, db_session):
    order = await _order(db_session, status="deleted")
    task = await _task(db_session, order)
    project = await _project(async_client)
    response = await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})
    assert response.status_code == 404
    assert (await async_client.get(f"/api/v1/aito/{order.id}/project-links")).status_code == 404


@pytest.mark.asyncio
@pytest.mark.integration
async def test_create_project_from_task(async_client: AsyncClient, db_session):
    order = await _order(db_session)
    task = await _task(db_session, order)

    response = await async_client.post(f"/api/v1/aito/tasks/{task.id}/project", json={"name": "Nouveau"})
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["project"]["name"] == "Nouveau"
    assert body["project"]["code"].startswith("P-")

    bad = await async_client.post(f"/api/v1/aito/tasks/{task.id}/project", json={"name": "X", "tag_ids": [99999]})
    assert bad.status_code == 400


@pytest.mark.asyncio
@pytest.mark.integration
async def test_suggestions(async_client: AsyncClient, db_session):
    order = await _order(db_session)
    await _project(async_client, name="Support caméra")
    task = await _task(db_session, order, title="Support caméra")

    response = await async_client.get(f"/api/v1/aito/tasks/{task.id}/project-suggestions")
    assert response.status_code == 200, response.text
    assert [s["reason"] for s in response.json()] == ["similar_title"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_deliveries_replace_400_409(async_client: AsyncClient, db_session):
    order = await _order(db_session)
    task = await _task(db_session, order)
    project = await _project(async_client)
    other = await _project(async_client, name="Autre")
    revision = await _revision(async_client, project["id"])
    foreign = await _revision(async_client, other["id"])

    not_linked = await async_client.put(f"/api/v1/aito/tasks/{task.id}/deliveries", json={"revision_ids": [revision]})
    assert not_linked.status_code == 409

    await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})
    response = await async_client.put(f"/api/v1/aito/tasks/{task.id}/deliveries", json={"revision_ids": [revision]})
    assert response.status_code == 200, response.text
    assert response.json()["deliveries"] == [revision]

    bad = await async_client.put(f"/api/v1/aito/tasks/{task.id}/deliveries", json={"revision_ids": [foreign]})
    assert bad.status_code == 400

    cleared = await async_client.put(f"/api/v1/aito/tasks/{task.id}/deliveries", json={"revision_ids": []})
    assert cleared.json()["deliveries"] == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_project_links_codes_and_project_orders(async_client: AsyncClient, db_session):
    order = await _order(db_session)
    task = await _task(db_session, order)
    project = await _project(async_client)
    revision = await _revision(async_client, project["id"])
    await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})
    await async_client.put(f"/api/v1/aito/tasks/{task.id}/deliveries", json={"revision_ids": [revision]})

    links = (await async_client.get(f"/api/v1/aito/{order.id}/project-links")).json()
    assert links["order_id"] == order.id
    [entry] = links["tasks"]
    assert entry["project"]["id"] == project["id"]
    assert entry["deliveries"] == [revision]
    assert entry["sections"]["impression"][0]["item_name"] == "Pièce"

    codes = (await async_client.get("/api/v1/aito/project-codes")).json()
    assert codes == {str(order.id): [project["code"]]}

    orders = await async_client.get(f"/api/v1/projects/{project['id']}/orders")
    assert orders.status_code == 200
    [row] = orders.json()["orders"]
    assert row["order_id"] == order.id and row["task_id"] == task.id
    assert [d["id"] for d in row["deliveries"]] == [revision]

    assert (await async_client.get("/api/v1/projects/99999/orders")).status_code == 404


@pytest.mark.asyncio
@pytest.mark.integration
async def test_drop_files_endpoint(async_client: AsyncClient, db_session):
    order = await _order(db_session)
    task = await _task(db_session, order)
    project = await _project(async_client)

    unlinked = await async_client.post(
        f"/api/v1/aito/tasks/{task.id}/files", files=[("files", ("a.stl", b"x", "application/octet-stream"))]
    )
    assert unlinked.status_code == 409

    await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})
    response = await async_client.post(
        f"/api/v1/aito/tasks/{task.id}/files",
        files=[("files", ("a.stl", b"x", "application/octet-stream"))],
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["project_id"] == project["id"]
    assert body["results"][0]["section"] == "modelisation"

    missing = await async_client.post(
        "/api/v1/aito/tasks/999999/files", files=[("files", ("a.stl", b"x", "application/octet-stream"))]
    )
    assert missing.status_code == 404

    events = (await async_client.get(f"/api/v1/aito/{order.id}/events", params={"depth": "story"})).json()
    assert [e["kind"] for e in events["events"]].count("project.files_dropped") == 1


@pytest.mark.asyncio
@pytest.mark.integration
async def test_revision_events_on_every_linked_order(async_client: AsyncClient, db_session):
    project = await _project(async_client)
    orders = [await _order(db_session), await _order(db_session)]
    for order in orders:
        task = await _task(db_session, order)
        await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})

    revision_id = await _revision(async_client, project["id"])
    status = await async_client.patch(f"/api/v1/projects/revisions/{revision_id}", json={"status": "valide"})
    assert status.status_code == 200, status.text
    note_only = await async_client.patch(f"/api/v1/projects/revisions/{revision_id}", json={"note": "n"})
    assert note_only.status_code == 200

    for order in orders:
        events = (await async_client.get(f"/api/v1/aito/{order.id}/events", params={"depth": "story"})).json()["events"]
        added = [e for e in events if e["kind"] == "project.revision_added"]
        changed = [e for e in events if e["kind"] == "project.revision_status_changed"]
        assert len(added) == 1
        assert len(changed) == 1
        assert changed[0]["detail"]["from"] == "wip"
        assert changed[0]["detail"]["to"] == "valide"
