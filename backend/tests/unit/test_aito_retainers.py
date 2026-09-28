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
