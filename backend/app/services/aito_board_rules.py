"""The Aito board's rules: a project's column is derived, not dropped.

A project sits where its quote status and its ticked task steps say it sits.
This module is the ONLY definition of that, deliberately: it is pure (no
FastAPI, no SQLAlchemy, no models), so it can be unit-tested exhaustively, and
it is never mirrored in TypeScript. The frontend renders `column` and
`move_lock` as the server computes them and derives nothing of its own, which
is what keeps the two languages from drifting the way `taskTotal` and
`_task_summaries` do.
"""

from collections.abc import Collection, Iterable
from typing import Any

# Board order, left to right. `waiting`, `scan` and `done` were added and
# `pickup` removed on 2026-07-29; see the migration in core/database.py.
COLUMN_ORDER: tuple[str, ...] = ("devis", "waiting", "scan", "model", "print", "finish", "done")

# Zoho statuses meaning the quote has left the shop: the answer is now the
# client's to give, not ours to write. `viewed` only says they opened it and
# `expired` says they never answered — both are still waiting on them.
AWAY_STATUSES: frozenset[str] = frozenset({"sent", "viewed", "expired"})

# The four services a task can carry, in the canonical order the rest of the
# Aito code emits them (see _SERVICE_COLUMNS in api/routes/aito.py).
SERVICES: tuple[str, ...] = ("scan", "modelisation", "impression", "usinage")

# Which services each work stage covers, in board order. Printing and machining
# share one column while remaining two separate steps on a task: the column is
# left only once BOTH are ticked everywhere they appear.
STAGES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("scan", ("scan",)),
    ("model", ("modelisation",)),
    ("print", ("impression", "usinage")),
)


def pending_services(tasks: Iterable[Any]) -> set[str]:
    """Services with at least one enabled-but-unticked step across ``tasks``.

    Duck-typed over anything exposing ``<service>_cost`` and ``<service>_done``
    — an ``AitoTask`` row in practice — so this module never imports a model.

    A cost of ``None`` means the service is absent from the job and is skipped;
    ``0`` means it is quoted free, which is a real step and is NOT skipped.
    """
    pending: set[str] = set()
    for task in tasks:
        for service in SERVICES:
            if getattr(task, f"{service}_cost") is not None and not getattr(task, f"{service}_done"):
                pending.add(service)
    return pending


def evaluate(quote_status: str | None, stored_column: str, pending: Collection[str]) -> tuple[str, str | None]:
    """The whole rule set: ``(column, move_lock)``.

    ``move_lock`` names why the card cannot be dragged between columns, and is
    ``None`` only when it can (Finish <-> Done). It is what the card renders its
    lock badge and tooltip from, and what decides which droppables a drag
    enables — the frontend re-derives none of this.

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
