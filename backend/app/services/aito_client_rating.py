"""A customer's payment rating, read off their Books invoice history.

Spec: docs/superpowers/specs/2026-09-22-aito-client-rating-design.md

Two layers. ``rate_invoices`` is pure — rows in, a ``ClientRating`` out, the
clock passed in — so every tier rule is a table row in its test.
``read_client_rating`` (added in a later task) wraps it with the Books read
and the per-customer cache row.

Why the rules are what they are
-------------------------------
- Lateness is measured against the DUE date, not the invoice date, so the
  payment terms the shop agreed per customer are honoured: a 30-day customer
  paying on day 25 is punctual.
- A currently overdue invoice, past a short grace, OVERRIDES the history:
  the rating exists to be read before a printer is committed, and a live
  debt is the fact that matters then. The grace absorbs a transfer in
  transit and a payment booked a day or two late.
- Chronic lateness with no live debt is also bad. Five invoices each paid
  three weeks late is a pattern, and "medium" would hide it.
- The first settled invoice is enough to rate: not enough for "good", but
  enough to stop saying "new".
- A partially paid invoice is open until its balance is zero. The remaining
  debt is real.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_client_rating import AitoClientRating
from backend.app.schemas.aito import AitoClientRatingResponse
from backend.app.services.zoho import ZohoNotConfiguredError, ZohoRateLimited, ZohoUpstreamError, zoho_service

logger = logging.getLogger(__name__)

# Overdue days before an open invoice forces `bad`, whatever the history.
GRACE_DAYS = 7
# A settled invoice paid this many days after its due date still counts as
# on time: bank delay, or a payment recorded in Books after it arrived.
ON_TIME_SLACK_DAYS = 3
# Settled invoices needed before `good` is reachable.
GOOD_MIN_SETTLED = 3
# Share of settled invoices that must be on time for `good`.
GOOD_MIN_ON_TIME_RATIO = 0.9
# At or below this share, with GOOD_MIN_SETTLED or more settled, the tier is
# `bad` even with nothing open.
CHRONIC_MAX_ON_TIME_RATIO = 0.5
# Invoices issued more than this long ago are not scored: an old lapse fades.
HISTORY_MONTHS = 24
# How long a cached rating is served before Books is re-read.
CACHE_TTL = timedelta(hours=1)
# Which list-row field says when a paid invoice was paid. Settled by the
# read-only probe of 2026-09-22 (plan Task 1): `last_payment_date` when Books
# lists it, otherwise `last_modified_time` — Books stamps that when the
# payment is recorded, which is the same moment for the rating's purpose.
PAID_ON_FIELD = "last_payment_date"

_IGNORED_STATUSES = frozenset({"void", "draft"})

TIERS = ("good", "medium", "bad", "new")
REASONS = ("overdue", "chronic", "new", "punctual", "mixed")


@dataclass(frozen=True)
class ClientRating:
    tier: str
    reason: str
    settled_count: int
    on_time_count: int
    # Open invoices past the grace — the ones that force `bad`.
    overdue_count: int
    # Open invoices past due but inside the grace — what keeps a regular off
    # `good` without making them `bad`.
    past_due_count: int
    worst_overdue_days: int
    worst_overdue_number: str | None


def _parse_date(value) -> date | None:
    """Books' `YYYY-MM-DD` (a `T...` suffix is tolerated), or None. Never raises:
    one mangled row costs that row's date, not the customer's rating."""
    if not value or not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def _months_ago(today: date, months: int) -> date:
    year = today.year - months // 12
    month = today.month - months % 12
    if month < 1:
        month += 12
        year -= 1
    # Clamp the day for a shorter target month (31 March -> 28/29 February).
    for day in (today.day, 30, 29, 28):
        try:
            return date(year, month, day)
        except ValueError:
            continue
    return date(year, month, 1)


def _balance(row: dict) -> float:
    try:
        return float(row.get("balance") or 0)
    except (TypeError, ValueError):
        return 0.0


def rate_invoices(rows: list[dict], today: date) -> ClientRating:
    """Fold a customer's invoice rows (``_map_invoice_history`` shape) into a
    rating as of ``today``. Rules, top down, from the spec:

    1. bad/overdue   — any open invoice more than GRACE_DAYS past due
    2. bad/chronic   — >= GOOD_MIN_SETTLED settled and <= CHRONIC ratio on time
    3. new/new       — nothing settled
    4. good/punctual — >= GOOD_MIN_SETTLED settled, >= GOOD ratio on time,
                       nothing past due at all
    5. medium/mixed  — everything else
    """
    window_start = _months_ago(today, HISTORY_MONTHS)
    settled = on_time = overdue = past_due = 0
    worst_days = 0
    worst_number: str | None = None

    for row in rows:
        status = (row.get("status") or "").lower()
        if status in _IGNORED_STATUSES:
            continue
        issued = _parse_date(row.get("date"))
        if issued is not None and issued < window_start:
            continue
        due = _parse_date(row.get("due_date"))
        if status == "paid":
            settled += 1
            paid_on = _parse_date(row.get(PAID_ON_FIELD))
            lateness = (paid_on - due).days if (paid_on is not None and due is not None) else 0
            if lateness <= ON_TIME_SLACK_DAYS:
                on_time += 1
            continue
        if _balance(row) <= 0:
            continue
        days = max((today - due).days, 0) if due is not None else 0
        if days > GRACE_DAYS:
            overdue += 1
            if days > worst_days:
                worst_days, worst_number = days, (row.get("number") or None)
        elif days > 0:
            past_due += 1

    def _make(tier: str, reason: str) -> ClientRating:
        return ClientRating(tier, reason, settled, on_time, overdue, past_due, worst_days, worst_number)

    ratio = on_time / settled if settled else 0.0
    if overdue:
        return _make("bad", "overdue")
    if settled >= GOOD_MIN_SETTLED and ratio <= CHRONIC_MAX_ON_TIME_RATIO:
        return _make("bad", "chronic")
    if settled == 0:
        return _make("new", "new")
    if settled >= GOOD_MIN_SETTLED and ratio >= GOOD_MIN_ON_TIME_RATIO and past_due == 0:
        return _make("good", "punctual")
    return _make("medium", "mixed")


def _response(row: AitoClientRating, *, stale: bool) -> AitoClientRatingResponse:
    return AitoClientRatingResponse(
        tier=row.tier,
        reason=row.reason,
        settled_count=row.settled_count,
        on_time_count=row.on_time_count,
        overdue_count=row.overdue_count,
        past_due_count=row.past_due_count,
        worst_overdue_days=row.worst_overdue_days,
        worst_overdue_number=row.worst_overdue_number,
        computed_at=row.computed_at,
        stale=stale,
    )


def _response_from_rating(rating: ClientRating, computed_at: datetime) -> AitoClientRatingResponse:
    return AitoClientRatingResponse(
        tier=rating.tier,
        reason=rating.reason,
        settled_count=rating.settled_count,
        on_time_count=rating.on_time_count,
        overdue_count=rating.overdue_count,
        past_due_count=rating.past_due_count,
        worst_overdue_days=rating.worst_overdue_days,
        worst_overdue_number=rating.worst_overdue_number,
        computed_at=computed_at,
        stale=False,
    )


_NEW = AitoClientRatingResponse(tier="new", reason="new", computed_at=None, stale=False)
_UNAVAILABLE = AitoClientRatingResponse(tier="unavailable", reason=None, computed_at=None, stale=False)


async def read_client_rating(
    db: AsyncSession,
    customer_id: str | None,
    *,
    refresh: bool = False,
    now: datetime | None = None,
) -> AitoClientRatingResponse:
    """The customer's rating: cached when fresh, recomputed from Books
    otherwise, degraded rather than raised when Books cannot answer.

    Never raises to the route. This decorates a name; a 502 over it would
    take the panel down for a pill. A 429 is logged and treated like any
    other read failure — there is no retry loop here, the next open of the
    panel is the retry.

    ``now`` is injectable for the tests; production passes nothing.
    """
    if not customer_id:
        return _NEW
    default_id, _name = await zoho_service.get_default_contact(db)
    if customer_id == default_id:
        # The walk-in contact's invoices belong to everyone — no verdict.
        return _NEW

    moment = now or datetime.now(timezone.utc).replace(tzinfo=None)
    cached = await db.get(AitoClientRating, customer_id)
    if cached is not None and not refresh and moment - cached.computed_at < CACHE_TTL:
        return _response(cached, stale=False)

    try:
        rows = await zoho_service.list_customer_invoices(db, customer_id)
    except (ZohoNotConfiguredError, ZohoUpstreamError, ZohoRateLimited) as e:
        logger.warning("Aito: could not read customer %s's invoices for the rating: %s", customer_id, e)
        return _response(cached, stale=True) if cached is not None else _UNAVAILABLE

    rating = rate_invoices(rows, moment.date())
    if cached is None:
        cached = AitoClientRating(customer_id=customer_id)
        db.add(cached)
    cached.tier = rating.tier
    cached.reason = rating.reason
    cached.settled_count = rating.settled_count
    cached.on_time_count = rating.on_time_count
    cached.overdue_count = rating.overdue_count
    cached.past_due_count = rating.past_due_count
    cached.worst_overdue_days = rating.worst_overdue_days
    cached.worst_overdue_number = rating.worst_overdue_number
    cached.computed_at = moment
    try:
        await db.commit()
    except SQLAlchemyError as e:
        await db.rollback()
        logger.warning("Aito: could not cache customer %s's rating: %s", customer_id, e)
        # The rating itself is correct; only the cache write was lost. Build
        # the response from `rating`, not `cached` — after a rollback the
        # ORM row's attributes are expired and reading them raises
        # MissingGreenlet.
        return _response_from_rating(rating, moment)
    return _response_from_rating(rating, moment)
