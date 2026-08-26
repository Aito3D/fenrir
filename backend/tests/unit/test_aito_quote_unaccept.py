"""Revoking an acceptance: accepted -> sent is the one transition allowed
back OUT of 'accepted'.

The hold-to-unaccept pill on the detail panel exists for two real cases: an
Accept held by mistake, and a quote that was modified after acceptance and
needs the client's go-ahead again. Both want the card back in Waiting, which
the board rules derive from 'sent'. Everything else off 'accepted' (declining
it, re-accepting it) keeps its existing behavior: declined stays a 409
conflict, accepted->accepted stays a no_op — see
test_aito_quote_status_conflicts.py.
"""

from unittest.mock import AsyncMock

import pytest

from backend.app.services.zoho import zoho_service


async def _create_accepted(client):
    payload = {
        "description": "Support GoPro",
        "client_id": "z1",
        "client_name": "ACME",
        "client_phone": "+33 6 12 34 56 78",
        "quote_id": "q-77",
        "quote_number": "EST-77",
        "quote_status": "sent",
    }
    project_id = (await client.post("/api/v1/aito/", json=payload)).json()["id"]
    accepted = await client.post(f"/api/v1/aito/{project_id}/quote-status", json={"status": "accepted"})
    assert accepted.status_code == 200
    return project_id


@pytest.mark.asyncio
async def test_unaccept_moves_the_card_back_to_waiting(async_client, monkeypatch):
    push = AsyncMock()
    monkeypatch.setattr(zoho_service, "advance_estimate_status", push)
    project_id = await _create_accepted(async_client)

    response = await async_client.post(f"/api/v1/aito/{project_id}/quote-status", json={"status": "sent"})
    assert response.status_code == 200
    body = response.json()
    assert body["no_op"] is False
    assert body["project"]["quote_status"] == "sent"
    assert body["project"]["column"] == "waiting"


@pytest.mark.asyncio
async def test_unaccept_pushes_sent_to_zoho(async_client, monkeypatch):
    push = AsyncMock()
    monkeypatch.setattr(zoho_service, "advance_estimate_status", push)
    project_id = await _create_accepted(async_client)

    response = await async_client.post(f"/api/v1/aito/{project_id}/quote-status", json={"status": "sent"})
    assert response.json()["zoho_synced"] is True
    # One push for the accept, one for the revoke — and the revoke names 'sent'.
    assert push.await_count == 2
    assert push.await_args.args[1:] == ("q-77", "sent")


@pytest.mark.asyncio
async def test_unaccept_records_its_own_timeline_event(async_client, monkeypatch):
    """A revoked acceptance must not masquerade as an ordinary 'marked sent':
    the audit trail is how the shop reconstructs who un-authorised the work."""
    monkeypatch.setattr(zoho_service, "advance_estimate_status", AsyncMock())
    project_id = await _create_accepted(async_client)

    await async_client.post(f"/api/v1/aito/{project_id}/quote-status", json={"status": "sent"})

    events = (await async_client.get(f"/api/v1/aito/{project_id}/events")).json()["events"]
    kinds = [e["kind"] for e in events]
    assert "quote.unaccepted" in kinds
    # The revoke is NOT additionally recorded as a plain send.
    assert "quote.sent" not in kinds


@pytest.mark.asyncio
async def test_unaccepted_quote_can_be_accepted_again(async_client, monkeypatch):
    """The whole point of the revoke: the quote goes around the loop again."""
    monkeypatch.setattr(zoho_service, "advance_estimate_status", AsyncMock())
    project_id = await _create_accepted(async_client)

    await async_client.post(f"/api/v1/aito/{project_id}/quote-status", json={"status": "sent"})
    reaccepted = await async_client.post(f"/api/v1/aito/{project_id}/quote-status", json={"status": "accepted"})
    assert reaccepted.status_code == 200
    assert reaccepted.json()["project"]["quote_status"] == "accepted"


@pytest.mark.asyncio
async def test_declining_an_accepted_quote_is_still_a_conflict(async_client, monkeypatch):
    """Widening accepted->sent must not widen accepted->declined: no fresh UI
    offers Decline on an accepted card, so that request can only be stale."""
    monkeypatch.setattr(zoho_service, "advance_estimate_status", AsyncMock())
    project_id = await _create_accepted(async_client)

    decline = await async_client.post(f"/api/v1/aito/{project_id}/quote-status", json={"status": "declined"})
    assert decline.status_code == 409
    assert decline.json()["detail"]["code"] == "quote_status_conflict"
