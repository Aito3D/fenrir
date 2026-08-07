"""Every board mutation fans out one aito_changed message so other operators'
boards refetch. Best-effort: a broadcast failure never fails the request."""

from unittest.mock import AsyncMock

import pytest


async def _create(client, **overrides):
    payload = {
        "description": "Support GoPro",
        "client_id": "z1",
        "client_name": "ACME",
        "client_phone": "+33 6 12 34 56 78",
    }
    payload.update(overrides)
    return await client.post("/api/v1/aito/", json=payload)


@pytest.fixture
def broadcast(monkeypatch):
    spy = AsyncMock()
    monkeypatch.setattr("backend.app.api.routes.aito.ws_manager.broadcast", spy)
    return spy


def _actions(spy):
    return [call.args[0]["action"] for call in spy.await_args_list if call.args[0]["type"] == "aito_changed"]


@pytest.mark.asyncio
async def test_create_and_patch_broadcast(async_client, broadcast):
    project_id = (await _create(async_client)).json()["id"]
    await async_client.patch(f"/api/v1/aito/{project_id}", json={"description": "edited"})
    assert _actions(broadcast) == ["create", "update"]


@pytest.mark.asyncio
async def test_move_delete_restore_broadcast(async_client, broadcast):
    project_id = (await _create(async_client)).json()["id"]
    await async_client.patch(f"/api/v1/aito/{project_id}/move", json={"column": "devis", "position": 0})
    await async_client.delete(f"/api/v1/aito/{project_id}")
    await async_client.post(f"/api/v1/aito/{project_id}/restore")
    assert _actions(broadcast) == ["create", "move", "delete", "restore"]


@pytest.mark.asyncio
async def test_no_op_patch_does_not_broadcast(async_client, broadcast):
    project_id = (await _create(async_client)).json()["id"]
    # Same description the create call already stored — diff_fields sees no
    # change and _validated_shipping is never even reached (no shipping
    # column in the payload), so this must stay as silent as a repeated
    # quote-status transition.
    await async_client.patch(f"/api/v1/aito/{project_id}", json={"description": "Support GoPro"})
    assert _actions(broadcast) == ["create"]  # the no-op PATCH stayed silent


@pytest.mark.asyncio
async def test_no_op_quote_status_does_not_broadcast(async_client, broadcast, monkeypatch):
    from backend.app.services.zoho import zoho_service

    monkeypatch.setattr(zoho_service, "advance_estimate_status", AsyncMock())
    project_id = (await _create(async_client, quote_status="sent")).json()["id"]
    await async_client.post(f"/api/v1/aito/{project_id}/quote-status", json={"status": "accepted"})
    await async_client.post(f"/api/v1/aito/{project_id}/quote-status", json={"status": "accepted"})
    assert _actions(broadcast) == ["create", "quote-status"]  # the repeat stayed silent


@pytest.mark.asyncio
async def test_broadcast_failure_never_fails_the_request(async_client, monkeypatch):
    monkeypatch.setattr(
        "backend.app.api.routes.aito.ws_manager.broadcast", AsyncMock(side_effect=RuntimeError("ws down"))
    )
    response = await _create(async_client)
    assert response.status_code == 201
