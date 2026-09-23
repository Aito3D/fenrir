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
- A currently overdue invoice, past a short grace, counts against the
  history: the rating exists to be read before a printer is committed, and
  a live debt is the fact that matters then. The grace absorbs a transfer
  in transit and a payment booked a day or two late.
- But a live debt is weighed against the RECORD (rework of 2026-09-23). Ten
  invoices paid on time and one a fortnight overdue is a good customer
  having a slow month, not a bad customer: with a strong record (enough
  settled, nearly all on time) a mild overdue lands on `medium`, and only a
  SEVERE one — weeks past due — forces `bad`. A thin or weak record gets no
  such buffer, since there is nothing to weigh the debt against.
- A company is scored on its own profile. A company is the more willing
  payer (a budget, an accounts department, a reputation), and also the
  slower one, because every invoice waits on someone's approval and a
  payment run. So a company's lateness thresholds are looser at every step
  — on-time slack, grace, the severe line — and it reaches `good` on fewer
  settled invoices. What makes a company is Books' `customer_sub_type`.
- Chronic lateness with no live debt is also bad. Five invoices each paid
  three weeks late is a pattern, and "medium" would hide it.
- The first settled invoice is enough to rate: not enough for "good", but
  enough to stop saying "new".
- A partially paid invoice is open until its balance is zero. The remaining
  debt is real.
- The 24-month window only fades SETTLED invoices: an old lapse should stop
  counting once it is far enough behind. An open invoice with a balance is
  scored whatever its age — an unpaid debt does not get to expire just
  because it has gone unnoticed for two years.
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


@dataclass(frozen=True)
class RatingProfile:
    """The timing thresholds one kind of customer is held to."""

    # A settled invoice paid this many days after its due date still counts
    # as on time: bank delay, or a payment recorded in Books after it
    # arrived — or, for a company, the approval-and-payment-run cycle.
    on_time_slack_days: int
    # Overdue days before an open invoice counts as `overdue` rather than
    # merely past due.
    grace_days: int
    # Settled invoices needed before `good` is reachable.
    good_min_settled: int
    # Overdue days past which an open invoice forces `bad` whatever the
    # record. Below it, a strong record buffers the debt to `medium`.
    severe_overdue_days: int


INDIVIDUAL_PROFILE = RatingProfile(on_time_slack_days=3, grace_days=7, good_min_settled=3, severe_overdue_days=45)
COMPANY_PROFILE = RatingProfile(on_time_slack_days=14, grace_days=21, good_min_settled=2, severe_overdue_days=60)

# The individual figures under their historical names — the spec's worked
# examples and the tests read them.
GRACE_DAYS = INDIVIDUAL_PROFILE.grace_days
ON_TIME_SLACK_DAYS = INDIVIDUAL_PROFILE.on_time_slack_days
GOOD_MIN_SETTLED = INDIVIDUAL_PROFILE.good_min_settled
# Share of settled invoices that must be on time for `good` — and the share
# that makes a record strong enough to buffer a mild overdue invoice.
GOOD_MIN_ON_TIME_RATIO = 0.9
# Settled invoices needed before `chronic` can be called, for either
# profile: two data points are not a pattern.
CHRONIC_MIN_SETTLED = 3
# At or below this share, with CHRONIC_MIN_SETTLED or more settled, the tier
# is `bad` even with nothing open.
CHRONIC_MAX_ON_TIME_RATIO = 0.5
# Books' `customer_sub_type` value that selects the company profile.
COMPANY_SUB_TYPE = "business"
# Settled invoices issued more than this long ago are not scored: an old
# lapse fades. Does NOT apply to an open invoice with a balance — that stays
# in scope whatever its age, since an unpaid debt never fades.
HISTORY_MONTHS = 24
# How long a cached rating is served before Books is re-read.
CACHE_TTL = timedelta(hours=1)
# A `refresh=True` request is ignored while the cached row is younger than
# this, so a loop hitting `?refresh=1` cannot amplify Books calls.
REFRESH_MIN_AGE = timedelta(seconds=60)
# Which list-row field says when a paid invoice was paid. The read-only probe
# of 2026-09-22 (plan Task 1) confirmed Books' list rows carry
# `last_payment_date` directly, so that is what is read. `last_modified_time`
# is still mapped through by `_map_invoice_history` but otherwise unused here
# — kept as the documented alternative should Books ever stop listing
# `last_payment_date`.
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
    # Which profile scored the rows.
    is_company: bool = False


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


def rate_invoices(rows: list[dict], today: date, *, is_company: bool = False) -> ClientRating:
    """Fold a customer's invoice rows (``_map_invoice_history`` shape) into a
    rating as of ``today``, under the individual or the company profile.
    Rules, top down, from the spec:

    0. window          — the HISTORY_MONTHS lookback drops a SETTLED invoice
                          issued before it; an open invoice with a balance is
                          scored whatever its age, so an unpaid debt never
                          ages out of the rating
    1. bad/overdue     — an open invoice more than `severe_overdue_days` past
                          due, whatever the record
    2. bad/overdue     — an open invoice more than `grace_days` past due and
                          a record too thin (< `good_min_settled` settled) or
                          too weak (< GOOD ratio on time) to buffer it
    3. medium/overdue  — an open invoice more than `grace_days` past due,
                          buffered by a strong record
    4. bad/chronic     — >= CHRONIC_MIN_SETTLED settled and <= CHRONIC ratio
                          on time
    5. new/new         — nothing settled
    6. good/punctual   — >= `good_min_settled` settled, >= GOOD ratio on
                          time, nothing past due at all
    7. medium/mixed    — everything else
    """
    profile = COMPANY_PROFILE if is_company else INDIVIDUAL_PROFILE
    window_start = _months_ago(today, HISTORY_MONTHS)
    settled = on_time = overdue = past_due = 0
    worst_days = 0
    worst_number: str | None = None

    for row in rows:
        status = (row.get("status") or "").lower()
        if status in _IGNORED_STATUSES:
            continue
        issued = _parse_date(row.get("date"))
        due = _parse_date(row.get("due_date"))
        if status == "paid":
            if issued is not None and issued < window_start:
                # An old settled invoice fades — but only a settled one.
                continue
            settled += 1
            paid_on = _parse_date(row.get(PAID_ON_FIELD))
            lateness = (paid_on - due).days if (paid_on is not None and due is not None) else 0
            if lateness <= profile.on_time_slack_days:
                on_time += 1
            continue
        if _balance(row) <= 0:
            continue
        days = max((today - due).days, 0) if due is not None else 0
        if days > profile.grace_days:
            overdue += 1
            if days > worst_days:
                worst_days, worst_number = days, (row.get("number") or None)
        elif days > 0:
            past_due += 1

    def _make(tier: str, reason: str) -> ClientRating:
        return ClientRating(tier, reason, settled, on_time, overdue, past_due, worst_days, worst_number, is_company)

    ratio = on_time / settled if settled else 0.0
    strong_record = settled >= profile.good_min_settled and ratio >= GOOD_MIN_ON_TIME_RATIO
    if overdue:
        if worst_days > profile.severe_overdue_days or not strong_record:
            return _make("bad", "overdue")
        return _make("medium", "overdue")
    if settled >= CHRONIC_MIN_SETTLED and ratio <= CHRONIC_MAX_ON_TIME_RATIO:
        return _make("bad", "chronic")
    if settled == 0:
        return _make("new", "new")
    if strong_record and past_due == 0:
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
        is_company=row.is_company,
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
        is_company=rating.is_company,
        computed_at=computed_at,
        stale=False,
    )


def _new() -> AitoClientRatingResponse:
    return AitoClientRatingResponse(tier="new", reason="new", computed_at=None, stale=False)


def _unavailable() -> AitoClientRatingResponse:
    return AitoClientRatingResponse(tier="unavailable", reason=None, computed_at=None, stale=False)


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

    Both DB reads below (the default contact and the cached row) are guarded:
    the contract is "never fail over a pill" and a locked/unreachable
    database is exactly the kind of transient fault that contract exists
    for, same as a Books outage.
    """
    if not customer_id:
        return _new()
    try:
        default_id, _name = await zoho_service.get_default_contact(db)
    except SQLAlchemyError as e:
        logger.warning("Aito: could not read the default contact for customer %s's rating: %s", customer_id, e)
        return _unavailable()
    if customer_id == default_id:
        # The walk-in contact's invoices belong to everyone — no verdict.
        return _new()

    moment = now or datetime.now(timezone.utc).replace(tzinfo=None)
    try:
        cached = await db.get(AitoClientRating, customer_id)
    except SQLAlchemyError as e:
        logger.warning("Aito: could not read customer %s's cached rating: %s", customer_id, e)
        return _unavailable()

    if refresh and cached is not None and moment - cached.computed_at < REFRESH_MIN_AGE:
        # A refresh request cannot be older than the row it would replace;
        # ignore it rather than let a `?refresh=1` loop amplify Books calls.
        refresh = False
    if cached is not None and not refresh and moment - cached.computed_at < CACHE_TTL:
        return _response(cached, stale=False)

    try:
        rows = await zoho_service.list_customer_invoices(db, customer_id)
    except (ZohoNotConfiguredError, ZohoUpstreamError, ZohoRateLimited) as e:
        logger.warning("Aito: could not read customer %s's invoices for the rating: %s", customer_id, e)
        return _response(cached, stale=True) if cached is not None else _unavailable()

    # Which profile: Books' contact says whether this is a company. A second
    # read per recompute, but the invoices are the rating and the contact is
    # only its lens — so a failed contact read costs the lens, not the
    # rating: the last known flag is kept, and a customer never seen before
    # is scored as an individual, the stricter of the two.
    is_company = cached.is_company if cached is not None else False
    try:
        contact = await zoho_service.get_contact(db, customer_id)
    except (ZohoNotConfiguredError, ZohoUpstreamError, ZohoRateLimited) as e:
        logger.warning("Aito: could not read customer %s's contact type for the rating: %s", customer_id, e)
    else:
        is_company = (contact.get("customer_sub_type") or "").lower() == COMPANY_SUB_TYPE

    rating = rate_invoices(rows, moment.date(), is_company=is_company)
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
    cached.is_company = rating.is_company
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
