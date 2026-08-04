"""OpenRouter summary service: prompt assembly, config gating, upstream errors."""

import httpx
import pytest

from backend.app.services import openrouter
from backend.app.services.openrouter import (
    OpenRouterNotConfiguredError,
    OpenRouterUpstreamError,
    _task_lines,
    summarize_tasks,
)

TASKS = [
    {
        "title": "Capot moteur",
        "scan_description": None,
        "modelisation_description": None,
        "impression_description": "fissuré",
        "usinage_description": None,
        "scan_cost": None,
        "modelisation_cost": None,
        "usinage_cost": None,
        "impression_cost": 120.0,
        "impression_weight_g": 86.0,
        "impression_time_min": 260,
        "impression_quantity": 1,
        "impression_color": "noir",
        "impression_printer_id": 1,
        "impression_filament_id": 2,
        "scan_done": False,
        "modelisation_done": False,
        "impression_done": False,
        "usinage_done": False,
    },
    {"title": "Support antenne", "modelisation_cost": 60.0},
]


def test_task_lines_names_enabled_services_only():
    lines = _task_lines(TASKS)
    assert "Capot moteur" in lines[0]
    assert "impression 3D" in lines[0]
    assert "scan" not in lines[0].lower()
    assert "modélisation 3D" in lines[1]


def test_task_lines_truncates_title_and_description_to_500_chars():
    long_task = {"title": "T" * 900, "impression_cost": 120.0, "impression_description": "D" * 900}
    lines = _task_lines([long_task])
    # Title is truncated to 500 chars before it's used as the line's prefix.
    assert "T" * 500 in lines[0]
    assert "T" * 501 not in lines[0]
    # Description is truncated to 500 chars before being appended.
    assert "D" * 500 in lines[0]
    assert "D" * 501 not in lines[0]


def test_task_lines_carry_enabled_service_descriptions():
    lines = _task_lines(
        [
            {
                "title": "Capot",
                "scan_cost": 50.0,
                "scan_description": "Scanner l'original",
                "modelisation_cost": None,
                "modelisation_description": "ignorée : service désactivé",
                "impression_cost": 120.0,
                "impression_description": "PETG noir",
                "usinage_cost": None,
                "usinage_description": None,
            }
        ]
    )
    assert "Scanner l'original" in lines[0]
    assert "PETG noir" in lines[0]
    # A description on a DISABLED service is not part of the job.
    assert "ignorée : service désactivé" not in lines[0]


def test_system_prompt_demands_digit_numbers():
    from backend.app.services.openrouter import _SYSTEM_PROMPT

    assert "chiffres" in _SYSTEM_PROMPT
    assert "en toutes lettres" in _SYSTEM_PROMPT


@pytest.mark.asyncio
async def test_summarize_raises_when_unconfigured(db_session):
    with pytest.raises(OpenRouterNotConfiguredError):
        await summarize_tasks(db_session, TASKS)


class _FakeResponse:
    status_code = 200

    def json(self):
        return {"choices": [{"message": {"content": "  Résumé du projet.  "}}]}


class _FakeClient:
    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, headers=None, json=None):
        _FakeClient.last_json = json
        return _FakeResponse()


@pytest.mark.asyncio
async def test_summarize_happy_path(db_session, monkeypatch):
    from backend.app.api.routes.settings import set_setting

    await set_setting(db_session, "openrouter_api_key", "sk-or-test")
    await db_session.commit()
    monkeypatch.setattr(openrouter.httpx, "AsyncClient", _FakeClient)
    summary, model = await summarize_tasks(db_session, TASKS)
    assert summary == "Résumé du projet."
    assert model == "mistralai/mistral-small"
    assert _FakeClient.last_json["model"] == "mistralai/mistral-small"
    # French system prompt rides along
    assert "français" in _FakeClient.last_json["messages"][0]["content"].lower()


class _ErrorResponse:
    status_code = 500
    text = "boom"

    def json(self):
        return {}


@pytest.mark.asyncio
async def test_summarize_upstream_error(db_session, monkeypatch):
    from backend.app.api.routes.settings import set_setting

    await set_setting(db_session, "openrouter_api_key", "sk-or-test")
    await db_session.commit()

    class _FailingClient(_FakeClient):
        async def post(self, url, headers=None, json=None):
            return _ErrorResponse()

    monkeypatch.setattr(openrouter.httpx, "AsyncClient", _FailingClient)
    with pytest.raises(OpenRouterUpstreamError):
        await summarize_tasks(db_session, TASKS)
