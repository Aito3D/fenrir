"""T-036: real-JWT 403 sweep over every permission-gated route in
backend/app/api/routes/heimdall.py.

Every test in test_heimdall_route.py calls `/api/v1/heimdall/test` with no
Authorization header and no 401/403 assertion — none of them prove that
`RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE)` (declared on
the route as `_: User | None = ...`) actually rejects an unauthorized
caller. See test_aito_permissions.py's docstring for why overriding
`current_user` wholesale (the technique used elsewhere in this suite) proves
nothing about the REAL dependency: it replaces the very callable that would
enforce the gate.

Reuses `aito_tokens` from test_aito_permissions.py rather than duplicating
it: same two real, persisted principals (no permission at all; only the
sibling `aito:read`), same auth-enabled `Settings` row, same real JWT over
`Authorization`. A third principal holds `settings:read` but not
`settings:update`, to prove the gate is on the specific UPDATE permission
and not merely "any settings permission".
"""

import pytest

from backend.app.core.permissions import Permission
from backend.app.main import app
from backend.app.services.heimdall import heimdall_service
from backend.tests.unit.test_aito_permissions import aito_tokens  # noqa: F401


def _is_permission_gate(dep_call) -> bool:
    """True for a callable produced by `require_permission_if_auth_enabled`
    or `require_any_permission_if_auth_enabled` — matched by `__qualname__`
    rather than by the dependency parameter's NAME, since heimdall.py
    declares it as `_: User | None = ...`."""
    qualname = getattr(dep_call, "__qualname__", "")
    return qualname.startswith("require_permission_if_auth_enabled.") or qualname.startswith(
        "require_any_permission_if_auth_enabled."
    )


# Every @router.* in backend/app/api/routes/heimdall.py — 1 in total,
# confirmed by `grep -c '^@router' backend/app/api/routes/heimdall.py`.
HEIMDALL_ROUTES = [
    ("test_heimdall", "post", "/api/v1/heimdall/test", {}),
]

assert len(HEIMDALL_ROUTES) == 1, "HEIMDALL_ROUTES must cover exactly the 1 gated route heimdall.py declares"


@pytest.mark.asyncio
async def test_every_heimdall_route_declares_a_permission_gate():
    """A NEW route added to heimdall.py without RequirePermissionIfAuthEnabled
    or RequireAnyPermissionIfAuthEnabled fails HERE, rather than silently
    escaping the sweep below (which only iterates HEIMDALL_ROUTES by hand)."""
    heimdall_routes = [r for r in app.routes if getattr(r, "path", "").startswith("/api/v1/heimdall/")]
    assert len(heimdall_routes) == 1, (
        "heimdall.py grew or shrank a route — update HEIMDALL_ROUTES + this count together"
    )
    ungated = [
        r.name for r in heimdall_routes if not any(_is_permission_gate(d.call) for d in r.dependant.dependencies)
    ]
    assert ungated == [], f"these heimdall.py routes declare no permission gate: {ungated}"


@pytest.fixture
def no_heimdall_egress(monkeypatch):
    """Blocks every outbound Heimdall HTTP call at the single choke point
    every `heimdall_service` method funnels through (`_client`, used by
    `_request` for every ping/payments call) — proves a refused request
    never reaches Heimdall, regardless of which method the handler would
    have called had the gate let it through."""
    calls: list[str] = []

    def blocked():
        calls.append("client")
        raise AssertionError("a refused heimdall.py request reached Heimdall")

    monkeypatch.setattr(heimdall_service, "_client", blocked)
    return calls


@pytest.mark.asyncio
@pytest.mark.parametrize("route_name,method,url,body", HEIMDALL_ROUTES, ids=[r[0] for r in HEIMDALL_ROUTES])
@pytest.mark.parametrize("token_key", ["none", "read_only"])
async def test_heimdall_route_rejects_a_caller_with_no_settings_update_permission(
    async_client, aito_tokens, no_heimdall_egress, token_key, route_name, method, url, body
):
    """A caller holding no aito permission at all, or only the sibling aito
    read permission (`aito:read` — irrelevant to settings), must be refused
    by the permission-gated route in heimdall.py — and never reach Heimdall
    doing it."""
    kwargs = {"headers": {"Authorization": f"Bearer {aito_tokens[token_key]}"}}
    if body is not None:
        kwargs["json"] = body
    r = await getattr(async_client, method)(url, **kwargs)
    assert r.status_code == 403, f"{route_name} ({method.upper()} {url}) as {token_key}: got {r.status_code}"
    assert "Missing required permissions" in r.json()["detail"]
    assert no_heimdall_egress == [], f"{route_name} reached Heimdall despite the 403"


@pytest.fixture
async def settings_read_only_token(db_session):
    """A third real, persisted principal holding `settings:read` but not
    `settings:update` — proves the gate is specifically SETTINGS_UPDATE and
    not merely "any settings permission at all"."""
    from backend.app.core.auth import create_access_token, get_password_hash
    from backend.app.models.group import Group
    from backend.app.models.settings import Settings
    from backend.app.models.user import User

    db_session.add(Settings(key="auth_enabled", value="true"))

    group = Group(name="t036-settings-read-only", permissions=[Permission.SETTINGS_READ.value], is_system=False)
    db_session.add(group)
    await db_session.flush()

    user = User(username="t036-settings-read-only", password_hash=get_password_hash("password"), is_active=True)
    user.groups.append(group)
    db_session.add(user)
    await db_session.commit()

    return create_access_token(data={"sub": user.username})


@pytest.mark.asyncio
async def test_heimdall_route_rejects_a_caller_with_only_settings_read(
    async_client, settings_read_only_token, no_heimdall_egress
):
    r = await async_client.post(
        "/api/v1/heimdall/test", json={}, headers={"Authorization": f"Bearer {settings_read_only_token}"}
    )
    assert r.status_code == 403
    assert "Missing required permissions" in r.json()["detail"]
    assert no_heimdall_egress == []
