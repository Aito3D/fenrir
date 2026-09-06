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
the pass. T-027 (loop-9): a database-locked (or any other SQLAlchemy) failure
on that commit is caught right there -- the transaction is rolled back and
the one project is skipped, exactly like the upstream/malformed-payload
branch above it, so every project already refreshed earlier in the same pass
stays committed AND every project still queued behind the failure is still
attempted. T-031 (loop-9): the hourly gate's timestamp is stamped on every
exit from the pass except a ``ZohoRateLimited`` -- a per-project commit
failure (or any other unexpected exception) still spends the hourly slot the
same way a clean pass does, since the loop itself already recovered from it
project by project; only the 429 path leaves ``_last_run`` untouched, because
that path relies on ``run_sync_loop``'s shared throttle window to decide
when to try again rather than on this hourly gate.

T-026 (loop-9): the selection is ordered least-recently-checked first
(``invoice_checked_at`` ascending, nulls first, id as tiebreaker) instead of
left unordered. Without this, a pass cut short by a 429 always resumed at
the identical head-of-list projects on the next tick, re-spending calls on
rows it had just refreshed while the tail past the cutoff never got looked
at again. The ``_last_run`` rule from T-031 above is unchanged by this fix
(deliberately -- see the module docstring) and does the rest of the work:
once the shared throttle window clears, the very next tick resumes the
sweep, and thanks to this ordering it now resumes with the projects the 429
cut off rather than the ones already refreshed."""

import logging
import time
from datetime import datetime, timezone

from sqlalchemy import or_, select
from sqlalchemy.exc import SQLAlchemyError
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
    backoff instead of each discovering the limit on its own.

    T-031 (loop-9): the hourly gate's timestamp is stamped on every exit
    from this pass EXCEPT a ``ZohoRateLimited`` — that path alone leaves
    ``_last_run`` untouched, because the throttle window ``run_sync_loop``
    arms already prevents hammering Books again immediately, so once that
    window clears the sweep should simply resume on the next tick rather
    than also sitting out the rest of an hour it never got to finish. Any
    other exception escaping the pass (an unexpected error out of the
    SELECT, say) still spends the hourly slot, since a per-project failure
    below no longer aborts the pass at all — see T-027.

    T-026 (loop-9): the selection below is ordered least-recently-checked
    first, so a pass resumed after a 429 picks up with the tail the 429 cut
    off rather than re-refreshing the same head-of-list projects. This is
    deliberately NOT paired with a "stamp ``_last_run`` on partial progress"
    rule — the T-031 rule above already decides when the hourly gate is
    spent, and this ordering fix is what makes the resumed pass useful on
    its own."""
    global _last_run
    if not force and _last_run and time.monotonic() - _last_run < _SWEEP_INTERVAL_SECONDS:
        return 0

    updated = 0
    try:
        stmt = (
            select(AitoProject)
            .where(
                AitoProject.status == "active",
                AitoProject.quote_invoiced.is_(True),
                AitoProject.quote_id.is_not(None),
                or_(AitoProject.invoice_balance.is_(None), AitoProject.invoice_balance > 0),
            )
            # T-026 (loop-9): least-recently-checked first (nulls -- never
            # swept -- ahead of everything), id as a stable tiebreaker. A
            # pass that gets cut short (a 429, most commonly) leaves its
            # unreached tail with the oldest invoice_checked_at values, so
            # resuming with this order means the NEXT pass starts exactly
            # where the interrupted one left off instead of re-spending its
            # calls on the same head-of-list projects every tick.
            .order_by(AitoProject.invoice_checked_at.asc().nulls_first(), AitoProject.id)
        )
        projects = list((await db.execute(stmt)).scalars().all())
        # T-027: id/quote_id/client_id are captured up front, while every row
        # is still fresh, rather than re-read off `project` inside the loop.
        # A rollback below (recovering from a failed commit) expires every
        # object still held by the session, including projects further down
        # this same list -- re-reading a plain column off an expired ORM
        # object triggers an implicit lazy-load that needs a greenlet and
        # raises ``MissingGreenlet`` outside of one, so the values this loop
        # needs to *read* are pinned to plain locals instead.
        targets = [(project, project.id, project.quote_id or "", project.client_id or "") for project in projects]
        for project, project_id, quote_id, client_id in targets:
            try:
                invoices = await zoho_service.list_project_invoices(db, quote_id, client_id)
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
                logger.warning("Invoice sweep skipped project %s: %s", project_id, exc)
                continue
            project.invoice_checked_at = _now()
            # T-027 (loop-9): commit this project's refresh on its own rather
            # than batching the whole pass into one commit at the end. A
            # failure on this specific commit (SQLite "database is locked",
            # for example) is now caught right here -- the transaction is
            # rolled back and only this one project is skipped, matching the
            # upstream/malformed-payload branch above; every project already
            # refreshed earlier in the same pass stays committed AND every
            # project still queued behind this one is still attempted.
            try:
                await db.commit()
            except SQLAlchemyError as exc:
                logger.warning("Invoice sweep could not commit project %s: %s", project_id, exc)
                try:
                    await db.rollback()
                except SQLAlchemyError:
                    # Best-effort: the rollback itself failing (a closed
                    # connection, say) shouldn't stop the sweep from moving
                    # on to the next project either.
                    pass
                continue
            updated += 1
    except ZohoRateLimited:
        # T-031: the 429 path alone does not spend the hourly slot -- see
        # the function docstring.
        raise
    except Exception:
        # T-031: any other exception escaping the pass (out of the SELECT,
        # say) still spends the hourly slot before propagating -- a
        # per-project failure no longer needs this fallback (T-027 already
        # recovers from it in the loop), but an unexpected error deserves
        # the same treatment as a normal completed pass.
        _last_run = time.monotonic()
        raise
    else:
        _last_run = time.monotonic()
    return updated
