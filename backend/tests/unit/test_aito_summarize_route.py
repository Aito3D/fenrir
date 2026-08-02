"""POST /aito/summarize: happy path, unconfigured 409, upstream 502."""

import pytest

from backend.app.services import openrouter as openrouter_service


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
