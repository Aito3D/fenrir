"""ZohoService under a hostile wire: network exceptions, rate limits, token
trouble, non-JSON and wrong-shape bodies, and the shipping-catalogue cache's
defensive branches.

Everything runs through the singleton's ``transport`` seam
(``httpx.MockTransport``) — no ``unittest.mock`` on httpx, and no class-level
monkeypatching (see the instance-shadow warning in test_aito_quote_email.py).
These tests PIN current behaviour; where the behaviour is arguably a product
bug (a 429 spending the sync retry budget, for instance) the test says so in
its docstring rather than silently encoding an opinion.
"""

import json

import httpx
import pytest

from backend.app.api.routes.settings import set_setting
from backend.app.services.zoho import (
    ZohoNotFound,
    ZohoRequestRejected,
    ZohoUpstreamError,
    zoho_service,
)


@pytest.fixture(autouse=True)
def reset_service():
    """Mirror of the reset fixture in test_zoho_service.py: the token cache and
    transport live on the module singleton and would otherwise leak across
    whatever unrelated test the same xdist worker runs next."""
    zoho_service.invalidate_token()
    zoho_service.transport = None
    yield
    zoho_service.invalidate_token()
    zoho_service.transport = None


async def _configure(db) -> None:
    for key, value in {
        "zoho_client_id": "1000.FAKE",
        "zoho_client_secret": "fake-secret",
        "zoho_refresh_token": "1000.fake.refresh",
        "zoho_organization_id": "999",
    }.items():
        await set_setting(db, key, value)
    await db.commit()


def _token_ok(request: httpx.Request) -> httpx.Response | None:
    if "oauth" in request.url.path:
        return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
    return None


# ---------------------------------------------------------------------------
# Network-level failures
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "exc_class",
    [httpx.ConnectError, httpx.ReadTimeout, httpx.RemoteProtocolError],
)
async def test_books_network_error_maps_to_unreachable_with_the_exception_name(db_session, exc_class):
    """Any httpx transport exception on a Books call becomes ZohoUpstreamError
    naming the exception class — the message the sync worker stores verbatim
    in quote_sync_error, so its shape is user-facing."""
    await _configure(db_session)

    def handler(request: httpx.Request) -> httpx.Response:
        if (token := _token_ok(request)) is not None:
            return token
        raise exc_class("boom")

    zoho_service.transport = httpx.MockTransport(handler)
    with pytest.raises(ZohoUpstreamError) as excinfo:
        await zoho_service.search_contacts(db_session, "dupont")
    assert str(excinfo.value) == f"Zoho Books unreachable: {exc_class.__name__}"


@pytest.mark.asyncio
async def test_token_endpoint_network_error_maps_to_accounts_unreachable(db_session):
    await _configure(db_session)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    zoho_service.transport = httpx.MockTransport(handler)
    with pytest.raises(ZohoUpstreamError) as excinfo:
        await zoho_service.search_contacts(db_session, "dupont")
    assert str(excinfo.value) == "Zoho accounts unreachable: ConnectError"


@pytest.mark.asyncio
async def test_network_error_is_not_a_rejection_or_not_found(db_session):
    """Handlers downstream key on the subclass to tell "Books said no" from
    "Books is down" — an outage must never masquerade as either."""
    await _configure(db_session)

    def handler(request: httpx.Request) -> httpx.Response:
        if (token := _token_ok(request)) is not None:
            return token
        raise httpx.ConnectError("down")

    zoho_service.transport = httpx.MockTransport(handler)
    with pytest.raises(ZohoUpstreamError) as excinfo:
        await zoho_service.get_estimate(db_session, "E1")
    assert not isinstance(excinfo.value, (ZohoRequestRejected, ZohoNotFound))


# ---------------------------------------------------------------------------
# HTTP status mapping beyond the classic 400/404/500
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_429_maps_to_generic_upstream_error_without_retry(db_session):
    """A rate limit is a plain ZohoUpstreamError — no Retry-After handling, no
    retry, and (pinned, arguably a product gap) nothing distinguishes it from
    an outage: through the sync worker it spends the same failure budget."""
    await _configure(db_session)
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if (token := _token_ok(request)) is not None:
            return token
        calls.append(request.url.path)
        return httpx.Response(429, json={"message": "Rate limited"})

    zoho_service.transport = httpx.MockTransport(handler)
    with pytest.raises(ZohoUpstreamError) as excinfo:
        await zoho_service.get_estimate(db_session, "E1")
    assert str(excinfo.value) == "Zoho Books error (HTTP 429)"
    assert not isinstance(excinfo.value, (ZohoRequestRejected, ZohoNotFound))
    assert len(calls) == 1  # a 429 is not a 401: no second attempt


@pytest.mark.asyncio
async def test_403_maps_to_generic_upstream_error(db_session):
    """An org-permission refusal (403) has no dedicated subclass; it reads as
    a generic upstream error, message included."""
    await _configure(db_session)

    def handler(request: httpx.Request) -> httpx.Response:
        if (token := _token_ok(request)) is not None:
            return token
        return httpx.Response(403, json={"message": "You are not authorized"})

    zoho_service.transport = httpx.MockTransport(handler)
    with pytest.raises(ZohoUpstreamError) as excinfo:
        await zoho_service.get_estimate(db_session, "E1")
    assert str(excinfo.value) == "Zoho Books error (HTTP 403)"


# ---------------------------------------------------------------------------
# Token lifecycle under failure
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_double_401_surfaces_as_generic_401_after_exactly_one_retry(db_session):
    """First 401 invalidates the cache and retries once with a fresh token;
    a second 401 is returned as-is and maps to the generic error — the
    "rejected the refreshed token" guard in _send is deliberately unreachable."""
    await _configure(db_session)
    books_calls: list[str] = []
    token_calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            token_calls.append(request.url.path)
            return httpx.Response(200, json={"access_token": f"t{len(token_calls)}", "expires_in": 3600})
        books_calls.append(request.headers["Authorization"])
        return httpx.Response(401, json={"message": "Invalid token"})

    zoho_service.transport = httpx.MockTransport(handler)
    with pytest.raises(ZohoUpstreamError) as excinfo:
        await zoho_service.get_estimate(db_session, "E1")
    assert str(excinfo.value) == "Zoho Books error (HTTP 401)"
    assert len(books_calls) == 2
    assert len(token_calls) == 2  # the retry really did fetch a fresh token
    assert books_calls[0] != books_calls[1]  # and really did send it


@pytest.mark.asyncio
async def test_token_refresh_500_mid_business_call_propagates_the_token_error(db_session):
    """An expired cache whose refresh then 500s: the business call surfaces
    the token failure, not a misleading Books error."""
    await _configure(db_session)

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(500, json={"error": "server_error"})
        raise AssertionError("Books must never be called without a token")

    zoho_service.transport = httpx.MockTransport(handler)
    with pytest.raises(ZohoUpstreamError) as excinfo:
        await zoho_service.search_estimates(db_session, "")
    assert str(excinfo.value) == "server_error"


@pytest.mark.asyncio
async def test_token_200_without_access_token_fails_the_refresh(db_session):
    await _configure(db_session)

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"scope": "books"})
        raise AssertionError("Books must never be called without a token")

    zoho_service.transport = httpx.MockTransport(handler)
    with pytest.raises(ZohoUpstreamError) as excinfo:
        await zoho_service.search_estimates(db_session, "")
    assert str(excinfo.value) == "Token refresh failed (HTTP 200)"


# ---------------------------------------------------------------------------
# Non-JSON and wrong-shape 200 bodies on the estimate endpoints
# ---------------------------------------------------------------------------


def _html_handler(request: httpx.Request) -> httpx.Response:
    if (token := _token_ok(request)) is not None:
        return token
    return httpx.Response(200, text="<html>gateway timeout</html>")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "call",
    [
        lambda db: zoho_service.get_estimate(db, "E1"),
        lambda db: zoho_service.create_estimate(db, {"customer_id": "C1"}),
        lambda db: zoho_service.update_estimate_lines(db, "E1", []),
        lambda db: zoho_service.list_items(db, "Livraison Avion"),
        lambda db: zoho_service.list_estimate_comments(db, "E1"),
        lambda db: zoho_service.set_estimate_status(db, "E1", "sent"),
    ],
    ids=["get_estimate", "create_estimate", "update_estimate_lines", "list_items", "comments", "set_status"],
)
async def test_non_json_200_body_raises_upstream_error_on_every_estimate_endpoint(db_session, call):
    """A proxy or login page answering 200 text/html must become a clean
    ZohoUpstreamError, never a JSONDecodeError crashing the sync worker's
    generic handlers with a stack trace for a message."""
    await _configure(db_session)
    zoho_service.transport = httpx.MockTransport(_html_handler)
    with pytest.raises(ZohoUpstreamError) as excinfo:
        await call(db_session)
    assert str(excinfo.value) == "Zoho returned a non-JSON response (HTTP 200)"


@pytest.mark.asyncio
async def test_create_estimate_with_empty_body_returns_empty_dict(db_session):
    """A 200 with no ``estimate`` key degrades to {} — the caller
    (_apply_estimate) is what turns that into a retryable error; the client
    itself must not invent structure."""
    await _configure(db_session)

    def handler(request: httpx.Request) -> httpx.Response:
        if (token := _token_ok(request)) is not None:
            return token
        return httpx.Response(200, json={"code": 0, "message": "success"})

    zoho_service.transport = httpx.MockTransport(handler)
    assert await zoho_service.create_estimate(db_session, {"customer_id": "C1"}) == {}


@pytest.mark.asyncio
async def test_get_estimate_with_null_estimate_key_returns_none(db_session):
    """Pinned: ``{"estimate": null}`` passes ``.get("estimate", {})`` through
    as None. Downstream, the sync worker's catch-all turns the resulting
    AttributeError into a terminal per-project error (covered in
    test_aito_quote_e2e.py) — if this pin ever breaks, re-check that path."""
    await _configure(db_session)

    def handler(request: httpx.Request) -> httpx.Response:
        if (token := _token_ok(request)) is not None:
            return token
        return httpx.Response(200, json={"estimate": None})

    zoho_service.transport = httpx.MockTransport(handler)
    assert await zoho_service.get_estimate(db_session, "E1") is None


# ---------------------------------------------------------------------------
# Shipping-catalogue cache: the defensive branches
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_corrupt_json_in_the_cache_row_is_treated_as_no_cache(db_session):
    await set_setting(db_session, "zoho_shipping_catalogue", "{not json at all")
    await db_session.commit()
    assert await zoho_service.get_shipping_catalogue(db_session, refresh=False) == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("raw", ["null", "[]", '"tuamotu"', "42"])
async def test_valid_json_of_the_wrong_shape_is_treated_as_no_cache(db_session, raw):
    await set_setting(db_session, "zoho_shipping_catalogue", raw)
    await db_session.commit()
    assert await zoho_service.get_shipping_catalogue(db_session, refresh=False) == {}


@pytest.mark.asyncio
async def test_malformed_cache_entries_are_filtered_not_fatal(db_session):
    """An entry that is not a dict, or has a blank item_id, is skipped; the
    healthy entries still resolve."""
    await set_setting(
        db_session,
        "zoho_shipping_catalogue",
        json.dumps(
            {
                "societe": {"item_id": ""},
                "tuamotu": "bogus-not-a-dict",
                "marquises": {"item_id": "M1", "rate": 2500},
            }
        ),
    )
    await db_session.commit()
    catalogue = await zoho_service.get_shipping_catalogue(db_session, refresh=False)
    assert set(catalogue) == {"marquises"}
    assert catalogue["marquises"].item_id == "M1"
    assert catalogue["marquises"].rate == 2500


@pytest.mark.asyncio
async def test_tz_aware_checked_at_reads_as_stale_and_triggers_a_refresh(db_session):
    """A legacy/hand-edited timestamp WITH an offset makes the naive-now
    subtraction raise TypeError; the branch must swallow it and refresh as if
    the cache were stale, not crash the drawer."""
    await _configure(db_session)
    await set_setting(db_session, "zoho_shipping_catalogue", json.dumps({"tuamotu": {"item_id": "T1", "rate": 1}}))
    await set_setting(db_session, "zoho_shipping_catalogue_at", "2026-08-05T10:00:00+00:00")
    await db_session.commit()

    fetched: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if (token := _token_ok(request)) is not None:
            return token
        fetched.append(request.url.path)
        return httpx.Response(
            200, json={"items": [{"item_id": "T1", "name": "Livraison Avion Tuamotu", "rate": 3200}]}
        )

    zoho_service.transport = httpx.MockTransport(handler)
    catalogue = await zoho_service.get_shipping_catalogue(db_session, refresh=True)
    assert fetched, "a tz-aware checked_at must be treated as stale, so /items must be fetched"
    assert catalogue["tuamotu"].rate == 3200


@pytest.mark.asyncio
async def test_failed_refresh_serves_the_stale_cache_unchanged(db_session):
    """Books down mid-refresh: the previous cache is returned, nothing raises,
    and the stale rate still bills — the documented trade."""
    await _configure(db_session)
    await set_setting(db_session, "zoho_shipping_catalogue", json.dumps({"tuamotu": {"item_id": "T1", "rate": 1500}}))
    await set_setting(db_session, "zoho_shipping_catalogue_at", "2020-01-01T00:00:00")
    await db_session.commit()

    def handler(request: httpx.Request) -> httpx.Response:
        if (token := _token_ok(request)) is not None:
            return token
        raise httpx.ConnectError("books is down")

    zoho_service.transport = httpx.MockTransport(handler)
    catalogue = await zoho_service.get_shipping_catalogue(db_session, refresh=True)
    assert catalogue["tuamotu"].item_id == "T1"
    assert catalogue["tuamotu"].rate == 1500
