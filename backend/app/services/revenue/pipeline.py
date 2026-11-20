"""Order book from the Aito board: accepted quotes not invoiced yet, and sent quotes awaiting an answer.

Local DB only. Every Aito card is a 3D service, so no scope cut; goods orders on the Order Board are not included.
Amounts are the Zoho quote's own total (TTC) as snapshotted on the card.
"""

from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncConnection

from backend.app.models.aito_project import AitoProject
from backend.app.services.aito_board_rules import COLUMN_ORDER
from backend.app.services.revenue.series import js_round

AWAITING_STATUSES = ("sent", "viewed")


async def pipeline_stamp(conn: AsyncConnection) -> str:
    """Moves on any card write (updated_at) and on a new card (count); soft deletes bump updated_at too."""
    n, at = (await conn.execute(select(func.count(), func.max(AitoProject.updated_at)))).one()
    return f"{n}@{at or ''}"


async def read_cards(conn: AsyncConnection) -> list:
    """Active cards only: trash is status 'deleted' (aito_stats uses the same test)."""
    cols = (
        AitoProject.board_column,
        AitoProject.quote_status,
        AitoProject.quote_invoiced,
        AitoProject.quote_total,
        AitoProject.retainer_paid_total,
        AitoProject.quote_sent_at,
    )
    return list((await conn.execute(select(*cols).where(AitoProject.status == "active"))).all())


def build_pipeline(cards: list, now: datetime) -> dict:
    """`now` is naive UTC, like quote_sent_at."""
    by_column = {c: {"column": c, "count": 0, "total": 0.0} for c in COLUMN_ORDER}
    accepted = {"count": 0, "total": 0.0, "retainerPaid": 0.0, "missingTotal": 0}
    awaiting = {"count": 0, "total": 0.0, "oldestDays": None}
    oldest: datetime | None = None
    for c in cards:
        if c.quote_status == "accepted" and not c.quote_invoiced:
            accepted["count"] += 1
            accepted["retainerPaid"] += c.retainer_paid_total or 0.0
            col = by_column.setdefault(c.board_column, {"column": c.board_column, "count": 0, "total": 0.0})
            col["count"] += 1
            if c.quote_total is None:
                accepted["missingTotal"] += 1
            else:
                accepted["total"] += c.quote_total
                col["total"] += c.quote_total
        elif c.quote_status in AWAITING_STATUSES:
            awaiting["count"] += 1
            awaiting["total"] += c.quote_total or 0.0
            if c.quote_sent_at is not None and (oldest is None or c.quote_sent_at < oldest):
                oldest = c.quote_sent_at
    if oldest is not None:
        awaiting["oldestDays"] = max(0, (now - oldest).days)
    for d in (accepted, awaiting, *by_column.values()):
        d["total"] = js_round(d["total"])
    accepted["retainerPaid"] = js_round(accepted["retainerPaid"])
    accepted["byColumn"] = [c for c in by_column.values() if c["count"]]
    return {"accepted": accepted, "awaiting": awaiting}
