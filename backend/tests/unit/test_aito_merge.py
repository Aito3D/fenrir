"""POST /aito/{project_id}/merge: another card's tasks are copied onto this
one and that card goes to the trash — one request, one timeline story."""

import pytest
from sqlalchemy import select

from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.aito_task_delivery import AitoTaskDelivery
from backend.app.models.project import Project


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
