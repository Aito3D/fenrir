"""Aggregates for the Stats page's Aito pipeline widget.

Seven read-only queries over projects, the event log, and tracking-page views;
the stay maths for "days per stage" runs in Python over one ordered scan.
Trashed projects and their events are excluded everywhere. Spec:
docs/superpowers/specs/2026-09-05-aito-pipeline-widget-design.md
"""

import json
import logging
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from statistics import fmean, median

from sqlalchemy import func, select
from sqlalchemy.engine import Row
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.aito_tracking_view import AitoTrackingView
from backend.app.schemas.aito import (
    AitoStatsBucket,
    AitoStatsClients,
    AitoStatsConversion,
    AitoStatsDay,
    AitoStatsInvoicing,
    AitoStatsIsland,
    AitoStatsOverdue,
    AitoStatsOverdueBucket,
    AitoStatsPrevious,
    AitoStatsQuoteAge,
    AitoStatsResponse,
    AitoStatsRework,
    AitoStatsService,
    AitoStatsSizeBand,
    AitoStatsStage,
    AitoStatsStageDays,
    AitoStatsStageTime,
    AitoStatsThroughput,
    AitoStatsTracking,
)
from backend.app.services.aito_board_rules import COLUMN_ORDER, SERVICES, net_cost
from backend.app.utils.dates import local_day_bounds

logger = logging.getLogger(__name__)

_SENT_KINDS = ("quote.sent", "quote.emailed")
_STAGE_COLUMNS = tuple(column for column in COLUMN_ORDER if column != "done")
_DAY_SECONDS = 86_400.0
# A `stage.changed` this soon after the card's own `project.created` is the
# creation-time board placement, not a real move: an imported card is created
# with a backdated `created_at` (the quote's date in Books), so that first
# rule-driven move would otherwise close a weeks-long fake stay in `devis`.
_CREATION_MOVE_GRACE = timedelta(seconds=60)

# Bounds for the calendar `/aito/stats` can materialise. `_daily()` emits one
# AitoStatsDay row per day in [first_day, last_day]; a caller-chosen range —
# or an "all time" request whose start is derived from the earliest
# `project.created` moment, which an import can backdate to whatever a Books
# quote_date says — must never be able to drive that loop past a sane size.
# Five years is comfortably wider than the widest date-bounded preset the
# frontend offers ("this-year") and than any realistic all-time history for
# this product, while keeping row count, JSON size, and memory small.
MAX_STATS_SPAN_DAYS = 1827  # 5 * 365 + 2 leap days
# Absolute floor/ceiling for a requested date, wide enough to cover any real
# usage but far enough from `date.min`/`date.max` that combining it with the
# widest allowed `tz_offset_minutes` (+/- 14h) in `local_day_bounds` can never
# overflow `datetime`.
MIN_STATS_DATE = date(2000, 1, 1)
MAX_STATS_DATE = date(2999, 12, 31)


def _in_range(at: datetime, start: datetime | None, end: datetime | None) -> bool:
    return (start is None or at >= start) and (end is None or at <= end)


# Every column this module actually reads off a project, in one place so the
# narrowed `_active_projects` select and this list can't drift apart. Every
# consumer below reads a `p.<attr>` (or `project.<attr>`/`projects[pid].<attr>`)
# purely as a value — nothing mutates a project, adds it back to a session, or
# relies on it being a real ORM instance — so a `Row` carrying just these
# columns is a drop-in replacement for the full `AitoProject`.
_PROJECT_COLUMNS = (
    AitoProject.id,
    AitoProject.board_column,
    AitoProject.client_id,
    AitoProject.client_name,
    AitoProject.created_at,
    AitoProject.description,
    AitoProject.invoice_balance,
    AitoProject.invoice_due_date,
    AitoProject.quote_accepted_at,
    AitoProject.quote_invoiced,
    AitoProject.quote_sent_at,
    AitoProject.quote_status,
    AitoProject.quote_total,
    AitoProject.shipping_island,
    AitoProject.shipping_price,
    AitoProject.tracking_token,
)


async def _active_projects(db: AsyncSession) -> dict[int, Row]:
    rows = (await db.execute(select(*_PROJECT_COLUMNS).where(AitoProject.status == "active"))).all()
    return {row.id: row for row in rows}


def _board(projects: dict[int, Row]) -> list[AitoStatsStage]:
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
    firsts: dict[int, datetime], projects: dict[int, Row], start: datetime | None, end: datetime | None
) -> AitoStatsBucket:
    hits = [pid for pid, at in firsts.items() if _in_range(at, start, end)]
    return AitoStatsBucket(count=len(hits), total=sum(projects[pid].quote_total or 0.0 for pid in hits))


@dataclass
class _Stay:
    column: str
    began: datetime
    ended: datetime


@dataclass
class _StageScan:
    """One ordered pass over every `stage.changed` row: the closed stays per
    project, the moments a card moved BACKWARDS on the board, and the first
    REAL move into Done per project (creation-time placement excluded, same
    as the other two; a card re-opened and closed again keeps its first
    completion — a re-open is not a second delivery). Four blocks read it
    (days per stage, stage time per card, rework, throughput/daily), so the
    scan runs once."""

    stays: dict[int, list[_Stay]] = field(default_factory=lambda: defaultdict(list))
    backward: dict[int, list[datetime]] = field(default_factory=lambda: defaultdict(list))
    done: dict[int, datetime] = field(default_factory=dict)


async def _scan_stages(
    db: AsyncSession, projects: dict[int, Row], born: dict[int, datetime], end: datetime | None
) -> _StageScan:
    scan = _StageScan()
    ids = list(projects)
    if not ids:
        return scan
    stmt = select(AitoEvent.project_id, AitoEvent.occurred_at, AitoEvent.changes).where(
        AitoEvent.kind == "stage.changed", AitoEvent.project_id.in_(ids)
    )
    # A row past `end` can only ever fail `_in_range` downstream, and the
    # `opened_at` it would record is read only by later rows for the same
    # project (rows are ordered by occurred_at), which are also past `end` —
    # so dropping it here changes nothing but what SQLite reads.
    if end is not None:
        stmt = stmt.where(AitoEvent.occurred_at <= end)
    stmt = stmt.order_by(AitoEvent.project_id, AitoEvent.occurred_at, AitoEvent.id)
    opened_at: dict[int, datetime] = {}
    for pid, at, changes in (await db.execute(stmt)).all():
        if isinstance(changes, str):
            changes = json.loads(changes)
        left = changes[0].get("from") if changes else None
        to = changes[0].get("to") if changes else None
        began = opened_at.get(pid) or projects[pid].created_at
        opened_at[pid] = at
        # The board rules move a freshly created card into its computed
        # column in the same request that created it. `created_at` can be
        # backdated (an import carries the Books quote's date), so measure
        # against the `project.created` EVENT and drop that opening move.
        if _is_creation_time(at, born.get(pid)):
            continue
        if left in _STAGE_COLUMNS and began is not None:
            scan.stays[pid].append(_Stay(column=left, began=began, ended=at))
        if left in COLUMN_ORDER and to in COLUMN_ORDER and COLUMN_ORDER.index(to) < COLUMN_ORDER.index(left):
            scan.backward[pid].append(at)
        if to == "done" and pid not in scan.done:
            scan.done[pid] = at
    return scan


def _stage_days(scan: _StageScan, start: datetime | None, end: datetime | None) -> list[AitoStatsStageDays]:
    stays: dict[str, list[float]] = defaultdict(list)
    for per_project in scan.stays.values():
        for stay in per_project:
            if _in_range(stay.ended, start, end):
                stays[stay.column].append(_days_between(stay.began, stay.ended))
    return [
        AitoStatsStageDays(
            column=c, median_days=(round(median(stays[c]), 2) if stays[c] else None), sample=len(stays[c])
        )
        for c in _STAGE_COLUMNS
    ]


_STAGE_TIME_CAP = 30


def _stage_time(
    scan: _StageScan,
    projects: dict[int, Row],
    done: dict[int, datetime],
    start: datetime | None,
    end: datetime | None,
) -> list[AitoStatsStageTime]:
    """Days per stage for every card completed in the period, newest first.
    Only stays closed by the completion count: a re-open afterwards is a
    different story and would double the bar."""
    rows: list[AitoStatsStageTime] = []
    for pid, done_at in done.items():
        if not _in_range(done_at, start, end):
            continue
        per = dict.fromkeys(_STAGE_COLUMNS, 0.0)
        for stay in scan.stays.get(pid, []):
            if stay.ended <= done_at:
                per[stay.column] += _days_between(stay.began, stay.ended)
        p = projects[pid]
        rows.append(
            AitoStatsStageTime(
                project_id=pid,
                client_name=p.client_name,
                description=(p.description or "")[:60],
                done_at=done_at,
                stages={c: round(v, 2) for c, v in per.items()},
            )
        )
    rows.sort(key=lambda r: (r.done_at, r.project_id), reverse=True)
    return rows[:_STAGE_TIME_CAP]


def _rework(scan: _StageScan, start: datetime | None, end: datetime | None) -> AitoStatsRework:
    moved: set[int] = set()
    cards: set[int] = set()
    moves = 0
    for pid, per_project in scan.stays.items():
        if any(_in_range(stay.ended, start, end) for stay in per_project):
            moved.add(pid)
    for pid, moments in scan.backward.items():
        hits = sum(1 for at in moments if _in_range(at, start, end))
        if hits:
            moves += hits
            cards.add(pid)
            moved.add(pid)
    return AitoStatsRework(moves=moves, cards=len(cards), share=(round(len(cards) / len(moved), 3) if moved else None))


_AGE_BUCKETS: tuple[tuple[str, int, int | None], ...] = (
    ("0-3", 0, 3),
    ("4-7", 4, 7),
    ("8-14", 8, 14),
    ("15+", 15, None),
)
_OVERDUE_BUCKETS: tuple[tuple[str, int, int | None], ...] = (("1-7", 1, 7), ("8-30", 8, 30), ("31+", 31, None))


def _bucket_name(days: int, buckets: tuple[tuple[str, int, int | None], ...]) -> str | None:
    for name, lo, hi in buckets:
        if days >= lo and (hi is None or days <= hi):
            return name
    return None


def _quote_age(projects: dict[int, Row], now: datetime) -> list[AitoStatsQuoteAge]:
    """Snapshot: sent, undecided quotes by whole days since sending."""
    rows: dict[str, list[float]] = {name: [0, 0.0] for name, _, _ in _AGE_BUCKETS}
    for p in projects.values():
        if p.quote_status != "sent" or p.quote_sent_at is None:
            continue
        name = _bucket_name(max(0, (now - p.quote_sent_at).days), _AGE_BUCKETS)
        if name is None:
            continue
        rows[name][0] += 1
        rows[name][1] += p.quote_total or 0.0
    return [AitoStatsQuoteAge(bucket=name, count=int(c), total=t) for name, (c, t) in rows.items()]  # type: ignore[arg-type]


def _size_bands(
    projects: dict[int, Row],
    accepted: dict[int, datetime],
    declined: dict[int, datetime],
    start: datetime | None,
    end: datetime | None,
) -> list[AitoStatsSizeBand]:
    """Decisions in the period, sorted by quote_total and cut into up to four
    equal-count bands (one band per two decisions below eight)."""
    decided: list[tuple[float, bool]] = []
    for pid, p in projects.items():
        if p.quote_total is None:
            continue
        moments = [(at, True) for at in (accepted.get(pid),) if at is not None]
        moments += [(at, False) for at in (declined.get(pid),) if at is not None]
        if not moments:
            continue
        first_at, won = min(moments, key=lambda m: m[0])
        if _in_range(first_at, start, end):
            decided.append((p.quote_total, won))
    decided.sort(key=lambda d: d[0])
    n = len(decided)
    if not n:
        return []
    count = max(1, min(4, n // 2))
    bands: list[AitoStatsSizeBand] = []
    for i in range(count):
        chunk = decided[i * n // count : (i + 1) * n // count]
        if not chunk:
            continue
        acc = sum(1 for _, won in chunk if won)
        bands.append(
            AitoStatsSizeBand(
                min=chunk[0][0],
                max=chunk[-1][0],
                accepted=acc,
                declined=len(chunk) - acc,
                rate=round(acc / len(chunk), 3),
            )
        )
    return bands


def _overdue(projects: dict[int, Row], today: date) -> AitoStatsOverdue:
    rows: dict[str, list[float]] = {name: [0, 0.0] for name, _, _ in _OVERDUE_BUCKETS}
    oldest: int | None = None
    for p in projects.values():
        if not p.quote_invoiced or (p.invoice_balance or 0.0) <= 0 or not p.invoice_due_date:
            continue
        try:
            due = date.fromisoformat(p.invoice_due_date)
        except ValueError:
            logger.warning("Project %s has an unparsable invoice_due_date %r", p.id, p.invoice_due_date)
            continue
        days = (today - due).days
        name = _bucket_name(days, _OVERDUE_BUCKETS)
        if name is None:
            continue
        oldest = days if oldest is None else max(oldest, days)
        rows[name][0] += 1
        rows[name][1] += p.invoice_balance or 0.0
    return AitoStatsOverdue(
        buckets=[AitoStatsOverdueBucket(bucket=name, count=int(c), balance=b) for name, (c, b) in rows.items()],  # type: ignore[arg-type]
        oldest_days=oldest,
    )


async def _services(
    db: AsyncSession, accepted: dict[int, datetime], start: datetime | None, end: datetime | None
) -> list[AitoStatsService]:
    """Tasks of the cards accepted in the period, one count per priced
    service; revenue is `net_cost`, the same figure the board total sums."""
    ids = [pid for pid, at in accepted.items() if _in_range(at, start, end)]
    tasks = dict.fromkeys(SERVICES, 0)
    revenue = dict.fromkeys(SERVICES, 0.0)
    if ids:
        for task in (await db.execute(select(AitoTask).where(AitoTask.project_id.in_(ids)))).scalars().all():
            for service in SERVICES:
                cost = net_cost(task, service)
                if cost is None:
                    continue
                tasks[service] += 1
                revenue[service] += cost
    return [AitoStatsService(service=s, tasks=tasks[s], revenue=round(revenue[s], 2)) for s in SERVICES]


def _clients(
    projects: dict[int, Row], born: dict[int, datetime], start: datetime | None, end: datetime | None
) -> AitoStatsClients:
    """A card is a returning client's when the same client_id has an active
    card created earlier. No client_id (a walk-in) always reads as new."""
    earliest: dict[str, datetime] = {}
    for p in projects.values():
        if (
            p.client_id
            and p.created_at is not None
            and (p.client_id not in earliest or p.created_at < earliest[p.client_id])
        ):
            earliest[p.client_id] = p.created_at
    new = returning = 0
    new_total = returning_total = 0.0
    for pid, at in born.items():
        if not _in_range(at, start, end):
            continue
        p = projects[pid]
        first = earliest.get(p.client_id) if p.client_id else None
        if first is not None and p.created_at is not None and first < p.created_at:
            returning += 1
            returning_total += p.quote_total or 0.0
        else:
            new += 1
            new_total += p.quote_total or 0.0
    return AitoStatsClients(new=new, returning=returning, new_total=new_total, returning_total=returning_total)


def _arrivals(
    born: dict[int, datetime], start: datetime | None, end: datetime | None, tz_offset_minutes: int
) -> list[list[int]]:
    grid = [[0] * 24 for _ in range(7)]
    for at in born.values():
        if _in_range(at, start, end):
            local = at + timedelta(minutes=tz_offset_minutes)
            grid[local.weekday()][local.hour] += 1
    return grid


def _islands(
    projects: dict[int, Row], born: dict[int, datetime], start: datetime | None, end: datetime | None
) -> list[AitoStatsIsland]:
    agg: dict[str | None, list[float]] = {}
    for pid, at in born.items():
        if not _in_range(at, start, end):
            continue
        p = projects[pid]
        row = agg.setdefault(p.shipping_island or None, [0, 0.0])
        row[0] += 1
        row[1] += p.shipping_price or 0.0
    rows = [AitoStatsIsland(island=k, count=int(c), shipping_total=t) for k, (c, t) in agg.items()]
    rows.sort(key=lambda r: (r.island is None, -r.count, r.island or ""))
    return rows


async def _tracking(
    db: AsyncSession, projects: dict[int, Row], start: datetime | None, end: datetime | None
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


def _days_between(a: datetime, b: datetime) -> float:
    return max(0.0, (b - a).total_seconds() / _DAY_SECONDS)


def _local_day(at: datetime, tz_offset_minutes: int) -> date:
    return (at + timedelta(minutes=tz_offset_minutes)).date()


def _throughput(
    projects: dict[int, Row],
    born: dict[int, datetime],
    accepted: dict[int, datetime],
    done: dict[int, datetime],
    start: datetime | None,
    end: datetime | None,
    days: int | None,
) -> AitoStatsThroughput:
    """Counts and lead times for one window. ``born``/``accepted``/``done``
    are the first-moment maps, already bounded by the request's ``end``, so
    the same maps serve the previous window too."""
    created = sum(1 for at in born.values() if _in_range(at, start, end))
    finished = {pid: at for pid, at in done.items() if _in_range(at, start, end)}
    # Lead time runs from the card's own created_at, not the `project.created`
    # event: an import backdates created_at to the Books quote date, which is
    # when the client's job actually began.
    leads = [_days_between(projects[pid].created_at, at) for pid, at in finished.items()]
    production = [
        _days_between(accepted[pid], at) for pid, at in finished.items() if pid in accepted and accepted[pid] <= at
    ]
    return AitoStatsThroughput(
        created=created,
        accepted=sum(1 for at in accepted.values() if _in_range(at, start, end)),
        done=len(finished),
        per_day=(round(created / days, 3) if days else None),
        lead_days=(round(fmean(leads), 2) if leads else None),
        lead_days_median=(round(median(leads), 2) if leads else None),
        production_days=(round(fmean(production), 2) if production else None),
        active=sum(1 for p in projects.values() if p.board_column != "done"),
    )


def _daily(
    born: dict[int, datetime],
    accepted: dict[int, datetime],
    declined: dict[int, datetime],
    done: dict[int, datetime],
    first_day: date | None,
    last_day: date | None,
    tz_offset_minutes: int,
) -> list[AitoStatsDay]:
    if first_day is None or last_day is None or last_day < first_day:
        return []
    # Defensive backstop, independent of the route's own validation: `first_day`
    # can come from the earliest `project.created` moment rather than from the
    # caller, so this loop must bound itself rather than trust either source.
    # Keep the most recent MAX_STATS_SPAN_DAYS days — the same window every
    # other "all time" widget on the page effectively shows — rather than the
    # oldest.
    if (last_day - first_day).days + 1 > MAX_STATS_SPAN_DAYS:
        first_day = last_day - timedelta(days=MAX_STATS_SPAN_DAYS - 1)
    counts: dict[date, list[int]] = defaultdict(lambda: [0, 0, 0, 0])
    for index, moments in enumerate((born, accepted, declined, done)):
        for at in moments.values():
            counts[_local_day(at, tz_offset_minutes)][index] += 1
    rows: list[AitoStatsDay] = []
    day = first_day
    while day <= last_day:
        c = counts.get(day, [0, 0, 0, 0])
        rows.append(AitoStatsDay(day=day, created=c[0], accepted=c[1], declined=c[2], done=c[3]))
        day += timedelta(days=1)
    return rows


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
    scan = await _scan_stages(db, projects, born, end)
    done = scan.done
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    # The statistics view's calendar. A bounded request is its own calendar;
    # all-time runs from the first card's arrival to the caller's today.
    today = _local_day(now, tz_offset_minutes)
    earliest = min(born.values(), default=None)
    first_day = date_from if date_from is not None else (_local_day(earliest, tz_offset_minutes) if earliest else None)
    last_day = date_to if date_to is not None else (today if first_day is not None else None)
    days = (last_day - first_day).days + 1 if first_day is not None and last_day is not None else None

    throughput = _throughput(projects, born, accepted, done, start, end, days)
    previous = None
    if start is not None and end is not None and days:
        prev = _throughput(
            projects, born, accepted, done, start - timedelta(days=days), start - timedelta(microseconds=1), days
        )
        prev_start, prev_end = start - timedelta(days=days), start - timedelta(microseconds=1)
        previous = AitoStatsPrevious(
            created=prev.created,
            accepted=prev.accepted,
            declined=sum(1 for at in declined.values() if _in_range(at, prev_start, prev_end)),
            done=prev.done,
            lead_days=prev.lead_days,
        )

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
        stage_days=_stage_days(scan, start, end),
        invoicing=invoicing,
        tracking=await _tracking(db, projects, start, end),
        throughput=throughput,
        previous=previous,
        daily=_daily(born, accepted, declined, done, first_day, last_day, tz_offset_minutes),
        quote_age=_quote_age(projects, now),
        size_bands=_size_bands(projects, accepted, declined, start, end),
        overdue=_overdue(projects, today),
        stage_time=_stage_time(scan, projects, done, start, end),
        rework=_rework(scan, start, end),
        services=await _services(db, accepted, start, end),
        clients=_clients(projects, born, start, end),
        arrivals=_arrivals(born, start, end, tz_offset_minutes),
        islands=_islands(projects, born, start, end),
        date_from=date_from,
        date_to=date_to,
    )
