"""Every mutation route leaves a trace, and a no-op leaves none."""

import pytest
from sqlalchemy import select

from backend.app.models.aito_event import AitoEvent


async def _kinds(db_session, project_id: int) -> list[str]:
    rows = (
        (
            await db_session.execute(
                select(AitoEvent.kind).where(AitoEvent.project_id == project_id).order_by(AitoEvent.id)
            )
        )
        .scalars()
        .all()
    )
    return list(rows)


def _project_payload(**overrides):
    payload = {
        "description": "Trophy",
        "client_id": "z1",
        "client_name": "ACME",
        "client_phone": "+689-87000009",
    }
    payload.update(overrides)
    return payload


@pytest.mark.asyncio
async def test_creating_a_project_records_it(async_client, db_session):
    response = await async_client.post("/api/v1/aito/", json=_project_payload())
    assert response.status_code == 201
    project_id = response.json()["id"]

    assert "project.created" in await _kinds(db_session, project_id)


@pytest.mark.asyncio
async def test_adding_a_task_records_it(async_client, db_session):
    project_id = (await async_client.post("/api/v1/aito/", json=_project_payload())).json()["id"]
    response = await async_client.post(f"/api/v1/aito/{project_id}/tasks", json={"title": "Socle"})
    assert response.status_code == 201

    assert "task.added" in await _kinds(db_session, project_id)


@pytest.mark.asyncio
async def test_a_patch_that_changes_nothing_records_nothing(async_client, db_session):
    """TaskEditor saves on row blur, so tabbing through a task without editing
    it must stay silent or the timeline fills with non-events."""
    project_id = (await async_client.post("/api/v1/aito/", json=_project_payload())).json()["id"]
    task_id = (await async_client.post(f"/api/v1/aito/{project_id}/tasks", json={"title": "Socle"})).json()["id"]

    before = await _kinds(db_session, project_id)
    await async_client.patch(f"/api/v1/aito/tasks/{task_id}", json={"title": "Socle"})
    assert await _kinds(db_session, project_id) == before


@pytest.mark.asyncio
async def test_editing_a_task_records_the_diff(async_client, db_session):
    project_id = (await async_client.post("/api/v1/aito/", json=_project_payload())).json()["id"]
    task_id = (await async_client.post(f"/api/v1/aito/{project_id}/tasks", json={"title": "Socle"})).json()["id"]

    await async_client.patch(f"/api/v1/aito/tasks/{task_id}", json={"title": "Socle v2"})

    event = (
        await db_session.execute(
            select(AitoEvent)
            .where(AitoEvent.project_id == project_id, AitoEvent.kind == "task.updated")
            .order_by(AitoEvent.id.desc())
            .limit(1)
        )
    ).scalar_one()
    assert {"field": "title", "from": "Socle", "to": "Socle v2"} in event.changes


@pytest.mark.asyncio
async def test_marking_a_quote_sent_records_it(async_client, db_session):
    project_id = (await async_client.post("/api/v1/aito/", json=_project_payload())).json()["id"]

    await async_client.post(f"/api/v1/aito/{project_id}/quote-status", json={"status": "sent"})

    assert "quote.sent" in await _kinds(db_session, project_id)


@pytest.mark.asyncio
async def test_trashing_and_restoring_are_both_recorded(async_client, db_session):
    project_id = (await async_client.post("/api/v1/aito/", json=_project_payload())).json()["id"]

    await async_client.delete(f"/api/v1/aito/{project_id}")
    await async_client.post(f"/api/v1/aito/{project_id}/restore")

    kinds = await _kinds(db_session, project_id)
    assert "project.trashed" in kinds
    assert "project.restored" in kinds


@pytest.mark.asyncio
async def test_clearing_a_cost_records_the_implicit_untick(async_client, db_session):
    """The SERVICES normalization loop in update_task force-clears a *_done
    flag when its cost is cleared to null. That flip never appears in the
    request body, but it can still move the board via _apply_rules, so it
    must leave a task.step.unticked event just like an explicit untick would."""
    project_id = (await async_client.post("/api/v1/aito/", json=_project_payload(quote_status="accepted"))).json()["id"]
    task_id = (
        await async_client.post(f"/api/v1/aito/{project_id}/tasks", json={"title": "Socle", "scan_cost": 1200.0})
    ).json()["id"]
    await async_client.patch(f"/api/v1/aito/tasks/{task_id}", json={"scan_done": True})

    response = await async_client.patch(f"/api/v1/aito/tasks/{task_id}", json={"scan_cost": None})
    assert response.status_code == 200

    event = (
        await db_session.execute(
            select(AitoEvent)
            .where(
                AitoEvent.project_id == project_id,
                AitoEvent.kind == "task.step.unticked",
                AitoEvent.subject_id == task_id,
            )
            .order_by(AitoEvent.id.desc())
            .limit(1)
        )
    ).scalar_one()
    assert event.detail["service"] == "scan"


@pytest.mark.asyncio
async def test_the_actor_is_recorded_as_none_when_auth_is_disabled(async_client, db_session):
    """Matches created_by's existing rule: no user, no name, and saying so is
    information rather than a gap."""
    project_id = (await async_client.post("/api/v1/aito/", json=_project_payload())).json()["id"]

    event = (
        await db_session.execute(
            select(AitoEvent).where(AitoEvent.project_id == project_id, AitoEvent.kind == "project.created")
        )
    ).scalar_one()
    assert event.actor_name is None
    assert event.actor_class == "user"
