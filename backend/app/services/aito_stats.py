"""Aggregates for the Stats page's Aito pipeline widget.

Seven read-only queries over projects, the event log, and tracking-page views;
the stay maths for "days per stage" runs in Python over one ordered scan.
Trashed projects and their events are excluded everywhere. Spec:
docs/superpowers/specs/2026-09-05-aito-pipeline-widget-design.md
"""

import json
from collections import defaultdict
from datetime import date, datetime, timedelta
from statistics import median

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_tracking_view import AitoTrackingView
from backend.app.schemas.aito import (
    AitoStatsBucket,
    AitoStatsConversion,
    AitoStatsInvoicing,
    AitoStatsResponse,
    AitoStatsStage,
    AitoStatsStageDays,
    AitoStatsTracking,
)
from backend.app.services.aito_board_rules import COLUMN_ORDER
from backend.app.utils.dates import local_day_bounds

_SENT_KINDS = ("quote.sent", "quote.emailed")
_STAGE_COLUMNS = tuple(column for column in COLUMN_ORDER if column != "done")
_DAY_SECONDS = 86_400.0
# A `stage.changed` this soon after the card's own `project.created` is the
# creation-time board placement, not a real move: an imported card is created
# with a backdated `created_at` (the quote's date in Books), so that first
# rule-driven move would otherwise close a weeks-long fake stay in `devis`.
_CREATION_MOVE_GRACE = timedelta(seconds=60)


def _in_range(at: datetime, start: datetime | None, end: datetime | None) -> bool:
    return (start is None or at >= start) and (end is None or at <= end)


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


def _is_creation_time(at: datetime, born: datetime | None) -> bool:
    """Did this land in the window where a card is still being created?"""
    return born is not None and timedelta(0) <= at - born <= _CREATION_MOVE_GRACE


async def _first_moments(
    db: AsyncSession,
    kinds: tuple[str, ...],
    project_ids: list[int],
    born: dict[int, datetime] | None = None,
    end: datetime | None = None,
) -> dict[int, datetime]:
    """project_id -> earliest occurred_at among ``kinds``, active projects only.

    Import-time records are skipped: an already-decided Books quote pulled onto
    the board records its decision with ``occurred_at=now`` even though the
    client decided at some past, unknown moment, so counting it would credit
    the import week with a sale that never happened in it. A row counts as one
    when EITHER it carries ``detail.cause == "import"`` (what ``create_project``
    stamps now) OR — when ``born`` is given — it lands within
    ``_CREATION_MOVE_GRACE`` after the project's own ``project.created``, which
    catches the cards imported before that marker existed without a backfill.

    That pair of checks is why the ordered scan + first-eligible-row runs in
    Python instead of a SQL ``MIN``.

    ``end`` narrows the scan to rows that could possibly be "the first" within
    the requested window: every caller only ever reads this result through
    ``_in_range(..., end)`` (directly via ``_bucket``, or via
    ``_is_creation_time`` where a value beyond ``end`` and a missing value
    behave identically, since every row it is compared against is itself
    bounded to ``<= end``). There is no lower bound: history before ``start``
    is still needed to find the true first moment.
    """
    if not project_ids:
        return {}
    stmt = select(AitoEvent.project_id, AitoEvent.occurred_at, AitoEvent.detail).where(
        AitoEvent.kind.in_(kinds), AitoEvent.project_id.in_(project_ids)
    )
    if end is not None:
        stmt = stmt.where(AitoEvent.occurred_at <= end)
    stmt = stmt.order_by(AitoEvent.occurred_at, AitoEvent.id)
    firsts: dict[int, datetime] = {}
    for pid, at, detail in (await db.execute(stmt)).all():
        if pid in firsts:
            continue
        if isinstance(detail, str):
            detail = json.loads(detail)
        if (detail or {}).get("cause") == "import":
            continue
        if born is not None and _is_creation_time(at, born.get(pid)):
            continue
        firsts[pid] = at
    return firsts


def _bucket(
    firsts: dict[int, datetime], projects: dict[int, AitoProject], start: datetime | None, end: datetime | None
) -> AitoStatsBucket:
    hits = [pid for pid, at in firsts.items() if _in_range(at, start, end)]
    return AitoStatsBucket(count=len(hits), total=sum(projects[pid].quote_total or 0.0 for pid in hits))


async def _stage_days(
    db: AsyncSession,
    projects: dict[int, AitoProject],
    born: dict[int, datetime],
    start: datetime | None,
    end: datetime | None,
) -> list[AitoStatsStageDays]:
    ids = list(projects)
    stays: dict[str, list[float]] = defaultdict(list)
    if ids:
        stmt = select(AitoEvent.project_id, AitoEvent.occurred_at, AitoEvent.changes).where(
            AitoEvent.kind == "stage.changed", AitoEvent.project_id.in_(ids)
        )
        # A row past `end` can only ever fail `_in_range` below, and the
        # `opened_at` it would record is read only by later rows for the same
        # project (rows are ordered by occurred_at), which are also past
        # `end` — so dropping it here changes nothing but what SQLite reads.
        if end is not None:
            stmt = stmt.where(AitoEvent.occurred_at <= end)
        stmt = stmt.order_by(AitoEvent.project_id, AitoEvent.occurred_at, AitoEvent.id)
        opened_at: dict[int, datetime] = {}
        for pid, at, changes in (await db.execute(stmt)).all():
            if isinstance(changes, str):
                changes = json.loads(changes)
            left = changes[0].get("from") if changes else None
            began = opened_at.get(pid) or projects[pid].created_at
            opened_at[pid] = at
            # The board rules move a freshly created card into its computed
            # column in the same request that created it. `created_at` can be
            # backdated (an import carries the Books quote's date), so measure
            # against the `project.created` EVENT and drop that opening move.
            if _is_creation_time(at, born.get(pid)):
                continue
            if left in _STAGE_COLUMNS and began is not None and _in_range(at, start, end):
                stays[left].append(max(0.0, (at - began).total_seconds() / _DAY_SECONDS))
    return [
        AitoStatsStageDays(
            column=c, median_days=(round(median(stays[c]), 2) if stays[c] else None), sample=len(stays[c])
        )
        for c in _STAGE_COLUMNS
    ]


async def _tracking(
    db: AsyncSession, projects: dict[int, AitoProject], start: datetime | None, end: datetime | None
) -> AitoStatsTracking:
    cards_with_link = sum(1 for p in projects.values() if p.tracking_token)
    if not projects:
        return AitoStatsTracking(views=0, cards_viewed=0, cards_with_link=cards_with_link)
    stmt = select(func.count(AitoTrackingView.id), func.count(func.distinct(AitoTrackingView.project_id))).where(
        AitoTrackingView.project_id.in_(projects)
    )
    if start is not None:
        stmt = stmt.where(AitoTrackingView.viewed_at >= start)
    if end is not None:
        stmt = stmt.where(AitoTrackingView.viewed_at <= end)
    views, cards = (await db.execute(stmt)).one()
    return AitoStatsTracking(
        views=int(views or 0),
        cards_viewed=int(cards or 0),
        cards_with_link=cards_with_link,
    )


async def compute_aito_stats(
    db: AsyncSession,
    date_from: date | None,
    date_to: date | None,
    tz_offset_minutes: int = 0,
) -> AitoStatsResponse:
    start, end = local_day_bounds(date_from, date_to, tz_offset_minutes)
    projects = await _active_projects(db)
    ids = list(projects)

    # Fetched once and reused: the decision moments and the stage-days maths
    # both measure "was this still the card's creation?" against it.
    born = await _first_moments(db, ("project.created",), ids, end=end)
    sent = await _first_moments(db, _SENT_KINDS, ids, end=end)
    accepted = await _first_moments(db, ("quote.accepted",), ids, born, end=end)
    declined = await _first_moments(db, ("quote.declined",), ids, born, end=end)
    # A decision mirrored from Books (reconcile_quote_status -> adopt_quote_status)
    # records only `poll.reconciled`, but it DOES stamp quote_accepted_at, so a
    # client acceptance can exist with no `quote.accepted` event at all. Take
    # the earlier of the two moments wherever both exist. Declines have no such
    # column, so a Zoho-side decline without an event stays invisible.
    for pid, project in projects.items():
        stamped = project.quote_accepted_at
        if stamped is None:
            continue
        known = accepted.get(pid)
        accepted[pid] = stamped if known is None or stamped < known else known
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
        stage_days=await _stage_days(db, projects, born, start, end),
        invoicing=invoicing,
        tracking=await _tracking(db, projects, start, end),
        date_from=date_from,
        date_to=date_to,
    )
