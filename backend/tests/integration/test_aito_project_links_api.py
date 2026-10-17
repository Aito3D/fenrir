"""Aito task ↔ project link routes (spec §1.6, §4)."""

import asyncio
from datetime import datetime, timedelta
from functools import partial

import pytest
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes import aito_project_links as links_routes, project_files as files_routes
from backend.app.core.auth import create_access_token, get_password_hash
from backend.app.core.config import settings
from backend.app.core.permissions import Permission
from backend.app.core.websocket import ws_manager
from backend.app.models.aito_event import AitoEvent
from backend.app.models.group import Group
from backend.app.models.project_item import ProjectItem
from backend.app.models.settings import Settings
from backend.app.models.user import User
from backend.app.services import aito_project_links as links_service, project_files as files_service, project_storage
from backend.tests.project_fixtures import (
    ChunkedMultipart,
    api_project,
    legacy_uploads_fixture,
    make_order,
    make_task,
    projects_root_fixture,
    upload,
)

root = projects_root_fixture(autouse=True)
legacy_uploads = legacy_uploads_fixture(autouse=True)


_order = partial(make_order, commit=True)
_task = partial(make_task, commit=True)
_project = partial(api_project, check=False)


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
@pytest.mark.parametrize("action", ["unlink", "create_from_task", "set_deliveries", "drop_files"])
async def test_no_link_mutating_path_marks_quote_pending(async_client: AsyncClient, db_session, action):
    order = await _order(db_session)
    task = await _task(db_session, order)
    project = await _project(async_client)
    revision = await _revision(async_client, project["id"])
    base = f"/api/v1/aito/tasks/{task.id}"
    if action != "create_from_task":
        linked = await async_client.put(f"{base}/project", json={"project_id": project["id"]})
        assert linked.status_code == 200, linked.text
    order.quote_sync_state = "idle"
    await db_session.commit()
    version = order.version

    if action == "unlink":
        response = await async_client.put(f"{base}/project", json={"project_id": None})
        expected = 200
    elif action == "create_from_task":
        response = await async_client.post(f"{base}/project", json={"name": "Nouveau"})
        expected = 201
    elif action == "set_deliveries":
        response = await async_client.put(f"{base}/deliveries", json={"revision_ids": [revision]})
        expected = 200
    else:
        response = await async_client.post(
            f"{base}/files", files=[("files", ("a.3mf", b"x", "application/octet-stream"))]
        )
        expected = 201
    assert response.status_code == expected, response.text

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
        f"/api/v1/aito/tasks/{task.id}/files", files=[("files", ("a.3mf", b"x", "application/octet-stream"))]
    )
    assert unlinked.status_code == 409

    await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})
    response = await async_client.post(
        f"/api/v1/aito/tasks/{task.id}/files",
        files=[("files", ("a.3mf", b"x", "application/octet-stream"))],
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["project_id"] == project["id"]
    assert body["results"][0]["section"] == "impression"
    assert "errors" not in body  # T-286: a full drop's answer keeps its old shape

    missing = await async_client.post(
        "/api/v1/aito/tasks/999999/files", files=[("files", ("a.3mf", b"x", "application/octet-stream"))]
    )
    assert missing.status_code == 404

    events = (await async_client.get(f"/api/v1/aito/{order.id}/events", params={"depth": "story"})).json()
    assert [e["kind"] for e in events["events"]].count("project.files_dropped") == 1


@pytest.mark.asyncio
@pytest.mark.integration
async def test_drop_chunked_upload_over_cap_refused(async_client: AsyncClient, db_session, monkeypatch):
    """T-289: a chunked drop (no Content-Length) is capped like the project upload routes."""
    task = await _task(db_session, await _order(db_session))
    project = await _project(async_client)
    await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})
    monkeypatch.setattr(settings, "library_max_upload_bytes", 1024)
    url = f"/api/v1/aito/tasks/{task.id}/files"
    body = ChunkedMultipart([(f"part{i}.3mf", b"x" * 1000) for i in range(40)])
    refused = await body.post(async_client, url)
    assert refused.status_code == 413
    assert refused.json()["detail"] == "Upload exceeds the maximum size of 1024 bytes"
    assert body.sent < len(body.body)
    accepted = await ChunkedMultipart([("a.3mf", b"x" * 1000)]).post(async_client, url)
    assert accepted.status_code == 201, accepted.text
    assert accepted.json()["results"][0]["section"] == "impression"


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


@pytest.mark.asyncio
@pytest.mark.integration
async def test_upload_revision_records_the_revision_added_label_and_detail(async_client: AsyncClient, db_session):
    """The upload route's ``project.revision_added``: ``"<item> R<n>"`` and section/item_id/revision_id, in order."""
    project = await _project(async_client)
    order = await _order(db_session)
    task = await _task(db_session, order)
    await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})

    revision_id = await _revision(async_client, project["id"])
    item_id = (await db_session.execute(select(ProjectItem.id).where(ProjectItem.name == "Pièce"))).scalar_one()
    [event] = (
        (
            await db_session.execute(
                select(AitoEvent).where(AitoEvent.project_id == order.id, AitoEvent.kind == "project.revision_added")
            )
        )
        .scalars()
        .all()
    )
    assert event.subject_label == "Pièce R1"
    assert list(event.detail.items()) == [
        ("project_id", project["id"]),
        ("code", project["code"]),
        ("section", "impression"),
        ("item_id", item_id),
        ("revision_id", revision_id),
    ]


async def _linked_revision(async_client, db_session):
    project = await _project(async_client)
    order = await _order(db_session)
    task = await _task(db_session, order)
    await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})
    return project, order, await _revision(async_client, project["id"])


@pytest.mark.asyncio
@pytest.mark.integration
async def test_status_change_survives_event_failure(async_client: AsyncClient, db_session, monkeypatch):
    _project_row, order, revision_id = await _linked_revision(async_client, db_session)

    async def boom(*_a, **_k):
        raise RuntimeError("event store down")

    monkeypatch.setattr(files_routes.aito_links, "record_on_linked_orders", boom)
    response = await async_client.patch(f"/api/v1/projects/revisions/{revision_id}", json={"status": "valide"})
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "valide"

    monkeypatch.undo()
    tree = (await async_client.get(f"/api/v1/projects/{_project_row['id']}/tree")).json()
    statuses = [r["status"] for sec in tree["sections"] for it in sec["items"] for r in it["revisions"]]
    assert statuses == ["valide"]
    kinds = (await db_session.execute(select(AitoEvent.kind).where(AitoEvent.project_id == order.id))).scalars().all()
    assert "project.revision_status_changed" not in kinds


@pytest.mark.asyncio
@pytest.mark.integration
async def test_status_change_commit_failure_is_an_error(async_client: AsyncClient, db_session, monkeypatch):
    project, _order_row, revision_id = await _linked_revision(async_client, db_session)
    real_commit = AsyncSession.commit
    calls = {"n": 0}

    async def first_commit_fails(self):
        calls["n"] += 1
        if calls["n"] == 1:
            raise OperationalError("COMMIT", {}, Exception("database is locked"))
        return await real_commit(self)

    monkeypatch.setattr(AsyncSession, "commit", first_commit_fails)
    try:
        response = await async_client.patch(f"/api/v1/projects/revisions/{revision_id}", json={"status": "valide"})
        status_code = response.status_code
    except OperationalError:
        status_code = 500
    assert calls["n"] >= 1
    assert status_code >= 500
    monkeypatch.undo()
    tree = (await async_client.get(f"/api/v1/projects/{project['id']}/tree")).json()
    statuses = [r["status"] for sec in tree["sections"] for it in sec["items"] for r in it["revisions"]]
    assert statuses == ["wip"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_drop_partial_failure_keeps_stored_group_and_records_once(
    async_client: AsyncClient, db_session, monkeypatch
):
    order = await _order(db_session)
    task = await _task(db_session, order)
    project = await _project(async_client)
    await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})

    real = files_service.add_revision
    calls = {"n": 0}

    async def second_fails(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            raise files_service.ProjectFilesError(409, "boom")
        return await real(*args, **kwargs)

    broadcasts = []

    async def fake_broadcast(order_id, actor):
        broadcasts.append(order_id)

    monkeypatch.setattr(links_service.project_files, "add_revision", second_fails)
    monkeypatch.setattr(links_routes, "_broadcast_changed", fake_broadcast)

    response = await async_client.post(
        f"/api/v1/aito/tasks/{task.id}/files",
        files=[
            ("files", ("a.3mf", b"x", "application/octet-stream")),
            ("files", ("b.3mf", b"x", "application/octet-stream")),
        ],
    )
    # T-286: the stored group plus the failed group's error, instead of a bare 409
    assert response.status_code == 201, response.text
    body = response.json()
    assert [r["filename"] for r in body["results"]] == ["a.3mf"]
    assert body["errors"] == [{"filenames": ["b.3mf"], "status_code": 409, "detail": "boom"}]
    assert broadcasts == [order.id]

    monkeypatch.undo()
    tree = (await async_client.get(f"/api/v1/projects/{project['id']}/tree")).json()
    stored = [(it["name"], len(it["revisions"])) for sec in tree["sections"] for it in sec["items"]]
    assert ("a", 1) in stored
    events = (
        (await db_session.execute(select(AitoEvent).where(AitoEvent.kind == "project.files_dropped"))).scalars().all()
    )
    assert len(events) == 1
    assert [r["filename"] for r in events[0].detail["results"]] == ["a.3mf"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_drop_with_an_os_error_on_a_later_group_returns_the_stored_part_and_broadcasts(
    async_client: AsyncClient, db_session, monkeypatch
):
    """T-286: a non-``ProjectFilesError`` (disk full) after a stored group is a partial answer, broadcast too."""
    order = await _order(db_session)
    task = await _task(db_session, order)
    project = await _project(async_client)
    await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})

    real = files_service.add_revision
    calls = {"n": 0}

    async def second_fails(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError(28, "No space left on device")
        return await real(*args, **kwargs)

    broadcasts = []

    async def fake_broadcast(order_id, actor):
        broadcasts.append(order_id)

    monkeypatch.setattr(links_service.project_files, "add_revision", second_fails)
    monkeypatch.setattr(links_routes, "_broadcast_changed", fake_broadcast)

    response = await async_client.post(
        f"/api/v1/aito/tasks/{task.id}/files",
        files=[
            ("files", ("a.3mf", b"x", "application/octet-stream")),
            ("files", ("b.3mf", b"x", "application/octet-stream")),
        ],
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert [r["filename"] for r in body["results"]] == ["a.3mf"]
    assert body["errors"] == [
        {"filenames": ["b.3mf"], "status_code": 500, "detail": "unexpected error while storing the files"}
    ]
    assert broadcasts == [order.id]


@pytest.mark.asyncio
async def test_drop_route_broadcasts_a_stored_group_when_cancelled(db_session, monkeypatch):
    """T-286: the broadcast runs in a ``finally``, so a cancellation past a stored group still refreshes the order."""
    order = await _order(db_session)
    task = await _task(db_session, order)

    async def cancelled_after_one(*_args, **_kwargs):
        exc = asyncio.CancelledError()
        exc.stored_count = 1
        raise exc

    broadcasts = []

    async def fake_broadcast(order_id, actor):
        broadcasts.append(order_id)

    monkeypatch.setattr(links_service, "drop_files_on_task", cancelled_after_one)
    monkeypatch.setattr(links_routes, "_broadcast_changed", fake_broadcast)
    with pytest.raises(asyncio.CancelledError):
        await links_routes.drop_task_files(task.id, files=[], db=db_session, user=None, __=None)
    assert broadcasts == [order.id]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_drop_route_broadcasts_when_cancelled_while_recording_a_stored_group(
    async_client: AsyncClient, db_session, monkeypatch
):
    """T-258: the real service, cancelled inside its ``finally`` after a stored group, still lets the route broadcast."""
    order = await _order(db_session)
    task = await _task(db_session, order)
    project = await _project(async_client)
    await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})
    await db_session.refresh(task)

    async def cancelled_record_drop(*_args, **_kwargs):
        raise asyncio.CancelledError

    broadcasts = []

    async def fake_broadcast(order_id, actor):
        broadcasts.append(order_id)

    monkeypatch.setattr(links_service, "_record_drop", cancelled_record_drop)
    monkeypatch.setattr(links_routes, "_broadcast_changed", fake_broadcast)
    with pytest.raises(asyncio.CancelledError):
        await links_routes.drop_task_files(task.id, files=[upload("a.3mf", b"x")], db=db_session, user=None, __=None)
    assert broadcasts == [order.id]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_drop_failing_on_the_first_group_does_not_broadcast(async_client: AsyncClient, db_session, monkeypatch):
    """Nothing stored (``stored_count`` 0): the 409 goes out without an aito_changed broadcast (T-286: unchanged)."""
    order = await _order(db_session)
    task = await _task(db_session, order)
    project = await _project(async_client)
    await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})

    async def always_fails(*_args, **_kwargs):
        raise files_service.ProjectFilesError(409, "boom")

    broadcasts = []

    async def fake_broadcast(order_id, actor):
        broadcasts.append(order_id)

    monkeypatch.setattr(links_service.project_files, "add_revision", always_fails)
    monkeypatch.setattr(links_routes, "_broadcast_changed", fake_broadcast)

    response = await async_client.post(
        f"/api/v1/aito/tasks/{task.id}/files", files=[("files", ("a.3mf", b"x", "application/octet-stream"))]
    )
    assert (response.status_code, response.json()["detail"]) == (409, "boom")
    assert broadcasts == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_project_linked_only_from_a_trashed_order_deletes(async_client: AsyncClient, db_session):
    """F1: a trashed order's task can never be unlinked (its routes 404), so it must not block the delete."""
    project = await _project(async_client)
    order = await _order(db_session)
    task = await _task(db_session, order)
    await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})
    order.status = "deleted"
    await db_session.commit()

    response = await async_client.delete(f"/api/v1/projects/{project['id']}")
    assert response.status_code == 200, response.text
    await db_session.refresh(task)
    # The trashed task no longer points at a project id that may be reused.
    assert task.linked_project_id is None


@pytest.mark.asyncio
@pytest.mark.integration
async def test_project_linked_from_an_active_order_cannot_be_deleted(async_client: AsyncClient, db_session):
    project = await _project(async_client)
    order = await _order(db_session)
    task = await _task(db_session, order)
    await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})

    response = await async_client.delete(f"/api/v1/projects/{project['id']}")
    assert response.status_code == 409
    assert response.json()["detail"] == "This project is linked to Aito tasks; unlink them first"


@pytest.fixture
async def one_side_tokens(db_session):
    """Auth on; one user with only projects:read, one with only aito:read."""
    db_session.add(Settings(key="auth_enabled", value="true"))
    groups = {
        "projects": Group(name="pdm-projects-read", permissions=[Permission.PROJECTS_READ.value], is_system=False),
        "aito": Group(name="pdm-aito-read", permissions=[Permission.AITO_READ.value], is_system=False),
    }
    db_session.add_all(groups.values())
    await db_session.flush()
    tokens = {}
    for key, group in groups.items():
        user = User(username=f"pdm-{key}-only", password_hash=get_password_hash("password"), is_active=True)
        user.groups.append(group)
        db_session.add(user)
        tokens[key] = create_access_token(data={"sub": user.username})
    await db_session.commit()
    return tokens


@pytest.mark.asyncio
@pytest.mark.integration
async def test_project_orders_needs_aito_read_too(async_client: AsyncClient, one_side_tokens):
    """F4: the orders card lists Aito orders/clients, so projects:read alone is not enough."""
    response = await async_client.get(
        "/api/v1/projects/1/orders", headers={"Authorization": f"Bearer {one_side_tokens['projects']}"}
    )
    assert response.status_code == 403
    response = await async_client.get(
        "/api/v1/projects/1/orders", headers={"Authorization": f"Bearer {one_side_tokens['aito']}"}
    )
    assert response.status_code == 403


@pytest.mark.asyncio
@pytest.mark.integration
async def test_project_codes_needs_projects_read_too(async_client: AsyncClient, one_side_tokens):
    """F4: the card chips show PDM project codes, so aito:read alone is not enough."""
    response = await async_client.get(
        "/api/v1/aito/project-codes", headers={"Authorization": f"Bearer {one_side_tokens['aito']}"}
    )
    assert response.status_code == 403


@pytest.fixture
def aito_broadcasts(monkeypatch):
    """Every aito_changed order id broadcast during the test, in order."""
    sent: list[int] = []

    async def fake(message):
        if message.get("type") == "aito_changed":
            sent.append(message["project_id"])

    monkeypatch.setattr(ws_manager, "broadcast_aito", fake)
    return sent


async def _two_linked_orders(async_client, db_session):
    project = await _project(async_client)
    orders, tasks = [], []
    for _ in range(2):
        order = await _order(db_session)
        task = await _task(db_session, order)
        await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})
        orders.append(order)
        tasks.append(task)
    return project, orders, tasks


@pytest.mark.asyncio
@pytest.mark.integration
async def test_revision_upload_and_status_change_broadcast_to_linked_orders(
    async_client: AsyncClient, db_session, aito_broadcasts
):
    """F5: an open Aito panel of every linked order refreshes its links/step summaries."""
    project, orders, _tasks = await _two_linked_orders(async_client, db_session)
    aito_broadcasts.clear()

    revision_id = await _revision(async_client, project["id"])
    assert sorted(aito_broadcasts) == sorted(o.id for o in orders)

    aito_broadcasts.clear()
    response = await async_client.patch(f"/api/v1/projects/revisions/{revision_id}", json={"status": "valide"})
    assert response.status_code == 200
    assert sorted(aito_broadcasts) == sorted(o.id for o in orders)

    aito_broadcasts.clear()
    await async_client.patch(f"/api/v1/projects/revisions/{revision_id}", json={"note": "n"})
    assert aito_broadcasts == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_drop_fans_revision_events_out_to_other_linked_orders(
    async_client: AsyncClient, db_session, aito_broadcasts
):
    """F8: a drop on order A's task tells order B about each new revision, like a project-page upload."""
    project, (order_a, order_b), (task_a, _task_b) = await _two_linked_orders(async_client, db_session)
    aito_broadcasts.clear()

    response = await async_client.post(
        f"/api/v1/aito/tasks/{task_a.id}/files",
        files=[
            ("files", ("a.3mf", b"x", "application/octet-stream")),
            ("files", ("b.gcode", b"x", "application/octet-stream")),
        ],
    )
    assert response.status_code == 201, response.text

    def kinds(order):
        return select(AitoEvent).where(AitoEvent.project_id == order.id).where(AitoEvent.kind.like("project.%"))

    events_b = (await db_session.execute(kinds(order_b))).scalars().all()
    added = sorted(e.subject_label for e in events_b if e.kind == "project.revision_added")
    assert added == ["a R1", "b R1"]
    assert all(e.detail["code"] == project["code"] for e in events_b)
    events_a = (await db_session.execute(kinds(order_a))).scalars().all()
    assert [e.kind for e in events_a] == ["project.files_dropped"]
    assert set(aito_broadcasts) == {order_a.id, order_b.id}


@pytest.mark.asyncio
@pytest.mark.integration
async def test_linked_event_time_is_not_in_the_future(async_client: AsyncClient, db_session):
    """F10: occurred_at is naive UTC like every other Aito event (record() uses utcnow)."""
    before = datetime.utcnow()
    order = await _order(db_session)
    task = await _task(db_session, order)
    project = await _project(async_client)
    await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})
    after = datetime.utcnow()

    event = (await db_session.execute(select(AitoEvent).where(AitoEvent.kind == "task.project_linked"))).scalar_one()
    assert event.occurred_at.tzinfo is None
    assert before - timedelta(seconds=1) <= event.occurred_at <= after


@pytest.mark.asyncio
@pytest.mark.integration
async def test_task_link_missing_from_its_order_is_404(db_session, monkeypatch):
    """F6: a task that vanished from its order's links is a 404, not a StopIteration 500."""
    order = await _order(db_session)
    task = await _task(db_session, order)

    async def empty_links(_db, order_id):
        return links_service.OrderProjectLinks(order_id=order_id, tasks=[])

    monkeypatch.setattr(links_routes.svc, "order_links", empty_links)
    with pytest.raises(HTTPException) as err:
        await links_routes._task_link(db_session, task)
    assert err.value.status_code == 404


@pytest.mark.parametrize("skip_name_check", [False, True], ids=["name-check-409", "unique-constraint"])
@pytest.mark.asyncio
@pytest.mark.integration
async def test_concurrent_drop_creating_the_same_item_joins_it(
    async_client: AsyncClient, db_session, monkeypatch, skip_name_check
):
    """F6: another drop creates the item between our lookup and our create: we add
    a revision to that item instead of failing (409 from the name check, or the
    unique constraint's IntegrityError when both passed the check)."""
    order = await _order(db_session)
    task = await _task(db_session, order)
    project = await _project(async_client)
    await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})

    real_create = files_service.create_item

    async def racing_create(db, project_row, *, section, name, user_id):
        db_session.add(
            ProjectItem(project_id=project_row.id, section=section, name=name, name_key=files_service.name_key(name))
        )
        await db_session.commit()
        return await real_create(db, project_row, section=section, name=name, user_id=user_id)

    async def no_check(*_a, **_k):
        return None

    monkeypatch.setattr(links_service.project_files, "create_item", racing_create)
    if skip_name_check:
        monkeypatch.setattr(files_service, "_require_item_name_free", no_check)

    response = await async_client.post(
        f"/api/v1/aito/tasks/{task.id}/files", files=[("files", ("a.3mf", b"x", "application/octet-stream"))]
    )
    assert response.status_code == 201, response.text
    [result] = response.json()["results"]
    assert result["revision_number"] == 1
    items = (
        (await db_session.execute(select(ProjectItem).where(ProjectItem.project_id == project["id"]))).scalars().all()
    )
    assert [(i.name, i.id) for i in items] == [("a", result["item_id"])]


_LINK_ERROR_SITES = [
    ("link_task", "put", "project", {"json": {"project_id": 1}}),
    ("create_project_for_task", "post", "project", {"json": {"name": "Nouveau"}}),
    ("set_deliveries", "put", "deliveries", {"json": {"revision_ids": [1]}}),
    ("drop_files_on_task", "post", "files", {"files": [("files", ("a.3mf", b"x", "application/octet-stream"))]}),
]


@pytest.mark.parametrize(("op", "method", "path", "kwargs"), _LINK_ERROR_SITES, ids=[s[0] for s in _LINK_ERROR_SITES])
@pytest.mark.asyncio
@pytest.mark.integration
async def test_link_error_rolls_back_then_maps_to_its_status(
    async_client: AsyncClient, db_session, monkeypatch, op, method, path, kwargs
):
    """T-195 pin: a LinkError from the service op rolls the session back, then
    becomes an HTTP error with the LinkError's own status and detail."""
    order = await _order(db_session)
    task = await _task(db_session, order)
    calls: list[str] = []

    async def teapot(*_a, **_k):
        calls.append("op")
        raise links_service.LinkError(418, "teapot")

    real_rollback = AsyncSession.rollback

    async def spy_rollback(self):
        calls.append("rollback")
        return await real_rollback(self)

    monkeypatch.setattr(links_routes.svc, op, teapot)
    monkeypatch.setattr(AsyncSession, "rollback", spy_rollback)
    response = await getattr(async_client, method)(f"/api/v1/aito/tasks/{task.id}/{path}", **kwargs)
    monkeypatch.undo()
    assert response.status_code == 418
    assert response.json()["detail"] == "teapot"
    # The route's own rollback, then get_db's teardown rollback on the propagating HTTPException.
    assert calls == ["op", "rollback", "rollback"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_link_error_chains_and_other_errors_pass_through(db_session, monkeypatch):
    """T-195 pin, called directly: the HTTPException is raised after the rollback
    and chains the LinkError; any other exception propagates untouched, no rollback."""
    order = await _order(db_session)
    task_id = (await _task(db_session, order)).id
    rolled_back: list[bool] = []
    real_rollback = AsyncSession.rollback

    async def spy_rollback(self):
        rolled_back.append(True)
        return await real_rollback(self)

    link_error = links_service.LinkError(418, "teapot")

    async def teapot(*_a, **_k):
        raise link_error

    monkeypatch.setattr(AsyncSession, "rollback", spy_rollback)
    monkeypatch.setattr(links_routes.svc, "link_task", teapot)
    body = links_routes.TaskLinkRequest(project_id=1)
    with pytest.raises(HTTPException) as err:
        await links_routes.put_task_project(task_id, body, db=db_session, user=None, __=None)
    assert rolled_back == [True]
    assert (err.value.status_code, err.value.detail) == (418, "teapot")
    assert err.value.__cause__ is link_error

    rolled_back.clear()
    boom = RuntimeError("boom")

    async def other(*_a, **_k):
        raise boom

    monkeypatch.setattr(links_routes.svc, "link_task", other)
    with pytest.raises(RuntimeError) as err2:
        await links_routes.put_task_project(task_id, body, db=db_session, user=None, __=None)
    assert err2.value is boom
    assert rolled_back == []
    monkeypatch.undo()


@pytest.mark.asyncio
@pytest.mark.integration
async def test_drop_with_a_blank_sanitised_name_is_refused_whole(
    async_client: AsyncClient, db_session, root, monkeypatch
):
    """T-259: a file whose name sanitises to nothing refuses the whole drop up front (400 naming it), even
    after a valid group: no item, no revision, no file, no event, no broadcast."""
    order = await _order(db_session)
    task = await _task(db_session, order)
    project = await _project(async_client)
    await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})
    order_id = order.id

    broadcasts = []

    async def fake_broadcast(order_id, actor):
        broadcasts.append(order_id)

    monkeypatch.setattr(links_routes, "_broadcast_changed", fake_broadcast)

    async def fake_fan_out(order_ids, actor):
        broadcasts.extend(order_ids)

    monkeypatch.setattr(links_service, "broadcast_orders_changed", fake_fan_out)
    on_disk = sorted(p for p in root.rglob("*") if p.is_file())

    async def drop(*names):
        return await async_client.post(
            f"/api/v1/aito/tasks/{task.id}/files",
            files=[("files", (name, b"x", "application/octet-stream")) for name in names],
        )

    mixed = await drop("a.3mf", "???.3mf", "b.gcode", "...3mf")
    assert (mixed.status_code, mixed.json()["detail"]) == (400, "Item name must not be blank; refused: ???.3mf, ...3mf")
    blank_only = await drop("???.3mf")
    assert (blank_only.status_code, blank_only.json()["detail"]) == (
        400,
        "Item name must not be blank; refused: ???.3mf",
    )
    # a non-printable file is still the first refusal, as before
    other = await drop("???.3mf", "notes.txt")
    assert other.status_code == 400 and other.json()["detail"].startswith("Projects only accept printing files")

    tree = (await async_client.get(f"/api/v1/projects/{project['id']}/tree")).json()
    assert [it for sec in tree["sections"] for it in sec["items"]] == []
    assert sorted(p for p in root.rglob("*") if p.is_file()) == on_disk
    events = (
        (await db_session.execute(select(AitoEvent).where(AitoEvent.kind == "project.files_dropped"))).scalars().all()
    )
    assert events == []
    assert broadcasts == []

    valid = await drop("a.3mf", "b.gcode")
    assert valid.status_code == 201, valid.text
    assert [r["filename"] for r in valid.json()["results"]] == ["a.3mf", "b.gcode"]
    assert broadcasts == [order_id]
