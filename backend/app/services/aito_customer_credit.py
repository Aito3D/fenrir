"""A customer's unspent deposits — "deposit available" on the Aito panel.

Why this is read off the CUSTOMER and not the quote
---------------------------------------------------
A retainer invoice in Books is a customer document. It MAY reference an
estimate (when raised from one) and then appears in that estimate's
``retainerinvoices`` list — but one raised by hand references nothing, and
never shows on any quote. Either way its payment lands as an advance on the
customer's account, and Books spends that advance on whatever invoice it is
applied to. The estimate's list keeps reporting the retainer as ``paid`` with
its full ``total`` long after the money is gone.

So the figure the operator needs — what this customer still has on account —
is the sum of the ``unused_amount`` of the customer's payments. One list
call (``GET /customerpayments?customer_id=``, verified on the live org
2026-09-15 to carry ``unused_amount`` and ``retainerinvoice_id`` per row),
no per-retainer detail reads.

What still reads the ESTIMATE's retainers, on purpose
-----------------------------------------------------
``retainer_paid_total`` (aito_quote_sync._paid_retainer_total) is unchanged
and still per-quote: it decides the paid-retainer auto-accept and nets the
online payment link. Counting customer-wide credit there would let a deposit
paid for one job silently accept and discount a sibling job for the same
customer. Two figures, two meanings.
"""

from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.services.zoho import ZohoNotConfiguredError, ZohoRateLimited, ZohoUpstreamError, zoho_service

logger = logging.getLogger(__name__)


def unused_credit_total(payments: list[dict]) -> float:
    """Sum of what is still unspent across a customer's payments.

    Tolerant of Books' own sloppiness (a missing or non-numeric field reads
    as zero) for the same reason ``_paid_retainer_total`` is: a single odd
    row must not blank a real figure.
    """
    total = 0.0
    for payment in payments:
        try:
            total += float(payment.get("unused_amount") or 0)
        except (TypeError, ValueError):
            continue
    return total


async def read_customer_credit(
    db: AsyncSession,
    customer_id: str | None,
    cache: dict[str, float] | None = None,
) -> float | None:
    """The customer's unspent deposits, or None when Books could not say.

    ``cache`` is per-CALLER, not module state: the sweep hands one dict to
    every project it reconciles in a tick, so N projects of one customer cost
    one call, and the dict dies with the tick — nothing to expire, nothing
    to leak between tests. Without one, every call reads.

    Best-effort by design. This is a side read beside a reconcile that has
    already succeeded; a failure here returns None — "leave the stored figure
    alone" — rather than flipping the card to a sync error over a number
    that is only displayed. The one exception is a 429: that is the sweep's
    own signal to stand down for the tick, and swallowing it would deepen
    the throttle it exists to clear. Failures are not cached, so the next
    project of the same customer in the tick tries again.

    An empty id is refused before any call: Books reads ``customer_id=`` as
    no filter and would answer with every payment in the org.
    """
    if not customer_id:
        return None
    if cache is not None and customer_id in cache:
        return cache[customer_id]
    try:
        payments = await zoho_service.list_customer_payments(db, customer_id)
    except ZohoRateLimited:
        raise
    except (ZohoNotConfiguredError, ZohoUpstreamError) as e:
        logger.warning("Aito: could not read customer %s's deposits from Books: %s", customer_id, e)
        return None
    total = unused_credit_total(payments)
    if cache is not None:
        cache[customer_id] = total
    return total
