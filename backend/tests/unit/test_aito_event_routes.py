"""Reading the timeline, and the one thing a client may write to it."""

import pytest
from sqlalchemy import select

from backend.app.models.aito_event import AitoEvent


async def _create(client, **overrides):
    payload = {
        "description": "Trophy",
        "client_id": "z1",
        "client_name": "ACME",
    }
    payload.update(overrides)
    return await client.post("/api/v1/aito/", json=payload)


@pytest.mark.asyncio
async def test_story_depth_hides_edits_and_machine_traffic(async_client, db_session):
    project_id = (await _create(async_client)).json()["id"]
    task_id = (await async_client.post(f"/api/v1/aito/{project_id}/tasks", json={"title": "Socle"})).json()["id"]
    await async_client.patch(f"/api/v1/aito/tasks/{task_id}", json={"title": "Socle v2"})

    story = (await async_client.get(f"/api/v1/aito/{project_id}/events?depth=story")).json()
    kinds = [e["kind"] for e in story["events"]]
    assert "project.created" in kinds
    assert "task.updated" not in kinds

    detail = (await async_client.get(f"/api/v1/aito/{project_id}/events?depth=detail")).json()
    assert "task.updated" in [e["kind"] for e in detail["events"]]


@pytest.mark.asyncio
async def test_events_come_back_newest_first(async_client):
    project_id = (await _create(async_client)).json()["id"]
    await async_client.post(f"/api/v1/aito/{project_id}/tasks", json={"title": "Socle"})

    events = (await async_client.get(f"/api/v1/aito/{project_id}/events?depth=detail")).json()["events"]
    assert events[0]["kind"] == "task.added"


@pytest.mark.asyncio
async def test_the_cursor_pages_backwards(async_client):
    project_id = (await _create(async_client)).json()["id"]
    for n in range(5):
        await async_client.post(f"/api/v1/aito/{project_id}/tasks", json={"title": f"Task {n}"})

    first = (await async_client.get(f"/api/v1/aito/{project_id}/events?depth=detail&limit=2")).json()
    assert first["has_more"] is True

    cursor = first["events"][-1]["id"]
    second = (await async_client.get(f"/api/v1/aito/{project_id}/events?depth=detail&limit=2&before={cursor}")).json()
    assert all(e["id"] < cursor for e in second["events"])


@pytest.mark.asyncio
async def test_a_note_is_recorded_as_an_event(async_client, db_session):
    project_id = (await _create(async_client)).json()["id"]

    response = await async_client.post(f"/api/v1/aito/{project_id}/events", json={"note": "Called client, wants matte"})
    assert response.status_code == 201
    assert response.json()["kind"] == "note.added"
    assert response.json()["note"] == "Called client, wants matte"


@pytest.mark.asyncio
async def test_a_client_cannot_forge_an_event_kind(async_client, db_session):
    """The POST body accepts a note and nothing else. Anything that let a
    caller name the kind would let it fabricate 'quote.accepted'."""
    project_id = (await _create(async_client)).json()["id"]

    await async_client.post(
        f"/api/v1/aito/{project_id}/events",
        json={"note": "hi", "kind": "quote.accepted", "actor_class": "client"},
    )

    kinds = (await db_session.execute(select(AitoEvent.kind).where(AitoEvent.project_id == project_id))).scalars().all()
    assert "quote.accepted" not in kinds


@pytest.mark.asyncio
async def test_an_empty_note_is_rejected(async_client):
    project_id = (await _create(async_client)).json()["id"]
    response = await async_client.post(f"/api/v1/aito/{project_id}/events", json={"note": "   "})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_events_404_for_an_unknown_project(async_client):
    assert (await async_client.get("/api/v1/aito/99999/events")).status_code == 404
