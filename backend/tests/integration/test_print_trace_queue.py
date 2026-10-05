"""Queue creation derives the revision and validates the Aito task (projects as a PDM, phase 4).

``revision_id`` comes from the library file, never from the client; an
``aito_task_id`` must name a live task linked to the revision's project, and a
successful queue records ``print.queued_from_revision`` once on the task's order.
"""

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.core.websocket import ws_manager
from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.services import project_storage
from backend.app.services.print_batch import _clone_queue_item

KIND = "print.queued_from_revision"


@pytest.fixture(autouse=True)
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(project_storage, "projects_root", lambda: tmp_path)


@pytest.fixture
def broadcasts(monkeypatch):
    sent: list[dict] = []

    async def _capture(message):
        sent.append(message)

    monkeypatch.setattr(ws_manager, "broadcast_aito", _capture)
    return sent


async def _order(db, *, status="active"):
    order = AitoProject(description="Commande", board_column="devis", status=status, client_id="C1", client_name="ACME")
    db.add(order)
    await db.commit()
    return order


async def _task(db, order, *, linked_project_id=None, title="Support"):
    task = AitoTask(project_id=order.id, title=title, linked_project_id=linked_project_id)
    db.add(task)
    await db.commit()
    return task


async def _project(client, name="Support caméra"):
    response = await client.post("/api/v1/projects/", json={"name": name})
    assert response.status_code in (200, 201), response.text
    return response.json()


async def _revision_file(client, db, project_id, item_name="Support"):
    """R1 of a new impression item holding one sliced file; returns (revision_id, library_file_id)."""
    item = (
        await client.post(f"/api/v1/projects/{project_id}/items", json={"section": "impression", "name": item_name})
    ).json()
    response = await client.post(
        f"/api/v1/projects/items/{item['id']}/revisions",
        files=[("files", ("part.gcode.3mf", b"x", "application/octet-stream"))],
    )
    assert response.status_code == 201, response.text
    revision_id = response.json()["revision"]["id"]
    file_id = (await db.execute(select(LibraryFile.id).where(LibraryFile.revision_id == revision_id))).scalar_one()
    return revision_id, file_id


async def _plain_file(db, tmp_path):
    path = tmp_path / "plain.gcode.3mf"
    path.write_bytes(b"x")
    row = LibraryFile(filename="plain.gcode.3mf", file_path=str(path), file_type="3mf", file_size=1)
    db.add(row)
    await db.commit()
    return row.id


async def _items(db, **where):
    stmt = select(PrintQueueItem)
    for column, value in where.items():
        stmt = stmt.where(getattr(PrintQueueItem, column) == value)
    return list((await db.execute(stmt.order_by(PrintQueueItem.id))).scalars())


async def _events(db, order_id):
    return list(
        (await db.execute(select(AitoEvent).where(AitoEvent.project_id == order_id, AitoEvent.kind == KIND))).scalars()
    )


@pytest.mark.asyncio
@pytest.mark.integration
async def test_revision_file_without_project_id_takes_the_revision_and_its_project(
    async_client: AsyncClient, db_session
):
    project = await _project(async_client)
    revision_id, file_id = await _revision_file(async_client, db_session, project["id"])

    response = await async_client.post("/api/v1/queue/", json={"library_file_id": file_id})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["revision_id"] == revision_id
    assert body["aito_task_id"] is None
    (item,) = await _items(db_session, library_file_id=file_id)
    assert (item.revision_id, item.project_id, item.aito_task_id) == (revision_id, project["id"], None)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_client_sent_revision_id_is_ignored(async_client: AsyncClient, db_session, tmp_path):
    project = await _project(async_client)
    revision_id, file_id = await _revision_file(async_client, db_session, project["id"])
    plain_id = await _plain_file(db_session, tmp_path)

    on_plain = await async_client.post("/api/v1/queue/", json={"library_file_id": plain_id, "revision_id": revision_id})
    assert on_plain.status_code == 200, on_plain.text
    assert on_plain.json()["revision_id"] is None

    on_revision = await async_client.post("/api/v1/queue/", json={"library_file_id": file_id, "revision_id": 99999})
    assert on_revision.status_code == 200, on_revision.text
    assert on_revision.json()["revision_id"] == revision_id


@pytest.mark.asyncio
@pytest.mark.integration
async def test_task_is_stored_on_every_copy_and_recorded_once(async_client: AsyncClient, db_session, broadcasts):
    project = await _project(async_client)
    revision_id, file_id = await _revision_file(async_client, db_session, project["id"], item_name="Support")
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project["id"])

    response = await async_client.post(
        "/api/v1/queue/", json={"library_file_id": file_id, "aito_task_id": task.id, "quantity": 3}
    )
    assert response.status_code == 200, response.text
    assert response.json()["aito_task_id"] == task.id

    items = await _items(db_session, library_file_id=file_id)
    assert len(items) == 3
    assert {(i.revision_id, i.aito_task_id, i.project_id) for i in items} == {(revision_id, task.id, project["id"])}
    assert len({i.batch_id for i in items}) == 1 and items[0].batch_id is not None

    (event,) = await _events(db_session, order.id)
    assert event.detail == {
        "revision_label": "Support R1",
        "copies": 3,
        "project_id": project["id"],
        "code": project["code"],
    }
    assert (event.subject_type, event.subject_id) == ("task", task.id)
    assert any(m.get("type") == "aito_changed" and m.get("project_id") == order.id for m in broadcasts)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_task_linked_to_another_project_is_400(async_client: AsyncClient, db_session):
    project = await _project(async_client)
    other = await _project(async_client, name="Autre")
    _revision_id, file_id = await _revision_file(async_client, db_session, project["id"])
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=other["id"])
    unlinked = await _task(db_session, order, title="Libre")

    details = set()
    for task_id in (task.id, unlinked.id, 99999):
        response = await async_client.post("/api/v1/queue/", json={"library_file_id": file_id, "aito_task_id": task_id})
        assert response.status_code == 400, response.text
        details.add(response.json()["detail"])
    # Same message whether the task exists or not.
    assert details == {"This Aito task can't be used for this file"}
    assert await _items(db_session, library_file_id=file_id) == []
    assert await _events(db_session, order.id) == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_task_of_deleted_order_is_400(async_client: AsyncClient, db_session):
    project = await _project(async_client)
    _revision_id, file_id = await _revision_file(async_client, db_session, project["id"])
    order = await _order(db_session, status="deleted")
    task = await _task(db_session, order, linked_project_id=project["id"])

    response = await async_client.post("/api/v1/queue/", json={"library_file_id": file_id, "aito_task_id": task.id})
    assert response.status_code == 400, response.text
    assert await _items(db_session, library_file_id=file_id) == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_task_with_non_project_file_is_400(async_client: AsyncClient, db_session, tmp_path):
    project = await _project(async_client)
    plain_id = await _plain_file(db_session, tmp_path)
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project["id"])

    response = await async_client.post("/api/v1/queue/", json={"library_file_id": plain_id, "aito_task_id": task.id})
    assert response.status_code == 400, response.text
    assert await _items(db_session, library_file_id=plain_id) == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_non_project_file_queues_as_before(async_client: AsyncClient, db_session, tmp_path, broadcasts):
    plain_id = await _plain_file(db_session, tmp_path)

    response = await async_client.post("/api/v1/queue/", json={"library_file_id": plain_id, "quantity": 2})
    assert response.status_code == 200, response.text
    items = await _items(db_session, library_file_id=plain_id)
    assert len(items) == 2
    assert all((i.revision_id, i.aito_task_id, i.project_id) == (None, None, None) for i in items)
    assert (await db_session.execute(select(AitoEvent).where(AitoEvent.kind == KIND))).first() is None
    assert broadcasts == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_explicit_project_id_is_kept(async_client: AsyncClient, db_session):
    project = await _project(async_client)
    other = await _project(async_client, name="Autre")
    revision_id, file_id = await _revision_file(async_client, db_session, project["id"])

    response = await async_client.post("/api/v1/queue/", json={"library_file_id": file_id, "project_id": other["id"]})
    assert response.status_code == 200, response.text
    (item,) = await _items(db_session, library_file_id=file_id)
    assert (item.revision_id, item.project_id) == (revision_id, other["id"])


@pytest.mark.asyncio
@pytest.mark.integration
async def test_event_failure_never_fails_the_queue(async_client: AsyncClient, db_session, monkeypatch):
    from backend.app.services import aito_events

    project = await _project(async_client)
    _revision_id, file_id = await _revision_file(async_client, db_session, project["id"])
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project["id"])

    async def _boom(*_args, **_kwargs):
        raise RuntimeError("event store down")

    monkeypatch.setattr(aito_events, "record", _boom)
    response = await async_client.post("/api/v1/queue/", json={"library_file_id": file_id, "aito_task_id": task.id})
    assert response.status_code == 200, response.text
    (item,) = await _items(db_session, library_file_id=file_id)
    assert item.aito_task_id == task.id


@pytest.mark.asyncio
@pytest.mark.integration
async def test_library_add_to_queue_derives_the_revision(async_client: AsyncClient, db_session):
    project = await _project(async_client)
    revision_id, file_id = await _revision_file(async_client, db_session, project["id"])

    response = await async_client.post("/api/v1/library/files/add-to-queue", json={"file_ids": [file_id]})
    assert response.status_code == 200, response.text
    (item,) = await _items(db_session, library_file_id=file_id)
    assert (item.revision_id, item.project_id, item.aito_task_id) == (revision_id, project["id"], None)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_batch_clone_keeps_revision_and_task():
    source = PrintQueueItem(status="printing", position=1, library_file_id=4, revision_id=11, aito_task_id=22)
    clone = _clone_queue_item(source, position=9, created_by_id=None)
    assert (clone.revision_id, clone.aito_task_id, clone.status) == (11, 22, "pending")


async def _sliced(db, *, model, revision_id=None, project_id=None):
    row = LibraryFile(
        filename=f"{model.lower()}.gcode.3mf",
        file_path=f"/test/{model.lower()}.gcode.3mf",
        file_type="gcode.3mf",
        file_size=1,
        file_metadata={"sliced_for_model": model},
        revision_id=revision_id,
        project_id=project_id,
    )
    db.add(row)
    await db.commit()
    return row.id


@pytest.mark.asyncio
@pytest.mark.integration
async def test_variants_of_one_revision_carry_it_and_mixed_ones_are_400(
    async_client: AsyncClient, db_session, printer_factory
):
    await printer_factory(model="H2S")
    await printer_factory(model="H2C")
    project = await _project(async_client)
    revision_id, _file_id = await _revision_file(async_client, db_session, project["id"])
    other_revision, _ = await _revision_file(async_client, db_session, project["id"], item_name="Capot")
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project["id"])
    h2s = await _sliced(db_session, model="H2S", revision_id=revision_id, project_id=project["id"])
    h2c = await _sliced(db_session, model="H2C", revision_id=revision_id, project_id=project["id"])
    h2c_other = await _sliced(db_session, model="H2C", revision_id=other_revision, project_id=project["id"])
    h2c_plain = await _sliced(db_session, model="H2C")

    ok = await async_client.post(
        "/api/v1/queue/",
        json={"variants": [{"library_file_id": h2s}, {"library_file_id": h2c}], "aito_task_id": task.id},
    )
    assert ok.status_code == 200, ok.text
    assert (ok.json()["revision_id"], ok.json()["aito_task_id"]) == (revision_id, task.id)
    item = await db_session.get(PrintQueueItem, ok.json()["id"])
    assert item.project_id == project["id"]

    for mixed in (h2c_other, h2c_plain):
        response = await async_client.post(
            "/api/v1/queue/", json={"variants": [{"library_file_id": h2s}, {"library_file_id": mixed}]}
        )
        assert response.status_code == 400, response.text
        assert "same project revision" in response.json()["detail"]


async def _archive(db, *, revision_id=None):
    archive = PrintArchive(
        filename="reprint.gcode.3mf",
        print_name="Reprint",
        file_path="archives/test/reprint.gcode.3mf",
        file_size=1,
        status="completed",
        revision_id=revision_id,
    )
    db.add(archive)
    await db.commit()
    return archive.id


@pytest.mark.asyncio
@pytest.mark.integration
async def test_reprint_of_a_traced_archive_keeps_its_revision_and_task(
    async_client: AsyncClient, db_session, broadcasts
):
    project = await _project(async_client)
    revision_id, _file_id = await _revision_file(async_client, db_session, project["id"], item_name="Support")
    archive_id = await _archive(db_session, revision_id=revision_id)
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project["id"])
    other = await _project(async_client, name="Autre")
    wrong = await _task(db_session, order, linked_project_id=other["id"], title="Autre")

    plain = await async_client.post("/api/v1/queue/", json={"archive_id": archive_id})
    assert plain.status_code == 200, plain.text
    assert (plain.json()["revision_id"], plain.json()["aito_task_id"]) == (revision_id, None)
    assert (await db_session.get(PrintQueueItem, plain.json()["id"])).project_id == project["id"]

    rejected = await async_client.post("/api/v1/queue/", json={"archive_id": archive_id, "aito_task_id": wrong.id})
    assert rejected.status_code == 400, rejected.text

    traced = await async_client.post(
        "/api/v1/queue/", json={"archive_id": archive_id, "aito_task_id": task.id, "quantity": 2}
    )
    assert traced.status_code == 200, traced.text
    items = await _items(db_session, archive_id=archive_id, aito_task_id=task.id)
    assert len(items) == 2 and {i.revision_id for i in items} == {revision_id}
    (event,) = await _events(db_session, order.id)
    assert event.detail["revision_label"] == "Support R1" and event.detail["copies"] == 2


@pytest.mark.asyncio
@pytest.mark.integration
async def test_reprint_of_an_untraced_archive_is_unchanged(async_client: AsyncClient, db_session):
    project = await _project(async_client)
    archive_id = await _archive(db_session)
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project["id"])

    response = await async_client.post("/api/v1/queue/", json={"archive_id": archive_id})
    assert response.status_code == 200, response.text
    (item,) = await _items(db_session, archive_id=archive_id)
    assert (item.revision_id, item.aito_task_id, item.project_id) == (None, None, None)

    with_task = await async_client.post("/api/v1/queue/", json={"archive_id": archive_id, "aito_task_id": task.id})
    assert with_task.status_code == 400, with_task.text
