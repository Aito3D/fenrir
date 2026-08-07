"""aito_projects.version: a content-fields revision counter.

Bumps ONLY when a field the detail panel edits (description / client_* /
shipping_*) actually changes — background writers (sync-state flips, rule
moves, flag toggles) must NOT bump it, or every open panel would false-409
the moment the sync worker ticked. See VERSIONED_FIELDS on the model.
"""

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
