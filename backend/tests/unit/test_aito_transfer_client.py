"""PUT /aito/{project_id}/transfer-client: re-point a card at another contact."""

import pytest
from sqlalchemy import select

from backend.app.models.aito_project import AitoProject
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
    """Same contact id: nothing is written, even when the rest of the body
    differs — the no-op is decided on `client_id` alone."""
    p = await _create_with_tasks(async_client, [], client_social_network="instagram", client_social_handle="@acme")
    fields = (
        "client_name",
        "client_phone",
        "client_email",
        "client_is_company",
        "client_contact_person_id",
        "client_social_network",
        "client_social_handle",
        "quote_sync_state",
    )
    before_card = await _card(async_client, p["id"])
    before = len((await async_client.get(f"/api/v1/aito/{p['id']}/events")).json()["events"])
    resp = await async_client.put(
        f"/api/v1/aito/{p['id']}/transfer-client",
        json={**NEW, "client_id": "z1", "client_name": "ACME RENAMED"},
    )
    assert resp.status_code == 200
    assert {f: resp.json()[f] for f in fields} == {f: before_card[f] for f in fields}
    assert resp.json()["client_name"] == "ACME"
    after_card = await _card(async_client, p["id"])
    assert {f: after_card[f] for f in fields} == {f: before_card[f] for f in fields}
    assert len((await async_client.get(f"/api/v1/aito/{p['id']}/events")).json()["events"]) == before


@pytest.mark.asyncio
async def test_a_trashed_card_is_a_404(async_client, db_session):
    p = await _create_with_tasks(async_client, [])
    assert (await async_client.delete(f"/api/v1/aito/{p['id']}")).status_code == 204
    resp = await async_client.put(f"/api/v1/aito/{p['id']}/transfer-client", json=NEW)
    assert resp.status_code == 404, resp.text
    trashed = (await db_session.execute(select(AitoProject).where(AitoProject.id == p["id"]))).scalar_one()
    assert trashed.status != "active"
    assert (trashed.client_id, trashed.client_name) == ("z1", "ACME")


async def _card(client, project_id):
    resp = await client.get("/api/v1/aito/")
    assert resp.status_code == 200, resp.text
    return next(c for c in resp.json() if c["id"] == project_id)


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
