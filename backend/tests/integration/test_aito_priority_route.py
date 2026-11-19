"""Project priority level: create default, its own PATCH route, one story event
per real change, quote marked pending, 409 once invoiced."""

import pytest
from sqlalchemy import select

from backend.app.models.aito_project import AitoProject


async def _create(client, **overrides):
    payload = {
        "description": "Support GoPro",
        "client_id": "z1",
        "client_name": "ACME",
        "client_phone": "+33 6 12 34 56 78",
    }
    payload.update(overrides)
    return await client.post("/api/v1/aito/", json=payload)


async def _row(db_session, project_id):
    db_session.expire_all()
    return (await db_session.execute(select(AitoProject).where(AitoProject.id == project_id))).scalar_one()


@pytest.mark.asyncio
async def test_create_defaults_to_normal(async_client):
    r = await _create(async_client)
    assert r.status_code == 201
    assert r.json()["priority"] == "normal"


@pytest.mark.asyncio
async def test_create_with_urgent_persists(async_client):
    r = await _create(async_client, priority="urgent")
    assert r.json()["priority"] == "urgent"
    assert (await async_client.get("/api/v1/aito/")).json()[0]["priority"] == "urgent"


@pytest.mark.asyncio
async def test_patch_sets_priority_one_event_and_marks_pending(async_client, db_session):
    project_id = (await _create(async_client)).json()["id"]
    row = await _row(db_session, project_id)
    row.quote_id = "q1"
    row.quote_sync_state = "idle"
    await db_session.commit()
    url = f"/api/v1/aito/{project_id}/priority"

    r = await async_client.patch(url, json={"priority": "priority"})
    assert r.status_code == 200, r.text
    assert r.json()["priority"] == "priority"
    assert (await _row(db_session, project_id)).quote_sync_state == "pending"

    row = await _row(db_session, project_id)
    row.quote_sync_state = "idle"
    await db_session.commit()
    assert (await async_client.patch(url, json={"priority": "priority"})).status_code == 200  # no-op
    assert (await _row(db_session, project_id)).quote_sync_state == "idle"

    events = (await async_client.get(f"/api/v1/aito/{project_id}/events?depth=story")).json()["events"]
    sets = [e for e in events if e["kind"] == "project.priority.set"]
    assert len(sets) == 1
    assert sets[0]["changes"] == [{"field": "priority", "from": "normal", "to": "priority"}]


@pytest.mark.asyncio
async def test_patch_rejects_unknown_level(async_client):
    project_id = (await _create(async_client)).json()["id"]
    r = await async_client.patch(f"/api/v1/aito/{project_id}/priority", json={"priority": "rush"})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_patch_on_invoiced_project_is_409(async_client, db_session):
    project_id = (await _create(async_client)).json()["id"]
    row = await _row(db_session, project_id)
    row.quote_invoiced = True
    await db_session.commit()
    r = await async_client.patch(f"/api/v1/aito/{project_id}/priority", json={"priority": "urgent"})
    assert r.status_code == 409
