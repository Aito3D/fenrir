"""An invoiced project's tasks are frozen.

Once Books has billed the estimate, the quote's content is accounting: adding,
editing, removing or reordering a task would re-push a document Books refuses
to change, and the card would only ever land on a sync error. The panel greys
its controls out for the same reason, but a rule that lives in a button is a
convention, not a rule — so the four task writes refuse here too.

Ticks are the one exception. Reaching Done requires the invoice to exist
first, so marking steps done AFTER invoicing is the normal flow, and a PATCH
that carries nothing but done flags must still pass.
"""

import pytest
from sqlalchemy import update

from backend.app.models.aito_project import AitoProject

REFUSAL = "This project has been invoiced — its tasks can no longer be changed"


async def _create_accepted_with_tasks(client, n=2):
    payload = {
        "description": "Support GoPro",
        "client_id": "z1",
        "client_name": "ACME",
        "client_phone": "+33 6 12 34 56 78",
        "quote_id": "E1",
        "quote_number": "DEV26-1",
        "tasks": [{"title": f"T{i}", "scan_cost": 1000 + i} for i in range(n)],
    }
    created = (await client.post("/api/v1/aito/", json=payload)).json()
    accepted = await client.post(f"/api/v1/aito/{created['id']}/quote-status", json={"status": "accepted"})
    return accepted.json()["project"]


async def _set_invoiced(db_session, project_id: int) -> None:
    async with db_session.begin_nested():
        await db_session.execute(update(AitoProject).where(AitoProject.id == project_id).values(quote_invoiced=True))
    await db_session.commit()


async def _task_ids(client, project_id):
    resp = await client.get(f"/api/v1/aito/{project_id}/tasks")
    assert resp.status_code == 200
    return [t["id"] for t in resp.json()]


@pytest.mark.asyncio
async def test_add_task_is_refused_on_an_invoiced_project(async_client, db_session):
    p = await _create_accepted_with_tasks(async_client)
    await _set_invoiced(db_session, p["id"])

    r = await async_client.post(f"/api/v1/aito/{p['id']}/tasks", json={"title": "Late", "scan_cost": 500})

    assert r.status_code == 409
    assert r.json()["detail"] == REFUSAL
    assert len(await _task_ids(async_client, p["id"])) == 2


@pytest.mark.asyncio
async def test_delete_task_is_refused_on_an_invoiced_project(async_client, db_session):
    p = await _create_accepted_with_tasks(async_client)
    ids = await _task_ids(async_client, p["id"])
    await _set_invoiced(db_session, p["id"])

    r = await async_client.delete(f"/api/v1/aito/tasks/{ids[0]}")

    assert r.status_code == 409
    assert r.json()["detail"] == REFUSAL
    assert await _task_ids(async_client, p["id"]) == ids


@pytest.mark.asyncio
async def test_reorder_is_refused_on_an_invoiced_project(async_client, db_session):
    p = await _create_accepted_with_tasks(async_client)
    ids = await _task_ids(async_client, p["id"])
    await _set_invoiced(db_session, p["id"])

    r = await async_client.patch(f"/api/v1/aito/{p['id']}/tasks/reorder", json={"task_ids": list(reversed(ids))})

    assert r.status_code == 409
    assert r.json()["detail"] == REFUSAL
    assert await _task_ids(async_client, p["id"]) == ids


@pytest.mark.asyncio
async def test_editing_a_task_field_is_refused_on_an_invoiced_project(async_client, db_session):
    p = await _create_accepted_with_tasks(async_client)
    ids = await _task_ids(async_client, p["id"])
    await _set_invoiced(db_session, p["id"])

    for body in ({"title": "Renamed"}, {"scan_cost": 9999}, {"scan_cost": None}, {"scan_done": True, "title": "x"}):
        r = await async_client.patch(f"/api/v1/aito/tasks/{ids[0]}", json=body)
        assert r.status_code == 409, (body, r.text)
        assert r.json()["detail"] == REFUSAL

    task = (await async_client.get(f"/api/v1/aito/{p['id']}/tasks")).json()[0]
    assert task["title"] == "T0"
    assert task["scan_cost"] == 1000
    assert task["scan_done"] is False


@pytest.mark.asyncio
async def test_ticking_a_step_still_works_on_an_invoiced_project(async_client, db_session):
    """Done flags are progress, not quote content: the invoice comes BEFORE
    the last steps are ticked on the way to Done, so a tick-only PATCH must
    pass — and so must the untick that undoes it."""
    p = await _create_accepted_with_tasks(async_client)
    ids = await _task_ids(async_client, p["id"])
    await _set_invoiced(db_session, p["id"])

    r = await async_client.patch(f"/api/v1/aito/tasks/{ids[0]}", json={"scan_done": True})
    assert r.status_code == 200, r.text
    assert r.json()["scan_done"] is True

    r = await async_client.patch(f"/api/v1/aito/tasks/{ids[0]}", json={"scan_done": False})
    assert r.status_code == 200, r.text
    assert r.json()["scan_done"] is False


@pytest.mark.asyncio
async def test_a_locked_but_uninvoiced_project_stays_editable(async_client, db_session):
    """The OTHER lock — a push Books refused (tax-exclusive estimate) — is
    the operator's to fix and force-sync, so its tasks stay open. Only the
    invoice freezes them."""
    p = await _create_accepted_with_tasks(async_client)
    ids = await _task_ids(async_client, p["id"])
    async with db_session.begin_nested():
        await db_session.execute(
            update(AitoProject).where(AitoProject.id == p["id"]).values(quote_sync_state="locked", quote_invoiced=False)
        )
    await db_session.commit()

    r = await async_client.patch(f"/api/v1/aito/tasks/{ids[0]}", json={"title": "Still mine"})
    assert r.status_code == 200, r.text
    r = await async_client.post(f"/api/v1/aito/{p['id']}/tasks", json={"title": "Late", "scan_cost": 500})
    assert r.status_code == 201, r.text
