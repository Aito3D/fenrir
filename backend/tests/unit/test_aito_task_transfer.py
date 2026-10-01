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
