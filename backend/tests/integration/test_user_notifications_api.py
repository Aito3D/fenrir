"""Integration tests for User Notifications API endpoints.

Tests the full request/response cycle for /api/v1/user-notifications/ endpoints.
"""

import pytest
from httpx import AsyncClient

from backend.tests.integration.test_printer_scope_1727 import _admin_token, _auth, _group


class TestUserNotificationsAPI:
    """Integration tests for /api/v1/user-notifications/ endpoints."""

    # ========================================================================
    # GET /preferences — no auth
    # ========================================================================

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_preferences_returns_defaults_when_no_auth(self, async_client: AsyncClient):
        """Without auth, GET should return all-enabled defaults."""
        response = await async_client.get("/api/v1/user-notifications/preferences")

        assert response.status_code == 200
        data = response.json()
        assert data["notify_print_start"] is True
        assert data["notify_print_complete"] is True
        assert data["notify_print_failed"] is True
        assert data["notify_print_stopped"] is True

    # ========================================================================
    # PUT /preferences — no auth
    # ========================================================================

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_preferences_fails_without_auth(self, async_client: AsyncClient):
        """Without auth enabled, PUT should return 400 (no user context)."""
        data = {
            "notify_print_start": False,
            "notify_print_complete": True,
            "notify_print_failed": True,
            "notify_print_stopped": False,
        }

        response = await async_client.put("/api/v1/user-notifications/preferences", json=data)

        assert response.status_code == 400
        assert "Authentication must be enabled" in response.json()["detail"]

    # ========================================================================
    # Schema validation
    # ========================================================================

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_preferences_rejects_missing_fields(self, async_client: AsyncClient):
        """PUT should reject requests missing required boolean fields."""
        data = {
            "notify_print_start": True,
            # missing other fields
        }

        response = await async_client.put("/api/v1/user-notifications/preferences", json=data)

        assert response.status_code == 422  # Pydantic validation error

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_update_preferences_rejects_invalid_type(self, async_client: AsyncClient):
        """PUT should reject values that cannot be coerced to boolean."""
        data = {
            "notify_print_start": [1, 2, 3],
            "notify_print_complete": True,
            "notify_print_failed": True,
            "notify_print_stopped": True,
        }

        response = await async_client.put("/api/v1/user-notifications/preferences", json=data)

        assert response.status_code == 422


URL = "/api/v1/user-notifications/preferences"
ALL_ON = {
    "notify_print_start": True,
    "notify_print_complete": True,
    "notify_print_failed": True,
    "notify_print_stopped": True,
}


async def _member(client: AsyncClient, permissions: list[str], email: str | None) -> dict[str, str]:
    admin = await _admin_token(client)
    group = await _group(client, admin, "g", permissions=permissions)
    body = {"username": "mailer", "password": "UserPass1!", "group_ids": [group]}
    if email:
        body["email"] = email
    created = await client.post("/api/v1/users/", headers=_auth(admin), json=body)
    assert created.status_code in (200, 201), created.text
    login = await client.post("/api/v1/auth/login", json={"username": "mailer", "password": "UserPass1!"})
    assert login.status_code == 200, login.text
    return _auth(login.json()["access_token"])


class TestUserNotificationsAuthenticated:
    """GET/PUT /preferences with auth enabled and a real user."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_returns_defaults_when_no_row(self, async_client: AsyncClient):
        headers = await _member(async_client, ["notifications:user_email"], "m@example.com")

        response = await async_client.get(URL, headers=headers)

        assert response.status_code == 200
        assert response.json() == ALL_ON

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_put_creates_then_updates_same_row(self, async_client: AsyncClient, db_session):
        from sqlalchemy import select

        from backend.app.models.user_email_pref import UserEmailPreference

        headers = await _member(async_client, ["notifications:user_email"], "m@example.com")
        first = {**ALL_ON, "notify_print_start": False, "notify_print_stopped": False}
        second = {**ALL_ON, "notify_print_complete": False}

        created = await async_client.put(URL, headers=headers, json=first)
        assert created.status_code == 200
        assert created.json() == first
        assert (await async_client.get(URL, headers=headers)).json() == first

        updated = await async_client.put(URL, headers=headers, json=second)
        assert updated.status_code == 200
        assert updated.json() == second
        assert (await async_client.get(URL, headers=headers)).json() == second
        rows = (await db_session.execute(select(UserEmailPreference))).scalars().all()
        assert len(rows) == 1

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_put_rejects_user_without_email(self, async_client: AsyncClient):
        headers = await _member(async_client, ["notifications:user_email"], None)

        response = await async_client.put(URL, headers=headers, json=ALL_ON)

        assert response.status_code == 400
        assert response.json()["detail"] == "User must have an email address to receive notifications"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_user_without_permission_gets_403(self, async_client: AsyncClient):
        headers = await _member(async_client, ["printers:read"], "m@example.com")

        assert (await async_client.get(URL, headers=headers)).status_code == 403
        assert (await async_client.put(URL, headers=headers, json=ALL_ON)).status_code == 403

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_unauthenticated_request_is_rejected_when_auth_enabled(self, async_client: AsyncClient):
        await _admin_token(async_client)

        assert (await async_client.get(URL)).status_code == 401
        assert (await async_client.put(URL, json=ALL_ON)).status_code == 401
