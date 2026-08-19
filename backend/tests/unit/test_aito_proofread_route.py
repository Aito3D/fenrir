"""POST /aito/proofread: happy path, unconfigured 409, upstream 502, input caps."""

import pytest

from backend.app.services import openrouter as openrouter_service


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
