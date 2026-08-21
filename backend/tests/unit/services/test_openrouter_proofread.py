"""backend.app.services.openrouter.proofread_text.

Patches ``backend.app.services.openrouter.httpx.AsyncClient`` (the same idiom as
test_oidc_icon_service.py) and the settings lookup the service imports lazily,
so nothing here touches the network or the DB.
"""

from unittest.mock import patch

import httpx
import pytest

from backend.app.services.openrouter import (
    PROOFREAD_MODEL,
    OpenRouterNotConfiguredError,
    OpenRouterUpstreamError,
    proofread_text,
)


def build_client(*, status_code=200, payload=None, raises=None):
    """(AsyncClient replacement, list that receives each POST's json body)."""
    sent: list[dict] = []

    class FakeResponse:
        def __init__(self):
            self.status_code = status_code

        def json(self):
            return payload

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, headers=None, json=None):
            sent.append(json)
            if raises is not None:
                raise raises
            return FakeResponse()

    return FakeClient, sent


def chat_payload(content: str) -> dict:
    return {"choices": [{"message": {"content": content}}]}


@pytest.fixture
def configured():
    """Settings with an OpenRouter key, and an `openrouter_model` that must be
    IGNORED — proofreading pins its own model."""

    async def get_setting(db, key):
        return {"openrouter_api_key": "sk-test", "openrouter_model": "some/other-model"}.get(key)

    with patch("backend.app.api.routes.settings.get_setting", get_setting):
        yield


@pytest.mark.asyncio
async def test_corrects_text_with_the_pinned_model(configured):
    client, sent = build_client(payload=chat_payload("Capot avec 3 pièces"))
    with patch("backend.app.services.openrouter.httpx.AsyncClient", client):
        corrected, model = await proofread_text(None, "capot avec 3 pieces")
    assert corrected == "Capot avec 3 pièces"
    assert model == PROOFREAD_MODEL
    assert sent[0]["model"] == PROOFREAD_MODEL
    assert sent[0]["messages"][1]["content"] == "capot avec 3 pieces"


@pytest.mark.asyncio
async def test_strips_quotes_the_model_wrapped_the_answer_in(configured):
    client, _ = build_client(payload=chat_payload('"Capot avant"'))
    with patch("backend.app.services.openrouter.httpx.AsyncClient", client):
        corrected, _ = await proofread_text(None, "capot avant")
    assert corrected == "Capot avant"


@pytest.mark.asyncio
async def test_keeps_quotes_the_user_wrote_themselves(configured):
    client, _ = build_client(payload=chat_payload('"Capot avant"'))
    with patch("backend.app.services.openrouter.httpx.AsyncClient", client):
        corrected, _ = await proofread_text(None, '"capot avant"')
    assert corrected == '"Capot avant"'


@pytest.mark.asyncio
async def test_no_api_key_is_not_configured():
    async def get_setting(db, key):
        return ""

    with patch("backend.app.api.routes.settings.get_setting", get_setting), pytest.raises(OpenRouterNotConfiguredError):
        await proofread_text(None, "capot")


@pytest.mark.asyncio
async def test_non_200_is_an_upstream_error(configured):
    client, _ = build_client(status_code=429, payload={})
    with patch("backend.app.services.openrouter.httpx.AsyncClient", client), pytest.raises(OpenRouterUpstreamError):
        await proofread_text(None, "capot")


@pytest.mark.asyncio
async def test_transport_failure_is_an_upstream_error(configured):
    client, _ = build_client(raises=httpx.ConnectError("no route"))
    with patch("backend.app.services.openrouter.httpx.AsyncClient", client), pytest.raises(OpenRouterUpstreamError):
        await proofread_text(None, "capot")


@pytest.mark.asyncio
async def test_empty_answer_is_an_upstream_error(configured):
    """Never return "": the field would be blanked by its own spell-check."""
    client, _ = build_client(payload=chat_payload("   "))
    with patch("backend.app.services.openrouter.httpx.AsyncClient", client), pytest.raises(OpenRouterUpstreamError):
        await proofread_text(None, "capot")


@pytest.mark.asyncio
async def test_unexpected_payload_is_an_upstream_error(configured):
    client, _ = build_client(payload={"error": "nope"})
    with patch("backend.app.services.openrouter.httpx.AsyncClient", client), pytest.raises(OpenRouterUpstreamError):
        await proofread_text(None, "capot")


@pytest.mark.asyncio
async def test_truncated_completion_is_an_upstream_error(configured):
    """finish_reason "length" means the model's answer was cut off mid-sentence.

    Returning that truncated string as a 200 would let the caller swap it into
    the field, silently deleting whatever came after the cut. It must instead
    raise, so the caller leaves the user's original text alone.
    """
    payload = {"choices": [{"message": {"content": "Capot avec 3 pi"}, "finish_reason": "length"}]}
    client, _ = build_client(payload=payload)
    with patch("backend.app.services.openrouter.httpx.AsyncClient", client), pytest.raises(OpenRouterUpstreamError):
        await proofread_text(None, "capot avec 3 pieces")


@pytest.mark.asyncio
async def test_pinned_quote_correction_still_strips_to_the_bare_word(configured):
    """Pin: a normal quoted correction still strips to the bare word, unchanged
    by the emptiness fallback below."""
    client, _ = build_client(payload=chat_payload('"Capot"'))
    with patch("backend.app.services.openrouter.httpx.AsyncClient", client):
        corrected, _ = await proofread_text(None, "capot")
    assert corrected == "Capot"


@pytest.mark.asyncio
async def test_reply_that_is_only_a_quote_pair_keeps_the_original_text(configured):
    """A reply of exactly `""` strips to "" in _unquote, which would otherwise
    blank the field (T-009). The caller must get its own text back instead."""
    client, _ = build_client(payload=chat_payload('""'))
    with patch("backend.app.services.openrouter.httpx.AsyncClient", client):
        corrected, _ = await proofread_text(None, "capot")
    assert corrected == "capot"


@pytest.mark.asyncio
async def test_reply_that_is_a_guillemet_pair_with_only_whitespace_inside_keeps_the_original(configured):
    """Same failure mode, other quote style, whitespace instead of nothing
    between the pair — `.strip()` still empties it."""
    client, _ = build_client(payload=chat_payload("«  »"))
    with patch("backend.app.services.openrouter.httpx.AsyncClient", client):
        corrected, _ = await proofread_text(None, "capot")
    assert corrected == "capot"


@pytest.mark.asyncio
async def test_reply_that_is_a_curly_quote_pair_with_nothing_inside_keeps_the_original(configured):
    """A third quote style from the pair list, same degenerate shape."""
    client, _ = build_client(payload=chat_payload("“”"))
    with patch("backend.app.services.openrouter.httpx.AsyncClient", client):
        corrected, _ = await proofread_text(None, "capot")
    assert corrected == "capot"


@pytest.mark.asyncio
async def test_max_tokens_is_sized_conservatively_for_a_long_source(configured):
    """A 2000-char French source tokenises well under 2 chars/token, so a budget
    of len(source)//2 caps the answer before it can finish a dense sentence.
    max_tokens must instead scale from a conservative (smaller) chars-per-token
    ratio, leaving real headroom above the character count.
    """
    source = "é" * 2000
    client, sent = build_client(payload=chat_payload("é" * 2000))
    with patch("backend.app.services.openrouter.httpx.AsyncClient", client):
        await proofread_text(None, source)
    assert sent[0]["max_tokens"] > len(source) // 2 + 120
