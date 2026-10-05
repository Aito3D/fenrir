"""Queue creation derives the revision and validates the Aito task (projects as a PDM, phase 4).

``revision_id`` comes from the library file, never from the client; an
``aito_task_id`` must name a live task linked to the revision's project, and a
successful queue records ``print.queued_from_revision`` once on the task's order.
"""

from datetime import datetime, timezone

import pytest
from httpx import AsyncClient
from sqlalchemy import event, select

from backend.app.api.routes.projects import _archive_trace_labels
from backend.app.core.websocket import ws_manager
from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.project import Project
from backend.app.services import project_storage
from backend.app.services.aito_project_links import order_links
from backend.app.services.print_batch import _clone_queue_item
from backend.app.services.project_files import load_tree
from backend.app.services.project_print_trace import PrintCounts, revision_print_counts, task_print_counts

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


# --- counts (task 3) --------------------------------------------------------


def _counted_archive(*, task_id=None, revision_id=None, project_id=None, **kwargs):
    kwargs.setdefault("status", "completed")
    kwargs.setdefault("print_name", "Part")
    return PrintArchive(
        filename="part.gcode.3mf",
        file_path="archives/test/part.gcode.3mf",
        file_size=1,
        aito_task_id=task_id,
        revision_id=revision_id,
        project_id=project_id,
        **kwargs,
    )


def _queue_item(task_id, status):
    return PrintQueueItem(aito_task_id=task_id, status=status, position=1)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_printed_count_follows_verdicts(db_session):
    order = await _order(db_session)
    task = await _task(db_session, order)
    empty = await _task(db_session, order, title="Nothing")
    db_session.add_all(
        [
            _counted_archive(task_id=task.id),  # completed -> printed
            _counted_archive(task_id=task.id, user_verdict="reject"),  # completed+reject -> rejected only
            _counted_archive(task_id=task.id, status="failed", user_verdict="good"),  # failed+good -> printed
            _counted_archive(task_id=task.id, status="failed"),  # neither
            _counted_archive(task_id=task.id, deleted_at=datetime.now(timezone.utc)),  # ignored
            _counted_archive(task_id=task.id, quantity=4),  # counts 4
        ]
    )
    await db_session.commit()

    counts = await task_print_counts(db_session, [task.id, empty.id])
    assert counts[task.id] == PrintCounts(printed=1 + 1 + 4, rejected=1, queued=0)
    assert empty.id not in counts
    assert await task_print_counts(db_session, []) == {}


@pytest.mark.asyncio
@pytest.mark.integration
async def test_queued_counts_pending_and_printing_only(db_session):
    order = await _order(db_session)
    task = await _task(db_session, order)
    db_session.add_all(
        [_queue_item(task.id, s) for s in ("pending", "printing", "completed", "failed", "skipped", "cancelled")]
    )
    await db_session.commit()

    assert (await task_print_counts(db_session, [task.id]))[task.id] == PrintCounts(0, 0, 2)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_link_target_mirrors_impression_quantity_and_counts(db_session):
    order = await _order(db_session)
    task = await _task(db_session, order)
    task.impression_quantity = 10
    other = await _task(db_session, order, title="Other")
    db_session.add_all([_counted_archive(task_id=task.id, quantity=3), _queue_item(task.id, "pending")])
    await db_session.commit()

    links = {t.task_id: t for t in (await order_links(db_session, order.id)).tasks}
    assert (links[task.id].printed, links[task.id].rejected, links[task.id].queued, links[task.id].target) == (
        3,
        0,
        1,
        10,
    )
    assert (links[other.id].printed, links[other.id].queued, links[other.id].target) == (0, 0, None)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_revision_print_count_in_tree(async_client: AsyncClient, db_session):
    project = await _project(async_client)
    revision_id, _file_id = await _revision_file(async_client, db_session, project["id"])
    db_session.add_all(
        [
            _counted_archive(revision_id=revision_id, quantity=2),
            _counted_archive(revision_id=revision_id, user_verdict="reject"),
            _counted_archive(revision_id=revision_id, deleted_at=datetime.now(timezone.utc)),
        ]
    )
    await db_session.commit()

    assert await revision_print_counts(db_session, [revision_id]) == {revision_id: 2}
    tree = (await async_client.get(f"/api/v1/projects/{project['id']}/tree")).json()
    revisions = [r for s in tree["sections"] for i in s["items"] for r in i["revisions"]]
    assert [r["print_count"] for r in revisions] == [2]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_project_archives_carry_revision_label_task_and_order(async_client: AsyncClient, db_session):
    project = await _project(async_client)
    revision_id, _file_id = await _revision_file(async_client, db_session, project["id"], item_name="Support")
    order = await _order(db_session)
    task = await _task(db_session, order, linked_project_id=project["id"])
    db_session.add_all(
        [
            _counted_archive(task_id=task.id, revision_id=revision_id, project_id=project["id"], print_name="traced"),
            _counted_archive(project_id=project["id"], print_name="plain"),
        ]
    )
    await db_session.commit()

    response = await async_client.get(f"/api/v1/projects/{project['id']}/archives")
    assert response.status_code == 200, response.text
    by_name = {a["print_name"]: a for a in response.json()}
    traced, plain = by_name["traced"], by_name["plain"]
    assert (traced["revision_label"], traced["aito_task_id"], traced["order_id"]) == ("Support R1", task.id, order.id)
    assert (plain["revision_label"], plain["aito_task_id"], plain["order_id"]) == (None, None, None)


async def _statements(db_session, call):
    engine = db_session.bind.sync_engine
    seen: list[str] = []

    def _count(_conn, _cursor, statement, *_args):
        seen.append(statement)

    event.listen(engine, "before_cursor_execute", _count)
    try:
        await call()
    finally:
        event.remove(engine, "before_cursor_execute", _count)
    return len(seen)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_counts_use_a_fixed_number_of_queries(async_client: AsyncClient, db_session):
    project = await _project(async_client)
    revision_id, _file_id = await _revision_file(async_client, db_session, project["id"])
    order = await _order(db_session)
    first = await _task(db_session, order, linked_project_id=project["id"])
    db_session.add(_counted_archive(task_id=first.id, revision_id=revision_id))
    await db_session.commit()

    async def probe():
        await order_links(db_session, order.id)
        await load_tree(db_session, await db_session.get(Project, project["id"]))
        await _archive_trace_labels(db_session, list((await db_session.execute(select(PrintArchive))).scalars()))

    baseline = await _statements(db_session, probe)

    for n in range(5):
        task = await _task(db_session, order, title=f"T{n}", linked_project_id=project["id"])
        extra_revision, _ = await _revision_file(async_client, db_session, project["id"], item_name=f"Item{n}")
        db_session.add_all(
            [_counted_archive(task_id=task.id, revision_id=extra_revision), _queue_item(task.id, "pending")]
        )
    await db_session.commit()

    assert await _statements(db_session, probe) <= baseline


async def _file_with_parts(db, parts: int | None):
    """A library file whose stored 3MF metadata lists ``parts`` printable objects (None: no metadata)."""
    metadata = None if parts is None else {"printable_objects": {str(i + 1): f"Part {i + 1}" for i in range(parts)}}
    row = LibraryFile(
        filename=f"parts-{parts}.gcode.3mf",
        file_path=f"/test/parts-{parts}.gcode.3mf",
        file_type="gcode.3mf",
        file_size=1,
        file_metadata=metadata,
    )
    db.add(row)
    await db.commit()
    return row.id


@pytest.mark.asyncio
@pytest.mark.integration
async def test_queued_counts_parts_like_printed(db_session):
    """Queued is in parts, like printed: a 5-part plate queued twice is 10."""
    order = await _order(db_session)
    task = await _task(db_session, order)
    bare = await _task(db_session, order, title="Bare")
    reprint = await _task(db_session, order, title="Reprint")
    five = await _file_with_parts(db_session, 5)
    none = await _file_with_parts(db_session, None)
    archive = _counted_archive(quantity=3)
    db_session.add(archive)
    await db_session.commit()
    db_session.add_all(
        [
            PrintQueueItem(aito_task_id=task.id, status="pending", position=1, library_file_id=five),
            PrintQueueItem(aito_task_id=task.id, status="printing", position=2, library_file_id=five),
            PrintQueueItem(aito_task_id=task.id, status="completed", position=3, library_file_id=five),
            PrintQueueItem(aito_task_id=bare.id, status="pending", position=4, library_file_id=none),
            PrintQueueItem(aito_task_id=bare.id, status="pending", position=5, library_file_id=none),
            PrintQueueItem(aito_task_id=reprint.id, status="pending", position=6, archive_id=archive.id),
        ]
    )
    await db_session.commit()

    counts = await task_print_counts(db_session, [task.id, bare.id, reprint.id])
    assert counts[task.id].queued == 10
    assert counts[bare.id].queued == 2
    assert counts[reprint.id].queued == 3


@pytest.mark.asyncio
@pytest.mark.integration
async def test_reprint_cannot_move_an_archive_to_another_task(async_client: AsyncClient, db_session):
    """The scheduler keeps the archive's own task, so a different one would be credited wrongly."""
    project = await _project(async_client)
    revision_id, _file_id = await _revision_file(async_client, db_session, project["id"])
    order = await _order(db_session)
    owner = await _task(db_session, order, linked_project_id=project["id"])
    other = await _task(db_session, order, linked_project_id=project["id"], title="Autre")
    archive_id = await _archive(db_session, revision_id=revision_id)
    archive = await db_session.get(PrintArchive, archive_id)
    archive.aito_task_id = owner.id
    await db_session.commit()

    moved = await async_client.post("/api/v1/queue/", json={"archive_id": archive_id, "aito_task_id": other.id})
    assert moved.status_code == 400, moved.text
    assert moved.json()["detail"] == "This Aito task can't be used for this file"
    assert await _items(db_session, archive_id=archive_id) == []

    same = await async_client.post("/api/v1/queue/", json={"archive_id": archive_id, "aito_task_id": owner.id})
    assert same.status_code == 200, same.text
    assert same.json()["aito_task_id"] == owner.id
    unset = await async_client.post("/api/v1/queue/", json={"archive_id": archive_id})
    assert unset.status_code == 200, unset.text
