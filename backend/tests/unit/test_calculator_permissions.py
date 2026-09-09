"""T-031: end-to-end negative-permission sweep for every Calculator write route.

test_calculator_zoho_routes.py's ``TestZohoFilamentSearchRequiresCalculatorUpdate``
is the only negative-permission test anywhere in the calculator test surface,
and it covers ``GET /calculator/zoho-filaments`` -- a READ endpoint
deliberately gated on ``calculator:update`` for confidentiality (T-068), not
one of the 8 actual mutating routes declared with
``RequirePermissionIfAuthEnabled(Permission.CALCULATOR_UPDATE)`` in
``backend/app/api/routes/calculator.py``: ``create_calculator_filament``,
``update_calculator_filament``, ``delete_calculator_filament``,
``sync_calculator_filaments_from_zoho``, ``create_calculator_printer``,
``update_calculator_printer``, ``delete_calculator_printer``, and
``update_calculator_defaults``.

Per T-030's finding (see test_aito_permissions.py), a dependency override
that replaces the whole ``current_user`` callable with a lambda BYPASSES
``RequirePermissionIfAuthEnabled``'s own ``has_all_permissions``/403 logic
entirely -- it only ever reaches whatever secondary check the handler body
performs, and yields 404/422 instead of 403 for routes with no such check.
This file therefore uses the same real-dependency technique
test_aito_permissions.py established: auth turned on via a genuine
``Settings`` row, real persisted users/groups, and real JWTs sent over
``Authorization`` -- never an override of ``current_user`` itself. The
existing ``calculator_read_only_setup``/``calculator_update_setup`` fixtures
in test_calculator_zoho_routes.py already follow this same real-JWT
technique (they insert a user/group pair and patch only
``is_auth_enabled`` to return True), so their shape is mirrored here rather
than reused directly, to keep this file self-contained with its own
"no permission at all" case those fixtures don't cover.

``require_permission_if_auth_enabled``-family dependencies resolve as FastAPI
sub-dependencies BEFORE the path id is looked up or the body is validated --
already pinned for Aito's identical dependency by
test_aito_permissions.py::test_permission_gate_rejects_a_nonexistent_id_and_an_invalid_body_before_either_is_reached.
``test_permission_gate_rejects_a_nonexistent_id_and_an_invalid_body_before_either_is_reached``
below re-confirms the same ordering against calculator's own routes, so every
case in the sweep can target a filament/printer id that does not exist,
without seeding any real calculator row.
"""

import pytest

from backend.app.core.permissions import Permission

# An id that can never exist in a freshly-seeded test database. The gate
# fires before the handler ever looks the id up (confirmed below), so no
# fixture needs to create a real filament or printer for any of the cases in
# WRITE_ROUTES.
_MISSING_ID = 999_999_999

_FILAMENT_BODY = {"material": "PLA", "cost_per_kg": 20.0}
_PRINTER_BODY = {
    "name": "Test Printer",
    "purchase_price": 999.0,
    "lifetime_years": 3.0,
    "daily_usage_hours": 8.0,
    "power_watts": 150.0,
    "repair_rate_pct": 5.0,
}


@pytest.fixture
async def calculator_tokens(db_session):
    """Three real, persisted principals under auth-enabled: one holding NO
    calculator permission at all, one holding only ``calculator:read`` (the
    sibling read permission every write route's gate must still refuse), and
    one holding ``calculator:update`` (must get past the gate). Mirrors
    test_aito_permissions.py's ``aito_tokens`` fixture."""
    from backend.app.core.auth import create_access_token, get_password_hash
    from backend.app.models.group import Group
    from backend.app.models.settings import Settings
    from backend.app.models.user import User

    db_session.add(Settings(key="auth_enabled", value="true"))

    no_perm_group = Group(name="t031-no-calc", permissions=[], is_system=False)
    read_only_group = Group(name="t031-calc-read-only", permissions=[Permission.CALCULATOR_READ.value], is_system=False)
    update_group = Group(name="t031-calc-update", permissions=[Permission.CALCULATOR_UPDATE.value], is_system=False)
    db_session.add_all([no_perm_group, read_only_group, update_group])
    await db_session.flush()

    password_hash = get_password_hash("password")
    no_perm_user = User(username="t031-no-perm", password_hash=password_hash, is_active=True)
    no_perm_user.groups.append(no_perm_group)
    read_only_user = User(username="t031-read-only", password_hash=password_hash, is_active=True)
    read_only_user.groups.append(read_only_group)
    update_user = User(username="t031-update", password_hash=password_hash, is_active=True)
    update_user.groups.append(update_group)
    db_session.add_all([no_perm_user, read_only_user, update_user])
    await db_session.commit()

    return {
        "none": create_access_token(data={"sub": no_perm_user.username}),
        "read_only": create_access_token(data={"sub": read_only_user.username}),
        "update": create_access_token(data={"sub": update_user.username}),
    }


# Every RequirePermissionIfAuthEnabled(Permission.CALCULATOR_UPDATE) route in
# backend/app/api/routes/calculator.py -- 8 in total, confirmed by
# `grep -n RequirePermissionIfAuthEnabled backend/app/api/routes/calculator.py`.
# (route_name, method, url, json_body). `route_name` is the FastAPI handler's
# function name, used only in assertion failure messages here.
WRITE_ROUTES = [
    ("create_calculator_filament", "post", "/api/v1/calculator/filaments/", _FILAMENT_BODY),
    ("update_calculator_filament", "patch", f"/api/v1/calculator/filaments/{_MISSING_ID}", {}),
    ("delete_calculator_filament", "delete", f"/api/v1/calculator/filaments/{_MISSING_ID}", None),
    ("sync_calculator_filaments_from_zoho", "post", "/api/v1/calculator/filaments/zoho-sync", {}),
    ("create_calculator_printer", "post", "/api/v1/calculator/printers/", _PRINTER_BODY),
    ("update_calculator_printer", "patch", f"/api/v1/calculator/printers/{_MISSING_ID}", {}),
    ("delete_calculator_printer", "delete", f"/api/v1/calculator/printers/{_MISSING_ID}", None),
    ("update_calculator_defaults", "patch", "/api/v1/calculator/defaults", {}),
]

assert len(WRITE_ROUTES) == 8, "WRITE_ROUTES must cover exactly the 8 CALCULATOR_UPDATE-gated write routes"


@pytest.mark.asyncio
async def test_permission_gate_rejects_a_nonexistent_id_and_an_invalid_body_before_either_is_reached(
    async_client, calculator_tokens
):
    """Pins the ordering the rest of this file's fixture strategy relies on:
    ``update_calculator_filament`` targets an id that cannot exist, with a
    body that would independently fail its own schema validation
    (``cost_per_kg`` must be > 0) -- and still gets 403, not 404 (id looked
    up in the handler body) or 422 (body failed schema validation). The
    permission dependency runs first regardless."""
    r = await async_client.patch(
        f"/api/v1/calculator/filaments/{_MISSING_ID}",
        json={"cost_per_kg": -5},
        headers={"Authorization": f"Bearer {calculator_tokens['none']}"},
    )
    assert r.status_code == 403

    r = await async_client.delete(
        f"/api/v1/calculator/printers/{_MISSING_ID}",
        headers={"Authorization": f"Bearer {calculator_tokens['none']}"},
    )
    assert r.status_code == 403


@pytest.mark.asyncio
@pytest.mark.parametrize("route_name,method,url,body", WRITE_ROUTES, ids=[r[0] for r in WRITE_ROUTES])
@pytest.mark.parametrize("token_key", ["none", "read_only"])
async def test_write_route_rejects_a_caller_without_calculator_update(
    async_client, calculator_tokens, token_key, route_name, method, url, body
):
    """A caller holding no calculator permission at all, or only the sibling
    read permission (``calculator:read``), must be refused by every one of
    the 8 write routes gated with
    ``RequirePermissionIfAuthEnabled(Permission.CALCULATOR_UPDATE)``."""
    kwargs = {"headers": {"Authorization": f"Bearer {calculator_tokens[token_key]}"}}
    if body is not None:
        kwargs["json"] = body
    r = await getattr(async_client, method)(url, **kwargs)
    assert r.status_code == 403, f"{route_name} ({method.upper()} {url}) as {token_key}: got {r.status_code}"
    assert "Missing required permissions" in r.json()["detail"]


@pytest.mark.asyncio
@pytest.mark.parametrize("route_name,method,url,body", WRITE_ROUTES, ids=[r[0] for r in WRITE_ROUTES])
async def test_write_route_admits_a_caller_with_calculator_update(
    async_client, calculator_tokens, route_name, method, url, body
):
    """A caller holding ``calculator:update`` must get past the gate on every
    one of the 8 write routes -- whatever the handler itself then does with a
    nonexistent id or an otherwise-empty body (2xx, 404, 422, ...), it must
    never be the gate's own 403."""
    kwargs = {"headers": {"Authorization": f"Bearer {calculator_tokens['update']}"}}
    if body is not None:
        kwargs["json"] = body
    r = await getattr(async_client, method)(url, **kwargs)
    assert r.status_code != 403, f"{route_name} ({method.upper()} {url}) as update: got {r.status_code}"


# ------------------------------------------------------ no outbound calls


@pytest.mark.asyncio
async def test_zoho_sync_makes_no_outbound_call_when_rejected(async_client, calculator_tokens, monkeypatch):
    """The zoho-sync route talks to Zoho before touching any local filament
    row -- a rejected caller must never trigger that call."""
    from backend.app.services import zoho_filaments
    from backend.app.services.zoho import zoho_service

    calls = []

    async def fake_is_configured(db):
        calls.append("is_configured")
        return True

    async def fake_fetch_catalogue(db, *, refresh=True):
        calls.append("fetch_catalogue")
        return []

    monkeypatch.setattr(zoho_service, "is_configured", fake_is_configured)
    monkeypatch.setattr(zoho_filaments, "fetch_catalogue", fake_fetch_catalogue)

    for token_key in ("none", "read_only"):
        r = await async_client.post(
            "/api/v1/calculator/filaments/zoho-sync",
            json={},
            headers={"Authorization": f"Bearer {calculator_tokens[token_key]}"},
        )
        assert r.status_code == 403

    assert calls == []


# ------------------------------------------ T-014: CALCULATOR_READ is user-token only


@pytest.fixture
async def t014_read_status_api_key(db_session):
    """A real, persisted API key with `can_read_status=True` -- the flag
    CALCULATOR_READ used to map to, same as every other read permission
    (PRINTERS_READ, SETTINGS_READ, ...). Also turns auth on. Mirrors
    test_aito_permissions.py's `t024_read_status_api_key` fixture."""
    from backend.app.core.auth import generate_api_key
    from backend.app.models.api_key import APIKey
    from backend.app.models.settings import Settings

    db_session.add(Settings(key="auth_enabled", value="true"))

    full_key, key_hash, key_prefix = generate_api_key()
    db_session.add(
        APIKey(
            name="t014-read-status",
            key_hash=key_hash,
            key_prefix=key_prefix,
            can_read_status=True,
            enabled=True,
        )
    )
    await db_session.commit()
    return full_key


@pytest.mark.asyncio
async def test_read_status_api_key_cannot_read_calculator_defaults(async_client, t014_read_status_api_key):
    """T-014: an API key holding only `can_read_status` (the flag it used to
    map to) must now be refused GET /api/v1/calculator/defaults -- the
    response carries the shop's confidential cost base (labor rate, margin
    curve, markups), so it is no longer on the default API-key scope."""
    r = await async_client.get("/api/v1/calculator/defaults", headers={"X-API-Key": t014_read_status_api_key})
    assert r.status_code == 403
    assert "administrative operations" in r.json()["detail"]


@pytest.mark.asyncio
async def test_calculator_read_user_token_can_still_read_defaults(async_client, calculator_tokens):
    """T-014 is scoped to the API-key allowlist only -- a genuine user token
    holding `calculator:read` is unaffected and still gets 200."""
    r = await async_client.get(
        "/api/v1/calculator/defaults",
        headers={"Authorization": f"Bearer {calculator_tokens['read_only']}"},
    )
    assert r.status_code == 200
