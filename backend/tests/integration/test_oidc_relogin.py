"""E2E test for issue #1285: SSO user can re-login after admin deletion.

Reproduces the exact symptom from the issue: a user logs in via OIDC
(auto_create_users=True), gets created, is then deleted by the admin, and
attempts to log in again. With the fix in delete_user (UserOIDCLink cleanup)
+ the orphan-cleanup migration, the second OIDC callback must trigger
auto_create_users and produce a fresh user — instead of redirecting to
"account_inactive" because of the orphan link.
"""

from __future__ import annotations

import base64
import secrets
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import httpx
import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.auth_ephemeral import AuthEphemeralToken
from backend.app.models.oidc_provider import UserOIDCLink
from backend.app.models.user import User


def _make_rsa_key():
    """Throwaway RSA + JWKS for the mocked IdP."""
    priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = priv.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    )
    pub = priv.public_key().public_numbers()

    def _b64url(n: int, length: int) -> str:
        return base64.urlsafe_b64encode(n.to_bytes(length, "big")).rstrip(b"=").decode()

    jwks = {
        "keys": [
            {
                "kty": "RSA",
                "use": "sig",
                "alg": "RS256",
                "kid": "test-kid-1",
                "n": _b64url(pub.n, 256),
                "e": _b64url(pub.e, 3),
            }
        ]
    }
    return pem, jwks


class _MockResp:
    def __init__(self, data):
        self._data = data
        self.status_code = 200
        self.is_success = True
        self.text = str(data)

    def json(self):
        return self._data

    def raise_for_status(self):
        pass


class _MockErrorResp:
    """A non-2xx httpx-response stand-in for the token endpoint, with an
    optional non-JSON body (``json_data=None`` makes ``.json()`` raise, the
    same as httpx does on a malformed/empty body)."""

    def __init__(self, status_code: int, json_data: dict | None = None, text: str = ""):
        self.status_code = status_code
        self.is_success = False
        self._json_data = json_data
        self.text = text if json_data is None else str(json_data)

    def json(self):
        if self._json_data is None:
            raise ValueError("Response body is not valid JSON")
        return self._json_data


def _mock_httpx_factory(discovery_doc, jwks_data, token_response):
    class _MockHttpxClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def get(self, url, **kwargs):
            if "jwks" in url:
                return _MockResp(jwks_data)
            return _MockResp(discovery_doc)

        async def post(self, url, **kwargs):
            return _MockResp(token_response)

    return _MockHttpxClient


async def _trigger_oidc_callback(
    async_client: AsyncClient,
    db_session: AsyncSession,
    provider_id: int,
    issuer: str,
    client_id: str,
    private_pem: bytes,
    jwks_data: dict,
    *,
    sub: str,
    email: str,
) -> str:
    """Run a full mocked OIDC callback and return the resulting access token."""
    nonce = secrets.token_urlsafe(16)
    state = secrets.token_urlsafe(32)
    code_verifier = secrets.token_urlsafe(48)

    now = int(time.time())
    id_token = pyjwt.encode(
        {
            "sub": sub,
            "iss": issuer,
            "aud": client_id,
            "nonce": nonce,
            "email": email,
            "email_verified": True,
            "iat": now,
            "exp": now + 300,
        },
        private_pem,
        algorithm="RS256",
        headers={"kid": "test-kid-1"},
    )

    db_session.add(
        AuthEphemeralToken(
            token=state,
            token_type="oidc_state",
            provider_id=provider_id,
            nonce=nonce,
            code_verifier=code_verifier,
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
        )
    )
    await db_session.commit()

    discovery = {
        "issuer": issuer,
        "authorization_endpoint": f"{issuer}/auth",
        "token_endpoint": f"{issuer}/token",
        "jwks_uri": f"{issuer}/.well-known/jwks.json",
    }
    token_response = {
        "access_token": "mock-access",
        "token_type": "Bearer",
        "id_token": id_token,
    }

    with patch(
        "backend.app.api.routes.mfa.httpx.AsyncClient",
        _mock_httpx_factory(discovery, jwks_data, token_response),
    ):
        callback_resp = await async_client.get(
            f"/api/v1/auth/oidc/callback?code=test-code&state={state}",
            follow_redirects=False,
        )

    assert callback_resp.status_code == 302, callback_resp.text
    location = callback_resp.headers.get("location", "")
    assert "oidc_token=" in location, f"Expected oidc_token in redirect, got: {location}"

    exchange_token = location.split("oidc_token=")[1].split("&")[0]
    exchange_resp = await async_client.post(
        "/api/v1/auth/oidc/exchange",
        json={"oidc_token": exchange_token},
    )
    assert exchange_resp.status_code == 200, exchange_resp.text
    return exchange_resp.json()["access_token"]


async def _setup_provider_and_state(async_client: AsyncClient, db_session: AsyncSession, *, tag: str):
    """Admin setup + create an OIDC provider + seed an ``oidc_state`` token.

    Shared by every test below that only needs a valid ``(issuer, state)``
    pair to drive the callback — no real IdP round-trip required. ``tag``
    keeps the admin username / provider name / issuer unique per test.
    """
    issuer = f"https://idp.{tag}-test.example.com"
    client_id = f"{tag}-client"

    await async_client.post(
        "/api/v1/auth/setup",
        json={
            "auth_enabled": True,
            "admin_username": f"{tag}adm",
            "admin_password": "AdminPass1!",
        },
    )
    login_resp = await async_client.post(
        "/api/v1/auth/login",
        json={"username": f"{tag}adm", "password": "AdminPass1!"},
    )
    admin_token = login_resp.json()["access_token"]
    headers = {"Authorization": f"Bearer {admin_token}"}

    create_resp = await async_client.post(
        "/api/v1/auth/oidc/providers",
        json={
            "name": f"{tag}-IdP",
            "issuer_url": issuer,
            "client_id": client_id,
            "client_secret": "test-secret",
            "scopes": "openid email profile",
            "is_enabled": True,
            "auto_create_users": True,
        },
        headers=headers,
    )
    assert create_resp.status_code == 201, create_resp.text
    provider_id = create_resp.json()["id"]

    state = secrets.token_urlsafe(32)
    db_session.add(
        AuthEphemeralToken(
            token=state,
            token_type="oidc_state",
            provider_id=provider_id,
            nonce=secrets.token_urlsafe(16),
            code_verifier=secrets.token_urlsafe(48),
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
        )
    )
    await db_session.commit()
    return issuer, state


class TestOidcReloginAfterDelete:
    """Issue #1285: SSO user must be recreatable after admin deletion."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_relogin_after_delete_recreates_user_via_auto_create(
        self, async_client: AsyncClient, db_session: AsyncSession
    ):
        """User created via OIDC → deleted by admin → second OIDC login creates a new user.

        Without the delete_user UserOIDCLink-cleanup fix, the second callback finds
        the orphan link, fails to load the now-deleted user, and redirects to
        ``account_inactive`` — never reaching auto_create_users.
        """
        private_pem, jwks = _make_rsa_key()
        issuer = "https://idp.relogin-test.example.com"
        client_id = "relogin-test-client"
        sub = "oidc-sub-relogin-1285"
        email = "relogin@example.com"

        # Admin setup + create OIDC provider
        await async_client.post(
            "/api/v1/auth/setup",
            json={
                "auth_enabled": True,
                "admin_username": "reloginadm",
                "admin_password": "AdminPass1!",
            },
        )
        login_resp = await async_client.post(
            "/api/v1/auth/login",
            json={"username": "reloginadm", "password": "AdminPass1!"},
        )
        admin_token = login_resp.json()["access_token"]
        headers = {"Authorization": f"Bearer {admin_token}"}

        create_resp = await async_client.post(
            "/api/v1/auth/oidc/providers",
            json={
                "name": "ReloginIdP",
                "issuer_url": issuer,
                "client_id": client_id,
                "client_secret": "test-secret",
                "scopes": "openid email profile",
                "is_enabled": True,
                "auto_create_users": True,
            },
            headers=headers,
        )
        assert create_resp.status_code == 201, create_resp.text
        provider_id = create_resp.json()["id"]

        # ── First OIDC login: creates user + link ──
        await _trigger_oidc_callback(
            async_client,
            db_session,
            provider_id,
            issuer,
            client_id,
            private_pem,
            jwks,
            sub=sub,
            email=email,
        )

        await db_session.commit()
        first_user_row = await db_session.execute(select(User).where(User.email == email))
        first_user = first_user_row.scalar_one()
        first_user_id = first_user.id
        first_user_created_at = first_user.created_at

        first_link_row = await db_session.execute(select(UserOIDCLink).where(UserOIDCLink.provider_user_id == sub))
        assert first_link_row.scalar_one().user_id == first_user_id

        # ── Admin deletes the user ──
        del_resp = await async_client.delete(
            f"/api/v1/users/{first_user_id}",
            headers=headers,
        )
        assert del_resp.status_code == 204, del_resp.text

        await db_session.commit()
        # With the fix the orphan link is gone too — verifying because that
        # is exactly the precondition for auto_create to fire on retry.
        link_after_delete = await db_session.execute(select(UserOIDCLink).where(UserOIDCLink.provider_user_id == sub))
        assert link_after_delete.scalar_one_or_none() is None, (
            "Orphan UserOIDCLink left after delete — would block re-login per #1285"
        )
        # And the user row itself is gone (#1285 prerequisite).
        user_after_delete = await db_session.execute(select(User).where(User.email == email))
        assert user_after_delete.scalar_one_or_none() is None

        # ── Second OIDC login with the same sub: auto_create must run again ──
        # The helper already asserts a 302 with oidc_token=… — that alone proves
        # auto_create fired (otherwise the callback would have redirected to
        # /login?oidc_error=account_inactive and the helper would have failed).
        await _trigger_oidc_callback(
            async_client,
            db_session,
            provider_id,
            issuer,
            client_id,
            private_pem,
            jwks,
            sub=sub,
            email=email,
        )

        await db_session.commit()
        second_row = await db_session.execute(select(User).where(User.email == email))
        second_user = second_row.scalar_one()
        # SQLite recycles primary-key ids when AUTOINCREMENT is not declared, so
        # comparing ids is not a reliable freshness signal across delete+recreate.
        # The decisive proof: a new user row was created (post-delete) and a
        # fresh link points at it. created_at must not be earlier than the
        # original — equality is acceptable on fast machines where seconds match.
        assert second_user.created_at >= first_user_created_at, (
            f"Re-created user has earlier created_at ({second_user.created_at}) "
            f"than the deleted original ({first_user_created_at}) — bug regression"
        )

        # And a fresh link for the new user
        link_after = await db_session.execute(select(UserOIDCLink).where(UserOIDCLink.provider_user_id == sub))
        assert link_after.scalar_one().user_id == second_user.id


class TestOidcCallbackDiscoveryFailure:
    """GET /oidc/callback must redirect to ``discovery_failed`` when the IdP's
    discovery document fetch fails (e.g. a non-2xx response tripping
    ``raise_for_status()``).

    Exercises the shared ``_fetch_oidc_discovery()`` helper on the callback
    path specifically — ``oidc_authorize`` already has trailing-slash
    coverage in test_mfa_api.py, but nothing previously drove a discovery
    failure through the callback's own try/except + redirect.
    """

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_discovery_fetch_failure_redirects_to_discovery_failed(
        self, async_client: AsyncClient, db_session: AsyncSession
    ):
        _issuer, state = await _setup_provider_and_state(async_client, db_session, tag="discovery-failure")

        class _MockHttpx500Client:
            """Discovery GET returns a real httpx.Response(500) so the
            helper's own ``raise_for_status()`` call is the thing under
            test, not a stubbed exception."""

            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def get(self, url, **kwargs):
                return httpx.Response(500, request=httpx.Request("GET", url), json={})

        with patch("backend.app.api.routes.mfa.httpx.AsyncClient", _MockHttpx500Client):
            callback_resp = await async_client.get(
                f"/api/v1/auth/oidc/callback?code=test-code&state={state}",
                follow_redirects=False,
            )

        assert callback_resp.status_code == 302, callback_resp.text
        location = callback_resp.headers.get("location", "")
        assert "oidc_error=discovery_failed" in location, f"Expected discovery_failed redirect, got: {location}"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_failure_redirect_targets_login_route_not_bare_index(
        self, async_client: AsyncClient, db_session: AsyncSession
    ):
        """The failure redirect must land on ``/login?oidc_error=...``, not the
        bare ``/`` index route.

        ``/`` is nested under ``ProtectedRoute`` (App.tsx), which redirects an
        unauthenticated visitor to ``/login`` *without* preserving the query
        string — so a failure sent to ``/?oidc_error=...`` would silently
        drop the error code and, on installs with autologin configured, loop
        straight back to the IdP. Regression test for #T-069.
        """
        _issuer, state = await _setup_provider_and_state(async_client, db_session, tag="login-route")

        class _MockHttpx500Client:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def get(self, url, **kwargs):
                return httpx.Response(500, request=httpx.Request("GET", url), json={})

        with patch("backend.app.api.routes.mfa.httpx.AsyncClient", _MockHttpx500Client):
            callback_resp = await async_client.get(
                f"/api/v1/auth/oidc/callback?code=test-code&state={state}",
                follow_redirects=False,
            )

        assert callback_resp.status_code == 302, callback_resp.text
        location = callback_resp.headers.get("location", "")
        expected_external_url = "http://localhost:5173"
        assert location.startswith(f"{expected_external_url}/login?oidc_error="), (
            f"Expected redirect to {expected_external_url}/login?oidc_error=..., got: {location}"
        )
        parsed = urllib.parse.urlparse(location)
        assert parsed.path == "/login", f"Expected path '/login', got: {parsed.path!r} (location={location})"
        query = urllib.parse.parse_qs(parsed.query)
        assert "oidc_error" in query, f"Expected 'oidc_error' query param, got: {parsed.query!r}"
        assert query["oidc_error"] == ["discovery_failed"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    @pytest.mark.parametrize(
        "raw_body",
        ["null", "[1, 2]"],
        ids=["null-body", "list-body"],
    )
    async def test_discovery_non_object_body_redirects_to_discovery_failed(
        self, async_client: AsyncClient, db_session: AsyncSession, raw_body: str
    ):
        """A 200 discovery response whose body is not a JSON object (e.g.
        ``null`` or a list) must land on the existing ``discovery_failed``
        redirect — not the outer catch-all's ``internal_error`` — and must
        never reach the token exchange POST.
        """
        _issuer, state = await _setup_provider_and_state(async_client, db_session, tag="discovery-non-object")

        token_post_called = False

        class _MockHttpxNonObjectClient:
            """Discovery GET returns a real 200 whose body is not a JSON
            object, so the helper's own isinstance check is what's under
            test, not a stubbed exception."""

            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def get(self, url, **kwargs):
                return httpx.Response(
                    200,
                    request=httpx.Request("GET", url),
                    content=raw_body.encode(),
                    headers={"content-type": "application/json"},
                )

            async def post(self, url, **kwargs):
                nonlocal token_post_called
                token_post_called = True
                raise AssertionError("Token exchange must not be attempted after a discovery failure")

        with patch("backend.app.api.routes.mfa.httpx.AsyncClient", _MockHttpxNonObjectClient):
            callback_resp = await async_client.get(
                f"/api/v1/auth/oidc/callback?code=test-code&state={state}",
                follow_redirects=False,
            )

        assert callback_resp.status_code == 302, callback_resp.text
        location = callback_resp.headers.get("location", "")
        assert "oidc_error=discovery_failed" in location, f"Expected discovery_failed redirect, got: {location}"
        assert not token_post_called, "Token exchange POST must not be attempted after a discovery failure"


class TestOidcCallbackDiscoveryEndpointSSRFGuard:
    """T-050: token_endpoint and jwks_uri declared by the discovery document
    must pass the same public-internet SSRF guard already applied to the
    issuer_url they came from (schemas/auth.py:_validate_issuer_url) —
    not just a scheme check. A private-address endpoint must redirect to
    ``invalid_discovery_document`` and the token exchange POST must never
    be attempted.
    """

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_private_token_endpoint_rejected_no_token_post(
        self, async_client: AsyncClient, db_session: AsyncSession
    ):
        issuer, state = await _setup_provider_and_state(async_client, db_session, tag="privtoken")

        discovery = {
            "issuer": issuer,
            "authorization_endpoint": f"{issuer}/auth",
            # A private-address token_endpoint — a classic SSRF/metadata probe,
            # not merely a bad scheme.
            "token_endpoint": "https://169.254.169.254/token",
            "jwks_uri": f"{issuer}/.well-known/jwks.json",
        }

        post_calls: list[str] = []

        class _MockHttpxClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def get(self, url, **kwargs):
                return _MockResp(discovery)

            async def post(self, url, **kwargs):
                post_calls.append(url)
                raise AssertionError("token exchange POST must never be attempted")

        with patch("backend.app.api.routes.mfa.httpx.AsyncClient", _MockHttpxClient):
            callback_resp = await async_client.get(
                f"/api/v1/auth/oidc/callback?code=test-code&state={state}",
                follow_redirects=False,
            )

        assert callback_resp.status_code == 302, callback_resp.text
        location = callback_resp.headers.get("location", "")
        assert "oidc_error=invalid_discovery_document" in location, (
            f"Expected invalid_discovery_document redirect, got: {location}"
        )
        assert post_calls == [], "token endpoint POST must not have been attempted"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_private_jwks_uri_rejected_no_token_post(self, async_client: AsyncClient, db_session: AsyncSession):
        issuer, state = await _setup_provider_and_state(async_client, db_session, tag="privjwks")

        discovery = {
            "issuer": issuer,
            "authorization_endpoint": f"{issuer}/auth",
            "token_endpoint": f"{issuer}/token",
            # A loopback-address jwks_uri — must be rejected too.
            "jwks_uri": "https://127.0.0.1/jwks.json",
        }

        post_calls: list[str] = []

        class _MockHttpxClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def get(self, url, **kwargs):
                return _MockResp(discovery)

            async def post(self, url, **kwargs):
                post_calls.append(url)
                raise AssertionError("token exchange POST must never be attempted")

        with patch("backend.app.api.routes.mfa.httpx.AsyncClient", _MockHttpxClient):
            callback_resp = await async_client.get(
                f"/api/v1/auth/oidc/callback?code=test-code&state={state}",
                follow_redirects=False,
            )

        assert callback_resp.status_code == 302, callback_resp.text
        location = callback_resp.headers.get("location", "")
        assert "oidc_error=invalid_discovery_document" in location, (
            f"Expected invalid_discovery_document redirect, got: {location}"
        )
        assert post_calls == [], "token endpoint POST must not have been attempted"


class TestOidcCallbackTokenExchangeFailure:
    """T-056: oidc_callback()'s post-discovery failure branches.

    Covers the branches left untested after T-050 added the discovery-document
    SSRF guard (private-IP token_endpoint/jwks_uri already covered by
    ``TestOidcCallbackDiscoveryEndpointSSRFGuard``):

    - discovery document missing ``token_endpoint`` or ``jwks_uri`` entirely
      (a plain scheme/shape validation, distinct from the SSRF guard)
    - the token-exchange POST raising a network error
    - the token endpoint responding with a non-2xx status and a JSON error body
    - the token endpoint responding with a non-2xx status and a non-JSON body

    Each case must redirect to the documented error code and must not
    proceed past the step under test (no token POST for discovery failures,
    no id_token/JWKS handling for token-exchange failures).
    """

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_discovery_missing_token_endpoint_redirects_to_invalid_discovery_document(
        self, async_client: AsyncClient, db_session: AsyncSession
    ):
        issuer, state = await _setup_provider_and_state(async_client, db_session, tag="notokenep")

        discovery = {
            "issuer": issuer,
            "authorization_endpoint": f"{issuer}/auth",
            # token_endpoint intentionally absent.
            "jwks_uri": f"{issuer}/.well-known/jwks.json",
        }

        post_calls: list[str] = []

        class _MockHttpxClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def get(self, url, **kwargs):
                return _MockResp(discovery)

            async def post(self, url, **kwargs):
                post_calls.append(url)
                raise AssertionError("token exchange POST must never be attempted")

        with patch("backend.app.api.routes.mfa.httpx.AsyncClient", _MockHttpxClient):
            callback_resp = await async_client.get(
                f"/api/v1/auth/oidc/callback?code=test-code&state={state}",
                follow_redirects=False,
            )

        assert callback_resp.status_code == 302, callback_resp.text
        location = callback_resp.headers.get("location", "")
        assert location.endswith("oidc_error=invalid_discovery_document"), (
            f"Expected invalid_discovery_document redirect, got: {location}"
        )
        assert post_calls == [], "token endpoint POST must not have been attempted"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_discovery_missing_jwks_uri_redirects_to_invalid_discovery_document(
        self, async_client: AsyncClient, db_session: AsyncSession
    ):
        issuer, state = await _setup_provider_and_state(async_client, db_session, tag="nojwksuri")

        discovery = {
            "issuer": issuer,
            "authorization_endpoint": f"{issuer}/auth",
            "token_endpoint": f"{issuer}/token",
            # jwks_uri intentionally absent.
        }

        post_calls: list[str] = []

        class _MockHttpxClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def get(self, url, **kwargs):
                return _MockResp(discovery)

            async def post(self, url, **kwargs):
                post_calls.append(url)
                raise AssertionError("token exchange POST must never be attempted")

        with patch("backend.app.api.routes.mfa.httpx.AsyncClient", _MockHttpxClient):
            callback_resp = await async_client.get(
                f"/api/v1/auth/oidc/callback?code=test-code&state={state}",
                follow_redirects=False,
            )

        assert callback_resp.status_code == 302, callback_resp.text
        location = callback_resp.headers.get("location", "")
        assert location.endswith("oidc_error=invalid_discovery_document"), (
            f"Expected invalid_discovery_document redirect, got: {location}"
        )
        assert post_calls == [], "token endpoint POST must not have been attempted"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_token_exchange_network_error_redirects_to_token_exchange_network_error(
        self, async_client: AsyncClient, db_session: AsyncSession
    ):
        issuer, state = await _setup_provider_and_state(async_client, db_session, tag="netfail")

        discovery = {
            "issuer": issuer,
            "authorization_endpoint": f"{issuer}/auth",
            "token_endpoint": f"{issuer}/token",
            "jwks_uri": f"{issuer}/.well-known/jwks.json",
        }

        class _MockHttpxClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def get(self, url, **kwargs):
                return _MockResp(discovery)

            async def post(self, url, **kwargs):
                raise httpx.ConnectError("simulated connection failure")

        with patch("backend.app.api.routes.mfa.httpx.AsyncClient", _MockHttpxClient):
            callback_resp = await async_client.get(
                f"/api/v1/auth/oidc/callback?code=test-code&state={state}",
                follow_redirects=False,
            )

        assert callback_resp.status_code == 302, callback_resp.text
        location = callback_resp.headers.get("location", "")
        assert location.endswith("oidc_error=token_exchange_network_error"), (
            f"Expected token_exchange_network_error redirect, got: {location}"
        )

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_token_exchange_non_2xx_json_error_body_redirects_with_urlencoded_code(
        self, async_client: AsyncClient, db_session: AsyncSession
    ):
        issuer, state = await _setup_provider_and_state(async_client, db_session, tag="jsonerr")

        discovery = {
            "issuer": issuer,
            "authorization_endpoint": f"{issuer}/auth",
            "token_endpoint": f"{issuer}/token",
            "jwks_uri": f"{issuer}/.well-known/jwks.json",
        }
        # A space in the error code proves the redirect target is actually
        # URL-encoded (safe="") rather than interpolated raw, which would
        # otherwise let a malicious IdP inject extra query parameters.
        oidc_error_code = "invalid grant"
        expected_suffix = f"oidc_error=token_exchange_{urllib.parse.quote(oidc_error_code, safe='')}"

        class _MockHttpxClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def get(self, url, **kwargs):
                return _MockResp(discovery)

            async def post(self, url, **kwargs):
                return _MockErrorResp(
                    400,
                    {"error": oidc_error_code, "error_description": "The authorization code is invalid."},
                )

        with patch("backend.app.api.routes.mfa.httpx.AsyncClient", _MockHttpxClient):
            callback_resp = await async_client.get(
                f"/api/v1/auth/oidc/callback?code=test-code&state={state}",
                follow_redirects=False,
            )

        assert callback_resp.status_code == 302, callback_resp.text
        location = callback_resp.headers.get("location", "")
        assert location.endswith(expected_suffix), f"Expected {expected_suffix!r} redirect, got: {location}"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_token_exchange_non_2xx_non_json_body_redirects_with_status_code(
        self, async_client: AsyncClient, db_session: AsyncSession
    ):
        issuer, state = await _setup_provider_and_state(async_client, db_session, tag="nonjsonerr")

        discovery = {
            "issuer": issuer,
            "authorization_endpoint": f"{issuer}/auth",
            "token_endpoint": f"{issuer}/token",
            "jwks_uri": f"{issuer}/.well-known/jwks.json",
        }

        class _MockHttpxClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def get(self, url, **kwargs):
                return _MockResp(discovery)

            async def post(self, url, **kwargs):
                # A non-JSON body (e.g. an upstream proxy's plain-text error
                # page) falls through the inner try/except, so oidc_err stays
                # empty and the redirect falls back to the HTTP status code.
                return _MockErrorResp(503, None, text="<html>Service Unavailable</html>")

        with patch("backend.app.api.routes.mfa.httpx.AsyncClient", _MockHttpxClient):
            callback_resp = await async_client.get(
                f"/api/v1/auth/oidc/callback?code=test-code&state={state}",
                follow_redirects=False,
            )

        assert callback_resp.status_code == 302, callback_resp.text
        location = callback_resp.headers.get("location", "")
        assert location.endswith("oidc_error=token_exchange_503"), (
            f"Expected token_exchange_503 redirect, got: {location}"
        )

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_token_exchange_2xx_non_json_body_redirects_to_token_exchange_bad_response(
        self, async_client: AsyncClient, db_session: AsyncSession
    ):
        """A *successful* (2xx) token response whose body is not valid JSON
        is a distinct branch from the non-2xx error-body handling above: the
        outer ``token_resp.is_success`` check passes, so it's the inner
        ``token_resp.json()`` call (made to extract ``id_token``) that must
        raise and be caught, redirecting to ``token_exchange_bad_response``.
        """
        issuer, state = await _setup_provider_and_state(async_client, db_session, tag="badjson2xx")

        discovery = {
            "issuer": issuer,
            "authorization_endpoint": f"{issuer}/auth",
            "token_endpoint": f"{issuer}/token",
            "jwks_uri": f"{issuer}/.well-known/jwks.json",
        }

        class _Mock2xxNonJsonResp:
            status_code = 200
            is_success = True
            text = "not json"

            def json(self):
                raise ValueError("Response body is not valid JSON")

        get_calls: list[str] = []

        class _MockHttpxClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def get(self, url, **kwargs):
                get_calls.append(url)
                return _MockResp(discovery)

            async def post(self, url, **kwargs):
                return _Mock2xxNonJsonResp()

        with patch("backend.app.api.routes.mfa.httpx.AsyncClient", _MockHttpxClient):
            callback_resp = await async_client.get(
                f"/api/v1/auth/oidc/callback?code=test-code&state={state}",
                follow_redirects=False,
            )

        assert callback_resp.status_code == 302, callback_resp.text
        location = callback_resp.headers.get("location", "")
        expected_external_url = "http://localhost:5173"
        assert location.startswith(f"{expected_external_url}/login?oidc_error="), (
            f"Expected redirect to {expected_external_url}/login?oidc_error=..., got: {location}"
        )
        assert location.endswith("oidc_error=token_exchange_bad_response"), (
            f"Expected token_exchange_bad_response redirect, got: {location}"
        )
        assert not any("jwks" in url for url in get_calls), "JWKS must not be fetched after a bad token response"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_token_exchange_2xx_missing_id_token_redirects_to_no_id_token(
        self, async_client: AsyncClient, db_session: AsyncSession
    ):
        """A 2xx JSON token response that omits ``id_token`` must redirect to
        ``no_id_token`` and must never proceed to Step 3 (JWKS fetch / JWT
        decode) — those calls are recorded/patched so this test fails loudly
        if the route reaches them.
        """
        issuer, state = await _setup_provider_and_state(async_client, db_session, tag="noidtoken")

        discovery = {
            "issuer": issuer,
            "authorization_endpoint": f"{issuer}/auth",
            "token_endpoint": f"{issuer}/token",
            "jwks_uri": f"{issuer}/.well-known/jwks.json",
        }
        # No "id_token" key present, unlike the happy-path token_response fixture.
        token_response = {"access_token": "mock-access", "token_type": "Bearer"}

        get_calls: list[str] = []

        class _MockHttpxClient:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def get(self, url, **kwargs):
                get_calls.append(url)
                return _MockResp(discovery)

            async def post(self, url, **kwargs):
                return _MockResp(token_response)

        with (
            patch("backend.app.api.routes.mfa.httpx.AsyncClient", _MockHttpxClient),
            patch("backend.app.api.routes.mfa.jwt.decode") as mock_jwt_decode,
        ):
            callback_resp = await async_client.get(
                f"/api/v1/auth/oidc/callback?code=test-code&state={state}",
                follow_redirects=False,
            )

        assert callback_resp.status_code == 302, callback_resp.text
        location = callback_resp.headers.get("location", "")
        expected_external_url = "http://localhost:5173"
        assert location.startswith(f"{expected_external_url}/login?oidc_error="), (
            f"Expected redirect to {expected_external_url}/login?oidc_error=..., got: {location}"
        )
        assert location.endswith("oidc_error=no_id_token"), f"Expected no_id_token redirect, got: {location}"
        assert mock_jwt_decode.call_count == 0, "JWT decode must not be attempted when id_token is missing"
        assert not any("jwks" in url for url in get_calls), "JWKS must not be fetched when id_token is missing"
