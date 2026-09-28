"""POST /aito/ with `regenerate_description`: the card is summarised from the
tasks actually being created, and every failure of that summary keeps the
description the drawer sent instead of refusing the card."""

import pytest

from backend.app.api.routes import aito as aito_routes
from backend.app.services import openrouter as openrouter_service

_TASKS = [{"title": "Capot", "impression_cost": 120}, {"title": "Support", "scan_cost": 40}]


@pytest.fixture(autouse=True)
def _reset_ai_rate_limit():
    aito_routes._ai_rate_limit_calls.clear()
    yield
    aito_routes._ai_rate_limit_calls.clear()


async def _create(client, **overrides):
    payload = {
        "description": "Tâche 1 — Impression 3D",
        "client_id": "z1",
        "client_name": "ACME",
        "client_phone": "+33 6 12 34 56 78",
        "tasks": _TASKS,
    }
    payload.update(overrides)
    return await client.post("/api/v1/aito/", json=payload)


def _patch_summarize(monkeypatch, calls: list | None = None, *, raises: Exception | None = None):
    async def fake(db, tasks):
        if calls is not None:
            calls.append(tasks)
        if raises is not None:
            raise raises
        return "Impression 3D du capot et scan du support.", "mistralai/mistral-small"

    monkeypatch.setattr(aito_routes, "summarize_tasks", fake)


@pytest.mark.asyncio
async def test_regenerate_replaces_the_description_from_the_created_tasks(async_client, monkeypatch):
    calls: list = []
    _patch_summarize(monkeypatch, calls)

    r = await _create(async_client, regenerate_description=True)

    assert r.status_code == 201, r.text
    assert r.json()["description"] == "Impression 3D du capot et scan du support."
    # Summarised from the payload's tasks, in order — not from a re-read.
    assert [t["title"] for t in calls[0]] == ["Capot", "Support"]
    # The stored row agrees with the response.
    listed = (await async_client.get("/api/v1/aito/")).json()
    assert listed[0]["description"] == "Impression 3D du capot et scan du support."


@pytest.mark.asyncio
async def test_without_the_flag_the_description_is_stored_as_sent(async_client, monkeypatch):
    calls: list = []
    _patch_summarize(monkeypatch, calls)

    r = await _create(async_client)

    assert r.status_code == 201, r.text
    assert r.json()["description"] == "Tâche 1 — Impression 3D"
    assert calls == []


@pytest.mark.asyncio
async def test_regenerate_with_no_tasks_spends_nothing(async_client, monkeypatch):
    calls: list = []
    _patch_summarize(monkeypatch, calls)

    r = await _create(async_client, regenerate_description=True, tasks=[])

    assert r.status_code == 201, r.text
    assert r.json()["description"] == "Tâche 1 — Impression 3D"
    assert calls == []


@pytest.mark.asyncio
async def test_unconfigured_openrouter_keeps_the_sent_description(async_client, monkeypatch):
    _patch_summarize(monkeypatch, raises=openrouter_service.OpenRouterNotConfiguredError())

    r = await _create(async_client, regenerate_description=True)

    assert r.status_code == 201, r.text
    assert r.json()["description"] == "Tâche 1 — Impression 3D"


@pytest.mark.asyncio
async def test_upstream_failure_keeps_the_sent_description(async_client, monkeypatch):
    _patch_summarize(monkeypatch, raises=openrouter_service.OpenRouterUpstreamError("boom"))

    r = await _create(async_client, regenerate_description=True)

    assert r.status_code == 201, r.text
    assert r.json()["description"] == "Tâche 1 — Impression 3D"


@pytest.mark.asyncio
async def test_exhausted_ai_budget_keeps_the_sent_description_instead_of_429(async_client, monkeypatch):
    """The create shares the summarize route's per-principal OpenRouter
    budget, but past it the card is still created — with the drawer's text."""
    calls: list = []
    _patch_summarize(monkeypatch, calls)

    for _ in range(aito_routes._AI_RATE_LIMIT_MAX_CALLS):
        r = await async_client.post("/api/v1/aito/summarize", json={"tasks": _TASKS})
        assert r.status_code == 200

    r = await _create(async_client, regenerate_description=True)

    assert r.status_code == 201, r.text
    assert r.json()["description"] == "Tâche 1 — Impression 3D"
    assert len(calls) == aito_routes._AI_RATE_LIMIT_MAX_CALLS


@pytest.mark.asyncio
async def test_a_regenerating_create_counts_against_the_ai_budget(async_client, monkeypatch):
    _patch_summarize(monkeypatch)

    r = await _create(async_client, regenerate_description=True)
    assert r.status_code == 201, r.text

    for _ in range(aito_routes._AI_RATE_LIMIT_MAX_CALLS - 1):
        r = await async_client.post("/api/v1/aito/summarize", json={"tasks": _TASKS})
        assert r.status_code == 200
    r = await async_client.post("/api/v1/aito/summarize", json={"tasks": _TASKS})
    assert r.status_code == 429
