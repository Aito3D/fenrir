"""Reading the timeline, and the one thing a client may write to it."""

from datetime import datetime

import pytest
from sqlalchemy import select

from backend.app.models.aito_event import AitoEvent


async def _create(client, **overrides):
    payload = {
        "description": "Trophy",
        "client_id": "z1",
        "client_name": "ACME",
        "client_phone": "+689 87 00 00 10",
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

    last = first["events"][-1]
    cursor_id, cursor_at = last["id"], last["occurred_at"]
    second = (
        await async_client.get(
            f"/api/v1/aito/{project_id}/events",
            params={"depth": "detail", "limit": 2, "before": cursor_id, "before_at": cursor_at},
        )
    ).json()
    assert all(e["id"] < cursor_id for e in second["events"])


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


@pytest.mark.asyncio
async def test_a_backfilled_old_timestamp_high_id_event_is_still_reachable(async_client, db_session):
    """The backfill migration (_backfill_aito_events in core/database.py) gives
    a pre-existing project's synthesised 'project.created' row a freshly
    assigned HIGH id but an OLD occurred_at (the project's own created_at,
    possibly years before any organic event). Paging on `id < before` alone
    treats id as a stand-in for the compound (occurred_at, id) sort order —
    which only holds when the two agree. They do not here: the cursor only
    ever shrinks past the high id, so the old row can never come up. This
    walks the WHOLE timeline with a tiny page size and asserts the
    old-timestamp/high-id row is among what came back.
    """
    project_id = (await _create(async_client)).json()["id"]
    for n in range(3):
        await async_client.post(f"/api/v1/aito/{project_id}/tasks", json={"title": f"Task {n}"})

    # Inserted LAST, so autoincrement hands it the highest id in the project —
    # exactly what the backfill produces for a project older than this table.
    old_event = AitoEvent(
        project_id=project_id,
        occurred_at=datetime(2020, 1, 1),
        kind="project.created",
        actor_class="user",
        subject_type="project",
        subject_id=project_id,
    )
    db_session.add(old_event)
    await db_session.commit()
    await db_session.refresh(old_event)

    all_ids = set(
        (await db_session.execute(select(AitoEvent.id).where(AitoEvent.project_id == project_id))).scalars().all()
    )
    assert old_event.id == max(all_ids), "test setup bug: the old event must have the HIGHEST id"

    collected_ids: list[int] = []
    cursor: dict = {}
    for _ in range(20):  # generous cap; this timeline pages out in 3 rounds
        page = (
            await async_client.get(
                f"/api/v1/aito/{project_id}/events", params={"depth": "everything", "limit": 2, **cursor}
            )
        ).json()
        collected_ids.extend(e["id"] for e in page["events"])
        if not page["has_more"]:
            break
        last = page["events"][-1]
        cursor = {"before": last["id"], "before_at": last["occurred_at"]}
    else:
        pytest.fail("Paged 20 times without has_more going False — possible infinite loop")

    assert old_event.id in collected_ids


@pytest.mark.asyncio
async def test_a_lone_cursor_half_is_rejected(async_client):
    """`before` and `before_at` are one cursor, not two independent filters —
    an id-only (or timestamp-only) cursor over the compound sort key is
    exactly the bug this pair replaces."""
    project_id = (await _create(async_client)).json()["id"]

    only_before = await async_client.get(f"/api/v1/aito/{project_id}/events", params={"before": 5})
    assert only_before.status_code == 422

    only_before_at = await async_client.get(
        f"/api/v1/aito/{project_id}/events", params={"before_at": "2024-01-01T00:00:00"}
    )
    assert only_before_at.status_code == 422


@pytest.mark.asyncio
async def test_paging_produces_no_duplicates_when_timestamps_tie(async_client, db_session):
    """Several events sharing one occurred_at (routine after a backfill, and
    possible any time two things happen in the same instant) must still page
    without a row appearing twice or going missing."""
    project_id = (await _create(async_client)).json()["id"]

    tied_at = datetime(2024, 6, 1, 12, 0, 0)
    tied_events = [
        AitoEvent(project_id=project_id, occurred_at=tied_at, kind="note.added", actor_class="user", note=f"note {n}")
        for n in range(5)
    ]
    db_session.add_all(tied_events)
    await db_session.commit()

    expected_ids = set(
        (await db_session.execute(select(AitoEvent.id).where(AitoEvent.project_id == project_id))).scalars().all()
    )
    assert len(expected_ids) == 6  # 1 project.created (from _create) + 5 tied notes

    collected_ids: list[int] = []
    cursor: dict = {}
    for _ in range(20):
        page = (
            await async_client.get(
                f"/api/v1/aito/{project_id}/events", params={"depth": "everything", "limit": 2, **cursor}
            )
        ).json()
        collected_ids.extend(e["id"] for e in page["events"])
        if not page["has_more"]:
            break
        last = page["events"][-1]
        cursor = {"before": last["id"], "before_at": last["occurred_at"]}
    else:
        pytest.fail("Paged 20 times without has_more going False — possible infinite loop")

    assert len(collected_ids) == len(set(collected_ids)), "duplicate ids across pages"
    assert set(collected_ids) == expected_ids
