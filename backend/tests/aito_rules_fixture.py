"""The Aito board rules, enumerated as data.

This module is the single definition of the contract between
``backend/app/services/aito_board_rules.py`` and its TypeScript mirror,
``frontend/src/utils/aitoBoardRules.ts``.

``scripts/gen_aito_board_rules_fixture.py`` writes what ``build_fixture``
returns to ``frontend/src/__tests__/fixtures/aitoBoardRules.cases.json``.
``test_aito_board_rules_contract.py`` asserts that committed file still matches
the current Python, and the TS suite asserts the mirror reproduces every case.

The result: changing the Python fails the backend test until the fixture is
regenerated, and regenerating fails the frontend test until the mirror is
updated. Neither language can move alone.
"""

from itertools import combinations
from typing import Any

from backend.app.services.aito_board_rules import COLUMN_ORDER, SERVICES, evaluate, summarise

# Every status the rules branch on, plus one they do not recognise. Zoho can
# add statuses, and the fallback ("anything not accepted stays in Quote") is a
# real rule that has to be pinned like the others.
QUOTE_STATUSES: tuple[str | None, ...] = (
    None,
    "draft",
    "sent",
    "viewed",
    "expired",
    "declined",
    "accepted",
    "some_status_zoho_added_later",
)


class _Task:
    """Duck-types the four cost/done pairs ``summarise`` reads off an AitoTask."""

    def __init__(self, **kwargs: Any) -> None:
        for service in SERVICES:
            setattr(self, f"{service}_cost", kwargs.get(f"{service}_cost"))
            setattr(self, f"{service}_done", kwargs.get(f"{service}_done", False))
            setattr(self, f"{service}_quantity", kwargs.get(f"{service}_quantity"))
            setattr(self, f"{service}_discount_pct", kwargs.get(f"{service}_discount_pct"))
        self.title = kwargs.get("title", "")


def _powerset(items: tuple[str, ...]) -> list[list[str]]:
    return [list(subset) for size in range(len(items) + 1) for subset in combinations(items, size)]


def _evaluate_cases() -> list[dict[str, Any]]:
    """The full cartesian product: 8 statuses x 7 columns x 16 pending sets."""
    cases = []
    for status in QUOTE_STATUSES:
        for column in COLUMN_ORDER:
            for pending in _powerset(SERVICES):
                result_column, lock = evaluate(status, column, pending)
                cases.append(
                    {
                        "quote_status": status,
                        "stored_column": column,
                        "pending": pending,
                        "column": result_column,
                        "move_lock": lock,
                    }
                )
    return cases


# Task shapes chosen for the traps this codebase has actually been bitten by,
# not for coverage of the happy path.
_SUMMARISE_SHAPES: tuple[tuple[str, list[dict[str, Any]]], ...] = (
    ("no tasks at all", []),
    ("one task, nothing priced", [{}]),
    (
        "a free step is a real step",
        [{"scan_cost": 0.0}],
    ),
    (
        "a done flag on an unpriced service is not a step",
        [{"usinage_done": True, "impression_cost": 5.0}],
    ),
    (
        "every service priced on one task, half ticked",
        [
            {
                "title": "Support principal",
                "scan_cost": 10.0,
                "scan_done": True,
                "modelisation_cost": 20.0,
                "modelisation_done": True,
                "impression_cost": 30.0,
                "usinage_cost": 40.0,
            }
        ],
    ),
    (
        "the same service on two tasks counts twice",
        [
            {"title": "Pièce A", "scan_cost": 1.0, "scan_done": True},
            {"scan_cost": 2.0},
        ],
    ),
    (
        "floats are summed, never rounded",
        [{"scan_cost": 0.1, "modelisation_cost": 0.2}],
    ),
    (
        "everything ticked",
        [{"scan_cost": 1.0, "scan_done": True, "impression_cost": 2.0, "impression_done": True}],
    ),
    (
        # The impression cost is stored pre-discount; the total must say what
        # the quote will actually say. 1000 at 10% + an undiscounted 500 scan
        # is 1400 — and the discount must not touch the step count.
        "a discounted impression reduces the total, not the steps",
        [{"scan_cost": 500.0, "impression_cost": 1000.0, "impression_discount_pct": 10.0}],
    ),
    (
        # Machining is quoted per unit now, and its cost is stored
        # pre-discount exactly as printing's is. 1000 at 10% plus an
        # undiscounted 500 scan is 1400, and the discount must not touch the
        # step count.
        "a discounted usinage reduces the total, not the steps",
        [{"scan_cost": 500.0, "usinage_cost": 1000.0, "usinage_discount_pct": 10.0}],
    ),
    (
        # Every service discounted at a different rate, to pin that each one
        # reads its OWN percent rather than sharing impression's.
        "each service applies its own discount",
        [
            {
                "scan_cost": 100.0,
                "scan_discount_pct": 50.0,
                "modelisation_cost": 100.0,
                "modelisation_discount_pct": 25.0,
                "impression_cost": 100.0,
                "impression_discount_pct": 10.0,
                "usinage_cost": 100.0,
                "usinage_discount_pct": 5.0,
            }
        ],
    ),
    (
        # The design doc's headline example, pinned exactly: three tasks
        # carrying ten steps between them with three ticked is the 30% the
        # card's progress bar must show. The free scan on the second task is
        # deliberate — it makes the tenth step one that a cost-weighted or
        # truthiness-based implementation would silently drop.
        "three tasks, ten steps, three done",
        [
            {
                "scan_cost": 1.0,
                "scan_done": True,
                "modelisation_cost": 2.0,
                "modelisation_done": True,
                "impression_cost": 3.0,
            },
            {"scan_cost": 0.0, "impression_cost": 4.0, "impression_done": True, "usinage_cost": 5.0},
            {"scan_cost": 6.0, "modelisation_cost": 7.0, "impression_cost": 8.0, "usinage_cost": 9.0},
        ],
    ),
)


def _task_payload(shape: dict[str, Any]) -> dict[str, Any]:
    """The shape written to JSON — every field explicit, so the TS side never
    has to guess a default."""
    payload: dict[str, Any] = {}
    for service in SERVICES:
        payload[f"{service}_cost"] = shape.get(f"{service}_cost")
        payload[f"{service}_done"] = shape.get(f"{service}_done", False)
    payload["title"] = shape.get("title", "")
    payload["impression_discount_pct"] = shape.get("impression_discount_pct")
    return payload


def _summarise_cases() -> list[dict[str, Any]]:
    cases = []
    for name, shapes in _SUMMARISE_SHAPES:
        summary = summarise([_Task(**shape) for shape in shapes])
        cases.append(
            {
                "name": name,
                "tasks": [_task_payload(shape) for shape in shapes],
                "count": summary.count,
                "total": summary.total,
                "services": list(summary.services),
                "pending": list(summary.pending),
                "steps_total": summary.steps_total,
                "steps_done": summary.steps_done,
                "steps_by_task": [
                    {"services": list(steps.services), "done": list(steps.done), "title": steps.title}
                    for steps in summary.steps_by_task
                ],
            }
        )
    return cases


def build_fixture() -> dict[str, Any]:
    return {"evaluate": _evaluate_cases(), "summarise": _summarise_cases()}
