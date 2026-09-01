"""Integration tests for AMS History API endpoints."""

from datetime import datetime, timedelta

import pytest
from httpx import AsyncClient


class TestAMSHistoryAPI:
    """Integration tests for /api/v1/ams-history endpoints."""

    @pytest.fixture
    async def ams_history_factory(self, db_session, printer_factory):
        """Factory to create test AMS history records."""

        async def _create_history(printer_id=None, ams_id=0, **kwargs):
            from backend.app.models.ams_history import AMSSensorHistory

            if printer_id is None:
                printer = await printer_factory()
                printer_id = printer.id

            defaults = {
                "printer_id": printer_id,
                "ams_id": ams_id,
                "humidity": 45.0,
                "humidity_raw": 4500,
                "temperature": 25.0,
                "recorded_at": datetime.now(),
            }
            defaults.update(kwargs)

            history = AMSSensorHistory(**defaults)
            db_session.add(history)
            await db_session.commit()
            await db_session.refresh(history)
            return history

        return _create_history

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_ams_history_empty(self, async_client: AsyncClient, printer_factory, db_session):
        """Verify empty history returns empty data array."""
        printer = await printer_factory()
        response = await async_client.get(f"/api/v1/ams-history/{printer.id}/0")
        assert response.status_code == 200
        data = response.json()
        assert data["printer_id"] == printer.id
        assert data["ams_id"] == 0
        assert data["data"] == []

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_ams_history_with_data(self, async_client: AsyncClient, ams_history_factory, db_session):
        """Verify history returns recorded data."""
        # Create history records
        history = await ams_history_factory()
        printer_id = history.printer_id

        response = await async_client.get(f"/api/v1/ams-history/{printer_id}/0")
        assert response.status_code == 200
        data = response.json()
        assert len(data["data"]) >= 1

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_ams_history_with_stats(
        self, async_client: AsyncClient, ams_history_factory, printer_factory, db_session
    ):
        """Verify history includes statistics."""
        printer = await printer_factory()
        # Create multiple records with different values
        await ams_history_factory(printer_id=printer.id, humidity=40.0, temperature=24.0)
        await ams_history_factory(printer_id=printer.id, humidity=50.0, temperature=26.0)
        await ams_history_factory(printer_id=printer.id, humidity=45.0, temperature=25.0)

        response = await async_client.get(f"/api/v1/ams-history/{printer.id}/0")
        assert response.status_code == 200
        data = response.json()

        # Check statistics
        assert data["min_humidity"] == 40.0
        assert data["max_humidity"] == 50.0
        assert data["min_temperature"] == 24.0
        assert data["max_temperature"] == 26.0

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_ams_history_with_hours_filter(
        self, async_client: AsyncClient, ams_history_factory, printer_factory, db_session
    ):
        """Verify hours parameter filters data."""
        printer = await printer_factory()
        # Create a recent record
        await ams_history_factory(printer_id=printer.id, recorded_at=datetime.now())
        # Create an old record (outside default 24h)
        await ams_history_factory(printer_id=printer.id, recorded_at=datetime.now() - timedelta(hours=48))

        # Request only last 24 hours (default)
        response = await async_client.get(f"/api/v1/ams-history/{printer.id}/0")
        assert response.status_code == 200
        data = response.json()
        # Should only get the recent record
        assert len(data["data"]) == 1

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_ams_history_custom_hours(self, async_client: AsyncClient, printer_factory, db_session):
        """Verify custom hours parameter works."""
        printer = await printer_factory()
        response = await async_client.get(f"/api/v1/ams-history/{printer.id}/0", params={"hours": 48})
        assert response.status_code == 200
        data = response.json()
        assert data["printer_id"] == printer.id

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_ams_history_different_ams_units(
        self, async_client: AsyncClient, ams_history_factory, printer_factory, db_session
    ):
        """Verify filtering by AMS unit ID."""
        printer = await printer_factory()
        await ams_history_factory(printer_id=printer.id, ams_id=0, humidity=40.0)
        await ams_history_factory(printer_id=printer.id, ams_id=1, humidity=50.0)

        # Get AMS unit 0
        response = await async_client.get(f"/api/v1/ams-history/{printer.id}/0")
        assert response.status_code == 200
        data0 = response.json()
        assert len(data0["data"]) == 1
        assert data0["data"][0]["humidity"] == 40.0

        # Get AMS unit 1
        response = await async_client.get(f"/api/v1/ams-history/{printer.id}/1")
        assert response.status_code == 200
        data1 = response.json()
        assert len(data1["data"]) == 1
        assert data1["data"][0]["humidity"] == 50.0

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_delete_old_history(
        self, async_client: AsyncClient, ams_history_factory, printer_factory, db_session
    ):
        """Verify old history can be deleted."""
        printer = await printer_factory()
        # Create an old record
        await ams_history_factory(printer_id=printer.id, recorded_at=datetime.now() - timedelta(days=60))

        # Delete records older than 30 days
        response = await async_client.delete(f"/api/v1/ams-history/{printer.id}", params={"days": 30})
        assert response.status_code == 200
        data = response.json()
        assert data["deleted"] >= 1

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_delete_old_history_no_records(self, async_client: AsyncClient, printer_factory, db_session):
        """Verify delete with no old records returns 0."""
        printer = await printer_factory()
        response = await async_client.delete(f"/api/v1/ams-history/{printer.id}", params={"days": 30})
        assert response.status_code == 200
        data = response.json()
        assert data["deleted"] == 0

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_delete_old_history_with_auth_disabled_is_unchanged(
        self, async_client: AsyncClient, printer_factory, db_session
    ):
        """T-032: with auth explicitly disabled, an anonymous caller can still
        purge old history — the permission gate is a no-op either way, exactly
        as before the fix."""
        from backend.app.models.settings import Settings

        db_session.add(Settings(key="auth_enabled", value="false"))
        await db_session.commit()

        printer = await printer_factory()
        response = await async_client.delete(f"/api/v1/ams-history/{printer.id}", params={"days": 30})
        assert response.status_code == 200
        assert response.json()["deleted"] == 0


def _declared_permissions(route_name: str, path_fragment: str) -> list[str]:
    """The permission strings a route's auth dependency was built with.

    Mirrors the pattern in ``test_aito_contacted.py::_declared_permissions``:
    read out of the closure rather than asserted through an HTTP call, since
    ``async_client`` runs with auth disabled by default and any override would
    replace the very check under test.

    ``delete_old_history`` is gated by
    ``require_printer_permission_if_auth_enabled``, which wraps a nested
    ``require_permission_if_auth_enabled`` checker — one extra closure hop
    versus the plain ``RequirePermissionIfAuthEnabled`` routes.
    """
    from backend.app.main import app

    route = next(r for r in app.routes if getattr(r, "name", "") == route_name and path_fragment in r.path)
    checker = next(d.call for d in route.dependant.dependencies if d.name == "_")
    outer_cells = dict(zip(checker.__code__.co_freevars, checker.__closure__ or (), strict=True))
    if "perm_strings" in checker.__code__.co_freevars:
        return list(outer_cells["perm_strings"].cell_contents)
    # Printer-scoped wrapper: unwrap one more level to reach perm_strings.
    permission_checker = outer_cells["permission_checker"].cell_contents
    inner_cells = dict(zip(permission_checker.__code__.co_freevars, permission_checker.__closure__, strict=True))
    return list(inner_cells["perm_strings"].cell_contents)


class TestDeleteOldHistoryPermissionGate:
    """T-032 (audit-security): the DELETE route must require a write-level
    permission, not the read-only ``ams_history:read`` it was gated on."""

    def test_delete_route_requires_the_write_permission(self):
        assert _declared_permissions("delete_old_history", "/ams-history") == ["ams_history:delete"]

    def test_delete_route_no_longer_accepts_the_read_permission(self):
        """Pinned regression: this exact assertion is what the pre-fix code
        violated (the DELETE route was gated on ``ams_history:read``)."""
        assert _declared_permissions("delete_old_history", "/ams-history") != ["ams_history:read"]

    def test_get_route_permission_is_unchanged(self):
        """The read endpoint's gate must not have moved — only the DELETE
        gate changed."""
        assert _declared_permissions("get_ams_history", "/ams-history") == ["ams_history:read"]

    def test_delete_route_uses_the_printer_scoped_dependency(self):
        """The fix also requires the per-printer API-key allowlist check,
        which only ``require_printer_permission_if_auth_enabled`` performs."""
        from backend.app.main import app

        route = next(
            r for r in app.routes if getattr(r, "name", "") == "delete_old_history" and "/ams-history" in r.path
        )
        checker = next(d.call for d in route.dependant.dependencies if d.name == "_")
        assert checker.__qualname__ == "require_printer_permission_if_auth_enabled.<locals>.checker"


class TestDeleteOldHistoryRoleEnforcement:
    """End-to-end: a real JWT-authenticated principal holding only the
    read permission (the built-in Viewers role) must be refused; a
    principal holding the write permission must succeed."""

    @pytest.fixture
    async def auth_setup(self, db_session):
        """Enable auth and create a Viewers-group user plus a custom group
        holding only ``ams_history:delete`` (isolates "has the write
        permission" from "is an Administrator", which holds every
        permission and so wouldn't distinguish a fix from a coincidence)."""
        from sqlalchemy import select

        from backend.app.core.auth import create_access_token, get_password_hash
        from backend.app.models.group import Group
        from backend.app.models.settings import Settings
        from backend.app.models.user import User

        db_session.add(Settings(key="auth_enabled", value="true"))
        await db_session.commit()

        viewer_group = (await db_session.execute(select(Group).where(Group.name == "Viewers"))).scalar_one()

        deleter_group = Group(
            name="ams-history-deleter",
            description="Test-only group holding just ams_history:delete",
            permissions=["ams_history:delete"],
            is_system=False,
        )
        db_session.add(deleter_group)
        await db_session.flush()

        password_hash = get_password_hash("password")

        viewer_user = User(username="ams_viewer", password_hash=password_hash, is_active=True)
        viewer_user.groups.append(viewer_group)

        deleter_user = User(username="ams_deleter", password_hash=password_hash, is_active=True)
        deleter_user.groups.append(deleter_group)

        db_session.add_all([viewer_user, deleter_user])
        await db_session.commit()

        return {
            "viewer_token": create_access_token(data={"sub": viewer_user.username}),
            "deleter_token": create_access_token(data={"sub": deleter_user.username}),
        }

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_viewers_role_is_refused(self, async_client: AsyncClient, printer_factory, db_session, auth_setup):
        """A principal holding only ``ams_history:read`` (the built-in
        Viewers role, per core/permissions.py) must get 403 on DELETE. This
        is the exact vulnerability T-032 closes — against the pre-fix gate
        (``ams_history:read`` on the DELETE route) this request would have
        returned 200."""
        printer = await printer_factory()

        response = await async_client.delete(
            f"/api/v1/ams-history/{printer.id}",
            params={"days": 30},
            headers={"Authorization": f"Bearer {auth_setup['viewer_token']}"},
        )
        assert response.status_code == 403

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_write_permission_holder_succeeds(
        self, async_client: AsyncClient, printer_factory, db_session, auth_setup
    ):
        """A principal holding ``ams_history:delete`` (and nothing else) must
        be allowed through."""
        printer = await printer_factory()

        response = await async_client.delete(
            f"/api/v1/ams-history/{printer.id}",
            params={"days": 30},
            headers={"Authorization": f"Bearer {auth_setup['deleter_token']}"},
        )
        assert response.status_code == 200
        assert response.json()["deleted"] == 0


class TestDeleteOldHistoryApiKeyPrinterAllowlist:
    """T-032 also requires wiring the per-printer API-key allowlist check
    (``check_printer_access``) onto the DELETE route, matching the pattern
    the 10 ``PRINTERS_FILES`` routes in printers.py already use."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_api_key_excluded_from_the_printer_gets_403(
        self, async_client: AsyncClient, printer_factory, db_session, monkeypatch
    ):
        """``AMS_HISTORY_DELETE`` is classified admin-only for API keys
        (matching the ``ARCHIVES_PURGE`` / ``LIBRARY_PURGE`` precedent — see
        ``_APIKEY_DENIED_PERMISSIONS`` in core/auth.py), so a real API key can
        never clear the permission gate to reach the printer_ids check at
        all. That classification is covered separately by
        ``test_auth_apikey_rbac.py``. To exercise the printer-scoped
        allowlist wiring on *this* route in isolation, the permission-scope
        check is bypassed here so the request reaches
        ``check_printer_access`` — proving the DELETE route is actually
        wired to the printer-scoped dependency, not just any permission dep.
        """
        import backend.app.core.auth as auth_module
        from backend.app.core.auth import generate_api_key
        from backend.app.models.api_key import APIKey
        from backend.app.models.settings import Settings

        db_session.add(Settings(key="auth_enabled", value="true"))

        printer = await printer_factory()
        other_printer = await printer_factory()

        full_key, key_hash, key_prefix = generate_api_key()
        api_key = APIKey(
            name="scoped-key",
            key_hash=key_hash,
            key_prefix=key_prefix,
            enabled=True,
            printer_ids=[other_printer.id],  # excludes `printer`
        )
        db_session.add(api_key)
        await db_session.commit()

        monkeypatch.setattr(auth_module, "_check_apikey_permissions", lambda *a, **k: None)

        response = await async_client.delete(
            f"/api/v1/ams-history/{printer.id}",
            params={"days": 30},
            headers={"X-API-Key": full_key},
        )
        assert response.status_code == 403
        assert f"printer {printer.id}" in response.json()["detail"]
