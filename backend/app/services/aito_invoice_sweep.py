"""Hourly read of each open invoice's status, balance and due date.

Cost-shaped for the Books quota the quote poller already protects: one call
per project that is invoiced AND still owes money, never one per board card,
and a project drops out of the selection for good once its balance reads 0.
The steady-state cost is therefore one call per hour per open receivable.

Reads only. No timeline event is recorded — an hourly "looked at the invoice"
row would drown the story. A malformed payload from Books (a non-numeric
balance, a missing key) skips that one project the same way an upstream
error does — it costs a project, not the whole pass.

T-007: if Books reports no invoice at all (deleted, or its estimate/customer
link removed), the cached status/balance/due date are cleared rather than
left showing the last figures ever seen. A cleared row still has a null
balance, so it keeps matching the selection above and costs one call per
hour until either an invoice reappears or the project itself is archived —
the same steady state as a project that was never invoiced yet.

T-010: each project's refresh is committed on its own, right after it is
computed, rather than batching every project into one commit at the end of
the pass. A database-locked (or any other) failure on that commit now costs
the one project mid-flush, not the whole pass's worth of already-refreshed
rows. The hourly gate's timestamp is stamped only once the pass has
actually finished, so a pass that never reaches the end (a ``ZohoRateLimited``
or any other exception escaping the function) is retried on the very next
300 s tick instead of sitting out the rest of the hour."""

import logging
import time
from datetime import datetime, timezone

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_project import AitoProject
from backend.app.services.zoho import ZohoRateLimited, ZohoUpstreamError, zoho_service

logger = logging.getLogger(__name__)

_SWEEP_INTERVAL_SECONDS = 3600
# time.monotonic() of the last pass that ran; 0.0 = never. Module state so
# the loop's 300 s ticks can call sweep_invoices() unconditionally.
_last_run: float = 0.0


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


async def sweep_invoices(db: AsyncSession, *, force: bool = False) -> int:
    """Refresh the cached invoice fields on every project still owing money.

    Returns the number of projects updated. ``force`` bypasses the hourly
    gate (tests, and a future manual refresh).

    T-006: a ``ZohoRateLimited`` (HTTP 429) is not treated like an ordinary
    upstream error — retrying the identical request will simply work once
    the window clears, so continuing to hit Books once per remaining project
    would only deepen the throttle, the same failure mode ``sync_project``'s
    own 429 handler exists to avoid. Every project already refreshed before
    the 429 was already committed on its own (T-010), so this function has
    nothing left to flush — it simply lets the exception propagate:
    ``run_sync_loop`` catches it there and arms the same process-local
    throttle window ``sync_project`` uses, so the two callers share one
    backoff instead of each discovering the limit on its own. The hourly
    gate's timestamp is deliberately NOT stamped on this path either: the
    throttle window in ``run_sync_loop`` already prevents hammering Books
    again immediately, so once that window clears the sweep should simply
    resume on the next tick rather than also sitting out the rest of an
    hour it never got to finish."""
    global _last_run
    if not force and _last_run and time.monotonic() - _last_run < _SWEEP_INTERVAL_SECONDS:
        return 0

    stmt = select(AitoProject).where(
        AitoProject.status == "active",
        AitoProject.quote_invoiced.is_(True),
        AitoProject.quote_id.is_not(None),
        or_(AitoProject.invoice_balance.is_(None), AitoProject.invoice_balance > 0),
    )
    projects = list((await db.execute(stmt)).scalars().all())
    updated = 0
    for project in projects:
        try:
            invoices = await zoho_service.list_project_invoices(db, project.quote_id or "", project.client_id or "")
            if invoices:
                newest = invoices[0]
                # Parsed into locals before any assignment: a ValueError on
                # the balance must leave the row untouched, not half-written.
                status = newest.get("status") or None
                balance = float(newest.get("balance") or 0)
                due = newest.get("due_date") or None
                project.invoice_status = status
                project.invoice_balance = balance
                project.invoice_due_date = due
            else:
                # T-007: Books no longer knows about an invoice for this
                # project (deleted, or its estimate/customer link removed).
                # The cached fields must not keep answering for an invoice
                # that is gone -- clear them the same way a fresh project
                # reads before its first invoice ever existed. This still
                # counts as a refresh (the call succeeded), so the row is
                # stamped and counted below like any other pass.
                project.invoice_status = None
                project.invoice_balance = None
                project.invoice_due_date = None
        except ZohoRateLimited:
            # T-006: stop here rather than spending one more request per
            # remaining project — everything refreshed so far this pass was
            # already committed per project below, so there is nothing left
            # to flush; just let the caller (run_sync_loop) arm the shared
            # throttle.
            raise
        except (ZohoUpstreamError, ValueError, TypeError, KeyError) as exc:
            logger.warning("Invoice sweep skipped project %s: %s", project.id, exc)
            continue
        project.invoice_checked_at = _now()
        updated += 1
        # T-010: commit this project's refresh on its own rather than
        # batching the whole pass into one commit at the end. A failure on
        # this specific commit (SQLite "database is locked", for example)
        # then costs only this one project instead of discarding every
        # project already refreshed earlier in the same pass.
        await db.commit()
    # T-010: the hourly slot is spent only once the pass has actually
    # finished. An exception escaping the loop above (a ZohoRateLimited,
    # or anything else) skips this line entirely, leaving _last_run at
    # whatever it was before this call so the next 300 s tick tries again
    # instead of waiting out the rest of an hour for a pass that never
    # completed.
    _last_run = time.monotonic()
    return updated
