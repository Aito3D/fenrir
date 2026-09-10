"""Integration tests for Advanced Authentication API endpoints.

Tests the full request/response cycle for SMTP configuration, advanced auth toggle,
email-based login, forgot password, admin password reset, and user creation
with advanced authentication enabled.
"""

import asyncio
from unittest.mock import patch

import pytest
from httpx import AsyncClient

# Shared SMTP settings data used across test classes
SMTP_DATA = {
    "smtp_host": "smtp.test.com",
    "smtp_port": 587,
    "smtp_username": "test@test.com",
    "smtp_password": "testpass",
    "smtp_security": "starttls",
    "smtp_auth_enabled": True,
    "smtp_from_email": "noreply@test.com",
}


async def _setup_admin(async_client: AsyncClient, username: str = "admin", password: str = "AdminPass1!"):
    """Enable auth and create admin user, return admin token."""
    await async_client.post(
        "/api/v1/auth/setup",
        json={
            "auth_enabled": True,
            "admin_username": username,
            "admin_password": password,
        },
    )
    login = await async_client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": password},
    )
    return login.json()["access_token"]


async def _setup_smtp_and_advanced_auth(async_client: AsyncClient, token: str):
    """Configure SMTP and enable advanced auth. Must mock send_email externally."""
    headers = {"Authorization": f"Bearer {token}"}
    await async_client.post("/api/v1/auth/smtp", headers=headers, json=SMTP_DATA)
    await async_client.post("/api/v1/auth/advanced-auth/enable", headers=headers)


async def _create_regular_user(
    async_client: AsyncClient, token: str, username: str = "regular", password: str = "Regularpass1!"
):
    """Create a regular (non-admin) user and return their token."""
    headers = {"Authorization": f"Bearer {token}"}
    await async_client.post(
        "/api/v1/users/",
        headers=headers,
        json={"username": username, "password": password, "role": "user"},
    )
    login = await async_client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": password},
    )
    return login.json()["access_token"]


class TestSMTPConfigAPI:
    """Integration tests for SMTP configuration endpoints."""

    @pytest.fixture
    async def admin_token(self, async_client: AsyncClient):
        return await _setup_admin(async_client, "smtpadmin", "AdminPass1!")

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_save_smtp_settings(self, async_client: AsyncClient, admin_token: str):
        """POST /auth/smtp with valid settings returns 200."""
        response = await async_client.post(
            "/api/v1/auth/smtp",
            headers={"Authorization": f"Bearer {admin_token}"},
            json=SMTP_DATA,
        )
        assert response.status_code == 200
        assert "saved" in response.json()["message"].lower() or "success" in response.json()["message"].lower()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_smtp_settings_masks_password(self, async_client: AsyncClient, admin_token: str):
        """GET /auth/smtp returns settings with password masked (None)."""
        headers = {"Authorization": f"Bearer {admin_token}"}
        # Save settings first
        await async_client.post("/api/v1/auth/smtp", headers=headers, json=SMTP_DATA)

        response = await async_client.get("/api/v1/auth/smtp", headers=headers)
        assert response.status_code == 200
        result = response.json()
        assert result["smtp_host"] == "smtp.test.com"
        assert result["smtp_password"] is None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_smtp_settings_requires_admin(self, async_client: AsyncClient, admin_token: str):
        """Non-admin user gets 403 on SMTP endpoints."""
        user_token = await _create_regular_user(async_client, admin_token, "smtpregular", "Pass12345!")
        headers = {"Authorization": f"Bearer {user_token}"}

        response = await async_client.post("/api/v1/auth/smtp", headers=headers, json=SMTP_DATA)
        assert response.status_code == 403

        response = await async_client.get("/api/v1/auth/smtp", headers=headers)
        assert response.status_code == 403

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_save_smtp_settings_no_auth(self, async_client: AsyncClient, admin_token: str):
        """No token on SMTP save returns 401."""
        response = await async_client.post("/api/v1/auth/smtp", json=SMTP_DATA)
        assert response.status_code == 401

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_test_smtp_connection(self, async_client: AsyncClient, admin_token: str):
        """POST /auth/smtp/test with mocked send_email returns success."""
        await async_client.post(
            "/api/v1/auth/smtp",
            headers={"Authorization": f"Bearer {admin_token}"},
            json=SMTP_DATA,
        )

        with patch("backend.app.api.routes.auth.send_email"):
            response = await async_client.post(
                "/api/v1/auth/smtp/test",
                headers={"Authorization": f"Bearer {admin_token}"},
                json={
                    "test_recipient": "recipient@test.com",
                },
            )
        assert response.status_code == 200
        assert response.json()["success"] is True


class TestAdvancedAuthToggleAPI:
    """Integration tests for enabling/disabling advanced authentication."""

    @pytest.fixture
    async def admin_token(self, async_client: AsyncClient):
        return await _setup_admin(async_client, "toggleadmin", "AdminPass1!")

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_enable_advanced_auth(self, async_client: AsyncClient, admin_token: str):
        """Enable advanced auth after SMTP is configured returns 200."""
        headers = {"Authorization": f"Bearer {admin_token}"}
        # Configure SMTP first
        await async_client.post("/api/v1/auth/smtp", headers=headers, json=SMTP_DATA)

        response = await async_client.post("/api/v1/auth/advanced-auth/enable", headers=headers)
        assert response.status_code == 200
        assert response.json()["advanced_auth_enabled"] is True

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_enable_advanced_auth_without_smtp(self, async_client: AsyncClient, admin_token: str):
        """Enable advanced auth without SMTP configured returns 400."""
        headers = {"Authorization": f"Bearer {admin_token}"}
        response = await async_client.post("/api/v1/auth/advanced-auth/enable", headers=headers)
        assert response.status_code == 400
        assert "SMTP" in response.json()["detail"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_disable_advanced_auth(self, async_client: AsyncClient, admin_token: str):
        """Disable advanced auth returns 200."""
        headers = {"Authorization": f"Bearer {admin_token}"}
        # Enable first
        await async_client.post("/api/v1/auth/smtp", headers=headers, json=SMTP_DATA)
        await async_client.post("/api/v1/auth/advanced-auth/enable", headers=headers)

        response = await async_client.post("/api/v1/auth/advanced-auth/disable", headers=headers)
        assert response.status_code == 200
        assert response.json()["advanced_auth_enabled"] is False

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_advanced_auth_status_public(self, async_client: AsyncClient, admin_token: str):
        """GET /auth/advanced-auth/status is accessible without token."""
        response = await async_client.get("/api/v1/auth/advanced-auth/status")
        assert response.status_code == 200
        result = response.json()
        assert "advanced_auth_enabled" in result
        assert "smtp_configured" in result

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_enable_requires_admin(self, async_client: AsyncClient, admin_token: str):
        """Non-admin user gets 403 on enable/disable."""
        user_token = await _create_regular_user(async_client, admin_token, "toggleregular", "Pass12345!")
        headers = {"Authorization": f"Bearer {user_token}"}

        response = await async_client.post("/api/v1/auth/advanced-auth/enable", headers=headers)
        assert response.status_code == 403

        response = await async_client.post("/api/v1/auth/advanced-auth/disable", headers=headers)
        assert response.status_code == 403


class TestEmailLoginAPI:
    """Integration tests for email-based login."""

    @pytest.fixture
    async def admin_token(self, async_client: AsyncClient):
        return await _setup_admin(async_client, "emailadmin", "AdminPass1!")

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_login_with_email(self, async_client: AsyncClient, admin_token: str):
        """Login with email address when advanced auth is enabled returns token."""
        headers = {"Authorization": f"Bearer {admin_token}"}

        with patch("backend.app.api.routes.users.send_email"):
            # Configure SMTP + advanced auth
            await _setup_smtp_and_advanced_auth(async_client, admin_token)

            # Create user with email (password auto-generated, so we set one explicitly via update)
            create_resp = await async_client.post(
                "/api/v1/users/",
                headers=headers,
                json={"username": "emailuser", "email": "emailuser@test.com", "role": "user"},
            )
            assert create_resp.status_code == 201
            user_id = create_resp.json()["id"]

            # Set a known password via admin update
            await async_client.patch(
                f"/api/v1/users/{user_id}",
                headers=headers,
                json={"password": "Knownpassword1!"},
            )

        # Login with email
        response = await async_client.post(
            "/api/v1/auth/login",
            json={"username": "emailuser@test.com", "password": "Knownpassword1!"},
        )
        assert response.status_code == 200
        assert "access_token" in response.json()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_login_with_email_case_insensitive(self, async_client: AsyncClient, admin_token: str):
        """Login with uppercase email matches case-insensitively."""
        headers = {"Authorization": f"Bearer {admin_token}"}

        with patch("backend.app.api.routes.users.send_email"):
            await _setup_smtp_and_advanced_auth(async_client, admin_token)

            create_resp = await async_client.post(
                "/api/v1/users/",
                headers=headers,
                json={"username": "caseuser", "email": "caseuser@test.com", "role": "user"},
            )
            user_id = create_resp.json()["id"]
            await async_client.patch(
                f"/api/v1/users/{user_id}",
                headers=headers,
                json={"password": "Casepassword1!"},
            )

        response = await async_client.post(
            "/api/v1/auth/login",
            json={"username": "CASEUSER@TEST.COM", "password": "Casepassword1!"},
        )
        assert response.status_code == 200
        assert "access_token" in response.json()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_login_with_email_advanced_auth_disabled(self, async_client: AsyncClient, admin_token: str):
        """Email login fails when advanced auth is disabled."""
        headers = {"Authorization": f"Bearer {admin_token}"}

        # Create user with email but no advanced auth
        await async_client.post(
            "/api/v1/users/",
            headers=headers,
            json={"username": "noemail", "password": "NoEmailPass1!", "email": "noemail@test.com", "role": "user"},
        )

        # Try to login with email — should fail since advanced auth is off
        response = await async_client.post(
            "/api/v1/auth/login",
            json={"username": "noemail@test.com", "password": "NoEmailPass1!"},
        )
        assert response.status_code == 401

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_login_with_username_still_works(self, async_client: AsyncClient, admin_token: str):
        """Username-based login still works when advanced auth is enabled."""
        headers = {"Authorization": f"Bearer {admin_token}"}

        with patch("backend.app.api.routes.users.send_email"):
            await _setup_smtp_and_advanced_auth(async_client, admin_token)

            create_resp = await async_client.post(
                "/api/v1/users/",
                headers=headers,
                json={"username": "usernameuser", "email": "usernameuser@test.com", "role": "user"},
            )
            user_id = create_resp.json()["id"]
            await async_client.patch(
                f"/api/v1/users/{user_id}",
                headers=headers,
                json={"password": "Usernamepass1!"},
            )

        # Login with username (not email)
        response = await async_client.post(
            "/api/v1/auth/login",
            json={"username": "usernameuser", "password": "Usernamepass1!"},
        )
        assert response.status_code == 200
        assert "access_token" in response.json()


class TestForgotPasswordAPI:
    """Integration tests for forgot-password flow."""

    @pytest.fixture
    async def admin_token(self, async_client: AsyncClient):
        return await _setup_admin(async_client, "forgotadmin", "AdminPass1!")

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_forgot_password_sends_email(self, async_client: AsyncClient, admin_token: str):
        """POST /auth/forgot-password with valid email sends reset email."""
        headers = {"Authorization": f"Bearer {admin_token}"}

        with patch("backend.app.api.routes.users.send_email"):
            await _setup_smtp_and_advanced_auth(async_client, admin_token)

            # Create a user with email
            create_resp = await async_client.post(
                "/api/v1/users/",
                headers=headers,
                json={"username": "forgotuser", "email": "forgot@test.com", "role": "user"},
            )
            assert create_resp.status_code == 201

        with patch("backend.app.api.routes.auth.send_email") as mock_send:
            response = await async_client.post(
                "/api/v1/auth/forgot-password",
                json={"email": "forgot@test.com"},
            )

        assert response.status_code == 200
        mock_send.assert_called_once()
        # Verify the email was sent to the right address
        assert mock_send.call_args[0][1] == "forgot@test.com"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_forgot_password_unknown_email(self, async_client: AsyncClient, admin_token: str):
        """Unknown email still returns 200 (anti-enumeration) but send_email not called."""
        headers = {"Authorization": f"Bearer {admin_token}"}
        await async_client.post("/api/v1/auth/smtp", headers=headers, json=SMTP_DATA)
        await async_client.post("/api/v1/auth/advanced-auth/enable", headers=headers)

        with patch("backend.app.api.routes.auth.send_email") as mock_send:
            response = await async_client.post(
                "/api/v1/auth/forgot-password",
                json={"email": "unknown@test.com"},
            )

        assert response.status_code == 200
        mock_send.assert_not_called()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_forgot_password_requires_advanced_auth(self, async_client: AsyncClient, admin_token: str):
        """Forgot password returns 400 when advanced auth is disabled."""
        response = await async_client.post(
            "/api/v1/auth/forgot-password",
            json={"email": "test@test.com"},
        )
        assert response.status_code == 400
        assert "not enabled" in response.json()["detail"].lower()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_forgot_password_changes_password(self, async_client: AsyncClient, admin_token: str):
        """After forgot-password + confirm, old password stops working and new one works.

        H-6: The flow is now token-based: /forgot-password issues a reset link and
        /forgot-password/confirm consumes the token and sets the new password.
        """
        from unittest.mock import AsyncMock

        headers = {"Authorization": f"Bearer {admin_token}"}

        with patch("backend.app.api.routes.users.send_email"):
            await _setup_smtp_and_advanced_auth(async_client, admin_token)

            create_resp = await async_client.post(
                "/api/v1/users/",
                headers=headers,
                json={"username": "resetme", "email": "resetme@test.com", "role": "user"},
            )
            user_id = create_resp.json()["id"]
            await async_client.patch(
                f"/api/v1/users/{user_id}",
                headers=headers,
                json={"password": "Originalpass1!"},
            )

        # Verify login works with original password
        login_resp = await async_client.post(
            "/api/v1/auth/login",
            json={"username": "resetme", "password": "Originalpass1!"},
        )
        assert login_resp.status_code == 200

        # Trigger forgot-password and capture the reset URL (contains the token)
        captured: dict[str, str] = {}

        async def _capture_link_email(db, username, reset_url):
            captured["reset_url"] = reset_url
            return ("subject", "body", "<body/>")

        with (
            patch(
                "backend.app.api.routes.auth.create_password_reset_link_email_from_template",
                side_effect=_capture_link_email,
            ),
            patch("backend.app.api.routes.auth.send_email"),
        ):
            resp = await async_client.post(
                "/api/v1/auth/forgot-password",
                json={"email": "resetme@test.com"},
            )
        assert resp.status_code == 200
        assert "reset_url" in captured, "Reset URL not captured — email function was not called"

        # Extract the token from the captured URL and confirm the reset
        reset_token = captured["reset_url"].split("reset_token=")[1]
        confirm_resp = await async_client.post(
            "/api/v1/auth/forgot-password/confirm",
            json={"token": reset_token, "new_password": "Newpass456!"},
        )
        assert confirm_resp.status_code == 200

        # Old password should no longer work
        login_resp = await async_client.post(
            "/api/v1/auth/login",
            json={"username": "resetme", "password": "Originalpass1!"},
        )
        assert login_resp.status_code == 401

        # New password must work
        login_resp = await async_client.post(
            "/api/v1/auth/login",
            json={"username": "resetme", "password": "Newpass456!"},
        )
        assert login_resp.status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_forgot_password_reissue_invalidates_previous_token(
        self, async_client: AsyncClient, admin_token: str
    ):
        """A second forgot-password request invalidates the token from the first.

        T-027: covers the outstanding-token prune performed by the shared
        _issue_password_reset_email() helper — without it, an older reset link
        would remain valid forever after a newer one is issued.
        """
        headers = {"Authorization": f"Bearer {admin_token}"}

        with patch("backend.app.api.routes.users.send_email"):
            await _setup_smtp_and_advanced_auth(async_client, admin_token)
            create_resp = await async_client.post(
                "/api/v1/users/",
                headers=headers,
                json={"username": "reissueme", "email": "reissueme@test.com", "role": "user"},
            )
            assert create_resp.status_code == 201

        captured: list[str] = []

        async def _capture_link_email(db, username, reset_url):
            captured.append(reset_url)
            return ("subject", "body", "<body/>")

        with (
            patch(
                "backend.app.api.routes.auth.create_password_reset_link_email_from_template",
                side_effect=_capture_link_email,
            ),
            patch("backend.app.api.routes.auth.send_email"),
        ):
            first_resp = await async_client.post(
                "/api/v1/auth/forgot-password",
                json={"email": "reissueme@test.com"},
            )
            assert first_resp.status_code == 200
            second_resp = await async_client.post(
                "/api/v1/auth/forgot-password",
                json={"email": "reissueme@test.com"},
            )
            assert second_resp.status_code == 200

        assert len(captured) == 2, "Both forgot-password requests should have queued an email"
        first_token = captured[0].split("reset_token=")[1]
        second_token = captured[1].split("reset_token=")[1]

        # The first (superseded) token must now be rejected...
        stale_resp = await async_client.post(
            "/api/v1/auth/forgot-password/confirm",
            json={"token": first_token, "new_password": "Stalepass1!"},
        )
        assert stale_resp.status_code == 400

        # ...while the second (current) token still works.
        fresh_resp = await async_client.post(
            "/api/v1/auth/forgot-password/confirm",
            json={"token": second_token, "new_password": "Freshpass1!"},
        )
        assert fresh_resp.status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_forgot_password_confirm_rejects_expired_token(
        self, async_client: AsyncClient, admin_token: str, db_session
    ):
        """An expired (but not yet consumed) reset token must be rejected.

        T-034: covers the `now > expires_at` branch in forgot_password_confirm,
        distinct from the already-consumed (row is None) branch.
        """
        import secrets
        from datetime import datetime, timedelta, timezone

        from backend.app.core.auth import get_password_hash
        from backend.app.models.auth_ephemeral import AuthEphemeralToken
        from backend.app.models.user import User

        # admin_token's fixture already called /auth/setup, enabling auth.
        user = User(
            username="expiredreset",
            email="expiredreset@test.com",
            password_hash=get_password_hash("Originalpass1!"),
            role="user",
            is_active=True,
        )
        db_session.add(user)
        await db_session.flush()

        expired_token = secrets.token_urlsafe(32)
        db_session.add(
            AuthEphemeralToken.new_password_reset(
                token=expired_token,
                username="expiredreset",
                expires_at=datetime.now(timezone.utc) - timedelta(hours=1),
            )
        )
        await db_session.commit()

        response = await async_client.post(
            "/api/v1/auth/forgot-password/confirm",
            json={"token": expired_token, "new_password": "Newpass456!"},
        )
        assert response.status_code == 400
        assert response.json()["detail"] == "Invalid or expired password reset token"

        # Password must remain unchanged
        login_resp = await async_client.post(
            "/api/v1/auth/login",
            json={"username": "expiredreset", "password": "Originalpass1!"},
        )
        assert login_resp.status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_forgot_password_send_runs_off_event_loop_and_deletes_token_on_failure(
        self, async_client: AsyncClient, admin_token: str, caplog, db_session
    ):
        """T-045: the blocking send_email() call must run off the event loop.

        _send_reset_email_or_delete_token is `async def` and registered via
        BackgroundTasks — Starlette awaits it directly rather than running it
        in a threadpool, so send_email() must itself be dispatched to a worker
        thread (asyncio.to_thread) to avoid freezing the loop for every other
        in-flight request. This also re-confirms the existing "delete the
        token on send failure" except-branch still fires (same exception
        handling, logged the same way) when the send is dispatched this way.
        """
        import logging
        import threading

        headers = {"Authorization": f"Bearer {admin_token}"}

        with patch("backend.app.api.routes.users.send_email"):
            await _setup_smtp_and_advanced_auth(async_client, admin_token)
            create_resp = await async_client.post(
                "/api/v1/users/",
                headers=headers,
                json={"username": "offloop", "email": "offloop@test.com", "role": "user"},
            )
            assert create_resp.status_code == 201

        captured: dict[str, object] = {}

        async def _capture_link_email(db, username, reset_url):
            captured["reset_url"] = reset_url
            # T-054: record whether the token row exists *before* the send
            # (and its failure-branch delete) runs, using the same
            # request-scoped session the endpoint just committed the token
            # with. This is the positive-evidence half of the deletion proof
            # — without it, "no row found" after the request could be
            # vacuously true even if the delete never touched anything.
            from sqlalchemy import select

            from backend.app.models.auth_ephemeral import AuthEphemeralToken

            reset_token = reset_url.rsplit("#reset_token=", 1)[1]
            result = await db.execute(select(AuthEphemeralToken).where(AuthEphemeralToken.token == reset_token))
            captured["existed_before_send"] = result.scalar_one_or_none() is not None
            return ("subject", "body", "<body/>")

        recorded: dict[str, object] = {}

        def _recording_send_email(*args, **kwargs):
            recorded["off_main_thread"] = threading.current_thread() is not threading.main_thread()
            try:
                asyncio.get_running_loop()
                recorded["loop_visible"] = True
            except RuntimeError:
                recorded["loop_visible"] = False
            # Simulate an SMTP failure to also exercise the token-deletion path.
            raise RuntimeError("smtp relay unreachable")

        with (
            patch(
                "backend.app.api.routes.auth.create_password_reset_link_email_from_template",
                side_effect=_capture_link_email,
            ),
            patch("backend.app.api.routes.auth.send_email", side_effect=_recording_send_email) as mock_send,
            caplog.at_level(logging.ERROR, logger="backend.app.api.routes.auth"),
        ):
            response = await async_client.post(
                "/api/v1/auth/forgot-password",
                json={"email": "offloop@test.com"},
            )

        assert response.status_code == 200
        mock_send.assert_called_once()
        assert "reset_url" in captured, "Reset URL not captured — email function was not called"

        # The blocking call must have run off the event loop's thread, with no
        # running loop visible from inside it (proof it's a real worker thread,
        # not just an awaited coroutine on the same thread).
        assert recorded.get("off_main_thread") is True
        assert recorded.get("loop_visible") is False

        # The send failure must still be caught by the except branch and trigger
        # the same "delete token to unblock re-request" cleanup attempt/log as
        # before — proving the wrapper's exception handling is unaffected by
        # moving send_email() onto a worker thread.
        failure_logs = [r for r in caplog.records if "deleting token to unblock re-request" in r.getMessage()]
        assert len(failure_logs) == 1
        assert "smtp relay unreachable" in failure_logs[0].getMessage()

        # T-054: the log line alone doesn't prove the delete actually happened
        # (the cleanup opens its own DB session — if that session isn't bound
        # to the test DB, the delete would silently fail against a table that
        # doesn't exist there while still logging the same message). Confirm
        # the token row is genuinely gone, not just that we attempted it.
        #
        # Positive evidence first: the token row must have existed before the
        # failure branch ran the delete — otherwise "no row found" below would
        # be vacuously true even if the delete never touched anything.
        assert captured.get("existed_before_send") is True, (
            "reset token row was never created — the deletion check below would be vacuous"
        )

        reset_token = captured["reset_url"].rsplit("#reset_token=", 1)[1]

        from sqlalchemy import select

        from backend.app.models.auth_ephemeral import AuthEphemeralToken

        remaining = await db_session.execute(select(AuthEphemeralToken).where(AuthEphemeralToken.token == reset_token))
        assert remaining.scalar_one_or_none() is None, "reset token row was not deleted after the send failure"

        confirm_resp = await async_client.post(
            "/api/v1/auth/forgot-password/confirm",
            json={"token": reset_token, "new_password": "Wontwork1!"},
        )
        assert confirm_resp.status_code == 400
        assert confirm_resp.json()["detail"] == "Invalid or expired password reset token"


class TestForgotPasswordRateLimitEquivalence:
    """T-051: the per-email PASSWORD_RESET_SEND rate-limit event must be staged
    for every /forgot-password request, regardless of whether the email
    belongs to a real, active, local account. Staging it only inside the
    user-exists branch made the resulting 429 an account-existence oracle —
    a local account's address got rate-limited after N attempts while an
    unknown or SSO-only address never did.
    """

    @pytest.fixture
    async def admin_token(self, async_client: AsyncClient):
        return await _setup_admin(async_client, "ratelimitadmin", "AdminPass1!")

    @staticmethod
    async def _submit(async_client: AsyncClient, email: str, count: int):
        """POST /auth/forgot-password `count` times for `email`, return the responses."""
        responses = []
        with patch("backend.app.api.routes.auth.send_email"):
            for _ in range(count):
                responses.append(await async_client.post("/api/v1/auth/forgot-password", json={"email": email}))
        return responses

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_unknown_email_hits_same_429_as_known_email(self, async_client: AsyncClient, admin_token: str):
        """An unknown email submitted N+1 (4) times gets the byte-identical 429
        response a known local account's email gets at the same count."""
        headers = {"Authorization": f"Bearer {admin_token}"}
        await _setup_smtp_and_advanced_auth(async_client, admin_token)

        create_resp = await async_client.post(
            "/api/v1/users/",
            headers=headers,
            json={"username": "ratelimitknown", "email": "ratelimitknown@test.com", "role": "user"},
        )
        assert create_resp.status_code == 201

        known_responses = await self._submit(async_client, "ratelimitknown@test.com", 4)
        unknown_responses = await self._submit(async_client, "ratelimitunknown@test.com", 4)

        assert [r.status_code for r in known_responses] == [200, 200, 200, 429]
        assert [r.status_code for r in unknown_responses] == [200, 200, 200, 429]

        # The 4th response's body must be byte-identical whether the account
        # exists or not — this is what makes the 429 non-oracle-able.
        assert unknown_responses[3].text == known_responses[3].text
        assert unknown_responses[3].json()["detail"] == "Too many password reset requests. Please wait 15 minutes."

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_sso_only_email_hits_same_429(self, async_client: AsyncClient, admin_token: str, db_session):
        """An OIDC-sourced user's email — for which no reset email is ever sent —
        is rate-limited exactly like a real local account's email."""
        from backend.app.core.auth import get_password_hash
        from backend.app.models.user import User

        await _setup_smtp_and_advanced_auth(async_client, admin_token)

        oidc_user = User(
            username="ratelimitoidc",
            email="ratelimitoidc@test.com",
            auth_source="oidc",
            password_hash=get_password_hash("irrelevant"),
            role="user",
            is_active=True,
        )
        db_session.add(oidc_user)
        await db_session.commit()

        responses = await self._submit(async_client, "ratelimitoidc@test.com", 4)
        assert [r.status_code for r in responses] == [200, 200, 200, 429]
        assert responses[3].json()["detail"] == "Too many password reset requests. Please wait 15 minutes."

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_unknown_email_rate_limit_is_per_address(self, async_client: AsyncClient, admin_token: str):
        """Exhausting one unknown email's per-email slots does not rate-limit a
        different, unrelated email address."""
        await _setup_smtp_and_advanced_auth(async_client, admin_token)

        exhausted = await self._submit(async_client, "ratelimitexhausted@test.com", 4)
        assert exhausted[3].status_code == 429

        other = await self._submit(async_client, "ratelimitother@test.com", 1)
        assert other[0].status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_generic_200_body_unchanged_before_limit(self, async_client: AsyncClient, admin_token: str):
        """The first N (3) attempts still return the exact generic
        anti-enumeration message, unaffected by staging the per-email
        rate-limit event earlier in the handler."""
        await _setup_smtp_and_advanced_auth(async_client, admin_token)

        responses = await self._submit(async_client, "ratelimitgeneric@test.com", 3)
        for r in responses:
            assert r.status_code == 200
            assert r.json() == {
                "message": "If the email address is associated with an account, a password reset email has been sent."
            }


class TestAdminResetPasswordAPI:
    """Integration tests for admin password reset endpoint."""

    @pytest.fixture
    async def admin_token(self, async_client: AsyncClient):
        return await _setup_admin(async_client, "resetadmin", "AdminPass1!")

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_reset_password_sends_email(self, async_client: AsyncClient, admin_token: str):
        """POST /auth/reset-password sends email to user."""
        headers = {"Authorization": f"Bearer {admin_token}"}

        with patch("backend.app.api.routes.users.send_email"):
            await _setup_smtp_and_advanced_auth(async_client, admin_token)

            create_resp = await async_client.post(
                "/api/v1/users/",
                headers=headers,
                json={"username": "resetuser", "email": "resetuser@test.com", "role": "user"},
            )
            user_id = create_resp.json()["id"]

        with patch("backend.app.api.routes.auth.send_email") as mock_send:
            response = await async_client.post(
                "/api/v1/auth/reset-password",
                headers=headers,
                json={"user_id": user_id},
            )

        assert response.status_code == 200
        mock_send.assert_called_once()
        assert mock_send.call_args[0][1] == "resetuser@test.com"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_reset_password_reissue_invalidates_previous_token(self, async_client: AsyncClient, admin_token: str):
        """A second admin reset-password request invalidates the token from the first.

        T-027: covers the outstanding-token prune performed by the shared
        _issue_password_reset_email() helper for the admin-reset path.
        """
        headers = {"Authorization": f"Bearer {admin_token}"}

        with patch("backend.app.api.routes.users.send_email"):
            await _setup_smtp_and_advanced_auth(async_client, admin_token)
            create_resp = await async_client.post(
                "/api/v1/users/",
                headers=headers,
                json={"username": "adminreissue", "email": "adminreissue@test.com", "role": "user"},
            )
            user_id = create_resp.json()["id"]

        captured: list[str] = []

        async def _capture_link_email(db, username, reset_url):
            captured.append(reset_url)
            return ("subject", "body", "<body/>")

        with (
            patch(
                "backend.app.api.routes.auth.create_password_reset_link_email_from_template",
                side_effect=_capture_link_email,
            ),
            patch("backend.app.api.routes.auth.send_email"),
        ):
            first_resp = await async_client.post(
                "/api/v1/auth/reset-password",
                headers=headers,
                json={"user_id": user_id},
            )
            assert first_resp.status_code == 200
            second_resp = await async_client.post(
                "/api/v1/auth/reset-password",
                headers=headers,
                json={"user_id": user_id},
            )
            assert second_resp.status_code == 200

        assert len(captured) == 2, "Both reset-password requests should have queued an email"
        first_token = captured[0].split("reset_token=")[1]
        second_token = captured[1].split("reset_token=")[1]

        # The first (superseded) token must now be rejected...
        stale_resp = await async_client.post(
            "/api/v1/auth/forgot-password/confirm",
            json={"token": first_token, "new_password": "Stalepass1!"},
        )
        assert stale_resp.status_code == 400

        # ...while the second (current) token still works.
        fresh_resp = await async_client.post(
            "/api/v1/auth/forgot-password/confirm",
            json={"token": second_token, "new_password": "Freshpass1!"},
        )
        assert fresh_resp.status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_reset_password_requires_admin(self, async_client: AsyncClient, admin_token: str):
        """Non-admin user gets 403 on reset-password."""
        # Create regular user before enabling advanced auth (no email required)
        user_token = await _create_regular_user(async_client, admin_token, "resetregular", "Pass12345!")

        with patch("backend.app.api.routes.users.send_email"):
            await _setup_smtp_and_advanced_auth(async_client, admin_token)

        response = await async_client.post(
            "/api/v1/auth/reset-password",
            headers={"Authorization": f"Bearer {user_token}"},
            json={"user_id": 1},
        )
        assert response.status_code == 403

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_reset_password_requires_advanced_auth(self, async_client: AsyncClient, admin_token: str):
        """Reset password returns 400 when advanced auth is disabled."""
        headers = {"Authorization": f"Bearer {admin_token}"}

        response = await async_client.post(
            "/api/v1/auth/reset-password",
            headers=headers,
            json={"user_id": 999},
        )
        assert response.status_code == 400
        assert "not enabled" in response.json()["detail"].lower()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_reset_password_user_not_found(self, async_client: AsyncClient, admin_token: str):
        """Reset password with invalid user_id returns 404."""
        headers = {"Authorization": f"Bearer {admin_token}"}
        await async_client.post("/api/v1/auth/smtp", headers=headers, json=SMTP_DATA)
        await async_client.post("/api/v1/auth/advanced-auth/enable", headers=headers)

        response = await async_client.post(
            "/api/v1/auth/reset-password",
            headers=headers,
            json={"user_id": 99999},
        )
        assert response.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_reset_password_user_no_email(self, async_client: AsyncClient, admin_token: str):
        """Reset password for user without email returns 400."""
        headers = {"Authorization": f"Bearer {admin_token}"}
        # Save SMTP and enable advanced auth
        await async_client.post("/api/v1/auth/smtp", headers=headers, json=SMTP_DATA)
        await async_client.post("/api/v1/auth/advanced-auth/enable", headers=headers)

        # Disable advanced auth temporarily to create a user without email
        await async_client.post("/api/v1/auth/advanced-auth/disable", headers=headers)
        create_resp = await async_client.post(
            "/api/v1/users/",
            headers=headers,
            json={"username": "noemailuser", "password": "Noemail12345!", "role": "user"},
        )
        user_id = create_resp.json()["id"]

        # Re-enable advanced auth
        await async_client.post("/api/v1/auth/advanced-auth/enable", headers=headers)

        response = await async_client.post(
            "/api/v1/auth/reset-password",
            headers=headers,
            json={"user_id": user_id},
        )
        assert response.status_code == 400
        assert "email" in response.json()["detail"].lower()


class TestUserCreationAdvancedAuth:
    """Integration tests for user creation with advanced auth enabled."""

    @pytest.fixture
    async def admin_token(self, async_client: AsyncClient):
        return await _setup_admin(async_client, "createadmin", "AdminPass1!")

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_create_user_advanced_auth_requires_email(self, async_client: AsyncClient, admin_token: str):
        """Creating user without email when advanced auth is on returns 400."""
        headers = {"Authorization": f"Bearer {admin_token}"}
        await async_client.post("/api/v1/auth/smtp", headers=headers, json=SMTP_DATA)
        await async_client.post("/api/v1/auth/advanced-auth/enable", headers=headers)

        response = await async_client.post(
            "/api/v1/users/",
            headers=headers,
            json={"username": "noemailcreate", "role": "user"},
        )
        assert response.status_code == 400
        assert "email" in response.json()["detail"].lower()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_create_user_advanced_auth_auto_password(self, async_client: AsyncClient, admin_token: str):
        """Creating user with email auto-generates password and sends welcome email."""
        headers = {"Authorization": f"Bearer {admin_token}"}
        await async_client.post("/api/v1/auth/smtp", headers=headers, json=SMTP_DATA)
        await async_client.post("/api/v1/auth/advanced-auth/enable", headers=headers)

        with patch("backend.app.api.routes.users.send_email") as mock_send:
            response = await async_client.post(
                "/api/v1/users/",
                headers=headers,
                json={"username": "autopassuser", "email": "autopass@test.com", "role": "user"},
            )

        assert response.status_code == 201
        result = response.json()
        assert result["username"] == "autopassuser"
        assert result["email"] == "autopass@test.com"
        # Welcome email should have been sent
        mock_send.assert_called_once()
        assert mock_send.call_args[0][1] == "autopass@test.com"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_create_user_duplicate_email(self, async_client: AsyncClient, admin_token: str):
        """Creating two users with the same email returns 400."""
        headers = {"Authorization": f"Bearer {admin_token}"}
        await async_client.post("/api/v1/auth/smtp", headers=headers, json=SMTP_DATA)
        await async_client.post("/api/v1/auth/advanced-auth/enable", headers=headers)

        with patch("backend.app.api.routes.users.send_email"):
            resp1 = await async_client.post(
                "/api/v1/users/",
                headers=headers,
                json={"username": "dupemail1", "email": "dupe@test.com", "role": "user"},
            )
            assert resp1.status_code == 201

            resp2 = await async_client.post(
                "/api/v1/users/",
                headers=headers,
                json={"username": "dupemail2", "email": "dupe@test.com", "role": "user"},
            )

        assert resp2.status_code == 400
        assert "email" in resp2.json()["detail"].lower()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_create_user_response_includes_email(self, async_client: AsyncClient, admin_token: str):
        """Created user response includes email field."""
        headers = {"Authorization": f"Bearer {admin_token}"}
        await async_client.post("/api/v1/auth/smtp", headers=headers, json=SMTP_DATA)
        await async_client.post("/api/v1/auth/advanced-auth/enable", headers=headers)

        with patch("backend.app.api.routes.users.send_email"):
            response = await async_client.post(
                "/api/v1/users/",
                headers=headers,
                json={"username": "emailresp", "email": "emailresp@test.com", "role": "user"},
            )

        assert response.status_code == 201
        result = response.json()
        assert "email" in result
        assert result["email"] == "emailresp@test.com"


# ===========================================================================
# M-1: OIDC/LDAP users must not be able to use the password reset flow
# ===========================================================================


class TestAuthSourcePasswordResetBlocking:
    """Forgot-password must silently skip OIDC and LDAP users (M-1)."""

    @pytest.fixture
    async def admin_token(self, async_client: AsyncClient):
        return await _setup_admin(async_client, "authsrcadmin", "AdminPass1!")

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_forgot_password_silently_skips_oidc_user(
        self, async_client: AsyncClient, admin_token: str, db_session
    ):
        """forgot-password for an OIDC user returns 200 but does NOT send email."""
        from backend.app.core.auth import get_password_hash
        from backend.app.models.user import User

        headers = {"Authorization": f"Bearer {admin_token}"}
        await async_client.post("/api/v1/auth/smtp", headers=headers, json=SMTP_DATA)
        await async_client.post("/api/v1/auth/advanced-auth/enable", headers=headers)

        # Directly insert an OIDC-sourced user into the DB
        oidc_user = User(
            username="oidcpwreset",
            email="oidcpwreset@test.com",
            auth_source="oidc",
            password_hash=get_password_hash("irrelevant"),
            role="user",
            is_active=True,
        )
        db_session.add(oidc_user)
        await db_session.commit()

        with patch("backend.app.api.routes.auth.send_email") as mock_send:
            response = await async_client.post(
                "/api/v1/auth/forgot-password",
                json={"email": "oidcpwreset@test.com"},
            )

        # Anti-enumeration: still returns 200
        assert response.status_code == 200
        # But no email is sent for OIDC users
        mock_send.assert_not_called()
