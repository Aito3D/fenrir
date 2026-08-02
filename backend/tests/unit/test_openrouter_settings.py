"""OpenRouter settings keys: defaults, write-only API key, API-key scrubbing."""

import pytest


@pytest.mark.asyncio
async def test_openrouter_defaults(async_client):
    r = await async_client.get("/api/v1/settings/")
    assert r.status_code == 200
    body = r.json()
    assert body["openrouter_model"] == "mistralai/mistral-small"
    # Write-only: never echoed, even when unset.
    assert body["openrouter_api_key"] == ""


@pytest.mark.asyncio
async def test_openrouter_key_write_only(async_client):
    r = await async_client.put(
        "/api/v1/settings/",
        json={"openrouter_api_key": "sk-or-secret", "openrouter_model": "google/gemini-2.5-flash-lite"},
    )
    assert r.status_code == 200
    r = await async_client.get("/api/v1/settings/")
    assert r.json()["openrouter_api_key"] == ""  # scrubbed on every GET
    assert r.json()["openrouter_model"] == "google/gemini-2.5-flash-lite"
