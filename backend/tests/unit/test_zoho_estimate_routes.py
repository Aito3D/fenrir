"""Zoho estimate search and quote preview: service mapping and route errors."""

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
    assert url == "https://books.zoho.eu/app/999#/estimates/abc"


@pytest.mark.asyncio
async def test_books_app_url_handles_a_multi_part_region(async_client):
    from backend.app.core.database import async_session

    await _configure(async_client, zoho_accounts_url="https://accounts.zoho.com.au")
    async with async_session() as db:
        url = await zoho_service.books_app_url(db, "abc")
    assert url == "https://books.zoho.com.au/app/999#/estimates/abc"


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
