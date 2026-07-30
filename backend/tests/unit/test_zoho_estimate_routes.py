"""Zoho estimate search and quote preview: service mapping and route errors."""

import json
from pathlib import Path

import httpx
import pytest

from backend.app.services.zoho import zoho_service


@pytest.fixture(autouse=True)
def reset_service():
    zoho_service.invalidate_token()
    zoho_service.transport = None
    yield
    zoho_service.invalidate_token()
    zoho_service.transport = None


async def _configure(async_client, **overrides):
    payload = {
        "zoho_client_id": "1000.FAKE",
        "zoho_client_secret": "fake-secret",
        "zoho_refresh_token": "1000.fake.refresh",
        "zoho_organization_id": "999",
    }
    payload.update(overrides)
    await async_client.put("/api/v1/settings/", json=payload)


def _token(request: httpx.Request) -> httpx.Response | None:
    if "/oauth/v2/token" in str(request.url):
        return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
    return None


@pytest.mark.asyncio
async def test_books_app_url_follows_the_accounts_region(async_client):
    from backend.app.core.database import async_session

    await _configure(async_client)
    async with async_session() as db:
        url = await zoho_service.books_app_url(db, "abc")
    # `#/quotes/`, not `#/estimates/`: the API calls them estimates, the Books
    # web app routes them under quotes, and only the latter resolves.
    assert url == "https://books.zoho.eu/app/999#/quotes/abc"


@pytest.mark.asyncio
async def test_books_app_url_handles_a_multi_part_region(async_client):
    from backend.app.core.database import async_session

    await _configure(async_client, zoho_accounts_url="https://accounts.zoho.com.au")
    async with async_session() as db:
        url = await zoho_service.books_app_url(db, "abc")
    assert url == "https://books.zoho.com.au/app/999#/quotes/abc"


@pytest.mark.asyncio
async def test_search_estimates_maps_the_summary_shape(async_client):
    from backend.app.core.database import async_session

    await _configure(async_client)
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        token = _token(request)
        if token:
            return token
        seen["params"] = dict(request.url.params)
        return httpx.Response(
            200,
            json={
                "estimates": [
                    {
                        "estimate_id": "e1",
                        "estimate_number": "DEV26-2467",
                        "customer_name": "Test Person",
                        "date": "2026-07-28",
                        "total": 5600,
                        "currency_code": "XPF",
                        "status": "draft",
                    }
                ]
            },
        )

    zoho_service.transport = httpx.MockTransport(handler)
    async with async_session() as db:
        results = await zoho_service.search_estimates(db, "2467")
    assert results == [
        {
            "id": "e1",
            "number": "DEV26-2467",
            "customer_name": "Test Person",
            "date": "2026-07-28",
            "total": 5600.0,
            "currency_code": "XPF",
            "status": "draft",
        }
    ]
    assert seen["params"]["search_text"] == "2467"


@pytest.mark.asyncio
async def test_search_estimates_without_a_query_lists_the_most_recent(async_client):
    from backend.app.core.database import async_session

    await _configure(async_client)
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        token = _token(request)
        if token:
            return token
        seen["params"] = dict(request.url.params)
        return httpx.Response(200, json={"estimates": []})

    zoho_service.transport = httpx.MockTransport(handler)
    async with async_session() as db:
        await zoho_service.search_estimates(db, "")
    assert "search_text" not in seen["params"]
    assert seen["params"]["sort_column"] == "date"
    assert seen["params"]["sort_order"] == "D"
    assert seen["params"]["per_page"] == "25"


_FIXTURES = Path(__file__).parent.parent / "fixtures" / "zoho_estimates"


def _estimate(name: str) -> dict:
    return json.loads((_FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def _books_handler(estimate: dict, *, contact_status: int = 200):
    """Token + estimate + contact, with a switchable contact failure."""

    def handler(request: httpx.Request) -> httpx.Response:
        token = _token(request)
        if token:
            return token
        path = request.url.path
        if "/contacts/" in path:
            if contact_status != 200:
                return httpx.Response(contact_status, json={"message": "nope"})
            return httpx.Response(
                200,
                json={
                    "contact": {
                        "contact_id": estimate["customer_id"],
                        "contact_name": estimate["customer_name"],
                        "company_name": "",
                        "customer_sub_type": "business",
                        "phone": "",
                        "mobile": "87123456",
                        "email": "hi@exemple.pf",
                    }
                },
            )
        return httpx.Response(200, json={"estimate": estimate})

    return handler


@pytest.mark.asyncio
async def test_estimates_409_when_unconfigured(async_client):
    assert (await async_client.get("/api/v1/zoho/estimates")).status_code == 409
    assert (await async_client.get("/api/v1/zoho/estimates/e1/preview")).status_code == 409


@pytest.mark.asyncio
async def test_estimates_502_when_upstream_fails(async_client):
    await _configure(async_client)
    zoho_service.transport = httpx.MockTransport(lambda request: _token(request) or httpx.Response(500, text="boom"))
    assert (await async_client.get("/api/v1/zoho/estimates?q=2467")).status_code == 502


@pytest.mark.asyncio
async def test_preview_returns_tasks_client_and_quote(async_client):
    await _configure(async_client)
    estimate = _estimate("dev-2461-three-services")
    zoho_service.transport = httpx.MockTransport(_books_handler(estimate))
    r = await async_client.get(f"/api/v1/zoho/estimates/{estimate['estimate_id']}/preview")
    assert r.status_code == 200
    body = r.json()
    assert body["quote"]["number"] == "DEV26-2461"
    assert body["quote"]["url"].endswith(f"#/quotes/{estimate['estimate_id']}")
    assert body["client"]["phone"] == "87123456"
    assert body["client"]["is_company"] is True
    assert len(body["tasks"]) == 1
    assert body["tasks"][0]["title"] == "Tapis souple X4 bloc"
    assert body["suggested_description"] == "Tapis souple X4 bloc"
    assert body["skipped_lines"] == []
    assert body["existing_project_id"] is None


@pytest.mark.asyncio
async def test_preview_degrades_when_the_contact_call_fails(async_client):
    await _configure(async_client)
    estimate = _estimate("dev-2461-three-services")
    zoho_service.transport = httpx.MockTransport(_books_handler(estimate, contact_status=500))
    body = (await async_client.get(f"/api/v1/zoho/estimates/{estimate['estimate_id']}/preview")).json()
    assert body["client"]["name"] == "SARL Exemple Import"
    assert body["client"]["phone"] is None
    assert len(body["tasks"]) == 1


@pytest.mark.asyncio
async def test_preview_reports_skipped_lines_for_a_retail_quote(async_client):
    await _configure(async_client)
    estimate = _estimate("dev-2463-retail")
    zoho_service.transport = httpx.MockTransport(_books_handler(estimate))
    body = (await async_client.get(f"/api/v1/zoho/estimates/{estimate['estimate_id']}/preview")).json()
    assert body["tasks"] == []
    assert [line["sku"] for line in body["skipped_lines"]] == ["PB05016", "L3DIMP"]


@pytest.mark.asyncio
async def test_preview_flags_an_already_imported_quote(async_client):
    await _configure(async_client)
    estimate = _estimate("dev-2461-three-services")
    created = await async_client.post(
        "/api/v1/aito/",
        json={
            "description": "existing",
            "client_id": "z1",
            "client_name": "ACME",
            "quote_id": estimate["estimate_id"],
        },
    )
    project_id = created.json()["id"]
    zoho_service.transport = httpx.MockTransport(_books_handler(estimate))
    body = (await async_client.get(f"/api/v1/zoho/estimates/{estimate['estimate_id']}/preview")).json()
    assert body["existing_project_id"] == project_id

    # A card in the trash is not a duplicate.
    await async_client.delete(f"/api/v1/aito/{project_id}")
    body = (await async_client.get(f"/api/v1/zoho/estimates/{estimate['estimate_id']}/preview")).json()
    assert body["existing_project_id"] is None
