"""The client rating: a customer's Books invoice history folded into one of
four tiers. Spec: docs/superpowers/specs/2026-09-22-aito-client-rating-design.md

The scorer is pure (rows + today in, dataclass out), so every tier rule and
every edge is a table row here with no Zoho, no clock and no database.
"""

from datetime import date, datetime, timedelta

import pytest
from sqlalchemy import select

from backend.app.models.aito_client_rating import AitoClientRating
from backend.app.schemas.aito import AitoClientRatingResponse
from backend.app.services.aito_client_rating import (
    GRACE_DAYS,
    ON_TIME_SLACK_DAYS,
    ClientRating,
    rate_invoices,
)

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
    assert rate_invoices([], TODAY) == ClientRating("new", "new", 0, 0, 0, 0, 0, None)


@pytest.mark.parametrize(
    ("rows", "tier", "reason"),
    [
        # 20 paid early + one open, inside its terms
        (_paid(20) + [_open(past_due=-20)], "good", "punctual"),
        # same, 3 days past due: inside the grace, history decides, but not good
        (_paid(20) + [_open(past_due=3)], "medium", "mixed"),
        # same, 9 days past due: override
        (_paid(20) + [_open(past_due=9)], "bad", "overdue"),
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
        # 3 paid, one 92 % paid and 12 days past due: a balance is a balance
        (_paid(3) + [_open(past_due=12, balance=80.0)], "bad", "overdue"),
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
    ],
)
def test_worked_examples_from_the_spec(rows, tier, reason):
    rating = rate_invoices(rows, TODAY)
    assert (rating.tier, rating.reason) == (tier, reason)


def test_overdue_reason_carries_the_worst_invoice():
    rows = _paid(3) + [_open(past_due=10, number="FA-A"), _open(past_due=23, number="FA-B")]
    rating = rate_invoices(rows, TODAY)
    assert rating.tier == "bad"
    assert rating.overdue_count == 2
    assert (rating.worst_overdue_days, rating.worst_overdue_number) == (23, "FA-B")


def test_grace_edge_seven_days_is_inside_eight_is_out():
    assert rate_invoices(_paid(3) + [_open(past_due=GRACE_DAYS)], TODAY).tier == "medium"
    assert rate_invoices(_paid(3) + [_open(past_due=GRACE_DAYS + 1)], TODAY).tier == "bad"


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
        "computed_at": None,
        "stale": False,
    }
