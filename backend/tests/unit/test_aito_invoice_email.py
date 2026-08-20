"""GET/POST /aito/{id}/invoice-email — the Books invoice send path."""

import pytest

from backend.app.services.zoho import ZohoRequestRejected, ZohoUpstreamError, zoho_service

CONTENT = {
    "subject": "Facture INV-00087",
    "body": "<p>Bonjour</p>",
    "recipients": [
        {"email": "contact@example.pf", "name": "Jean-Pierre DUPONT", "contact_person_id": "cp-1"},
    ],
}

INVOICE = {
    "id": "INV-7",
    "number": "INV-00087",
    "date": "2026-08-18",
    "due_date": "2026-09-18",
    "total": 45000.0,
    "balance": 45000.0,
    "currency_code": "XPF",
    "status": "draft",
}


@pytest.fixture
def books_invoice_email(monkeypatch):
    """Books lists one invoice, answers the prefill, and records every send.

    Patched on the zoho_service INSTANCE so the fakes need no ``self``. That is
    safe only because ``reset_zoho_singleton_shadows`` in conftest strips the
    shadow monkeypatch's undo leaves behind on the singleton — without it this
    fixture silently disarms every later class-level patch of the same method.
    """
    sent: list[tuple[str, list[str]]] = []

    async def invoices(db, estimate_id, customer_id):
        return [dict(INVOICE)]

    async def url(db, invoice_id):
        return f"https://books.zoho.com/app#/invoices/{invoice_id}"

    async def content(db, invoice_id):
        return {**CONTENT, "recipients": list(CONTENT["recipients"])}

    async def send(db, invoice_id, *, to_mail_ids):
        sent.append((invoice_id, to_mail_ids))

    monkeypatch.setattr(zoho_service, "list_project_invoices", invoices)
    monkeypatch.setattr(zoho_service, "books_invoice_url", url)
    monkeypatch.setattr(zoho_service, "get_invoice_email_content", content)
    monkeypatch.setattr(zoho_service, "email_invoice", send)
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


async def _events(async_client, project_id) -> list[str]:
    body = (await async_client.get(f"/api/v1/aito/{project_id}/events?depth=detail")).json()
    return [e["kind"] for e in body["events"]]


@pytest.mark.asyncio
async def test_prefill_returns_the_invoice_subject_and_recipients(async_client, books_invoice_email):
    project = await _create(async_client)
    body = (await async_client.get(f"/api/v1/aito/{project['id']}/invoice-email")).json()

    assert body["subject"] == "Facture INV-00087"
    assert body["invoice_id"] == "INV-7"
    assert body["invoice_number"] == "INV-00087"
    assert [r["email"] for r in body["recipients"]] == ["contact@example.pf"]
    assert body["default_email"] == "contact@example.pf"


@pytest.mark.asyncio
async def test_prefill_prefers_the_cards_own_client_email(async_client, books_invoice_email):
    # The card carries an address Books does not offer. It was attached by a
    # human on purpose, so it must be offered AND preselected.
    project = await _create(async_client, client_email="direct@example.pf")
    body = (await async_client.get(f"/api/v1/aito/{project['id']}/invoice-email")).json()

    assert body["default_email"] == "direct@example.pf"
    assert [r["email"] for r in body["recipients"]] == ["direct@example.pf", "contact@example.pf"]


@pytest.mark.asyncio
async def test_prefill_404s_without_a_quote(async_client, books_invoice_email):
    project = await _create(async_client, quote_id=None, quote_number=None)
    assert (await async_client.get(f"/api/v1/aito/{project['id']}/invoice-email")).status_code == 404


@pytest.mark.asyncio
async def test_prefill_404s_when_the_estimate_has_no_invoice(async_client, monkeypatch):
    async def none(db, estimate_id, customer_id):
        return []

    monkeypatch.setattr(zoho_service, "list_project_invoices", none)
    project = await _create(async_client)
    assert (await async_client.get(f"/api/v1/aito/{project['id']}/invoice-email")).status_code == 404


@pytest.mark.asyncio
async def test_prefill_404s_for_an_invoice_that_is_not_this_projects(async_client, books_invoice_email):
    project = await _create(async_client)
    response = await async_client.get(f"/api/v1/aito/{project['id']}/invoice-email?invoice_id=INV-999")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_prefill_maps_an_outage_to_502(async_client, books_invoice_email, monkeypatch):
    project = await _create(async_client)

    async def boom(db, invoice_id):
        raise ZohoUpstreamError("Zoho Books unreachable: ConnectError")

    monkeypatch.setattr(zoho_service, "get_invoice_email_content", boom)
    assert (await async_client.get(f"/api/v1/aito/{project['id']}/invoice-email")).status_code == 502


@pytest.mark.asyncio
async def test_prefill_maps_a_rejection_to_400(async_client, books_invoice_email, monkeypatch):
    project = await _create(async_client)

    async def rejected(db, invoice_id):
        raise ZohoRequestRejected("No email address for this contact")

    monkeypatch.setattr(zoho_service, "get_invoice_email_content", rejected)
    response = await async_client.get(f"/api/v1/aito/{project['id']}/invoice-email")
    assert response.status_code == 400
    assert "No email address" in response.json()["detail"]


@pytest.mark.asyncio
async def test_send_emails_the_invoice_and_records_one_event(async_client, books_invoice_email):
    project = await _create(async_client)

    response = await async_client.post(
        f"/api/v1/aito/{project['id']}/invoice-email",
        json={"to": "contact@example.pf", "invoice_id": "INV-7"},
    )

    assert response.status_code == 200
    assert response.json()["id"] == "INV-7"
    assert books_invoice_email == [("INV-7", ["contact@example.pf"])]
    kinds = await _events(async_client, project["id"])
    assert kinds.count("invoice.emailed") == 1


@pytest.mark.asyncio
async def test_send_never_moves_the_card(async_client, books_invoice_email):
    # An invoice going out is not a board transition — see the spec. The card
    # must sit exactly where it was.
    project = await _create(async_client)
    before = next(p for p in (await async_client.get("/api/v1/aito/")).json() if p["id"] == project["id"])

    await async_client.post(
        f"/api/v1/aito/{project['id']}/invoice-email",
        json={"to": "contact@example.pf", "invoice_id": "INV-7"},
    )

    after = next(p for p in (await async_client.get("/api/v1/aito/")).json() if p["id"] == project["id"])
    assert after["column"] == before["column"]
    assert after["quote_status"] == before["quote_status"]


@pytest.mark.asyncio
async def test_an_address_outside_the_allowlist_is_refused_without_sending(async_client, books_invoice_email):
    project = await _create(async_client)

    response = await async_client.post(
        f"/api/v1/aito/{project['id']}/invoice-email",
        json={"to": "attacker@evil.example", "invoice_id": "INV-7"},
    )

    assert response.status_code == 422
    assert books_invoice_email == []  # Zoho was never asked to send anything
    assert "invoice.emailed" not in await _events(async_client, project["id"])


@pytest.mark.asyncio
async def test_an_invoice_id_from_another_project_is_refused_without_sending(async_client, books_invoice_email):
    project = await _create(async_client)

    response = await async_client.post(
        f"/api/v1/aito/{project['id']}/invoice-email",
        json={"to": "contact@example.pf", "invoice_id": "INV-999"},
    )

    assert response.status_code == 404
    assert books_invoice_email == []
    assert "invoice.emailed" not in await _events(async_client, project["id"])


@pytest.mark.asyncio
async def test_a_failed_send_records_nothing(async_client, books_invoice_email, monkeypatch):
    project = await _create(async_client)

    async def boom(db, invoice_id, *, to_mail_ids):
        raise ZohoUpstreamError("Zoho Books unreachable: ConnectError")

    monkeypatch.setattr(zoho_service, "email_invoice", boom)

    response = await async_client.post(
        f"/api/v1/aito/{project['id']}/invoice-email",
        json={"to": "contact@example.pf", "invoice_id": "INV-7"},
    )

    assert response.status_code == 502
    assert "invoice.emailed" not in await _events(async_client, project["id"])


@pytest.mark.asyncio
async def test_a_failed_re_read_after_a_successful_send_still_returns_200(async_client, books_invoice_email):
    # The mail has gone out and the event is committed. 500ing here would
    # invite a real second send on retry, which is the one thing this
    # handler exists to prevent.
    project = await _create(async_client)
    calls = {"n": 0}

    async def flaky(db, estimate_id, customer_id):
        calls["n"] += 1
        if calls["n"] > 1:
            raise ZohoUpstreamError("Zoho Books unreachable: ConnectError")
        return [dict(INVOICE)]

    # Patched after the fixture so the first (pre-send) lookup still answers.
    zoho_service.list_project_invoices = flaky
    try:
        response = await async_client.post(
            f"/api/v1/aito/{project['id']}/invoice-email",
            json={"to": "contact@example.pf", "invoice_id": "INV-7"},
        )
    finally:
        del zoho_service.list_project_invoices

    assert response.status_code == 200
    assert response.json()["id"] == "INV-7"
    assert "invoice.emailed" in await _events(async_client, project["id"])
