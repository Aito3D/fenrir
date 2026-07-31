"""The Aito board's rules: a project's column is derived, not dropped.

A project sits where its quote status and its ticked task steps say it sits.
This module is the authoritative definition of that, and it is pure (no
FastAPI, no SQLAlchemy, no models) so it can be unit-tested exhaustively.

It IS mirrored in TypeScript — frontend/src/utils/aitoBoardRules.ts — because
the board is optimistic: the card has to move the instant a step is ticked,
which means the frontend must predict the column rather than wait to be told
it. The mirror is not maintained by discipline. It is pinned by a generated
contract fixture (backend/tests/aito_rules_fixture.py), so changing anything
here without updating the mirror fails the build. After editing this file run:

    ./venv/bin/python3 scripts/gen_aito_board_rules_fixture.py

and fix the TypeScript until the frontend suite is green again.
"""

from collections.abc import Collection, Iterable
from dataclasses import dataclass
from typing import Any

# Board order, left to right. `waiting`, `scan` and `done` were added and
# `pickup` removed on 2026-07-29; see the migration in core/database.py.
COLUMN_ORDER: tuple[str, ...] = ("devis", "waiting", "scan", "model", "print", "finish", "done")

# Zoho statuses meaning the quote has left the shop: the answer is now the
# client's to give, not ours to write. `viewed` only says they opened it and
# `expired` says they never answered — both are still waiting on them.
AWAY_STATUSES: frozenset[str] = frozenset({"sent", "viewed", "expired"})

# The four services a task can carry, in the canonical order the rest of the
# Aito code emits them. This is the canonical order — api/routes/aito.py
# imports SERVICES from here rather than defining its own.
SERVICES: tuple[str, ...] = ("scan", "modelisation", "impression", "usinage")

# Which services each work stage covers, in board order. Printing and machining
# share one column while remaining two separate steps on a task: the column is
# left only once BOTH are ticked everywhere they appear.
STAGES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("scan", ("scan",)),
    ("model", ("modelisation",)),
    ("print", ("impression", "usinage")),
)


@dataclass(frozen=True)
class TaskSteps:
    """One task's steps, as the card draws them.

    ``services`` is what the task carries, ``done`` the ticked subset, both in
    ``SERVICES`` order. Deliberately the same ``(services, done)`` pair the
    frontend's ``ServiceBadges`` takes, so the API, the board card and a
    collapsed task row all describe a task's steps the same way.
    """

    services: tuple[str, ...] = ()
    done: tuple[str, ...] = ()


@dataclass(frozen=True)
class TaskSummary:
    """Everything a project's tasks say about it, in one value.

    ``services`` and ``pending`` are in ``SERVICES`` order so the card's badge
    row is stable across refetches regardless of the order tasks were created
    in. ``total`` is the definition mirrored by ``taskTotal`` in
    frontend/src/utils/taskDraft.ts.

    ``steps_total``/``steps_done`` count (task, service) pairs, not services:
    two tasks each carrying a scan are two steps, where ``services`` would
    report ``('scan',)`` once. They are what the board card's progress bar
    reads. A service priced at 0 is a real step; a service priced ``None`` is
    absent from the job and is not counted at all, done flag or no.

    This whole dataclass is mirrored by ``summariseTasks`` in
    frontend/src/utils/aitoBoardRules.ts and pinned by the contract fixture —
    see backend/tests/aito_rules_fixture.py. Changing it here without
    regenerating that fixture fails the build, by design.
    """

    count: int = 0
    total: float = 0.0
    services: tuple[str, ...] = ()
    pending: tuple[str, ...] = ()
    steps_total: int = 0
    steps_done: int = 0
    # One entry per task, in the order the caller handed them over — the card
    # draws a row per entry and the detail panel lists them in that same order.
    # This is what makes the card's pill grid possible without shipping every
    # task row on GET /aito/.
    steps_by_task: tuple[TaskSteps, ...] = ()


def summarise(tasks: Iterable[Any]) -> TaskSummary:
    """Count, total, enabled services and pending services in one pass.

    Duck-typed over anything exposing ``<service>_cost`` and ``<service>_done``
    — an ``AitoTask`` row in practice — so this module never imports a model.

    A cost of ``None`` means the service is absent from the job and is skipped
    entirely; ``0`` means it is quoted free, which is a real step that must
    show its badge and hold its column.
    """
    rows = list(tasks)
    total = 0.0
    enabled: set[str] = set()
    unticked: set[str] = set()
    steps_total = 0
    steps_done = 0
    by_task: list[TaskSteps] = []
    for task in rows:
        task_services: list[str] = []
        task_done: list[str] = []
        for service in SERVICES:
            cost = getattr(task, f"{service}_cost")
            if cost is None:
                continue
            enabled.add(service)
            task_services.append(service)
            total += cost
            steps_total += 1
            if getattr(task, f"{service}_done"):
                steps_done += 1
                task_done.append(service)
            else:
                unticked.add(service)
        by_task.append(TaskSteps(services=tuple(task_services), done=tuple(task_done)))
    return TaskSummary(
        count=len(rows),
        total=total,
        services=tuple(service for service in SERVICES if service in enabled),
        pending=tuple(service for service in SERVICES if service in unticked),
        steps_total=steps_total,
        steps_done=steps_done,
        steps_by_task=tuple(by_task),
    )


def evaluate(quote_status: str | None, stored_column: str, pending: Collection[str]) -> tuple[str, str | None]:
    """The whole rule set: ``(column, move_lock)``.

    ``move_lock`` names why the card cannot be dragged between columns, and is
    ``None`` only when it can (Finish <-> Done). It is what the card renders its
    lock badge and tooltip from, and what decides which droppables a drag
    enables — mirrored, not independently re-derived, by the frontend's own
    ``evaluate`` in frontend/src/utils/aitoBoardRules.ts (see the module
    docstring above for how that mirror is pinned).

    Rule order matters twice. Waiting outranks the steps, so ticking a step on
    a card that is out with the client moves nothing — the work is not
    authorised yet. And the stage search runs before the nothing-left-to-do
    fallback, which is what evicts a card from Done the moment any step is
    re-opened; swapped, un-ticking would leave it parked in Done forever.
    """
    if quote_status == "declined":
        return "done", "declined"
    if quote_status in AWAY_STATUSES:
        return "waiting", "waiting"
    if quote_status != "accepted":
        # NULL included: a hand-made card with no Zoho quote waits for Accept
        # exactly like a draft does. Acceptance is the single gate.
        return "devis", "quote"

    pending_set = set(pending)
    for stage, services in STAGES:
        if pending_set.intersection(services):
            return stage, "steps"

    # Nothing left to do. This is the ONLY place the stored column is believed,
    # and only between Finish and Done — which is what makes that one manual
    # drag possible inside an otherwise fully derived model.
    return ("done" if stored_column == "done" else "finish"), None
