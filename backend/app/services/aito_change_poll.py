"""Three org-wide "what changed in Books?" reads, once per change pass.

The quote sweep used to answer "is this card still in step with Books?" by
re-reading every open quoted card on every tick: one estimate read plus a
payments read per customer. On the production board that was more than Books
allows in a minute (see the 2026-10-01 spec). This module asks the opposite
question — which estimates, customer payments and retainer invoices has Books
touched since the last pass — for three calls whatever the board's size, and
the worker then re-reads only the cards those rows name.

It returns WHAT changed and nothing else. Which cards that means, and what a
reconcile does, stays in ``aito_quote_sync``; this module does not import it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.services.aito_poll_watermark import advance_watermark, parse_books_time, read_since
from backend.app.services.zoho import ZohoNotConfiguredError, ZohoRateLimited, ZohoUpstreamError, zoho_service

logger = logging.getLogger(__name__)

# The first pass looks one day back. Nothing older is needed: the worker's
# safety trickle re-reads every open card within one cycle anyway.
BACKFILL_DAYS = 1
# Books' filter is inclusive and stamps to the second, so two changes in one
# second can straddle a pass. Two seconds closes that seam; rows re-read
# through it are recognised by ``_seen`` and not reported again.
OVERLAP_SECONDS = 2
TRUNCATED_OVERLAP_SECONDS = 1

# (name, watermark setting, zoho_service method). Looked up by name at call
# time so a test's MockTransport is what answers.
_POLLS = (
    ("estimates", "aito_estimate_poll_since", "list_estimates_modified_since"),
    ("payments", "aito_payment_poll_since", "list_customer_payments_modified_since"),
    ("retainers", "aito_retainer_poll_since", "list_retainers_modified_since"),
)

# Per poll: row id -> the last_modified_time already reported for it. Only the
# rows of the latest window are kept, so this stays the size of one pass.
_seen: dict[str, dict[str, str]] = {name: {} for name, _, _ in _POLLS}


@dataclass
class Changes:
    estimate_ids: set[str] = field(default_factory=set)
    customer_ids: set[str] = field(default_factory=set)
    # Set when a listing answered 429. The changes read before it are kept;
    # the caller arms its background hold.
    rate_limited: ZohoRateLimited | None = None


async def poll_changes(db: AsyncSession) -> Changes:
    changes = Changes()
    for name, setting, lister in _POLLS:
        try:
            since = await read_since(db, setting, BACKFILL_DAYS)
            rows = await getattr(zoho_service, lister)(db, since)
        except ZohoRateLimited as e:
            changes.rate_limited = e
            break
        except (ZohoNotConfiguredError, ZohoUpstreamError) as e:
            # This poll's watermark stays where it was; the next pass re-reads
            # the same window. The other polls still run.
            logger.warning("Aito change poll (%s) failed: %s", name, e)
            continue
        previously = _seen[name]
        window: dict[str, str] = {}
        newest: datetime | None = None
        for row in rows:
            stamp = str(row.get("last_modified_time") or "")
            moment = parse_books_time(stamp)
            if moment is not None and (newest is None or moment > newest):
                newest = moment
            row_id = str(row.get("id") or "")
            if not row_id:
                continue
            window[row_id] = stamp
            if previously.get(row_id) == stamp:
                continue
            if name == "estimates":
                changes.estimate_ids.add(row_id)
            elif row.get("customer_id"):
                changes.customer_ids.add(str(row["customer_id"]))
        _seen[name] = window
        await advance_watermark(
            db,
            setting,
            since,
            rows,
            newest,
            None,
            overlap_seconds=OVERLAP_SECONDS,
            truncated_overlap_seconds=TRUNCATED_OVERLAP_SECONDS,
        )
    return changes


def reset() -> None:
    """Test seam."""
    for name in _seen:
        _seen[name] = {}
