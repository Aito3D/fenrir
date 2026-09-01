"""Pushcut settings key: default, write-only round trip, stored value intact."""

import pytest

from backend.app.api.routes.settings import get_setting


@pytest.mark.asyncio
async def test_pushcut_url_default_is_empty(async_client):
    r = await async_client.get("/api/v1/settings/")
    assert r.status_code == 200
    assert r.json()["pushcut_sms_url"] == ""


@pytest.mark.asyncio
async def test_pushcut_url_write_only(async_client, db_session):
    """The URL embeds its secret token: a PUT stores it, and no GET — however
    it authenticates — ever echoes it back."""
    r = await async_client.put(
        "/api/v1/settings/",
        json={"pushcut_sms_url": "https://api.pushcut.io/secret-token/notifications/SMS"},
    )
    assert r.status_code == 200
    r = await async_client.get("/api/v1/settings/")
    assert r.json()["pushcut_sms_url"] == ""  # scrubbed on every GET
    # ...while the stored value the relay reads is intact.
    assert await get_setting(db_session, "pushcut_sms_url") == "https://api.pushcut.io/secret-token/notifications/SMS"
