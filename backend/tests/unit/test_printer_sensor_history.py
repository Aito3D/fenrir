"""Tests for printer heater (nozzle / bed / chamber) sensor history."""

from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.printer import Printer
from backend.app.models.printer_sensor_history import PrinterSensorHistory


@pytest.mark.asyncio
async def test_get_returns_per_sensor_series(async_client: AsyncClient, db_session: AsyncSession):
    """Each sensor_kind returns its own series with stats."""
    printer = Printer(name="X1C", serial_number="X1C-TEST-001", ip_address="10.0.0.10", access_code="12345678")
    db_session.add(printer)
    await db_session.commit()
    await db_session.refresh(printer)

    base = datetime.now(timezone.utc) - timedelta(hours=1)
    samples = [
        ("nozzle", 210.0, 220.0, 0),
        ("nozzle", 215.0, 220.0, 5),
        ("nozzle", 220.0, 220.0, 10),
        ("bed", 55.0, 60.0, 0),
        ("bed", 60.0, 60.0, 5),
        ("chamber", 38.0, 40.0, 0),
    ]
    for kind, value, target, minutes in samples:
        db_session.add(
            PrinterSensorHistory(
                printer_id=printer.id,
                sensor_kind=kind,
                value=value,
                target=target,
                recorded_at=base + timedelta(minutes=minutes),
            )
        )
    await db_session.commit()

    response = await async_client.get(f"/api/v1/printer-sensor-history/{printer.id}?hours=24")
    assert response.status_code == 200
    body = response.json()
    assert body["printer_id"] == printer.id
    series_by_kind = {s["sensor_kind"]: s for s in body["series"]}

    assert series_by_kind["nozzle"]["min_value"] == 210.0
    assert series_by_kind["nozzle"]["max_value"] == 220.0
    assert series_by_kind["nozzle"]["avg_value"] == pytest.approx(215.0, rel=0.01)
    assert len(series_by_kind["nozzle"]["data"]) == 3

    assert series_by_kind["bed"]["min_value"] == 55.0
    assert series_by_kind["bed"]["max_value"] == 60.0
    assert len(series_by_kind["bed"]["data"]) == 2

    assert series_by_kind["chamber"]["max_value"] == 38.0
    # nozzle_2 wasn't recorded — series present but empty
    assert series_by_kind["nozzle_2"]["data"] == []
    assert series_by_kind["nozzle_2"]["min_value"] is None


@pytest.mark.asyncio
async def test_get_filters_by_kinds_query(async_client: AsyncClient, db_session: AsyncSession):
    """`kinds=bed,chamber` only returns those series."""
    printer = Printer(name="X1C", serial_number="X1C-TEST-002", ip_address="10.0.0.11", access_code="12345678")
    db_session.add(printer)
    await db_session.commit()
    await db_session.refresh(printer)

    db_session.add(PrinterSensorHistory(printer_id=printer.id, sensor_kind="bed", value=60.0, target=60.0))
    await db_session.commit()

    response = await async_client.get(f"/api/v1/printer-sensor-history/{printer.id}?hours=24&kinds=bed,chamber")
    assert response.status_code == 200
    kinds_returned = {s["sensor_kind"] for s in response.json()["series"]}
    assert kinds_returned == {"bed", "chamber"}


@pytest.mark.asyncio
async def test_get_clamps_to_hours_window(async_client: AsyncClient, db_session: AsyncSession):
    """Rows older than the requested window are excluded."""
    printer = Printer(name="X1C", serial_number="X1C-TEST-003", ip_address="10.0.0.12", access_code="12345678")
    db_session.add(printer)
    await db_session.commit()
    await db_session.refresh(printer)

    now = datetime.now(timezone.utc)
    # One inside the window, one outside.
    db_session.add(
        PrinterSensorHistory(
            printer_id=printer.id,
            sensor_kind="bed",
            value=60.0,
            target=60.0,
            recorded_at=now - timedelta(minutes=30),
        )
    )
    db_session.add(
        PrinterSensorHistory(
            printer_id=printer.id,
            sensor_kind="bed",
            value=55.0,
            target=60.0,
            recorded_at=now - timedelta(hours=10),
        )
    )
    await db_session.commit()

    response = await async_client.get(f"/api/v1/printer-sensor-history/{printer.id}?hours=1")
    body = response.json()
    bed_series = next(s for s in body["series"] if s["sensor_kind"] == "bed")
    assert len(bed_series["data"]) == 1
    assert bed_series["data"][0]["value"] == 60.0


@pytest.mark.asyncio
async def test_delete_removes_old_rows(async_client: AsyncClient, db_session: AsyncSession):
    """DELETE removes rows older than `days` for the given printer only."""
    keep_printer = Printer(name="Keep", serial_number="KEEP-001", ip_address="10.0.0.20", access_code="12345678")
    other_printer = Printer(name="Other", serial_number="OTHER-001", ip_address="10.0.0.21", access_code="12345678")
    db_session.add_all([keep_printer, other_printer])
    await db_session.commit()
    await db_session.refresh(keep_printer)
    await db_session.refresh(other_printer)

    now = datetime.now(timezone.utc)
    old = now - timedelta(days=40)
    db_session.add(PrinterSensorHistory(printer_id=keep_printer.id, sensor_kind="bed", value=60.0, recorded_at=old))
    db_session.add(PrinterSensorHistory(printer_id=keep_printer.id, sensor_kind="bed", value=60.0, recorded_at=now))
    db_session.add(PrinterSensorHistory(printer_id=other_printer.id, sensor_kind="bed", value=60.0, recorded_at=old))
    await db_session.commit()

    response = await async_client.delete(f"/api/v1/printer-sensor-history/{keep_printer.id}?days=30")
    assert response.status_code == 200
    assert response.json()["deleted"] == 1

    # other printer's old row untouched.
    rows = (await db_session.execute(select(PrinterSensorHistory))).scalars().all()
    kinds_left = sorted((r.printer_id, r.value) for r in rows)
    assert kinds_left == sorted([(keep_printer.id, 60.0), (other_printer.id, 60.0)])


@pytest.mark.asyncio
async def test_delete_with_auth_disabled_is_unchanged(async_client: AsyncClient, db_session: AsyncSession):
    """T-033: with auth explicitly disabled, an anonymous caller can still
    purge old history — the permission gate is a no-op either way, exactly
    as before the fix."""
    from backend.app.models.settings import Settings

    db_session.add(Settings(key="auth_enabled", value="false"))
    await db_session.commit()

    printer = Printer(name="X1C", serial_number="X1C-TEST-004", ip_address="10.0.0.13", access_code="12345678")
    db_session.add(printer)
    await db_session.commit()
    await db_session.refresh(printer)

    response = await async_client.delete(f"/api/v1/printer-sensor-history/{printer.id}?days=30")
    assert response.status_code == 200
    assert response.json()["deleted"] == 0


def _declared_permissions(route_name: str, path_fragment: str) -> list[str]:
    """The permission strings a route's auth dependency was built with.

    Mirrors the pattern in ``test_ams_history_api.py::_declared_permissions``
    (itself mirroring ``test_aito_contacted.py``): read out of the closure
    rather than asserted through an HTTP call, since ``async_client`` runs
    with auth disabled by default and any override would replace the very
    check under test.

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
    """T-033 (audit-security): the DELETE route must require a write-level
    permission, not the read-only ``printer_sensor_history:read`` it was
    gated on."""

    def test_delete_route_requires_the_write_permission(self):
        assert _declared_permissions("delete_old_history", "/printer-sensor-history") == [
            "printer_sensor_history:delete"
        ]

    def test_delete_route_no_longer_accepts_the_read_permission(self):
        """Pinned regression: this exact assertion is what the pre-fix code
        violated (the DELETE route was gated on ``printer_sensor_history:read``)."""
        assert _declared_permissions("delete_old_history", "/printer-sensor-history") != ["printer_sensor_history:read"]

    def test_get_route_permission_is_unchanged(self):
        """The read endpoint's gate must not have moved — only the DELETE
        gate changed."""
        assert _declared_permissions("get_printer_sensor_history", "/printer-sensor-history") == [
            "printer_sensor_history:read"
        ]

    def test_delete_route_uses_the_printer_scoped_dependency(self):
        """The fix also requires the per-printer API-key allowlist check,
        which only ``require_printer_permission_if_auth_enabled`` performs."""
        from backend.app.main import app

        route = next(
            r
            for r in app.routes
            if getattr(r, "name", "") == "delete_old_history" and "/printer-sensor-history" in r.path
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
        holding only ``printer_sensor_history:delete`` (isolates "has the
        write permission" from "is an Administrator", which holds every
        permission and so wouldn't distinguish a fix from a coincidence)."""
        from sqlalchemy import select as sa_select

        from backend.app.core.auth import create_access_token, get_password_hash
        from backend.app.models.group import Group
        from backend.app.models.settings import Settings
        from backend.app.models.user import User

        db_session.add(Settings(key="auth_enabled", value="true"))
        await db_session.commit()

        viewer_group = (await db_session.execute(sa_select(Group).where(Group.name == "Viewers"))).scalar_one()

        deleter_group = Group(
            name="printer-sensor-history-deleter",
            description="Test-only group holding just printer_sensor_history:delete",
            permissions=["printer_sensor_history:delete"],
            is_system=False,
        )
        db_session.add(deleter_group)
        await db_session.flush()

        password_hash = get_password_hash("password")

        viewer_user = User(username="psh_viewer", password_hash=password_hash, is_active=True)
        viewer_user.groups.append(viewer_group)

        deleter_user = User(username="psh_deleter", password_hash=password_hash, is_active=True)
        deleter_user.groups.append(deleter_group)

        db_session.add_all([viewer_user, deleter_user])
        await db_session.commit()

        return {
            "viewer_token": create_access_token(data={"sub": viewer_user.username}),
            "deleter_token": create_access_token(data={"sub": deleter_user.username}),
        }

    @pytest.mark.asyncio
    async def test_viewers_role_is_refused(self, async_client: AsyncClient, db_session: AsyncSession, auth_setup):
        """A principal holding only ``printer_sensor_history:read`` (the
        built-in Viewers role, per core/permissions.py) must get 403 on
        DELETE. This is the exact vulnerability T-033 closes — against the
        pre-fix gate (``printer_sensor_history:read`` on the DELETE route)
        this request would have returned 200."""
        printer = Printer(name="X1C", serial_number="X1C-TEST-005", ip_address="10.0.0.14", access_code="12345678")
        db_session.add(printer)
        await db_session.commit()
        await db_session.refresh(printer)

        response = await async_client.delete(
            f"/api/v1/printer-sensor-history/{printer.id}",
            params={"days": 30},
            headers={"Authorization": f"Bearer {auth_setup['viewer_token']}"},
        )
        assert response.status_code == 403

    @pytest.mark.asyncio
    async def test_write_permission_holder_succeeds(
        self, async_client: AsyncClient, db_session: AsyncSession, auth_setup
    ):
        """A principal holding ``printer_sensor_history:delete`` (and
        nothing else) must be allowed through."""
        printer = Printer(name="X1C", serial_number="X1C-TEST-006", ip_address="10.0.0.15", access_code="12345678")
        db_session.add(printer)
        await db_session.commit()
        await db_session.refresh(printer)

        response = await async_client.delete(
            f"/api/v1/printer-sensor-history/{printer.id}",
            params={"days": 30},
            headers={"Authorization": f"Bearer {auth_setup['deleter_token']}"},
        )
        assert response.status_code == 200
        assert response.json()["deleted"] == 0


class TestDeleteOldHistoryApiKeyPrinterAllowlist:
    """T-033 also requires wiring the per-printer API-key allowlist check
    (``check_printer_access``) onto the DELETE route, matching the pattern
    the 10 ``PRINTERS_FILES`` routes in printers.py already use."""

    @pytest.mark.asyncio
    async def test_api_key_excluded_from_the_printer_gets_403(
        self, async_client: AsyncClient, printer_factory, db_session: AsyncSession, monkeypatch
    ):
        """``PRINTER_SENSOR_HISTORY_DELETE`` is classified admin-only for API
        keys (matching the ``AMS_HISTORY_DELETE`` / ``ARCHIVES_PURGE`` /
        ``LIBRARY_PURGE`` precedent — see ``_APIKEY_DENIED_PERMISSIONS`` in
        core/auth.py), so a real API key can never clear the permission gate
        to reach the printer_ids check at all. That classification is
        covered separately by ``test_auth_apikey_rbac.py``. To exercise the
        printer-scoped allowlist wiring on *this* route in isolation, the
        permission-scope check is bypassed here so the request reaches
        ``check_printer_access``, proving the DELETE route is actually wired
        to the printer-scoped dependency, not just any permission dep.
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
            f"/api/v1/printer-sensor-history/{printer.id}",
            params={"days": 30},
            headers={"X-API-Key": full_key},
        )
        assert response.status_code == 403
        assert f"printer {printer.id}" in response.json()["detail"]
