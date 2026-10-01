"""POST /aito/{project_id}/tasks/transfer: move tasks to another card, or
split them off onto a new one for the same client."""

import pytest

from backend.tests.unit.test_aito_merge import _accept, _create_with_tasks, _set_invoiced, _tasks

TASKS = [
    {"title": "A", "scan_cost": 1000},
    {"title": "B", "impression_cost": 2000, "impression_quantity": 2, "impression_color": "Noir"},
    {"title": "C", "usinage_cost": 500, "usinage_description": "Deburr"},
]


async def _transfer(client, source_id, task_ids, target_id):
    return await client.post(
        f"/api/v1/aito/{source_id}/tasks/transfer",
        json={"task_ids": task_ids, "target_project_id": target_id},
    )


async def _events_of_kind(client, project_id, kind):
    events = (await client.get(f"/api/v1/aito/{project_id}/events")).json()["events"]
    return [e for e in events if e["kind"] == kind]


@pytest.mark.asyncio
async def test_split_creates_a_card_for_the_same_client_and_moves_the_ticked_tasks(async_client):
    source = await _create_with_tasks(async_client, TASKS, client_email="a@b.pf", client_is_company=True)
    ids = [t["id"] for t in await _tasks(async_client, source["id"])]

    resp = await _transfer(async_client, source["id"], [ids[1], ids[2]], None)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["source"]["id"] == source["id"]
    new = body["target"]
    assert new["id"] != source["id"]
    assert new["client_id"] == "z1"
    assert new["client_name"] == "ACME"
    assert new["client_email"] == "a@b.pf"
    assert new["client_is_company"] is True
    assert new["description"] == source["description"]
    assert new["column"] == "devis"
    assert new["quote_status"] == "draft"
    assert [t["title"] for t in await _tasks(async_client, source["id"])] == ["A"]
    moved = await _tasks(async_client, new["id"])
    assert [(t["title"], t["position"]) for t in moved] == [("B", 0), ("C", 1)]
    assert moved[0]["impression_color"] == "Noir"
    assert moved[1]["usinage_description"] == "Deburr"
    assert (await _tasks(async_client, source["id"]))[0]["position"] == 0


@pytest.mark.asyncio
async def test_move_appends_after_the_target_tasks(async_client):
    source = await _create_with_tasks(async_client, TASKS)
    target = await _create_with_tasks(async_client, [{"title": "T0", "scan_cost": 1}])
    ids = [t["id"] for t in await _tasks(async_client, source["id"])]

    resp = await _transfer(async_client, source["id"], [ids[0]], target["id"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["target"]["task_count"] == 2
    assert [(t["title"], t["position"]) for t in await _tasks(async_client, target["id"])] == [("T0", 0), ("A", 1)]
    assert [(t["title"], t["position"]) for t in await _tasks(async_client, source["id"])] == [("B", 0), ("C", 1)]


@pytest.mark.asyncio
async def test_done_ticks_survive_only_onto_an_accepted_target(async_client):
    source = await _create_with_tasks(async_client, [{"title": "A", "scan_cost": 1}])
    await _accept(async_client, source["id"])
    task_id = (await _tasks(async_client, source["id"]))[0]["id"]
    assert (await async_client.patch(f"/api/v1/aito/tasks/{task_id}", json={"scan_done": True})).status_code == 200
    draft_target = await _create_with_tasks(async_client, [])
    assert (await _transfer(async_client, source["id"], [task_id], draft_target["id"])).status_code == 200
    assert (await _tasks(async_client, draft_target["id"]))[0]["scan_done"] is False

    source2 = await _create_with_tasks(async_client, [{"title": "A", "scan_cost": 1}])
    await _accept(async_client, source2["id"])
    task_id = (await _tasks(async_client, source2["id"]))[0]["id"]
    assert (await async_client.patch(f"/api/v1/aito/tasks/{task_id}", json={"scan_done": True})).status_code == 200
    accepted_target = await _create_with_tasks(async_client, [])
    await _accept(async_client, accepted_target["id"])
    assert (await _transfer(async_client, source2["id"], [task_id], accepted_target["id"])).status_code == 200
    assert (await _tasks(async_client, accepted_target["id"]))[0]["scan_done"] is True


@pytest.mark.asyncio
async def test_refusals_write_nothing(async_client, db_session):
    source = await _create_with_tasks(async_client, TASKS)
    other = await _create_with_tasks(async_client, [{"title": "X", "scan_cost": 1}])
    ids = [t["id"] for t in await _tasks(async_client, source["id"])]
    foreign = (await _tasks(async_client, other["id"]))[0]["id"]

    assert (await _transfer(async_client, source["id"], ids, None)).status_code == 409  # every task
    assert (await _transfer(async_client, source["id"], [foreign], other["id"])).status_code == 409
    assert (await _transfer(async_client, source["id"], [ids[0], ids[0]], other["id"])).status_code == 422
    assert (await _transfer(async_client, source["id"], [ids[0]], source["id"])).status_code == 409
    assert (await _transfer(async_client, source["id"], [ids[0]], 999999)).status_code == 404
    assert (await _transfer(async_client, 999999, [1], None)).status_code == 404

    await _set_invoiced(db_session, other["id"])
    assert (await _transfer(async_client, source["id"], [ids[0]], other["id"])).status_code == 409
    await _set_invoiced(db_session, source["id"])
    assert (await _transfer(async_client, source["id"], [ids[0]], None)).status_code == 409

    assert [t["id"] for t in await _tasks(async_client, source["id"])] == ids
    assert len(await _tasks(async_client, other["id"])) == 1


@pytest.mark.asyncio
async def test_transfer_tells_the_story_on_both_timelines(async_client):
    source = await _create_with_tasks(async_client, TASKS, description="Big job")
    target = await _create_with_tasks(async_client, [], description="Second card")
    ids = [t["id"] for t in await _tasks(async_client, source["id"])]
    assert (await _transfer(async_client, source["id"], ids[:2], target["id"])).status_code == 200

    out = await _events_of_kind(async_client, source["id"], "task.transferred_out")
    assert len(out) == 1 and out[0]["subject_id"] == target["id"] and out[0]["subject_label"] == "Second card"
    assert out[0]["detail"] == {"task_count": 2, "target_id": target["id"], "split": False}
    inn = await _events_of_kind(async_client, target["id"], "task.transferred_in")
    assert len(inn) == 1 and inn[0]["subject_id"] == source["id"]


@pytest.fixture
def wakes(monkeypatch):
    """Which sync-worker wake each transfer asks for."""
    from backend.app.api.routes import aito as aito_routes

    calls: list[str] = []
    monkeypatch.setattr(aito_routes, "request_immediate_sync", lambda: calls.append("immediate"))
    monkeypatch.setattr(aito_routes, "request_debounced_sync", lambda: calls.append("debounced"))
    return calls


@pytest.fixture
def markers_at_wake(monkeypatch):
    """The sync worker's requeue markers as they stood when each wake fired."""
    from backend.app.api.routes import aito as aito_routes
    from backend.app.services.aito_quote_sync import _requeue_marker

    _requeue_marker.clear()
    seen: list[dict[int, int]] = []
    monkeypatch.setattr(aito_routes, "request_immediate_sync", lambda: seen.append(dict(_requeue_marker)))
    monkeypatch.setattr(aito_routes, "request_debounced_sync", lambda: seen.append(dict(_requeue_marker)))
    yield seen
    _requeue_marker.clear()


@pytest.mark.asyncio
async def test_both_cards_markers_are_bumped_before_the_wake(async_client, markers_at_wake):
    """A worker woken before the target's marker moved could capture the
    stale marker, push, and settle the target idle over an edit it never
    saw. Both bumps land before the wake, for a split and for a move."""
    from backend.app.services.aito_quote_sync import _requeue_marker

    source = await _create_with_tasks(async_client, TASKS)
    target = await _create_with_tasks(async_client, [])
    ids = [t["id"] for t in await _tasks(async_client, source["id"])]

    markers_at_wake.clear()
    resp = await _transfer(async_client, source["id"], [ids[0]], None)
    assert resp.status_code == 200
    split_id = resp.json()["target"]["id"]
    assert markers_at_wake[-1].get(split_id) == _requeue_marker[split_id]
    assert markers_at_wake[-1].get(source["id"]) == _requeue_marker[source["id"]]

    markers_at_wake.clear()
    assert (await _transfer(async_client, source["id"], [ids[1]], target["id"])).status_code == 200
    assert markers_at_wake[-1].get(target["id"]) == _requeue_marker[target["id"]]
    assert markers_at_wake[-1].get(source["id"]) == _requeue_marker[source["id"]]


@pytest.mark.asyncio
async def test_a_merges_source_marker_is_bumped_before_the_wake(async_client, db_session, markers_at_wake):
    from backend.app.models.aito_project import AitoProject
    from backend.app.services.aito_quote_sync import _requeue_marker
    from backend.tests.unit.test_aito_merge import _merge

    target = await _create_with_tasks(async_client, TASKS[:1])
    source = await _create_with_tasks(async_client, TASKS[1:])
    markers_at_wake.clear()
    assert (await _merge(async_client, target["id"], source["id"])).status_code == 200
    row = await db_session.get(AitoProject, source["id"])
    await db_session.refresh(row)
    assert row.quote_sync_state == "pending"
    assert markers_at_wake[-1].get(source["id"]) == _requeue_marker[source["id"]]


@pytest.mark.asyncio
async def test_a_split_wakes_the_worker_immediately_and_a_move_debounces(async_client, wakes):
    """A split card is a brand-new card that owes Books an estimate — the same
    latency case as create_project. A move is an edit, so it keeps the window."""
    source = await _create_with_tasks(async_client, TASKS)
    target = await _create_with_tasks(async_client, [])
    ids = [t["id"] for t in await _tasks(async_client, source["id"])]

    wakes.clear()
    assert (await _transfer(async_client, source["id"], [ids[0]], None)).status_code == 200
    assert wakes == ["immediate"]

    wakes.clear()
    assert (await _transfer(async_client, source["id"], [ids[1]], target["id"])).status_code == 200
    assert wakes == ["debounced"]


async def _tasks_as(client, project_id, headers):
    resp = await client.get(f"/api/v1/aito/{project_id}/tasks", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.mark.asyncio
async def test_a_split_needs_aito_create(async_client, db_session):
    """Splitting creates a card, so update alone is not enough; a move onto an
    existing card creates nothing and is allowed with update alone."""
    from backend.app.core.auth import create_access_token
    from backend.app.models.settings import Settings
    from backend.tests.unit.test_inbox_service import _user

    source = await _create_with_tasks(async_client, TASKS)
    target = await _create_with_tasks(async_client, [])
    ids = [t["id"] for t in await _tasks(async_client, source["id"])]
    editor = await _user(db_session, "editor", ("aito:read", "aito:update"))
    db_session.add(Settings(key="auth_enabled", value="true"))
    await db_session.commit()
    headers = {"Authorization": f"Bearer {create_access_token(data={'sub': editor.username})}"}
    url = f"/api/v1/aito/{source['id']}/tasks/transfer"

    resp = await async_client.post(url, json={"task_ids": [ids[0]], "target_project_id": None}, headers=headers)
    assert resp.status_code == 403, resp.text
    assert "aito:create" in resp.json()["detail"]
    assert [t["id"] for t in await _tasks_as(async_client, source["id"], headers)] == ids

    resp = await async_client.post(url, json={"task_ids": [ids[0]], "target_project_id": target["id"]}, headers=headers)
    assert resp.status_code == 200, resp.text


@pytest.mark.asyncio
async def test_a_trashed_card_on_either_side_is_a_404(async_client):
    source = await _create_with_tasks(async_client, TASKS)
    trashed_target = await _create_with_tasks(async_client, [{"title": "T", "scan_cost": 1}])
    ids = [t["id"] for t in await _tasks(async_client, source["id"])]
    assert (await async_client.delete(f"/api/v1/aito/{trashed_target['id']}")).status_code == 204
    assert (await _transfer(async_client, source["id"], [ids[0]], trashed_target["id"])).status_code == 404
    assert [t["id"] for t in await _tasks(async_client, source["id"])] == ids

    live_target = await _create_with_tasks(async_client, [])
    assert (await async_client.delete(f"/api/v1/aito/{source['id']}")).status_code == 204
    assert (await _transfer(async_client, source["id"], [ids[0]], live_target["id"])).status_code == 404
    assert (await _transfer(async_client, source["id"], [ids[0]], None)).status_code == 404
    assert await _tasks(async_client, live_target["id"]) == []
