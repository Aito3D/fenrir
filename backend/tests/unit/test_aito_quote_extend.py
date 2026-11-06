"""POST /aito/{id}/quote-extend: an expired quote gets 15 more days from today,
written to Books first, then adopted locally with Books' own status."""

from datetime import date, timedelta

import pytest
from sqlalchemy import select

from backend.app.models.aito_event import AitoEvent
from backend.app.services.zoho import ZohoNotConfiguredError, ZohoUpstreamError, zoho_service


async def _expired(async_client, quote_id="E1"):
    r = await async_client.post(
        "/api/v1/aito/",
        json={
            "description": "Ecrou",
            "client_id": "z1",
            "client_name": "ACME",
            "client_phone": "+689 87 00 00 00",
            "quote_id": quote_id,
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


@pytest.mark.asyncio
async def test_extend_reconciles_the_payment_link_right_away(async_client, monkeypatch):
    """The expiry cancelled the link; the extension must mint its replacement
    in the same request, forced past any backoff, for this card only."""
    from backend.app.api.routes import aito as aito_routes

    async def update(db, estimate_id, fields):
        return {"estimate_id": estimate_id, "status": "sent", **fields}

    reconciled = []

    async def fake_reconcile(db, **kwargs):
        reconciled.append(kwargs)
        return 1

    monkeypatch.setattr(zoho_service, "update_estimate_fields", update)
    monkeypatch.setattr(aito_routes, "reconcile_payment_links", fake_reconcile)
    pid = await _expired(async_client)

    assert (await async_client.post(f"/api/v1/aito/{pid}/quote-extend")).status_code == 200
    assert reconciled == [{"only_project_id": pid, "force": True}]


@pytest.mark.asyncio
async def test_extend_does_not_wait_for_a_busy_background_pass(async_client, monkeypatch):
    """T-585: a pass holding the payment-link lock must not stall the response."""
    from backend.app.api.routes import aito as aito_routes
    from backend.app.services import aito_payment_links

    async def update(db, estimate_id, fields):
        return {"estimate_id": estimate_id, "status": "sent", **fields}

    async def fail_reconcile(db, **kwargs):
        raise AssertionError("must not reconcile while a pass is busy")

    monkeypatch.setattr(zoho_service, "update_estimate_fields", update)
    monkeypatch.setattr(aito_routes, "reconcile_payment_links", fail_reconcile)
    pid = await _expired(async_client)

    async with aito_payment_links._pass_lock:
        r = await async_client.post(f"/api/v1/aito/{pid}/quote-extend")
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_extend_survives_a_reconcile_failure_after_the_commit(async_client, monkeypatch):
    from backend.app.api.routes import aito as aito_routes

    async def update(db, estimate_id, fields):
        return {"estimate_id": estimate_id, "status": "sent", **fields}

    async def boom(db, **kwargs):
        raise RuntimeError("heimdall exploded")

    monkeypatch.setattr(zoho_service, "update_estimate_fields", update)
    monkeypatch.setattr(aito_routes, "reconcile_payment_links", boom)
    pid = await _expired(async_client)

    r = await async_client.post(f"/api/v1/aito/{pid}/quote-extend")
    assert r.status_code == 200
    assert r.json()["quote_status"] == "sent"


@pytest.mark.asyncio
async def test_extend_refuses_an_expired_card_without_a_quote_id(async_client, monkeypatch):
    async def update(db, estimate_id, fields):
        raise AssertionError("Books must not be called")

    monkeypatch.setattr(zoho_service, "update_estimate_fields", update)
    pid = await _expired(async_client, quote_id=None)
    r = await async_client.post(f"/api/v1/aito/{pid}/quote-extend")
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_extend_answers_502_and_stays_expired_when_books_is_not_configured(async_client, monkeypatch):
    async def update(db, estimate_id, fields):
        raise ZohoNotConfiguredError("Zoho Books is not configured")

    monkeypatch.setattr(zoho_service, "update_estimate_fields", update)
    pid = await _expired(async_client)
    r = await async_client.post(f"/api/v1/aito/{pid}/quote-extend")
    assert r.status_code == 502
    assert "not configured" in r.json()["detail"]
    board = (await async_client.get("/api/v1/aito/")).json()
    assert next(p for p in board if p["id"] == pid)["quote_status"] == "expired"


@pytest.mark.asyncio
async def test_extend_falls_back_to_our_expiry_and_sent_when_books_replies_empty(async_client, monkeypatch):
    async def update(db, estimate_id, fields):
        return {}

    monkeypatch.setattr(zoho_service, "update_estimate_fields", update)
    pid = await _expired(async_client)
    r = await async_client.post(f"/api/v1/aito/{pid}/quote-extend")
    assert r.status_code == 200, r.text
    assert r.json()["quote_status"] == "sent"
    # Same source as the route; a midnight rollover mid-test is the only slack.
    assert r.json()["quote_expiry_date"] in {(date.today() + timedelta(days=d)).isoformat() for d in (15, 16)}


@pytest.mark.asyncio
async def test_extend_on_a_trashed_card_is_404(async_client, monkeypatch):
    async def update(db, estimate_id, fields):
        raise AssertionError("Books must not be called")

    monkeypatch.setattr(zoho_service, "update_estimate_fields", update)
    pid = await _expired(async_client)
    assert (await async_client.delete(f"/api/v1/aito/{pid}")).status_code == 204
    assert (await async_client.post(f"/api/v1/aito/{pid}/quote-extend")).status_code == 404
