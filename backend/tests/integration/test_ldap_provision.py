"""Integration tests for the manual LDAP user provisioning routes (#1298).

Reporter @Fuechslein noted that Fenrir forced admins to leave auto-provision
on because there was no UI path to create an LDAP user by hand. The new
endpoints are GET /auth/ldap/search (admin types a partial name, picks a
candidate) and POST /auth/ldap/provision (server re-resolves and creates the
user).

These tests cover:

- Permission gating (only USERS_CREATE can search/provision)
- LDAP-disabled and short-query rejections
- Service-unreachable surfaces as 503, not 200 empty
- Provision creates the user with auth_source=ldap, password_hash=None
- Provision applies the same group mapping as the auto-provision login path
- Duplicate-username protection (409 with explanation)
"""

import asyncio
import logging
import threading
import time
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.finance import CostCenter, CostCenterMember, UserWallet
from backend.app.models.settings import Settings
from backend.app.models.user import User
from backend.app.services.ldap_service import LDAPSearchResult, LDAPUserInfo

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


async def _seed_ldap_settings(db: AsyncSession, **overrides) -> None:
    """Write a minimal but valid LDAP config to the settings table."""
    defaults = {
        "ldap_enabled": "true",
        "ldap_server_url": "ldaps://ldap.test.example:636",  # pragma: allowlist secret — test fixture
        "ldap_bind_dn": "cn=admin,dc=test,dc=com",  # pragma: allowlist secret — test fixture
        "ldap_bind_password": "x",  # pragma: allowlist secret — test fixture
        "ldap_search_base": "dc=test,dc=com",
        "ldap_user_filter": "(uid={username})",
        "ldap_security": "ldaps",
        "ldap_group_mapping": "{}",
        "ldap_auto_provision": "false",
        "ldap_ca_cert_path": "",
        "ldap_default_group": "",
    }
    defaults.update(overrides)
    for key, value in defaults.items():
        db.add(Settings(key=key, value=value))
    await db.commit()


@pytest.fixture
async def admin_token(async_client: AsyncClient) -> str:
    """Enable auth, create an admin, return a valid bearer token."""
    # pragma: allowlist secret — test fixture only, not a real credential
    test_password = "AdminPass1!"  # noqa: S105
    await async_client.post(
        "/api/v1/auth/setup",
        json={
            "auth_enabled": True,
            "admin_username": "ldapadmin",
            "admin_password": test_password,
        },
    )
    login = await async_client.post(
        "/api/v1/auth/login",
        json={"username": "ldapadmin", "password": test_password},
    )
    return login.json()["access_token"]


# ---------------------------------------------------------------------------
# /auth/ldap/search
# ---------------------------------------------------------------------------


class TestLdapSearchRoute:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_requires_auth(self, async_client: AsyncClient, db_session: AsyncSession):
        """Anonymous access is rejected when auth is enabled."""
        await async_client.post(
            "/api/v1/auth/setup",
            json={
                "auth_enabled": True,
                "admin_username": "x",
                "admin_password": "AdminPass1!",
            },  # pragma: allowlist secret — test fixture
        )

        response = await async_client.get("/api/v1/auth/ldap/search?q=jdoe")

        assert response.status_code == 401

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_rejects_short_query(self, async_client: AsyncClient, admin_token: str, db_session: AsyncSession):
        """Single-char queries would be effectively unbounded against a large directory."""
        await _seed_ldap_settings(db_session)

        response = await async_client.get(
            "/api/v1/auth/ldap/search?q=j",
            headers={"Authorization": f"Bearer {admin_token}"},
        )

        assert response.status_code == 400
        assert "at least 2 characters" in response.json()["detail"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_rejects_when_ldap_disabled(
        self, async_client: AsyncClient, admin_token: str, db_session: AsyncSession
    ):
        """No LDAP config in settings → 400 with a clear message."""
        response = await async_client.get(
            "/api/v1/auth/ldap/search?q=jdoe",
            headers={"Authorization": f"Bearer {admin_token}"},
        )

        assert response.status_code == 400
        assert "LDAP is not enabled" in response.json()["detail"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_surfaces_unreachable_as_503(
        self, async_client: AsyncClient, admin_token: str, db_session: AsyncSession
    ):
        """When the underlying search fails (network/auth), the admin gets 503 — not
        a silent empty list (which would look like 'no matches')."""
        await _seed_ldap_settings(db_session)

        with patch(
            "backend.app.services.ldap_service.search_ldap_users",
            side_effect=RuntimeError("simulated outage"),
        ):
            response = await async_client.get(
                "/api/v1/auth/ldap/search?q=jdoe",
                headers={"Authorization": f"Bearer {admin_token}"},
            )

        assert response.status_code == 503
        # Detail now includes the underlying exception class + message so the
        # admin can see why (e.g. "LDAP search failed: RuntimeError: simulated outage").
        detail = response.json()["detail"].lower()
        assert "ldap search failed" in detail
        assert "simulated outage" in detail

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_returns_results_annotated_with_already_provisioned(
        self, async_client: AsyncClient, admin_token: str, db_session: AsyncSession
    ):
        """Results that match an existing local row must come back with the flag set."""
        await _seed_ldap_settings(db_session)

        # Seed an existing local user that shares a username with one LDAP result.
        db_session.add(User(username="existing", email="x@test.com", password_hash="$x$", role="user"))
        await db_session.commit()

        fake_results = [
            LDAPSearchResult(
                username="jdoe",
                email="jdoe@test.com",
                display_name="John Doe",
                dn="cn=John Doe,dc=test,dc=com",
            ),
            LDAPSearchResult(
                username="existing",
                email="existing@test.com",
                display_name="Already Provisioned",
                dn="cn=existing,dc=test,dc=com",
            ),
        ]

        with patch(
            "backend.app.services.ldap_service.search_ldap_users",
            return_value=fake_results,
        ):
            response = await async_client.get(
                "/api/v1/auth/ldap/search?q=jdoe",
                headers={"Authorization": f"Bearer {admin_token}"},
            )

        assert response.status_code == 200
        body = response.json()
        assert len(body) == 2
        by_user = {r["username"]: r for r in body}
        assert by_user["jdoe"]["already_provisioned"] is False
        assert by_user["existing"]["already_provisioned"] is True


# ---------------------------------------------------------------------------
# /auth/ldap/provision
# ---------------------------------------------------------------------------


class TestLdapProvisionRoute:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_requires_auth(self, async_client: AsyncClient):
        await async_client.post(
            "/api/v1/auth/setup",
            json={
                "auth_enabled": True,
                "admin_username": "x",
                "admin_password": "AdminPass1!",
            },  # pragma: allowlist secret — test fixture
        )

        response = await async_client.post(
            "/api/v1/auth/ldap/provision",
            json={"username": "jdoe"},
        )

        assert response.status_code == 401

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_404_when_directory_lookup_misses(
        self, async_client: AsyncClient, admin_token: str, db_session: AsyncSession
    ):
        await _seed_ldap_settings(db_session)

        with patch("backend.app.services.ldap_service.lookup_ldap_user", return_value=None):
            response = await async_client.post(
                "/api/v1/auth/ldap/provision",
                json={"username": "nobody"},
                headers={"Authorization": f"Bearer {admin_token}"},
            )

        assert response.status_code == 404
        assert "not found in LDAP directory" in response.json()["detail"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_409_when_local_user_exists(
        self, async_client: AsyncClient, admin_token: str, db_session: AsyncSession
    ):
        """A local user with the same username must block provision — the admin has
        to resolve the collision manually rather than silently coexisting."""
        await _seed_ldap_settings(db_session)

        db_session.add(User(username="jdoe", password_hash="$x$", role="user", auth_source="local"))
        await db_session.commit()

        fake_ldap = LDAPUserInfo(username="jdoe", email="jdoe@test.com", display_name=None, groups=[])
        with patch("backend.app.services.ldap_service.lookup_ldap_user", return_value=fake_ldap):
            response = await async_client.post(
                "/api/v1/auth/ldap/provision",
                json={"username": "jdoe"},
                headers={"Authorization": f"Bearer {admin_token}"},
            )

        assert response.status_code == 409
        assert "local user" in response.json()["detail"].lower()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_409_when_already_provisioned(
        self, async_client: AsyncClient, admin_token: str, db_session: AsyncSession
    ):
        """Re-provisioning an existing LDAP user must give a distinct error so the
        UI can suggest 'they exist already, just have them log in' rather than
        the more alarming 'local conflict' message."""
        await _seed_ldap_settings(db_session)

        db_session.add(User(username="alice", password_hash=None, role="user", auth_source="ldap"))
        await db_session.commit()

        fake_ldap = LDAPUserInfo(username="alice", email="alice@test.com", display_name=None, groups=[])
        with patch("backend.app.services.ldap_service.lookup_ldap_user", return_value=fake_ldap):
            response = await async_client.post(
                "/api/v1/auth/ldap/provision",
                json={"username": "alice"},
                headers={"Authorization": f"Bearer {admin_token}"},
            )

        assert response.status_code == 409
        assert "already provisioned" in response.json()["detail"].lower()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_503_when_directory_unreachable(
        self, async_client: AsyncClient, admin_token: str, db_session: AsyncSession
    ):
        await _seed_ldap_settings(db_session)

        with patch(
            "backend.app.services.ldap_service.lookup_ldap_user",
            side_effect=RuntimeError("simulated outage"),
        ):
            response = await async_client.post(
                "/api/v1/auth/ldap/provision",
                json={"username": "jdoe"},
                headers={"Authorization": f"Bearer {admin_token}"},
            )

        assert response.status_code == 503

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_happy_path_creates_user_with_ldap_auth_source(
        self, async_client: AsyncClient, admin_token: str, db_session: AsyncSession
    ):
        """Verifies the full provision: response shape + DB state."""
        await _seed_ldap_settings(db_session)

        fake_ldap = LDAPUserInfo(
            username="newuser",
            email="newuser@test.com",
            display_name="New User",
            groups=[],
        )

        with patch("backend.app.services.ldap_service.lookup_ldap_user", return_value=fake_ldap):
            response = await async_client.post(
                "/api/v1/auth/ldap/provision",
                json={"username": "newuser"},
                headers={"Authorization": f"Bearer {admin_token}"},
            )

        assert response.status_code == 201
        body = response.json()
        assert body["username"] == "newuser"
        assert body["email"] == "newuser@test.com"
        assert body["auth_source"] == "ldap"

        # Verify DB state: password_hash MUST be None (LDAP has no local credential)
        from sqlalchemy import select

        row = (await db_session.execute(select(User).where(User.username == "newuser"))).scalar_one()
        assert row.auth_source == "ldap"
        assert row.password_hash is None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_happy_path_applies_group_mapping(
        self, async_client: AsyncClient, admin_token: str, db_session: AsyncSession
    ):
        """Provision must run the same group-mapping logic as the auto-provision
        login path — so an admin who provisions Alice gets the exact same group
        memberships as if Alice had logged in herself with auto-provision on."""
        await _seed_ldap_settings(
            db_session,
            ldap_group_mapping='{"cn=staff,ou=groups,dc=test,dc=com": "Operators"}',
        )

        # Operators group is auto-seeded by the test harness — no need to create it.
        fake_ldap = LDAPUserInfo(
            username="alice",
            email="alice@test.com",
            display_name="Alice",
            groups=["cn=staff,ou=groups,dc=test,dc=com"],
        )

        with patch("backend.app.services.ldap_service.lookup_ldap_user", return_value=fake_ldap):
            response = await async_client.post(
                "/api/v1/auth/ldap/provision",
                json={"username": "alice"},
                headers={"Authorization": f"Bearer {admin_token}"},
            )

        assert response.status_code == 201
        body = response.json()
        group_names = {g["name"] for g in body["groups"]}
        assert "Operators" in group_names


class TestLdapLoginFinanceDefaults:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_successful_ldap_login_backfills_finance_defaults(
        self, async_client: AsyncClient, db_session: AsyncSession
    ):
        """LDAP login should ensure wallet + private cost center defaults exist.

        Regression: LDAP users created before finance defaults were introduced can
        exist without wallet/private center. A successful LDAP login must backfill
        these defaults so billing-enabled flows have a valid personal cost center.
        """
        await async_client.post(
            "/api/v1/auth/setup",
            json={
                "auth_enabled": True,
                "admin_username": "ldapadmin",
                "admin_password": "AdminPass1!",
            },
        )
        await _seed_ldap_settings(db_session, ldap_auto_provision="false")

        legacy_user = User(
            username="legacyldap",
            email="legacyldap@test.com",
            password_hash=None,
            role="user",
            auth_source="ldap",
            is_active=True,
        )
        db_session.add(legacy_user)
        await db_session.commit()
        await db_session.refresh(legacy_user)

        # Precondition: legacy LDAP row has no finance defaults yet.
        wallet_before = (
            await db_session.execute(select(UserWallet).where(UserWallet.user_id == legacy_user.id))
        ).scalar_one_or_none()
        private_cc_before = (
            await db_session.execute(
                select(CostCenter).where(
                    CostCenter.owner_user_id == legacy_user.id,
                    CostCenter.is_private.is_(True),
                )
            )
        ).scalar_one_or_none()
        assert wallet_before is None
        assert private_cc_before is None

        fake_ldap = LDAPUserInfo(
            username="legacyldap",
            email="legacyldap@test.com",
            display_name="Legacy LDAP",
            groups=[],
        )
        with patch("backend.app.services.ldap_service.authenticate_ldap_user", return_value=fake_ldap):
            response = await async_client.post(
                "/api/v1/auth/login",
                json={"username": "legacyldap", "password": "irrelevant"},
            )

        assert response.status_code == 200
        assert response.json()["user"]["auth_source"] == "ldap"

        wallet_after = (
            await db_session.execute(select(UserWallet).where(UserWallet.user_id == legacy_user.id))
        ).scalar_one_or_none()
        assert wallet_after is not None

        private_cc_after = (
            await db_session.execute(
                select(CostCenter).where(
                    CostCenter.owner_user_id == legacy_user.id,
                    CostCenter.is_private.is_(True),
                )
            )
        ).scalar_one_or_none()
        assert private_cc_after is not None
        assert private_cc_after.name == "legacyldap"

        membership = (
            await db_session.execute(
                select(CostCenterMember).where(
                    CostCenterMember.cost_center_id == private_cc_after.id,
                    CostCenterMember.user_id == legacy_user.id,
                )
            )
        ).scalar_one_or_none()
        assert membership is not None
        assert membership.can_print is True


class TestLdapSyncFailureRollsBackSession:
    """T-114: a DB error raised by the LDAP sync/provision path (inside the
    login() try block) must not leak into the downstream local-auth code as
    an unrecoverable session or as an authenticated `user`.

    Before the fix, the except block set `ldap_user = None` but never rolled
    back the session and never reset `user`. Two distinct bugs followed:

      (a) if the failing call had left the AsyncSession's transaction dirty
          (e.g. a flush that raised IntegrityError), every subsequent
          statement on that session -- including the very next `SELECT
          local_login_enabled` and the local-credentials query -- raised
          SQLAlchemy's PendingRollbackError, turning a valid LDAP directory
          hiccup into an HTTP 500 instead of the documented "falls back to
          local" behavior.

      (b) if `_provision_ldap_user` (or `_sync_ldap_user`) had already
          resolved/created a `User` row before a *later* step in the same
          try block raised, `user` stayed bound to that half-resolved User
          object. When local login is disabled (local_login_allowed is
          False), the `if not ldap_user and local_login_allowed:` guard at
          the local-auth call site never runs, so `user` is never
          overwritten -- `if not user:` at the bottom of login() is False,
          and the request returns a normal 200 with an access token for a
          user whose credentials were never actually checked. That is a
          real authentication bypass, not just a robustness bug.
    """

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_dirty_session_from_sync_failure_falls_back_to_401_not_500(
        self,
        async_client: AsyncClient,
        db_session: AsyncSession,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ):
        """`_sync_ldap_user` performs a DB write that fails (IntegrityError from a
        duplicate username) leaving the session dirty. The login must still
        resolve to a normal 401 (wrong local credentials) rather than a 500."""
        await async_client.post(
            "/api/v1/auth/setup",
            json={
                "auth_enabled": True,
                "admin_username": "ldapadmin4",
                "admin_password": "AdminPass1!",
            },
        )
        await _seed_ldap_settings(db_session, ldap_auto_provision="false")

        legacy_user = User(
            username="dirtysync",
            email="dirtysync@test.com",
            password_hash=None,
            role="user",
            auth_source="ldap",
            is_active=True,
        )
        db_session.add(legacy_user)
        await db_session.commit()
        await db_session.refresh(legacy_user)

        async def fake_sync_ldap_user(db, user, ldap_user, ldap_config):
            # Simulate a DB write inside the LDAP sync step that fails and
            # leaves the session's transaction needing a rollback -- e.g. a
            # write-lock/constraint failure the codebase's own comments cite.
            db.add(
                User(
                    username=user.username,  # duplicate -> unique constraint violation
                    email="duplicate@test.com",
                    password_hash=None,
                    role="user",
                    auth_source="ldap",
                )
            )
            await db.flush()

        monkeypatch.setattr("backend.app.api.routes.auth._sync_ldap_user", fake_sync_ldap_user)

        fake_ldap = LDAPUserInfo(
            username="dirtysync",
            email="dirtysync@test.com",
            display_name="Dirty Sync",
            groups=[],
        )
        with (
            patch("backend.app.services.ldap_service.authenticate_ldap_user", return_value=fake_ldap),
            caplog.at_level(logging.WARNING, logger="backend.app.api.routes.auth"),
        ):
            response = await async_client.post(
                "/api/v1/auth/login",
                json={"username": "dirtysync", "password": "wrong-local-password"},
            )

        # Never a 500 -- PendingRollbackError must not escape to the client.
        assert response.status_code == 401, response.text
        assert "Incorrect username or password" in response.json()["detail"]
        assert "LDAP authentication error, falling back to local" in caplog.text

        # The session is left usable: a follow-up query on the same
        # connection succeeds (proves the rollback actually happened).
        row = (await db_session.execute(select(User).where(User.username == "dirtysync"))).scalar_one()
        assert row.email == "dirtysync@test.com"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_finance_defaults_failure_after_provision_does_not_leak_authenticated_user(
        self,
        async_client: AsyncClient,
        db_session: AsyncSession,
        monkeypatch: pytest.MonkeyPatch,
    ):
        """Auth bypass regression check: a provisioned-but-not-fully-synced LDAP
        user must never be treated as authenticated. Before the fix, this
        exact scenario (local login disabled, `ensure_user_finance_defaults`
        raising right after a successful provision) returned HTTP 200 with a
        valid access token -- login() never actually checked a credential."""
        await async_client.post(
            "/api/v1/auth/setup",
            json={
                "auth_enabled": True,
                "admin_username": "ldapadmin5",
                "admin_password": "AdminPass1!",
            },
        )
        await _seed_ldap_settings(db_session, ldap_auto_provision="true")
        # Local login disabled: without the `user = None` reset, nothing else
        # in login() would ever overwrite the leaked `user`.
        db_session.add(Settings(key="local_login_enabled", value="false"))
        await db_session.commit()

        # `_provision_ldap_user` "succeeds": it creates and commits a brand-new
        # User row (auth_source=ldap) and returns it, exactly like the real
        # provisioning path does once its own internal finance-defaults call
        # has gone through. `user` is now bound to a real, committed row.
        async def fake_provision(db, ldap_user_info, ldap_config):
            new_user = User(
                username=ldap_user_info.username,
                email=ldap_user_info.email,
                password_hash=None,
                role="user",
                auth_source="ldap",
                is_active=True,
            )
            db.add(new_user)
            await db.commit()
            await db.refresh(new_user)
            return new_user

        monkeypatch.setattr("backend.app.api.routes.auth._provision_ldap_user", fake_provision)
        # The *second* finance-defaults call further down in login() -- the
        # one that keeps every LDAP user's wallet in sync on every login,
        # run right after `_sync_ldap_user` -- is the one that fails here.
        monkeypatch.setattr(
            "backend.app.api.routes.auth.ensure_user_finance_defaults",
            AsyncMock(side_effect=RuntimeError("simulated finance-defaults failure")),
        )

        fake_ldap = LDAPUserInfo(
            username="halfprovisioned",
            email="halfprovisioned@test.com",
            display_name="Half Provisioned",
            groups=[],
        )
        with patch("backend.app.services.ldap_service.authenticate_ldap_user", return_value=fake_ldap):
            response = await async_client.post(
                "/api/v1/auth/login",
                json={"username": "halfprovisioned", "password": "not-checked-anywhere"},
            )

        assert response.status_code == 401, response.text
        assert "access_token" not in response.json()
        assert "Incorrect username or password" in response.json()["detail"]

        # The user row from the aborted provision attempt may or may not
        # persist (provisioning itself committed before finance-defaults
        # raised) -- what matters is that this request was never treated as
        # an authenticated session for it.
        row = (await db_session.execute(select(User).where(User.username == "halfprovisioned"))).scalar_one_or_none()
        if row is not None:
            assert row.auth_source == "ldap"


class TestLdapLoginOffLoop:
    """T-044: authenticate_ldap_user wraps blocking ldap3 calls; login() must run

    it via asyncio.to_thread so a slow/unreachable directory only blocks its own
    request instead of the whole event loop.
    """

    async def test_ldap_login_runs_authenticate_off_event_loop(
        self, async_client: AsyncClient, db_session: AsyncSession
    ):
        await async_client.post(
            "/api/v1/auth/setup",
            json={
                "auth_enabled": True,
                "admin_username": "ldapadmin2",
                "admin_password": "AdminPass1!",
            },
        )
        await _seed_ldap_settings(db_session, ldap_auto_provision="true")

        calls = []

        def fake_authenticate(config, username, password):
            off_main_thread = threading.current_thread() is not threading.main_thread()
            try:
                asyncio.get_running_loop()
                has_running_loop = True
            except RuntimeError:
                has_running_loop = False
            calls.append((off_main_thread, has_running_loop))
            return LDAPUserInfo(
                username="offloop",
                email="offloop@test.com",
                display_name="Off Loop",
                groups=[],
            )

        with patch("backend.app.services.ldap_service.authenticate_ldap_user", side_effect=fake_authenticate):
            response = await async_client.post(
                "/api/v1/auth/login",
                json={"username": "offloop", "password": "irrelevant"},
            )

        assert response.status_code == 200
        assert calls == [(True, False)]


class TestLdapLoginBindTimeout:
    """T-057: authenticate_ldap_user runs on the shared default executor via
    asyncio.to_thread with no bound on how long the bind can block — a
    directory that completes the TCP handshake and then stops answering
    would hold the request (and eventually starve the executor other
    to_thread callers share) indefinitely. login() now wraps the bind in
    asyncio.wait_for(..., timeout=_LDAP_BIND_TIMEOUT_S) and, on timeout,
    falls back through the exact same path an LDAP exception already takes.
    """

    async def test_slow_ldap_bind_times_out_and_falls_back_to_local_path(
        self,
        async_client: AsyncClient,
        db_session: AsyncSession,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ):
        monkeypatch.setattr("backend.app.api.routes.auth._LDAP_BIND_TIMEOUT_S", 0.2)
        await async_client.post(
            "/api/v1/auth/setup",
            json={
                "auth_enabled": True,
                "admin_username": "ldapadmin3",
                "admin_password": "AdminPass1!",
            },
        )
        await _seed_ldap_settings(db_session, ldap_auto_provision="true")

        def fake_authenticate(config, username, password):
            # Runs in a worker thread (asyncio.to_thread) — sleeping here
            # does not block the event loop, only the LDAP bind's own thread.
            time.sleep(1.0)
            return LDAPUserInfo(
                username="slowuser",
                email="slowuser@test.com",
                display_name="Slow User",
                groups=[],
            )

        with (
            patch("backend.app.services.ldap_service.authenticate_ldap_user", side_effect=fake_authenticate),
            caplog.at_level(logging.WARNING, logger="backend.app.api.routes.auth"),
        ):
            start = time.monotonic()
            response = await async_client.post(
                "/api/v1/auth/login",
                json={"username": "slowuser", "password": "irrelevant"},
            )
            elapsed = time.monotonic() - start

        # The bound request returns well before the 1.0s block finishes --
        # this is the assertion the mutation proof removes the wait_for for.
        assert elapsed < 0.8, f"login() took {elapsed:.2f}s — the wait_for bound did not apply"
        # Same response the existing LDAP-exception fallback path gives today:
        # no local user named "slowuser" exists, so local auth also fails.
        assert response.status_code == 401, response.text
        assert "Incorrect username or password" in response.json()["detail"]
        assert "LDAP authentication error, falling back to local" in caplog.text


class TestLoginLocalAccountCollisionGuard:
    """T-096: login() must not let a successful LDAP bind take over a username
    that already belongs to a *local* account. auth.py lines 513-516:

        if user and user.auth_source != "ldap":
            user = None
            ldap_user = None

    Without this guard, a directory that happens to contain a username
    matching an existing local admin/user would let anyone who can bind to
    that directory account log in as the local user — no local password
    required.
    """

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_ldap_success_does_not_take_over_existing_local_username(
        self, async_client: AsyncClient, db_session: AsyncSession
    ):
        """An LDAP bind that resolves to a username already owned by a local
        account must not log the caller in as that local account. The request
        must instead fall through to local password verification, which fails
        here because the supplied password is not the local user's password."""
        from backend.app.core.auth import get_password_hash

        await async_client.post(
            "/api/v1/auth/setup",
            json={
                "auth_enabled": True,
                "admin_username": "collisionadmin",
                "admin_password": "AdminPass1!",
            },
        )
        await _seed_ldap_settings(db_session, ldap_auto_provision="true")

        db_session.add(
            User(
                username="zoe",
                email="zoe@test.com",
                password_hash=get_password_hash("ZoeRealLocalPass1!"),
                role="user",
                auth_source="local",
            )
        )
        await db_session.commit()

        # The directory "succeeds" and hands back the same username — but the
        # login request carries the wrong *local* password. If the guard were
        # missing, the LDAP result alone would be enough to log in as "zoe".
        fake_ldap = LDAPUserInfo(username="zoe", email="zoe@test.com", display_name=None, groups=[])
        with patch("backend.app.services.ldap_service.authenticate_ldap_user", return_value=fake_ldap):
            response = await async_client.post(
                "/api/v1/auth/login",
                json={"username": "zoe", "password": "WrongLocalPass1!"},
            )

        assert response.status_code == 401, response.text
        assert "Incorrect username or password" in response.json()["detail"]

        # The local account must still be untouched — still local, never flipped to ldap.
        row = (await db_session.execute(select(User).where(User.username == "zoe"))).scalar_one()
        assert row.auth_source == "local"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_ldap_success_with_auto_provision_off_and_no_local_user_falls_through(
        self, async_client: AsyncClient, db_session: AsyncSession
    ):
        """A successful LDAP bind for a username with no matching local account,
        while auto-provision is off, must not create a user or log the caller
        in — it falls through cleanly to local auth, which then fails (no such
        local account) with the same generic 401."""
        await async_client.post(
            "/api/v1/auth/setup",
            json={
                "auth_enabled": True,
                "admin_username": "collisionadmin2",
                "admin_password": "AdminPass1!",
            },
        )
        await _seed_ldap_settings(db_session, ldap_auto_provision="false")

        fake_ldap = LDAPUserInfo(username="brandnew", email="brandnew@test.com", display_name=None, groups=[])
        with patch("backend.app.services.ldap_service.authenticate_ldap_user", return_value=fake_ldap):
            response = await async_client.post(
                "/api/v1/auth/login",
                json={"username": "brandnew", "password": "irrelevant"},
            )

        assert response.status_code == 401, response.text
        assert "Incorrect username or password" in response.json()["detail"]

        # No user must have been created as a side effect of the (discarded) LDAP result.
        row = (await db_session.execute(select(User).where(User.username == "brandnew"))).scalar_one_or_none()
        assert row is None
