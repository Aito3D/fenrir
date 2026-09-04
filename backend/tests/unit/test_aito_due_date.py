"""The promised delivery date: its own route (no Zoho push, no version
bump), one story event per real change, and overdue-first ordering."""

import pytest
from sqlalchemy import select

from backend.app.models.aito_project import AitoProject
from backend.tests.unit.test_aito_contacted import _declared_permissions


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
async def test_new_projects_have_no_due_date(async_client):
    created = await _create(async_client)
    assert created.status_code == 201
    assert created.json()["due_date"] is None
    assert [p["due_date"] for p in (await async_client.get("/api/v1/aito/")).json()] == [None]


@pytest.mark.asyncio
async def test_due_date_sets_changes_and_clears_without_touching_sync_or_version(async_client, db_session):
    project_id = (await _create(async_client)).json()["id"]
    before = await _row(db_session, project_id)
    sync_before, version_before = before.quote_sync_state, before.version

    r = await async_client.patch(f"/api/v1/aito/{project_id}/due-date", json={"due_date": "2026-09-12"})
    assert r.status_code == 200, r.text
    assert r.json()["due_date"] == "2026-09-12"

    r = await async_client.patch(f"/api/v1/aito/{project_id}/due-date", json={"due_date": "2026-09-15"})
    assert r.json()["due_date"] == "2026-09-15"

    after = await _row(db_session, project_id)
    assert after.quote_sync_state == sync_before
    assert after.version == version_before

    r = await async_client.patch(f"/api/v1/aito/{project_id}/due-date", json={"due_date": None})
    assert r.status_code == 200
    assert r.json()["due_date"] is None


@pytest.mark.asyncio
async def test_due_date_records_one_story_event_per_real_change(async_client):
    project_id = (await _create(async_client)).json()["id"]
    url = f"/api/v1/aito/{project_id}/due-date"
    await async_client.patch(url, json={"due_date": "2026-09-12"})
    await async_client.patch(url, json={"due_date": "2026-09-12"})  # no-op
    await async_client.patch(url, json={"due_date": "2026-09-15"})  # change = ONE set, not clear+set
    await async_client.patch(url, json={"due_date": None})
    await async_client.patch(url, json={"due_date": None})  # no-op

    events = (await async_client.get(f"/api/v1/aito/{project_id}/events?depth=story")).json()["events"]
    due = [e for e in events if e["kind"].startswith("project.due.")]
    assert [e["kind"] for e in due] == ["project.due.cleared", "project.due.set", "project.due.set"]
    # Newest first. The change carries both sides so the timeline can say
    # what the promise was before it moved.
    assert due[1]["changes"] == [{"field": "due_date", "from": "2026-09-12", "to": "2026-09-15"}]
    assert due[0]["changes"] == [{"field": "due_date", "from": "2026-09-15", "to": None}]


@pytest.mark.asyncio
async def test_due_date_rejects_a_non_date_and_accepts_the_past(async_client):
    project_id = (await _create(async_client)).json()["id"]
    url = f"/api/v1/aito/{project_id}/due-date"
    assert (await async_client.patch(url, json={"due_date": "12/09/2026"})).status_code == 422
    assert (await async_client.patch(url, json={"due_date": "2026-02-30"})).status_code == 422
    # A promise already broken is still the promise.
    assert (await async_client.patch(url, json={"due_date": "2020-01-01"})).status_code == 200


@pytest.mark.asyncio
async def test_due_date_404s_on_a_trashed_project(async_client):
    project_id = (await _create(async_client)).json()["id"]
    await async_client.delete(f"/api/v1/aito/{project_id}")
    r = await async_client.patch(f"/api/v1/aito/{project_id}/due-date", json={"due_date": "2026-09-12"})
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_create_with_due_date_stores_it_and_records_the_set_after_created(async_client):
    created = await _create(async_client, due_date="2026-09-20")
    assert created.status_code == 201, created.text
    assert created.json()["due_date"] == "2026-09-20"
    events = (await async_client.get(f"/api/v1/aito/{created.json()['id']}/events?depth=story")).json()["events"]
    kinds = [e["kind"] for e in events]
    # Newest first: the set comes AFTER creation in time, so before it here.
    assert kinds.index("project.due.set") < kinds.index("project.created")


def test_due_date_route_is_gated_like_the_flag_route():
    assert _declared_permissions("set_project_due_date") == ["aito:update"]
    assert _declared_permissions("set_project_due_date") == _declared_permissions("set_project_flag")
