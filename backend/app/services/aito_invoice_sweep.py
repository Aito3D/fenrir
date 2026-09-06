"""Hourly read of each open invoice's status, balance and due date.

Cost-shaped for the Books quota the quote poller already protects: one call
per project that is invoiced AND still owes money, never one per board card,
and a project drops out of the selection for good once its balance reads 0.
The steady-state cost is therefore one call per hour per open receivable.

Reads only. No timeline event is recorded — an hourly "looked at the invoice"
row would drown the story. A malformed payload from Books (a non-numeric
balance, a missing key) skips that one project the same way an upstream
error does — it costs a project, not the whole pass."""

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
    own 429 handler exists to avoid. This function commits whatever it has
    already refreshed and then lets the exception propagate: ``run_sync_loop``
    catches it there and arms the same process-local throttle window
    ``sync_project`` uses, so the two callers share one backoff instead of
    each discovering the limit on its own."""
    global _last_run
    if not force and _last_run and time.monotonic() - _last_run < _SWEEP_INTERVAL_SECONDS:
        return 0
    _last_run = time.monotonic()

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
        except ZohoRateLimited:
            # T-006: stop here rather than spending one more request per
            # remaining project — commit what already succeeded and let the
            # caller (run_sync_loop) arm the shared throttle.
            if updated:
                await db.commit()
            raise
        except (ZohoUpstreamError, ValueError, TypeError, KeyError) as exc:
            logger.warning("Invoice sweep skipped project %s: %s", project.id, exc)
            continue
        project.invoice_checked_at = _now()
        updated += 1
    if updated:
        await db.commit()
    return updated
