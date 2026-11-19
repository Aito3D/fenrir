"""Hourly read of each open invoice's status, balance and due date.

Cost-shaped for the Books quota the quote poller already protects: one call
per project that is invoiced AND still owes money, never one per board card,
and a project drops out of the selection for good once its balance reads 0.
The steady-state cost is therefore one call per hour per open receivable.

Mostly reads. No timeline event is recorded for the look itself — an hourly
"looked at the invoice" row would drown the story. The one write is
``settle_with_deposits``: an invoice still owing money gets the quote's own
unused retainer payments applied to it (an invoice raised by hand in Books,
or before its deposit was paid online, otherwise sits overdue while the
customer's money sits unused), and THAT is recorded, once per deposit spent.
A malformed payload from Books (a non-numeric balance, a missing key) skips
that one project the same way an upstream error does — it costs a project,
not the whole pass.

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
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import date, timedelta

from sqlalchemy import or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.models.notification_inbox import UserInboxPreference
from backend.app.services import aito_events
from backend.app.services.aito_events import utc_now_naive as _now
from backend.app.services.aito_invoice_cache import invoice_total_of
from backend.app.services.aito_invoice_create import (
    RetainerApplication,
    RetainerCredit,
    apply_retainers,
    customer_credits,
    share_out,
)
from backend.app.services.aito_search import remember_document_numbers
from backend.app.services.inbox import broadcast_pending, purge_old
from backend.app.services.zoho import ZohoNotConfiguredError, ZohoRateLimited, ZohoUpstreamError, zoho_service

logger = logging.getLogger(__name__)

_SWEEP_INTERVAL_SECONDS = 3600
# time.monotonic() of the last pass that ran; 0.0 = never. Module state so
# the loop's 300 s ticks can call sweep_invoices() unconditionally.
_last_run: float = 0.0
# The same, for sweep_inbox's own hourly gate.
_last_inbox_run: float = 0.0


def _same_reference(reference: str, quote_number: str | None) -> bool:
    return bool(quote_number) and reference.strip().casefold() == str(quote_number).strip().casefold()


def linked_credits(
    estimate: dict, credits: list[RetainerCredit], quote_number: str | None = None
) -> list[RetainerCredit]:
    """The deposits that belong to THIS quote and still have something to spend.

    A customer's account can hold advances from other jobs — a retainer raised
    from another estimate, or one raised by hand with no estimate at all. The
    sweep spends none of those: only money unambiguously this project's is
    applied, and anything else is the operator's call in Books (or the
    Create-invoice dialog, which shows them all). Two signals count:

    - the estimate lists the retainer in ``retainerinvoices`` (raised from
      the quote in Books);
    - the retainer's ``reference_number`` IS the quote number. Heimdall books
      every paid online link as a retainer referenced this way and never
      attaches it to the estimate (live DEV26-2684 / RET26-00295, 2026-09-19:
      empty ``retainerinvoices``, reference "DEV26-2684"), so without this
      rule an invoice raised before the link was paid sat overdue forever
      while the money sat unused. An operator typing the quote number as a
      hand-raised retainer's reference means the same thing.

    A plain advance with no retainer behind it has no reference to match and
    is never spent here, whatever its description says.
    """
    linked = {str(r.get("retainerinvoice_id") or "") for r in estimate.get("retainerinvoices") or []}
    linked.discard("")
    return [c for c in credits if c.applicable > 0 and (c.id in linked or _same_reference(c.reference, quote_number))]


@dataclass
class DepositSettlement:
    """What ``settle_deposits`` did. ``refused`` names the linked deposits
    that had a share to spend and that Books refused (``unknown`` lists the outcome-unknown ones) — ``apply_retainers``
    swallows those failures, so without this the caller cannot tell "nothing
    to apply" from "Books said no"."""

    invoice: dict
    remaining: float | None
    refused: list[str] = field(default_factory=list)
    # Deposits whose apply timed out (timeout/5xx): the money may have moved.
    unknown: list[str] = field(default_factory=list)


async def settle_with_deposits(
    db: AsyncSession, project_id: int, quote_id: str, invoice: dict, quote_number: str | None = None
) -> tuple[dict, float | None]:
    """Spend the quote's own unused deposits on its open invoice.

    Returns the invoice to cache (re-read from Books when something was
    applied, so the card flips to paid in this pass rather than an hour
    later) and the customer's remaining credit, or ``None`` when Books could
    not say. Best-effort throughout: a failed read or application leaves the
    invoice as it was found and the row still gets its refresh. Only a 429
    escapes, so the caller can arm the shared throttle exactly as it does for
    the invoice read itself.

    Idempotent by construction — an applied payment's ``unused_amount`` drops
    to zero in Books, so the next pass finds nothing left to spend.
    """
    settlement = await settle_deposits(db, project_id, quote_id, invoice, quote_number)
    return settlement.invoice, settlement.remaining


async def record_deposit_application(
    db: AsyncSession,
    project_id: int,
    invoice: dict,
    application: RetainerApplication,
    actor_class: str = "system",
    actor_name: str | None = None,
) -> None:
    """The ``invoice.deposit_applied`` event for one application (system actor by default)."""
    detail = {
        "retainer_number": application.number,
        "invoice_number": str(invoice.get("number") or ""),
        "amount": round(application.applied or application.unknown_amount, 2),
    }
    if application.unknown_amount:
        detail["outcome"] = "unknown"
    await aito_events.record(
        db,
        project_id,
        "invoice.deposit_applied",
        actor_class=actor_class,
        actor_name=actor_name,
        subject_type="project",
        subject_id=project_id,
        detail=detail,
    )


async def record_deposit_refusal(
    db: AsyncSession,
    project_id: int,
    invoice: dict,
    application: RetainerApplication,
    actor_class: str = "system",
    actor_name: str | None = None,
) -> None:
    """One ``invoice.deposit_refused`` per retainer+invoice: the hourly sweep retries a refused deposit, so an
    existing entry for the pair means it is already on the timeline."""
    detail = {"retainer_number": application.number, "invoice_number": str(invoice.get("number") or "")}
    earlier = (
        await db.execute(
            select(AitoEvent.detail).where(
                AitoEvent.project_id == project_id, AitoEvent.kind == "invoice.deposit_refused"
            )
        )
    ).scalars()
    if any(d == detail for d in earlier):
        return
    await aito_events.record(
        db,
        project_id,
        "invoice.deposit_refused",
        actor_class=actor_class,
        actor_name=actor_name,
        subject_type="project",
        subject_id=project_id,
        detail=detail,
    )


async def settle_deposits(
    db: AsyncSession, project_id: int, quote_id: str, invoice: dict, quote_number: str | None = None
) -> DepositSettlement:
    """``settle_with_deposits`` with the refusals kept (see DepositSettlement)."""
    try:
        estimate = await zoho_service.get_estimate(db, quote_id)
        credits = await customer_credits(db, estimate)
    except ZohoRateLimited:
        raise
    except (ZohoNotConfiguredError, ZohoUpstreamError, ValueError, TypeError, KeyError) as exc:
        logger.warning("Invoice sweep could not read deposits for project %s: %s", project_id, exc)
        return DepositSettlement(invoice, None)

    remaining = sum(c.applicable for c in credits)
    to_apply = linked_credits(estimate, credits, quote_number)
    if not to_apply:
        return DepositSettlement(invoice, remaining)

    invoice_id = str(invoice.get("id") or "")
    balance = float(invoice.get("balance") or 0)
    # The same pure split apply_retainers makes, so a deposit that had a share
    # and came back with nothing applied is known to have been refused.
    shares = share_out(to_apply, balance)
    applications = await apply_retainers(db, invoice_id, balance, to_apply)
    # apply_retainers returns one application per share (strict). An outcome-unknown deposit
    # (timeout/5xx, the money may have moved) is not refused; a 429 raises below, so none is "not attempted" here.
    refused = [
        a.number
        for (_, payments), a in zip(shares, applications, strict=True)
        if payments and a.applied <= 0 and a.unknown_amount <= 0
    ]
    unknown = [a.number for a in applications if a.unknown_amount > 0]
    applied_total = 0.0
    for application in applications:
        # An answer lost on the way (timeout, 5xx) may still have moved the money: keep it on record,
        # marked unknown, like the manual route does.
        amount = application.applied or application.unknown_amount
        if amount <= 0:
            continue
        applied_total += application.applied
        await record_deposit_application(db, project_id, invoice, application)
    for application in applications:
        if application.outcome == "refused":
            await record_deposit_refusal(db, project_id, invoice, application)
    # What landed is recorded above; a 429 now escapes so the caller arms the shared throttle.
    for application in applications:
        if application.rate_limited is not None:
            raise application.rate_limited
    if applied_total <= 0:
        return DepositSettlement(invoice, remaining, refused, unknown)

    # Re-read BY ID, same rule as the create route: the list row in hand was
    # read before the deposits landed. Degrades to the stale row on failure
    # rather than losing the refresh — the next pass will read it right.
    try:
        fresh = await zoho_service.get_invoice(db, invoice_id)
    except ZohoRateLimited:
        raise
    except (ZohoNotConfiguredError, ZohoUpstreamError) as exc:
        logger.warning("Invoice sweep applied deposits to %s but could not re-read it: %s", invoice_id, exc)
        fresh = None
    return DepositSettlement(fresh or invoice, max(remaining - applied_total, 0.0), refused, unknown)


# The Aito columns where a promised date is moot: a delivered job is not late.
# Same set as the board's ordering (`_FINISHED_COLUMNS` in routes/aito.py)
# and the frontend's `isFinished`.
_FINISHED_COLUMNS: tuple[str, ...] = ("finish", "done")


_OVERDUE_BACKFILL_KEY = "aito_overdue_kind_backfilled"


async def _backfill_overdue_kind(db: AsyncSession) -> None:
    """Once: switch ``aito.overdue`` on (with sound) in inbox preferences saved
    while it was off by default, as order_board_events.backfill_alert_kinds
    does for its kinds. Never commits."""
    from backend.app.api.routes.settings import get_setting, set_setting  # the route module imports services

    if await get_setting(db, _OVERDUE_BACKFILL_KEY) == "1":
        return
    kind = "aito.overdue"
    for pref in (await db.execute(select(UserInboxPreference))).scalars():
        if kind not in (pref.kinds_json or []):
            pref.kinds_json = [*(pref.kinds_json or []), kind]  # new list: JSON column change tracking
            if pref.sound_kinds_json and kind not in pref.sound_kinds_json:  # empty = bell muted: keep it silent
                pref.sound_kinds_json = [*pref.sound_kinds_json, kind]
    await set_setting(db, _OVERDUE_BACKFILL_KEY, "1")


async def _record_overdue(db: AsyncSession, today: date) -> int:
    """One ``project.due.overdue`` per open card per broken promise: once for
    each due date that passes, so moving the date later and missing it again
    alerts again. ``today`` is the server's calendar day, as the board's
    ``_today_iso`` reads it. Never commits."""
    already = (
        select(AitoEvent.id)
        .where(
            AitoEvent.project_id == AitoProject.id,
            AitoEvent.kind == "project.due.overdue",
            AitoEvent.detail["due_date"].as_string() == AitoProject.due_date,
        )
        .exists()
    )
    stmt = (
        select(AitoProject.id, AitoProject.due_date)
        .where(
            AitoProject.status == "active",
            AitoProject.due_date.is_not(None),
            AitoProject.due_date < today.isoformat(),
            AitoProject.board_column.not_in(_FINISHED_COLUMNS),
            ~already,
        )
        .order_by(AitoProject.id)
    )
    late = list((await db.execute(stmt)).all())
    for project_id, due_date in late:
        await aito_events.record(
            db, project_id, "project.due.overdue", actor_class="system", detail={"due_date": due_date}
        )
    return len(late)


async def sweep_inbox(db: AsyncSession, *, force: bool = False) -> None:
    """The hourly local step: overdue events, then the inbox retention purge.

    Its own step of the sync tick, not part of ``sweep_invoices``: neither
    half touches Books, so a Books outage (or a 429 window) must not stop
    either. Own hourly gate, spent on entry so a failing step is retried an
    hour later rather than every tick. Best effort -- a database failure is
    logged and rolled back; ``force`` bypasses the gate (tests)."""
    global _last_inbox_run
    if not force and _last_inbox_run and time.monotonic() - _last_inbox_run < _SWEEP_INTERVAL_SECONDS:
        return
    _last_inbox_run = time.monotonic()
    try:
        await _backfill_overdue_kind(db)
        overdue = await _record_overdue(db, date.today())
        purged = await purge_old(db, now=_now())
        await db.commit()
    except SQLAlchemyError as exc:
        logger.warning("Inbox sweep failed: %s", exc)
        try:
            await db.rollback()
        except SQLAlchemyError:
            pass
        return
    await broadcast_pending(db)
    if overdue or purged:
        logger.info("Inbox sweep: %d overdue card(s) recorded, %d inbox row(s) purged", overdue, purged)


async def _load_sweep_targets(
    db: AsyncSession, *, force: bool = False
) -> list[tuple[AitoProject, int, str, str, str | None]]:
    """The projects still owing money, least-recently-checked first, each with the
    plain locals the pass reads (see T-027 below)."""
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
    if not force:
        # A pass cut short at the call ceiling never stamps ``_last_run`` and is
        # back on the next tick: without this it re-read the same head of the
        # list every 300 s and never reached the end (prod, 2026-11-18).
        fresh_after = _now() - timedelta(seconds=_SWEEP_INTERVAL_SECONDS)
        stmt = stmt.where(or_(AitoProject.invoice_checked_at.is_(None), AitoProject.invoice_checked_at < fresh_after))
    projects = list((await db.execute(stmt)).scalars().all())
    # T-027: id/quote_id/client_id are captured up front, while every row
    # is still fresh, rather than re-read off `project` inside the loop.
    # A rollback below (recovering from a failed commit) expires every
    # object still held by the session, including projects further down
    # this same list -- re-reading a plain column off an expired ORM
    # object triggers an implicit lazy-load that needs a greenlet and
    # raises ``MissingGreenlet`` outside of one, so the values this loop
    # needs to *read* are pinned to plain locals instead.
    targets = [
        (project, project.id, project.quote_id or "", project.client_id or "", project.quote_number)
        for project in projects
    ]
    return targets


async def _refresh_cached_invoice(
    db: AsyncSession,
    project: AitoProject,
    project_id: int,
    quote_id: str,
    client_id: str,
    quote_number: str | None,
) -> None:
    """Read the project's newest invoice from Books and cache it on the row (or clear
    the cache when Books knows none). Raises whatever Books / parsing raise; the
    caller isolates the failure to this project."""
    # `remember_document_numbers` below READS the stored list.
    # Reload just that column first: a rollback for an earlier
    # project may have expired this row (a lazy-load would raise
    # MissingGreenlet), and another writer may have appended a
    # number since the pass began, which must not be overwritten.
    # It runs before anything is staged on the session, so its
    # SELECT never autoflushes this project's half-done writes.
    await db.refresh(project, attribute_names=["document_numbers"])
    invoices = await zoho_service.list_project_invoices(db, quote_id, client_id)
    if invoices:
        newest = invoices[0]
        credit: float | None = None
        if float(newest.get("balance") or 0) > 0:
            # Still owed: spend the quote's own unused deposits on
            # it first (a retainer paid online after the invoice
            # was raised in Books by hand, typically), and cache
            # whatever Books says the invoice is AFTER that.
            newest, credit = await settle_with_deposits(db, project_id, quote_id, newest, quote_number)
        # Parsed into locals before any assignment: a ValueError on
        # the balance must leave the row untouched, not half-written.
        status = newest.get("status") or None
        balance = float(newest.get("balance") or 0)
        total = invoice_total_of(newest)
        due = newest.get("due_date") or None
        project.invoice_status = status
        project.invoice_balance = balance
        project.invoice_total = total
        project.invoice_due_date = due
        remember_document_numbers(project, newest.get("number"))
        if credit is not None:
            # The status reconcile stops reading a locked (invoiced)
            # estimate, so this figure otherwise freezes the day
            # the invoice is raised. The payments list was in hand
            # anyway — zero extra calls.
            project.customer_credit_total = credit
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
        project.invoice_total = None
        project.invoice_due_date = None


async def _keep_what_landed(db: AsyncSession, project: AitoProject) -> None:
    """After a step raised: commit what it recorded (a settle can raise a 429
    on its re-read AFTER Books took the money and its events were recorded —
    no write to Books without its event), and leave the session usable for
    the steps after it. A session a failed commit poisoned is rolled back,
    and the project reloaded, since a rollback expires it."""
    if db.is_active:
        try:
            await db.commit()
            return
        except Exception as exc:  # noqa: BLE001 - fall through to the rollback
            logger.warning("Committing after a failed step on project %s failed: %s", project.id, exc)
    try:
        await db.rollback()
        await db.refresh(project)
    except Exception as exc:  # noqa: BLE001 - the later steps report their own failures
        logger.warning("Could not recover the session after a failed step: %s", exc)


async def sweep_invoices(
    db: AsyncSession,
    *,
    force: bool = False,
    serve_due_pushes: Callable[[AsyncSession], Awaitable[int]] | None = None,
    call_ceiling: int | None = None,
) -> int:
    """Refresh the cached invoice fields on every project still owing money.

    Returns the number of projects updated. ``force`` bypasses the hourly
    gate (tests, and a future manual refresh).

    T-006: a ``ZohoRateLimited`` (HTTP 429) is not treated like an ordinary
    upstream error — retrying the identical request will simply work once
    the window clears, so continuing to hit Books once per remaining project
    would only deepen the throttle, the same failure mode ``sync_project``'s
    own 429 handler exists to avoid. Every project already refreshed before
    the 429 was already committed on its own (T-010), so only what
    the project hit by the 429 staged is committed (T-683) before the exception propagates:
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
    its own.

    T-102 (loop-12): the loop passes ``serve_due_pushes`` (its own
    ``_serve_due_pushes``, handed in rather than imported to avoid the
    import cycle) and ``call_ceiling`` (``BACKGROUND_CALL_CEILING``). Before
    each project the due pushes are served, so a route waiting in
    ``flush_and_wait`` waits for at most one project's Books round trip,
    not the whole pass; then, once ``calls_in_last_minute()`` has reached
    the ceiling, the pass stops WITHOUT stamping ``_last_run``, leaving the
    rest of Books' per-minute budget to pushes. The least-recently-checked
    ordering above makes the next tick resume with the unreached tail.
    Either left ``None`` (the default), its step is skipped."""
    global _last_run
    if not force and _last_run and time.monotonic() - _last_run < _SWEEP_INTERVAL_SECONDS:
        return 0

    updated = 0
    try:
        targets = await _load_sweep_targets(db, force=force)
        cut_short = False
        for project, project_id, quote_id, client_id, quote_number in targets:
            if serve_due_pushes is not None:
                # Contains its own failures (logged, rolled back), like every
                # other caller's mid-pass serve. Runs between projects, after
                # the previous one's commit, so it never flushes a
                # half-written sweep row.
                await serve_due_pushes(db)
            if call_ceiling is not None and zoho_service.calls_in_last_minute() >= call_ceiling:
                cut_short = True
                break
            try:
                await _refresh_cached_invoice(db, project, project_id, quote_id, client_id, quote_number)
            except ZohoRateLimited:
                # T-006: stop here rather than spending one more request per
                # remaining project — everything refreshed so far this pass was
                # already committed per project below. Only what THIS project
                # staged before the 429 (a landed deposit's event) is kept
                # (T-683); the caller (run_sync_loop) arms the shared throttle.
                await _keep_what_landed(db, project)
                await broadcast_pending(db)
                raise
            except (ZohoUpstreamError, ValueError, TypeError, KeyError) as exc:
                logger.warning("Invoice sweep skipped project %s: %s", project_id, exc)
                continue
            except SQLAlchemyError as exc:
                # A database error inside the body (the reload above, or a
                # "database is locked" autoflush) costs only this project,
                # exactly like a failed commit below (T-027).
                logger.warning("Invoice sweep could not refresh project %s: %s", project_id, exc)
                try:
                    await db.rollback()
                except SQLAlchemyError:
                    pass
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
                await broadcast_pending(db)
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
        if not cut_short:
            _last_run = time.monotonic()
        else:
            logger.info("Invoice sweep paused at the Books call ceiling after %d project(s)", updated)
    return updated
