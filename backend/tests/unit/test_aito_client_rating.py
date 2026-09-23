"""The client rating: a customer's Books invoice history folded into one of
four tiers. Spec: docs/superpowers/specs/2026-09-22-aito-client-rating-design.md

The scorer is pure (rows + today in, dataclass out), so every tier rule and
every edge is a table row here with no Zoho, no clock and no database.
"""

from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.exc import OperationalError

import backend.app.services.aito_client_rating as aito_client_rating_module
from backend.app.models.aito_client_rating import AitoClientRating
from backend.app.schemas.aito import AitoClientRatingResponse
from backend.app.services.aito_client_rating import (
    CACHE_TTL,
    GRACE_DAYS,
    ON_TIME_SLACK_DAYS,
    ClientRating,
    rate_invoices,
    read_client_rating,
)
from backend.app.services.zoho import ZohoRateLimited, ZohoUpstreamError, zoho_service
from backend.tests.unit.test_aito_contacted import _declared_permissions

TODAY = date(2026, 9, 22)


def _inv(
    *,
    number: str = "FA-1",
    issued: date,
    due: date,
    status: str = "paid",
    paid_on: date | None = None,
    balance: float = 0.0,
) -> dict:
    return {
        "number": number,
        "date": issued.isoformat(),
        "due_date": due.isoformat(),
        "status": status,
        "balance": balance,
        "total": 1000.0,
        "last_payment_date": paid_on.isoformat() if paid_on else "",
        "last_modified_time": "",
    }


def _paid(n: int, *, late_by: int = -5, start: date = date(2026, 1, 10)) -> list[dict]:
    """``n`` settled invoices a month apart, each paid ``late_by`` days after
    its due date (negative = early)."""
    rows = []
    for i in range(n):
        issued = start + timedelta(days=30 * i)
        due = issued + timedelta(days=30)
        rows.append(_inv(number=f"FA-{i}", issued=issued, due=due, paid_on=due + timedelta(days=late_by)))
    return rows


def _open(*, past_due: int, number: str = "FA-OPEN", balance: float = 500.0) -> dict:
    due = TODAY - timedelta(days=past_due)
    return _inv(number=number, issued=due - timedelta(days=30), due=due, status="sent", balance=balance)


def test_no_history_at_all_is_new():
    assert rate_invoices([], TODAY) == ClientRating("new", "new", 0, 0, 0, 0, 0, None, False)


@pytest.mark.parametrize(
    ("rows", "tier", "reason"),
    [
        # 20 paid early + one open, inside its terms
        (_paid(20) + [_open(past_due=-20)], "good", "punctual"),
        # same, 3 days past due: inside the grace, history decides, but not good
        (_paid(20) + [_open(past_due=3)], "medium", "mixed"),
        # same, 9 days past due: overdue, but a strong record buffers it to medium
        (_paid(20) + [_open(past_due=9)], "medium", "overdue"),
        # one invoice paid on time: rated, not enough volume for good
        (_paid(1), "medium", "mixed"),
        # 5 settled, 2 on time, 3 paid 20 days late, nothing open: chronic
        (_paid(2) + _paid(3, late_by=20, start=date(2026, 6, 1)), "bad", "chronic"),
        # 5 settled, 4 on time, 1 late: 80 % < 90 %
        (_paid(4) + _paid(1, late_by=20, start=date(2026, 6, 1)), "medium", "mixed"),
        # 0 settled, 1 open 2 days past due: still new
        ([_open(past_due=2)], "new", "new"),
        # 0 settled, 1 open 30 days past due: bad
        ([_open(past_due=30)], "bad", "overdue"),
        # 3 paid, one 92 % paid and 12 days past due: a balance is a balance,
        # and 3 on time is a strong enough record to buffer it
        (_paid(3) + [_open(past_due=12, balance=80.0)], "medium", "overdue"),
        # 2 paid, same open balance: too thin a record to buffer anything
        (_paid(2) + [_open(past_due=12, balance=80.0)], "bad", "overdue"),
    ],
    ids=[
        "regular-open-inside-terms",
        "regular-open-inside-grace",
        "regular-open-past-grace",
        "single-paid",
        "chronic-late",
        "mostly-on-time",
        "new-inside-grace",
        "new-past-grace",
        "partial-past-grace",
        "partial-past-grace-thin",
    ],
)
def test_worked_examples_from_the_spec(rows, tier, reason):
    rating = rate_invoices(rows, TODAY)
    assert (rating.tier, rating.reason) == (tier, reason)


LATE = date(2026, 6, 1)


@pytest.mark.parametrize(
    ("rows", "is_company", "tier", "reason"),
    [
        # --- the override is weighted by the record (rework of 2026-09-23) ---
        # 10 paid on time + one 12 days overdue: the user's case — not bad
        (_paid(10) + [_open(past_due=12)], False, "medium", "overdue"),
        # same open invoice, but 50 days: severe, whatever the record
        (_paid(10) + [_open(past_due=50)], False, "bad", "overdue"),
        # the severe edge for an individual: 45 is buffered, 46 is not
        (_paid(10) + [_open(past_due=45)], False, "medium", "overdue"),
        (_paid(10) + [_open(past_due=46)], False, "bad", "overdue"),
        # 2 paid + 12 days overdue: too thin a record to buffer
        (_paid(2) + [_open(past_due=12)], False, "bad", "overdue"),
        # 7 on time + 3 late (70 %) + 12 days overdue: too weak a record to buffer
        (_paid(7) + _paid(3, late_by=20, start=LATE) + [_open(past_due=12)], False, "bad", "overdue"),
        # 9 on time + 1 late (90 %) + 12 days overdue: just strong enough
        (_paid(9) + _paid(1, late_by=20, start=LATE) + [_open(past_due=12)], False, "medium", "overdue"),
        # --- the company profile ---
        # 2 paid on time: enough volume for a company, not for an individual
        (_paid(2), True, "good", "punctual"),
        (_paid(2), False, "medium", "mixed"),
        # 5 paid 10 days late: process lag for a company, chronic for a person
        (_paid(5, late_by=10), True, "good", "punctual"),
        (_paid(5, late_by=10), False, "bad", "chronic"),
        # the company slack edge: 14 days is on time, 15 is late
        (_paid(5, late_by=14), True, "good", "punctual"),
        (_paid(5, late_by=15), True, "bad", "chronic"),
        # 20 paid + one 15 days past due: inside the company grace (past due,
        # not overdue) — an individual's grace ended a week ago
        (_paid(20) + [_open(past_due=15)], True, "medium", "mixed"),
        (_paid(20) + [_open(past_due=15)], False, "medium", "overdue"),
        # the company grace edge: 21 is past due, 22 is overdue
        (_paid(20) + [_open(past_due=21)], True, "medium", "mixed"),
        (_paid(20) + [_open(past_due=22)], True, "medium", "overdue"),
        # the company severe edge: 60 is buffered, 61 is not
        (_paid(10) + [_open(past_due=60)], True, "medium", "overdue"),
        (_paid(10) + [_open(past_due=61)], True, "bad", "overdue"),
        # chronic still needs 3 settled for a company: 2 late is mixed
        (_paid(2, late_by=20), True, "medium", "mixed"),
        (_paid(3, late_by=20), True, "bad", "chronic"),
        # a company with nothing settled is still new
        ([_open(past_due=2)], True, "new", "new"),
    ],
    ids=[
        "buffered-mild-overdue",
        "severe-overdue",
        "severe-edge-45-buffered",
        "severe-edge-46-bad",
        "thin-record-not-buffered",
        "weak-record-not-buffered",
        "ninety-percent-buffered",
        "company-good-at-two",
        "individual-medium-at-two",
        "company-ten-days-late-is-fine",
        "individual-ten-days-late-is-chronic",
        "company-slack-edge-14",
        "company-slack-edge-15",
        "company-grace-15-past-due",
        "individual-grace-15-overdue",
        "company-grace-edge-21",
        "company-grace-edge-22",
        "company-severe-edge-60",
        "company-severe-edge-61",
        "company-chronic-needs-three",
        "company-chronic-at-three",
        "company-nothing-settled-is-new",
    ],
)
def test_profile_and_record_weighted_examples(rows, is_company, tier, reason):
    rating = rate_invoices(rows, TODAY, is_company=is_company)
    assert (rating.tier, rating.reason, rating.is_company) == (tier, reason, is_company)


def test_buffered_overdue_still_reports_the_worst_invoice():
    rating = rate_invoices(_paid(10) + [_open(past_due=12, number="FA-LATE")], TODAY)
    assert (rating.tier, rating.overdue_count, rating.worst_overdue_days, rating.worst_overdue_number) == (
        "medium",
        1,
        12,
        "FA-LATE",
    )


def test_overdue_reason_carries_the_worst_invoice():
    rows = _paid(3) + [_open(past_due=10, number="FA-A"), _open(past_due=23, number="FA-B")]
    rating = rate_invoices(rows, TODAY)
    # Three on time buffer two mild overdues to medium; the reason stays.
    assert (rating.tier, rating.reason) == ("medium", "overdue")
    assert rating.overdue_count == 2
    assert (rating.worst_overdue_days, rating.worst_overdue_number) == (23, "FA-B")


def test_grace_edge_seven_days_is_inside_eight_is_out():
    inside = rate_invoices(_paid(3) + [_open(past_due=GRACE_DAYS)], TODAY)
    outside = rate_invoices(_paid(3) + [_open(past_due=GRACE_DAYS + 1)], TODAY)
    assert (inside.reason, inside.past_due_count, inside.overdue_count) == ("mixed", 1, 0)
    assert (outside.reason, outside.past_due_count, outside.overdue_count) == ("overdue", 0, 1)
    # With no record to buffer it, the same edge decides the tier outright.
    assert rate_invoices([_open(past_due=GRACE_DAYS)], TODAY).tier == "new"
    assert rate_invoices([_open(past_due=GRACE_DAYS + 1)], TODAY).tier == "bad"


def test_past_due_inside_the_grace_is_counted_for_the_tooltip():
    rating = rate_invoices(_paid(3) + [_open(past_due=2), _open(past_due=5, number="FA-2")], TODAY)
    assert (rating.tier, rating.past_due_count, rating.overdue_count) == ("medium", 2, 0)


def test_on_time_slack_edge():
    on_time = rate_invoices(_paid(3, late_by=ON_TIME_SLACK_DAYS), TODAY)
    late = rate_invoices(_paid(3, late_by=ON_TIME_SLACK_DAYS + 1), TODAY)
    assert (on_time.tier, on_time.on_time_count) == ("good", 3)
    assert (late.tier, late.on_time_count) == ("bad", 0)


def test_void_and_draft_rows_are_ignored():
    rows = _paid(3) + [
        _open(past_due=40, number="VOID", balance=900.0) | {"status": "void"},
        _open(past_due=40, number="DRAFT", balance=900.0) | {"status": "draft"},
    ]
    assert rate_invoices(rows, TODAY).tier == "good"


def test_open_invoice_with_zero_balance_does_not_count():
    rows = _paid(3) + [_open(past_due=40, balance=0.0)]
    assert rate_invoices(rows, TODAY).tier == "good"


def test_invoices_older_than_the_window_fade():
    old = date(2024, 9, 1)  # more than 24 months before TODAY
    rows = _paid(3) + [
        _inv(number="OLD", issued=old, due=old + timedelta(days=30), paid_on=old + timedelta(days=200)),
    ]
    rating = rate_invoices(rows, TODAY)
    assert (rating.tier, rating.settled_count) == ("good", 3)
    inside = date(2024, 10, 1)  # inside the window
    rows_inside = _paid(3) + [
        _inv(number="IN", issued=inside, due=inside + timedelta(days=30), paid_on=inside + timedelta(days=200)),
    ]
    assert rate_invoices(rows_inside, TODAY).settled_count == 4


def test_window_boundary_exact_start_date_counts_day_before_does_not():
    window_start = date(2024, 9, 22)  # exactly 24 months before TODAY
    on_boundary = _inv(
        number="EDGE-ON",
        issued=window_start,
        due=window_start + timedelta(days=30),
        paid_on=window_start + timedelta(days=5),
    )
    assert rate_invoices([on_boundary], TODAY).settled_count == 1

    day_before = window_start - timedelta(days=1)
    before_boundary = _inv(
        number="EDGE-BEFORE",
        issued=day_before,
        due=day_before + timedelta(days=30),
        paid_on=day_before + timedelta(days=5),
    )
    assert rate_invoices([before_boundary], TODAY).settled_count == 0


def test_window_applies_to_settled_invoices_only_not_to_an_open_balance():
    # An open invoice older than the window still counts, and still overrides
    # the history: an unpaid debt does not get to fade just because it is old.
    issued = TODAY - timedelta(days=30 * 30)  # ~30 months ago
    due = TODAY - timedelta(days=29 * 30)  # ~29 months ago, 400+ days past due
    open_row = _inv(number="OLD-OPEN", issued=issued, due=due, status="sent", balance=500.0)
    rating = rate_invoices([open_row], TODAY)
    assert (rating.tier, rating.reason, rating.settled_count) == ("bad", "overdue", 0)
    assert rating.worst_overdue_days > 400

    # The same invoice, settled instead of open: the window still fades it,
    # even though it was paid 200 days late.
    paid_row = _inv(number="OLD-PAID", issued=issued, due=due, status="paid", paid_on=due + timedelta(days=200))
    rating_paid = rate_invoices([paid_row], TODAY)
    assert (rating_paid.tier, rating_paid.reason, rating_paid.settled_count) == ("new", "new", 0)


def test_paid_invoice_without_a_payment_date_counts_as_on_time():
    rows = [r | {"last_payment_date": ""} for r in _paid(3)]
    rating = rate_invoices(rows, TODAY)
    assert (rating.tier, rating.on_time_count) == ("good", 3)


def test_open_invoice_without_a_due_date_is_not_overdue():
    rows = _paid(3) + [_open(past_due=40) | {"due_date": ""}]
    assert rate_invoices(rows, TODAY).tier == "good"


def test_unparseable_dates_never_raise():
    rows = [
        _inv(issued=TODAY, due=TODAY, paid_on=TODAY) | {"date": "garbage", "due_date": "??", "last_payment_date": "x"}
    ]
    assert rate_invoices(rows, TODAY).tier == "medium"


@pytest.mark.asyncio
async def test_cache_row_round_trips(db_session):
    db_session.add(
        AitoClientRating(
            customer_id="C1",
            tier="good",
            reason="punctual",
            settled_count=5,
            on_time_count=5,
            overdue_count=0,
            past_due_count=0,
            worst_overdue_days=0,
            worst_overdue_number=None,
            computed_at=datetime(2026, 9, 22, 10, 0, 0),
        )
    )
    await db_session.commit()
    row = (await db_session.execute(select(AitoClientRating))).scalar_one()
    assert (row.customer_id, row.tier, row.settled_count) == ("C1", "good", 5)


def test_response_schema_defaults_to_unavailable_shape():
    body = AitoClientRatingResponse(tier="unavailable", reason=None, computed_at=None, stale=False)
    assert body.model_dump() == {
        "tier": "unavailable",
        "reason": None,
        "settled_count": 0,
        "on_time_count": 0,
        "overdue_count": 0,
        "past_due_count": 0,
        "worst_overdue_days": 0,
        "worst_overdue_number": None,
        "is_company": False,
        "computed_at": None,
        "stale": False,
    }


NOW = datetime(2026, 9, 22, 12, 0, 0)


def _fake_books(
    monkeypatch,
    rows: list[dict] | Exception,
    calls: list[str] | None = None,
    *,
    contact: dict | Exception | None = None,
    contact_calls: list[str] | None = None,
):
    """Books answers ``rows`` to the invoice list and ``contact`` to the
    contact read (default: an individual). Either may be an exception."""

    async def fake_list(db, customer_id):
        if calls is not None:
            calls.append(customer_id)
        if isinstance(rows, Exception):
            raise rows
        return list(rows)

    async def fake_contact(db, contact_id):
        if contact_calls is not None:
            contact_calls.append(contact_id)
        if isinstance(contact, Exception):
            raise contact
        return dict(contact or {"customer_sub_type": "individual"})

    monkeypatch.setattr(zoho_service, "list_customer_invoices", fake_list)
    monkeypatch.setattr(zoho_service, "get_contact", fake_contact)


COMPANY = {"customer_sub_type": "business"}


@pytest.mark.asyncio
async def test_contact_type_selects_the_company_profile_and_is_cached(db_session, monkeypatch):
    contact_calls: list[str] = []
    _fake_books(monkeypatch, _paid(2), contact=COMPANY, contact_calls=contact_calls)

    body = await read_client_rating(db_session, "C1", now=NOW)
    cached = await read_client_rating(db_session, "C1", now=NOW + timedelta(minutes=5))

    # Two settled is `good` only under the company profile.
    assert (body.tier, body.is_company, body.stale) == ("good", True, False)
    assert (cached.tier, cached.is_company, cached.computed_at) == ("good", True, NOW)
    assert contact_calls == ["C1"]
    row = (await db_session.execute(select(AitoClientRating))).scalar_one()
    assert row.is_company is True


@pytest.mark.asyncio
async def test_contact_read_failure_falls_back_to_the_individual_profile(db_session, monkeypatch):
    _fake_books(monkeypatch, _paid(2), contact=ZohoUpstreamError("boom"))

    body = await read_client_rating(db_session, "C1", now=NOW)

    assert (body.tier, body.is_company, body.stale) == ("medium", False, False)
    row = (await db_session.execute(select(AitoClientRating))).scalar_one()
    assert row.is_company is False


@pytest.mark.asyncio
async def test_contact_read_failure_keeps_the_cached_company_flag(db_session, monkeypatch):
    _fake_books(monkeypatch, _paid(2), contact=COMPANY)
    await read_client_rating(db_session, "C1", now=NOW)
    _fake_books(monkeypatch, _paid(2), contact=ZohoUpstreamError("boom"))

    body = await read_client_rating(db_session, "C1", now=NOW + CACHE_TTL)

    assert (body.tier, body.is_company, body.computed_at) == ("good", True, NOW + CACHE_TTL)


@pytest.mark.asyncio
async def test_cache_miss_reads_books_scores_and_writes_the_row(db_session, monkeypatch):
    calls: list[str] = []
    _fake_books(monkeypatch, _paid(4), calls)

    body = await read_client_rating(db_session, "C1", now=NOW)

    assert (body.tier, body.reason, body.settled_count, body.stale) == ("good", "punctual", 4, False)
    assert body.computed_at == NOW
    assert calls == ["C1"]
    row = (await db_session.execute(select(AitoClientRating))).scalar_one()
    assert (row.customer_id, row.tier, row.computed_at) == ("C1", "good", NOW)


@pytest.mark.asyncio
async def test_cache_hit_inside_the_ttl_skips_books(db_session, monkeypatch):
    calls: list[str] = []
    _fake_books(monkeypatch, _paid(4), calls)
    await read_client_rating(db_session, "C1", now=NOW)

    later = await read_client_rating(db_session, "C1", now=NOW + CACHE_TTL - timedelta(seconds=1))

    assert later.tier == "good"
    assert later.computed_at == NOW
    assert calls == ["C1"]


@pytest.mark.asyncio
async def test_ttl_expiry_recomputes_and_refresh_forces_it(db_session, monkeypatch):
    calls: list[str] = []
    _fake_books(monkeypatch, _paid(4), calls)
    await read_client_rating(db_session, "C1", now=NOW)

    expired = await read_client_rating(db_session, "C1", now=NOW + CACHE_TTL)
    # 2 minutes after the row just written by `expired`, well past the
    # refresh throttle's 60-second floor, so the force still goes through.
    forced = await read_client_rating(db_session, "C1", refresh=True, now=NOW + CACHE_TTL + timedelta(minutes=2))

    assert expired.computed_at == NOW + CACHE_TTL
    assert forced.computed_at == NOW + CACHE_TTL + timedelta(minutes=2)
    assert calls == ["C1", "C1", "C1"]

    # A refresh request only 30 seconds after that forced compute is inside
    # the throttle window and must not reach Books at all.
    throttled = await read_client_rating(
        db_session, "C1", refresh=True, now=NOW + CACHE_TTL + timedelta(minutes=2, seconds=30)
    )
    assert throttled.computed_at == forced.computed_at
    assert calls == ["C1", "C1", "C1"]


@pytest.mark.asyncio
async def test_books_failure_with_a_cached_row_returns_it_stale(db_session, monkeypatch):
    _fake_books(monkeypatch, _paid(4))
    await read_client_rating(db_session, "C1", now=NOW)
    _fake_books(monkeypatch, ZohoUpstreamError("boom"))

    body = await read_client_rating(db_session, "C1", now=NOW + CACHE_TTL)

    assert (body.tier, body.stale, body.computed_at) == ("good", True, NOW)


@pytest.mark.asyncio
async def test_books_failure_without_a_cached_row_is_unavailable(db_session, monkeypatch):
    _fake_books(monkeypatch, ZohoUpstreamError("boom"))

    body = await read_client_rating(db_session, "C1", now=NOW)

    assert (body.tier, body.reason, body.stale, body.computed_at) == ("unavailable", None, False, None)
    assert (await db_session.execute(select(AitoClientRating))).first() is None


@pytest.mark.asyncio
async def test_rate_limit_does_not_raise(db_session, monkeypatch):
    _fake_books(monkeypatch, ZohoRateLimited("throttled", retry_after=30))
    body = await read_client_rating(db_session, "C1", now=NOW)
    assert body.tier == "unavailable"


@pytest.mark.asyncio
async def test_default_contact_and_empty_id_are_new_and_never_read_books(db_session, monkeypatch):
    calls: list[str] = []
    _fake_books(monkeypatch, _paid(4), calls)

    async def default_contact(db):
        return ("WALKIN", "Client de passage")

    monkeypatch.setattr(zoho_service, "get_default_contact", default_contact)

    walk_in = await read_client_rating(db_session, "WALKIN", now=NOW)
    empty = await read_client_rating(db_session, "", now=NOW)
    none = await read_client_rating(db_session, None, now=NOW)

    assert [b.tier for b in (walk_in, empty, none)] == ["new", "new", "new"]
    assert calls == []
    assert (await db_session.execute(select(AitoClientRating))).first() is None


@pytest.mark.asyncio
async def test_cache_write_failure_still_returns_the_fresh_rating(db_session, monkeypatch):
    _fake_books(monkeypatch, _paid(4))

    async def failing_commit():
        raise OperationalError("db is locked", None, Exception("locked"))

    monkeypatch.setattr(db_session, "commit", failing_commit)

    body = await read_client_rating(db_session, "C1", now=NOW)

    assert (body.tier, body.stale, body.computed_at) == ("good", False, NOW)


@pytest.mark.asyncio
async def test_cached_row_read_failure_returns_unavailable_without_raising(db_session, monkeypatch):
    async def failing_get(*args, **kwargs):
        raise OperationalError("db is locked", None, Exception("locked"))

    monkeypatch.setattr(db_session, "get", failing_get)

    body = await read_client_rating(db_session, "C1", now=NOW)

    assert body.tier == "unavailable"


@pytest.mark.asyncio
async def test_route_returns_the_rating_and_honours_refresh(async_client, monkeypatch):
    calls: list[str] = []
    _fake_books(monkeypatch, _paid(4), calls)

    # The route has no `now=` seam, so the wall clock is faked here instead:
    # without it, all three requests land within the same instant and the
    # refresh throttle (REFRESH_MIN_AGE) would swallow the forced call too.
    clock = {"now": datetime(2026, 9, 22, 12, 0, 0, tzinfo=timezone.utc)}

    class _FakeDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            return clock["now"]

    monkeypatch.setattr(aito_client_rating_module, "datetime", _FakeDateTime)

    first = await async_client.get("/api/v1/aito/clients/C9/rating")
    second = await async_client.get("/api/v1/aito/clients/C9/rating")
    clock["now"] = clock["now"] + timedelta(minutes=2)
    forced = await async_client.get("/api/v1/aito/clients/C9/rating?refresh=1")

    assert first.status_code == 200, first.text
    assert first.json()["tier"] == "good"
    assert first.json()["stale"] is False
    assert second.json()["computed_at"] == first.json()["computed_at"]
    assert forced.status_code == 200
    assert calls == ["C9", "C9"]


@pytest.mark.asyncio
async def test_route_never_502s_when_books_is_down(async_client, monkeypatch):
    _fake_books(monkeypatch, ZohoUpstreamError("down"))
    r = await async_client.get("/api/v1/aito/clients/C9/rating")
    assert r.status_code == 200
    assert r.json()["tier"] == "unavailable"


def test_route_requires_aito_read():
    assert _declared_permissions("get_client_rating") == ["aito:read"]
