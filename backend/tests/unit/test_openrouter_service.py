"""OpenRouter summary service: prompt assembly, config gating, upstream errors."""

import httpx
import pytest

from backend.app.services import openrouter
from backend.app.services.openrouter import (
    OpenRouterNotConfiguredError,
    OpenRouterUpstreamError,
    _chat,
    _task_lines,
    summarize_tasks,
)
from backend.tests._fixtures.openrouter import FakeOpenRouterClient, FakeOpenRouterResponse

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


def test_task_lines_states_the_count_for_a_non_printing_service():
    lines = _task_lines([{"title": "Support", "usinage_cost": 1000.0, "usinage_quantity": 3}])
    assert lines == ["Support: usinage x3"]


def test_task_lines_omits_a_count_of_one():
    lines = _task_lines([{"title": "Support", "usinage_cost": 1000.0, "usinage_quantity": 1}])
    assert lines == ["Support: usinage"]


def test_task_lines_omits_a_null_count():
    lines = _task_lines([{"title": "Support", "usinage_cost": 1000.0}])
    assert lines == ["Support: usinage"]


def test_task_lines_states_printings_count_exactly_once():
    # Printing already has a detail group (colour, weight); its count must
    # land on the service name like every other service and NOT be repeated
    # in the parenthesised group too.
    lines = _task_lines(
        [
            {
                "title": "Capot",
                "impression_cost": 120.0,
                "impression_quantity": 3,
                "impression_color": "bleu",
                "impression_weight_g": 210.0,
            }
        ]
    )
    assert lines == ["Capot: impression 3D x3 (bleu, 210 g)"]
    assert lines[0].count("x3") == 1


def test_system_prompt_demands_digit_numbers():
    from backend.app.services.openrouter import _SYSTEM_PROMPT

    assert "chiffres" in _SYSTEM_PROMPT
    assert "en toutes lettres" in _SYSTEM_PROMPT


@pytest.mark.asyncio
async def test_summarize_raises_when_unconfigured(db_session):
    with pytest.raises(OpenRouterNotConfiguredError):
        await summarize_tasks(db_session, TASKS)


class _FakeClient(FakeOpenRouterClient):
    reply = "  Résumé du projet.  "


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


@pytest.mark.asyncio
async def test_summarize_upstream_error(db_session, monkeypatch):
    from backend.app.api.routes.settings import set_setting

    await set_setting(db_session, "openrouter_api_key", "sk-or-test")
    await db_session.commit()

    class _FailingClient(_FakeClient):
        async def post(self, url, headers=None, json=None):
            return FakeOpenRouterResponse(status_code=500, raw_json={}, text="boom")

    monkeypatch.setattr(openrouter.httpx, "AsyncClient", _FailingClient)
    with pytest.raises(OpenRouterUpstreamError):
        await summarize_tasks(db_session, TASKS)


@pytest.mark.asyncio
async def test_summarize_returns_truncated_content_instead_of_raising(db_session, monkeypatch):
    """summarize_tasks runs against a hard-coded 200-token budget, so hitting
    it is common, not exceptional — unlike proofread_text, a truncated
    summary is still returned as the summary rather than treated as an
    upstream failure. This is BASE behavior (pre-dating the proofread
    truncation guard) and must not regress just because the two callers
    share the `_chat` helper.
    """
    from backend.app.api.routes.settings import set_setting

    await set_setting(db_session, "openrouter_api_key", "sk-or-test")
    await db_session.commit()

    class _TruncatedClient(_FakeClient):
        reply = "Résumé du proj"
        finish_reason = "length"

    monkeypatch.setattr(openrouter.httpx, "AsyncClient", _TruncatedClient)
    summary, model = await summarize_tasks(db_session, TASKS)
    assert summary == "Résumé du proj"
    assert model == "mistralai/mistral-small"


@pytest.mark.parametrize("transport_error", [httpx.ConnectTimeout, httpx.ReadError])
@pytest.mark.asyncio
async def test_chat_wraps_transport_failures_in_upstream_error(monkeypatch, transport_error):
    """A raised httpx transport error (never a status code) must surface as
    OpenRouterUpstreamError, not the raw httpx exception — callers only
    handle the two module errors.
    """

    class _RaisingClient(_FakeClient):
        async def post(self, url, headers=None, json=None):
            raise transport_error("boom", request=httpx.Request("POST", url))

    monkeypatch.setattr(openrouter.httpx, "AsyncClient", _RaisingClient)
    with pytest.raises(OpenRouterUpstreamError, match="OpenRouter request failed"):
        await _chat("sk-or-test", "some-model", "system", "user", max_tokens=50)


@pytest.mark.parametrize(
    "malformed_payload",
    [
        {},
        {"choices": []},
        {"choices": [{"message": {}}]},
    ],
)
@pytest.mark.asyncio
async def test_chat_raises_on_malformed_payload(monkeypatch, malformed_payload):
    class _MalformedClient(_FakeClient):
        async def post(self, url, headers=None, json=None):
            return FakeOpenRouterResponse(raw_json=malformed_payload)

    monkeypatch.setattr(openrouter.httpx, "AsyncClient", _MalformedClient)
    with pytest.raises(OpenRouterUpstreamError, match="unexpected payload"):
        await _chat("sk-or-test", "some-model", "system", "user", max_tokens=50)


class _TruncatedClientForChat(_FakeClient):
    reply = "Résumé du proj"
    finish_reason = "length"


@pytest.mark.asyncio
async def test_chat_raises_on_truncation_when_opted_in(monkeypatch):
    """raise_on_truncation=True (proofread_text's own use) treats a
    finish_reason of "length" as an upstream failure rather than returning
    the cut-off text.
    """
    monkeypatch.setattr(openrouter.httpx, "AsyncClient", _TruncatedClientForChat)
    with pytest.raises(OpenRouterUpstreamError, match="truncated"):
        await _chat("sk-or-test", "some-model", "system", "user", max_tokens=50, raise_on_truncation=True)


@pytest.mark.asyncio
async def test_chat_returns_truncated_content_when_not_opted_in(monkeypatch):
    """Same truncated payload, but with the default raise_on_truncation=False
    (summarize_tasks' behavior): the cut-off content is still returned,
    pinning that the guard is opt-in.
    """
    monkeypatch.setattr(openrouter.httpx, "AsyncClient", _TruncatedClientForChat)
    content = await _chat("sk-or-test", "some-model", "system", "user", max_tokens=50)
    assert content == "Résumé du proj"


@pytest.mark.parametrize("empty_content", ["", "   "])
@pytest.mark.asyncio
async def test_chat_raises_on_empty_answer(monkeypatch, empty_content):
    class _EmptyClient(_FakeClient):
        async def post(self, url, headers=None, json=None):
            return FakeOpenRouterResponse(content=empty_content)

    monkeypatch.setattr(openrouter.httpx, "AsyncClient", _EmptyClient)
    with pytest.raises(OpenRouterUpstreamError, match="empty answer"):
        await _chat("sk-or-test", "some-model", "system", "user", max_tokens=50)
