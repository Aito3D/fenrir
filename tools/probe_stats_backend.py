"""Golden probe: the Aito statistics aggregator, end to end.

``compute_aito_stats`` is 642 lines that turn a board plus its event log into
the nineteen ``AitoStats*`` blocks the statistics view draws. Every screen in
that view is a rendering of this one response, so pinning the response pins the
feature's arithmetic: board totals, first-event conversion, stage dwell times,
rework, quote ageing, size bands, overdue, services, clients, arrivals,
islands, tracking, throughput vs the previous period, and the daily series.

The probe drives the aggregator directly against a seeded in-memory database
rather than through the route, so no HTTP, auth or settings machinery sits
between a refactor and the numbers it changes.

Determinism: the aggregator reads the clock exactly once (for quote ageing and
overdue), and that call is frozen below. Every seeded timestamp is a literal,
so the output is a pure function of this file.

Invoked by PROBES.json as `./venv/bin/python3 tools/probe_stats_backend.py`.
"""

import asyncio
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from unittest.mock import patch

sys.path.insert(0, os.getcwd())

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine  # noqa: E402

from backend.app.core.database import Base  # noqa: E402
from backend.app.models.aito_event import AitoEvent  # noqa: E402
from backend.app.models.aito_project import AitoProject  # noqa: E402
from backend.app.models.aito_task import AitoTask  # noqa: E402
from backend.app.services import aito_stats  # noqa: E402

# The single moment the aggregator is allowed to observe. Chosen mid-March so
# the "last 30 days" window straddles a month boundary and the previous-period
# comparison lands in February.
NOW = datetime(2026, 3, 15, 12, 0, 0)


def _dt(spec: str) -> datetime:
    return datetime.strptime(spec, "%Y-%m-%d %H:%M:%S")


class _FrozenDatetime(datetime):
    """`datetime` with a nailed-down `now`, everything else untouched."""

    @classmethod
    def now(cls, tz=None):  # noqa: ARG003 - signature must match
        return NOW.replace(tzinfo=timezone.utc) if tz else NOW


# --- Fixture -----------------------------------------------------------------
# One card per shape the aggregator distinguishes. Deliberately includes the
# awkward ones: a declined quote, a card that moved backwards (rework), a
# deleted card that must be invisible everywhere, an overdue card, a card whose
# quote was never sent, and a returning client.

PROJECTS = [
    # id, column, status, quote_total, client_id, client_name, due_date, token,
    # island, created_at, (quote_invoiced, invoice_balance, invoice_due_date),
    # (quote_status, quote_sent_at) — `_quote_age` reads these off the project
    # rather than the event log, and buckets only rows still reading "sent".
    # created_at is set on every row: the column's server_default is func.now(),
    # and both `_clients` (returning detection) and `_scan_stages` (the opening
    # stay's start) read it, so leaving it to the database would make the probe
    # a function of the wall clock.
    (
        1,
        "devis",
        "active",
        120000.0,
        "c-acme",
        "ACME",
        None,
        "tok1",
        "Tahiti",
        "2026-03-01 08:00:00",
        None,
        ("sent", "2026-03-02 09:00:00"),
    ),
    (
        2,
        "waiting",
        "active",
        45000.0,
        "c-acme",
        "ACME",
        "2026-03-10",
        "tok2",
        "Tahiti",
        "2026-02-20 08:00:00",
        (True, 45000.0, "2026-03-05"),
        None,
    ),
    (
        3,
        "scan",
        "active",
        8000.0,
        "c-blue",
        "Blue Lagoon",
        "2026-03-20",
        None,
        "Moorea",
        "2026-03-05 09:30:00",
        None,
        None,
    ),
    (
        4,
        "model",
        "active",
        250000.0,
        "c-cora",
        "Cora",
        None,
        "tok4",
        "Raiatea",
        "2026-01-15 10:00:00",
        (True, 100000.0, "2026-01-31"),
        None,
    ),
    (
        5,
        "print",
        "active",
        0.0,
        "c-dune",
        "Dune",
        "2026-02-28",
        None,
        None,
        "2026-02-01 11:00:00",
        None,
        ("sent", "2026-02-10 09:00:00"),
    ),
    (
        6,
        "finish",
        "active",
        33000.0,
        "c-blue",
        "Blue Lagoon",
        None,
        "tok6",
        "Moorea",
        "2026-03-08 14:00:00",
        None,
        None,
    ),
    (
        7,
        "done",
        "active",
        99000.0,
        "c-echo",
        "Echo",
        None,
        "tok7",
        "Tahiti",
        "2026-02-10 08:00:00",
        (True, 0.0, "2026-02-20"),
        None,
    ),
    (
        8,
        "devis",
        "deleted",
        777777.0,
        "c-ghost",
        "Ghost",
        "2026-01-01",
        "tok8",
        "Tahiti",
        "2026-01-02 08:00:00",
        (True, 777777.0, "2026-01-05"),
        None,
    ),
    (
        9,
        "devis",
        "active",
        None,
        "c-fiji",
        "Fiji",
        None,
        None,
        None,
        "2026-03-14 16:00:00",
        None,
        ("sent", "2026-03-13 09:00:00"),
    ),
]

# kind, project, when. `project.created` anchors each card; the move events feed
# stage dwell time and rework; the quote events feed conversion and ageing.
EVENTS = [
    ("project.created", 1, "2026-03-01 08:00:00"),
    ("project.created", 2, "2026-02-20 08:00:00"),
    ("project.created", 3, "2026-03-05 09:30:00"),
    ("project.created", 4, "2026-01-15 10:00:00"),
    ("project.created", 5, "2026-02-01 11:00:00"),
    ("project.created", 6, "2026-03-08 14:00:00"),
    ("project.created", 7, "2026-02-10 08:00:00"),
    ("project.created", 8, "2026-01-02 08:00:00"),
    ("project.created", 9, "2026-03-14 16:00:00"),
    # Quotes sent, and the decisions that followed.
    ("quote.sent", 1, "2026-03-02 09:00:00"),
    ("quote.sent", 2, "2026-02-21 09:00:00"),
    ("quote.sent", 3, "2026-03-06 09:00:00"),
    ("quote.sent", 4, "2026-01-16 09:00:00"),
    ("quote.sent", 6, "2026-03-09 09:00:00"),
    ("quote.sent", 7, "2026-02-11 09:00:00"),
    ("quote.sent", 8, "2026-01-03 09:00:00"),
    # A re-send must not count as a second 'sent'.
    ("quote.sent", 1, "2026-03-07 09:00:00"),
    ("quote.accepted", 2, "2026-02-23 10:00:00"),
    ("quote.accepted", 4, "2026-01-20 10:00:00"),
    ("quote.accepted", 6, "2026-03-11 10:00:00"),
    ("quote.accepted", 7, "2026-02-13 10:00:00"),
    ("quote.accepted", 8, "2026-01-05 10:00:00"),
    ("quote.declined", 3, "2026-03-10 10:00:00"),
]

# project, from, to, when — the column moves behind stage days and rework.
MOVES = [
    (2, "devis", "waiting", "2026-02-23 10:30:00"),
    (4, "devis", "waiting", "2026-01-20 10:30:00"),
    (4, "waiting", "scan", "2026-01-25 09:00:00"),
    (4, "scan", "model", "2026-02-02 09:00:00"),
    (6, "devis", "waiting", "2026-03-11 10:30:00"),
    (6, "waiting", "scan", "2026-03-12 09:00:00"),
    (6, "scan", "model", "2026-03-13 09:00:00"),
    (6, "model", "print", "2026-03-13 15:00:00"),
    (6, "print", "finish", "2026-03-14 09:00:00"),
    # Backwards: the one move that makes `rework` non-zero.
    (5, "print", "model", "2026-02-15 09:00:00"),
    (5, "model", "print", "2026-02-18 09:00:00"),
    (7, "devis", "waiting", "2026-02-13 10:30:00"),
    (7, "waiting", "done", "2026-02-25 16:00:00"),
]

# project, service costs — revenue per service for accepted cards.
TASKS = [
    (2, {"scan_cost": 15000.0, "scan_quantity": 1}),
    (4, {"modelisation_cost": 200000.0, "modelisation_quantity": 1}),
    (4, {"impression_cost": 50000.0, "impression_quantity": 2}),
    (6, {"usinage_cost": 33000.0, "usinage_quantity": 1}),
    (7, {"impression_cost": 99000.0, "impression_quantity": 3}),
]


async def _seed(session: AsyncSession) -> None:
    for pid, column, status, total, cid, cname, due, token, island, born_at, invoice, quote in PROJECTS:
        invoiced, balance, invoice_due = invoice or (False, None, None)
        quote_status, quote_sent_at = quote or (None, None)
        session.add(
            AitoProject(
                id=pid,
                description=f"Card {pid}",
                board_column=column,
                position=pid * 100,
                status=status,
                client_id=cid,
                client_name=cname,
                quote_total=total,
                due_date=due,
                tracking_token=token,
                shipping_island=island,
                created_at=_dt(born_at),
                quote_invoiced=invoiced,
                invoice_balance=balance,
                invoice_due_date=invoice_due,
                quote_status=quote_status,
                quote_sent_at=_dt(quote_sent_at) if quote_sent_at else None,
            )
        )
    await session.flush()

    for kind, pid, when in EVENTS:
        session.add(AitoEvent(project_id=pid, occurred_at=_dt(when), kind=kind, actor_class="user"))
    for pid, src, dst, when in MOVES:
        session.add(
            AitoEvent(
                project_id=pid,
                occurred_at=_dt(when),
                kind="stage.changed",
                actor_class="user",
                changes=[{"field": "column", "from": src, "to": dst}],
            )
        )
    for pid, cols in TASKS:
        session.add(AitoTask(project_id=pid, position=0, title=f"task-{pid}", **cols))
    await session.commit()


# Each case is (label, date_from, date_to, tz_offset_minutes). Together they
# exercise the unbounded window, a bounded one, the same window seen from
# Tahiti (UTC-10, where local days start 10h after UTC days), a window that
# selects nothing, and a single day.
CASES = [
    ("all_time_utc", None, None, 0),
    ("march_utc", date(2026, 3, 1), date(2026, 3, 15), 0),
    ("march_tahiti", date(2026, 3, 1), date(2026, 3, 15), -600),
    ("empty_window", date(2025, 1, 1), date(2025, 1, 31), 0),
    ("single_day", date(2026, 3, 11), date(2026, 3, 11), 0),
    ("open_start", None, date(2026, 2, 28), 0),
]


async def main() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    out: dict = {}
    async with maker() as session:
        await _seed(session)
        with patch.object(aito_stats, "datetime", _FrozenDatetime):
            for label, dfrom, dto, tz in CASES:
                result = await aito_stats.compute_aito_stats(session, dfrom, dto, tz)
                out[label] = result.model_dump(mode="json")

    # The empty board: every block must still answer, with zeros rather than
    # absences. A refactor that starts returning null here changes what the
    # screens draw even though no card exists to notice.
    engine2 = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine2.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker2 = async_sessionmaker(engine2, class_=AsyncSession, expire_on_commit=False)
    async with maker2() as session:
        with patch.object(aito_stats, "datetime", _FrozenDatetime):
            result = await aito_stats.compute_aito_stats(session, None, None, 0)
            out["empty_board"] = result.model_dump(mode="json")

    # Module-level constants the aggregator's rules are expressed in. A silent
    # edit to one of these is a behaviour change no fixture above would catch
    # if it happened to fall outside the seeded ranges.
    out["_constants"] = {
        "SENT_KINDS": list(aito_stats._SENT_KINDS),
        "STAGE_COLUMNS": list(aito_stats._STAGE_COLUMNS),
        "DAY_SECONDS": aito_stats._DAY_SECONDS,
        "STAGE_TIME_CAP": aito_stats._STAGE_TIME_CAP,
        "CREATION_MOVE_GRACE_SECONDS": aito_stats._CREATION_MOVE_GRACE / timedelta(seconds=1),
    }

    print(json.dumps(out, indent=2, sort_keys=True, default=str))


if __name__ == "__main__":
    asyncio.run(main())
