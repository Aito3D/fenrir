"""A customer's quote rating: how readily they accept a quote, read off their
Books estimate history.

Spec: docs/superpowers/specs/2026-10-21-aito-quote-rating-design.md

Same two layers as the payment rating (``aito_client_rating``):
``rate_quotes`` is pure, and ``read_client_quote_rating`` wraps it with the
Books read and the per-customer cache row.

Why the rules are what they are
-------------------------------
- The point is to spot, before work goes into a quote, the customer who asks
  for many and accepts few. So the figure is an acceptance rate.
- A raw rate punishes a thin record: two quotes, two declines is 0 %, the
  same as twenty quotes and twenty declines. The rate is therefore SMOOTHED
  — every customer starts as if they already had PRIOR_ACCEPTED yes and
  PRIOR_DECLINED no (a neutral 50 %), and their real answers pull the score
  away from that middle. Two declines barely move it; eighteen of twenty
  drags it to the floor.
- ``accepted`` and ``invoiced`` (wholly or in part) are a yes. ``declined``
  is a no, and so is ``expired``: a quote left to die unanswered cost the
  shop the same time as one refused.
- ``sent`` and ``viewed`` are still waiting on the client; they are counted for
  the tooltip but not scored. ``draft`` (never sent), ``void`` and anything
  unknown are ignored.
- The 24-month window of the payment rating applies: an old habit fades.
  A row with no readable date is kept — dropping it would hide real answers.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_client_rating import AitoClientQuoteRating
from backend.app.schemas.aito import AitoClientQuoteRatingResponse
from backend.app.services.aito_client_rating import HISTORY_MONTHS, _months_ago, _parse_date
from backend.app.services.zoho import (
    ZohoNotConfiguredError,
    ZohoRateLimited,
    ZohoUpstreamError,
    zoho_service,
)

logger = logging.getLogger(__name__)

# The neutral starting record every customer is scored from. Six imaginary
# answers: a real record has to outweigh them before the tier leaves the
# middle, so two declines alone stay `medium` and three in a row do not.
PRIOR_ACCEPTED = 3.0
PRIOR_DECLINED = 3.0
# Score thresholds. `good` at 0.6 is two straight acceptances; `bad` below
# 0.35 is three straight refusals, or a long record mostly refused.
GOOD_MIN_SCORE = 0.6
BAD_MAX_SCORE = 0.35
# Cache timings, as for the payment rating.
CACHE_TTL = timedelta(hours=1)
REFRESH_MIN_AGE = timedelta(seconds=60)

_ACCEPTED_STATUSES = frozenset({"accepted", "invoiced", "partially_invoiced"})
_PENDING_STATUSES = frozenset({"sent", "viewed"})


@dataclass(frozen=True)
class QuoteRating:
    tier: str
    accepted_count: int
    declined_count: int
    expired_count: int
    pending_count: int
    score: float | None


def rate_quotes(rows: list[dict], today: date) -> QuoteRating:
    """Fold a customer's estimate rows (``_map_estimate_summary`` shape) into
    a quote rating as of ``today``."""
    window_start = _months_ago(today, HISTORY_MONTHS)
    accepted = declined = expired = pending = 0
    for row in rows:
        issued = _parse_date(row.get("date"))
        if issued is not None and issued < window_start:
            continue
        status = (row.get("status") or "").lower()
        if status in _ACCEPTED_STATUSES:
            accepted += 1
        elif status == "declined":
            declined += 1
        elif status == "expired":
            expired += 1
        elif status in _PENDING_STATUSES:
            pending += 1

    refused = declined + expired
    if accepted + refused == 0:
        return QuoteRating("new", accepted, declined, expired, pending, None)
    score = (accepted + PRIOR_ACCEPTED) / (accepted + refused + PRIOR_ACCEPTED + PRIOR_DECLINED)
    if score >= GOOD_MIN_SCORE:
        tier = "good"
    elif score < BAD_MAX_SCORE:
        tier = "bad"
    else:
        tier = "medium"
    return QuoteRating(tier, accepted, declined, expired, pending, score)


def _response(
    source: AitoClientQuoteRating | QuoteRating, *, computed_at: datetime | None, stale: bool
) -> AitoClientQuoteRatingResponse:
    return AitoClientQuoteRatingResponse(
        tier=source.tier,
        accepted_count=source.accepted_count,
        declined_count=source.declined_count,
        expired_count=source.expired_count,
        pending_count=source.pending_count,
        score=source.score,
        computed_at=computed_at,
        stale=stale,
    )


def _new() -> AitoClientQuoteRatingResponse:
    return AitoClientQuoteRatingResponse(tier="new", computed_at=None, stale=False)


def _unavailable() -> AitoClientQuoteRatingResponse:
    return AitoClientQuoteRatingResponse(tier="unavailable", computed_at=None, stale=False)


async def read_client_quote_rating(
    db: AsyncSession,
    customer_id: str | None,
    *,
    refresh: bool = False,
    now: datetime | None = None,
) -> AitoClientQuoteRatingResponse:
    """The customer's quote rating: cached when fresh, recomputed from Books
    otherwise, degraded rather than raised when Books or the database cannot
    answer — it decorates a name, and must never take the drawer down.

    An empty history is answered `new` and NOT cached: Books answers an id it
    does not know with an empty list too, and a caller-named id must not be
    able to leave rows behind (the payment rating's T-024). A real customer
    with no quotes yet costs one Books read per request, which the route's
    rate limit bounds.
    """
    if not customer_id:
        return _new()
    try:
        default_id, _name = await zoho_service.get_default_contact(db)
    except SQLAlchemyError as e:
        logger.warning("Aito: could not read the default contact for customer %s's quote rating: %s", customer_id, e)
        return _unavailable()
    if customer_id == default_id:
        # The walk-in contact's quotes belong to everyone — no verdict.
        return _new()

    moment = now or datetime.now(timezone.utc).replace(tzinfo=None)
    try:
        cached = await db.get(AitoClientQuoteRating, customer_id)
    except SQLAlchemyError as e:
        logger.warning("Aito: could not read customer %s's cached quote rating: %s", customer_id, e)
        return _unavailable()

    if refresh and cached is not None and moment - cached.computed_at < REFRESH_MIN_AGE:
        refresh = False
    if cached is not None and not refresh and moment - cached.computed_at < CACHE_TTL:
        return _response(cached, computed_at=cached.computed_at, stale=False)

    try:
        rows = await zoho_service.list_customer_estimates(db, customer_id)
    except (ZohoNotConfiguredError, ZohoUpstreamError, ZohoRateLimited) as e:
        logger.warning("Aito: could not read customer %s's estimates for the quote rating: %s", customer_id, e)
        return _response(cached, computed_at=cached.computed_at, stale=True) if cached is not None else _unavailable()

    rating = rate_quotes(rows, moment.date())
    if not rows and cached is None:
        return _response(rating, computed_at=moment, stale=False)
    if cached is None:
        cached = AitoClientQuoteRating(customer_id=customer_id)
        db.add(cached)
    cached.tier = rating.tier
    cached.accepted_count = rating.accepted_count
    cached.declined_count = rating.declined_count
    cached.expired_count = rating.expired_count
    cached.pending_count = rating.pending_count
    cached.score = rating.score
    cached.computed_at = moment
    try:
        await db.commit()
    except SQLAlchemyError as e:
        await db.rollback()
        logger.warning("Aito: could not cache customer %s's quote rating: %s", customer_id, e)
    # Built from `rating`, never `cached`: after a rollback the ORM row's
    # attributes are expired and reading them raises MissingGreenlet.
    return _response(rating, computed_at=moment, stale=False)
