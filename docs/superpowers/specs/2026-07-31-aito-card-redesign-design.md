# Aito project card redesign

Date: 2026-07-31
Branch: `aito-card-redesign`

## Problem

The board card carries information that no longer earns its place and misses
the one thing an operator actually wants at a glance.

- The **lock badge** in the header explains why a card cannot be dragged
  between columns. Since Done left the board (`columns.ts`, `DONE_COLUMN`),
  `finish ↔ done` — the only cross-column drag the rules ever allowed — is
  unreachable. The badge now explains a restriction that applies to every card
  without exception, which is the same as explaining nothing.
- **`1 task`** is a number nobody acts on. What an operator wants is *which
  steps are done*, and that is only visible after expanding the card.
- The **progress bar** is a 2px hairline whose bottom corners do not match the
  card's, so the fill squares off the card's rounded corner.
- Only the description block opens the detail panel. The footer, the badge row
  and the padding around them are dead to the pointer.
- A long description is clamped to three lines with no way to read the rest
  short of opening the panel.

## Design

### 1. Data: per-task steps on the board response

The board response carries project-level aggregates only — `task_services`
(union of enabled services), `task_pending`, `steps_done`, `steps_total`. One
pill row per task needs a per-task breakdown, which no endpoint currently
returns.

`TaskSummary` in `backend/app/services/aito_board_rules.py` gains a field:

```python
@dataclass(frozen=True)
class TaskSteps:
    services: tuple[str, ...]   # enabled on this task, canonical SERVICES order
    done: tuple[str, ...]       # the ticked subset, canonical order

@dataclass(frozen=True)
class TaskSummary:
    ...
    steps_by_task: tuple[TaskSteps, ...] = ()
```

`(services, done)` is deliberately the same pair `ServiceBadges` already takes,
so the card, a collapsed task row and the API all describe a task's steps the
same way.

`AitoProjectResponse` gains `task_steps: list[AitoTaskSteps]`, one entry per
task, in the order `_tasks_by_project` already returns (`position, id`) — the
order the detail panel lists them, so the card's rows and the panel's rows line
up.

This lives in `TaskSummary` rather than being computed in
`api/routes/aito.py`, because `aitoOptimistic.ts` writes the same aggregates
into the React Query cache when a step is ticked. A definition that is not in
`summarise`/`summariseTasks` is not pinned by the contract fixture and would be
free to drift. Consequences:

- mirror in `summariseTasks` (`frontend/src/utils/aitoBoardRules.ts`) as
  `stepsByTask: { services: ServiceId[]; done: ServiceId[] }[]`
- write `task_steps` in both cache-patch sites in `aitoOptimistic.ts`
- regenerate the contract fixture:
  `./venv/bin/python3 scripts/gen_aito_board_rules_fixture.py`

A cost of `null` means the service is absent from the job and contributes
nothing; `0` is a step quoted free and is a real step. This is the existing
rule and does not change.

### 2. Card layout

```
┌───────────────────────────────────────┐
│ Romain Pahuiri                    ⠿   │  header: drag handle only
├───────────────────────────────────────┤
│ Raccord de voiture pour durite de     │
│ refroidissement (2 tétines)           │
│ ┌──────┬──────┬──────┬──────┐         │
│ │ Scan │Modél…│Impre…│      │         │  task 1
│ ├──────┼──────┼──────┼──────┤         │
│ │ Scan │      │Impre…│Usin… │         │  task 2
│ └──────┴──────┴──────┴──────┘         │
│                         17 000 FCFP   │
│ 7 days ago  DEV26-2450                │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░  │
└───────────────────────────────────────┘
```

**Header.** The lock badge, `LOCK_LABEL_KEYS` and the `lockTitle` computation
are removed from `CardView`. `move_lock` itself is untouched: `allowedColumns`
still reads it, the server still enforces it with a 409, and `DoneGrid` still
reads it to decide whether to offer Restore. Only the drawing goes. The
`aito.locked*` i18n keys have no other consumer and are removed from all 13
locales.

**Step grid.** One `grid grid-cols-4 gap-1` row per task, no cap. A project
with ten tasks makes a tall card, which is the truth about that project.

A service absent from the task renders an empty cell. Fixed four columns mean
Scan is always leftmost and Machining always rightmost, so the *shape* of the
row says what the job involves before any label is read.

Pill states:

| state             | classes                                                                 |
|-------------------|-------------------------------------------------------------------------|
| done              | `bg-bambu-green/15 text-bambu-green ring-1 ring-inset ring-bambu-green/30` |
| pending           | `bg-bambu-dark-tertiary text-bambu-gray-light`                          |
| absent            | nothing rendered                                                        |

Labels reuse `AITO_SERVICE_LABEL_KEYS` — no new translation keys. Each pill is
`truncate` with the full label in `title`, since `Modélisation` does not fit a
quarter of a 300px column at every locale.

**Removed.** The `task_count` line, and the project-level `ServiceBadges` row —
the latter is the union of exactly what the pills now show per task.
`ServiceBadges` itself stays; `TaskRow`'s collapsed header still uses it.

`tasks_total` (the money) moves up to sit right-aligned on its own line under
the grid.

### 3. Progress bar

`h-0.5` → `h-1.5` (2px → 6px).

The corner artefact is a radius mismatch: the track carries its own
`rounded-b-xl`, but it sits *inside* the card's 1px border, so the card's inner
radius is `xl - 1px` and the two curves do not coincide. Fix by clipping at the
card instead — `overflow-hidden` on the card root, and drop `rounded-b-xl` from
the track. The card's own corner is then the only curve involved.

`overflow-hidden` is safe on the card root: the focus ring is
`focus-visible:ring-inset`, `card-shadow` is a box-shadow (not clipped by
`overflow`), and the grip's `p-2 -m-2` pulls padding inward rather than
overflowing.

### 4. The whole card below the header is one click target

A transparent `<button className="absolute inset-0">` covers the body, the
footer and the progress bar. The visible content renders above it with
`pointer-events-none`; the footer's injected action buttons (mark-sent,
mark-done, restore, hold-to-delete) get `pointer-events-auto` so they still
receive their own clicks.

One real `<button>` rather than a click handler on a `<div>`: keyboard and
assistive technology get exactly one target with one accessible name, and no
`<button>` ends up nested inside another, which is what forced the footer
outside the click target in the first place.

Known cost: the `7 days ago` text loses its created/updated `title` tooltip,
because `pointer-events: none` suppresses tooltips. The detail panel shows both
timestamps. Carving a live zone out of the middle of the click target to keep a
hover hint is the worse trade.

`data-aito-card-id` stays on the card root — `useCardMorph` queries it to
assign `viewTransitionName`, and the styled root is the correct snapshot.

### 5. Hover-intent expansion of the description

`line-clamp-3` stays. On `mouseenter` a 1s timer starts; on `mouseleave` it is
cleared. When it fires the card floats:

1. read the card root's current `offsetHeight`
2. pin that height on an outer shell `<div>`, so the column's layout does not
   change
3. the card root goes `absolute inset-x-0 top-0 z-30`, drops the line clamp and
   gains a heavier shadow

The shell is the new outermost element of `CardView`. It carries no
`data-aito-card*` attributes and no card styling — it exists only to hold the
space.

Guards:

- never on the DragOverlay clone (`overlay`) or a placeholder
- never when the description is not actually clamped
  (`scrollHeight <= clientHeight` on the description node) — nothing to reveal,
  so nothing should move
- the timer is cleared on unmount
- `motion-reduce` drops the transition; the expansion still happens, instantly

Touch devices get no `mouseenter` and are unaffected; tapping opens the panel,
which shows the full description.

## Testing

Frontend (`frontend/src/__tests__/`):

- `components/AitoCardView.test.tsx`
  - one pill row per entry in `task_steps`
  - a done service's pill carries the green treatment, a pending one does not
  - an absent service renders no pill, and the row still has four grid columns
  - no lock icon for any `move_lock` value
  - clicking the footer region calls `onExpand`; clicking an injected action
    button does not
  - hover for 1s (fake timers) un-clamps the description; `mouseleave` before
    1s does not
  - a description that is not clamped does not expand
- `pages/AitoPageDragLock.test.tsx` — needs no rewrite. It asserts that a
  disallowed drop is refused, not that a badge is drawn, and that behaviour is
  unchanged. If it goes red, something behavioural broke.
- `utils/aitoBoardRules.test.ts` — `stepsByTask` reproduced from the
  regenerated fixture
- `utils/aitoOptimistic.test.ts` — ticking a step updates `task_steps` in the
  cache
- fixture sweeps: every `makeProject`-style fixture across the Aito tests needs
  `task_steps`, since `tsconfig.app.json` excludes `src/__tests__` and the
  compiler will not flag them

Backend (`backend/tests/`):

- `unit/test_aito_board_summary.py` — `steps_by_task` for: no tasks, an
  unpriced task, canonical ordering, a free (`0`) step, a done flag on an
  absent (`None`) service, and two tasks in order
- `unit/test_aito_routes.py` — `task_steps` on the board response. The golden
  payload fixture (`tests/fixtures/aito_board_payload.json`) compares the whole
  JSON and so must be regenerated with `REGENERATE_GOLDEN=1`, diff read before
  committing.
- `test_aito_board_rules_contract.py` passes against the regenerated fixture

## Out of scope

- The detail panel, `TaskEditor` and `TaskRow` are untouched.
- `move_lock`, `allowedColumns` and the server's 409 keep their current
  behaviour; only the card's rendering of the lock changes.
- No change to how a card reaches Done (`markDone` in `SortableCard`) or
  returns from it (`DoneGrid`'s Restore).
