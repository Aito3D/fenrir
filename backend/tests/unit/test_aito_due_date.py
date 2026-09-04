"""The promised delivery date: its own route (no Zoho push, no version
bump), one story event per real change, and overdue-first ordering."""

import pytest
from sqlalchemy import select

from backend.app.api.routes import aito as aito_routes
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


@pytest.fixture
def today(monkeypatch):
    monkeypatch.setattr(aito_routes, "_today_iso", lambda: "2026-09-10")
    return "2026-09-10"


@pytest.mark.asyncio
async def test_board_lists_overdue_cards_first_even_above_urgent(async_client, today):
    """Overdue outranks the flag tier; inside the overdue group the flag tier
    and stored position still hold. Due TODAY is not overdue."""
    a = (await _create(async_client, description="a")).json()
    b = (await _create(async_client, description="b")).json()
    _c = (await _create(async_client, description="c")).json()
    d = (await _create(async_client, description="d")).json()
    # Creation prepends: stored order is d, c, b, a.
    await async_client.patch(f"/api/v1/aito/{d['id']}/flag", json={"flag": "urgent"})
    await async_client.patch(f"/api/v1/aito/{a['id']}/due-date", json={"due_date": "2026-09-01"})
    await async_client.patch(f"/api/v1/aito/{b['id']}/due-date", json={"due_date": today})

    board = (await async_client.get("/api/v1/aito/")).json()
    devis = [p["description"] for p in board if p["column"] == "devis"]
    assert devis == ["a", "d", "c", "b"]


@pytest.mark.asyncio
async def test_finished_cards_never_rank_as_overdue(async_client, today):
    """A finished card's promise is moot for ordering: it does not jump the
    Finish column, and the card paints no badge there either.

    A task-less project created already `accepted` lands in Finish via
    `_apply_rules`, which APPENDS to the end of the destination column (see
    its docstring) — unlike a fresh `devis` card, which is prepended. So
    `other` (created first) holds position 0 and `late` (created second)
    holds position 1 — `late` already sorts after `other` on position alone.
    The point of this test is that giving `late` a past due date must NOT
    additionally promote it to the front of Finish."""
    _other = (await _create(async_client, description="other", quote_id="Q1", quote_status="accepted")).json()
    late = (await _create(async_client, description="late", quote_id="Q2", quote_status="accepted")).json()
    await async_client.patch(f"/api/v1/aito/{late['id']}/due-date", json={"due_date": "2026-09-01"})
    board = (await async_client.get("/api/v1/aito/")).json()
    finish = [p["description"] for p in board if p["column"] == "finish"]
    assert finish == ["other", "late"]


@pytest.mark.asyncio
async def test_move_keeps_the_overdue_card_on_top_of_its_destination(async_client, today):
    first = (await _create(async_client, description="first")).json()
    second = (await _create(async_client, description="second")).json()
    _third = (await _create(async_client, description="third")).json()
    await async_client.patch(f"/api/v1/aito/{first['id']}/due-date", json={"due_date": "2026-09-01"})
    # Displayed: first (overdue), third, second. Drop `second` at index 0 —
    # it must land right after the overdue card, never above it.
    r = await async_client.patch(f"/api/v1/aito/{second['id']}/move", json={"column": "devis", "position": 0})
    assert r.status_code == 200, r.text
    board = (await async_client.get("/api/v1/aito/")).json()
    assert [p["description"] for p in board if p["column"] == "devis"] == ["first", "second", "third"]
