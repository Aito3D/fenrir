"""The client quote rating: a customer's Books estimate history folded into
how readily they accept a quote. Spec:
docs/superpowers/specs/2026-10-21-aito-quote-rating-design.md

The scorer is pure (rows + today in, dataclass out), so every rule is a
table row here with no Zoho, no clock and no database.
"""

from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.exc import OperationalError

import backend.app.services.aito_quote_rating as aito_quote_rating_module
from backend.app.models.aito_client_rating import AitoClientQuoteRating
from backend.app.schemas.aito import AitoClientQuoteRatingResponse
from backend.app.services.aito_quote_rating import (
    CACHE_TTL,
    REFRESH_MIN_AGE,
    rate_quotes,
    read_client_quote_rating,
)
from backend.app.services.zoho import ZohoRateLimited, ZohoUpstreamError, zoho_service

TODAY = date(2026, 10, 21)
NOW = datetime(2026, 10, 21, 12, 0, 0)


@pytest.fixture(autouse=True)
def _reset_route_buckets():
    from backend.app.api.routes import aito as aito_routes

    aito_routes._ai_rate_limit_calls.clear()
    yield
    aito_routes._ai_rate_limit_calls.clear()


def _est(status: str, *, issued: date = date(2026, 6, 1), number: str = "DEV-1") -> dict:
    return {"id": number, "number": number, "date": issued.isoformat(), "total": 1000.0, "status": status}


def _history(accepted: int = 0, declined: int = 0, expired: int = 0, pending: int = 0) -> list[dict]:
    return (
        [_est("accepted", number=f"A{i}") for i in range(accepted)]
        + [_est("declined", number=f"D{i}") for i in range(declined)]
        + [_est("expired", number=f"E{i}") for i in range(expired)]
        + [_est("sent", number=f"P{i}") for i in range(pending)]
    )


# ------------------------------------------------------------------ scorer


def test_no_history_is_new():
    r = rate_quotes([], TODAY)
    assert (r.tier, r.accepted_count, r.declined_count, r.score) == ("new", 0, 0, None)


def test_only_pending_quotes_is_new_but_counts_them():
    r = rate_quotes(_history(pending=3), TODAY)
    assert (r.tier, r.pending_count, r.score) == ("new", 3, None)


@pytest.mark.parametrize(
    ("accepted", "declined", "tier"),
    [
        # The user's own examples: two declines out of two is NOT as bad as
        # eighteen out of twenty — a thin record stays near the middle.
        (0, 2, "medium"),
        (2, 18, "bad"),
        (0, 1, "medium"),
        (1, 0, "medium"),
        (0, 4, "bad"),
        (1, 5, "bad"),
        (2, 0, "good"),
        (3, 0, "good"),
        (10, 0, "good"),
        (6, 4, "medium"),
        (7, 3, "good"),
        (3, 7, "medium"),
        (2, 8, "bad"),
    ],
)
def test_tier_table(accepted, declined, tier):
    assert rate_quotes(_history(accepted=accepted, declined=declined), TODAY).tier == tier


def test_two_declines_score_above_eighteen_of_twenty():
    thin = rate_quotes(_history(declined=2), TODAY).score
    heavy = rate_quotes(_history(accepted=2, declined=18), TODAY).score
    assert thin is not None and heavy is not None
    assert thin > heavy


def test_score_is_the_smoothed_acceptance_rate():
    # (accepted + 3) / (decided + 6)
    r = rate_quotes(_history(accepted=2, declined=18), TODAY)
    assert r.score == pytest.approx(5 / 26)


def test_invoiced_counts_as_accepted_and_expired_as_a_no():
    rows = [_est("invoiced"), _est("partially_invoiced"), _est("expired"), _est("declined")]
    r = rate_quotes(rows, TODAY)
    assert (r.accepted_count, r.declined_count, r.expired_count) == (2, 1, 1)
    assert r.score == pytest.approx((2 + 3) / (4 + 6))


def test_draft_void_sent_and_viewed_are_pending_or_ignored():
    rows = [_est("draft"), _est("void"), _est("sent"), _est("viewed"), _est("accepted")]
    r = rate_quotes(rows, TODAY)
    assert (r.accepted_count, r.declined_count, r.expired_count, r.pending_count) == (1, 0, 0, 2)


def test_status_is_case_insensitive():
    assert rate_quotes([_est("Accepted"), _est("DECLINED")], TODAY).accepted_count == 1


def test_quotes_older_than_the_window_fade():
    old = date(2024, 10, 20)
    rows = [_est("declined", issued=old, number=f"D{i}") for i in range(10)] + [_est("accepted")]
    r = rate_quotes(rows, TODAY)
    assert (r.accepted_count, r.declined_count, r.tier) == (1, 0, "medium")


def test_window_boundary_is_inclusive():
    on_edge = _est("declined", issued=date(2024, 10, 21))
    r = rate_quotes([on_edge], TODAY)
    assert r.declined_count == 1


def test_unparseable_dates_still_count():
    rows = [{"status": "declined", "date": "garbage"}, {"status": "accepted", "date": None}]
    r = rate_quotes(rows, TODAY)
    assert (r.accepted_count, r.declined_count) == (1, 1)


# ------------------------------------------------------------------ reader


def _fake_books(monkeypatch, rows: list[dict] | Exception, calls: list[str] | None = None):
    async def fake_list(db, customer_id):
        if calls is not None:
            calls.append(customer_id)
        if isinstance(rows, Exception):
            raise rows
        return list(rows)

    monkeypatch.setattr(zoho_service, "list_customer_estimates", fake_list)


@pytest.mark.asyncio
async def test_cache_miss_reads_books_scores_and_writes_the_row(db_session, monkeypatch):
    calls: list[str] = []
    _fake_books(monkeypatch, _history(accepted=2, declined=18), calls)

    body = await read_client_quote_rating(db_session, "C1", now=NOW)

    assert (body.tier, body.accepted_count, body.declined_count, body.stale) == ("bad", 2, 18, False)
    assert body.computed_at == NOW
    assert calls == ["C1"]
    row = (await db_session.execute(select(AitoClientQuoteRating))).scalar_one()
    assert (row.customer_id, row.tier, row.computed_at) == ("C1", "bad", NOW)


@pytest.mark.asyncio
async def test_cache_hit_inside_the_ttl_skips_books(db_session, monkeypatch):
    calls: list[str] = []
    _fake_books(monkeypatch, _history(accepted=3), calls)
    await read_client_quote_rating(db_session, "C1", now=NOW)

    body = await read_client_quote_rating(db_session, "C1", now=NOW + CACHE_TTL - timedelta(seconds=1))

    assert (body.tier, body.computed_at) == ("good", NOW)
    assert calls == ["C1"]


@pytest.mark.asyncio
async def test_ttl_expiry_recomputes_and_refresh_is_throttled(db_session, monkeypatch):
    calls: list[str] = []
    _fake_books(monkeypatch, _history(accepted=3), calls)
    await read_client_quote_rating(db_session, "C1", now=NOW)
    await read_client_quote_rating(db_session, "C1", refresh=True, now=NOW + REFRESH_MIN_AGE / 2)
    assert calls == ["C1"]
    await read_client_quote_rating(db_session, "C1", refresh=True, now=NOW + REFRESH_MIN_AGE)
    assert calls == ["C1", "C1"]
    await read_client_quote_rating(db_session, "C1", now=NOW + REFRESH_MIN_AGE + CACHE_TTL)
    assert calls == ["C1", "C1", "C1"]


@pytest.mark.asyncio
async def test_books_failure_with_a_cached_row_returns_it_stale(db_session, monkeypatch):
    _fake_books(monkeypatch, _history(declined=4))
    await read_client_quote_rating(db_session, "C1", now=NOW)
    _fake_books(monkeypatch, ZohoUpstreamError("down"))

    body = await read_client_quote_rating(db_session, "C1", now=NOW + CACHE_TTL)

    assert (body.tier, body.stale, body.computed_at) == ("bad", True, NOW)


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [ZohoUpstreamError("down"), ZohoRateLimited("slow down")])
async def test_books_failure_without_a_cached_row_is_unavailable(db_session, monkeypatch, error):
    _fake_books(monkeypatch, error)
    body = await read_client_quote_rating(db_session, "C1", now=NOW)
    assert body.tier == "unavailable"


@pytest.mark.asyncio
async def test_no_estimates_answers_new_and_writes_nothing(db_session, monkeypatch):
    """An id Books does not know answers an empty list too, so an empty
    history is never persisted: a caller-named id must not leave rows."""
    _fake_books(monkeypatch, [])
    body = await read_client_quote_rating(db_session, "C1", now=NOW)
    assert body.tier == "new"
    assert (await db_session.execute(select(AitoClientQuoteRating))).first() is None


@pytest.mark.asyncio
async def test_default_contact_and_empty_id_are_new_and_never_read_books(db_session, monkeypatch):
    calls: list[str] = []
    _fake_books(monkeypatch, _history(declined=9), calls)

    async def fake_default(db):
        return "WALKIN", "Client comptoir"

    monkeypatch.setattr(zoho_service, "get_default_contact", fake_default)

    assert (await read_client_quote_rating(db_session, "", now=NOW)).tier == "new"
    assert (await read_client_quote_rating(db_session, "WALKIN", now=NOW)).tier == "new"
    assert calls == []


@pytest.mark.asyncio
async def test_cache_write_failure_still_returns_the_fresh_rating(db_session, monkeypatch):
    _fake_books(monkeypatch, _history(accepted=3))

    async def boom():
        raise OperationalError("COMMIT", {}, Exception("locked"))

    monkeypatch.setattr(db_session, "commit", boom)
    body = await read_client_quote_rating(db_session, "C1", now=NOW)
    assert (body.tier, body.accepted_count, body.computed_at) == ("good", 3, NOW)


@pytest.mark.asyncio
async def test_cached_row_read_failure_returns_unavailable(db_session, monkeypatch):
    _fake_books(monkeypatch, _history(accepted=3))

    async def boom(*args, **kwargs):
        raise OperationalError("SELECT", {}, Exception("locked"))

    monkeypatch.setattr(db_session, "get", boom)
    body = await read_client_quote_rating(db_session, "C1", now=NOW)
    assert body.tier == "unavailable"


def test_response_schema_unavailable_shape():
    body = AitoClientQuoteRatingResponse(tier="unavailable", computed_at=None, stale=False)
    assert body.model_dump() == {
        "tier": "unavailable",
        "accepted_count": 0,
        "declined_count": 0,
        "expired_count": 0,
        "pending_count": 0,
        "score": None,
        "computed_at": None,
        "stale": False,
    }


# ------------------------------------------------------------------- route


@pytest.mark.asyncio
async def test_route_returns_the_rating(async_client, monkeypatch):
    calls: list[str] = []
    _fake_books(monkeypatch, _history(accepted=1, declined=1, expired=1, pending=2), calls)
    clock = {"now": datetime(2026, 10, 21, 12, 0, 0, tzinfo=timezone.utc)}

    class _FakeDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return clock["now"]

    monkeypatch.setattr(aito_quote_rating_module, "datetime", _FakeDateTime)

    first = await async_client.get("/api/v1/aito/clients/123456/quote-rating")
    second = await async_client.get("/api/v1/aito/clients/123456/quote-rating")

    assert first.status_code == 200, first.text
    body = first.json()
    assert (body["tier"], body["accepted_count"], body["declined_count"]) == ("medium", 1, 1)
    assert (body["expired_count"], body["pending_count"]) == (1, 2)
    assert second.json()["computed_at"] == body["computed_at"]
    assert calls == ["123456"]


@pytest.mark.asyncio
async def test_route_never_502s_when_books_is_down(async_client, monkeypatch):
    _fake_books(monkeypatch, ZohoUpstreamError("down"))
    r = await async_client.get("/api/v1/aito/clients/123456/quote-rating")
    assert r.status_code == 200
    assert r.json()["tier"] == "unavailable"


@pytest.mark.asyncio
async def test_route_refuses_a_malformed_id_before_spending_a_books_call(async_client, monkeypatch):
    calls: list[str] = []
    _fake_books(monkeypatch, [], calls)
    r = await async_client.get("/api/v1/aito/clients/not%20an%20id/quote-rating")
    assert r.status_code == 422
    assert calls == []


@pytest.mark.asyncio
async def test_route_rate_limit_blocks_past_the_budget(async_client, monkeypatch):
    from backend.app.api.routes import aito as aito_routes

    _fake_books(monkeypatch, [])
    monkeypatch.setattr(aito_routes, "_CLIENT_RATING_MAX_CALLS", 2)
    codes = [(await async_client.get(f"/api/v1/aito/clients/{i}/quote-rating")).status_code for i in range(3)]
    assert codes == [200, 200, 429]
