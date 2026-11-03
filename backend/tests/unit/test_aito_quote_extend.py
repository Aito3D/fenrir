"""POST /aito/{id}/quote-extend: an expired quote gets 15 more days from today,
written to Books first, then adopted locally with Books' own status."""

from datetime import date, timedelta

import pytest
from sqlalchemy import select

from backend.app.models.aito_event import AitoEvent
from backend.app.services.zoho import ZohoUpstreamError, zoho_service


async def _expired(async_client):
    r = await async_client.post(
        "/api/v1/aito/",
        json={
            "description": "Ecrou",
            "client_id": "z1",
            "client_name": "ACME",
            "client_phone": "+689 87 00 00 00",
            "quote_id": "E1",
            "quote_status": "expired",
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


@pytest.mark.asyncio
async def test_extend_pushes_today_plus_15_and_adopts_books_status(async_client, db_session, monkeypatch):
    calls = []

    async def update(db, estimate_id, fields):
        calls.append((estimate_id, fields))
        return {"estimate_id": estimate_id, "status": "sent", **fields}

    monkeypatch.setattr(zoho_service, "update_estimate_fields", update)
    pid = await _expired(async_client)

    r = await async_client.post(f"/api/v1/aito/{pid}/quote-extend")

    assert r.status_code == 200, r.text
    expected = (date.today() + timedelta(days=15)).isoformat()
    assert calls == [("E1", {"expiry_date": expected})]
    assert r.json()["quote_status"] == "sent"
    assert r.json()["quote_expiry_date"] == expected
    kinds = (await db_session.execute(select(AitoEvent.kind).where(AitoEvent.project_id == pid))).scalars().all()
    assert "quote.extended" in kinds


@pytest.mark.asyncio
async def test_extend_refuses_a_quote_that_is_not_expired(async_client, monkeypatch):
    async def update(db, estimate_id, fields):
        raise AssertionError("Books must not be called")

    monkeypatch.setattr(zoho_service, "update_estimate_fields", update)
    created = (
        await async_client.post(
            "/api/v1/aito/",
            json={"description": "Ecrou", "client_id": "z1", "client_name": "ACME", "client_phone": "+689 87 00 00 00"},
        )
    ).json()
    r = await async_client.post(f"/api/v1/aito/{created['id']}/quote-extend")
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_extend_keeps_the_card_expired_when_books_refuses(async_client, monkeypatch):
    async def update(db, estimate_id, fields):
        raise ZohoUpstreamError("boom")

    monkeypatch.setattr(zoho_service, "update_estimate_fields", update)
    pid = await _expired(async_client)
    r = await async_client.post(f"/api/v1/aito/{pid}/quote-extend")
    assert r.status_code == 502
    board = (await async_client.get("/api/v1/aito/")).json()
    assert next(p for p in board if p["id"] == pid)["quote_status"] == "expired"
