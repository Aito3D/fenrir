"""Card charges on the Heimdall terminal, started from a project card.

Query helpers and the API view live here; the reserve/create/settle/poll
machinery is added alongside (see spec §4)."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_terminal_payment import AitoTerminalPayment
from backend.app.services.aito_events import record
from backend.app.services.aito_payment_documents import PaymentDocument
from backend.app.services.heimdall import (
    HeimdallNotFound,
    HeimdallRateLimited,
    HeimdallUpstreamError,
    LinkView,
    heimdall_service,
)

logger = logging.getLogger(__name__)

OPEN_STATUSES = frozenset({"pending", "processing"})
BLOCKING_STATUSES = frozenset({"pending", "processing", "needs_attention"})
STATUSES = ("pending", "processing", "paid", "failed", "cancelled", "expired", "needs_attention")

REFRESH_MIN_SECONDS = 2.0
SETTLED_STATUSES = frozenset({"paid", "failed", "cancelled", "expired", "needs_attention"})


async def current_terminal_payment(db: AsyncSession, project_id: int) -> AitoTerminalPayment | None:
    stmt = (
        select(AitoTerminalPayment)
        .where(AitoTerminalPayment.project_id == project_id)
        .order_by(AitoTerminalPayment.id.desc())
        .limit(1)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def current_terminal_payments(db: AsyncSession, project_ids: list[int]) -> dict[int, AitoTerminalPayment]:
    if not project_ids:
        return {}
    stmt = (
        select(AitoTerminalPayment)
        .where(AitoTerminalPayment.project_id.in_(project_ids))
        .order_by(AitoTerminalPayment.project_id, AitoTerminalPayment.id.desc())
    )
    out: dict[int, AitoTerminalPayment] = {}
    for row in (await db.execute(stmt)).scalars():
        out.setdefault(row.project_id, row)
    return out


def terminal_view(row: AitoTerminalPayment | None):
    from backend.app.schemas.aito import AitoTerminalPaymentView

    if row is None:
        return None
    return AitoTerminalPaymentView(
        id=row.id,
        document_kind=row.document_kind,
        document_number=row.document_number,
        status=row.status if row.status in STATUSES else "pending",
        amount=row.amount,
        amount_confirmed=row.amount_confirmed,
        booking_status=row.booking_status
        if row.booking_status in ("pending", "booked", "failed", "not_booked")
        else None,
        booking_error=row.booking_error,
        sync_error=row.sync_error,
        created_at=row.created_at,
        settled_at=row.settled_at,
    )


class TerminalInProgress(Exception):
    """Another charge for this project is still open, or is waiting for a
    human to read the paper roll. One exchange at a time, by design."""


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


async def _blocking_row(db: AsyncSession, project_id: int) -> AitoTerminalPayment | None:
    stmt = select(AitoTerminalPayment).where(
        AitoTerminalPayment.project_id == project_id, AitoTerminalPayment.status.in_(BLOCKING_STATUSES)
    )
    return (await db.execute(stmt)).scalars().first()


async def _next_key(db: AsyncSession, project_id: int) -> str:
    count = len(
        (await db.execute(select(AitoTerminalPayment.id).where(AitoTerminalPayment.project_id == project_id)))
        .scalars()
        .all()
    )
    return f"aito-tpe:{project_id}:{count + 1}"


def _adopt(row: AitoTerminalPayment, view: LinkView, now: datetime) -> None:
    row.heimdall_id = view.id
    row.status = view.status
    row.native_state = view.native_state
    row.amount_confirmed = view.amount_confirmed
    row.booking_status = view.booking_status
    row.booking_error = view.booking_error
    row.zoho_payment_id = view.zoho_payment_id
    row.checked_at = now
    row.sync_error = None


async def start_terminal_payment(
    db: AsyncSession,
    project: AitoProject,
    *,
    document: PaymentDocument,
    amount: int,
    actor_name: str | None,
    now: datetime,
) -> AitoTerminalPayment:
    """Reserve a row, commit, fire the terminal, adopt Heimdall's answer.

    The reservation commit comes first so a crash between the POST and the
    second commit leaves a row the operator sees as `pending` with no
    heimdall_id — never a silent second charge. A Heimdall refusal marks the
    row `failed` (with the reason) and re-raises for the route to map."""
    project_id = project.id
    if await _blocking_row(db, project_id) is not None:
        raise TerminalInProgress("A terminal payment is already in progress for this project")
    row = AitoTerminalPayment(
        project_id=project_id,
        document_kind=document.kind,
        document_id=document.id,
        document_number=document.number,
        idempotency_key=await _next_key(db, project_id),
        amount=int(amount),
        created_by=actor_name,
        created_at=now,
    )
    db.add(row)
    await db.commit()
    try:
        view = await heimdall_service.create_terminal_payment(
            db,
            idempotency_key=row.idempotency_key,
            amount=row.amount,
            document={"type": document.kind, "id": document.id},
        )
    except HeimdallUpstreamError as exc:
        row.status = "failed"
        row.sync_error = str(exc)[:500]
        row.checked_at = now
        row.settled_at = now
        await db.commit()
        raise
    _adopt(row, view, now)
    await record(
        db,
        project_id,
        "payment.terminal.started",
        actor_class="user",
        actor_name=actor_name,
        subject_type="project",
        subject_id=project_id,
        detail={
            "document_kind": document.kind,
            "document_number": document.number,
            "amount": row.amount,
            "heimdall_id": row.heimdall_id,
        },
    )
    await db.commit()
    if row.status in SETTLED_STATUSES:
        # A 200 replay of an already-settled payment: settle it now.
        await apply_terminal_state(db, row, view, now=now)
    return row


async def apply_terminal_state(db: AsyncSession, row: AitoTerminalPayment, view: LinkView, *, now: datetime) -> None:
    """The one place a Heimdall view lands on a row. Commits. Idempotent:
    the transition events fire once, on the FIRST settle, and a later poll
    only refreshes `booking_*`."""
    project_id = row.project_id
    was = row.status
    already_settled = row.settled_at is not None
    _adopt(row, view, now)
    if row.status in SETTLED_STATUSES and not already_settled:
        row.settled_at = now
    await db.commit()
    if already_settled or row.status not in SETTLED_STATUSES or was == row.status:
        return
    detail = {
        "document_kind": row.document_kind,
        "document_number": row.document_number,
        "amount": row.amount,
        "amount_confirmed": row.amount_confirmed,
        "heimdall_id": row.heimdall_id,
        "native_state": row.native_state,
        "zoho_payment_id": row.zoho_payment_id,
    }
    if row.status == "paid":
        kind = "payment.terminal.paid"
    elif row.status == "needs_attention":
        kind = "payment.terminal.attention"
    else:
        kind = "payment.terminal.failed"
    await record(
        db, project_id, kind, actor_class="system", subject_type="project", subject_id=project_id, detail=detail
    )
    await db.commit()
    if row.status != "paid":
        return
    document_kind = row.document_kind
    amount = row.amount_confirmed if row.amount_confirmed is not None else row.amount
    from backend.app.services.aito_manual_payments import refresh_after_payment

    if document_kind == "quote":
        from backend.app.services.aito_quote_status import accept_quote

        project = await db.get(AitoProject, project_id)
        if project is not None and project.status == "active":
            await accept_quote(
                db, project, source="terminal", detail={"amount": amount, "reference": row.document_number}
            )
    await refresh_after_payment(db, project_id, document_kind)


async def refresh_terminal_payment(
    db: AsyncSession, row: AitoTerminalPayment, *, now: datetime, force: bool = False
) -> AitoTerminalPayment:
    """One GET, throttled to REFRESH_MIN_SECONDS since the last contact.
    Never raises: a Heimdall failure lands in `sync_error` and the stored
    row is returned as-is. A 404 (Heimdall lost the payment) marks the row
    `failed` so the operator can start again."""
    if row.heimdall_id is None:
        return row
    open_row = row.status in OPEN_STATUSES or (row.status == "paid" and row.booking_status == "pending")
    if not open_row:
        return row
    if not force and row.checked_at is not None and (now - row.checked_at) < timedelta(seconds=REFRESH_MIN_SECONDS):
        return row
    try:
        view = await heimdall_service.get_payment(db, row.heimdall_id)
    except HeimdallNotFound as exc:
        row.status = "failed"
        row.sync_error = str(exc)[:500]
        row.checked_at = now
        row.settled_at = row.settled_at or now
        await db.commit()
        return row
    except HeimdallUpstreamError as exc:
        row.sync_error = str(exc)[:500]
        row.checked_at = now
        await db.commit()
        return row
    await apply_terminal_state(db, row, view, now=now)
    return row


async def poll_open_terminal_payments(db: AsyncSession, *, now: datetime | None = None, limit: int = 40) -> int:
    """The tick's sweep: every open row, plus paid rows whose Zoho booking
    is still pending, oldest contact first. Returns the number visited. A
    429 stops the pass (the reconciler's own throttle covers the next tick)."""
    if not await heimdall_service.is_configured(db):
        return 0
    now = now or _now()
    stmt = (
        select(AitoTerminalPayment.id)
        .where(
            AitoTerminalPayment.heimdall_id.is_not(None),
            (AitoTerminalPayment.status.in_(OPEN_STATUSES))
            | ((AitoTerminalPayment.status == "paid") & (AitoTerminalPayment.booking_status == "pending")),
        )
        .order_by(AitoTerminalPayment.checked_at.asc().nulls_first(), AitoTerminalPayment.id)
        .limit(limit)
    )
    ids = list((await db.execute(stmt)).scalars().all())
    visited = 0
    for rid in ids:
        try:
            row = await db.get(AitoTerminalPayment, rid)
            if row is None:
                continue
            visited += 1
            await refresh_terminal_payment(db, row, now=now, force=True)
        except HeimdallRateLimited as exc:
            logger.warning("terminal payment poll: rate limited, stopping: %s", exc)
            await db.rollback()
            break
        except Exception as exc:  # noqa: BLE001 — one row's failure must not end the pass
            logger.warning("terminal payment poll: row %s failed: %s", rid, exc)
            await db.rollback()
    return visited
