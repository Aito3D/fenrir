"""Unit tests pinning ``_fetch_oidc_discovery``'s exception contract (T-104).

T-104 routed the streamed, byte-capped fetch loop through the shared
``_bounded_fetch`` helper (previously duplicated inline). The integration
suites (``test_mfa_api.py`` / ``test_oidc_relogin.py``) already exercise the
resulting HTTP-level behaviour (502s), but they go through the endpoint's
broad ``except Exception`` handler, so none of them pin the *specific*
exception type ``_fetch_oidc_discovery`` raises. These tests call the helper
directly to pin that: ``httpx.HTTPStatusError`` on a non-2xx response,
``ValueError`` on an oversized or non-dict body, and ``asyncio.TimeoutError``
past the overall deadline.
"""

from __future__ import annotations

import asyncio
import json
from unittest.mock import patch

import httpx
import pytest

from backend.app.api.routes import mfa as mfa_module

_ISSUER = "https://idp.example.com"


class _StreamCtx:
    def __init__(self, resp):
        self._resp = resp

    async def __aenter__(self):
        return self._resp

    async def __aexit__(self, *args):
        return False


def _client_with_stream(stream_fn):
    class _Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        def stream(self, method, url, **kwargs):
            return stream_fn(method, url, **kwargs)

    return _Client


@pytest.mark.asyncio
async def test_raises_http_status_error_on_non_2xx():
    """A non-2xx discovery response must raise ``httpx.HTTPStatusError``
    specifically (not a generic ``Exception``) — callers catch broadly, but
    the type itself is part of the contract this refactor must preserve."""

    def _stream(method, url, **kwargs):
        resp = httpx.Response(500, request=httpx.Request(method, url), json={})
        return _StreamCtx(resp)

    with (
        patch("backend.app.api.routes.mfa.httpx.AsyncClient", _client_with_stream(_stream)),
        pytest.raises(httpx.HTTPStatusError),
    ):
        await mfa_module._fetch_oidc_discovery(_ISSUER)


@pytest.mark.asyncio
async def test_raises_value_error_on_oversized_body(monkeypatch):
    """An oversized discovery body must raise ``ValueError`` before
    ``json.loads`` ever sees the full body, with the original discovery-specific
    message text (not the generic ``_bounded_fetch`` "<method> <url> response
    too large" text used by the token/JWKS callers)."""
    monkeypatch.setattr(mfa_module, "_OIDC_DISCOVERY_MAX_BYTES", 256)

    oversized_body = json.dumps({"issuer": "x", "padding": "a" * 1024}).encode()
    assert len(oversized_body) > 256

    class _Resp:
        status_code = 200

        def raise_for_status(self):
            pass

        async def aiter_bytes(self):
            chunk_size = 64
            for i in range(0, len(oversized_body), chunk_size):
                yield oversized_body[i : i + chunk_size]

    def _stream(method, url, **kwargs):
        return _StreamCtx(_Resp())

    with (
        patch("backend.app.api.routes.mfa.httpx.AsyncClient", _client_with_stream(_stream)),
        pytest.raises(ValueError, match="OIDC discovery document too large"),
    ):
        await mfa_module._fetch_oidc_discovery(_ISSUER)


@pytest.mark.asyncio
@pytest.mark.parametrize("raw_body", ["null", "[1, 2]"], ids=["null-body", "list-body"])
async def test_raises_value_error_on_non_dict_body(raw_body):
    """A syntactically valid JSON body that isn't an object must raise
    ``ValueError`` with the discovery-specific message."""

    class _Resp:
        status_code = 200

        def raise_for_status(self):
            pass

        async def aiter_bytes(self):
            yield raw_body.encode()

    def _stream(method, url, **kwargs):
        return _StreamCtx(_Resp())

    with (
        patch("backend.app.api.routes.mfa.httpx.AsyncClient", _client_with_stream(_stream)),
        pytest.raises(ValueError, match="OIDC discovery document is not a JSON object"),
    ):
        await mfa_module._fetch_oidc_discovery(_ISSUER)


@pytest.mark.asyncio
async def test_raises_timeout_error_past_overall_deadline(monkeypatch):
    """A response that trickles past the overall deadline must raise
    ``asyncio.TimeoutError`` — the overall ``asyncio.wait_for`` cutoff must
    still apply now that the loop lives in ``_bounded_fetch``."""
    monkeypatch.setattr(mfa_module, "_OIDC_DISCOVERY_TIMEOUT_S", 0.2)

    class _HangingStreamCtx:
        async def __aenter__(self):
            await asyncio.sleep(1.0)
            raise AssertionError("unreachable: the overall deadline must cancel this first")

        async def __aexit__(self, *args):
            return False

    def _stream(method, url, **kwargs):
        return _HangingStreamCtx()

    with (
        patch("backend.app.api.routes.mfa.httpx.AsyncClient", _client_with_stream(_stream)),
        pytest.raises(asyncio.TimeoutError),
    ):
        await mfa_module._fetch_oidc_discovery(_ISSUER)
