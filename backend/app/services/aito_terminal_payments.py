"""Card charges on the Heimdall terminal, started from a project card.

Query helpers and the API view live here; the reserve/create/settle/poll
machinery is added alongside (see spec §4)."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_terminal_payment import AitoTerminalPayment

OPEN_STATUSES = frozenset({"pending", "processing"})
BLOCKING_STATUSES = frozenset({"pending", "processing", "needs_attention"})
STATUSES = ("pending", "processing", "paid", "failed", "cancelled", "expired", "needs_attention")


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
