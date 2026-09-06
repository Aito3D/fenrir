"""Aggregates for the Stats page's Aito pipeline widget.

Four read-only queries over projects and the event log; the stay maths for
"days per stage" runs in Python over one ordered scan. Trashed projects and
their events are excluded everywhere. Spec:
docs/superpowers/specs/2026-09-05-aito-pipeline-widget-design.md
"""

import json
from collections import defaultdict
from datetime import date, datetime, time
from statistics import median

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.schemas.aito import (
    AitoStatsBucket,
    AitoStatsConversion,
    AitoStatsInvoicing,
    AitoStatsResponse,
    AitoStatsStage,
    AitoStatsStageDays,
)
from backend.app.services.aito_board_rules import COLUMN_ORDER

_SENT_KINDS = ("quote.sent", "quote.emailed")
_STAGE_COLUMNS = tuple(column for column in COLUMN_ORDER if column != "done")
_DAY_SECONDS = 86_400.0


def _in_range(at: datetime, start: datetime | None, end: datetime | None) -> bool:
    return (start is None or at >= start) and (end is None or at <= end)


def _bounds(date_from: date | None, date_to: date | None) -> tuple[datetime | None, datetime | None]:
    start = datetime.combine(date_from, time.min) if date_from else None
    end = datetime.combine(date_to, time.max) if date_to else None
    return start, end


async def _active_projects(db: AsyncSession) -> dict[int, AitoProject]:
    rows = (await db.execute(select(AitoProject).where(AitoProject.status == "active"))).scalars().all()
    return {p.id: p for p in rows}


def _board(projects: dict[int, AitoProject]) -> list[AitoStatsStage]:
    count: dict[str, int] = defaultdict(int)
    total: dict[str, float] = defaultdict(float)
    for p in projects.values():
        count[p.board_column] += 1
        total[p.board_column] += p.quote_total or 0.0
    return [AitoStatsStage(column=c, count=count[c], total=total[c]) for c in COLUMN_ORDER]


async def _first_moments(db: AsyncSession, kinds: tuple[str, ...], project_ids: list[int]) -> dict[int, datetime]:
    """project_id -> earliest occurred_at among ``kinds``, active projects only."""
    if not project_ids:
        return {}
    stmt = (
        select(AitoEvent.project_id, func.min(AitoEvent.occurred_at))
        .where(AitoEvent.kind.in_(kinds), AitoEvent.project_id.in_(project_ids))
        .group_by(AitoEvent.project_id)
    )
    return dict((await db.execute(stmt)).all())


def _bucket(
    firsts: dict[int, datetime], projects: dict[int, AitoProject], start: datetime | None, end: datetime | None
) -> AitoStatsBucket:
    hits = [pid for pid, at in firsts.items() if _in_range(at, start, end)]
    return AitoStatsBucket(count=len(hits), total=sum(projects[pid].quote_total or 0.0 for pid in hits))


async def _stage_days(
    db: AsyncSession, projects: dict[int, AitoProject], start: datetime | None, end: datetime | None
) -> list[AitoStatsStageDays]:
    ids = list(projects)
    stays: dict[str, list[float]] = defaultdict(list)
    if ids:
        stmt = (
            select(AitoEvent.project_id, AitoEvent.occurred_at, AitoEvent.changes)
            .where(AitoEvent.kind == "stage.changed", AitoEvent.project_id.in_(ids))
            .order_by(AitoEvent.project_id, AitoEvent.occurred_at, AitoEvent.id)
        )
        opened_at: dict[int, datetime] = {}
        for pid, at, changes in (await db.execute(stmt)).all():
            if isinstance(changes, str):
                changes = json.loads(changes)
            left = (changes or [{}])[0].get("from") if changes else None
            began = opened_at.get(pid) or projects[pid].created_at
            opened_at[pid] = at
            if left in _STAGE_COLUMNS and began is not None and _in_range(at, start, end):
                stays[left].append(max(0.0, (at - began).total_seconds() / _DAY_SECONDS))
    return [
        AitoStatsStageDays(
            column=c, median_days=(round(median(stays[c]), 2) if stays[c] else None), sample=len(stays[c])
        )
        for c in _STAGE_COLUMNS
    ]


async def compute_aito_stats(db: AsyncSession, date_from: date | None, date_to: date | None) -> AitoStatsResponse:
    start, end = _bounds(date_from, date_to)
    projects = await _active_projects(db)
    ids = list(projects)

    sent = await _first_moments(db, _SENT_KINDS, ids)
    accepted = await _first_moments(db, ("quote.accepted",), ids)
    declined = await _first_moments(db, ("quote.declined",), ids)
    acc = _bucket(accepted, projects, start, end)
    dec = _bucket(declined, projects, start, end)
    decided = acc.count + dec.count
    conversion = AitoStatsConversion(
        sent=_bucket(sent, projects, start, end),
        accepted=acc,
        declined=dec,
        acceptance_rate=(round(acc.count / decided, 3) if decided else None),
    )

    invoiced = [
        p
        for pid, p in projects.items()
        if p.quote_invoiced and pid in accepted and _in_range(accepted[pid], start, end)
    ]
    outstanding = [p for p in projects.values() if p.quote_invoiced and (p.invoice_balance or 0.0) > 0]
    invoicing = AitoStatsInvoicing(
        invoiced_total=sum(p.quote_total or 0.0 for p in invoiced),
        invoiced_count=len(invoiced),
        outstanding_balance=sum(p.invoice_balance or 0.0 for p in outstanding),
        outstanding_count=len(outstanding),
    )

    return AitoStatsResponse(
        board=_board(projects),
        conversion=conversion,
        stage_days=await _stage_days(db, projects, start, end),
        invoicing=invoicing,
        date_from=date_from,
        date_to=date_to,
    )
