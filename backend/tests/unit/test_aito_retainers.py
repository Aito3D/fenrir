"""GET /aito/{id}/retainers, /retainer.pdf, /retainer-email — the Billing card's retainer rows."""

import pytest

from backend.app.services import aito_retainers
from backend.app.services.zoho import ZohoUpstreamError, zoho_service
from backend.app.utils.http import build_content_disposition

RETAINER = {
    "id": "RET-B",
    "number": "AC-26-0031",
    "date": "2026-09-03",
    "total": 17500.0,
    "balance": 0.0,
    "currency_code": "XPF",
    "status": "paid",
}
OTHER = {**RETAINER, "id": "RET-A", "number": "AC-26-0001", "date": "2026-09-01", "total": 5000.0}


@pytest.fixture
def books_retainers(monkeypatch):
    """The resolver answers with two retainers (newest first) and the deep
    link is built from a fixed base. Patched at the ROUTE module's import of
    the resolver so the route is exercised, not the resolver (Task 2 covers
    that)."""
    rows: list[dict] = [dict(RETAINER), dict(OTHER)]

    async def resolver(db, project):
        return [dict(r) for r in rows]

    async def url(db, retainer_id):
        return f"https://books.zoho.eu/app/org1#/retainerinvoices/{retainer_id}"

    monkeypatch.setattr(aito_retainers, "list_project_retainers", resolver)
    monkeypatch.setattr("backend.app.api.routes.aito.list_project_retainers", resolver)
    monkeypatch.setattr(zoho_service, "books_retainer_url", url)
    return rows


async def _create(async_client, *, quoted=True, **overrides):
    payload = {
        "description": "Support GoPro",
        "client_id": "z1",
        "client_name": "ACME",
        "client_email": "contact@example.pf",
    }
    if quoted:
        payload |= {"quote_id": "EST-9", "quote_number": "DEV26-2638"}
    payload.update(overrides)
    return (await async_client.post("/api/v1/aito/", json=payload)).json()


@pytest.mark.asyncio
async def test_lists_the_projects_retainers_with_a_books_link(async_client, books_retainers):
    project = await _create(async_client)
    body = (await async_client.get(f"/api/v1/aito/{project['id']}/retainers")).json()

    assert [r["number"] for r in body] == ["AC-26-0031", "AC-26-0001"]
    assert body[0]["url"] == "https://books.zoho.eu/app/org1#/retainerinvoices/RET-B"
    assert body[0]["total"] == 17500.0
    assert body[0]["status"] == "paid"


@pytest.mark.asyncio
async def test_a_hand_made_card_gets_an_empty_list_without_asking_books(async_client, monkeypatch):
    called = []

    async def resolver(db, project):
        called.append(project.id)
        return []

    monkeypatch.setattr("backend.app.api.routes.aito.list_project_retainers", resolver)
    project = await _create(async_client, quoted=False)

    response = await async_client.get(f"/api/v1/aito/{project['id']}/retainers")

    assert response.status_code == 200
    assert response.json() == []
    assert called == []


@pytest.mark.asyncio
async def test_missing_project_is_404(async_client, books_retainers):
    assert (await async_client.get("/api/v1/aito/999999/retainers")).status_code == 404


@pytest.mark.asyncio
async def test_zoho_failure_is_502(async_client, monkeypatch):
    async def resolver(db, project):
        raise ZohoUpstreamError("Books is down")

    monkeypatch.setattr("backend.app.api.routes.aito.list_project_retainers", resolver)
    project = await _create(async_client)

    response = await async_client.get(f"/api/v1/aito/{project['id']}/retainers")

    assert response.status_code == 502
    assert "Books is down" in response.json()["detail"]


@pytest.mark.asyncio
async def test_retainer_pdf_is_inline_and_named_after_the_number(async_client, books_retainers, monkeypatch):
    fetched = []

    async def pdf(db, retainer_id):
        fetched.append(retainer_id)
        return b"%PDF-1.4 fake"

    monkeypatch.setattr(zoho_service, "get_retainer_invoice_pdf", pdf)
    project = await _create(async_client)

    response = await async_client.get(f"/api/v1/aito/{project['id']}/retainer.pdf", params={"retainer_id": "RET-A"})

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["content-disposition"] == build_content_disposition("AC-26-0001.pdf", disposition="inline")
    assert response.content == b"%PDF-1.4 fake"
    assert fetched == ["RET-A"]


@pytest.mark.asyncio
async def test_retainer_pdf_refuses_an_id_that_is_not_this_projects(async_client, books_retainers, monkeypatch):
    async def pdf(db, retainer_id):
        raise AssertionError("must not fetch")

    monkeypatch.setattr(zoho_service, "get_retainer_invoice_pdf", pdf)
    project = await _create(async_client)

    response = await async_client.get(f"/api/v1/aito/{project['id']}/retainer.pdf", params={"retainer_id": "RET-Z"})

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_retainer_pdf_requires_the_id(async_client, books_retainers):
    project = await _create(async_client)
    assert (await async_client.get(f"/api/v1/aito/{project['id']}/retainer.pdf")).status_code == 422


@pytest.mark.asyncio
async def test_retainer_pdf_on_a_quoteless_card_is_404(async_client, books_retainers):
    project = await _create(async_client, quoted=False)
    response = await async_client.get(f"/api/v1/aito/{project['id']}/retainer.pdf", params={"retainer_id": "RET-A"})
    assert response.status_code == 404


CONTENT = {
    "subject": "Acompte AC-26-0031",
    "body": "<p>Bonjour</p>",
    "recipients": [{"email": "contact@example.pf", "name": "Jean-Pierre Dupont", "contact_person_id": "cp-1"}],
}


@pytest.fixture
def books_retainer_email(monkeypatch, books_retainers):
    """Prefill and send fakes on top of the two resolved retainers. The
    resolved row's status flips to "sent" from the SECOND resolver call on,
    mirroring Books' side effect, so a handler that skipped the post-send
    re-read would be caught."""
    sent: list[tuple[str, list[str]]] = []
    calls = {"resolve": 0}

    async def resolver(db, project):
        calls["resolve"] += 1
        status = "paid" if calls["resolve"] == 1 else "sent"
        return [{**r, "status": status} for r in books_retainers]

    async def content(db, retainer_id):
        return {**CONTENT, "recipients": list(CONTENT["recipients"])}

    async def send(db, retainer_id, *, to_mail_ids):
        sent.append((retainer_id, to_mail_ids))

    monkeypatch.setattr("backend.app.api.routes.aito.list_project_retainers", resolver)
    monkeypatch.setattr(zoho_service, "get_retainer_email_content", content)
    monkeypatch.setattr(zoho_service, "email_retainer", send)
    return sent


async def _events(async_client, project_id) -> list[dict]:
    body = (await async_client.get(f"/api/v1/aito/{project_id}/events?depth=detail")).json()
    return body["events"]


@pytest.mark.asyncio
async def test_email_prefill_names_the_retainer_and_prefers_the_cards_email(async_client, books_retainer_email):
    project = await _create(async_client, client_email="direct@example.pf")

    body = (
        await async_client.get(f"/api/v1/aito/{project['id']}/retainer-email", params={"retainer_id": "RET-B"})
    ).json()

    assert body["subject"] == "Acompte AC-26-0031"
    assert body["retainer_id"] == "RET-B"
    assert body["retainer_number"] == "AC-26-0031"
    assert [r["email"] for r in body["recipients"]] == ["direct@example.pf", "contact@example.pf"]
    assert body["default_email"] == "direct@example.pf"


@pytest.mark.asyncio
async def test_send_emails_through_books_records_the_event_and_returns_the_re_read_row(
    async_client, books_retainer_email
):
    project = await _create(async_client)

    response = await async_client.post(
        f"/api/v1/aito/{project['id']}/retainer-email", json={"to": "contact@example.pf", "retainer_id": "RET-B"}
    )

    assert response.status_code == 200, response.text
    assert books_retainer_email == [("RET-B", ["contact@example.pf"])]
    assert response.json()["status"] == "sent"
    assert response.json()["url"] == "https://books.zoho.eu/app/org1#/retainerinvoices/RET-B"
    events = await _events(async_client, project["id"])
    emailed = [e for e in events if e["kind"] == "retainer.emailed"]
    assert len(emailed) == 1
    assert emailed[0]["detail"] == {"email": "contact@example.pf", "retainer_number": "AC-26-0031"}


@pytest.mark.asyncio
async def test_send_refuses_an_address_books_does_not_offer(async_client, books_retainer_email):
    project = await _create(async_client)

    response = await async_client.post(
        f"/api/v1/aito/{project['id']}/retainer-email", json={"to": "stranger@example.pf", "retainer_id": "RET-B"}
    )

    assert response.status_code == 422
    assert books_retainer_email == []


@pytest.mark.asyncio
async def test_send_refuses_a_retainer_that_is_not_this_projects(async_client, books_retainer_email):
    project = await _create(async_client)

    response = await async_client.post(
        f"/api/v1/aito/{project['id']}/retainer-email", json={"to": "contact@example.pf", "retainer_id": "RET-Z"}
    )

    assert response.status_code == 404
    assert books_retainer_email == []


@pytest.mark.asyncio
async def test_a_second_send_inside_the_window_is_409(async_client, books_retainer_email):
    from backend.app.api.routes.aito import _reset_recent_emails

    _reset_recent_emails()
    project = await _create(async_client)
    payload = {"to": "contact@example.pf", "retainer_id": "RET-B"}

    first = await async_client.post(f"/api/v1/aito/{project['id']}/retainer-email", json=payload)
    second = await async_client.post(f"/api/v1/aito/{project['id']}/retainer-email", json=payload)

    assert first.status_code == 200
    assert second.status_code == 409
    assert len(books_retainer_email) == 1
    _reset_recent_emails()


@pytest.mark.asyncio
async def test_send_degrades_to_the_pre_send_row_when_the_re_read_fails(
    async_client, books_retainer_email, monkeypatch
):
    calls = {"n": 0}

    async def resolver(db, project):
        calls["n"] += 1
        if calls["n"] > 1:
            raise ZohoUpstreamError("Books is down")
        return [dict(r) for r in [RETAINER, OTHER]]

    monkeypatch.setattr("backend.app.api.routes.aito.list_project_retainers", resolver)
    project = await _create(async_client)

    response = await async_client.post(
        f"/api/v1/aito/{project['id']}/retainer-email", json={"to": "contact@example.pf", "retainer_id": "RET-B"}
    )

    assert response.status_code == 200
    assert response.json()["number"] == "AC-26-0031"
    assert response.json()["status"] == "paid"
    assert len(books_retainer_email) == 1
