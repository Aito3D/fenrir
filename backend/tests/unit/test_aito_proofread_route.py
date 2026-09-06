"""POST /aito/proofread: happy path, unconfigured 409, upstream 502, input caps,
and T-043's per-principal AI call rate limit."""

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
async def test_proofread_unconfigured_409(async_client):
    r = await async_client.post("/api/v1/aito/proofread", json={"text": "capot avec 3 pieces"})
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_proofread_happy(async_client, monkeypatch):
    async def fake(db, text):
        assert text == "capot avec 3 pieces"
        return "Capot avec 3 pièces", "mistralai/mistral-small-2603"

    # Patch the name the ROUTE looks up (import site), not the service module's.
    from backend.app.api.routes import aito as aito_routes

    monkeypatch.setattr(aito_routes, "proofread_text", fake)
    r = await async_client.post("/api/v1/aito/proofread", json={"text": "capot avec 3 pieces"})
    assert r.status_code == 200
    assert r.json() == {"text": "Capot avec 3 pièces", "model": "mistralai/mistral-small-2603"}


@pytest.mark.asyncio
async def test_proofread_upstream_502(async_client, monkeypatch):
    async def fake(db, text):
        raise openrouter_service.OpenRouterUpstreamError("boom")

    from backend.app.api.routes import aito as aito_routes

    monkeypatch.setattr(aito_routes, "proofread_text", fake)
    r = await async_client.post("/api/v1/aito/proofread", json={"text": "capot"})
    assert r.status_code == 502


@pytest.mark.asyncio
async def test_proofread_rejects_blank_text(async_client):
    # Whitespace-only is nothing to correct — reject before spending a call.
    r = await async_client.post("/api/v1/aito/proofread", json={"text": "   \n "})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_proofread_rejects_oversized_text(async_client):
    r = await async_client.post("/api/v1/aito/proofread", json={"text": "a" * 2001})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_proofread_sends_trimmed_text(async_client, monkeypatch):
    """The service receives the trimmed text — the model must never be asked to
    'correct' leading/trailing whitespace, and the echo the field swaps in must
    not reintroduce it."""
    seen: list[str] = []

    async def fake(db, text):
        seen.append(text)
        return "Capot", "mistralai/mistral-small-2603"

    from backend.app.api.routes import aito as aito_routes

    monkeypatch.setattr(aito_routes, "proofread_text", fake)
    r = await async_client.post("/api/v1/aito/proofread", json={"text": "  capot  "})
    assert r.status_code == 200
    assert seen == ["capot"]


# ---------------------------------------------------------------- T-043: rate limit


def _patch_proofread_text(monkeypatch):
    async def fake(db, text):
        return f"{text} corrigé", "mistralai/mistral-small-2603"

    monkeypatch.setattr(aito_routes, "proofread_text", fake)


@pytest.mark.asyncio
async def test_proofread_rate_limit_blocks_the_call_past_the_budget(async_client, monkeypatch):
    """The Nth call in the window still succeeds; the N+1th gets 429 with the
    exact detail, and never reaches the (billed) OpenRouter call."""
    calls: list[str] = []

    async def fake(db, text):
        calls.append(text)
        return "Capot corrigé", "mistralai/mistral-small-2603"

    monkeypatch.setattr(aito_routes, "proofread_text", fake)

    for _ in range(aito_routes._AI_RATE_LIMIT_MAX_CALLS):
        r = await async_client.post("/api/v1/aito/proofread", json={"text": "capot"})
        assert r.status_code == 200

    r = await async_client.post("/api/v1/aito/proofread", json={"text": "capot"})
    assert r.status_code == 429
    assert r.json()["detail"] == aito_routes._AI_RATE_LIMIT_DETAIL
    assert len(calls) == aito_routes._AI_RATE_LIMIT_MAX_CALLS


@pytest.mark.asyncio
async def test_proofread_rate_limit_is_per_principal(async_client, monkeypatch):
    """A different principal (a different `current_user`) is not affected by
    another principal's exhausted budget — the bucket is keyed per user, not
    global."""
    from backend.app.main import app
    from backend.app.models.group import Group
    from backend.app.models.user import User

    _patch_proofread_text(monkeypatch)

    for _ in range(aito_routes._AI_RATE_LIMIT_MAX_CALLS):
        r = await async_client.post("/api/v1/aito/proofread", json={"text": "capot"})
        assert r.status_code == 200
    blocked = await async_client.post("/api/v1/aito/proofread", json={"text": "capot"})
    assert blocked.status_code == 429

    route = next(r for r in app.routes if getattr(r, "name", "") == "proofread_field")
    dep = next(d.call for d in route.dependant.dependencies if d.name == "current_user")
    app.dependency_overrides[dep] = lambda: User(
        id=999, username="other", groups=[Group(name="t", permissions=["aito:create"])]
    )
    try:
        r = await async_client.post("/api/v1/aito/proofread", json={"text": "capot"})
        assert r.status_code == 200
    finally:
        app.dependency_overrides.pop(dep, None)


@pytest.mark.asyncio
async def test_proofread_rate_limit_clears_once_the_window_elapses(async_client, monkeypatch):
    """After the window passes, the same principal is allowed again. The
    module's own `time` name is rebound to a fake clock — never the real
    `time.monotonic`, which asyncio's loop also relies on."""
    clock = _FakeClock(start=1_000.0)
    monkeypatch.setattr(aito_routes, "time", clock)
    _patch_proofread_text(monkeypatch)

    for _ in range(aito_routes._AI_RATE_LIMIT_MAX_CALLS):
        r = await async_client.post("/api/v1/aito/proofread", json={"text": "capot"})
        assert r.status_code == 200
    blocked = await async_client.post("/api/v1/aito/proofread", json={"text": "capot"})
    assert blocked.status_code == 429

    clock.now += aito_routes._AI_RATE_LIMIT_WINDOW_S + 1
    r = await async_client.post("/api/v1/aito/proofread", json={"text": "capot"})
    assert r.status_code == 200
