"""Concurrent quote decisions: repeats are no-ops, conflicts are 409s.

The hybrid rule (user-chosen): requesting the status the quote already has
returns 200 no_op=True — no rules re-run, no timeline event, no Zoho push.
Requesting a DIFFERENT status when the current one is terminal (accepted /
declined) is a 409 naming the existing decision. Ordinary progressions
(None -> sent -> accepted) are untouched.
"""

from unittest.mock import AsyncMock

import pytest

from backend.app.services.zoho import zoho_service


async def _create_with_quote(client, status="sent"):
    payload = {
        "description": "Support GoPro",
        "client_id": "z1",
        "client_name": "ACME",
        "client_phone": "+33 6 12 34 56 78",
        "quote_id": "q-77",
        "quote_number": "EST-77",
        "quote_status": status,
    }
    return (await client.post("/api/v1/aito/", json=payload)).json()


@pytest.mark.asyncio
async def test_repeat_accept_is_a_no_op(async_client, monkeypatch):
    push = AsyncMock()
    monkeypatch.setattr(zoho_service, "advance_estimate_status", push)
    project_id = (await _create_with_quote(async_client))["id"]

    first = await async_client.post(f"/api/v1/aito/{project_id}/quote-status", json={"status": "accepted"})
    assert first.status_code == 200
    assert first.json()["no_op"] is False
    assert push.await_count == 1

    second = await async_client.post(f"/api/v1/aito/{project_id}/quote-status", json={"status": "accepted"})
    assert second.status_code == 200
    assert second.json()["no_op"] is True
    assert push.await_count == 1  # no second Zoho push

    events = (await async_client.get(f"/api/v1/aito/{project_id}/events")).json()["events"]
    assert sum(1 for e in events if e["kind"] == "quote.accepted") == 1  # no duplicate event


@pytest.mark.asyncio
async def test_conflicting_decision_is_409(async_client, monkeypatch):
    monkeypatch.setattr(zoho_service, "advance_estimate_status", AsyncMock())
    project_id = (await _create_with_quote(async_client))["id"]
    await async_client.post(f"/api/v1/aito/{project_id}/quote-status", json={"status": "accepted"})

    decline = await async_client.post(f"/api/v1/aito/{project_id}/quote-status", json={"status": "declined"})
    assert decline.status_code == 409
    detail = decline.json()["detail"]
    assert detail["code"] == "quote_status_conflict"
    assert detail["current"] == "accepted"

    board = (await async_client.get("/api/v1/aito/")).json()
    assert board[0]["quote_status"] == "accepted"  # the decision stood


@pytest.mark.asyncio
async def test_regressing_a_terminal_decision_to_sent_is_409(async_client, monkeypatch):
    monkeypatch.setattr(zoho_service, "advance_estimate_status", AsyncMock())
    project_id = (await _create_with_quote(async_client))["id"]
    await async_client.post(f"/api/v1/aito/{project_id}/quote-status", json={"status": "declined"})

    resend = await async_client.post(f"/api/v1/aito/{project_id}/quote-status", json={"status": "sent"})
    assert resend.status_code == 409
    assert resend.json()["detail"]["current"] == "declined"


@pytest.mark.asyncio
async def test_normal_progression_still_works(async_client, monkeypatch):
    monkeypatch.setattr(zoho_service, "advance_estimate_status", AsyncMock())
    project_id = (await _create_with_quote(async_client, status=None))["id"]
    sent = await async_client.post(f"/api/v1/aito/{project_id}/quote-status", json={"status": "sent"})
    assert sent.status_code == 200 and sent.json()["no_op"] is False
    accepted = await async_client.post(f"/api/v1/aito/{project_id}/quote-status", json={"status": "accepted"})
    assert accepted.status_code == 200 and accepted.json()["no_op"] is False
