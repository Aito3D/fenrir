"""PUT /aito/{project_id}/transfer-client: re-point a card at another contact."""

import pytest

from backend.tests.unit.test_aito_merge import _create_with_tasks, _set_invoiced

NEW = {
    "client_id": "z9",
    "client_name": "PACIFIC MARINE",
    "client_phone": "40 00 00 00",
    "client_email": "pm@x.pf",
    "client_is_company": True,
    "client_contact_person_id": "cp1",
}


@pytest.mark.asyncio
async def test_transfer_rewrites_the_client_and_clears_the_social_handle(async_client):
    p = await _create_with_tasks(async_client, [], client_social_network="instagram", client_social_handle="@old")
    resp = await async_client.put(f"/api/v1/aito/{p['id']}/transfer-client", json=NEW)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["client_id"] == "z9" and body["client_name"] == "PACIFIC MARINE"
    assert body["client_email"] == "pm@x.pf" and body["client_is_company"] is True
    assert body["client_contact_person_id"] == "cp1"
    assert body["client_social_handle"] is None and body["client_social_network"] is None
    assert body["quote_sync_state"] == "pending"
    events = (await async_client.get(f"/api/v1/aito/{p['id']}/events")).json()["events"]
    moved = [e for e in events if e["kind"] == "client.transferred"]
    assert moved[0]["detail"] == {"from_id": "z1", "from_name": "ACME", "to_id": "z9", "to_name": "PACIFIC MARINE"}


@pytest.mark.asyncio
async def test_transfer_keeps_the_quote_status(async_client):
    p = await _create_with_tasks(async_client, [{"title": "A", "scan_cost": 1}])
    assert (await async_client.post(f"/api/v1/aito/{p['id']}/quote-status", json={"status": "sent"})).status_code == 200
    resp = await async_client.put(f"/api/v1/aito/{p['id']}/transfer-client", json=NEW)
    assert resp.json()["quote_status"] == "sent"


@pytest.mark.asyncio
async def test_same_client_is_a_silent_no_op(async_client):
    p = await _create_with_tasks(async_client, [])
    before = len((await async_client.get(f"/api/v1/aito/{p['id']}/events")).json()["events"])
    resp = await async_client.put(
        f"/api/v1/aito/{p['id']}/transfer-client", json={"client_id": "z1", "client_name": "ACME"}
    )
    assert resp.status_code == 200
    assert len((await async_client.get(f"/api/v1/aito/{p['id']}/events")).json()["events"]) == before


@pytest.mark.asyncio
async def test_transfer_refusals(async_client, db_session):
    p = await _create_with_tasks(async_client, [])
    assert (await async_client.put("/api/v1/aito/999999/transfer-client", json=NEW)).status_code == 404
    url = f"/api/v1/aito/{p['id']}/transfer-client"
    assert (await async_client.put(url, json={**NEW, "client_name": ""})).status_code == 422
    assert (await async_client.put(url, json={**NEW, "client_email": "x" * 201})).status_code == 422
    await _set_invoiced(db_session, p["id"])
    assert (await async_client.put(url, json=NEW)).status_code == 409
    assert (await async_client.get("/api/v1/aito/")).json()[0]["client_id"] == "z1"
