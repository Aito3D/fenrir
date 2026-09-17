# backend/app/services/aito_payment_links.py
"""Payment links for Aito quotes, minted through Heimdall.

Spec: docs/superpowers/specs/2026-09-12-aito-heimdall-payment-links-design.md.
This module starts with the money rule; the reconcile loop follows.
"""

import asyncio
import logging
import math
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_payment_link import AitoPaymentLink
from backend.app.models.aito_project import AitoProject
from backend.app.services.aito_events import record
from backend.app.services.heimdall import (
    HeimdallConflict,
    HeimdallNotFound,
    HeimdallRateLimited,
    HeimdallUpstreamError,
    LinkView,
    heimdall_service,
)

if TYPE_CHECKING:  # the runtime import stays function-level (import cycle)
    from backend.app.schemas.aito import AitoPaymentLinkView

logger = logging.getLogger(__name__)


async def deposit_pct(db: AsyncSession) -> int:
    """`aito_deposit_pct`: 0 = the link asks for the full total."""
    from backend.app.api.routes.settings import get_setting

    raw = await get_setting(db, "aito_deposit_pct")
    try:
        return max(0, min(100, int(raw))) if raw else 0
    except ValueError:
        return 0


def required_amount(quote_total: float | None, pct: int) -> int | None:
    """What the client must pay online for the quote to count as accepted —
    the ONE function the link amount, the retainer rule and the panel
    warning all read. Integer XPF: the full total rounded, or the deposit
    share rounded UP so a deposit is never a franc short. None when there
    is nothing to pay (no total yet, or a zero total)."""
    if quote_total is None or quote_total <= 0:
        return None
    if pct <= 0:
        return int(round(quote_total))
    return int(math.ceil(quote_total * pct / 100))


def outstanding_amount(required: int, retainer_paid_total: float | None) -> int:
    """What is still owed once the estimate's PAID retainer invoices are
    netted off ``required`` — the link asks for this, not the gross figure.
    Rounded UP so a fractional retainer never leaves the client a franc
    short; zero or negative means the retainers cover it."""
    return int(math.ceil(required - (retainer_paid_total or 0)))


MAX_POLLS_PER_TICK = 40
# One tick of the quote-sync loop; the per-row backoff counts in these.
_TICK_SECONDS = 300
_MAX_BACKOFF_TICKS = 6
_DEAD_STATUSES = frozenset({"failed", "cancelled", "expired"})
_CLOSED_QUOTE_STATUSES = frozenset({"declined", "expired"})
# time.monotonic() until which the whole reconciler stands down after a 429.
_throttled_until: float | None = None
# One pass at a time. The loop's tick and the panel's Retry
# (routes/aito.py:refresh_payment_link) can reach the same quote in the same
# instant; two passes that both read "no row yet" would both reserve and both
# POST, and the loser's reservation dies on the unique idempotency key while
# a stray live link sits at OSB. Single-process app, so a lock is the whole
# fix — no partial unique index, no migration.
_pass_lock = asyncio.Lock()


def _arm_throttle(retry_after: float | None) -> None:
    global _throttled_until
    _throttled_until = time.monotonic() + (retry_after if retry_after and retry_after > 0 else 60.0)


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


@dataclass(frozen=True)
class Wanted:
    reference: str
    amount: int
    expires_on: str


def wanted_link(project: AitoProject, *, pct: int, validity_days: int, today: date) -> Wanted | None:
    """The link this project should have right now, or None for "no live
    link": trashed, decided the other way, invoiced, already covered by paid
    retainers, or nothing to pay. Spec §5.3."""
    if project.status != "active" or not project.quote_number:
        return None
    if project.quote_status in _CLOSED_QUOTE_STATUSES or project.quote_invoiced:
        return None
    required = required_amount(project.quote_total, pct)
    if required is None:
        return None
    amount = outstanding_amount(required, project.retainer_paid_total)
    if amount <= 0:
        return None
    expires_on = project.quote_expiry_date or (today + timedelta(days=validity_days)).isoformat()
    return Wanted(reference=project.quote_number, amount=amount, expires_on=expires_on)


def expires_in_days(expires_on: str, today: date) -> int:
    """Heimdall takes a day count (1–365), never a date; a quote expiring
    today still gets a one-day link."""
    try:
        days = (date.fromisoformat(expires_on) - today).days
    except ValueError:
        days = 1
    return max(1, min(365, days))


def _confirmed_expiry(view: LinkView, fallback: str) -> str:
    """The calendar day (UTC) `view.expires_at` confirms the link actually
    closes on, or `fallback` when Heimdall omitted the field or returned
    something this cannot parse.

    Heimdall closes a link at 23:59:59.999 UTC on `expires_at`'s day (see
    the `expires_on` comment in models/aito_payment_link.py), so the UTC
    calendar date is taken verbatim — never shifted to a local zone, which
    would move the boundary by hours depending on where this process
    happens to run. `expires_on` is `String(10) NOT NULL`, and this feeds
    the reconciler's own drift comparison (`_fields_match`), so a missing
    or malformed value must never raise or produce something unparseable:
    falling back to `fallback` (in practice, the day we asked Heimdall for)
    is the conservative choice — it reproduces exactly what `expires_on`
    held before this function existed, for the one case (an upstream that
    omitted an optional field) that isn't actually new information."""
    if not view.expires_at:
        return fallback
    try:
        parsed = datetime.fromisoformat(view.expires_at.replace("Z", "+00:00"))
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone(timezone.utc)
        return parsed.date().isoformat()
    except (ValueError, TypeError):
        return fallback


def _fields_match(row: AitoPaymentLink, wanted: Wanted, today: date) -> bool:
    """Does the row already satisfy `wanted`? `expires_on` is compared
    against what Heimdall would confirm for `wanted.expires_on` as of a
    REFERENCE day, not the raw quote date. `row.expires_on` stores
    Heimdall's CONFIRMED expiry (see `_adopt`/`_confirmed_expiry`), which
    `expires_in_days` clamps to 365 days out — a quote wanting more than
    that can never produce a row whose `expires_on` equals its raw date, so
    comparing raw dates would mismatch FOREVER and the drift branch below
    would re-PATCH such a link on every single pass. Comparing against the
    clamped target tolerates that: a link already sitting at Heimdall's
    ceiling reads as matching.

    The reference day is `row.checked_at`'s calendar day when the row has
    one (T-011's follow-on to T-012's own comment here), never the live
    `today` — that is what makes a clamped link stop being drift instead of
    merely slowing its rate. `today` alone would still move the ceiling
    forward by one day every day the quote stays clamped (`today + 365`),
    so a permanently-clamped link would keep re-mismatching, and re-PATCHing,
    about once per calendar day forever. `checked_at` is the day Heimdall
    last actually confirmed something for this row, so once a clamped link
    converges it is NOT touched again — `checked_at` stays put, the ceiling
    computed from it stays put, and the comparison keeps agreeing with
    itself indefinitely. A genuine change to `wanted.expires_on` is still
    caught immediately: it changes the raw date being clamped, not the
    reference day, so the recomputed target moves too UNLESS the change
    still resolves to the same ceiling (extending an already-maxed-out quote
    even further out) — and in that case there is truly nothing for
    Heimdall to do, so that is correctly not drift either. `checked_at` is
    only absent for a row nothing has adopted yet, which never reaches this
    comparison with a NULL value in practice (see `reconcile_project`); the
    fallback to `today` exists for the pure-function tests that build a
    detached row by hand."""
    if row.amount != wanted.amount:
        return False
    reference = row.checked_at.date() if row.checked_at is not None else today
    target = reference + timedelta(days=expires_in_days(wanted.expires_on, reference))
    return row.expires_on == target.isoformat()


def needs_action(row: AitoPaymentLink | None, wanted: Wanted | None, today: date) -> bool:
    """Would `reconcile_project` do anything for this pair? The §5.4 table
    read as a predicate, with no Heimdall call: the wake path uses it to
    visit only the projects whose link drifted from the quote (a total or
    expiry moved, a renumber, an invoicing, a link still owed) and leave
    the steady state alone."""
    if row is None:
        return wanted is not None
    if row.heimdall_id is None:
        return True  # a reservation is always completed
    if row.status == "paid":
        return False
    if row.status in _DEAD_STATUSES:
        return wanted is not None
    # pending
    return wanted is None or row.reference != wanted.reference or not _fields_match(row, wanted, today)


def _adopt(row: AitoPaymentLink, view: LinkView, now: datetime, *, expires_fallback: str | None = None) -> None:
    """`expires_on` becomes the calendar day Heimdall's `expires_at`
    confirms (`_confirmed_expiry`) — never the day we merely asked for
    (see T-012). Falls back to `expires_fallback` when given, else the
    row's own current value, when Heimdall omitted or garbled the field."""
    row.heimdall_id = view.id
    row.status = view.status
    row.amount = view.amount
    if view.url:
        row.url = view.url
    row.expires_on = _confirmed_expiry(view, expires_fallback if expires_fallback is not None else row.expires_on)
    row.checked_at = now
    row.sync_error = None
    row.sync_failures = 0


class PatchDidNotConverge(Exception):
    """T-011: Heimdall answered the PATCH with 2xx, but the view it returned
    still does not satisfy `wanted` once `_adopt` has recorded it (clamped
    server-side, a stale read, or the write simply not sticking). Never
    raised past `reconcile_project` — only ever fed to `_fail`, so the row
    gets the same backoff and visible `sync_error` as any other Heimdall
    failure, rather than looking healthy while re-sending an identical PATCH
    every single tick forever."""


def _fail(row: AitoPaymentLink, exc: Exception, now: datetime) -> None:
    """`checked_at` is the last Heimdall CONTACT (success or failure), not
    the last success: the backoff below counts from it. Stamped with the
    caller's `now`, never the DB's onupdate clock, so tests can drive it."""
    row.sync_error = str(exc)[:500]
    row.sync_failures = (row.sync_failures or 0) + 1
    row.checked_at = now


def _in_backoff(row: AitoPaymentLink, now: datetime) -> bool:
    if not row.sync_failures or row.checked_at is None:
        return False
    wait = timedelta(seconds=_TICK_SECONDS * min(row.sync_failures, _MAX_BACKOFF_TICKS))
    return now - row.checked_at < wait


async def current_link(db: AsyncSession, project_id: int) -> AitoPaymentLink | None:
    stmt = (
        select(AitoPaymentLink)
        .where(AitoPaymentLink.project_id == project_id, AitoPaymentLink.superseded_at.is_(None))
        .order_by(AitoPaymentLink.id.desc())
        .limit(1)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def current_links(db: AsyncSession, project_ids: list[int]) -> dict[int, AitoPaymentLink]:
    """One query for a whole board: the newest un-superseded row per project."""
    if not project_ids:
        return {}
    stmt = (
        select(AitoPaymentLink)
        .where(AitoPaymentLink.project_id.in_(project_ids), AitoPaymentLink.superseded_at.is_(None))
        .order_by(AitoPaymentLink.project_id, AitoPaymentLink.id.desc())
    )
    out: dict[int, AitoPaymentLink] = {}
    for row in (await db.execute(stmt)).scalars():
        out.setdefault(row.project_id, row)
    return out


async def _next_key(db: AsyncSession, project_id: int) -> str:
    count = (
        (await db.execute(select(AitoPaymentLink.id).where(AitoPaymentLink.project_id == project_id))).scalars().all()
    )
    return f"aito:{project_id}:{len(count) + 1}"


async def _became_paid(db: AsyncSession, row: AitoPaymentLink, *, now: datetime) -> None:
    """Everything a link's transition to `paid` triggers, wherever it was
    discovered — a poll, a cancel racing a payment (409), a patch racing one
    (409). `row.status` must already be `'paid'` (the caller's `_adopt` set
    it) before this runs. Stamps `paid_at`, records the story event, commits,
    then accepts the quote if the project is still active."""
    project_id = row.project_id
    row.paid_at = now
    await record(
        db,
        project_id,
        "payment_link.paid",
        actor_class="system",
        subject_type="project",
        subject_id=project_id,
        detail={"reference": row.reference, "amount": row.amount, "heimdall_id": row.heimdall_id},
    )
    await db.commit()
    from backend.app.services.aito_quote_status import accept_quote

    project = await db.get(AitoProject, project_id)
    if project is not None and project.status == "active":
        await accept_quote(
            db, project, source="payment_link", detail={"amount": row.amount, "reference": row.reference}
        )


async def _create(
    db: AsyncSession,
    project: AitoProject,
    wanted: Wanted,
    *,
    now: datetime,
    kind: str,
    extra_detail: dict | None = None,
) -> None:
    """Reserve, commit, POST, complete. A crash between the two commits
    leaves a reservation the next pass re-POSTs under the same key.
    `created_at` is stamped explicitly (not left to the server default) so a
    retry days later still asks Heimdall for the SAME `expires_in_days` —
    see `_complete`."""
    row = AitoPaymentLink(
        project_id=project.id,
        idempotency_key=await _next_key(db, project.id),
        reference=wanted.reference,
        amount=wanted.amount,
        expires_on=wanted.expires_on,
        created_at=now,
    )
    db.add(row)
    await db.commit()
    await _complete(db, project, row, now=now, kind=kind, extra_detail=extra_detail)


async def _complete(
    db: AsyncSession,
    project: AitoProject,
    row: AitoPaymentLink,
    *,
    now: datetime,
    kind: str,
    extra_detail: dict | None = None,
    record_event: bool = True,
) -> None:
    """POST the reservation. `expires_in_days` is computed from the
    reservation's OWN day (`row.created_at`), never `today`: a retry of an
    unfinished reservation on a later day must send the exact same body
    under the same idempotency key, or Heimdall sees a changed body and
    answers 409 forever instead of replaying the first response.

    `record_event=False` lets a caller that is about to cancel this same
    reservation right back (the quote it was for has moved on since the POST
    was reserved) complete it WITHOUT telling the story it was ever offered
    to the client — only the `payment_link.cancelled`/`.replaced` that
    follows gets recorded."""
    view = await heimdall_service.create_link(
        db,
        idempotency_key=row.idempotency_key,
        reference=row.reference,
        amount=row.amount,
        expires_in_days=expires_in_days(row.expires_on, row.created_at.date()),
    )
    _adopt(row, view, now)
    if record_event:
        await record(
            db,
            project.id,
            kind,
            actor_class="system",
            subject_type="project",
            subject_id=project.id,
            detail={
                "reference": row.reference,
                "amount": row.amount,
                "expires_on": row.expires_on,
                "heimdall_id": row.heimdall_id,
                **(extra_detail or {}),
            },
        )
    await db.commit()


async def _cancel(
    db: AsyncSession,
    project: AitoProject,
    row: AitoPaymentLink,
    *,
    now: datetime,
    reason: str,
    record_event: bool = True,
) -> bool:
    """`record_event=False` lets a caller that already records its OWN event
    for this transition (a renumber, which records `payment_link.replaced`
    with `detail.reason` instead) suppress the `payment_link.cancelled` that
    would otherwise double up the story.

    Returns True when the link turned out to be PAID instead of cancellable —
    money wins over the cancel we were attempting. Callers must branch on
    this return value and never on `row.status` afterwards: the `_became_paid`
    below reaches `accept_quote`, whose best-effort Books push rolls the
    session back on failure and EXPIRES `row`, so a bare `row.status` read
    after this call can raise `MissingGreenlet`."""
    try:
        view = await heimdall_service.cancel_link(db, row.heimdall_id)
        _adopt(row, view, now)
    except HeimdallConflict:
        # Already settled at OSB (paid/expired meanwhile): read the truth.
        was = row.status
        _adopt(row, await heimdall_service.get_payment(db, row.heimdall_id), now)
        if row.status == "paid":
            if was != "paid":
                await _became_paid(db, row, now=now)  # commits (and may roll back)
            else:
                # Unreachable today (a paid row never reaches a cancel), but
                # `_adopt` has already dirtied the session: commit rather than
                # return with pending writes for someone else to trip over.
                await db.commit()
            return True  # money wins over the cancel we were attempting
    if record_event:
        await record(
            db,
            project.id,
            "payment_link.cancelled",
            actor_class="system",
            subject_type="project",
            subject_id=project.id,
            detail={"reference": row.reference, "reason": reason, "heimdall_id": row.heimdall_id},
        )
    await db.commit()
    return False


async def _record_failure(db: AsyncSession, project_id: int, exc: Exception, now: datetime) -> None:
    """Store a Heimdall failure on the project's current row (backoff and
    the panel read it). The caller has already rolled the session back."""
    row = await current_link(db, project_id)
    if row is not None:
        _fail(row, exc, now)
        await db.commit()


async def _replace_lost(
    db: AsyncSession,
    project_id: int,
    exc: HeimdallNotFound,
    *,
    now: datetime,
    pct: int,
    validity_days: int,
    today: date,
) -> None:
    """Heimdall answered 404 for an id this ledger holds: the link was
    deleted there, or Heimdall came back from a backup that predates it.
    Retrying the same id would fail forever, and the quote would sit without
    a live link. So: the row goes dead (`failed`, the 404 as its error, NO
    backoff — dead is not "try later"), and if the quote still wants a link
    a fresh one is minted right now, in the same pass, recorded as a
    replacement with `reason: "lost"`. Unwanted, it is just told once in the
    story as a cancellation for the same reason.

    The caller has rolled back; row and project are re-read here."""
    row = await current_link(db, project_id)
    project = await db.get(AitoProject, project_id)
    if row is None or project is None or row.heimdall_id is None:
        return
    if row.status == "paid" or row.status in _DEAD_STATUSES:
        return  # settled already; a poll never touched it, nothing to replace
    row.status = "failed"
    row.sync_error = str(exc)[:500]
    row.checked_at = now
    wanted = wanted_link(project, pct=pct, validity_days=validity_days, today=today)
    if wanted is None:
        await record(
            db,
            project_id,
            "payment_link.cancelled",
            actor_class="system",
            subject_type="project",
            subject_id=project_id,
            detail={"reference": row.reference, "reason": "lost", "heimdall_id": row.heimdall_id},
        )
        await db.commit()
        return
    row.superseded_at = now
    await db.commit()
    await _create(db, project, wanted, now=now, kind="payment_link.replaced", extra_detail={"reason": "lost"})


def _cancel_reason(project: AitoProject, amount: int | None) -> str:
    if project.status != "active":
        return "trashed"
    if project.quote_status in _CLOSED_QUOTE_STATUSES:
        return str(project.quote_status)
    if project.quote_invoiced:
        return "invoiced"
    if amount is not None and (project.retainer_paid_total or 0) >= amount:
        return "retainer"
    # Outside the spec's cancel vocabulary (declined/expired/invoiced/retainer/
    # trashed) on purpose: reached only when `required_amount` came back None,
    # i.e. the quote total dropped to zero or below and there is simply nothing
    # left to pay. The timeline renders the token raw; mapping tokens to
    # translated phrases is a phase-2 lead.
    return "nothing_to_pay"


async def reconcile_project(
    db: AsyncSession,
    project: AitoProject,
    *,
    pct: int,
    validity_days: int,
    today: date,
    now: datetime,
    force: bool = False,
) -> None:
    """Spec §5.4, one project. Commits its own work; a Heimdall failure is
    stored on the row and never raises past here — except a 429, which the
    pass handler turns into a throttle. The WHOLE body runs under one
    try/except, including the very first read off `project`: nothing is
    read before the try, so even a stale/expired `project` handed in by a
    caller (a bare attribute access raises `MissingGreenlet`, a
    `SQLAlchemyError` subclass) is caught and isolated like any other
    failure, rather than escaping and aborting the whole pass.

    `force=True` bypasses the per-row backoff. The loop never passes it; the
    panel's Retry (routes/aito.py:refresh_payment_link) always does, because
    Retry is only OFFERED while the row carries a sync_error — which is
    precisely when the row is inside its backoff window."""
    project_id: int | None = None
    try:
        project_id = project.id
        wanted = wanted_link(project, pct=pct, validity_days=validity_days, today=today)
        row = await current_link(db, project_id)
        if row is not None and not force and _in_backoff(row, now):
            return
        if row is None:
            if wanted is not None:
                await _create(db, project, wanted, now=now, kind="payment_link.created")
            return
        if row.heimdall_id is None:
            # A reservation: the POST it stands for may already have reached
            # Heimdall and only the commit that would have recorded
            # `heimdall_id` failed — that is the whole reason reservations
            # exist. So it is never abandoned outright. But it must not be
            # completed BLINDLY under its original terms either: if the
            # quote it was for has since been declined, invoiced or
            # trashed, `_complete` would mint (or reveal) a live, payable
            # link for a dead quote, if only for the instant before the
            # next tick cancels it. Re-check `wanted` against what this
            # reservation promised first.
            if wanted is not None and row.reference == wanted.reference and row.amount == wanted.amount:
                # Unchanged since the reservation was made: proceed exactly
                # as before.
                await _complete(db, project, row, now=now, kind="payment_link.created")
                return
            # Something moved on. Complete it anyway, under the SAME
            # idempotency key, so a POST that already succeeded is replayed
            # rather than a second link minted — but QUIETLY: the client was
            # never actually offered this link, so no `payment_link.created`
            # enters the story. Then cancel it immediately, in the same
            # pass, so there is no tick where a live link for a dead or
            # stale reservation is exposed to the panel.
            await _complete(db, project, row, now=now, kind="payment_link.created", record_event=False)
            if wanted is None:
                await _cancel(
                    db,
                    project,
                    row,
                    now=now,
                    reason=_cancel_reason(project, required_amount(project.quote_total, pct)),
                )
                return
            # Still owed, just not what this reservation promised (a
            # renumber or a repricing raced the crash that orphaned it):
            # cancel it and mint a fresh one under the current terms, same
            # as a renumber on an already-completed row.
            reason = "renumbered" if row.reference != wanted.reference else "repriced"
            if await _cancel(db, project, row, now=now, reason=reason, record_event=False):
                return  # the client paid the stale reservation; nothing to replace
            row.superseded_at = now
            await db.commit()
            await _create(db, project, wanted, now=now, kind="payment_link.replaced", extra_detail={"reason": reason})
            return
        if row.status == "paid":
            return
        if row.status in _DEAD_STATUSES:
            if wanted is not None:
                row.superseded_at = now
                await db.commit()
                await _create(db, project, wanted, now=now, kind="payment_link.replaced")
            return
        # pending
        if wanted is None:
            await _cancel(
                db, project, row, now=now, reason=_cancel_reason(project, required_amount(project.quote_total, pct))
            )
            return
        if row.reference != wanted.reference:
            # One event for a renumber (payment_link.replaced, reason
            # carried in its detail), not a cancelled/replaced pair.
            #
            # Branch on the RETURN value, never on `row.status`: the paid
            # branch inside `_cancel` reaches `accept_quote`, whose failed
            # Books push rolls the session back and expires `row` — a bare
            # re-read here would raise `MissingGreenlet`, be caught below, and
            # stamp sync_error/sync_failures on a row that had just turned
            # PAID (and is therefore never re-adopted, so the error would
            # stick forever).
            if await _cancel(db, project, row, now=now, reason="renumbered", record_event=False):
                return  # the client paid the old link; nothing to replace
            row.superseded_at = now
            await db.commit()
            await _create(
                db, project, wanted, now=now, kind="payment_link.replaced", extra_detail={"reason": "renumbered"}
            )
            return
        if not _fields_match(row, wanted, today):
            try:
                view = await heimdall_service.patch_link(
                    db,
                    row.heimdall_id,
                    amount=wanted.amount if row.amount != wanted.amount else None,
                    expires_in_days=expires_in_days(wanted.expires_on, today)
                    if row.expires_on != wanted.expires_on
                    else None,
                )
                # `_adopt` below unconditionally resets sync_failures/
                # sync_error to a clean bill of health — save what they were
                # BEFORE that, in case the patch turns out not to have
                # converged and they need restoring (T-011).
                prior_failures = row.sync_failures or 0
                prior_amount, prior_expires_on = row.amount, row.expires_on
                _adopt(row, view, now, expires_fallback=wanted.expires_on)
                if _fields_match(row, wanted, today):
                    # Converged: tell the story an amount or expiry change
                    # actually reached the client-facing link (T-011 — this
                    # used to be silent, e.g. `04-amount-drift`'s golden
                    # scenario, `events: []`, on the success path too).
                    await record(
                        db,
                        project.id,
                        "payment_link.updated",
                        actor_class="system",
                        subject_type="project",
                        subject_id=project.id,
                        detail={
                            "reference": row.reference,
                            "amount": row.amount,
                            "expires_on": row.expires_on,
                            "previous_amount": prior_amount,
                            "previous_expires_on": prior_expires_on,
                            "heimdall_id": row.heimdall_id,
                        },
                    )
                    await db.commit()
                else:
                    # Heimdall answered 2xx, but the view it confirmed still
                    # doesn't satisfy `wanted` (clamped server-side, a stale
                    # read, or the write simply didn't stick). Treating that
                    # 2xx as success — the old behavior — left the row
                    # looking perfectly healthy while re-sending the exact
                    # same PATCH every single tick forever, spending
                    # Heimdall's rate-limit budget for nothing. Restore the
                    # failure count `_adopt` just zeroed and fail properly:
                    # same backoff cap and visible `sync_error` as any other
                    # persistent Heimdall failure, offering the operator the
                    # panel's Retry instead of a silent, endless loop.
                    row.sync_failures = prior_failures
                    _fail(
                        row,
                        PatchDidNotConverge(
                            f"Heimdall did not apply the requested change: wanted amount={wanted.amount} "
                            f"expires_on={wanted.expires_on}, confirmed amount={row.amount} "
                            f"expires_on={row.expires_on}"
                        ),
                        now,
                    )
                    await db.commit()
            except HeimdallConflict:
                # The link left `pending` under us: adopt the truth. A
                # patch racing a payment is credited right now instead of
                # waiting for the next poll to notice.
                was = row.status
                _adopt(row, await heimdall_service.get_payment(db, row.heimdall_id), now)
                if row.status == "paid" and was != "paid":
                    await _became_paid(db, row, now=now)
                else:
                    await db.commit()
    except HeimdallRateLimited:
        raise
    except HeimdallNotFound as exc:
        # Before the generic branch (it is a subclass): a 404 is not a
        # transient failure to back off from, it is a link that no longer
        # exists. Replace it now — and treat a failure of the replacement
        # itself exactly like any other Heimdall failure.
        logger.warning("payment link for project %s is gone at Heimdall, replacing: %s", project_id, exc)
        await db.rollback()
        if project_id is None:
            return
        try:
            await _replace_lost(db, project_id, exc, now=now, pct=pct, validity_days=validity_days, today=today)
        except HeimdallRateLimited:
            raise
        except (HeimdallUpstreamError, SQLAlchemyError) as exc2:
            logger.warning("payment link replacement failed for project %s: %s", project_id, exc2)
            await db.rollback()
            await _record_failure(db, project_id, exc2, now)
    except (HeimdallUpstreamError, SQLAlchemyError) as exc:
        logger.warning("payment link reconcile failed for project %s: %s", project_id, exc)
        await db.rollback()
        if project_id is None:
            # The very first read off `project` was itself what failed (an
            # already-expired object handed in) — there is no id to look a
            # row up by, so there is nothing more to record.
            return
        await _record_failure(db, project_id, exc, now)


async def poll_link(db: AsyncSession, row: AitoPaymentLink, *, now: datetime) -> None:
    """One GET for a pending link. Spec §5.5. `paid` credits and accepts.
    A 404 propagates: the link is gone at Heimdall and the pass replaces it
    (`_replace_lost`) — that needs the pass's money settings, which a poll
    does not carry."""
    try:
        view = await heimdall_service.get_payment(db, row.heimdall_id)
    except (HeimdallRateLimited, HeimdallNotFound):
        raise
    except HeimdallUpstreamError as exc:
        _fail(row, exc, now)
        await db.commit()
        return
    was = row.status
    _adopt(row, view, now)
    if row.status == "paid" and was != "paid":
        await _became_paid(db, row, now=now)
        return
    await db.commit()


async def reconcile_payment_links(
    db: AsyncSession,
    *,
    only_project_id: int | None = None,
    changes_only: bool = False,
    now: datetime | None = None,
    today: date | None = None,
    force: bool = False,
) -> int:
    """One pass: reconcile every quoted project, then poll pending links.
    Returns the number of projects visited. Silent no-op when Heimdall is not
    configured or the 429 throttle is armed.

    `force=True` bypasses the per-row backoff in BOTH halves (reconcile and
    poll) — the panel's Retry, which is only offered on a row that IS backed
    off. The loop never sets it.

    `changes_only=True` is the wake path (the drain right after a quote was
    created or pushed): it visits only the projects `needs_action` flags —
    a link still owed, or one whose amount, expiry or reference no longer
    matches the quote Books just confirmed — and skips the poll half, so a
    wake spends nothing of the polling budget. A changed total reaches
    Heimdall within seconds of the push instead of at the next full tick.

    Ids are materialised up front and each row/project is re-fetched with
    `db.get()` INSIDE its own loop iteration, never held onto across
    iterations: a rollback anywhere in this pass (a Heimdall failure, a
    Books push failure inside `accept_quote`, an unexpected DB error)
    expires every ORM object the session is tracking, not just the one the
    failure was about. Holding a list of already-loaded objects across
    iterations would turn iteration N's failure into a bare-attribute
    `MissingGreenlet` on iteration N+1; re-fetching by id avoids it.
    """
    if not await heimdall_service.is_configured(db):
        return 0
    if _throttled_until is not None and time.monotonic() < _throttled_until:
        return 0
    async with _pass_lock:
        # Re-checked under the lock: the pass we just waited for may have
        # hit the 429 that arms this.
        if _throttled_until is not None and time.monotonic() < _throttled_until:
            return 0
        return await _run_pass(
            db, only_project_id=only_project_id, changes_only=changes_only, now=now, today=today, force=force
        )


async def _run_pass(
    db: AsyncSession,
    *,
    only_project_id: int | None,
    changes_only: bool,
    now: datetime | None,
    today: date | None,
    force: bool,
) -> int:
    """The body of `reconcile_payment_links`, run under `_pass_lock`."""
    global _throttled_until
    now = now or _now()
    today = today or now.date()
    from backend.app.services.aito_quote_sync import quote_validity_days

    pct = await deposit_pct(db)
    validity = await quote_validity_days(db)
    stmt = select(AitoProject.id).where(
        AitoProject.quote_number.is_not(None), AitoProject.quote_sync_state != "unmanaged"
    )
    if only_project_id is not None:
        stmt = stmt.where(AitoProject.id == only_project_id)
    project_ids = list((await db.execute(stmt.order_by(AitoProject.id))).scalars().all())
    if changes_only:
        have = await current_links(db, project_ids)
        projects = (await db.execute(select(AitoProject).where(AitoProject.id.in_(project_ids)))).scalars()
        drifted = {
            p.id
            for p in projects
            if needs_action(have.get(p.id), wanted_link(p, pct=pct, validity_days=validity, today=today), today)
        }
        project_ids = [pid for pid in project_ids if pid in drifted]
    visited = 0
    try:
        for pid in project_ids:
            # The `db.get` is INSIDE the try: a previous iteration's rollback
            # can leave the session in a state where even the fetch raises,
            # and a fetch error must isolate to its own item rather than
            # abort the whole pass.
            try:
                project = await db.get(AitoProject, pid)
                if project is None:
                    continue
                visited += 1
                await reconcile_project(db, project, pct=pct, validity_days=validity, today=today, now=now, force=force)
            except SQLAlchemyError as exc:
                logger.warning("payment link reconcile: project %s failed unexpectedly: %s", pid, exc)
                await db.rollback()
        if not changes_only:
            _throttled_until = None
            pending = (
                select(AitoPaymentLink.id)
                .where(
                    AitoPaymentLink.status == "pending",
                    AitoPaymentLink.superseded_at.is_(None),
                    AitoPaymentLink.heimdall_id.is_not(None),
                )
                .order_by(AitoPaymentLink.checked_at.asc().nulls_first(), AitoPaymentLink.id)
                .limit(MAX_POLLS_PER_TICK)
            )
            if only_project_id is not None:
                pending = pending.where(AitoPaymentLink.project_id == only_project_id)
            pending_ids = list((await db.execute(pending)).scalars().all())
            for rid in pending_ids:
                project_id: int | None = None
                try:
                    row = await db.get(AitoPaymentLink, rid)
                    if row is None or (not force and _in_backoff(row, now)):
                        continue
                    project_id = row.project_id
                    await poll_link(db, row, now=now)
                except HeimdallNotFound as exc:
                    # The poll is the only thing that notices a lost link
                    # in the steady state (no drift, so the reconcile half
                    # had nothing to send). Replace it in this same pass.
                    logger.warning("payment link row %s is gone at Heimdall, replacing: %s", rid, exc)
                    await db.rollback()
                    if project_id is None:
                        continue
                    try:
                        await _replace_lost(db, project_id, exc, now=now, pct=pct, validity_days=validity, today=today)
                    except HeimdallRateLimited:
                        raise
                    except (HeimdallUpstreamError, SQLAlchemyError) as exc2:
                        logger.warning("payment link replacement failed for project %s: %s", project_id, exc2)
                        await db.rollback()
                        await _record_failure(db, project_id, exc2, now)
                except SQLAlchemyError as exc:
                    logger.warning("payment link poll: row %s failed unexpectedly: %s", rid, exc)
                    await db.rollback()
    except HeimdallRateLimited as exc:
        logger.warning("Heimdall rate limit: standing down for %s s", exc.retry_after)
        await db.rollback()
        _arm_throttle(exc.retry_after)
    return visited


def link_view(row: AitoPaymentLink | None) -> "AitoPaymentLinkView | None":
    """The API shape of a ledger row; None only for no row at all.

    A reservation (`heimdall_id` still NULL — the create either never
    reached Heimdall or its reply never got recorded) is NOT hidden: its
    `url` is naturally None (never set while `heimdall_id` is None), so the
    panel's own "is this payable" test (state pending/paid AND a url) already
    keeps it from ever rendering Open/Copy buttons or being mistaken for a
    live link. What DOES cross is `sync_error` — the one thing a reservation
    stuck retrying a permanent Heimdall refusal needs to surface, since that
    is otherwise invisible anywhere a human looks (see T-010)."""
    from backend.app.schemas.aito import AitoPaymentLinkView

    if row is None:
        return None
    return AitoPaymentLinkView(
        state=row.status if row.status in ("pending", "paid", "failed", "cancelled", "expired") else "pending",
        amount=row.amount,
        currency=row.currency or "XPF",
        url=row.url,
        expires_on=row.expires_on,
        paid_at=row.paid_at,
        sync_error=row.sync_error,
        minted=row.heimdall_id is not None,
    )
