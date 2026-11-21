"""Order book from the Aito board: accepted quotes not invoiced yet, and sent quotes awaiting an answer.

Local DB only. Every Aito card is a 3D service, so no scope cut; goods orders on the Order Board are not included.
Amounts are the Zoho quote's own total (TTC) as snapshotted on the card.
"""

import statistics
from datetime import datetime, timedelta

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


FUNNEL_DAYS = 365
FUNNEL_BANDS = ((10_000, "small"), (50_000, "medium"), (None, "large"))  # upper bound excluded, XPF TTC
_OUTCOME = {
    "accepted": "accepted",
    "invoiced": "accepted",
    "declined": "declined",
    "expired": "expired",
    "sent": "awaiting",
    "viewed": "awaiting",
}
DECIDED = ("accepted", "declined", "expired")


async def read_funnel_cards(conn: AsyncConnection) -> list:
    """Every card a quote was sent from, trash included: a declined quote is often binned."""
    cols = (
        AitoProject.status,
        AitoProject.quote_status,
        AitoProject.quote_status_before_trash,
        AitoProject.quote_total,
        AitoProject.quote_sent_at,
        AitoProject.quote_accepted_at,
    )
    return list((await conn.execute(select(*cols).where(AitoProject.quote_sent_at.is_not(None)))).all())


def _pct(part: float, whole: float) -> float | None:
    return round(part / whole * 100, 1) if whole else None


def build_funnel(cards: list, now: datetime) -> dict:
    """What became of the quotes sent in the last FUNNEL_DAYS days. `now` is naive UTC, like quote_sent_at."""
    since = now - timedelta(days=FUNNEL_DAYS)
    groups = {k: {"count": 0, "total": 0.0} for k in ("sent", "accepted", "declined", "expired", "awaiting")}
    bands = {name: {"band": name, "decided": 0, "accepted": 0} for _limit, name in FUNNEL_BANDS}
    missing = 0
    delays = []
    for c in cards:
        if c.quote_sent_at is None or c.quote_sent_at < since:
            continue
        status = (
            c.quote_status_before_trash if c.status == "deleted" and c.quote_status_before_trash else c.quote_status
        )
        outcome = _OUTCOME.get(status or "")
        if outcome is None:
            continue
        for key in ("sent", outcome):
            groups[key]["count"] += 1
            groups[key]["total"] += c.quote_total or 0.0
        if outcome == "accepted" and c.quote_accepted_at is not None:
            delays.append(max(0, (c.quote_accepted_at - c.quote_sent_at).days))
        if c.quote_total is None:
            missing += 1
        elif outcome in DECIDED:
            band = bands[next(name for limit, name in FUNNEL_BANDS if limit is None or c.quote_total < limit)]
            band["decided"] += 1
            band["accepted"] += outcome == "accepted"
    for g in groups.values():
        g["total"] = js_round(g["total"])
    decided = sum(groups[k]["count"] for k in DECIDED)
    decided_total = sum(groups[k]["total"] for k in DECIDED)
    return {
        **groups,
        "missingTotal": missing,
        "conversion": {
            "count": _pct(groups["accepted"]["count"], decided),
            "value": _pct(groups["accepted"]["total"], decided_total),
            "decided": decided,
        },
        "medianDaysToAccept": js_round(statistics.median(delays)) if delays else None,
        "bands": [{**b, "conversion": _pct(b["accepted"], b["decided"])} for b in bands.values()],
    }
