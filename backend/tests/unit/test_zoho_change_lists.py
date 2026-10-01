"""Zoho client additions for the sync rework: the call meter, the daily-budget
header, the richer 429, and the three modified-since listings."""

import time

import httpx
import pytest

from backend.app.services.zoho import ModifiedSinceRows, ZohoRateLimited, zoho_service
from backend.tests.unit.test_aito_quote_sync import (  # noqa: F401 — fixtures register by name
    _configure_zoho,
    reset_zoho_service,
)

SINCE = "2026-10-01T00:00:00+0000"


def _handler(pages: dict[str, list[dict]], seen: list, headers: dict | None = None):
    """pages maps a path suffix ("/estimates") to that listing's pages; each
    page is the JSON body Books would return."""

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        seen.append((request.url.path, dict(request.url.params)))
        for suffix, bodies in pages.items():
            if request.url.path.endswith(suffix):
                page = int(request.url.params.get("page", "1"))
                return httpx.Response(200, json=bodies[page - 1], headers=headers or {})
        return httpx.Response(404, json={"message": "no route"})

    return handler


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "suffix", "key", "id_field"),
    [
        ("list_estimates_modified_since", "/estimates", "estimates", "estimate_id"),
        ("list_customer_payments_modified_since", "/customerpayments", "customerpayments", "payment_id"),
        ("list_retainers_modified_since", "/retainerinvoices", "retainerinvoices", "retainerinvoice_id"),
    ],
)
async def test_modified_since_listing_maps_rows_and_sends_the_filter(db_session, method, suffix, key, id_field):
    await _configure_zoho(db_session)
    seen: list = []
    body = {
        key: [{id_field: "X1", "customer_id": "C1", "last_modified_time": "2026-10-01T01:00:00-1000", "total": 5}],
        "page_context": {"has_more_page": False},
    }
    zoho_service.transport = httpx.MockTransport(_handler({suffix: [body]}, seen))

    rows = await getattr(zoho_service, method)(db_session, SINCE)

    assert list(rows) == [{"id": "X1", "customer_id": "C1", "last_modified_time": "2026-10-01T01:00:00-1000"}]
    assert isinstance(rows, ModifiedSinceRows) and rows.truncated is False
    path, params = seen[0]
    assert path.endswith(suffix)
    assert params["last_modified_time"] == SINCE
    assert params["sort_column"] == "last_modified_time"
    assert params["sort_order"] == "A"
    assert params["per_page"] == "200"


@pytest.mark.asyncio
async def test_modified_since_listing_walks_pages_and_flags_a_capped_pass(db_session, monkeypatch):
    from backend.app.services import zoho as zoho_mod

    monkeypatch.setattr(zoho_mod, "_MAX_CHANGE_PAGES", 2)
    await _configure_zoho(db_session)
    seen: list = []
    page = lambda n: {  # noqa: E731
        "estimates": [{"estimate_id": f"E{n}", "customer_id": "C1", "last_modified_time": "2026-10-01T01:00:00-1000"}],
        "page_context": {"has_more_page": True},
    }
    zoho_service.transport = httpx.MockTransport(_handler({"/estimates": [page(1), page(2), page(3)]}, seen))

    rows = await zoho_service.list_estimates_modified_since(db_session, SINCE)

    assert [r["id"] for r in rows] == ["E1", "E2"]
    assert rows.truncated is True
    assert len(seen) == 2


@pytest.mark.asyncio
async def test_the_call_meter_counts_books_calls_and_forgets_old_ones(db_session):
    await _configure_zoho(db_session)
    body = {"estimates": [], "page_context": {"has_more_page": False}}
    zoho_service.transport = httpx.MockTransport(_handler({"/estimates": [body]}, []))
    zoho_service.reset_call_meter()

    await zoho_service.list_estimates_modified_since(db_session, SINCE)
    await zoho_service.list_estimates_modified_since(db_session, SINCE)

    assert zoho_service.calls_in_last_minute() == 2
    assert zoho_service.calls_total == 2
    # A call older than a minute leaves the window; the total keeps it.
    zoho_service._sent_at.appendleft(time.monotonic() - 61)
    assert zoho_service.calls_in_last_minute() == 2
    assert zoho_service.calls_total == 2


@pytest.mark.asyncio
async def test_the_daily_budget_header_is_remembered(db_session):
    await _configure_zoho(db_session)
    body = {"estimates": [], "page_context": {"has_more_page": False}}
    zoho_service.transport = httpx.MockTransport(
        _handler({"/estimates": [body]}, [], headers={"x-rate-limit-remaining": "48577"})
    )
    zoho_service.reset_call_meter()
    assert zoho_service.daily_remaining is None

    await zoho_service.list_estimates_modified_since(db_session, SINCE)

    assert zoho_service.daily_remaining == 48577


@pytest.mark.asyncio
async def test_a_garbled_daily_budget_header_leaves_the_last_value(db_session):
    await _configure_zoho(db_session)
    body = {"estimates": [], "page_context": {"has_more_page": False}}
    zoho_service.transport = httpx.MockTransport(
        _handler({"/estimates": [body]}, [], headers={"x-rate-limit-remaining": "soon"})
    )
    zoho_service.reset_call_meter()
    zoho_service.daily_remaining = 123

    await zoho_service.list_estimates_modified_since(db_session, SINCE)

    assert zoho_service.daily_remaining == 123


@pytest.mark.asyncio
async def test_a_429_carries_books_error_code_and_the_raw_retry_after(db_session):
    await _configure_zoho(db_session)

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        return httpx.Response(429, json={"code": 44, "message": "too many"}, headers={"Retry-After": "900"})

    zoho_service.transport = httpx.MockTransport(handler)

    with pytest.raises(ZohoRateLimited) as caught:
        await zoho_service.list_estimates_modified_since(db_session, SINCE)

    assert caught.value.code == 44
    assert caught.value.retry_after == 900.0
    assert caught.value.retry_after_raw == "900"
