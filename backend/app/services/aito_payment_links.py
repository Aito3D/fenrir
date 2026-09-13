# backend/app/services/aito_payment_links.py
"""Payment links for Aito quotes, minted through Heimdall.

Spec: docs/superpowers/specs/2026-09-12-aito-heimdall-payment-links-design.md.
This module starts with the money rule; the reconcile loop follows.
"""

import logging
import math
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_payment_link import AitoPaymentLink
from backend.app.models.aito_project import AitoProject
from backend.app.services.aito_events import record
from backend.app.services.heimdall import (
    HeimdallConflict,
    HeimdallRateLimited,
    HeimdallUpstreamError,
    LinkView,
    heimdall_service,
)

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


MAX_POLLS_PER_TICK = 40
# One tick of the quote-sync loop; the per-row backoff counts in these.
_TICK_SECONDS = 300
_MAX_BACKOFF_TICKS = 6
_FINAL_STATUSES = frozenset({"paid", "failed", "cancelled", "expired"})
_DEAD_STATUSES = frozenset({"failed", "cancelled", "expired"})
_CLOSED_QUOTE_STATUSES = frozenset({"declined", "expired"})
# time.monotonic() until which the whole reconciler stands down after a 429.
_throttled_until: float | None = None


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
    amount = required_amount(project.quote_total, pct)
    if amount is None:
        return None
    if (project.retainer_paid_total or 0) >= amount:
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


def _fields_match(row: AitoPaymentLink, wanted: Wanted) -> bool:
    return row.amount == wanted.amount and row.expires_on == wanted.expires_on


def _adopt(row: AitoPaymentLink, view: LinkView, now: datetime) -> None:
    row.heimdall_id = view.id
    row.status = view.status
    row.amount = view.amount
    if view.url:
        row.url = view.url
    row.checked_at = now
    row.sync_error = None
    row.sync_failures = 0


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


async def _create(
    db: AsyncSession, project: AitoProject, wanted: Wanted, *, today: date, now: datetime, kind: str
) -> None:
    """Reserve, commit, POST, complete. A crash between the two commits
    leaves a reservation the next pass re-POSTs under the same key."""
    row = AitoPaymentLink(
        project_id=project.id,
        idempotency_key=await _next_key(db, project.id),
        reference=wanted.reference,
        amount=wanted.amount,
        expires_on=wanted.expires_on,
    )
    db.add(row)
    await db.commit()
    await _complete(db, project, row, today=today, now=now, kind=kind)


async def _complete(
    db: AsyncSession, project: AitoProject, row: AitoPaymentLink, *, today: date, now: datetime, kind: str
) -> None:
    view = await heimdall_service.create_link(
        db,
        idempotency_key=row.idempotency_key,
        reference=row.reference,
        amount=row.amount,
        expires_in_days=expires_in_days(row.expires_on, today),
    )
    _adopt(row, view, now)
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
        },
    )
    await db.commit()


async def _cancel(db: AsyncSession, project: AitoProject, row: AitoPaymentLink, *, now: datetime, reason: str) -> None:
    try:
        view = await heimdall_service.cancel_link(db, row.heimdall_id)
        _adopt(row, view, now)
    except HeimdallConflict:
        # Already settled at OSB (paid/expired meanwhile): read the truth.
        view = await heimdall_service.get_payment(db, row.heimdall_id)
        _adopt(row, view, now)
        if row.status == "paid":
            return  # money wins; the poll path records/accepts it
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


def _cancel_reason(project: AitoProject, amount: int | None) -> str:
    if project.status != "active":
        return "trashed"
    if project.quote_status in _CLOSED_QUOTE_STATUSES:
        return str(project.quote_status)
    if project.quote_invoiced:
        return "invoiced"
    if amount is not None and (project.retainer_paid_total or 0) >= amount:
        return "retainer"
    return "nothing_to_pay"


async def reconcile_project(
    db: AsyncSession, project: AitoProject, *, pct: int, validity_days: int, today: date, now: datetime
) -> None:
    """Spec §5.4, one project. Commits its own work; a Heimdall failure is
    stored on the row and never raises past here — except a 429, which the
    pass handler turns into a throttle."""
    # Captured now: a rollback below can expire `project` (whenever the
    # failure hits before any intervening commit re-closed the transaction),
    # and a bare attribute access on an expired ORM object outside of an
    # awaited session call needs SQLAlchemy's async-to-sync greenlet bridge,
    # which is not active here — it would raise MissingGreenlet instead of
    # reloading.
    project_id = project.id
    wanted = wanted_link(project, pct=pct, validity_days=validity_days, today=today)
    row = await current_link(db, project_id)
    if row is not None and _in_backoff(row, now):
        return
    try:
        if row is None:
            if wanted is not None:
                await _create(db, project, wanted, today=today, now=now, kind="payment_link.created")
            return
        if row.heimdall_id is None:
            # A reservation: always complete it under its own key first.
            await _complete(db, project, row, today=today, now=now, kind="payment_link.created")
            return
        if row.status == "paid":
            return
        if row.status in _DEAD_STATUSES:
            if wanted is not None:
                row.superseded_at = now
                await db.commit()
                await _create(db, project, wanted, today=today, now=now, kind="payment_link.replaced")
            return
        # pending
        if wanted is None:
            await _cancel(
                db, project, row, now=now, reason=_cancel_reason(project, required_amount(project.quote_total, pct))
            )
            return
        if row.reference != wanted.reference:
            await _cancel(db, project, row, now=now, reason="renumbered")
            if row.status == "paid":
                return
            row.superseded_at = now
            await db.commit()
            await _create(db, project, wanted, today=today, now=now, kind="payment_link.replaced")
            return
        if not _fields_match(row, wanted):
            try:
                view = await heimdall_service.patch_link(
                    db,
                    row.heimdall_id,
                    amount=wanted.amount if row.amount != wanted.amount else None,
                    expires_in_days=expires_in_days(wanted.expires_on, today)
                    if row.expires_on != wanted.expires_on
                    else None,
                )
                _adopt(row, view, now)
                row.expires_on = wanted.expires_on
            except HeimdallConflict:
                # The link left `pending` under us: adopt the truth, next
                # pass takes the paid/dead branch above.
                _adopt(row, await heimdall_service.get_payment(db, row.heimdall_id), now)
            await db.commit()
    except HeimdallRateLimited:
        raise
    except (HeimdallUpstreamError, SQLAlchemyError) as exc:
        logger.warning("payment link reconcile failed for project %s: %s", project_id, exc)
        await db.rollback()
        # A real rollback (one where a transaction was genuinely open —
        # e.g. the top-of-function `current_link` SELECT autobegan one and
        # nothing committed since) expires every ORM object the session
        # tracks, `project` included. The caller keeps its own reference to
        # `project` past this call, so leave it valid rather than expired —
        # a bare attribute access on an expired async-ORM object outside an
        # awaited session call raises MissingGreenlet instead of reloading.
        await db.refresh(project)
        row = await current_link(db, project_id)
        if row is not None:
            _fail(row, exc, now)
            await db.commit()


async def poll_link(db: AsyncSession, row: AitoPaymentLink, *, now: datetime) -> None:
    """One GET for a pending link. Spec §5.5. `paid` accepts the quote."""
    from backend.app.services.aito_quote_status import accept_quote

    project_id = row.project_id
    try:
        view = await heimdall_service.get_payment(db, row.heimdall_id)
    except HeimdallRateLimited:
        raise
    except HeimdallUpstreamError as exc:
        _fail(row, exc, now)
        await db.commit()
        return
    was = row.status
    _adopt(row, view, now)
    if row.status == "paid" and was != "paid":
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
        project = await db.get(AitoProject, project_id)
        if project is not None and project.status == "active":
            await accept_quote(
                db, project, source="payment_link", detail={"amount": row.amount, "reference": row.reference}
            )
        return
    await db.commit()


async def reconcile_payment_links(
    db: AsyncSession,
    *,
    only_project_id: int | None = None,
    create_only: bool = False,
    now: datetime | None = None,
    today: date | None = None,
) -> int:
    """One pass: reconcile every quoted project, then poll pending links.
    Returns the number of projects visited. Silent no-op when Heimdall is not
    configured or the 429 throttle is armed."""
    global _throttled_until
    if not await heimdall_service.is_configured(db):
        return 0
    if _throttled_until is not None and time.monotonic() < _throttled_until:
        return 0
    now = now or _now()
    today = today or now.date()
    from backend.app.services.aito_quote_sync import quote_validity_days

    pct = await deposit_pct(db)
    validity = await quote_validity_days(db)
    stmt = select(AitoProject).where(AitoProject.quote_number.is_not(None), AitoProject.quote_sync_state != "unmanaged")
    if only_project_id is not None:
        stmt = stmt.where(AitoProject.id == only_project_id)
    projects = list((await db.execute(stmt.order_by(AitoProject.id))).scalars().all())
    if create_only:
        have = await current_links(db, [p.id for p in projects])
        projects = [p for p in projects if p.id not in have]
    visited = 0
    try:
        for project in projects:
            visited += 1
            await reconcile_project(db, project, pct=pct, validity_days=validity, today=today, now=now)
        if not create_only:
            _throttled_until = None
            pending = (
                select(AitoPaymentLink)
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
            for row in list((await db.execute(pending)).scalars().all()):
                if _in_backoff(row, now):
                    continue
                await poll_link(db, row, now=now)
    except HeimdallRateLimited as exc:
        logger.warning("Heimdall rate limit: standing down for %s s", exc.retry_after)
        await db.rollback()
        _arm_throttle(exc.retry_after)
    return visited
