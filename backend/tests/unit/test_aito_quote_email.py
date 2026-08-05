"""GET/POST /aito/{id}/quote-email — the Books send path and the card move."""

import pytest

from backend.app.services.zoho import ZohoRequestRejected, ZohoUpstreamError, zoho_service

CONTENT = {
    "subject": "Devis QT-00412",
    "body": "<p>Bonjour</p>",
    "recipients": [
        {"email": "contact@example.pf", "name": "Jean-Pierre DUPONT", "contact_person_id": "cp-1"},
    ],
}


@pytest.fixture
def books_email(monkeypatch):
    """Books answers the prefill, and records every send.

    Patched on the zoho_service INSTANCE, not the class — a class-level patch
    is masked by instance shadows other modules in this suite leave behind.
    """
    sent: list[tuple[str, list[str]]] = []

    async def content(db, estimate_id):
        return {**CONTENT, "recipients": list(CONTENT["recipients"])}

    async def send(db, estimate_id, *, to_mail_ids):
        sent.append((estimate_id, to_mail_ids))

    monkeypatch.setattr(zoho_service, "get_estimate_email_content", content)
    monkeypatch.setattr(zoho_service, "email_estimate", send)
    return sent


async def _create(async_client, **overrides):
    payload = {
        "description": "Support GoPro",
        "client_id": "z1",
        "client_name": "ACME",
        "client_email": "contact@example.pf",
        "quote_id": "EST-9",
        "quote_number": "QT-00412",
    }
    payload.update(overrides)
    return (await async_client.post("/api/v1/aito/", json=payload)).json()


@pytest.mark.asyncio
async def test_prefill_returns_subject_and_recipients(async_client, books_email):
    project = await _create(async_client)
    body = (await async_client.get(f"/api/v1/aito/{project['id']}/quote-email")).json()

    assert body["subject"] == "Devis QT-00412"
    assert [r["email"] for r in body["recipients"]] == ["contact@example.pf"]
    assert body["default_email"] == "contact@example.pf"


@pytest.mark.asyncio
async def test_prefill_prefers_the_cards_own_client_email(async_client, books_email):
    # The card carries an address Books does not offer. It was attached by a
    # human on purpose, so it must be offered AND preselected.
    project = await _create(async_client, client_email="direct@example.pf")
    body = (await async_client.get(f"/api/v1/aito/{project['id']}/quote-email")).json()

    assert body["default_email"] == "direct@example.pf"
    assert [r["email"] for r in body["recipients"]] == ["direct@example.pf", "contact@example.pf"]


@pytest.mark.asyncio
async def test_prefill_falls_back_to_the_client_email_alone(async_client, monkeypatch):
    # Books offers nobody (a contact with no contact persons). The card's own
    # address is still a real address, and must be the whole list.
    async def empty(db, estimate_id):
        return {"subject": "Devis QT-00412", "body": "<p>Bonjour</p>", "recipients": []}

    monkeypatch.setattr(zoho_service, "get_estimate_email_content", empty)
    project = await _create(async_client)
    body = (await async_client.get(f"/api/v1/aito/{project['id']}/quote-email")).json()

    assert [r["email"] for r in body["recipients"]] == ["contact@example.pf"]
    assert body["default_email"] == "contact@example.pf"


@pytest.mark.asyncio
async def test_prefill_has_no_default_when_nobody_can_receive_it(async_client, monkeypatch):
    async def empty(db, estimate_id):
        return {"subject": "Devis QT-00412", "body": "<p>Bonjour</p>", "recipients": []}

    monkeypatch.setattr(zoho_service, "get_estimate_email_content", empty)
    project = await _create(async_client, client_email=None)
    body = (await async_client.get(f"/api/v1/aito/{project['id']}/quote-email")).json()

    assert body["recipients"] == []
    assert body["default_email"] is None


@pytest.mark.asyncio
async def test_prefill_404s_without_a_quote(async_client, books_email):
    project = await _create(async_client, quote_id=None, quote_number=None)
    response = await async_client.get(f"/api/v1/aito/{project['id']}/quote-email")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_prefill_404s_for_an_unknown_project(async_client, books_email):
    assert (await async_client.get("/api/v1/aito/99999/quote-email")).status_code == 404


@pytest.mark.asyncio
async def test_prefill_maps_an_outage_to_502(async_client, monkeypatch):
    project = await _create(async_client)

    async def boom(db, estimate_id):
        raise ZohoUpstreamError("Zoho Books unreachable: ConnectError")

    monkeypatch.setattr(zoho_service, "get_estimate_email_content", boom)
    response = await async_client.get(f"/api/v1/aito/{project['id']}/quote-email")
    assert response.status_code == 502


@pytest.mark.asyncio
async def test_prefill_maps_a_rejection_to_400(async_client, monkeypatch):
    project = await _create(async_client)

    async def rejected(db, estimate_id):
        raise ZohoRequestRejected("No email address for this contact")

    monkeypatch.setattr(zoho_service, "get_estimate_email_content", rejected)
    response = await async_client.get(f"/api/v1/aito/{project['id']}/quote-email")
    assert response.status_code == 400
    assert "No email address" in response.json()["detail"]
