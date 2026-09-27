"""POST /aito/summarize: happy path, unconfigured 409, upstream 502, and
T-043's per-principal AI call rate limit."""

import pytest
from fastapi import HTTPException

from backend.app.api.routes import aito as aito_routes
from backend.app.services import openrouter as openrouter_service


class _FakeClock:
    """Stands in for the module's `time` name — only `.monotonic()` is used
    by `_check_ai_rate_limit`. Never patch the real `time.monotonic`: asyncio's
    own loop internals depend on it, and this test suite runs async tests."""

    def __init__(self, start: float = 0.0):
        self.now = start

    def monotonic(self) -> float:
        return self.now


@pytest.fixture(autouse=True)
def _reset_ai_rate_limit():
    """Every route in this file shares the module-level bucket dict — clear it
    so one test's calls never count against another's budget."""
    aito_routes._ai_rate_limit_calls.clear()
    yield
    aito_routes._ai_rate_limit_calls.clear()


@pytest.mark.asyncio
async def test_summarize_unconfigured_409(async_client):
    r = await async_client.post(
        "/api/v1/aito/summarize",
        json={"tasks": [{"title": "Capot", "impression_cost": 120}]},
    )
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_summarize_happy(async_client, monkeypatch):
    async def fake(db, tasks):
        assert tasks[0]["title"] == "Capot"
        return "Impression 3D du capot.", "mistralai/mistral-small"

    # Patch the name the ROUTE looks up (import site), not the service module's.
    from backend.app.api.routes import aito as aito_routes

    monkeypatch.setattr(aito_routes, "summarize_tasks", fake)
    r = await async_client.post(
        "/api/v1/aito/summarize",
        json={"tasks": [{"title": "Capot", "impression_cost": 120}]},
    )
    assert r.status_code == 200
    assert r.json() == {"summary": "Impression 3D du capot.", "model": "mistralai/mistral-small"}


@pytest.mark.asyncio
async def test_summarize_upstream_502(async_client, monkeypatch):
    async def fake(db, tasks):
        raise openrouter_service.OpenRouterUpstreamError("boom")

    from backend.app.api.routes import aito as aito_routes

    monkeypatch.setattr(aito_routes, "summarize_tasks", fake)
    r = await async_client.post(
        "/api/v1/aito/summarize",
        json={"tasks": [{"title": "Capot", "impression_cost": 120}]},
    )
    assert r.status_code == 502


@pytest.mark.asyncio
async def test_summarize_requires_a_task(async_client):
    r = await async_client.post("/api/v1/aito/summarize", json={"tasks": []})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_summarize_rejects_more_than_fifty_tasks(async_client):
    tasks = [{"title": f"Tâche {i}", "impression_cost": 1} for i in range(51)]
    r = await async_client.post("/api/v1/aito/summarize", json={"tasks": tasks})
    assert r.status_code == 422


# ---------------------------------------------------------------- T-043: rate limit

_PAYLOAD = {"tasks": [{"title": "Capot", "impression_cost": 120}]}


def _patch_summarize_tasks(monkeypatch):
    async def fake(db, tasks):
        return "Impression 3D du capot.", "mistralai/mistral-small"

    monkeypatch.setattr(aito_routes, "summarize_tasks", fake)


@pytest.mark.asyncio
async def test_summarize_rate_limit_blocks_the_call_past_the_budget(async_client, monkeypatch):
    """The Nth call in the window still succeeds; the N+1th gets 429 with the
    exact detail, and never reaches the (billed) OpenRouter call."""
    calls: list[str] = []

    async def fake(db, tasks):
        calls.append("call")
        return "Impression 3D du capot.", "mistralai/mistral-small"

    monkeypatch.setattr(aito_routes, "summarize_tasks", fake)

    for _ in range(aito_routes._AI_RATE_LIMIT_MAX_CALLS):
        r = await async_client.post("/api/v1/aito/summarize", json=_PAYLOAD)
        assert r.status_code == 200

    r = await async_client.post("/api/v1/aito/summarize", json=_PAYLOAD)
    assert r.status_code == 429
    assert r.json()["detail"] == aito_routes._AI_RATE_LIMIT_DETAIL
    assert len(calls) == aito_routes._AI_RATE_LIMIT_MAX_CALLS


@pytest.mark.asyncio
async def test_summarize_rate_limit_is_per_principal(async_client, monkeypatch):
    """A different principal (a different `current_user`) is not affected by
    another principal's exhausted budget — the bucket is keyed per user, not
    global."""
    from backend.app.main import app
    from backend.app.models.group import Group
    from backend.app.models.user import User

    _patch_summarize_tasks(monkeypatch)

    for _ in range(aito_routes._AI_RATE_LIMIT_MAX_CALLS):
        r = await async_client.post("/api/v1/aito/summarize", json=_PAYLOAD)
        assert r.status_code == 200
    blocked = await async_client.post("/api/v1/aito/summarize", json=_PAYLOAD)
    assert blocked.status_code == 429

    route = next(r for r in app.routes if getattr(r, "name", "") == "summarize_project")
    dep = next(d.call for d in route.dependant.dependencies if d.name == "current_user")
    app.dependency_overrides[dep] = lambda: User(
        id=999, username="other", groups=[Group(name="t", permissions=["aito:create"])]
    )
    try:
        r = await async_client.post("/api/v1/aito/summarize", json=_PAYLOAD)
        assert r.status_code == 200
    finally:
        app.dependency_overrides.pop(dep, None)


@pytest.mark.asyncio
async def test_summarize_rate_limit_clears_once_the_window_elapses(async_client, monkeypatch):
    """After the window passes, the same principal is allowed again. The
    module's own `time` name is rebound to a fake clock — never the real
    `time.monotonic`, which asyncio's loop also relies on."""
    clock = _FakeClock(start=1_000.0)
    monkeypatch.setattr(aito_routes, "time", clock)
    _patch_summarize_tasks(monkeypatch)

    for _ in range(aito_routes._AI_RATE_LIMIT_MAX_CALLS):
        r = await async_client.post("/api/v1/aito/summarize", json=_PAYLOAD)
        assert r.status_code == 200
    blocked = await async_client.post("/api/v1/aito/summarize", json=_PAYLOAD)
    assert blocked.status_code == 429

    clock.now += aito_routes._AI_RATE_LIMIT_WINDOW_S + 1
    r = await async_client.post("/api/v1/aito/summarize", json=_PAYLOAD)
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_summarize_rate_limit_key_is_proxy_aware(async_client, monkeypatch):
    """T-032: the anonymous bucket used to be keyed on `request.client.host`
    -- the raw TCP peer -- so behind a reverse proxy every visitor shared
    one `ip:<proxy>` bucket. It is now resolved through auth.py's
    proxy-aware `_get_client_ip`, the same helper `_track_rate_limited`
    already uses for the public tracking route: two different visitors
    forwarded by a TRUSTED_PROXY_IPS peer get two buckets, and an untrusted
    peer's forged X-Forwarded-For is ignored."""
    from backend.app.api.routes import auth as auth_routes

    _patch_summarize_tasks(monkeypatch)

    # The test client's own TCP peer becomes a trusted proxy; the real
    # visitor is whoever X-Forwarded-For names.
    monkeypatch.setattr(auth_routes, "_TRUSTED_PROXY_IPS", frozenset({"127.0.0.1"}))

    for _ in range(aito_routes._AI_RATE_LIMIT_MAX_CALLS):
        r = await async_client.post("/api/v1/aito/summarize", json=_PAYLOAD, headers={"X-Forwarded-For": "203.0.113.5"})
        assert r.status_code == 200
    blocked = await async_client.post(
        "/api/v1/aito/summarize", json=_PAYLOAD, headers={"X-Forwarded-For": "203.0.113.5"}
    )
    assert blocked.status_code == 429
    assert "ai:ip:203.0.113.5" in aito_routes._ai_rate_limit_calls

    # A second visitor behind the same trusted proxy is not affected --
    # its own bucket, keyed on its own forwarded address.
    r = await async_client.post("/api/v1/aito/summarize", json=_PAYLOAD, headers={"X-Forwarded-For": "203.0.113.6"})
    assert r.status_code == 200
    assert "ai:ip:203.0.113.6" in aito_routes._ai_rate_limit_calls


@pytest.mark.asyncio
async def test_summarize_rate_limit_ignores_a_forged_header_from_an_untrusted_peer(async_client, monkeypatch):
    """No TRUSTED_PROXY_IPS configured (the default): `_get_client_ip` cannot
    unwrap X-Forwarded-For, so a forged header from an ordinary caller must
    not let it hop into someone else's bucket or dodge its own budget."""
    from backend.app.api.routes import auth as auth_routes

    _patch_summarize_tasks(monkeypatch)
    monkeypatch.setattr(auth_routes, "_TRUSTED_PROXY_IPS", frozenset())

    for _ in range(aito_routes._AI_RATE_LIMIT_MAX_CALLS):
        r = await async_client.post("/api/v1/aito/summarize", json=_PAYLOAD, headers={"X-Forwarded-For": "203.0.113.5"})
        assert r.status_code == 200
    blocked = await async_client.post(
        "/api/v1/aito/summarize", json=_PAYLOAD, headers={"X-Forwarded-For": "203.0.113.5"}
    )
    assert blocked.status_code == 429
    # Keyed on the real (test client) peer, not the forged header.
    assert "ai:ip:127.0.0.1" in aito_routes._ai_rate_limit_calls
    assert not any(k.startswith("ai:ip:203.0.113.5") for k in aito_routes._ai_rate_limit_calls)


class _FakeRequest:
    """Just enough of `Request` for `_ai_rate_limit_key`'s no-auth branch:
    `request.client.host`."""

    class _Client:
        def __init__(self, host: str) -> None:
            self.host = host

    def __init__(self, host: str) -> None:
        self.client = self._Client(host)


def test_stale_keys_are_swept_while_a_key_inside_its_window_keeps_counting(monkeypatch):
    """T-015: the shared `_ai_rate_limit_calls` dict used to keep a key
    forever once created. Past `_AI_RATE_LIMIT_SWEEP_ABOVE` entries, a call
    now drops any key with nothing left inside the window — but a key that
    was touched again inside its window must survive the same sweep with its
    call count intact (429 behaviour must not change for it)."""
    clock = _FakeClock(start=0.0)
    monkeypatch.setattr(aito_routes, "time", clock)

    # More filler principals than the sweep threshold, all called once at t=0.
    for i in range(aito_routes._AI_RATE_LIMIT_SWEEP_ABOVE + 1):
        aito_routes._check_rate_limit(_FakeRequest(f"10.0.0.{i}"), None, bucket="filler", max_calls=1000, detail="x")
    # `keeper` is called once at t=0 too, then again just before the window
    # on its first call would elapse — same shape as a caller polling well
    # inside the limiter's window.
    aito_routes._check_rate_limit(_FakeRequest("keeper"), None, bucket="keeper_bucket", max_calls=5, detail="x")

    clock.now = aito_routes._AI_RATE_LIMIT_WINDOW_S - 1
    aito_routes._check_rate_limit(_FakeRequest("keeper"), None, bucket="keeper_bucket", max_calls=5, detail="x")

    # Past the window for everything called at t=0 (the fillers, and
    # `keeper`'s FIRST call) but not for `keeper`'s second call.
    clock.now = aito_routes._AI_RATE_LIMIT_WINDOW_S + 1
    aito_routes._check_rate_limit(_FakeRequest("poke"), None, bucket="trigger", max_calls=1000, detail="x")

    assert "filler:ip:10.0.0.0" not in aito_routes._ai_rate_limit_calls  # stale: swept
    assert "keeper_bucket:ip:keeper" in aito_routes._ai_rate_limit_calls  # a live entry survives: kept
    # The sweep only ever deletes whole keys with nothing live left; it never
    # prunes a surviving key's own list (that happens on the key's own next
    # direct hit, same as before this change) — so both of `keeper`'s calls
    # are still there.
    assert aito_routes._ai_rate_limit_calls["keeper_bucket:ip:keeper"] == [0, aito_routes._AI_RATE_LIMIT_WINDOW_S - 1]
    assert "trigger:ip:poke" in aito_routes._ai_rate_limit_calls  # this call's own key

    # 429 behaviour for `keeper` is unaffected: it still has 1 live call, so
    # 4 more are allowed under its max_calls=5 budget before a 5th refuses.
    for _ in range(4):
        aito_routes._check_rate_limit(_FakeRequest("keeper"), None, bucket="keeper_bucket", max_calls=5, detail="x")
    with pytest.raises(HTTPException) as exc:
        aito_routes._check_rate_limit(_FakeRequest("keeper"), None, bucket="keeper_bucket", max_calls=5, detail="x")
    assert exc.value.status_code == 429
