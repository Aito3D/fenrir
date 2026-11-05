"""The Order Board API: who may call what, and what the settings route accepts."""

import pytest

from backend.app.core.permissions import Permission
from backend.app.services import order_board_sync


@pytest.fixture
async def tokens(db_session):
    """Three persisted principals under auth-enabled: no orders permission,
    orders:read only, and both."""
    from backend.app.core.auth import create_access_token, get_password_hash
    from backend.app.models.group import Group
    from backend.app.models.settings import Settings
    from backend.app.models.user import User

    db_session.add(Settings(key="auth_enabled", value="true"))
    password_hash = get_password_hash("password")
    principals = {
        "none": [],
        "read": [Permission.ORDERS_READ.value],
        "both": [Permission.ORDERS_READ.value, Permission.ORDERS_UPDATE.value],
    }
    for name, perms in principals.items():
        group = Group(name=f"orders-{name}", permissions=perms, is_system=False)
        user = User(username=f"orders-{name}", password_hash=password_hash, is_active=True)
        user.groups.append(group)
        db_session.add_all([group, user])
    await db_session.commit()
    # Minted AFTER the commit: a token issued before its user's
    # password_changed_at is rejected as stale (401), and that stamp is set
    # when the row is saved. Minting first failed whenever a second ticked
    # over in between, which a loaded full-suite run made likely.
    return {
        name: {"Authorization": f"Bearer {create_access_token(data={'sub': f'orders-{name}'})}"} for name in principals
    }


SETTINGS = {"sync_enabled": True, "sync_minutes": 15, "max_age_days": 365, "core_brands": ["eSUN"]}


@pytest.mark.asyncio
async def test_read_needs_orders_read(async_client, tokens):
    assert (await async_client.get("/api/v1/order-board", headers=tokens["none"])).status_code == 403
    r = await async_client.get("/api/v1/order-board", headers=tokens["read"])
    assert r.status_code == 200
    assert set(r.json()) == {"rows", "computed_at", "stock_loaded_at", "sync"}
    assert set(r.json()["sync"]) == {
        "enabled",
        "configured",
        "running",
        "pending",
        "last_error",
        "last_error_at",
        "last_success_at",
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "url", "body"),
    [
        ("post", "/api/v1/order-board/refresh", None),
        ("get", "/api/v1/order-board/settings", None),
        ("put", "/api/v1/order-board/settings", SETTINGS),
    ],
)
async def test_refresh_and_settings_need_orders_update(async_client, tokens, method, url, body):
    kwargs = {"json": body} if body else {}
    for who in ("none", "read"):
        r = await getattr(async_client, method)(url, headers=tokens[who], **kwargs)
        assert r.status_code == 403, f"{method.upper()} {url} as {who}: {r.status_code}"


@pytest.mark.asyncio
async def test_refresh_runs_one_pass_and_returns_the_board(async_client, tokens, monkeypatch):
    calls = []

    async def fake_pass(db):
        calls.append(db)
        return True

    monkeypatch.setattr(order_board_sync, "run_pass", fake_pass)
    r = await async_client.post("/api/v1/order-board/refresh", headers=tokens["both"])
    assert r.status_code == 200
    assert len(calls) == 1
    assert r.json()["rows"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "patch",
    [
        {"sync_minutes": 7},
        {"max_age_days": -1},
        {"max_age_days": 3651},
        {"core_brands": [" eSUN ", ""]},
        {"core_brands": ["x" * 61]},
        {"core_brands": [f"brand {n}" for n in range(31)]},
    ],
)
async def test_put_settings_rejects_bad_values(async_client, tokens, patch):
    r = await async_client.put("/api/v1/order-board/settings", headers=tokens["both"], json={**SETTINGS, **patch})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_put_settings_cleans_persists_and_returns_the_values(async_client, tokens):
    body = {"sync_enabled": False, "sync_minutes": 60, "max_age_days": 0, "core_brands": [" eSUN ", "esun", "Marlow"]}
    r = await async_client.put("/api/v1/order-board/settings", headers=tokens["both"], json=body)
    assert r.status_code == 200
    expected = {"sync_enabled": False, "sync_minutes": 60, "max_age_days": 0, "core_brands": ["eSUN", "Marlow"]}
    assert r.json() == expected
    assert (await async_client.get("/api/v1/order-board/settings", headers=tokens["both"])).json() == expected


@pytest.mark.asyncio
async def test_settings_defaults(async_client, tokens):
    r = await async_client.get("/api/v1/order-board/settings", headers=tokens["both"])
    assert r.json() == {
        "sync_enabled": True,
        "sync_minutes": 15,
        "max_age_days": 365,
        "core_brands": ["Bambu Lab", "eSUN", "SUNLU", "Polymaker", "Inslogic", "Magigoo"],
    }
