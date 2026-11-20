"""Per-user view settings: /api/v1/users/me/ui-prefs."""

import pytest
from httpx import AsyncClient


async def _token(client: AsyncClient) -> str:
    await client.post(
        "/api/v1/auth/setup",
        json={"auth_enabled": True, "admin_username": "prefsadmin", "admin_password": "AdminPass1!"},
    )
    login = await client.post("/api/v1/auth/login", json={"username": "prefsadmin", "password": "AdminPass1!"})
    return login.json()["access_token"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_saves_each_view_under_its_key_and_reads_them_back(async_client: AsyncClient):
    headers = {"Authorization": f"Bearer {await _token(async_client)}"}
    assert (await async_client.get("/api/v1/users/me/ui-prefs", headers=headers)).json() == {}

    r = await async_client.put("/api/v1/users/me/ui-prefs/orders", json={"pay": "unpaid"}, headers=headers)
    assert r.status_code == 204
    await async_client.put("/api/v1/users/me/ui-prefs/queue", json={"x": 1}, headers=headers)
    await async_client.put("/api/v1/users/me/ui-prefs/orders", json={"sort": "value"}, headers=headers)

    assert (await async_client.get("/api/v1/users/me/ui-prefs", headers=headers)).json() == {
        "orders": {"sort": "value"},
        "queue": {"x": 1},
    }


@pytest.mark.asyncio
@pytest.mark.integration
async def test_refuses_anonymous_bad_keys_and_oversized_values(async_client: AsyncClient):
    headers = {"Authorization": f"Bearer {await _token(async_client)}"}
    assert (await async_client.get("/api/v1/users/me/ui-prefs")).status_code == 401
    bad_key = await async_client.put("/api/v1/users/me/ui-prefs/a%20b", json={}, headers=headers)
    assert bad_key.status_code == 422
    big = await async_client.put("/api/v1/users/me/ui-prefs/orders", json={"x": "y" * 5000}, headers=headers)
    assert big.status_code == 413


@pytest.mark.asyncio
@pytest.mark.integration
async def test_auth_off_has_no_account_to_save_on(async_client: AsyncClient):
    assert (await async_client.get("/api/v1/users/me/ui-prefs")).json() == {}
    assert (await async_client.put("/api/v1/users/me/ui-prefs/orders", json={"a": 1})).status_code == 204
