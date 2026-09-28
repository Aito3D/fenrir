"""GET /aito/{id}/retainers, /retainer.pdf, /retainer-email — the Billing card's retainer rows."""

import pytest

from backend.app.services import aito_retainers
from backend.app.services.zoho import ZohoUpstreamError, zoho_service
from backend.app.utils.http import build_content_disposition  # noqa: F401

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
