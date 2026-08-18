"""PATCH /aito/{project_id}/tasks/reorder: renumbering, id-set validation,
quote-sync queueing, and the timeline event."""

import pytest


async def _create_with_tasks(client, n=3, **overrides):
    payload = {
        "description": "Reorder me",
        "client_id": "z1",
        "client_name": "ACME",
        "client_phone": "+33 6 12 34 56 78",
        "tasks": [{"title": f"T{i}", "scan_cost": 1000 + i} for i in range(n)],
    }
    payload.update(overrides)
    resp = await client.post("/api/v1/aito/", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _task_ids(client, project_id):
    resp = await client.get(f"/api/v1/aito/{project_id}/tasks")
    assert resp.status_code == 200
    return [t["id"] for t in resp.json()]


@pytest.mark.asyncio
async def test_reorder_persists_and_lists_in_new_order(async_client):
    project = await _create_with_tasks(async_client)
    ids = await _task_ids(async_client, project["id"])
    new_order = list(reversed(ids))

    resp = await async_client.patch(f"/api/v1/aito/{project['id']}/tasks/reorder", json={"task_ids": new_order})
    assert resp.status_code == 200, resp.text
    assert [t["id"] for t in resp.json()] == new_order
    assert [t["position"] for t in resp.json()] == [0, 1, 2]
    assert await _task_ids(async_client, project["id"]) == new_order


@pytest.mark.asyncio
async def test_reorder_rejects_a_stale_or_forged_id_set(async_client):
    """The payload must be exactly the project's current task-id set: a
    missing id, a foreign id, or a duplicate each means the client's list is
    stale (a concurrent add/delete) or wrong, and renumbering from it would
    corrupt the order. 409 tells the client to refetch and retry."""
    project = await _create_with_tasks(async_client)
    other = await _create_with_tasks(async_client, n=1)
    ids = await _task_ids(async_client, project["id"])
    foreign = (await _task_ids(async_client, other["id"]))[0]

    for bad in (ids[:-1], [*ids, foreign], [ids[0], ids[0], ids[1]], [*ids[:-1], foreign]):
        resp = await async_client.patch(f"/api/v1/aito/{project['id']}/tasks/reorder", json={"task_ids": bad})
        assert resp.status_code == 409, (bad, resp.text)

    # Nothing was written by any refused attempt.
    assert await _task_ids(async_client, project["id"]) == ids


@pytest.mark.asyncio
async def test_reorder_404s_on_missing_or_trashed_project(async_client):
    project = await _create_with_tasks(async_client)
    ids = await _task_ids(async_client, project["id"])
    assert (await async_client.delete(f"/api/v1/aito/{project['id']}")).status_code == 204

    resp = await async_client.patch(f"/api/v1/aito/{project['id']}/tasks/reorder", json={"task_ids": ids})
    assert resp.status_code == 404
    resp = await async_client.patch("/api/v1/aito/999999/tasks/reorder", json={"task_ids": [1]})
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_reorder_wakes_the_quote_sync_worker(async_client):
    """A reorder changes what the quote must say (line order), so it queues a
    push instead of sitting out the 300s poll — same contract as every other
    task edit (see test_every_edit_that_touches_the_quote_wakes_the_worker)."""
    from backend.app.services import aito_quote_sync

    project = await _create_with_tasks(async_client)
    ids = await _task_ids(async_client, project["id"])

    aito_quote_sync._wake.clear()
    aito_quote_sync._debounce_deadline = None
    resp = await async_client.patch(
        f"/api/v1/aito/{project['id']}/tasks/reorder", json={"task_ids": list(reversed(ids))}
    )
    assert resp.status_code == 200
    assert aito_quote_sync._wake.is_set()


@pytest.mark.asyncio
async def test_reorder_never_touches_an_unmanaged_project(async_client):
    """An imported legacy card's quote belongs to Zoho, not to this feature:
    reordering its tasks must reorder the LIST but never queue a quote push."""
    from backend.app.services import aito_quote_sync

    seeded = await async_client.post(
        "/api/v1/aito/import",
        json={"projects": [{"description": "Legacy", "column": "devis", "position": 0}]},
    )
    assert seeded.status_code == 201
    project_id = seeded.json()[0]["id"]
    for i in range(2):
        r = await async_client.post(f"/api/v1/aito/{project_id}/tasks", json={"scan_cost": 100 + i})
        assert r.status_code == 201
    ids = await _task_ids(async_client, project_id)

    aito_quote_sync._wake.clear()
    aito_quote_sync._debounce_deadline = None
    resp = await async_client.patch(f"/api/v1/aito/{project_id}/tasks/reorder", json={"task_ids": list(reversed(ids))})
    assert resp.status_code == 200
    assert await _task_ids(async_client, project_id) == list(reversed(ids))
    assert not aito_quote_sync._wake.is_set()

    listed = await async_client.get("/api/v1/aito/")
    row = next(p for p in listed.json() if p["id"] == project_id)
    assert row["quote_sync_state"] == "unmanaged"


async def _sync_queued_count(client, project_id):
    trace = (await client.get(f"/api/v1/aito/{project_id}/events?depth=everything")).json()["events"]
    return len([e for e in trace if e["kind"] == "sync.queued"])


@pytest.mark.asyncio
async def test_reorder_records_one_detail_event(async_client):
    project = await _create_with_tasks(async_client)
    ids = await _task_ids(async_client, project["id"])
    queued_before = await _sync_queued_count(async_client, project["id"])
    resp = await async_client.patch(
        f"/api/v1/aito/{project['id']}/tasks/reorder", json={"task_ids": list(reversed(ids))}
    )
    assert resp.status_code == 200

    events = (await async_client.get(f"/api/v1/aito/{project['id']}/events?depth=detail")).json()["events"]
    reorders = [e for e in events if e["kind"] == "task.reordered"]
    assert len(reorders) == 1
    # story depth hides it: it is hand-work detail, not project narrative.
    story = (await async_client.get(f"/api/v1/aito/{project['id']}/events?depth=story")).json()["events"]
    assert all(e["kind"] != "task.reordered" for e in story)
    # A fresh project is created already-pending, so this reorder must NOT add
    # a second sync.queued — only a genuine idle→pending transition records one.
    assert await _sync_queued_count(async_client, project["id"]) == queued_before


@pytest.mark.asyncio
async def test_reorder_in_place_is_a_no_op(async_client):
    """Dropping a card back into its own slot must not queue a Zoho push or
    write a timeline event — nothing changed."""
    from backend.app.services import aito_quote_sync

    project = await _create_with_tasks(async_client)
    ids = await _task_ids(async_client, project["id"])

    aito_quote_sync._wake.clear()
    aito_quote_sync._debounce_deadline = None
    resp = await async_client.patch(f"/api/v1/aito/{project['id']}/tasks/reorder", json={"task_ids": ids})
    assert resp.status_code == 200
    assert [t["id"] for t in resp.json()] == ids
    assert not aito_quote_sync._wake.is_set()
    events = (await async_client.get(f"/api/v1/aito/{project['id']}/events?depth=detail")).json()["events"]
    assert all(e["kind"] != "task.reordered" for e in events)
