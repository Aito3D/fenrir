"""aito_projects.version: a content-fields revision counter.

Bumps ONLY when a field the detail panel edits (description / client_* /
shipping_*) actually changes — background writers (sync-state flips, rule
moves, flag toggles) must NOT bump it, or every open panel would false-409
the moment the sync worker ticked. See VERSIONED_FIELDS on the model.
"""

from datetime import datetime

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


@pytest.mark.asyncio
async def test_new_project_starts_at_version_zero(async_client):
    created = (await _create(async_client)).json()
    assert created["version"] == 0
    board = (await async_client.get("/api/v1/aito/")).json()
    assert board[0]["version"] == 0


@pytest.mark.asyncio
async def test_content_edit_bumps_version(async_client):
    project_id = (await _create(async_client)).json()["id"]
    updated = (await async_client.patch(f"/api/v1/aito/{project_id}", json={"description": "New description"})).json()
    assert updated["version"] == 1
    again = (await async_client.patch(f"/api/v1/aito/{project_id}", json={"client_phone": "+689 87 11 22 33"})).json()
    assert again["version"] == 2


@pytest.mark.asyncio
async def test_no_op_content_edit_does_not_bump(async_client):
    project_id = (await _create(async_client)).json()["id"]
    updated = (await async_client.patch(f"/api/v1/aito/{project_id}", json={"description": "Support GoPro"})).json()
    assert updated["version"] == 0


@pytest.mark.asyncio
async def test_flag_toggle_does_not_bump(async_client, db_session):
    project_id = (await _create(async_client)).json()["id"]
    updated = (await async_client.patch(f"/api/v1/aito/{project_id}/flag", json={"flag": "urgent"})).json()
    assert updated["version"] == 0
    row = (await db_session.execute(select(AitoProject).where(AitoProject.id == project_id))).scalar_one()
    assert row.flag == "urgent"


@pytest.mark.asyncio
async def test_quote_status_change_does_not_bump(async_client):
    project_id = (await _create(async_client)).json()["id"]
    response = await async_client.post(f"/api/v1/aito/{project_id}/quote-status", json={"status": "sent"})
    assert response.status_code == 200
    assert response.json()["project"]["version"] == 0


@pytest.mark.asyncio
async def test_stale_expected_version_conflicts(async_client):
    project_id = (await _create(async_client)).json()["id"]
    first = await async_client.patch(
        f"/api/v1/aito/{project_id}", json={"description": "Operator A's edit", "expected_version": 0}
    )
    assert first.status_code == 200
    assert first.json()["version"] == 1

    second = await async_client.patch(
        f"/api/v1/aito/{project_id}", json={"description": "Operator B's edit", "expected_version": 0}
    )
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "version_conflict"
    # The losing write must not have landed.
    board = (await async_client.get("/api/v1/aito/")).json()
    assert board[0]["description"] == "Operator A's edit"


@pytest.mark.asyncio
async def test_matching_expected_version_passes(async_client):
    project_id = (await _create(async_client)).json()["id"]
    response = await async_client.patch(
        f"/api/v1/aito/{project_id}", json={"description": "fresh edit", "expected_version": 0}
    )
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_omitted_expected_version_skips_the_check(async_client):
    """API-key/scripted callers that never learned the version keep working."""
    project_id = (await _create(async_client)).json()["id"]
    await async_client.patch(f"/api/v1/aito/{project_id}", json={"description": "one", "expected_version": 0})
    response = await async_client.patch(f"/api/v1/aito/{project_id}", json={"description": "two"})
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_racing_writers_only_the_loser_gets_409(async_client, monkeypatch):
    """T-046: the guard has to be atomic with the write, not a plain SELECT
    evaluated long before it — a shipping PATCH sits behind a live Zoho
    catalogue fetch (`_shipping_rates`) between the original top-of-function
    compare and the actual write.

    Driven DETERMINISTICALLY, not by timing: this patches the catalogue
    fetch to itself commit operator B's competing edit — using the exact
    `db` session `update_project` already holds, exactly as if another
    request's own `_commit_and_wake` had already landed while this request
    was stalled on Zoho — and let that commit complete before returning
    rates back to operator A. (A true two-connection race can't be driven
    deterministically over the test harness's single in-memory SQLite
    connection; committing the competing write through the same session
    still exercises the real thing this task is about — an atomic,
    live-against-the-database compare, not a Python-side snapshot taken
    before the fetch.) Operator A read version 0 and passed the fast
    top-of-function compare same as B would have; by the time A's request
    reaches the atomic re-check, right after the catalogue fetch, the row
    is genuinely at version 1 — so A's claim on version 0 must fail.
    """
    from sqlalchemy import select

    from backend.app.models.aito_project import AitoProject
    from backend.app.services.aito_shipping import ShippingItem
    from backend.app.services.zoho import zoho_service

    project_id = (await _create(async_client)).json()["id"]

    async def fake_catalogue(db, **kwargs):
        row = (await db.execute(select(AitoProject).where(AitoProject.id == project_id))).scalar_one()
        row.description = "Operator B's edit"
        await db.commit()
        assert row.version == 1
        return {"tuamotu": ShippingItem(item_id="SHIP-TU", name="Livraison Avion Tuamotu", rate=3200.0)}

    # Instance-level, not class-level — see test_aito_shipping_routes.py's
    # resolved_catalogue fixture for why.
    monkeypatch.setattr(zoho_service, "get_shipping_catalogue", fake_catalogue)

    loser = await async_client.patch(
        f"/api/v1/aito/{project_id}",
        json={
            "expected_version": 0,
            "shipping_island": "rangiroa",
            "shipping_first_name": "Jean-Pierre",
            "shipping_last_name": "DUPONT",
            "shipping_phone": "+689-89645864",
        },
    )
    assert loser.status_code == 409
    assert loser.json()["detail"]["code"] == "version_conflict"

    board = (await async_client.get("/api/v1/aito/")).json()
    assert board[0]["description"] == "Operator B's edit"
    assert board[0]["version"] == 1
    # The loser's shipping payload must not have landed either.
    assert board[0]["shipping_island"] is None


async def _set_updated_at(db_session, project_id: int, when: datetime) -> None:
    """Stamps `updated_at` to a known sentinel via a real ORM assignment (not
    the guard's raw Core UPDATE), so a later read can distinguish "the claim
    touched this row" from "nothing touched this row" without depending on
    wall-clock timing or SQLite's one-second CURRENT_TIMESTAMP resolution.
    An explicit ORM-level assignment lands in the flush's own SET clause, so
    it is not itself subject to the column's `onupdate` default."""
    row = (await db_session.execute(select(AitoProject).where(AitoProject.id == project_id))).scalar_one()
    row.updated_at = when
    await db_session.commit()


async def _updated_at(db_session, project_id: int) -> datetime:
    db_session.expire_all()
    row = (await db_session.execute(select(AitoProject).where(AitoProject.id == project_id))).scalar_one()
    return row.updated_at


@pytest.mark.asyncio
async def test_guarded_noop_patch_does_not_bump_updated_at(async_client, db_session):
    """The atomic claim's SET clause has to be a genuine no-op. `updated_at`
    carries `onupdate=func.now()`, and SQLAlchemy Core auto-appends a
    column's `onupdate` default to a statement's SET clause whenever that
    column is absent from `.values()` — so a claim that only self-assigned
    `version` was silently also writing `updated_at = now()` on every
    guarded PATCH, including a no-op one that changes no VERSIONED_FIELDS
    and so must NOT move `updated_at` (`updated_at` orders Done/Trash and
    drives the card's displayed age — see routes/aito.py:749 and
    schemas/aito.py's AitoProjectResponse). Pinning `updated_at` in the
    claim's own `.values()` closes that.
    """
    sentinel = datetime(2020, 1, 1, 0, 0, 0)
    project_id = (await _create(async_client)).json()["id"]
    await _set_updated_at(db_session, project_id, sentinel)

    # Re-sends the description already stored: no VERSIONED_FIELDS change,
    # so version correctly stays put -- and now updated_at must too.
    response = await async_client.patch(
        f"/api/v1/aito/{project_id}", json={"description": "Support GoPro", "expected_version": 0}
    )
    assert response.status_code == 200
    assert response.json()["version"] == 0

    assert await _updated_at(db_session, project_id) == sentinel


@pytest.mark.asyncio
async def test_guarded_real_edit_still_bumps_updated_at(async_client, db_session):
    """Companion to the no-op case above, pinning the other direction: a
    guarded PATCH that DOES change a versioned field must still move both
    `version` and `updated_at`, through the normal ORM flush that follows
    the claim — the claim's pinned SET must suppress `onupdate` only for
    itself, not for the real write."""
    sentinel = datetime(2020, 1, 1, 0, 0, 0)
    project_id = (await _create(async_client)).json()["id"]
    await _set_updated_at(db_session, project_id, sentinel)

    response = await async_client.patch(
        f"/api/v1/aito/{project_id}", json={"description": "New description", "expected_version": 0}
    )
    assert response.status_code == 200
    assert response.json()["version"] == 1

    assert await _updated_at(db_session, project_id) > sentinel
