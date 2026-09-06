"""POST /aito/summarize: happy path, unconfigured 409, upstream 502, and
T-043's per-principal AI call rate limit."""

import pytest

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
