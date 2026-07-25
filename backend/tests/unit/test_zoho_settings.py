"""Zoho credentials in settings: persisted, but secrets never returned."""

import pytest


@pytest.mark.asyncio
async def test_zoho_secrets_never_returned(async_client):
    r = await async_client.put(
        "/api/v1/settings/",
        json={
            "zoho_client_id": "1000.FAKECLIENTID",
            "zoho_client_secret": "fake-secret",
            "zoho_refresh_token": "1000.fake.refresh",
            "zoho_organization_id": "12345",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["zoho_client_id"] == "1000.FAKECLIENTID"
    assert body["zoho_organization_id"] == "12345"
    assert body["zoho_client_secret"] == ""
    assert body["zoho_refresh_token"] == ""

    body2 = (await async_client.get("/api/v1/settings/")).json()
    assert body2["zoho_client_secret"] == ""
    assert body2["zoho_refresh_token"] == ""
    assert body2["zoho_base_url"] == "https://www.zohoapis.eu"
    assert body2["zoho_accounts_url"] == "https://accounts.zoho.eu"
