# Aito Optimistic UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every action on the Aito board takes effect on screen the instant it is taken, and reverts with a visible signal if the server refuses it.

**Architecture:** The Aito board's column is derived server-side by `aito_board_rules.evaluate()`. To predict a card's new column locally we mirror that function in TypeScript and pin the mirror with a generated contract fixture, so the two languages cannot drift silently. On top of that mirror sit pure `AitoProject[] -> AitoProject[]` transforms and one `useOptimisticBoardMutation` wrapper that every call site adopts. Two unrelated card changes ride along: the quote-status badge comes off, a step-progress bar goes on, and the detail panel's task rows stop collapsing.

**Tech Stack:** FastAPI + SQLAlchemy (Python 3.10+), React 19 + TypeScript (strict), TanStack React Query v5, dnd-kit, Tailwind CSS 4, Vitest, pytest.

**Spec:** `docs/superpowers/specs/2026-07-30-aito-optimistic-ui-design.md`

## Global Constraints

- Python line length 120, double quotes, Ruff (`E,W,F,I,B,C4,UP,ARG,SIM`), target Python 3.10 — **no** `datetime.UTC` or other 3.11+ features.
- Use `./venv/bin/python3` for every Python command. System `python3` lacks project deps. `ruff` is on PATH.
- TypeScript strict, no unused locals or parameters, ES2022, `@/` aliases `frontend/src/`.
- All test scripts run **from the project root**: `./test_frontend.sh`, `./test_backend.sh`.
- `npm run build` catches missing imports and module-resolution errors that `npx tsc --noEmit` does not. Run it, not just tsc.
- **`frontend/tsconfig.app.json` excludes `src/__tests__`.** Neither tsc nor `npm run build` ever type-checks test files. Removing a prop from an interface produces **zero** compiler errors in test fixtures. Sweep by grep.
- New user-facing strings need entries in **all 13** locales under `frontend/src/i18n/locales/` (`de, en, es, fr, it, ja, ko, pt-BR, ru, tr, uk, zh-CN, zh-TW`). The i18n gate rejects English text left in a non-English file.
- Board rule vocabulary, used verbatim throughout: columns `devis, waiting, scan, model, print, finish, done`; services `scan, modelisation, impression, usinage`; move locks `quote, waiting, declined, steps, null`.
- A service cost of `null` means **absent from the job**; `0` means **quoted free** and is a real step. Membership is always a null check, never truthiness.

## File Structure

**New**

| Path | Responsibility |
|---|---|
| `frontend/src/utils/aitoBoardRules.ts` | TS mirror of `evaluate()` + `summariseTasks()`. Imports nothing local — structural types only, so nothing can cycle back into it. |
| `frontend/src/utils/aitoOptimistic.ts` | Pure `AitoProject[] -> AitoProject[]` transforms. No React, no network. |
| `frontend/src/hooks/useBoardSync.ts` | Shared in-flight counter + resync generation for every board writer. |
| `frontend/src/hooks/useRevertFlash.ts` | 600 ms "this reverted" marker, module store + subscriber hook. |
| `frontend/src/hooks/useOptimisticBoardMutation.ts` | The cancel → snapshot → transform → rollback → flash → settle wrapper. |
| `frontend/src/components/aito/ProjectProgress.tsx` | The card's step-progress bar. |
| `backend/tests/aito_rules_fixture.py` | `build_fixture()` — the single definition of the contract cases. |
| `scripts/gen_aito_board_rules_fixture.py` | Thin CLI that writes the fixture to disk. |
| `frontend/src/__tests__/fixtures/aitoBoardRules.cases.json` | Generated. Committed. |
| `backend/tests/unit/test_aito_board_rules_contract.py` | Asserts the committed fixture matches current Python. |
| `frontend/src/__tests__/utils/aitoBoardRules.test.ts` | Asserts the TS mirror reproduces every case. |
| `frontend/src/__tests__/utils/aitoOptimistic.test.ts` | Unit tests for the transforms. |

**Note on the script's location.** The spec said `backend/scripts/`. That directory does not exist; this repo keeps Python scripts in a root-level `scripts/`. Following the existing convention. The generation *logic* lives in `backend/tests/aito_rules_fixture.py` so the contract test can import it without path games — the script is a five-line wrapper.

**Modified:** `backend/app/services/aito_board_rules.py`, `backend/app/schemas/aito.py`, `backend/app/api/routes/aito.py`, `frontend/src/api/client.ts`, `frontend/src/utils/taskDraft.ts`, `frontend/src/components/aito/services.ts`, `frontend/src/pages/AitoPage.tsx`, `frontend/src/hooks/useBoardDrag.ts`, `frontend/src/hooks/useProjectTasks.ts`, `frontend/src/hooks/useQuoteStatusMutation.ts`, `frontend/src/components/aito/{CardView,BoardColumn,TaskEditor,TaskRow,ProjectDetailPanel,TrashModal,quoteStatus}.tsx|ts`, `frontend/src/components/aito/history/ActivityRail.tsx`, `frontend/src/index.css`, all 13 locale files.

---

## Stage 1 — The mirror and its pin

### Task 1: Step counters in the rule engine

**Files:**
- Modify: `backend/app/services/aito_board_rules.py:40-85`
- Test: `backend/tests/unit/test_aito_board_summary.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `TaskSummary` gains `steps_total: int = 0` and `steps_done: int = 0`. `summarise(tasks)` populates both.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/unit/test_aito_board_summary.py`:

```python
def test_step_counters_count_priced_services_only():
    # scan and impression are priced (0 counts — free is real work);
    # modelisation and usinage are absent from the job.
    summary = summarise([_Task(scan_cost=10.0, scan_done=True, impression_cost=0.0)])
    assert summary.steps_total == 2
    assert summary.steps_done == 1


def test_step_counters_ignore_done_flags_on_unpriced_services():
    # A done flag on a service with no cost is not a step at all.
    summary = summarise([_Task(usinage_done=True)])
    assert summary.steps_total == 0
    assert summary.steps_done == 0


def test_step_counters_sum_across_tasks():
    summary = summarise([
        _Task(scan_cost=1.0, scan_done=True, modelisation_cost=2.0, modelisation_done=True, impression_cost=3.0),
        _Task(impression_cost=4.0, impression_done=True, usinage_cost=5.0),
        _Task(scan_cost=6.0, modelisation_cost=7.0, impression_cost=8.0, usinage_cost=9.0),
    ])
    assert summary.steps_total == 10
    assert summary.steps_done == 3


def test_empty_summary_has_zero_steps():
    assert summarise([]).steps_total == 0
    assert summarise([]).steps_done == 0
```

- [ ] **Step 2: Run them to verify they fail**

```bash
./venv/bin/python3 -m pytest backend/tests/unit/test_aito_board_summary.py -v
```

Expected: FAIL — `AttributeError: 'TaskSummary' object has no attribute 'steps_total'`.

- [ ] **Step 3: Add the fields**

In `backend/app/services/aito_board_rules.py`, extend the dataclass. Add to the docstring after the existing `total` sentence:

```python
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
```

- [ ] **Step 4: Populate them in the existing pass**

Replace the body of `summarise` (currently lines ~67-85). The `if not ...` becomes an `if/else` so both counters come off the same branch — no second loop:

```python
    rows = list(tasks)
    total = 0.0
    enabled: set[str] = set()
    unticked: set[str] = set()
    steps_total = 0
    steps_done = 0
    for task in rows:
        for service in SERVICES:
            cost = getattr(task, f"{service}_cost")
            if cost is None:
                continue
            enabled.add(service)
            total += cost
            steps_total += 1
            if getattr(task, f"{service}_done"):
                steps_done += 1
            else:
                unticked.add(service)
    return TaskSummary(
        count=len(rows),
        total=total,
        services=tuple(service for service in SERVICES if service in enabled),
        pending=tuple(service for service in SERVICES if service in unticked),
        steps_total=steps_total,
        steps_done=steps_done,
    )
```

- [ ] **Step 5: Run the whole board-rules suite**

```bash
./venv/bin/python3 -m pytest backend/tests/unit/test_aito_board_summary.py backend/tests/unit/test_aito_board_rules.py -v
```

Expected: PASS. `test_no_tasks_is_all_empty` still passes because both new fields default to 0.

- [ ] **Step 6: Lint and commit**

```bash
ruff check backend/app/services/aito_board_rules.py && ruff format --check backend/app/services/aito_board_rules.py
git add backend/app/services/aito_board_rules.py backend/tests/unit/test_aito_board_summary.py
git commit -m "feat(aito): count a project's steps in the task summary"
```

---

### Task 2: Ship the counters over the wire

**Files:**
- Modify: `backend/app/schemas/aito.py:145-150`
- Modify: `backend/app/api/routes/aito.py:69-105` (`_to_response`)
- Modify: `frontend/src/api/client.ts` (the `AitoProject` interface, near line 3455)
- Test: `backend/tests/unit/test_aito_board_summary.py`

**Interfaces:**
- Consumes: `TaskSummary.steps_total` / `.steps_done` from Task 1.
- Produces: `AitoProjectResponse.steps_total: int`, `.steps_done: int`. TS `AitoProject.steps_total: number`, `.steps_done: number`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/unit/test_aito_board_summary.py`:

```python
def test_to_response_carries_the_step_counters():
    """The card's progress bar reads these; a handler that dropped them would
    render every bar at zero with nothing failing."""
    from backend.app.api.routes.aito import _to_response
    from backend.app.models.aito_project import AitoProject

    project = AitoProject(
        id=1,
        description="x",
        board_column="print",
        position=0,
        status="active",
        quote_status="accepted",
    )
    summary = summarise([_Task(scan_cost=1.0, scan_done=True, impression_cost=2.0)])
    response = _to_response(project, summary)
    assert response.steps_total == 2
    assert response.steps_done == 1
```

- [ ] **Step 2: Run it to verify it fails**

```bash
./venv/bin/python3 -m pytest backend/tests/unit/test_aito_board_summary.py::test_to_response_carries_the_step_counters -v
```

Expected: FAIL — `AttributeError: 'AitoProjectResponse' object has no attribute 'steps_total'`.

- [ ] **Step 3: Add to the schema**

In `backend/app/schemas/aito.py`, directly after the `task_services: list[str]` line:

```python
    # Steps, not services: two tasks each carrying a scan are two steps, where
    # task_services reports 'scan' once. The board card's progress bar is
    # steps_done / steps_total, and hides itself entirely when steps_total is
    # 0 — an unpriced project has nothing to measure.
    steps_total: int
    steps_done: int
```

- [ ] **Step 4: Set them in `_to_response`**

In `backend/app/api/routes/aito.py`, after `task_services=list(summary.services),`:

```python
        steps_total=summary.steps_total,
        steps_done=summary.steps_done,
```

- [ ] **Step 5: Add to the TS interface**

In `frontend/src/api/client.ts`, in `interface AitoProject`, after `task_services: string[];`:

```ts
  /** The project's steps: one per (task, service) pair whose cost is not null.
   *  A service priced 0 is a real step, one priced null is absent from the job.
   *  Mirrored by `summariseTasks` in utils/aitoBoardRules.ts and pinned by the
   *  contract fixture. The card's progress bar is done/total, hidden when
   *  total is 0. */
  steps_total: number;
  steps_done: number;
```

- [ ] **Step 6: Run backend tests**

```bash
./venv/bin/python3 -m pytest backend/tests/unit/test_aito_board_summary.py -v
```

Expected: PASS.

- [ ] **Step 7: Sweep the frontend test fixtures**

`AitoProject` is a required-field interface and test files are not type-checked. Find every fixture literal:

```bash
grep -rln "task_services" frontend/src/__tests__/
```

Add `steps_total: 0, steps_done: 0,` to every `AitoProject` object literal in each file found (they sit next to `task_services`). Then confirm none were missed:

```bash
grep -rc "task_services" frontend/src/__tests__/ | grep -v ':0'
grep -rc "steps_total" frontend/src/__tests__/ | grep -v ':0'
```

Expected: the two counts match, file for file.

- [ ] **Step 8: Full gate and commit**

```bash
./venv/bin/python3 -m pytest backend/tests/unit -k aito -q
cd frontend && npm run build && cd ..
./test_frontend.sh
```

Expected: all pass.

```bash
git add -A
git commit -m "feat(aito): send the step counters to the board card"
```

---

### Task 3: The contract fixture and its backend half

**Files:**
- Create: `backend/tests/aito_rules_fixture.py`
- Create: `scripts/gen_aito_board_rules_fixture.py`
- Create: `frontend/src/__tests__/fixtures/aitoBoardRules.cases.json` (generated)
- Create: `backend/tests/unit/test_aito_board_rules_contract.py`

**Interfaces:**
- Consumes: `evaluate`, `summarise`, `SERVICES`, `COLUMN_ORDER`, `TaskSummary` from `backend.app.services.aito_board_rules`.
- Produces: `build_fixture() -> dict` with keys `"evaluate"` and `"summarise"`. JSON shape is the contract Task 4's TS test reads:
  - `evaluate[]`: `{quote_status: str|null, stored_column: str, pending: str[], column: str, move_lock: str|null}`
  - `summarise[]`: `{name: str, tasks: [{scan_cost, modelisation_cost, impression_cost, usinage_cost, scan_done, modelisation_done, impression_done, usinage_done}], count, total, services, pending, steps_total, steps_done}`

- [ ] **Step 1: Write the fixture builder**

Create `backend/tests/aito_rules_fixture.py`. No `test_` prefix — pytest will not collect it, and both the script and the contract test import it, so there is exactly one definition of the cases.

```python
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
        [{"scan_cost": 1.0, "scan_done": True}, {"scan_cost": 2.0}],
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
        "three tasks, ten steps, three done",
        [
            {
                "scan_cost": 1.0,
                "scan_done": True,
                "modelisation_cost": 2.0,
                "modelisation_done": True,
                "impression_cost": 3.0,
            },
            {"impression_cost": 4.0, "impression_done": True, "usinage_cost": 5.0},
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
            }
        )
    return cases


def build_fixture() -> dict[str, Any]:
    return {"evaluate": _evaluate_cases(), "summarise": _summarise_cases()}
```

- [ ] **Step 2: Write the generator script**

Create `scripts/gen_aito_board_rules_fixture.py`:

```python
#!/usr/bin/env python3
"""Regenerate the Aito board-rules contract fixture.

Run from the project root after changing ``evaluate`` or ``summarise`` in
``backend/app/services/aito_board_rules.py``:

    ./venv/bin/python3 scripts/gen_aito_board_rules_fixture.py

Then update ``frontend/src/utils/aitoBoardRules.ts`` until the frontend suite
passes again. See backend/tests/aito_rules_fixture.py for why.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.tests.aito_rules_fixture import build_fixture  # noqa: E402

FIXTURE = ROOT / "frontend" / "src" / "__tests__" / "fixtures" / "aitoBoardRules.cases.json"


def main() -> None:
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    # sort_keys + trailing newline so a regeneration that changes nothing
    # produces a byte-identical file and an empty diff.
    FIXTURE.write_text(json.dumps(build_fixture(), indent=2, sort_keys=True) + "\n")
    print(f"wrote {FIXTURE.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Generate the fixture**

```bash
./venv/bin/python3 scripts/gen_aito_board_rules_fixture.py
```

Expected output: `wrote frontend/src/__tests__/fixtures/aitoBoardRules.cases.json`

Verify the case count is 896 and the summarise set is 9:

```bash
./venv/bin/python3 -c "
import json
d = json.load(open('frontend/src/__tests__/fixtures/aitoBoardRules.cases.json'))
print(len(d['evaluate']), len(d['summarise']))
"
```

Expected: `896 9`

- [ ] **Step 4: Write the contract test**

Create `backend/tests/unit/test_aito_board_rules_contract.py`:

```python
"""The committed contract fixture must match the current Python.

Reads only — never writes — so it is safe under `pytest -n 30`. When this
fails, the rules changed and the fixture is stale:

    ./venv/bin/python3 scripts/gen_aito_board_rules_fixture.py

That regeneration will in turn fail the TypeScript mirror's test until
frontend/src/utils/aitoBoardRules.ts is brought back in line. That chain is
the whole point: neither language can change the rules alone.
"""

import json
from pathlib import Path

from backend.tests.aito_rules_fixture import build_fixture

FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "frontend"
    / "src"
    / "__tests__"
    / "fixtures"
    / "aitoBoardRules.cases.json"
)


def test_fixture_matches_the_current_rules():
    assert FIXTURE.exists(), f"missing {FIXTURE}; run scripts/gen_aito_board_rules_fixture.py"
    committed = json.loads(FIXTURE.read_text())
    assert committed == build_fixture(), (
        "The board rules changed but the contract fixture was not regenerated. Run:\n"
        "  ./venv/bin/python3 scripts/gen_aito_board_rules_fixture.py"
    )


def test_evaluate_cases_cover_the_full_product():
    """A generator that silently stopped enumerating would let the mirror pass
    on a subset. Pin the size too."""
    committed = json.loads(FIXTURE.read_text())
    assert len(committed["evaluate"]) == 8 * 7 * 16
```

- [ ] **Step 5: Run it**

```bash
./venv/bin/python3 -m pytest backend/tests/unit/test_aito_board_rules_contract.py -v
```

Expected: 2 passed.

- [ ] **Step 6: Prove the pin actually bites**

Temporarily break the rules to confirm the test is not vacuous. Edit `backend/app/services/aito_board_rules.py` and change `return "done", "declined"` to `return "finish", "declined"`, then:

```bash
./venv/bin/python3 -m pytest backend/tests/unit/test_aito_board_rules_contract.py -v
```

Expected: FAIL on `test_fixture_matches_the_current_rules`. **Revert the edit** and re-run to confirm it passes again.

- [ ] **Step 7: Rewrite the module docstring**

In `backend/app/services/aito_board_rules.py`, replace the opening docstring. The old text forbids mirroring; that is no longer the arrangement:

```python
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
```

- [ ] **Step 8: Commit**

```bash
ruff check backend/ scripts/gen_aito_board_rules_fixture.py && ruff format --check backend/ scripts/gen_aito_board_rules_fixture.py
./venv/bin/python3 -m pytest backend/tests/unit -k aito -q
git add backend/tests/aito_rules_fixture.py scripts/gen_aito_board_rules_fixture.py \
        frontend/src/__tests__/fixtures/aitoBoardRules.cases.json \
        backend/tests/unit/test_aito_board_rules_contract.py \
        backend/app/services/aito_board_rules.py
git commit -m "test(aito): pin the board rules with a generated contract fixture"
```

---

### Task 4: The TypeScript mirror

**Files:**
- Create: `frontend/src/utils/aitoBoardRules.ts`
- Create: `frontend/src/__tests__/utils/aitoBoardRules.test.ts`
- Modify: `frontend/src/components/aito/services.ts:36-43`
- Modify: `frontend/src/utils/taskDraft.ts:189-204`

**Interfaces:**
- Consumes: the fixture from Task 3.
- Produces:
  - `type ServiceId = 'scan' | 'modelisation' | 'impression' | 'usinage'`
  - `type MoveLock = 'quote' | 'waiting' | 'declined' | 'steps' | null`
  - `const SERVICES: readonly ServiceId[]`, `const COLUMN_ORDER: readonly AitoColumnId[]`, `const AWAY_STATUSES: ReadonlySet<string>`
  - `interface TaskLike { scanCost: number|null; modelisationCost: number|null; impressionCost: number|null; usinageCost: number|null; done: Record<ServiceId, boolean> }`
  - `evaluate(quoteStatus: string|null, storedColumn: AitoColumnId, pending: readonly string[]): [AitoColumnId, MoveLock]`
  - `interface TaskSummary { count: number; total: number; services: ServiceId[]; pending: ServiceId[]; stepsTotal: number; stepsDone: number }`
  - `summariseTasks(tasks: readonly TaskLike[]): TaskSummary`
  - `taskCost(task: TaskLike, service: ServiceId): number | null`

**Import direction matters.** This module imports nothing from `services.ts` or `taskDraft.ts` — only `import type { AitoColumnId } from '../api/client'`. Both of those import *from* it. Reaching the other way would create `aitoBoardRules → services → taskDraft → aitoBoardRules`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/__tests__/utils/aitoBoardRules.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import cases from '../fixtures/aitoBoardRules.cases.json';
import { evaluate, summariseTasks } from '../../utils/aitoBoardRules';
import type { ServiceId, TaskLike } from '../../utils/aitoBoardRules';
import type { AitoColumnId } from '../../api/client';

interface EvaluateCase {
  quote_status: string | null;
  stored_column: string;
  pending: string[];
  column: string;
  move_lock: string | null;
}

interface SummariseCase {
  name: string;
  tasks: Record<string, number | boolean | null>[];
  count: number;
  total: number;
  services: string[];
  pending: string[];
  steps_total: number;
  steps_done: number;
}

const SERVICE_IDS: ServiceId[] = ['scan', 'modelisation', 'impression', 'usinage'];

/** The fixture's wire shape -> the client shape the mirror consumes. */
function toTaskLike(row: Record<string, number | boolean | null>): TaskLike {
  return {
    scanCost: row.scan_cost as number | null,
    modelisationCost: row.modelisation_cost as number | null,
    impressionCost: row.impression_cost as number | null,
    usinageCost: row.usinage_cost as number | null,
    done: {
      scan: row.scan_done === true,
      modelisation: row.modelisation_done === true,
      impression: row.impression_done === true,
      usinage: row.usinage_done === true,
    },
  };
}

describe('the board-rules contract', () => {
  const evaluateCases = cases.evaluate as EvaluateCase[];
  const summariseCases = cases.summarise as SummariseCase[];

  it('has the full evaluate product loaded', () => {
    // Guards against an empty or truncated fixture quietly passing the loop
    // below by iterating zero times.
    expect(evaluateCases).toHaveLength(8 * 7 * 16);
    expect(summariseCases.length).toBeGreaterThan(0);
  });

  it('reproduces every evaluate case', () => {
    const mismatches = evaluateCases.filter((c) => {
      const [column, lock] = evaluate(c.quote_status, c.stored_column as AitoColumnId, c.pending);
      return column !== c.column || lock !== c.move_lock;
    });
    // Report the case itself, not just a count — a bare "expected 3 to be 0"
    // says nothing about which rule drifted.
    expect(mismatches).toEqual([]);
  });

  it.each(SERVICE_IDS)('treats %s consistently in both directions', (service) => {
    // A priced service is pending until ticked; an unpriced one never is.
    const priced = { ...blank(), [`${service}Cost`]: 0 } as unknown as TaskLike;
    expect(summariseTasks([priced]).pending).toContain(service);
    expect(summariseTasks([blank()]).pending).not.toContain(service);
  });

  it.each(
    (cases.summarise as SummariseCase[]).map((c) => [c.name, c] as const),
  )('reproduces summarise: %s', (_name, c) => {
    const summary = summariseTasks(c.tasks.map(toTaskLike));
    expect(summary.count).toBe(c.count);
    expect(summary.total).toBeCloseTo(c.total, 10);
    expect(summary.services).toEqual(c.services);
    expect(summary.pending).toEqual(c.pending);
    expect(summary.stepsTotal).toBe(c.steps_total);
    expect(summary.stepsDone).toBe(c.steps_done);
  });
});

function blank(): TaskLike {
  return {
    scanCost: null,
    modelisationCost: null,
    impressionCost: null,
    usinageCost: null,
    done: { scan: false, modelisation: false, impression: false, usinage: false },
  };
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd frontend && npx vitest run src/__tests__/utils/aitoBoardRules.test.ts; cd ..
```

Expected: FAIL — cannot resolve `../../utils/aitoBoardRules`.

- [ ] **Step 3: Write the mirror**

Create `frontend/src/utils/aitoBoardRules.ts`:

```ts
import type { AitoColumnId } from '../api/client';

/** The Aito board's rules, mirrored from
 *  backend/app/services/aito_board_rules.py.
 *
 *  A mirror exists because the board is optimistic: a card must move the
 *  instant a step is ticked or a quote is accepted, which means predicting the
 *  column locally rather than waiting to be told it.
 *
 *  This mirror is NOT maintained by discipline. It is pinned by a generated
 *  contract fixture — see backend/tests/aito_rules_fixture.py. Change the
 *  Python and the backend test fails until the fixture is regenerated;
 *  regenerate it and this file's test fails until it is brought back in line.
 *
 *  Imports nothing local but a type. `services.ts` and `taskDraft.ts` both
 *  import FROM here; importing either of them back would close a cycle. */

export type ServiceId = 'scan' | 'modelisation' | 'impression' | 'usinage';
export type MoveLock = 'quote' | 'waiting' | 'declined' | 'steps' | null;

/** Board order, left to right. */
export const COLUMN_ORDER: readonly AitoColumnId[] = [
  'devis',
  'waiting',
  'scan',
  'model',
  'print',
  'finish',
  'done',
];

/** Canonical service order — every derived list is emitted in it, so a badge
 *  row is stable across refetches regardless of task creation order. */
export const SERVICES: readonly ServiceId[] = ['scan', 'modelisation', 'impression', 'usinage'];

/** Statuses meaning the quote has left the shop: the answer is the client's to
 *  give, not ours to write. `viewed` only says they opened it and `expired`
 *  says they never answered — both are still waiting on them. */
export const AWAY_STATUSES: ReadonlySet<string> = new Set(['sent', 'viewed', 'expired']);

/** Which services each work stage covers, in board order. Printing and
 *  machining share one column while remaining two separate steps on a task:
 *  the column is left only once BOTH are ticked everywhere they appear. */
const STAGES: readonly (readonly [AitoColumnId, readonly ServiceId[]])[] = [
  ['scan', ['scan']],
  ['model', ['modelisation']],
  ['print', ['impression', 'usinage']],
];

/** The minimum a task must expose for these rules to read it. Structural, not
 *  `TaskDraft`, for the same reason the Python is duck-typed: it keeps this
 *  module free of any dependency that could cycle back into it. */
export interface TaskLike {
  scanCost: number | null;
  modelisationCost: number | null;
  impressionCost: number | null;
  usinageCost: number | null;
  done: Record<ServiceId, boolean>;
}

const COST_KEYS: Record<ServiceId, keyof TaskLike> = {
  scan: 'scanCost',
  modelisation: 'modelisationCost',
  impression: 'impressionCost',
  usinage: 'usinageCost',
};

/** One service's cost, or null when the service is absent from the job.
 *  `0` is a real cost — a step quoted free. */
export function taskCost(task: TaskLike, service: ServiceId): number | null {
  return task[COST_KEYS[service]] as number | null;
}

/** The whole rule set: `[column, moveLock]`.
 *
 *  `moveLock` names why the card cannot be dragged between columns, and is
 *  null only when it can (Finish <-> Done).
 *
 *  Rule ORDER matters twice, and is the part a data-driven version could not
 *  express. Waiting outranks the steps, so ticking a step on a card that is
 *  out with the client moves nothing — the work is not authorised yet. And the
 *  stage search runs before the nothing-left-to-do fallback, which is what
 *  evicts a card from Done the moment any step is re-opened; swapped,
 *  un-ticking would leave it parked in Done forever. */
export function evaluate(
  quoteStatus: string | null,
  storedColumn: AitoColumnId,
  pending: readonly string[],
): [AitoColumnId, MoveLock] {
  if (quoteStatus === 'declined') return ['done', 'declined'];
  if (quoteStatus !== null && AWAY_STATUSES.has(quoteStatus)) return ['waiting', 'waiting'];
  if (quoteStatus !== 'accepted') {
    // null included: a hand-made card with no Zoho quote waits for Accept
    // exactly like a draft does. Acceptance is the single gate.
    return ['devis', 'quote'];
  }

  const pendingSet = new Set(pending);
  for (const [stage, services] of STAGES) {
    if (services.some((service) => pendingSet.has(service))) return [stage, 'steps'];
  }

  // Nothing left to do. This is the ONLY place the stored column is believed,
  // and only between Finish and Done — which is what makes that one manual
  // drag possible inside an otherwise fully derived model.
  return [storedColumn === 'done' ? 'done' : 'finish', null];
}

export interface TaskSummary {
  count: number;
  total: number;
  services: ServiceId[];
  pending: ServiceId[];
  stepsTotal: number;
  stepsDone: number;
}

/** Everything a project's tasks say about it, in one pass.
 *
 *  A cost of null means the service is absent from the job and is skipped
 *  entirely; 0 means it is quoted free, which is a real step that must show
 *  its badge, hold its column and count toward the progress bar.
 *
 *  `stepsTotal`/`stepsDone` count (task, service) PAIRS, not services: two
 *  tasks each carrying a scan are two steps, where `services` reports 'scan'
 *  once. */
export function summariseTasks(tasks: readonly TaskLike[]): TaskSummary {
  let total = 0;
  let stepsTotal = 0;
  let stepsDone = 0;
  const enabled = new Set<ServiceId>();
  const unticked = new Set<ServiceId>();

  for (const task of tasks) {
    for (const service of SERVICES) {
      const cost = taskCost(task, service);
      if (cost === null) continue;
      enabled.add(service);
      total += cost;
      stepsTotal += 1;
      if (task.done[service]) stepsDone += 1;
      else unticked.add(service);
    }
  }

  return {
    count: tasks.length,
    total,
    services: SERVICES.filter((service) => enabled.has(service)),
    pending: SERVICES.filter((service) => unticked.has(service)),
    stepsTotal,
    stepsDone,
  };
}
```

- [ ] **Step 4: Allow JSON imports if needed**

```bash
cd frontend && npx vitest run src/__tests__/utils/aitoBoardRules.test.ts; cd ..
```

Expected: PASS. If the JSON import errors with "resolveJsonModule", add `"resolveJsonModule": true` to `compilerOptions` in `frontend/tsconfig.app.json` and re-run.

- [ ] **Step 5: Re-point `services.ts` at the shared `ServiceId`**

In `frontend/src/components/aito/services.ts`, replace the local declaration (line ~36) and the `SERVICE_IDS`/`COSTS` block (lines ~38-50) so there is one definition of each:

```ts
import { SERVICES, taskCost } from '../../utils/aitoBoardRules';
import type { ServiceId } from '../../utils/aitoBoardRules';

export type { ServiceId };
```

Then rewrite `taskSteps` to use them, deleting `SERVICE_IDS` and `COSTS`:

```ts
/** The task's steps, in canonical order — one per service whose cost is set.
 *  A cost of 0 is a step quoted free, not an absent one, so membership is a
 *  null check and never a truthiness test. */
export function taskSteps(task: TaskDraft): { service: ServiceId; cost: number; done: boolean }[] {
  return SERVICES.filter((service) => taskCost(task, service) !== null).map((service) => ({
    service,
    cost: taskCost(task, service) as number,
    done: task.done[service],
  }));
}
```

`TaskDraft` structurally satisfies `TaskLike`, so it passes to `taskCost` with no cast.

- [ ] **Step 6: Delegate `taskTotal`**

In `frontend/src/utils/taskDraft.ts`, replace `orZero` and `taskTotal` (lines ~189-200):

```ts
import { summariseTasks } from './aitoBoardRules';

/** Sums a task's four cost fields, treating a disabled service (null) as 0.
 *
 *  Delegates to the mirrored rule engine rather than re-adding the fields:
 *  this figure has to agree with `TaskSummary.total` in
 *  backend/app/services/aito_board_rules.py, and going through the mirror is
 *  what puts it under the contract fixture instead of under a comment. */
export function taskTotal(task: TaskDraft): number {
  return summariseTasks([task]).total;
}

export function projectTotal(tasks: TaskDraft[]): number {
  return summariseTasks(tasks).total;
}
```

Delete the now-unused `const orZero`.

- [ ] **Step 7: Full gate and commit**

```bash
cd frontend && npm run build && cd ..
./test_frontend.sh
```

Expected: all pass. If `hasPricedService` tests fail, note it still reads the draft's fields directly and is unchanged — investigate rather than editing tests.

```bash
git add -A
git commit -m "feat(aito): mirror the board rules in TypeScript, pinned by the fixture"
```

---

## Stage 2 — The optimistic layer

### Task 5: The pure cache transforms

**Files:**
- Create: `frontend/src/utils/aitoOptimistic.ts`
- Create: `frontend/src/__tests__/utils/aitoOptimistic.test.ts`

**Interfaces:**
- Consumes: `evaluate`, `summariseTasks`, `TaskSummary`, `TaskLike` from Task 4.
- Produces:
  - `nextPlaceholderId(): number` — module-level counter, returns -1, -2, …
  - `isPlaceholder(project: AitoProject): boolean`
  - `applyQuoteStatus(projects, id, status: string): AitoProject[]`
  - `applyTaskSummary(projects, id, summary: TaskSummary): AitoProject[]`
  - `applyDescription(projects, id, description: string): AitoProject[]`
  - `applyDelete(projects, id): AitoProject[]`
  - `applyInsert(projects, project: AitoProject): AitoProject[]`
  - `applySyncState(projects, id, state: AitoProject['quote_sync_state']): AitoProject[]`

  All take `projects: AitoProject[] | undefined` and return `AitoProject[]` (empty array when given undefined). All are pure.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/__tests__/utils/aitoOptimistic.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  applyDelete,
  applyDescription,
  applyInsert,
  applyQuoteStatus,
  applyTaskSummary,
  isPlaceholder,
  nextPlaceholderId,
} from '../../utils/aitoOptimistic';
import type { AitoProject } from '../../api/client';

const card = (over: Partial<AitoProject> = {}): AitoProject => ({
  id: 1,
  description: 'card',
  column: 'devis',
  position: 0,
  status: 'active',
  client_id: null,
  client_name: null,
  client_phone: null,
  client_email: null,
  client_is_company: null,
  quote_id: null,
  quote_number: null,
  quote_date: null,
  quote_total: null,
  quote_url: null,
  quote_salesperson: null,
  quote_status: null,
  quote_sync_state: 'idle',
  quote_sync_error: null,
  quote_status_block: null,
  quote_status_remote: null,
  created_by: null,
  task_count: 0,
  tasks_total: 0,
  task_services: [],
  steps_total: 0,
  steps_done: 0,
  move_lock: 'quote',
  created_at: '2026-07-01T10:00:00Z',
  updated_at: '2026-07-01T10:00:00Z',
  ...over,
});

const find = (projects: AitoProject[], id: number) => projects.find((p) => p.id === id)!;

describe('applyQuoteStatus', () => {
  it('relocates an accepted card to its first pending stage', () => {
    const before = [card({ id: 1, column: 'devis', position: 0, task_services: ['impression'] })];
    // pending is derived from the card's own summary; a card with one unticked
    // impression step lands in print.
    const after = applyQuoteStatus(
      [{ ...before[0], steps_total: 1, steps_done: 0 }],
      1,
      'accepted',
    );
    expect(find(after, 1).column).toBe('print');
    expect(find(after, 1).quote_status).toBe('accepted');
    expect(find(after, 1).move_lock).toBe('steps');
  });

  it('sends a declined card to done', () => {
    const after = applyQuoteStatus([card({ id: 1 })], 1, 'declined');
    expect(find(after, 1).column).toBe('done');
    expect(find(after, 1).move_lock).toBe('declined');
  });

  it('appends to the END of the destination column', () => {
    const projects = [
      card({ id: 1, column: 'devis', position: 0 }),
      card({ id: 2, column: 'waiting', position: 0 }),
      card({ id: 3, column: 'waiting', position: 1 }),
    ];
    const after = applyQuoteStatus(projects, 1, 'sent');
    expect(find(after, 1).column).toBe('waiting');
    expect(find(after, 1).position).toBe(2);
  });

  it('renumbers the source column contiguously', () => {
    const projects = [
      card({ id: 1, column: 'devis', position: 0 }),
      card({ id: 2, column: 'devis', position: 1 }),
      card({ id: 3, column: 'devis', position: 2 }),
    ];
    const after = applyQuoteStatus(projects, 2, 'sent');
    expect(find(after, 1).position).toBe(0);
    expect(find(after, 3).position).toBe(1);
  });

  it('does not renumber when the column does not change', () => {
    // draft -> sent moves; null -> draft would not. Use a card already in
    // waiting being re-marked sent.
    const projects = [
      card({ id: 1, column: 'waiting', position: 0, quote_status: 'viewed' }),
      card({ id: 2, column: 'waiting', position: 1, quote_status: 'sent' }),
    ];
    const after = applyQuoteStatus(projects, 1, 'sent');
    expect(find(after, 1).position).toBe(0);
    expect(find(after, 2).position).toBe(1);
  });

  it('leaves other projects untouched', () => {
    const projects = [card({ id: 1 }), card({ id: 2, column: 'print', position: 0 })];
    const after = applyQuoteStatus(projects, 1, 'sent');
    expect(find(after, 2)).toEqual(find(projects, 2));
  });

  it('is a no-op for an unknown id', () => {
    const projects = [card({ id: 1 })];
    expect(applyQuoteStatus(projects, 99, 'sent')).toEqual(projects);
  });

  it('returns an empty array for undefined input', () => {
    expect(applyQuoteStatus(undefined, 1, 'sent')).toEqual([]);
  });
});

describe('applyTaskSummary', () => {
  it('writes the counters and relocates on the new pending set', () => {
    const projects = [
      card({ id: 1, column: 'scan', position: 0, quote_status: 'accepted', move_lock: 'steps' }),
    ];
    const after = applyTaskSummary(projects, 1, {
      count: 2,
      total: 150,
      services: ['scan', 'impression'],
      pending: ['impression'],
      stepsTotal: 4,
      stepsDone: 3,
    });
    const updated = find(after, 1);
    expect(updated.task_count).toBe(2);
    expect(updated.tasks_total).toBe(150);
    expect(updated.task_services).toEqual(['scan', 'impression']);
    expect(updated.steps_total).toBe(4);
    expect(updated.steps_done).toBe(3);
    expect(updated.column).toBe('print');
  });

  it('sends a fully ticked accepted project to finish', () => {
    const projects = [card({ id: 1, column: 'print', quote_status: 'accepted' })];
    const after = applyTaskSummary(projects, 1, {
      count: 1,
      total: 10,
      services: ['impression'],
      pending: [],
      stepsTotal: 1,
      stepsDone: 1,
    });
    expect(find(after, 1).column).toBe('finish');
    expect(find(after, 1).move_lock).toBeNull();
  });

  it('does not move an unaccepted project however many steps are ticked', () => {
    const projects = [card({ id: 1, column: 'devis', quote_status: 'draft' })];
    const after = applyTaskSummary(projects, 1, {
      count: 1,
      total: 10,
      services: ['scan'],
      pending: [],
      stepsTotal: 1,
      stepsDone: 1,
    });
    expect(find(after, 1).column).toBe('devis');
  });
});

describe('applyDescription', () => {
  it('replaces the description and nothing else', () => {
    const after = applyDescription([card({ id: 1, description: 'old' })], 1, 'new');
    expect(find(after, 1).description).toBe('new');
    expect(find(after, 1).column).toBe('devis');
  });
});

describe('applyDelete', () => {
  it('removes the card and renumbers its column', () => {
    const projects = [
      card({ id: 1, column: 'devis', position: 0 }),
      card({ id: 2, column: 'devis', position: 1 }),
      card({ id: 3, column: 'devis', position: 2 }),
    ];
    const after = applyDelete(projects, 2);
    expect(after.map((p) => p.id)).toEqual([1, 3]);
    expect(find(after, 3).position).toBe(1);
  });

  it('leaves other columns alone', () => {
    const projects = [
      card({ id: 1, column: 'devis', position: 0 }),
      card({ id: 2, column: 'print', position: 5 }),
    ];
    expect(find(applyDelete(projects, 1), 2).position).toBe(5);
  });
});

describe('applyInsert', () => {
  it('appends to the end of its column', () => {
    const projects = [card({ id: 1, column: 'devis', position: 0 })];
    const after = applyInsert(projects, card({ id: -1, column: 'devis', position: 999 }));
    expect(find(after, -1).position).toBe(1);
  });
});

describe('placeholder identity', () => {
  it('hands out distinct negative ids', () => {
    const a = nextPlaceholderId();
    const b = nextPlaceholderId();
    expect(a).toBeLessThan(0);
    expect(b).toBeLessThan(0);
    expect(a).not.toBe(b);
  });

  it('recognises a placeholder and a real row', () => {
    expect(isPlaceholder(card({ id: -1 }))).toBe(true);
    expect(isPlaceholder(card({ id: 42 }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd frontend && npx vitest run src/__tests__/utils/aitoOptimistic.test.ts; cd ..
```

Expected: FAIL — cannot resolve `../../utils/aitoOptimistic`.

- [ ] **Step 3: Write the transforms**

Create `frontend/src/utils/aitoOptimistic.ts`:

```ts
import { evaluate } from './aitoBoardRules';
import type { TaskSummary } from './aitoBoardRules';
import type { AitoProject } from '../api/client';

/** Pure optimistic transforms over the `['aito-projects']` cache.
 *
 *  Every function here is `AitoProject[] -> AitoProject[]`: no React, no query
 *  client, no network. That is deliberate and load-bearing — it is what makes
 *  the whole optimistic layer unit-testable without mounting a modal, which
 *  the previous generation of this code (see useProjectTasks' docstring) was
 *  not.
 *
 *  Each transform reproduces what the SERVER does, `_apply_rules` in
 *  backend/app/api/routes/aito.py included: recompute the column, and when it
 *  changes, append the project to the END of its destination column and
 *  renumber the source contiguously. Getting the relocation wrong is not a
 *  correctness risk — the settle-invalidate corrects it one round trip later —
 *  but getting it right is what stops the card visibly jumping twice. */

// Module-level, not per-hook: board create, quote import and trash restore can
// all have placeholders outstanding at once, and a per-surface counter would
// hand two of them the same id. Negative is a space real ids never occupy.
let placeholderCounter = 0;

export function nextPlaceholderId(): number {
  placeholderCounter -= 1;
  return placeholderCounter;
}

/** A row the server has not acknowledged yet. Such a card renders inert — no
 *  grip, no expand, no actions — because its id does not exist yet, and
 *  letting a user edit against it is the one way optimistic creates actually
 *  corrupt state. */
export function isPlaceholder(project: AitoProject): boolean {
  return project.id < 0;
}

/** `_apply_rules`, in TypeScript: relocate `moved` into `column` and renumber
 *  both affected columns. Returns the full list, order-insensitive — the board
 *  is grouped and sorted by `buildBoard` downstream. */
function relocate(projects: AitoProject[], moved: AitoProject, column: AitoProject['column']): AitoProject[] {
  if (moved.column === column) return projects;

  const source = moved.column;
  const destinationCount = projects.filter((p) => p.column === column && p.id !== moved.id).length;
  const relocated = { ...moved, column, position: destinationCount };

  let sourceIndex = 0;
  return projects.map((project) => {
    if (project.id === moved.id) return relocated;
    if (project.column !== source) return project;
    const position = sourceIndex;
    sourceIndex += 1;
    return project.position === position ? project : { ...project, position };
  });
}

/** Recompute a project's column and lock from the rules, then relocate.
 *  `pending` comes from the caller because only it knows whether the tasks
 *  changed; passing the card's own state through unchanged is correct for
 *  transforms that touch nothing task-shaped. */
function reevaluate(projects: AitoProject[], updated: AitoProject, pending: readonly string[]): AitoProject[] {
  const [column, lock] = evaluate(updated.quote_status, updated.column, pending);
  const withLock = { ...updated, move_lock: lock };
  const next = projects.map((p) => (p.id === withLock.id ? withLock : p));
  return relocate(next, withLock, column);
}

/** The card's own pending set, inferred from its summary counters.
 *
 *  `AitoProject` carries `task_services` (the union of ENABLED services) but
 *  not `pending`, so an exact set is not recoverable from a card alone. For a
 *  transform that does not change the tasks — a quote-status change — the only
 *  thing the rules need to know is whether anything is still unticked, and
 *  `steps_done < steps_total` answers that exactly. When work remains, the
 *  enabled services stand in for the pending ones, which lands the card in the
 *  first stage that has any of them: the same answer the server gives whenever
 *  the earliest enabled service is also unticked, and one refetch from correct
 *  otherwise. */
function inferredPending(project: AitoProject): string[] {
  return project.steps_done < project.steps_total ? project.task_services : [];
}

export function applyQuoteStatus(
  projects: AitoProject[] | undefined,
  id: number,
  status: string,
): AitoProject[] {
  if (!projects) return [];
  const target = projects.find((p) => p.id === id);
  if (!target) return projects;
  const updated = { ...target, quote_status: status };
  return reevaluate(projects, updated, inferredPending(updated));
}

export function applyTaskSummary(
  projects: AitoProject[] | undefined,
  id: number,
  summary: TaskSummary,
): AitoProject[] {
  if (!projects) return [];
  const target = projects.find((p) => p.id === id);
  if (!target) return projects;
  const updated: AitoProject = {
    ...target,
    task_count: summary.count,
    tasks_total: summary.total,
    task_services: [...summary.services],
    steps_total: summary.stepsTotal,
    steps_done: summary.stepsDone,
  };
  return reevaluate(projects, updated, summary.pending);
}

export function applyDescription(
  projects: AitoProject[] | undefined,
  id: number,
  description: string,
): AitoProject[] {
  if (!projects) return [];
  return projects.map((p) => (p.id === id ? { ...p, description } : p));
}

export function applySyncState(
  projects: AitoProject[] | undefined,
  id: number,
  state: AitoProject['quote_sync_state'],
): AitoProject[] {
  if (!projects) return [];
  return projects.map((p) => (p.id === id ? { ...p, quote_sync_state: state } : p));
}

export function applyDelete(projects: AitoProject[] | undefined, id: number): AitoProject[] {
  if (!projects) return [];
  const target = projects.find((p) => p.id === id);
  if (!target) return projects;
  let position = 0;
  return projects
    .filter((p) => p.id !== id)
    .map((project) => {
      if (project.column !== target.column) return project;
      const next = position;
      position += 1;
      return project.position === next ? project : { ...project, position: next };
    });
}

/** Append a card to the end of its own column. Used by create, import and
 *  restore, all of which land a row the list has never seen. */
export function applyInsert(projects: AitoProject[] | undefined, project: AitoProject): AitoProject[] {
  const list = projects ?? [];
  const count = list.filter((p) => p.column === project.column).length;
  return [...list, { ...project, position: count }];
}
```

- [ ] **Step 4: Run the tests**

```bash
cd frontend && npx vitest run src/__tests__/utils/aitoOptimistic.test.ts; cd ..
```

Expected: PASS, all describes green.

- [ ] **Step 5: Commit**

```bash
cd frontend && npm run build && cd ..
git add frontend/src/utils/aitoOptimistic.ts frontend/src/__tests__/utils/aitoOptimistic.test.ts
git commit -m "feat(aito): pure optimistic transforms over the board cache"
```

---

### Task 6: The shared board-sync counter

**Files:**
- Create: `frontend/src/hooks/useBoardSync.ts`
- Modify: `frontend/src/hooks/useBoardDrag.ts:53-113,181-229,242-257`

**Interfaces:**
- Consumes: nothing.
- Produces: `useBoardSync(): { generation: number; begin(): void; settle(queryClient: QueryClient): void; resyncIfIdle(queryClient: QueryClient): void; isIdle(): boolean }`
  - `begin()` increments the in-flight count.
  - `settle(queryClient)` decrements, bumps the generation, and invalidates `['aito-projects']` **only when the count reaches 0**.
  - `resyncIfIdle(queryClient)` invalidates only when the count is 0.
  - `isIdle()` reads the count. `begin`, `settle`, `resyncIfIdle` and `isIdle` are all `useCallback([])` and therefore stable across renders — the returned *object* is not, so never put it in a dependency array.
  - `__resetBoardSync()` is exported for tests only; module state survives between tests in one file.

**Why shared, not per-hook.** `useBoardDrag` rebuilds its local `board` from `projects` whenever no move is pending. A quote-status change landing mid-drag-settle would rebuild from stale data unless both mutations feed the same counter. The counter must therefore be module-level state, not per-hook state.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/__tests__/hooks/useBoardSync.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { useBoardSync, __resetBoardSync } from '../../hooks/useBoardSync';

describe('useBoardSync', () => {
  beforeEach(() => __resetBoardSync());

  it('invalidates only when the last in-flight write settles', () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockImplementation(() => Promise.resolve());
    const { result } = renderHook(() => useBoardSync());

    act(() => {
      result.current.begin();
      result.current.begin();
    });
    act(() => result.current.settle(client));
    expect(invalidate).not.toHaveBeenCalled();

    act(() => result.current.settle(client));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['aito-projects'] });
  });

  it('bumps the generation on every settle, not just the last', () => {
    const client = new QueryClient();
    vi.spyOn(client, 'invalidateQueries').mockImplementation(() => Promise.resolve());
    const { result } = renderHook(() => useBoardSync());
    const first = result.current.generation;

    act(() => {
      result.current.begin();
      result.current.begin();
    });
    act(() => result.current.settle(client));
    expect(result.current.generation).not.toBe(first);
  });

  it('resyncIfIdle does nothing while a write is in flight', () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockImplementation(() => Promise.resolve());
    const { result } = renderHook(() => useBoardSync());

    act(() => result.current.begin());
    act(() => result.current.resyncIfIdle(client));
    expect(invalidate).not.toHaveBeenCalled();

    act(() => result.current.settle(client));
    invalidate.mockClear();
    act(() => result.current.resyncIfIdle(client));
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it('shares the count across separate hook instances', () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockImplementation(() => Promise.resolve());
    const a = renderHook(() => useBoardSync());
    const b = renderHook(() => useBoardSync());

    act(() => a.result.current.begin());
    act(() => b.result.current.settle(client));
    expect(invalidate).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd frontend && npx vitest run src/__tests__/hooks/useBoardSync.test.tsx; cd ..
```

Expected: FAIL — cannot resolve `../../hooks/useBoardSync`.

- [ ] **Step 3: Write the hook**

Create `frontend/src/hooks/useBoardSync.ts`:

```ts
import { useCallback, useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';

/** The board's write arbitration, shared by every mutation that touches
 *  `['aito-projects']`.
 *
 *  Two rules, both moved here from `useBoardDrag`, which discovered both:
 *
 *  ONLY THE LAST WRITE TO SETTLE INVALIDATES. Invalidating while another write
 *  is still queued or in flight lets the resulting GET — which predates that
 *  write — overwrite its optimistic cache entry. The last settle always
 *  invalidates, so nothing is left stale.
 *
 *  THE GENERATION BUMPS ON EVERY SETTLE. `useBoardDrag` rebuilds its local
 *  drag board from the query data only when nothing is pending; the bump is
 *  what lets a rebuild that was skipped while blocked re-run once things go
 *  quiet, even on a render where the query data's identity never changed.
 *
 *  MODULE-LEVEL, not per-hook. A quote-status change landing mid-drag-settle
 *  would rebuild the drag board from stale data if the two hooks kept separate
 *  counters. Every consumer must see the same number. */

let pendingWrites = 0;
let generation = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: module state survives between tests in one file. */
export function __resetBoardSync() {
  pendingWrites = 0;
  generation = 0;
  emit();
}

export function useBoardSync() {
  const currentGeneration = useSyncExternalStore(
    subscribe,
    () => generation,
    () => generation,
  );

  const begin = useCallback(() => {
    pendingWrites += 1;
  }, []);

  const settle = useCallback((queryClient: QueryClient) => {
    // Must not throw: on the success path React Query runs onSettled inside
    // the same try as the mutationFn, so a throw here re-runs onError +
    // onSettled and double-decrements.
    pendingWrites = Math.max(0, pendingWrites - 1);
    generation += 1;
    emit();
    if (pendingWrites === 0) {
      queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
    }
  }, []);

  const resyncIfIdle = useCallback((queryClient: QueryClient) => {
    if (pendingWrites > 0) return;
    queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
  }, []);

  const isIdle = useCallback(() => pendingWrites === 0, []);

  return { generation: currentGeneration, begin, settle, resyncIfIdle, isIdle };
}
```

- [ ] **Step 4: Run the tests**

```bash
cd frontend && npx vitest run src/__tests__/hooks/useBoardSync.test.tsx; cd ..
```

Expected: PASS.

- [ ] **Step 5: Adopt it in `useBoardDrag`**

In `frontend/src/hooks/useBoardDrag.ts`:

1. Add the import: `import { useBoardSync } from './useBoardSync';`
2. Delete `const pendingMoves = useRef(0);` and `const [syncGeneration, setSyncGeneration] = useState(0);`
3. Add the hook, **destructured**: `const { generation, begin, settle, resyncIfIdle, isIdle } = useBoardSync();`

   Destructure rather than keeping `boardSync` whole. `useBoardSync()` returns a fresh object literal every render, so `boardSync` in a dependency array would re-run the effect on every render — an infinite resync loop. The individual functions are `useCallback([])` and genuinely stable.

4. The sync effect (line ~67) becomes:

```ts
  useEffect(() => {
    if (!projects) return;
    if (activeId !== null) return;
    if (!isIdle()) return;
    setBoard(buildBoard(projects));
  }, [projects, activeId, generation, isIdle]);
```

5. `moveMutation.onSettled` becomes:

```ts
    onSettled: () => {
      settle(queryClient);
    },
```

6. Replace every `if (pendingMoves.current === 0) { queryClient.invalidateQueries({ queryKey: ['aito-projects'] }); }` block — three of them, in `handleDragEnd`'s no-`over` branch, its `resync` branch, and `onDragCancel` — with:

```ts
      resyncIfIdle(queryClient);
```

7. Replace `pendingMoves.current += 1;` before `moveMutation.mutate(...)` with `begin();`
8. Widen the mutation scope: `scope: { id: 'aito-board' },` — keep the existing comment and add a line:

```ts
    // Widened from 'aito-move' to cover every mutation that writes
    // ['aito-projects'] — quote status, delete, restore, create — not just
    // drags. Two overlapping writes otherwise race the endpoint, and the
    // second's prediction (computed against a board that assumed the first had
    // landed) can be persisted first.
    scope: { id: 'aito-board' },
```

9. Remove now-unused imports (`useState` may still be needed for `board`/`activeId` — check before deleting).

- [ ] **Step 6: Run the drag suites**

```bash
cd frontend && npx vitest run src/__tests__/pages/AitoPageDragLock.test.tsx src/__tests__/components/AitoBoardColumnDrag.test.tsx src/__tests__/pages/AitoPage.test.tsx; cd ..
```

Expected: PASS, unchanged behaviour.

- [ ] **Step 7: Full gate and commit**

```bash
cd frontend && npm run build && cd ..
./test_frontend.sh
git add -A
git commit -m "refactor(aito): share the board's write arbitration across every writer"
```

---

### Task 7: The revert flash

**Files:**
- Create: `frontend/src/hooks/useRevertFlash.ts`
- Modify: `frontend/src/index.css` (append near the `rise` utility, around line 655)
- Modify: `frontend/src/components/aito/BoardColumn.tsx:46-61`

**Interfaces:**
- Consumes: nothing.
- Produces: `flashRevert(id: number): void` (imperative, callable outside React) and `useIsReverting(id: number): boolean`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/__tests__/hooks/useRevertFlash.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { flashRevert, useIsReverting } from '../../hooks/useRevertFlash';

describe('useRevertFlash', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('marks the flashed id and clears it after 600ms', () => {
    const { result } = renderHook(() => useIsReverting(7));
    expect(result.current).toBe(false);

    act(() => flashRevert(7));
    expect(result.current).toBe(true);

    act(() => vi.advanceTimersByTime(600));
    expect(result.current).toBe(false);
  });

  it('does not mark a different id', () => {
    const { result } = renderHook(() => useIsReverting(1));
    act(() => flashRevert(2));
    expect(result.current).toBe(false);
  });

  it('a second flash restarts the window rather than stacking timers', () => {
    const { result } = renderHook(() => useIsReverting(3));
    act(() => flashRevert(3));
    act(() => vi.advanceTimersByTime(400));
    act(() => flashRevert(3));
    act(() => vi.advanceTimersByTime(400));
    // Still inside the restarted window.
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(200));
    expect(result.current).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd frontend && npx vitest run src/__tests__/hooks/useRevertFlash.test.tsx; cd ..
```

Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the hook**

Create `frontend/src/hooks/useRevertFlash.ts`:

```ts
import { useSyncExternalStore } from 'react';

/** "This just snapped back" — a 600 ms marker on one project id.
 *
 *  Optimistic actions make rejection visible as motion: a card jumps back to
 *  Quote, a checkbox un-ticks, a deleted card reappears. A toast alone leaves
 *  that unexplained — the user reads "Save failed", looks at the panel in
 *  front of them, and never notices the card behind it moved. The flash gives
 *  the toast a referent.
 *
 *  A module store rather than a context: `flashRevert` is called from mutation
 *  callbacks, which are not components, and threading a provider through every
 *  hook that owns a mutation would buy nothing. */

const REVERT_FLASH_MS = 600;

let flashedId: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** One id at a time. Two reverts inside one window is a case that does not
 *  happen in practice — the mutations are serialised on a shared scope — and
 *  a per-id map would be state to clean up for no gain. */
export function flashRevert(id: number) {
  if (timer !== null) clearTimeout(timer);
  flashedId = id;
  emit();
  timer = setTimeout(() => {
    flashedId = null;
    timer = null;
    emit();
  }, REVERT_FLASH_MS);
}

export function useIsReverting(id: number): boolean {
  return useSyncExternalStore(
    subscribe,
    () => flashedId === id,
    () => false,
  );
}
```

- [ ] **Step 4: Run the tests**

```bash
cd frontend && npx vitest run src/__tests__/hooks/useRevertFlash.test.tsx; cd ..
```

Expected: PASS.

- [ ] **Step 5: Add the CSS**

Append to `frontend/src/index.css`, immediately after the `.animate-rise` block (around line 657):

```css
/* Aito: a card that just snapped back after the server refused the change.
   Paired with a toast, never alone — see hooks/useRevertFlash.ts. The ring is
   drawn on a wrapper around the card, so it reads as "this card" without
   touching the card's own border, which already carries hover and lock state.
   600ms matches REVERT_FLASH_MS. */
@keyframes aito-revert-flash {
  from { box-shadow: 0 0 0 2px var(--color-status-error, #ef4444); }
  to { box-shadow: 0 0 0 2px transparent; }
}
.animate-revert-flash {
  border-radius: 0.75rem; /* matches the card's rounded-xl */
  animation: aito-revert-flash 0.6s var(--ease-exit) forwards;
}
/* The ring still appears and clears — only the fade is dropped, so the signal
   survives for anyone who has asked for less motion. */
@media (prefers-reduced-motion: reduce) {
  .animate-revert-flash {
    animation: none;
    box-shadow: 0 0 0 2px var(--color-status-error, #ef4444);
  }
}
```

- [ ] **Step 6: Wire it into the card wrapper**

In `frontend/src/components/aito/BoardColumn.tsx`, add the import and read it in `SortableCard`:

```ts
import { useIsReverting } from '../../hooks/useRevertFlash';
```

Inside `SortableCard`, after the `useQuoteStatusMutation` call:

```ts
  // A card that just snapped back. The ring lives on this wrapper rather than
  // on CardView so the DragOverlay clone — which renders CardView directly —
  // never inherits it.
  const reverting = useIsReverting(project.id);
```

And in the wrapper `<div>`'s className:

```tsx
      className={`${animateIn ? 'animate-rise' : ''} ${isDragging ? 'opacity-30' : ''} ${
        reverting ? 'animate-revert-flash' : ''
      }`}
```

- [ ] **Step 7: Record how later tasks must assert on the flash**

Tasks 9, 10 and 12 all assert `flashRevert` was called. **`vi.spyOn` will not work here.** Consumers import the binding directly (`import { flashRevert } from './useRevertFlash'`), and under ESM that binding is resolved at module load — spying on the namespace object afterwards either throws "Cannot redefine property" or silently patches an object nobody reads.

Use `vi.mock` at the top of any test file that asserts on it:

```ts
import { flashRevert } from '../../hooks/useRevertFlash';

vi.mock('../../hooks/useRevertFlash', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useRevertFlash')>()),
  flashRevert: vi.fn(),
}));
```

Then assert with `expect(vi.mocked(flashRevert)).toHaveBeenCalledWith(1);`. Spreading the original keeps `useIsReverting` real, so the component under test still renders normally. Add `vi.mocked(flashRevert).mockClear()` to that file's `beforeEach`.

- [ ] **Step 8: Full gate and commit**

```bash
cd frontend && npm run build && cd ..
./test_frontend.sh
git add -A
git commit -m "feat(aito): flash a card that snapped back, so the toast has a referent"
```

---

### Task 8: The optimistic mutation wrapper

**Files:**
- Create: `frontend/src/hooks/useOptimisticBoardMutation.ts`
- Test: `frontend/src/__tests__/hooks/useOptimisticBoardMutation.test.tsx`

**Interfaces:**
- Consumes: `useBoardSync` (Task 6), `flashRevert` (Task 7).
- Produces:

```ts
interface OptimisticBoardOptions<TData, TVars> {
  mutationFn: (vars: TVars) => Promise<TData>;
  /** The optimistic cache write. Return the next list; return `previous`
   *  unchanged to write nothing. */
  transform: (previous: AitoProject[] | undefined, vars: TVars) => AitoProject[];
  /** Which card to flash if this reverts. Omit for writes with no card. */
  flashId?: (vars: TVars) => number | null;
  onSuccess?: (data: TData, vars: TVars) => void;
  onError?: (error: unknown, vars: TVars) => void;
}
function useOptimisticBoardMutation<TData, TVars>(
  options: OptimisticBoardOptions<TData, TVars>,
): UseMutationResult<TData, unknown, TVars, { previous: AitoProject[] | undefined }>
```

- [ ] **Step 1: Write the failing test**

Create `frontend/src/__tests__/hooks/useOptimisticBoardMutation.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useOptimisticBoardMutation } from '../../hooks/useOptimisticBoardMutation';
import { __resetBoardSync } from '../../hooks/useBoardSync';
import { flashRevert } from '../../hooks/useRevertFlash';

// The wrapper imports `flashRevert` as a direct binding, so vi.spyOn on the
// namespace would patch an object nobody reads. Mock the module instead, and
// spread the original so `useIsReverting` stays real.
vi.mock('../../hooks/useRevertFlash', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useRevertFlash')>()),
  flashRevert: vi.fn(),
}));
import type { AitoProject } from '../../api/client';

const card = (id: number, description: string): AitoProject =>
  ({ id, description, column: 'devis', position: 0 }) as AitoProject;

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(['aito-projects'], [card(1, 'before')]);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe('useOptimisticBoardMutation', () => {
  beforeEach(() => {
    __resetBoardSync();
    vi.restoreAllMocks();
  });

  it('writes the transform to the cache before the request resolves', async () => {
    const { client, wrapper } = harness();
    let release: (v: unknown) => void = () => {};
    const { result } = renderHook(
      () =>
        useOptimisticBoardMutation<unknown, string>({
          mutationFn: () => new Promise((resolve) => { release = resolve; }),
          transform: (previous, text) => (previous ?? []).map((p) => ({ ...p, description: text })),
        }),
      { wrapper },
    );

    act(() => result.current.mutate('after'));
    await waitFor(() => {
      expect(client.getQueryData<AitoProject[]>(['aito-projects'])![0].description).toBe('after');
    });
    act(() => release(null));
  });

  it('restores the snapshot and flashes when the request fails', async () => {
    const { client, wrapper } = harness();
    const flash = vi.mocked(flashRevert); // see Task 7 Step 7 for the required vi.mock
    const { result } = renderHook(
      () =>
        useOptimisticBoardMutation<unknown, string>({
          mutationFn: () => Promise.reject(new Error('nope')),
          transform: (previous, text) => (previous ?? []).map((p) => ({ ...p, description: text })),
          flashId: () => 1,
        }),
      { wrapper },
    );

    act(() => result.current.mutate('after'));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData<AitoProject[]>(['aito-projects'])![0].description).toBe('before');
    expect(flash).toHaveBeenCalledWith(1);
  });

  it('invalidates once the last write settles', async () => {
    const { client, wrapper } = harness();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockImplementation(() => Promise.resolve());
    const { result } = renderHook(
      () =>
        useOptimisticBoardMutation<unknown, string>({
          mutationFn: () => Promise.resolve(null),
          transform: (previous) => previous ?? [],
        }),
      { wrapper },
    );

    act(() => result.current.mutate('x'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['aito-projects'] });
  });

  it('runs the caller onSuccess with the server data', async () => {
    const { wrapper } = harness();
    const onSuccess = vi.fn();
    const { result } = renderHook(
      () =>
        useOptimisticBoardMutation<string, string>({
          mutationFn: () => Promise.resolve('server said this'),
          transform: (previous) => previous ?? [],
          onSuccess,
        }),
      { wrapper },
    );

    act(() => result.current.mutate('x'));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith('server said this', 'x'));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd frontend && npx vitest run src/__tests__/hooks/useOptimisticBoardMutation.test.tsx; cd ..
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the wrapper**

Create `frontend/src/hooks/useOptimisticBoardMutation.ts`:

```ts
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { useBoardSync } from './useBoardSync';
import { flashRevert } from './useRevertFlash';
import type { AitoProject } from '../api/client';

export interface OptimisticBoardOptions<TData, TVars> {
  mutationFn: (vars: TVars) => Promise<TData>;
  /** The optimistic cache write, applied synchronously before the request
   *  goes out. Pure — see utils/aitoOptimistic.ts for the transforms. */
  transform: (previous: AitoProject[] | undefined, vars: TVars) => AitoProject[];
  /** Which card to flash if this reverts. Omit for a write with no card of its
   *  own (adding a note, for instance). */
  flashId?: (vars: TVars) => number | null;
  onSuccess?: (data: TData, vars: TVars) => void;
  onError?: (error: unknown, vars: TVars) => void;
}

interface Context {
  previous: AitoProject[] | undefined;
}

/** One mutation shape for every write that touches the Aito board.
 *
 *  Owns the sequence each of them needs and none of them should reimplement:
 *  cancel in-flight refetches, snapshot, apply the transform, roll back and
 *  flash on failure, and settle through the shared counter so exactly one
 *  refetch happens per burst.
 *
 *  KNOWN LIMIT, inherited from useBoardDrag and accepted there: concurrent
 *  rollbacks stack. Each write snapshots at its own start, so if two fail the
 *  second's rollback restores over the first. Self-corrected one round trip
 *  later by the settle-invalidate. The shared `aito-board` mutation scope makes
 *  this rare rather than impossible. */
export function useOptimisticBoardMutation<TData, TVars>(
  options: OptimisticBoardOptions<TData, TVars>,
): UseMutationResult<TData, unknown, TVars, Context> {
  const queryClient = useQueryClient();
  const boardSync = useBoardSync();

  return useMutation<TData, unknown, TVars, Context>({
    // Every board writer shares one scope so overlapping writes are applied in
    // the order they were made, not the order the network happens to finish
    // them in. Same id useBoardDrag's move mutation uses.
    scope: { id: 'aito-board' },
    mutationFn: options.mutationFn,
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: ['aito-projects'] });
      const previous = queryClient.getQueryData<AitoProject[]>(['aito-projects']);
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], options.transform(previous, vars));
      boardSync.begin();
      return { previous };
    },
    onError: (error, vars, context) => {
      if (context) queryClient.setQueryData(['aito-projects'], context.previous);
      const id = options.flashId?.(vars);
      if (id !== undefined && id !== null) flashRevert(id);
      options.onError?.(error, vars);
    },
    onSuccess: (data, vars) => {
      options.onSuccess?.(data, vars);
    },
    onSettled: () => {
      boardSync.settle(queryClient);
    },
  });
}
```

- [ ] **Step 4: Run the tests**

```bash
cd frontend && npx vitest run src/__tests__/hooks/useOptimisticBoardMutation.test.tsx; cd ..
```

Expected: PASS.

- [ ] **Step 5: Full gate and commit**

```bash
cd frontend && npm run build && cd ..
./test_frontend.sh
git add -A
git commit -m "feat(aito): one optimistic mutation shape for every board writer"
```

---

## Stage 3 — Call-site adoption

### Task 9: Quote status

**Files:**
- Modify: `frontend/src/hooks/useQuoteStatusMutation.ts` (whole file)
- Test: `frontend/src/__tests__/components/AitoQuoteStatusActions.test.tsx`

**Interfaces:**
- Consumes: `useOptimisticBoardMutation` (Task 8), `applyQuoteStatus` (Task 5).
- Produces: unchanged public shape — `useQuoteStatusMutation(project)` still returns a mutation whose `.mutate('sent' | 'accepted' | 'declined')` is called by `QuoteStatusActions` and `BoardColumn`'s `SortableCard`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/__tests__/components/AitoQuoteStatusActions.test.tsx`. Match the file's existing render helper and mocking style — read it first, then adapt these two cases to it:

```tsx
  it('moves the card the moment accept is held, before the request resolves', async () => {
    // A project in devis with one unticked step lands in its first pending
    // stage as soon as accept is optimistically applied.
    let release: (v: unknown) => void = () => {};
    vi.mocked(api.setAitoQuoteStatus).mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );

    const project = makeProject({
      id: 1, column: 'devis', quote_status: 'draft',
      task_services: ['impression'], steps_total: 1, steps_done: 0,
    });
    const client = renderWithBoard(project);

    await holdButton(screen.getByRole('button', { name: /accept/i }));

    const cached = client.getQueryData<AitoProject[]>(['aito-projects'])!;
    expect(cached[0].column).toBe('print');
    expect(cached[0].quote_status).toBe('accepted');
    release(null);
  });

  it('puts the card back and flashes when the server refuses', async () => {
    vi.mocked(api.setAitoQuoteStatus).mockRejectedValue(new Error('nope'));
    const flash = vi.mocked(flashRevert); // see Task 7 Step 7 for the required vi.mock

    const project = makeProject({ id: 1, column: 'devis', quote_status: 'draft' });
    const client = renderWithBoard(project);

    await holdButton(screen.getByRole('button', { name: /accept/i }));

    await waitFor(() => {
      expect(client.getQueryData<AitoProject[]>(['aito-projects'])![0].column).toBe('devis');
    });
    expect(flash).toHaveBeenCalledWith(1);
  });
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd frontend && npx vitest run src/__tests__/components/AitoQuoteStatusActions.test.tsx; cd ..
```

Expected: FAIL — the cache still holds `devis` at the moment of the first assertion.

- [ ] **Step 3: Rewrite the hook**

Replace the body of `frontend/src/hooks/useQuoteStatusMutation.ts`:

```ts
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useOptimisticBoardMutation } from './useOptimisticBoardMutation';
import { applyQuoteStatus } from '../utils/aitoOptimistic';
import { api, type AitoProject } from '../api/client';
import { useToast } from '../contexts/ToastContext';

// Module scope: a plain object literal, identical on every render, so it
// need not be reconstructed each time a consumer renders.
const TOAST_KEYS = {
  sent: 'aito.quoteSent',
  accepted: 'aito.quoteAccepted',
  declined: 'aito.quoteDeclined',
} as const;

type QuoteStatus = keyof typeof TOAST_KEYS;

/** The one quote-status transition, shared by the detail panel's action block
 *  and the board card's mark-as-sent button.
 *
 *  Extracted rather than duplicated because the two surfaces must agree on
 *  more than the request: the optimistic cache write, which toast fires, and
 *  the separate warning when the board moved but the push to Books did not.
 *  A second copy would drift on the third of those first.
 *
 *  Optimistic: the card relocates the instant the hold completes, predicted
 *  through the mirrored rules. The success handler still writes the server's
 *  own row over the prediction, which is what corrects the position when the
 *  server's `pending` set differs from what the card's counters implied. */
export function useQuoteStatusMutation(project: AitoProject) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useOptimisticBoardMutation<{ project: AitoProject; zoho_synced: boolean }, QuoteStatus>({
    mutationFn: (status) => api.setAitoQuoteStatus(project.id, { status }),
    transform: (previous, status) => applyQuoteStatus(previous, project.id, status),
    flashId: () => project.id,
    onSuccess: (result, status) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.map((p) => (p.id === result.project.id ? result.project : p)) ?? prev,
      );
      queryClient.invalidateQueries({ queryKey: ['aito-events', project.id] });
      showToast(t(TOAST_KEYS[status]), 'success');
      // The board is right either way — only the push to Books failed. No
      // rollback: this is a warning about Zoho, not a refused change.
      if (project.quote_id && !result.zoho_synced) showToast(t('aito.zohoNotUpdated'), 'error');
    },
    onError: () => showToast(t('aito.saveFailed'), 'error'),
  });
}
```

- [ ] **Step 4: Run the tests**

```bash
cd frontend && npx vitest run src/__tests__/components/AitoQuoteStatusActions.test.tsx src/__tests__/components/AitoCardView.test.tsx; cd ..
```

Expected: PASS.

- [ ] **Step 5: Full gate and commit**

```bash
cd frontend && npm run build && cd ..
./test_frontend.sh
git add -A
git commit -m "feat(aito): move the card the instant a quote status is set"
```

---

### Task 10: Description and retry-sync

**Files:**
- Modify: `frontend/src/components/aito/ProjectDetailPanel.tsx:86-95,331-339`

**Interfaces:**
- Consumes: `useOptimisticBoardMutation`, `applyDescription`, `applySyncState`.
- Produces: nothing new. `updateMutation` keeps its `.mutate(patch, { onSuccess, onError })` call shape so `saveDescription` is unchanged.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/__tests__/components/AitoDetailPanelOptimistic.test.tsx`. Model the render helper on `AitoQuoteStatusActions.test.tsx`.

```tsx
  it('shows the new description before the PATCH resolves', async () => {
    let release: (v: unknown) => void = () => {};
    vi.mocked(api.updateAitoProject).mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const client = renderPanel(makeProject({ id: 1, description: 'old text' }));

    await userEvent.click(screen.getByRole('button', { name: /edit description/i }));
    const box = screen.getByRole('textbox');
    await userEvent.clear(box);
    await userEvent.type(box, 'new text');
    await userEvent.tab();

    expect(client.getQueryData<AitoProject[]>(['aito-projects'])![0].description).toBe('new text');
    release({ ...makeProject({ id: 1, description: 'new text' }) });
  });

  it('restores the old description and flashes when the PATCH fails', async () => {
    vi.mocked(api.updateAitoProject).mockRejectedValue(new Error('nope'));
    const flash = vi.mocked(flashRevert); // see Task 7 Step 7 for the required vi.mock
    const client = renderPanel(makeProject({ id: 1, description: 'old text' }));

    await userEvent.click(screen.getByRole('button', { name: /edit description/i }));
    const box = screen.getByRole('textbox');
    await userEvent.clear(box);
    await userEvent.type(box, 'new text');
    await userEvent.tab();

    await waitFor(() => {
      expect(client.getQueryData<AitoProject[]>(['aito-projects'])![0].description).toBe('old text');
    });
    expect(flash).toHaveBeenCalledWith(1);
  });
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd frontend && npx vitest run src/__tests__/components/AitoDetailPanelOptimistic.test.tsx; cd ..
```

Expected: FAIL — the cache still holds `old text`.

- [ ] **Step 3: Convert the mutation**

In `frontend/src/components/aito/ProjectDetailPanel.tsx`, replace the `updateMutation` block (lines 86-95). Add the imports:

```ts
import { useOptimisticBoardMutation } from '../../hooks/useOptimisticBoardMutation';
import { applyDescription, applySyncState } from '../../utils/aitoOptimistic';
```

```ts
  const updateMutation = useOptimisticBoardMutation<AitoProject, AitoProjectUpdate>({
    mutationFn: (patch) => api.updateAitoProject(project.id, patch),
    // A description edit shows immediately; the retry-sync button sends the
    // description UNCHANGED (its only job is to re-mark the project pending
    // for the worker), so it writes the sync state instead. One transform,
    // branching on which of the two this is.
    transform: (previous, patch) => {
      if (patch.description !== undefined && patch.description !== project.description) {
        return applyDescription(previous, project.id, patch.description);
      }
      return applySyncState(previous, project.id, 'pending');
    },
    flashId: () => project.id,
    onSuccess: (updatedProject) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.map((p) => (p.id === updatedProject.id ? updatedProject : p)) ?? prev,
      );
      queryClient.invalidateQueries({ queryKey: ['aito-events', project.id] });
    },
    onError: () => showToast(t('aito.saveFailed'), 'error'),
  });
```

`saveDescription` (line 115) is unchanged — `useOptimisticBoardMutation` returns a standard `UseMutationResult`, so its per-call `{ onSuccess, onError }` still work.

- [ ] **Step 4: Run the tests**

```bash
cd frontend && npx vitest run src/__tests__/components/AitoDetailPanelOptimistic.test.tsx src/__tests__/pages/AitoPage.test.tsx; cd ..
```

Expected: PASS.

- [ ] **Step 5: Full gate and commit**

```bash
cd frontend && npm run build && cd ..
./test_frontend.sh
git add -A
git commit -m "feat(aito): show a description edit and a sync retry at once"
```

---

### Task 11: Task add, delete, and the board projection

**Files:**
- Modify: `frontend/src/hooks/useProjectTasks.ts:158-162,164-237,295-305,311-353`

**Interfaces:**
- Consumes: `summariseTasks` (Task 4), `applyTaskSummary` (Task 5).
- Produces: unchanged public shape — `useProjectTasks(projectId)` still returns `{ tasks, onTasksChange, onRemoveTask, onRowBlur }`.

**Do not break these two existing guarantees.** They are load-bearing and heavily commented in the file:

1. **The board is refetched once, on close** — never per keystroke. This task adds `setQueryData`, which is free. It must **not** add `invalidateQueries` on the edit path. The existing `closedRef`/`inFlightRef` arbitration stays exactly as it is.
2. **The 422 rollback from `baselineRef`** stays untouched. It restores the whole row because the whole PATCH was refused, and it needs no GET.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/__tests__/hooks/useProjectTasksOptimistic.test.tsx`:

```tsx
  it('projects a step tick onto the board card at once', async () => {
    let release: (v: unknown) => void = () => {};
    vi.mocked(api.updateAitoTask).mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const client = renderTasks({
      projectId: 1,
      project: makeProject({ id: 1, quote_status: 'accepted', column: 'print', steps_total: 2, steps_done: 0 }),
      tasks: [makeTask({ id: 10, impression_cost: 5, usinage_cost: 5 })],
    });

    await tickStep('impression');

    const cached = client.getQueryData<AitoProject[]>(['aito-projects'])![0];
    expect(cached.steps_done).toBe(1);
    release(null);
  });

  it('shows a new task row before the POST resolves, and removes it on failure', async () => {
    vi.mocked(api.createAitoTask).mockRejectedValue(new Error('nope'));
    renderTasks({ projectId: 1, tasks: [] });

    await userEvent.click(screen.getByRole('button', { name: /add task/i }));
    expect(screen.getAllByRole('heading', { level: 4 })).toHaveLength(1);

    await waitFor(() => expect(screen.queryAllByRole('heading', { level: 4 })).toHaveLength(0));
  });

  it('removes a deleted row at once and restores it when the DELETE fails', async () => {
    vi.mocked(api.deleteAitoTask).mockRejectedValue(new Error('nope'));
    renderTasks({ projectId: 1, tasks: [makeTask({ id: 10 }), makeTask({ id: 11 })] });

    await holdDelete(0);
    expect(screen.getAllByRole('heading', { level: 4 })).toHaveLength(1);

    await waitFor(() => expect(screen.getAllByRole('heading', { level: 4 })).toHaveLength(2));
  });

  it('does not refetch the board on a task edit', async () => {
    const client = renderTasks({ projectId: 1, tasks: [makeTask({ id: 10, scan_cost: 5 })] }).client;
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await editCost(10, '9');
    await waitFor(() => expect(api.updateAitoTask).toHaveBeenCalled());
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['aito-projects'] });
  });
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd frontend && npx vitest run src/__tests__/hooks/useProjectTasksOptimistic.test.tsx; cd ..
```

Expected: FAIL on all four.

- [ ] **Step 3: Add the board projection helper**

In `frontend/src/hooks/useProjectTasks.ts`, add the imports and a helper below `invalidateTasksAndBoard`:

```ts
import { summariseTasks } from '../utils/aitoBoardRules';
import { applyTaskSummary } from '../utils/aitoOptimistic';
import type { AitoProject } from '../api/client';
```

```ts
  /** Project the current draft array onto the board card: total, badges,
   *  progress bar and — through the mirrored rules — the column.
   *
   *  A setQueryData, never an invalidateQueries. The board is refetched once,
   *  on close, and only if something was really saved (see `closedRef` and
   *  `inFlightRef` below); a refetch here would be a full-board GET per
   *  keystroke, which is the exact cost that arbitration exists to avoid. A
   *  cache write costs nothing and is corrected by that same close-time
   *  refetch. */
  const projectOntoBoard = useCallback(
    (rows: TaskDraft[]) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        applyTaskSummary(prev, projectId, summariseTasks(rows)),
      );
    },
    [queryClient, projectId],
  );
```

- [ ] **Step 4: Call it wherever `tasks` changes**

Four call sites, each immediately after the corresponding `setTasks`:

In `onTasksChange`, after `setTasks(next);`:

```ts
      projectOntoBoard(next);
```

In `updateTaskMutation.onError`'s 422 branch, replace the `setTasks` call:

```ts
      const restored = tasksRef.current.map((row) => (row.id === id ? taskDraftFromAitoTask(baseline) : row));
      setTasks(restored);
      projectOntoBoard(restored);
```

This needs a `tasksRef` mirroring `tasks`, since the callback closes over a stale array. Add beside the other refs:

```ts
  // The current draft array, readable from mutation callbacks that outlive the
  // render they were created in.
  const tasksRef = useRef<TaskDraft[]>([]);
  tasksRef.current = tasks;
```

In the resync effect, after `setTasks(tasksQuery.data.map(taskDraftFromAitoTask));` — no projection needed: that path is applying the server's own answer, and the board query will carry it too.

- [ ] **Step 5: Make add optimistic**

Replace `addTaskMutation` and the growth branch of `onTasksChange`:

```ts
  const addTaskMutation = useMutation({
    mutationFn: ({ draft }: { draft: TaskDraft }) =>
      api.createAitoTask(projectId, taskDraftToTaskCreate(draft)),
    onSuccess: (created, { draft }) => {
      // Swap the placeholder for the real row, matched on `uid` — the draft's
      // stable client-side identity. Matching on array position instead would
      // put the id on the wrong row if another add or delete landed meanwhile.
      baselineRef.current.set(created.id, created);
      setTasks((prev) => prev.map((row) => (row.uid === draft.uid ? taskDraftFromAitoTask(created) : row)));
      tasksDirtyRef.current = true;
      invalidateTasksAndBoard();
    },
    onError: (_error, { draft }) => {
      // The placeholder never became a row. Remove it rather than leaving an
      // un-PATCHable ghost the user can type into.
      setTasks((prev) => prev.filter((row) => row.uid !== draft.uid));
      showToast(t('aito.saveFailed'), 'error');
    },
  });
```

And in `onTasksChange`, the growth branch becomes:

```ts
      if (next.length > tasks.length) {
        // TaskEditor has already appended the draft to `next`; adopt its array
        // so the row is on screen this render, and POST the same draft.
        const added = next[next.length - 1];
        setTasks(next);
        addTaskMutation.mutate({ draft: added });
        return;
      }
```

Update the dependency comment and array to `[tasks, addTaskMutation.mutate, flush, projectOntoBoard]`.

- [ ] **Step 6: Make delete optimistic**

```ts
  const deleteTaskMutation = useMutation({
    mutationFn: ({ id }: { id: number; removed: TaskDraft; index: number }) => api.deleteAitoTask(id),
    onSuccess: (_data, { id }) => {
      // The row is gone for good; drop its diff baseline so a late flush
      // cannot PATCH a deleted task.
      baselineRef.current.delete(id);
      tasksDirtyRef.current = true;
      invalidateTasksAndBoard();
    },
    onError: (_error, { removed, index }) => {
      // Put the row back where it was, not at the end: a task list has an
      // order the user chose, and a failed delete must not silently reorder it.
      setTasks((prev) => {
        const restored = [...prev];
        restored.splice(index, 0, removed);
        projectOntoBoard(restored);
        return restored;
      });
      showToast(t('aito.saveFailed'), 'error');
    },
  });
```

And `onRemoveTask` removes the row before firing:

```ts
  const onRemoveTask = useCallback(
    (index: number) => {
      const task = tasks[index];
      if (!task) return;
      if (task.id === null) {
        const next = tasks.filter((_, i) => i !== index);
        setTasks(next);
        projectOntoBoard(next);
        return;
      }
      // Drop any queued patch for a row about to be deleted.
      const pending = pendingRef.current.get(task.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRef.current.delete(task.id);
      }
      const next = tasks.filter((_, i) => i !== index);
      setTasks(next);
      projectOntoBoard(next);
      deleteTaskMutation.mutate({ id: task.id, removed: task, index });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, deleteTaskMutation.mutate, projectOntoBoard],
  );
```

Remove the stray `baselineRef.current.delete(0)` line from Step 6's `onSuccess` — it was a placeholder; the correct body is just `invalidateTasksAndBoard();`.

- [ ] **Step 7: Run the tests**

```bash
cd frontend && npx vitest run src/__tests__/hooks/useProjectTasksOptimistic.test.tsx src/__tests__/components/AitoTaskStepList.test.tsx src/__tests__/utils/; cd ..
```

Expected: PASS. If a pre-existing `useProjectTasks` test asserts the old add/delete round-trip behaviour, update it to the new behaviour — do not weaken it.

- [ ] **Step 8: Full gate and commit**

```bash
cd frontend && npm run build && cd ..
./test_frontend.sh
git add -A
git commit -m "feat(aito): show task adds, deletes and ticks on the board at once"
```

---

### Task 12: Project delete and trash restore

**Files:**
- Modify: `frontend/src/pages/AitoPage.tsx:196-202`
- Modify: `frontend/src/components/aito/TrashModal.tsx:16-27`

**Interfaces:**
- Consumes: `useOptimisticBoardMutation`, `applyDelete`, `applyInsert`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/__tests__/pages/AitoPage.test.tsx`:

```tsx
  it('removes the card at once on delete and puts it back on failure', async () => {
    vi.mocked(api.deleteAitoProject).mockRejectedValue(new Error('nope'));
    const flash = vi.mocked(flashRevert); // see Task 7 Step 7 for the required vi.mock
    renderPage([makeProject({ id: 1, description: 'doomed' }), makeProject({ id: 2, description: 'safe' })]);

    await openCard('doomed');
    await holdDelete();

    expect(screen.queryByText('doomed')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('doomed')).toBeInTheDocument());
    expect(flash).toHaveBeenCalledWith(1);
  });
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd frontend && npx vitest run src/__tests__/pages/AitoPage.test.tsx; cd ..
```

Expected: FAIL — the card is still on screen immediately after the hold.

- [ ] **Step 3: Convert the delete mutation**

In `frontend/src/pages/AitoPage.tsx`, add the imports:

```ts
import { useOptimisticBoardMutation } from '../hooks/useOptimisticBoardMutation';
import { applyDelete, applyInsert, nextPlaceholderId } from '../utils/aitoOptimistic';
```

Replace `deleteMutation` (lines 196-202):

```ts
  const deleteMutation = useOptimisticBoardMutation<void, number>({
    mutationFn: (id) => api.deleteAitoProject(id),
    transform: (previous, id) => applyDelete(previous, id),
    flashId: (id) => id,
    onSuccess: () => {
      // The board is handled by the wrapper's settle-invalidate; the trash is
      // a separate query with a new row in it.
      queryClient.invalidateQueries({ queryKey: ['aito-trash'] });
    },
    onError: () => showToast(t('aito.deleteFailed'), 'error'),
  });
```

The `onDelete` handler at line 311 is unchanged — closing before deleting is still correct, and still for the same reason.

- [ ] **Step 4: Add the missing toast key**

`aito.deleteFailed` does not exist. Add it to all 13 locale files under the `aito` block:

| file | value |
|---|---|
| `en.ts` | `deleteFailed: 'Could not delete this project',` |
| `fr.ts` | `deleteFailed: 'Impossible de supprimer ce projet',` |
| `de.ts` | `deleteFailed: 'Dieses Projekt konnte nicht gelöscht werden',` |
| `es.ts` | `deleteFailed: 'No se pudo eliminar este proyecto',` |
| `it.ts` | `deleteFailed: 'Impossibile eliminare questo progetto',` |
| `ja.ts` | `deleteFailed: 'このプロジェクトを削除できませんでした',` |
| `ko.ts` | `deleteFailed: '이 프로젝트를 삭제할 수 없습니다',` |
| `pt-BR.ts` | `deleteFailed: 'Não foi possível excluir este projeto',` |
| `ru.ts` | `deleteFailed: 'Не удалось удалить этот проект',` |
| `tr.ts` | `deleteFailed: 'Bu proje silinemedi',` |
| `uk.ts` | `deleteFailed: 'Не вдалося видалити цей проєкт',` |
| `zh-CN.ts` | `deleteFailed: '无法删除此项目',` |
| `zh-TW.ts` | `deleteFailed: '無法刪除此專案',` |

- [ ] **Step 5: Convert the restore mutation**

In `frontend/src/components/aito/TrashModal.tsx`, replace `restoreMutation`:

```ts
  const restoreMutation = useOptimisticBoardMutation<AitoProject, AitoProject>({
    mutationFn: (project) => api.restoreAitoProject(project.id),
    // The restored card lands on the board immediately. Its column comes from
    // the server on success — the trash row's stored column can be stale, and
    // the rules may relocate it — so this is the one transform that predicts a
    // column it does not compute.
    transform: (previous, project) => applyInsert(previous, { ...project, status: 'active' }),
    flashId: (project) => project.id,
    onSuccess: (restored) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.map((p) => (p.id === restored.id ? restored : p)) ?? prev,
      );
      queryClient.invalidateQueries({ queryKey: ['aito-trash'] });
      showToast(t('aito.restored'));
    },
    onError: (error) => {
      const conflict = error instanceof ApiError && error.status === 409;
      showToast(t(conflict ? 'aito.restoreBlockedByQuote' : 'aito.restoreFailed'), 'error');
    },
  });
```

Delete the stray `onMutateExtra: undefined,` line — it is not part of the options interface and will not compile.

The trash list itself also needs to lose the row optimistically. Add a second cache write inside the same handler by filtering the trash query in `transform` is not possible (it only owns `['aito-projects']`), so do it in the button's click handler:

```tsx
                    onClick={() => {
                      // Drop it from the trash list too — the wrapper's
                      // transform only owns the board query.
                      queryClient.setQueryData<AitoProject[]>(['aito-trash'], (prev) =>
                        prev?.filter((p) => p.id !== project.id) ?? prev,
                      );
                      restoreMutation.mutate(project);
                    }}
```

The `onError` path currently invalidates nothing for the trash; add `queryClient.invalidateQueries({ queryKey: ['aito-trash'] });` to it so a refused restore puts the row back.

Delete the unused `useMutation` import from this file if `restoreMutation` was its only consumer, and add `import { useOptimisticBoardMutation } from '../../hooks/useOptimisticBoardMutation';` plus `import { applyInsert } from '../../utils/aitoOptimistic';` and `import type { AitoProject } from '../../api/client';`.

- [ ] **Step 6: Run the tests**

```bash
cd frontend && npx vitest run src/__tests__/pages/AitoPage.test.tsx; cd ..
```

Expected: PASS.

- [ ] **Step 7: Full gate and commit**

```bash
cd frontend && npm run build && cd ..
./test_frontend.sh
git add -A
git commit -m "feat(aito): delete and restore a project without waiting"
```

---

### Task 13: Create and import placeholders

**Files:**
- Modify: `frontend/src/pages/AitoPage.tsx:143-194`
- Modify: `frontend/src/components/aito/CardView.tsx` (inert rendering)
- Modify: `frontend/src/components/aito/BoardColumn.tsx` (skip the grip and mark-sent for a placeholder)

**Interfaces:**
- Consumes: `applyInsert`, `nextPlaceholderId`, `isPlaceholder` (Task 5).
- Produces: `CardView` gains `placeholder?: boolean`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/__tests__/pages/AitoPage.test.tsx`:

```tsx
  it('closes the modal and shows an inert placeholder card at once', async () => {
    let release: (v: unknown) => void = () => {};
    vi.mocked(api.createAitoProject).mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    renderPage([]);

    await createProject('a new job');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('a new job')).toBeInTheDocument();
    // Inert: no grip, so it cannot be dragged before it exists server-side.
    expect(screen.queryByRole('button', { name: /drag/i })).not.toBeInTheDocument();

    release(makeProject({ id: 42, description: 'a new job' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /drag/i })).toBeInTheDocument());
  });

  it('removes the placeholder when the create fails', async () => {
    vi.mocked(api.createAitoProject).mockRejectedValue(new Error('nope'));
    renderPage([]);
    await createProject('doomed job');
    await waitFor(() => expect(screen.queryByText('doomed job')).not.toBeInTheDocument());
  });
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd frontend && npx vitest run src/__tests__/pages/AitoPage.test.tsx; cd ..
```

Expected: FAIL — the modal is still open and no card is on the board.

- [ ] **Step 3: Add a placeholder factory**

In `frontend/src/utils/aitoOptimistic.ts`, add:

```ts
/** A card that exists on screen but not yet on the server.
 *
 *  Every field the board renders must be present and honest: `column: 'devis'`
 *  and `move_lock: 'quote'` because a brand-new project has no accepted quote,
 *  which is what `evaluate(null, 'devis', [])` returns. Nothing here guesses —
 *  the server's own row replaces this wholesale on success. */
export function placeholderProject(fields: {
  description: string;
  client_id: string | null;
  client_name: string | null;
  client_phone: string | null;
  client_email: string | null;
  client_is_company: boolean | null;
  quote_number?: string | null;
  quote_total?: number | null;
}): AitoProject {
  const now = new Date().toISOString();
  return {
    id: nextPlaceholderId(),
    description: fields.description,
    column: 'devis',
    position: 0,
    status: 'active',
    client_id: fields.client_id,
    client_name: fields.client_name,
    client_phone: fields.client_phone,
    client_email: fields.client_email,
    client_is_company: fields.client_is_company,
    quote_id: null,
    quote_number: fields.quote_number ?? null,
    quote_date: null,
    quote_total: fields.quote_total ?? null,
    quote_url: null,
    quote_salesperson: null,
    quote_status: null,
    quote_sync_state: 'pending',
    quote_sync_error: null,
    quote_status_block: null,
    quote_status_remote: null,
    created_by: null,
    task_count: 0,
    tasks_total: 0,
    task_services: [],
    steps_total: 0,
    steps_done: 0,
    move_lock: 'quote',
    created_at: now,
    updated_at: now,
  };
}
```

- [ ] **Step 4: Convert create and import**

In `frontend/src/pages/AitoPage.tsx`, replace `createMutation`:

```ts
  const createMutation = useOptimisticBoardMutation<
    AitoProject,
    { description: string; draft: ClientDraft; tasks: TaskDraft[]; placeholder: AitoProject }
  >({
    mutationFn: ({ description, draft, tasks }) =>
      api.createAitoProject({
        description,
        client_id: draft.id,
        client_name: draft.name,
        client_phone: formatPhone(draft) || null,
        client_email: draft.email.trim() || null,
        client_is_company: draft.isCompany,
        tasks: tasks.map(taskDraftToTaskCreate),
      }),
    transform: (previous, { placeholder }) => applyInsert(previous, placeholder),
    // No flash: the placeholder is REMOVED on failure rather than reverted in
    // place, so there is no card left to ring.
    onSuccess: (created, { placeholder, draft }) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.map((p) => (p.id === placeholder.id ? created : p)) ?? prev,
      );
      void syncClientToZoho(draft);
    },
    onError: (_error, { placeholder }) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.filter((p) => p.id !== placeholder.id) ?? prev,
      );
      showToast(t('aito.createFailed'), 'error');
    },
  });
```

`createProject` builds the placeholder and closes the modal itself:

```ts
  const createProject = (description: string, draft: ClientDraft, tasks: TaskDraft[]) => {
    // Closed here, not in onSuccess: the whole point is that the modal does
    // not sit open through a round trip. The placeholder is what tells the
    // user their card exists.
    setShowModal(false);
    createMutation.mutate({
      description,
      draft,
      tasks,
      placeholder: placeholderProject({
        description,
        client_id: draft.id,
        client_name: draft.name,
        client_phone: formatPhone(draft) || null,
        client_email: draft.email.trim() || null,
        client_is_company: draft.isCompany,
      }),
    });
  };
```

Apply the identical shape to `importMutation`, closing `setShowImport(false)` in the `onImport` handler and building the placeholder from `preview.client` plus `quote_number: preview.quote.number, quote_total: preview.quote.total`. Keep its existing 409 branch verbatim:

```ts
    onError: (error, { placeholder }) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.filter((p) => p.id !== placeholder.id) ?? prev,
      );
      const conflict = error instanceof ApiError && error.status === 409;
      showToast(t(conflict ? 'aito.quoteAlreadyHasProject' : 'aito.createFailed'), 'error');
    },
```

- [ ] **Step 5: Render a placeholder inert**

In `frontend/src/components/aito/CardView.tsx`, add to `CardViewProps`:

```ts
  /** A card the server has not acknowledged yet. Renders dimmed with no grip
   *  and no actions: its id does not exist, so anything acting on it would act
   *  on nothing. Cleared the instant the real row replaces it. */
  placeholder?: boolean;
```

Destructure `placeholder = false` and use it in three places:

1. Root className — append `${placeholder ? 'opacity-60' : ''}`.
2. The grip block — change `{dragHandleProps ? (` to `{dragHandleProps && !placeholder ? (`.
3. The mark-sent block — change the condition to `{onMarkSent && !placeholder && project.column === 'devis' && (`.

Also gate the body button so a placeholder cannot open a panel for a project that does not exist: change `{onExpand ? (` to `{onExpand && !placeholder ? (`.

In `frontend/src/components/aito/BoardColumn.tsx`, `SortableCard` passes it:

```ts
import { isPlaceholder } from '../../utils/aitoOptimistic';
```

```tsx
  const placeholder = isPlaceholder(project);
```

```tsx
      <CardView
        project={project}
        placeholder={placeholder}
        onExpand={onExpand}
        ...
```

And disable the sortable so dnd-kit never picks it up:

```ts
  } = useSortable({
    id: project.id,
    transition: transitionConfig,
    disabled: placeholder,
  });
```

- [ ] **Step 6: Run the tests**

```bash
cd frontend && npx vitest run src/__tests__/pages/AitoPage.test.tsx src/__tests__/components/AitoCardView.test.tsx; cd ..
```

Expected: PASS.

- [ ] **Step 7: Full gate and commit**

```bash
cd frontend && npm run build && cd ..
./test_frontend.sh
git add -A
git commit -m "feat(aito): land a created or imported card before the server answers"
```

---

### Task 14: The activity note

**Files:**
- Modify: `frontend/src/components/aito/history/ActivityRail.tsx:45-52,85-106`

**Interfaces:**
- Consumes: `nextPlaceholderId` (Task 5).
- Produces: nothing new.

This one does not use `useOptimisticBoardMutation` — it writes `['aito-events', projectId]`, an infinite query, not the board.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/__tests__/components/AitoActivityRail.test.tsx`:

```tsx
  it('shows the note and clears the box before the POST resolves', async () => {
    let release: (v: unknown) => void = () => {};
    vi.mocked(api.addAitoNote).mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    renderRail({ projectId: 1, events: [] });

    await userEvent.type(screen.getByRole('textbox'), 'called the client');
    await userEvent.click(screen.getByRole('button', { name: /add/i }));

    expect(screen.getByText('called the client')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('');
    release(makeEvent({ id: 99, kind: 'note.added', note: 'called the client' }));
  });

  it('removes the note and restores the text when the POST fails', async () => {
    vi.mocked(api.addAitoNote).mockRejectedValue(new Error('nope'));
    renderRail({ projectId: 1, events: [] });

    await userEvent.type(screen.getByRole('textbox'), 'called the client');
    await userEvent.click(screen.getByRole('button', { name: /add/i }));

    await waitFor(() => expect(screen.queryByText('called the client')).not.toBeInTheDocument());
    // The text comes back so the user does not have to retype it.
    expect(screen.getByRole('textbox')).toHaveValue('called the client');
  });
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd frontend && npx vitest run src/__tests__/components/AitoActivityRail.test.tsx; cd ..
```

Expected: FAIL.

- [ ] **Step 3: Read the event page shape**

Before writing the transform, confirm the exact `AitoEvent` and `AitoEventPage` fields:

```bash
grep -n "interface AitoEvent\b" -A 25 frontend/src/api/client.ts
grep -n "interface AitoEventPage" -A 8 frontend/src/api/client.ts
```

Build the optimistic event with every field that interface requires — do not cast.

- [ ] **Step 4: Make the note optimistic**

In `ActivityRail.tsx`:

```ts
import { nextPlaceholderId } from '../../../utils/aitoOptimistic';
import type { AitoEvent, AitoEventPage } from '../../../api/client';
```

```ts
  const addNote = useMutation({
    mutationFn: ({ body }: { body: string; optimistic: AitoEvent }) => api.addAitoNote(projectId, body),
    // Prepends into the FIRST page only. The list runs newest-first and the
    // cursor keysets on (occurred_at, id), so a row at the head cannot shift
    // any page boundary — an optimistic note is invisible to paging.
    onMutate: ({ optimistic }) => {
      setNote('');
      queryClient.setQueryData<{ pages: AitoEventPage[]; pageParams: unknown[] }>(
        ['aito-events', projectId, depth],
        (prev) =>
          prev
            ? { ...prev, pages: [{ ...prev.pages[0], events: [optimistic, ...prev.pages[0].events] }, ...prev.pages.slice(1)] }
            : prev,
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['aito-events', projectId] });
    },
    onError: (_error, { body, optimistic }) => {
      queryClient.setQueryData<{ pages: AitoEventPage[]; pageParams: unknown[] }>(
        ['aito-events', projectId, depth],
        (prev) =>
          prev
            ? {
                ...prev,
                pages: prev.pages.map((page) => ({
                  ...page,
                  events: page.events.filter((event) => event.id !== optimistic.id),
                })),
              }
            : prev,
      );
      // Put the text back rather than making the user retype it.
      setNote(body);
      showToast(t('aito.history.noteFailed'), 'error');
    },
  });
```

The form handler builds the optimistic event:

```tsx
        onSubmit={(e) => {
          e.preventDefault();
          const body = note.trim();
          if (!body) return;
          addNote.mutate({
            body,
            optimistic: {
              id: nextPlaceholderId(),
              kind: 'note.added',
              occurred_at: new Date().toISOString(),
              actor_class: 'user',
              actor_name: null,
              subject_type: 'project',
              subject_id: projectId,
              changes: [],
              detail: { note: body },
            },
          });
        }}
```

Adjust the literal to whatever `AitoEvent` actually declares — Step 3 established it. If `useProjectEvents` keys its query differently from `['aito-events', projectId, depth]`, use its real key:

```bash
grep -n "queryKey" frontend/src/hooks/useProjectEvents.ts
```

- [ ] **Step 5: Run the tests**

```bash
cd frontend && npx vitest run src/__tests__/components/AitoActivityRail.test.tsx; cd ..
```

Expected: PASS.

- [ ] **Step 6: Full gate and commit**

```bash
cd frontend && npm run build && cd ..
./test_frontend.sh
git add -A
git commit -m "feat(aito): post a note into the timeline at once"
```

---

## Stage 4 — The card

### Task 15: Remove the quote-status badge

**Files:**
- Modify: `frontend/src/components/aito/CardView.tsx:196-211` and its imports
- Modify: `frontend/src/components/aito/quoteStatus.ts`
- Test: `frontend/src/__tests__/components/AitoCardView.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `quoteStatusStyle` is deleted from `quoteStatus.ts`. `quoteStatusLabelKey` stays — `ProjectDetailPanel` uses it.

**Accepted information loss, recorded so it is a choice and not a surprise.** `evaluate()` maps status to column but not injectively: `sent`, `viewed` and `expired` all become Waiting, and `declined` shares Done with a genuinely finished project. The card therefore stops distinguishing "the client opened it" from "it expired unanswered", and a declined card becomes indistinguishable from a completed one. The detail panel still shows the exact status, and `aito.quoteDeclinedNoDraft` already renders there for a declined card specifically because it is otherwise invisible.

- [ ] **Step 1: Write the failing test**

In `frontend/src/__tests__/components/AitoCardView.test.tsx`:

```tsx
  it('does not repeat the quote status the column already states', () => {
    render(<CardView project={makeProject({ quote_status: 'sent', column: 'waiting' })} />);
    expect(screen.queryByText(/sent/i)).not.toBeInTheDocument();
  });
```

Also **delete or rewrite** any existing test in this file that asserts the badge renders. Find them:

```bash
grep -n "quote_status\|quoteStatus" frontend/src/__tests__/components/AitoCardView.test.tsx
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd frontend && npx vitest run src/__tests__/components/AitoCardView.test.tsx; cd ..
```

Expected: FAIL — the badge is still rendered.

- [ ] **Step 3: Delete the badge block**

In `frontend/src/components/aito/CardView.tsx`, delete lines 196-211 — the comment beginning "The status as it stood at import" through the closing `)}` of the `{project.quote_status && (` block.

Then fix the import on line 6:

```ts
import { quoteStatusLabelKey } from './quoteStatus';
```

If `quoteStatusLabelKey` is no longer referenced in this file after the deletion, remove the import entirely. Check:

```bash
grep -n "quoteStatusLabelKey" frontend/src/components/aito/CardView.tsx
```

- [ ] **Step 4: Delete the dead export**

Confirm nothing else uses it — an unused *export* draws no ESLint error, so grep is the only check:

```bash
grep -rn "quoteStatusStyle" frontend/src/ --include=*.ts --include=*.tsx
```

If the only hits are its definition in `quoteStatus.ts` and its own test, delete the function from `quoteStatus.ts` and its test cases.

- [ ] **Step 5: Run the tests**

```bash
cd frontend && npx vitest run src/__tests__/components/; cd ..
```

Expected: PASS.

- [ ] **Step 6: Full gate and commit**

```bash
cd frontend && npm run build && cd ..
./test_frontend.sh
git add -A
git commit -m "feat(aito): drop the card's quote badge, which the column already says"
```

---

### Task 16: The progress bar

**Files:**
- Create: `frontend/src/components/aito/ProjectProgress.tsx`
- Modify: `frontend/src/components/aito/CardView.tsx` (render it last)
- Modify: all 13 locale files
- Test: `frontend/src/__tests__/components/AitoProjectProgress.test.tsx`

**Interfaces:**
- Consumes: `AitoProject.steps_total`, `.steps_done` (Task 2).
- Produces: `<ProjectProgress done={number} total={number} />`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/__tests__/components/AitoProjectProgress.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProjectProgress } from '../../components/aito/ProjectProgress';

describe('ProjectProgress', () => {
  it('renders nothing when the project has no steps', () => {
    const { container } = render(<ProjectProgress done={0} total={0} />);
    // An unpriced project has nothing to measure; an empty bar on every fresh
    // card would be clutter, not information.
    expect(container).toBeEmptyDOMElement();
  });

  it('reports the ratio to assistive technology', () => {
    render(<ProjectProgress done={3} total={10} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '3');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '10');
  });

  it('sets the fill width to the completed fraction', () => {
    render(<ProjectProgress done={3} total={10} />);
    const fill = screen.getByTestId('aito-progress-fill');
    expect(fill).toHaveStyle({ width: '30%' });
  });

  it('fills completely when every step is done', () => {
    render(<ProjectProgress done={4} total={4} />);
    expect(screen.getByTestId('aito-progress-fill')).toHaveStyle({ width: '100%' });
  });

  it('counts a free step like any other', () => {
    // The caller counts steps, not money — a step quoted 0 is a real step, so
    // 1 of 2 is 50% regardless of price. This asserts the component does no
    // cost arithmetic of its own.
    render(<ProjectProgress done={1} total={2} />);
    expect(screen.getByTestId('aito-progress-fill')).toHaveStyle({ width: '50%' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd frontend && npx vitest run src/__tests__/components/AitoProjectProgress.test.tsx; cd ..
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the component**

Create `frontend/src/components/aito/ProjectProgress.tsx`:

```tsx
import { useTranslation } from 'react-i18next';

/** How far through its steps a project is, as a hairline at the foot of the
 *  card.
 *
 *  A step is one (task, service) pair with a cost — three tasks carrying ten
 *  steps between them with three ticked reads 30%. A step quoted free counts
 *  like any other; the caller has already applied that rule (see
 *  `summariseTasks`), and this component does no arithmetic beyond the ratio.
 *
 *  No percentage text: at 2px the number is noise, and the card is already
 *  dense. The value reaches assistive technology through `aria-valuenow` and
 *  anyone hovering through the title.
 *
 *  Renders nothing at all when there are no steps. An unpriced project has
 *  nothing to measure, and an empty track on every freshly created card is
 *  clutter rather than information. */
export function ProjectProgress({ done, total }: { done: number; total: number }) {
  const { t } = useTranslation();
  if (total <= 0) return null;

  const label = t('aito.progressLabel', { done, total });
  const percent = Math.round((done / total) * 100);

  return (
    <div
      role="progressbar"
      aria-valuenow={done}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-label={label}
      title={label}
      className="h-0.5 w-full overflow-hidden rounded-b-xl bg-bambu-dark-tertiary"
    >
      <div
        data-testid="aito-progress-fill"
        style={{ width: `${percent}%` }}
        // The width transition is what makes an optimistic tick visible as
        // motion rather than a jump. motion-reduce drops it, keeping the
        // value change instant for anyone who asked for less movement.
        className="h-full bg-bambu-green transition-[width] duration-300 ease-[var(--ease-signature)] motion-reduce:transition-none"
      />
    </div>
  );
}
```

- [ ] **Step 4: Add the i18n key to all 13 locales**

Under the `aito` block in each file:

| file | value |
|---|---|
| `en.ts` | `progressLabel: '{{done}} of {{total}} steps done',` |
| `fr.ts` | `progressLabel: '{{done}} étapes terminées sur {{total}}',` |
| `de.ts` | `progressLabel: '{{done}} von {{total}} Schritten erledigt',` |
| `es.ts` | `progressLabel: '{{done}} de {{total}} pasos completados',` |
| `it.ts` | `progressLabel: '{{done}} di {{total}} passaggi completati',` |
| `ja.ts` | `progressLabel: '{{total}} 件中 {{done}} 件のステップが完了',` |
| `ko.ts` | `progressLabel: '{{total}}개 단계 중 {{done}}개 완료',` |
| `pt-BR.ts` | `progressLabel: '{{done}} de {{total}} etapas concluídas',` |
| `ru.ts` | `progressLabel: 'Выполнено шагов: {{done}} из {{total}}',` |
| `tr.ts` | `progressLabel: '{{total}} adımdan {{done}} tanesi tamamlandı',` |
| `uk.ts` | `progressLabel: 'Виконано кроків: {{done}} з {{total}}',` |
| `zh-CN.ts` | `progressLabel: '已完成 {{total}} 个步骤中的 {{done}} 个',` |
| `zh-TW.ts` | `progressLabel: '已完成 {{total}} 個步驟中的 {{done}} 個',` |

- [ ] **Step 5: Render it on the card**

In `frontend/src/components/aito/CardView.tsx`, add the import and place it as the **last** child of the card's root `<div>`, after the footer block that closes around line 236:

```tsx
import { ProjectProgress } from './ProjectProgress';
```

```tsx
      <ProjectProgress done={project.steps_done} total={project.steps_total} />
```

The card root already has `rounded-xl`; the bar carries `rounded-b-xl` so it sits inside the corner rather than squaring it off.

- [ ] **Step 6: Add a card-level test**

In `frontend/src/__tests__/components/AitoCardView.test.tsx`:

```tsx
  it('shows the progress bar once the project has steps', () => {
    render(<CardView project={makeProject({ steps_total: 4, steps_done: 1 })} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
  });

  it('shows no bar on an unpriced project', () => {
    render(<CardView project={makeProject({ steps_total: 0, steps_done: 0 })} />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
```

- [ ] **Step 7: Run the tests**

```bash
cd frontend && npx vitest run src/__tests__/components/AitoProjectProgress.test.tsx src/__tests__/components/AitoCardView.test.tsx; cd ..
```

Expected: PASS.

- [ ] **Step 8: Full gate and commit**

```bash
cd frontend && npm run build && cd ..
./test_frontend.sh
git add -A
git commit -m "feat(aito): a step-progress hairline at the foot of each card"
```

---

## Stage 5 — The task list

### Task 17: Tasks stop collapsing

**Files:**
- Modify: `frontend/src/components/aito/TaskRow.tsx` (props, header, body)
- Modify: `frontend/src/components/aito/TaskEditor.tsx:66-145`
- Test: sweep `AitoTaskStepList`, `AitoTaskStepFields`, `AitoCardView`, `AitoPage`, `AitoQuoteStatusActions`

**Interfaces:**
- Consumes: `taskSteps` from `services.ts`.
- Produces: `TaskRowProps` loses `expanded` and `onToggle`. Everything else is unchanged.

- [ ] **Step 1: Write the failing test**

In `frontend/src/__tests__/components/AitoTaskStepList.test.tsx` (or a new `AitoTaskRow.test.tsx` if the render helper does not fit):

```tsx
  it('shows a task step without anything needing to be opened first', () => {
    renderRow(makeTask({ scanCost: 20, done: { scan: false, modelisation: false, impression: false, usinage: false } }), {
      canTick: true,
    });
    // Straight to the Done toggle — no disclosure click in between.
    expect(screen.getByRole('button', { name: /mark done/i })).toBeInTheDocument();
  });

  it('has no disclosure control at all', () => {
    renderRow(makeTask({ scanCost: 20 }), { canTick: true });
    expect(screen.queryByRole('button', { expanded: false })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { expanded: true })).not.toBeInTheDocument();
  });

  it('shows the form, not "no steps yet", on a task with nothing priced', () => {
    // A row with no steps IS the form — there is nothing else it could show.
    renderRow(makeTask({}), { canTick: false });
    expect(screen.queryByText(/no steps yet/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/scan/i)).toBeInTheDocument();
  });

  it('hides the edit toggle on a stepless row', () => {
    // There is no other mode to switch to, so an inert toggle explains nothing.
    renderRow(makeTask({}), { canTick: false });
    expect(screen.queryByRole('button', { name: /edit task/i })).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd frontend && npx vitest run src/__tests__/components/AitoTaskStepList.test.tsx; cd ..
```

Expected: FAIL — the row is collapsed and the toggle exists.

- [ ] **Step 3: Flatten `TaskRow`**

In `frontend/src/components/aito/TaskRow.tsx`:

1. Remove `expanded: boolean;` and `onToggle: () => void;` from `TaskRowProps`, and from the destructured parameter list.
2. Remove the `ChevronRight` import; keep `Check` and `Pencil`.
3. Replace the docstring's second paragraph:

```
 *  Always open. The row was collapsible when it held a form, and the cost of
 *  that was a click between the user and the one control they reach for most —
 *  Done. Now that read mode is a short step list, the row is simply a card.
 *
 *  `TaskStepFields` (edit mode) still mounts only behind the pencil, so an
 *  open row in read mode still runs none of ImpressionFields' three
 *  reference-data queries.
```

4. Replace the header block (lines 93-146) — the heading is no longer a button:

```tsx
      <div className="flex items-center gap-2 p-3">
        <h4 className="flex-1 min-w-0 flex items-center gap-2">
          <span className="text-sm font-medium text-white truncate min-w-0">{name}</span>
          {finished && (
            <Check className="w-3.5 h-3.5 flex-shrink-0 text-bambu-green" aria-label={t('aito.taskFinished')} />
          )}
          <Money
            currency={currency}
            value={taskTotal(task)}
            className="ml-auto flex-shrink-0 text-sm text-white"
          />
        </h4>
        {/* Hidden on a stepless row: that row is already showing the form, so
            there is no other mode to switch to. */}
        {steps.length > 0 && (
          <button
            type="button"
            aria-label={t('aito.editTask')}
            aria-pressed={editing}
            title={t('aito.editTask')}
            onClick={onToggleEdit}
            className={`flex-shrink-0 p-1 -m-1 rounded-md transition-colors ${focusRingCls} ${
              editing ? 'text-bambu-green' : 'text-bambu-gray hover:text-white'
            }`}
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
        {onRemove && (
          <DeleteHoldButton onDelete={onRemove} label={t('aito.removeTask')} hint={t('aito.holdToDelete')} />
        )}
      </div>

      <div className="px-3 pb-3 space-y-3">
        {editing ? (
          <TaskStepFields task={task} onChange={onChange} />
        ) : (
          <TaskStepList task={task} onChange={onChange} canTick={canTick} />
        )}
      </div>
```

5. Add `const steps = taskSteps(task);` beside `const finished = isTaskFinished(task);`, and drop `useId` plus the `reactId` line — the `aria-controls` pairing it existed for is gone.
6. Remove the now-unused `ServiceBadges` import (the header no longer renders badges) and `enabledServices` if nothing else uses it. Check:

```bash
grep -n "ServiceBadges\|enabledServices" frontend/src/components/aito/TaskRow.tsx
```

- [ ] **Step 4: Flatten `TaskEditor`**

In `frontend/src/components/aito/TaskEditor.tsx`:

1. Delete `expandedKeys`, its `useState`, and the `toggle` function.
2. Delete `addRequestedRef`, `previousKeysRef` and the whole `useEffect` between them (lines 85-110) with its comment — the rule below replaces its only purpose.
3. Delete the now-unused `useEffect` and `useRef` imports if nothing else needs them.
4. Add the derived-editing rule with its reasoning:

```tsx
  // A row with no steps IS the form — read mode would show nothing but "No
  // steps yet", so there is nothing to disclose. Deriving this replaces the
  // effect that used to diff row keys to open a newly added row in edit mode,
  // and fixes the create modal for free: its first task previously started
  // both collapsed and not editing, costing two clicks before the user could
  // type a price.
  const isEditing = (task: TaskDraft) => editingKeys.has(rowKey(task)) || taskSteps(task).length === 0;
```

with `import { taskSteps } from './services';`

5. The row render loses two props and gains the derived one:

```tsx
          <TaskRow
            key={rowKey(task)}
            task={task}
            index={index}
            onChange={(next) => onChange(value.map((existing, i) => (i === index ? next : existing)))}
            onRemove={value.length > minRows ? () => onRemove(index) : undefined}
            editing={isEditing(task)}
            onToggleEdit={() => toggleEdit(rowKey(task))}
            onRowBlur={onRowBlur}
            canTick={canTick}
          />
```

6. Keep the "+ Add task" button, minus the flag:

```tsx
        onClick={() => onChange([...value, emptyTaskDraft()])}
```

- [ ] **Step 5: Sweep the test fixtures**

Test files are not type-checked, so removing the two props produces no compiler error. Find every construction site:

```bash
grep -rn "expanded=\|onToggle=\|expandedKeys" frontend/src/__tests__/ frontend/src/components/aito/
```

Remove `expanded` and `onToggle` from every `<TaskRow>` in the test files. Any test asserting a collapse/expand interaction is now testing behaviour that no longer exists — rewrite it against the always-open row rather than deleting it, unless its only subject was the toggle.

- [ ] **Step 6: Run the full frontend suite**

```bash
cd frontend && npm run build && cd ..
./test_frontend.sh
```

Expected: all pass. Per the project's known flake, if `PrintModal` tests fail, retry once before investigating — they are unrelated to this change.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(aito): tasks become a list of cards, Done always one click away"
```

---

## Final verification

- [ ] **Run every gate from the project root**

```bash
cd frontend && npm run build && cd ..
./test_frontend.sh
./test_backend.sh
```

Expected: all green. `test_backend.sh` skips `test_bambu_ftp.py` by default, which is fine — nothing here touches FTP.

- [ ] **Prove the contract pin still bites end to end**

Change `evaluate()`'s away-status branch in `backend/app/services/aito_board_rules.py` to return `("devis", "waiting")`:

```bash
./venv/bin/python3 -m pytest backend/tests/unit/test_aito_board_rules_contract.py -q
```

Expected: FAIL. Then regenerate and confirm the failure moves to the frontend:

```bash
./venv/bin/python3 scripts/gen_aito_board_rules_fixture.py
cd frontend && npx vitest run src/__tests__/utils/aitoBoardRules.test.ts; cd ..
```

Expected: FAIL on the mirror. **Revert both** (`git checkout backend/app/services/aito_board_rules.py frontend/src/__tests__/fixtures/aitoBoardRules.cases.json`) and re-run both to confirm green.

- [ ] **Manual pass against the running app**

Use the `run` skill or the dev server. Walk each row of the Part 2 table: confirm the effect is immediate, then confirm the revert by pointing the frontend at a stopped backend for one action.

Specifically check the three that predict a column: accept a quote, tick a project's last step, and delete a task that was holding a column.
