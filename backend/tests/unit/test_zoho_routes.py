"""Zoho proxy routes: status flags and contact search error mapping."""

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


async def _configure(async_client):
    await async_client.put(
        "/api/v1/settings/",
        json={
            "zoho_client_id": "1000.FAKE",
            "zoho_client_secret": "fake-secret",
            "zoho_refresh_token": "1000.fake.refresh",
            "zoho_organization_id": "999",
        },
    )


@pytest.mark.asyncio
async def test_status_unconfigured(async_client):
    r = await async_client.get("/api/v1/zoho/status")
    assert r.status_code == 200
    assert r.json() == {"configured": False, "reachable": False}


@pytest.mark.asyncio
async def test_status_configured_reachable(async_client):
    await _configure(async_client)
    zoho_service.transport = httpx.MockTransport(
        lambda request: httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
    )
    assert (await async_client.get("/api/v1/zoho/status")).json() == {"configured": True, "reachable": True}


@pytest.mark.asyncio
async def test_contacts_409_when_unconfigured(async_client):
    assert (await async_client.get("/api/v1/zoho/contacts?q=ac")).status_code == 409


@pytest.mark.asyncio
async def test_contacts_min_query_length(async_client):
    await _configure(async_client)
    assert (await async_client.get("/api/v1/zoho/contacts?q=a")).status_code == 422


@pytest.mark.asyncio
async def test_contacts_search_and_upstream_error(async_client):
    await _configure(async_client)

    def ok_handler(request: httpx.Request) -> httpx.Response:
        if "/oauth/v2/token" in str(request.url):
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
        return httpx.Response(
            200,
            json={
                "contacts": [
                    {
                        "contact_id": "z1",
                        "contact_name": "ACME",
                        "company_name": "",
                        "phone": "01",
                        "mobile": "",
                        "email": "",
                    }
                ]
            },
        )

    zoho_service.transport = httpx.MockTransport(ok_handler)
    r = await async_client.get("/api/v1/zoho/contacts?q=acm")
    assert r.status_code == 200
    assert r.json()[0] == {"id": "z1", "name": "ACME", "company_name": "", "phone": "01", "mobile": "", "email": ""}

    zoho_service.invalidate_token()
    zoho_service.transport = httpx.MockTransport(lambda request: httpx.Response(500))
    assert (await async_client.get("/api/v1/zoho/contacts?q=acm")).status_code == 502
