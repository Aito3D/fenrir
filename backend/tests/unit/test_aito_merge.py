"""POST /aito/{project_id}/merge: another card's tasks are copied onto this
one and that card goes to the trash — one request, one timeline story."""

from datetime import datetime

import pytest
from sqlalchemy import delete, select

from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.aito_task_delivery import AitoTaskDelivery
from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.project import Project
from backend.app.models.project_item import ProjectItem, ProjectRevision
from backend.app.services.project_print_trace import PrintCounts, move_task_print_trace, task_print_counts
from backend.tests.project_fixtures import make_project


async def _create_with_tasks(client, tasks, **overrides):
    payload = {
        "description": "Merge me",
        "client_id": "z1",
        "client_name": "ACME",
        "client_phone": "+33 6 12 34 56 78",
        "tasks": tasks,
    }
    payload.update(overrides)
    resp = await client.post("/api/v1/aito/", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _tasks(client, project_id):
    resp = await client.get(f"/api/v1/aito/{project_id}/tasks")
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _merge(client, target_id, source_id):
    return await client.post(f"/api/v1/aito/{target_id}/merge", json={"source_project_id": source_id})


async def _accept(client, project_id):
    resp = await client.post(f"/api/v1/aito/{project_id}/quote-status", json={"status": "accepted"})
    assert resp.status_code == 200, resp.text


async def _set_invoiced(db_session, project_id):
    project = (await db_session.execute(select(AitoProject).where(AitoProject.id == project_id))).scalar_one()
    project.quote_invoiced = True
    await db_session.commit()


SOURCE_TASKS = [
    {
        "title": "Scan the part",
        "scan_cost": 5000,
        "scan_quantity": 2,
        "scan_discount_pct": 10,
        "scan_description": "Both halves",
    },
    {
        "title": "Print it",
        "impression_cost": 12000,
        "impression_quantity": 3,
        "impression_weight_g": 250,
        "impression_time_min": 90,
        "impression_color": "Noir",
        "impression_description": "PETG",
        "maindoeuvre_cost": 1500,
        "maindoeuvre_description": "Post-processing",
    },
]


@pytest.mark.asyncio
async def test_merge_appends_the_source_tasks_with_every_service_field(async_client):
    target = await _create_with_tasks(async_client, [{"title": "Existing", "usinage_cost": 800}])
    source = await _create_with_tasks(async_client, SOURCE_TASKS, description="Source card")

    resp = await _merge(async_client, target["id"], source["id"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["id"] == target["id"]
    assert resp.json()["task_count"] == 3

    tasks = await _tasks(async_client, target["id"])
    assert [t["title"] for t in tasks] == ["Existing", "Scan the part", "Print it"]
    assert [t["position"] for t in tasks] == [0, 1, 2]
    scan, print_ = tasks[1], tasks[2]
    assert scan["scan_cost"] == 5000
    assert scan["scan_quantity"] == 2
    assert scan["scan_discount_pct"] == 10
    assert scan["scan_description"] == "Both halves"
    assert print_["impression_cost"] == 12000
    assert print_["impression_quantity"] == 3
    assert print_["impression_weight_g"] == 250
    assert print_["impression_time_min"] == 90
    assert print_["impression_color"] == "Noir"
    assert print_["impression_description"] == "PETG"
    assert print_["maindoeuvre_cost"] == 1500
    assert print_["maindoeuvre_description"] == "Post-processing"
    # Copies, not moves: the rows belong to the target now.
    assert {t["project_id"] for t in tasks} == {target["id"]}


@pytest.mark.asyncio
async def test_merge_trashes_the_source_and_keeps_its_own_tasks_for_the_record(async_client):
    target = await _create_with_tasks(async_client, [])
    source = await _create_with_tasks(async_client, SOURCE_TASKS)

    assert (await _merge(async_client, target["id"], source["id"])).status_code == 200

    board = (await async_client.get("/api/v1/aito/")).json()
    assert source["id"] not in {p["id"] for p in board}
    trash = (await async_client.get("/api/v1/aito/trash")).json()
    assert source["id"] in {p["id"] for p in trash}
    # The trashed row keeps its tasks: a restore brings back the card as it
    # was, and the target's copies are independent rows.
    assert len(await _tasks(async_client, source["id"])) == 2


@pytest.mark.asyncio
async def test_merge_keeps_done_ticks_only_when_the_target_is_accepted(async_client):
    source = await _create_with_tasks(async_client, [{"title": "T", "scan_cost": 100}])
    await _accept(async_client, source["id"])
    task_id = (await _tasks(async_client, source["id"]))[0]["id"]
    resp = await async_client.patch(f"/api/v1/aito/tasks/{task_id}", json={"scan_done": True})
    assert resp.status_code == 200, resp.text

    quoted_target = await _create_with_tasks(async_client, [])
    assert (await _merge(async_client, quoted_target["id"], source["id"])).status_code == 200
    assert (await _tasks(async_client, quoted_target["id"]))[0]["scan_done"] is False

    source2 = await _create_with_tasks(async_client, [{"title": "T", "scan_cost": 100}])
    await _accept(async_client, source2["id"])
    task_id = (await _tasks(async_client, source2["id"]))[0]["id"]
    assert (await async_client.patch(f"/api/v1/aito/tasks/{task_id}", json={"scan_done": True})).status_code == 200
    accepted_target = await _create_with_tasks(async_client, [])
    await _accept(async_client, accepted_target["id"])
    assert (await _merge(async_client, accepted_target["id"], source2["id"])).status_code == 200
    assert (await _tasks(async_client, accepted_target["id"]))[0]["scan_done"] is True


@pytest.mark.asyncio
async def test_merge_refuses_itself_and_missing_or_trashed_cards(async_client):
    target = await _create_with_tasks(async_client, [])
    source = await _create_with_tasks(async_client, SOURCE_TASKS)

    assert (await _merge(async_client, target["id"], target["id"])).status_code == 409
    assert (await _merge(async_client, target["id"], 999999)).status_code == 404
    assert (await _merge(async_client, 999999, source["id"])).status_code == 404

    assert (await async_client.delete(f"/api/v1/aito/{source['id']}")).status_code == 204
    assert (await _merge(async_client, target["id"], source["id"])).status_code == 404
    # Nothing was written by any refused attempt.
    assert await _tasks(async_client, target["id"]) == []


@pytest.mark.asyncio
async def test_merge_refuses_an_invoiced_card_on_either_side(async_client, db_session):
    target = await _create_with_tasks(async_client, [])
    source = await _create_with_tasks(async_client, SOURCE_TASKS)

    await _set_invoiced(db_session, source["id"])
    assert (await _merge(async_client, target["id"], source["id"])).status_code == 409

    fresh_source = await _create_with_tasks(async_client, SOURCE_TASKS)
    await _set_invoiced(db_session, target["id"])
    assert (await _merge(async_client, target["id"], fresh_source["id"])).status_code == 409

    assert await _tasks(async_client, target["id"]) == []
    board_ids = {p["id"] for p in (await async_client.get("/api/v1/aito/")).json()}
    assert {source["id"], fresh_source["id"]} <= board_ids


@pytest.mark.asyncio
async def test_merge_tells_the_story_on_both_timelines(async_client, db_session):
    target = await _create_with_tasks(async_client, [])
    source = await _create_with_tasks(async_client, SOURCE_TASKS, description="Second half of the job")

    assert (await _merge(async_client, target["id"], source["id"])).status_code == 200

    target_events = (await async_client.get(f"/api/v1/aito/{target['id']}/events")).json()["events"]
    merged = [e for e in target_events if e["kind"] == "project.merged"]
    assert len(merged) == 1
    assert merged[0]["subject_id"] == source["id"]
    assert merged[0]["subject_label"] == "Second half of the job"
    assert merged[0]["detail"] == {"task_count": 2}

    source_events = (await async_client.get(f"/api/v1/aito/{source['id']}/events")).json()["events"]
    trashed = [e for e in source_events if e["kind"] == "project.trashed"]
    assert len(trashed) == 1
    assert trashed[0]["detail"] == {"merged_into": target["id"]}

    # The copied rows are real AitoTask rows on the target, not references.
    rows = (await db_session.execute(select(AitoTask).where(AitoTask.project_id == target["id"]))).scalars().all()
    assert len(rows) == 2


@pytest.mark.asyncio
async def test_merge_keeps_the_project_link_and_deliveries_with_the_work(async_client, db_session):
    """Fenrir PDM: the copied task stays linked to its project and keeps the
    revisions it delivered; the trashed source keeps its own rows (copy, not move)."""
    target = await _create_with_tasks(async_client, [{"title": "Existing"}])
    source = await _create_with_tasks(async_client, [{"title": "Linked part"}], description="Source card")
    project = Project(name="Support")
    db_session.add(project)
    await db_session.flush()
    source_task = (await db_session.execute(select(AitoTask).where(AitoTask.project_id == source["id"]))).scalar_one()
    source_task.linked_project_id = project.id
    db_session.add(AitoTaskDelivery(task_id=source_task.id, revision_id=4242))
    await db_session.commit()

    resp = await _merge(async_client, target["id"], source["id"])
    assert resp.status_code == 200, resp.text

    copied = (
        await db_session.execute(
            select(AitoTask).where(AitoTask.project_id == target["id"], AitoTask.title == "Linked part")
        )
    ).scalar_one()
    assert copied.linked_project_id == project.id
    delivered = (
        await db_session.execute(select(AitoTaskDelivery.revision_id).where(AitoTaskDelivery.task_id == copied.id))
    ).scalars()
    assert list(delivered) == [4242]
    kept = (
        await db_session.execute(select(AitoTaskDelivery.revision_id).where(AitoTaskDelivery.task_id == source_task.id))
    ).scalars()
    assert list(kept) == [4242]


async def _delivering_source(client, db_session, *, number=2):
    """A source card whose one task is linked to a real project and delivers a
    real revision ``Pièce R<number>``; returns (source, task, project, revision)."""
    source = await _create_with_tasks(client, [{"title": "Linked part"}], description="Source card")
    project = await make_project(db_session, "Support")
    item = ProjectItem(
        project_id=project.id, section="impression", name="Pièce", name_key="pièce", last_revision_number=number
    )
    db_session.add(item)
    await db_session.flush()
    revision = ProjectRevision(item_id=item.id, number=number, status="valide")
    db_session.add(revision)
    await db_session.flush()
    source_task = (await db_session.execute(select(AitoTask).where(AitoTask.project_id == source["id"]))).scalar_one()
    source_task.linked_project_id = project.id
    db_session.add(AitoTaskDelivery(task_id=source_task.id, revision_id=revision.id))
    await db_session.commit()
    return source, source_task, project, revision


async def _link_of(client, order_id, title):
    resp = await client.get(f"/api/v1/aito/{order_id}/project-links")
    assert resp.status_code == 200, resp.text
    return next(t for t in resp.json()["tasks"] if t["task_title"] == title)


def _delivered_labels(link):
    """``"<item> R<n>"`` for each delivered revision visible in the task's section summary."""
    by_number = {(s["item_name"], s["number"]) for section in link["sections"].values() for s in section}
    return sorted(f"{name} R{number}" for name, number in by_number)


@pytest.mark.asyncio
async def test_merge_copies_a_real_delivered_revision_onto_the_target_links(async_client, db_session):
    """T-211: the copy delivers the same real revision, and the target's
    project-links page shows it on the copied task as ``Pièce R2``."""
    target = await _create_with_tasks(async_client, [{"title": "Existing"}])
    source, source_task, project, revision = await _delivering_source(async_client, db_session)

    resp = await _merge(async_client, target["id"], source["id"])
    assert resp.status_code == 200, resp.text

    link = await _link_of(async_client, target["id"], "Linked part")
    assert link["task_id"] != source_task.id
    assert link["project"]["id"] == project.id
    assert link["project"]["name"] == "Support"
    assert link["deliveries"] == [revision.id]
    assert link["sections"]["impression"][0]["item_name"] == "Pièce"
    assert link["sections"]["impression"][0]["number"] == 2
    assert _delivered_labels(link) == ["Pièce R2"]
    # The untouched target task has no link and no deliveries.
    existing = await _link_of(async_client, target["id"], "Existing")
    assert existing["project"] is None
    assert existing["deliveries"] == []
    # The trashed source's links page is gone (404), its delivery row kept (copy, not move).
    assert (await async_client.get(f"/api/v1/aito/{source['id']}/project-links")).status_code == 404
    kept = (
        await db_session.execute(select(AitoTaskDelivery.revision_id).where(AitoTaskDelivery.task_id == source_task.id))
    ).scalars()
    assert list(kept) == [revision.id]


@pytest.mark.asyncio
async def test_merge_copies_a_delivery_whose_revision_was_deleted(async_client, db_session):
    """T-211 pin: AitoTaskDelivery.revision_id has no FK and the merge copies
    every delivery row as is — a delivery of a deleted revision is copied too
    (the dangling id travels), and the links page reports it without a section entry."""
    target = await _create_with_tasks(async_client, [{"title": "Existing"}])
    source, _, project, revision = await _delivering_source(async_client, db_session)
    dangling = revision.id
    await db_session.execute(delete(ProjectRevision).where(ProjectRevision.id == dangling))
    await db_session.commit()

    resp = await _merge(async_client, target["id"], source["id"])
    assert resp.status_code == 200, resp.text

    link = await _link_of(async_client, target["id"], "Linked part")
    assert link["project"]["id"] == project.id
    assert link["deliveries"] == [dangling]
    assert link["sections"] == {}


@pytest.mark.asyncio
async def test_merge_keeps_the_link_to_a_deleted_project(async_client, db_session):
    """T-211 pin: AitoTask.linked_project_id has no FK; with the linked project
    deleted before the merge the copy still carries its id and its delivery
    rows, and the links page shows the copied task with no project."""
    target = await _create_with_tasks(async_client, [{"title": "Existing"}])
    source, _, project, revision = await _delivering_source(async_client, db_session)
    project_id, revision_id = project.id, revision.id
    await db_session.execute(delete(Project).where(Project.id == project_id))
    await db_session.commit()

    resp = await _merge(async_client, target["id"], source["id"])
    assert resp.status_code == 200, resp.text

    copied = (
        await db_session.execute(
            select(AitoTask).where(AitoTask.project_id == target["id"], AitoTask.title == "Linked part")
        )
    ).scalar_one()
    assert copied.linked_project_id == project_id
    link = await _link_of(async_client, target["id"], "Linked part")
    assert link["project"] is None
    assert link["sections"] == {}
    assert link["deliveries"] == [revision_id]


async def _race(async_client, monkeypatch, first, second):
    """Run merge ``first`` up to the point where it has read both cards as
    active, then run merge ``second`` to completion, then let ``first``
    finish. Returns both responses. Before T-126 the paused merge carried
    on from its stale reads and succeeded too."""
    import asyncio

    from backend.app.api.routes import aito as aito_routes

    original = aito_routes._get_active_project_or_404
    paused = asyncio.Event()
    release = asyncio.Event()
    calls = {"n": 0}

    async def pausing(db, project_id):
        project = await original(db, project_id)
        calls["n"] += 1
        # The first request's second read is its source: pause right after it.
        if calls["n"] == 2:
            paused.set()
            await release.wait()
        return project

    monkeypatch.setattr(aito_routes, "_get_active_project_or_404", pausing)
    first_task = asyncio.create_task(_merge(async_client, *first))
    await asyncio.wait_for(paused.wait(), timeout=5)
    second_resp = await _merge(async_client, *second)
    release.set()
    first_resp = await asyncio.wait_for(first_task, timeout=5)
    return first_resp, second_resp


async def _event_kinds(async_client, project_id):
    events = (await async_client.get(f"/api/v1/aito/{project_id}/events")).json()["events"]
    return [e["kind"] for e in events]


@pytest.mark.asyncio
async def test_a_duplicated_merge_request_gets_a_409_and_copies_nothing(async_client, monkeypatch):
    """A<-B sent twice (two operators, a client retry): one merge wins, the
    other is refused before it copies a task or records an event, so the
    target does not end up with every source line twice."""
    target = await _create_with_tasks(async_client, [])
    source = await _create_with_tasks(async_client, SOURCE_TASKS)

    first, second = await _race(async_client, monkeypatch, (target["id"], source["id"]), (target["id"], source["id"]))

    assert second.status_code == 200, second.text
    assert first.status_code == 409, first.text
    assert [t["title"] for t in await _tasks(async_client, target["id"])] == ["Scan the part", "Print it"]
    assert (await _event_kinds(async_client, target["id"])).count("project.merged") == 1
    assert (await _event_kinds(async_client, source["id"])).count("project.trashed") == 1


@pytest.mark.asyncio
async def test_crossed_merges_cannot_trash_both_cards(async_client, monkeypatch):
    """A<-B racing B<-A: before T-126 each copied the other's tasks and
    trashed the other, and both cards left the board. Now the second to
    write gets a 409 and the winner's target stays on the board."""
    a = await _create_with_tasks(async_client, [{"title": "A task", "scan_cost": 100}])
    b = await _create_with_tasks(async_client, [{"title": "B task", "scan_cost": 200}])

    first, second = await _race(async_client, monkeypatch, (a["id"], b["id"]), (b["id"], a["id"]))

    assert second.status_code == 200, second.text
    assert first.status_code == 409, first.text
    board_ids = {p["id"] for p in (await async_client.get("/api/v1/aito/")).json()}
    assert a["id"] not in board_ids
    assert b["id"] in board_ids
    assert [t["title"] for t in await _tasks(async_client, b["id"])] == ["B task", "A task"]
    assert "project.merged" not in await _event_kinds(async_client, a["id"])


@pytest.mark.asyncio
async def test_merge_with_linked_delivering_task_queues_the_target_quote_push(async_client, db_session):
    """T-249: unlike the link routes (which never touch quote_sync_state), a merge
    copies billable tasks onto the target, so it DOES mark the target quote pending."""
    target = await _create_with_tasks(async_client, [{"title": "Existing"}])
    source, _, _, _ = await _delivering_source(async_client, db_session)
    target_row = (await db_session.execute(select(AitoProject).where(AitoProject.id == target["id"]))).scalar_one()
    target_row.quote_sync_state = "idle"
    await db_session.commit()

    resp = await _merge(async_client, target["id"], source["id"])
    assert resp.status_code == 200, resp.text

    await db_session.refresh(target_row)
    assert target_row.quote_sync_state == "pending"


# --- T-294: the source tasks' prints move to their copies -------------------


def _queue_row(task_id, status):
    return PrintQueueItem(aito_task_id=task_id, status=status)


def _archive_row(task_id, *, status="completed", deleted=False):
    return PrintArchive(
        filename="part.3mf",
        file_path="archives/part.3mf",
        file_size=1,
        status=status,
        aito_task_id=task_id,
        deleted_at=datetime(2026, 1, 1) if deleted else None,
    )


async def _task_ids(db_session, model, ids):
    rows = await db_session.execute(select(model.id, model.aito_task_id).where(model.id.in_(ids)))
    return dict(rows.all())


@pytest.mark.asyncio
async def test_merge_moves_the_source_tasks_prints_to_their_copies(async_client, db_session):
    """Every queue item (pending to finished) and archive (trashed ones too) of a
    source task now names its copy; the target's own task, a task-less row and
    the other source task's rows are left alone."""
    target = await _create_with_tasks(async_client, [{"title": "Existing"}])
    source = await _create_with_tasks(
        async_client, [{"title": "Printed part"}, {"title": "Other part"}], description="Source card"
    )
    by_title = {
        t.title: t.id
        for t in (
            await db_session.execute(select(AitoTask).where(AitoTask.project_id.in_([target["id"], source["id"]])))
        )
        .scalars()
        .all()
    }
    printed, other, existing = by_title["Printed part"], by_title["Other part"], by_title["Existing"]
    queue = [_queue_row(printed, s) for s in ("pending", "printing", "completed", "failed", "cancelled")]
    queue += [_queue_row(other, "pending"), _queue_row(existing, "pending"), _queue_row(None, "pending")]
    archives = [_archive_row(printed), _archive_row(printed, status="failed"), _archive_row(printed, deleted=True)]
    archives += [_archive_row(other), _archive_row(existing), _archive_row(None)]
    db_session.add_all(queue + archives)
    await db_session.commit()
    queue_ids, archive_ids = [q.id for q in queue], [a.id for a in archives]

    resp = await _merge(async_client, target["id"], source["id"])
    assert resp.status_code == 200, resp.text

    copies = {
        t.title: t.id
        for t in (await db_session.execute(select(AitoTask).where(AitoTask.project_id == target["id"]))).scalars()
    }
    printed_copy, other_copy = copies["Printed part"], copies["Other part"]
    db_session.expire_all()
    assert list((await _task_ids(db_session, PrintQueueItem, queue_ids)).values()) == [printed_copy] * 5 + [
        other_copy,
        existing,
        None,
    ]
    assert [(await _task_ids(db_session, PrintArchive, archive_ids))[i] for i in archive_ids] == [printed_copy] * 3 + [
        other_copy,
        existing,
        None,
    ]

    counts = await task_print_counts(db_session, [printed_copy, other_copy, printed, other, existing])
    assert counts[printed_copy] == PrintCounts(printed=1, rejected=0, queued=2)  # pending + printing
    assert counts[other_copy] == PrintCounts(printed=1, rejected=0, queued=1)
    assert counts[existing] == PrintCounts(printed=1, rejected=0, queued=1)
    assert printed not in counts and other not in counts  # the trashed card's tasks show nothing now
    link = await _link_of(async_client, target["id"], "Printed part")
    assert (link["printed"], link["queued"]) == (1, 2)


@pytest.mark.asyncio
async def test_merge_without_prints_moves_nothing(async_client, db_session):
    target = await _create_with_tasks(async_client, [{"title": "Existing"}])
    source = await _create_with_tasks(async_client, [{"title": "Unprinted"}], description="Source card")
    bystander = _queue_row(None, "pending")
    db_session.add(bystander)
    await db_session.commit()
    bystander_id = bystander.id

    resp = await _merge(async_client, target["id"], source["id"])
    assert resp.status_code == 200, resp.text
    db_session.expire_all()
    assert (await _task_ids(db_session, PrintQueueItem, [bystander_id])) == {bystander_id: None}


@pytest.mark.asyncio
async def test_move_task_print_trace_with_no_tasks_runs_nothing():
    class _NoQueries:
        async def execute(self, statement):  # pragma: no cover - must not run
            raise AssertionError("no statement expected")

    assert await move_task_print_trace(_NoQueries(), {}) is None
