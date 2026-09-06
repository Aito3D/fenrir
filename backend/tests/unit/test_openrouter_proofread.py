"""proofread_text and _unquote: the French-correction call that lands verbatim
in a field on a real customer quote. summarize_tasks has its own test file;
this one exercises the real symbol the route tests monkeypatch away.
"""

import pytest

from backend.app.services import openrouter
from backend.app.services.openrouter import (
    PROOFREAD_MAX_CHARS,
    PROOFREAD_MODEL,
    OpenRouterUpstreamError,
    _unquote,
    proofread_text,
)


class _FakeResponse:
    status_code = 200

    def __init__(self, content, finish_reason=None):
        self._content = content
        self._finish_reason = finish_reason

    def json(self):
        message = {"content": self._content}
        choice = {"message": message}
        if self._finish_reason is not None:
            choice["finish_reason"] = self._finish_reason
        return {"choices": [choice]}


class _FakeClient:
    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, headers=None, json=None):
        _FakeClient.last_json = json
        return _FakeResponse(_FakeClient.reply, _FakeClient.finish_reason)


def _configure_reply(monkeypatch, reply, finish_reason=None):
    _FakeClient.reply = reply
    _FakeClient.finish_reason = finish_reason
    monkeypatch.setattr(openrouter.httpx, "AsyncClient", _FakeClient)


async def _configure_key(db_session):
    from backend.app.api.routes.settings import set_setting

    await set_setting(db_session, "openrouter_api_key", "sk-or-test")
    await db_session.commit()


@pytest.mark.asyncio
async def test_proofread_plain_correction(db_session, monkeypatch):
    await _configure_key(db_session)
    _configure_reply(monkeypatch, "Capot corrigé")
    corrected, model = await proofread_text(db_session, "capot corige")
    assert corrected == "Capot corrigé"
    assert model == PROOFREAD_MODEL
    assert _FakeClient.last_json["model"] == PROOFREAD_MODEL
    assert _FakeClient.last_json["messages"][1]["content"] == "capot corige"


@pytest.mark.asyncio
async def test_proofread_pins_max_tokens_from_source_length(db_session, monkeypatch):
    """max_tokens = int(len(source)/1.5) + 120 — pin the sizing math."""
    await _configure_key(db_session)
    _configure_reply(monkeypatch, "ok")
    source = "a" * 300
    await proofread_text(db_session, source)
    assert _FakeClient.last_json["max_tokens"] == 320
    assert _FakeClient.last_json["messages"][1]["content"] == source


@pytest.mark.parametrize(
    "wrapped",
    ['"Capot"', "«Capot»", "“Capot”", "'Capot'"],
)
@pytest.mark.asyncio
async def test_proofread_unwraps_a_quoted_reply_when_original_was_bare(db_session, monkeypatch, wrapped):
    await _configure_key(db_session)
    _configure_reply(monkeypatch, wrapped)
    corrected, _ = await proofread_text(db_session, "Capot")
    assert corrected == "Capot"


@pytest.mark.asyncio
async def test_proofread_leaves_reply_alone_when_original_was_already_quoted(db_session, monkeypatch):
    await _configure_key(db_session)
    _configure_reply(monkeypatch, '"Capot"')
    corrected, _ = await proofread_text(db_session, '"Capot"')
    assert corrected == '"Capot"'


@pytest.mark.asyncio
async def test_proofread_strips_only_one_layer_of_quotes(db_session, monkeypatch):
    await _configure_key(db_session)
    _configure_reply(monkeypatch, '""Capot""')
    corrected, _ = await proofread_text(db_session, "Capot")
    assert corrected == '"Capot"'


@pytest.mark.asyncio
async def test_proofread_falls_back_to_source_when_reply_is_only_a_quote_pair(db_session, monkeypatch):
    await _configure_key(db_session)
    _configure_reply(monkeypatch, '""')
    corrected, model = await proofread_text(db_session, "Capot")
    assert corrected == "Capot"
    assert model == PROOFREAD_MODEL


@pytest.mark.asyncio
async def test_proofread_raises_on_truncation(db_session, monkeypatch):
    await _configure_key(db_session)
    _configure_reply(monkeypatch, "Capot corr", finish_reason="length")
    with pytest.raises(OpenRouterUpstreamError, match="truncated"):
        await proofread_text(db_session, "capot corige")


@pytest.mark.asyncio
async def test_proofread_caps_input_at_max_chars_and_strips_whitespace(db_session, monkeypatch):
    await _configure_key(db_session)
    _configure_reply(monkeypatch, "ok")
    padded = "  " + ("c" * (PROOFREAD_MAX_CHARS + 50)) + "  "
    await proofread_text(db_session, padded)
    sent = _FakeClient.last_json["messages"][1]["content"]
    assert len(sent) == PROOFREAD_MAX_CHARS
    assert sent == "c" * PROOFREAD_MAX_CHARS


def test_unquote_strips_a_matching_pair_when_original_was_bare():
    assert _unquote('"Capot"', "Capot") == "Capot"
    assert _unquote("«Capot»", "Capot") == "Capot"


def test_unquote_leaves_reply_alone_when_original_had_the_same_pair():
    assert _unquote('"Capot"', '"Capot"') == '"Capot"'


def test_unquote_leaves_unmatched_or_too_short_replies_alone():
    assert _unquote("Capot", "Capot") == "Capot"
    assert _unquote('"', "Capot") == '"'
    assert _unquote('"Capot', "Capot") == '"Capot'
