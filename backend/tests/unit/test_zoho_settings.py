"""Zoho credentials in settings: persisted, but secrets never returned."""

from datetime import datetime, timezone

import pytest

from backend.app.services import zoho_filaments


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


@pytest.mark.asyncio
async def test_changing_credentials_drops_the_cached_filament_catalogue(async_client):
    """Rotating an organization must not keep serving the old org's filaments.

    The catalogue is cached in-process for ~10 minutes, so without this the
    calculator's product search — and the price sync that reuses the same
    fetch — would answer from the previous organization for the rest of the
    window.
    """
    zoho_filaments._cache = []
    zoho_filaments._cache_at = datetime.now(timezone.utc)
    try:
        r = await async_client.put("/api/v1/settings/", json={"zoho_organization_id": "999"})
        assert r.status_code == 200
        assert zoho_filaments._cache is None
        assert zoho_filaments._cache_at is None
    finally:
        zoho_filaments.reset_cache()


@pytest.mark.asyncio
async def test_an_unrelated_settings_change_keeps_the_cache(async_client):
    """Only Zoho keys invalidate it — every save must not cost a Zoho refetch."""
    zoho_filaments._cache = []
    zoho_filaments._cache_at = datetime.now(timezone.utc)
    try:
        r = await async_client.put("/api/v1/settings/", json={"energy_cost_per_kwh": 42.0})
        assert r.status_code == 200
        assert zoho_filaments._cache == []
    finally:
        zoho_filaments.reset_cache()
