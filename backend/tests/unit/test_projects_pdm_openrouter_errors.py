"""OpenRouter error mapping for the Projects-PDM AI routes: status, detail,
exception chaining and the per-route warning line."""

import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from backend.app.api.routes import projects_pdm
from backend.app.schemas.project import ProjectReformulateRequest, ProjectSuggestTagsRequest
from backend.app.services.openrouter import OpenRouterNotConfiguredError, OpenRouterUpstreamError

LOGGER = "backend.app.api.routes.projects_pdm"


def _db():
    result = MagicMock()
    result.all.return_value = []
    return SimpleNamespace(execute=AsyncMock(return_value=result))


async def _call_reformulate():
    return await projects_pdm.reformulate_text(
        ProjectReformulateRequest(text="x", field="title"), MagicMock(), _db(), None
    )


async def _call_suggest():
    return await projects_pdm.suggest_tags(ProjectSuggestTagsRequest(title="Support"), MagicMock(), _db(), None)


def _raise(exc):
    async def fake(*_args, **_kwargs):
        raise exc

    return fake


@pytest.fixture(autouse=True)
def _no_rate_limit(monkeypatch):
    monkeypatch.setattr(projects_pdm, "_check_ai_rate_limit", lambda _request, _user: None)


ROUTES = [
    ("reformulate_project_text", _call_reformulate, "Project reformulate failed upstream: %s"),
    ("suggest_project_tag_names", _call_suggest, "Project tag suggestion failed upstream: %s"),
]


@pytest.mark.asyncio
@pytest.mark.parametrize(("service", "call", "message"), ROUTES)
async def test_upstream_error_is_502_chained_and_logged(monkeypatch, caplog, service, call, message):
    upstream = OpenRouterUpstreamError("upstream exploded")
    monkeypatch.setattr(projects_pdm, service, _raise(upstream))
    with caplog.at_level(logging.DEBUG, logger=LOGGER), pytest.raises(HTTPException) as info:
        await call()
    assert info.value.status_code == 502
    assert info.value.detail == "upstream exploded"
    assert info.value.__cause__ is upstream
    assert info.value.__suppress_context__ is True
    records = [r for r in caplog.records if r.name == LOGGER]
    assert len(records) == 1
    assert records[0].levelno == logging.WARNING
    assert records[0].msg == message
    assert records[0].args == (upstream,)
    assert records[0].getMessage() == message % "upstream exploded"


@pytest.mark.asyncio
@pytest.mark.parametrize(("service", "call", "_message"), ROUTES)
async def test_not_configured_is_409_without_cause_and_silent(monkeypatch, caplog, service, call, _message):
    monkeypatch.setattr(projects_pdm, service, _raise(OpenRouterNotConfiguredError()))
    with caplog.at_level(logging.DEBUG, logger=LOGGER), pytest.raises(HTTPException) as info:
        await call()
    assert info.value.status_code == 409
    assert info.value.detail == "OpenRouter is not configured"
    assert info.value.__cause__ is None
    assert info.value.__suppress_context__ is True
    assert [r for r in caplog.records if r.name == LOGGER] == []


@pytest.mark.asyncio
@pytest.mark.parametrize(("service", "call", "_message"), ROUTES)
async def test_other_errors_pass_through_untouched(monkeypatch, service, call, _message):
    boom = RuntimeError("boom")
    monkeypatch.setattr(projects_pdm, service, _raise(boom))
    with pytest.raises(RuntimeError) as info:
        await call()
    assert info.value is boom
