# Aito: optimistic actions, card progress, and a flat task list

**Date:** 2026-07-30
**Status:** approved, ready for an implementation plan

## Goal

Every action on the Aito board takes effect on screen the moment it is taken.
If the server refuses it, the UI puts it back and says so.

Today only two of the feature's fourteen actions behave that way. Dragging a
card is fully optimistic (`useBoardDrag`), and editing a task field is locally
optimistic (`useProjectTasks`). Everything else — accepting a quote, ticking a
step, adding a task, creating a project, deleting one, restoring one, writing a
note — fires its request and waits, then invalidates, then waits again for the
refetch. Two round trips before anything moves.

Three further changes ride along, all touching the same surfaces:

1. The board card loses its quote-status badge, which the column already says.
2. The board card gains a discreet progress bar.
3. The detail panel's tasks stop being collapsible and become a list of cards,
   so ticking Done never requires opening anything first.

## Scope

In scope: an optimistic layer over every Aito mutation, the TS mirror of the
board rules that makes card relocation predictable, the contract test that pins
that mirror, the revert signal, the card's badge removal and progress bar, and
the flattening of the task list.

Out of scope, deliberately:

- **Offline queueing.** An optimistic write that cannot reach the server is
  reverted, not held. Retry is the user's, by repeating the action.
- **Optimistic Zoho state.** `quote_sync_state` and `quote_status_block` are
  the sync worker's to write. The one exception is noted under Retry sync.
- **WebSocket push for the board.** The settle-invalidate stays the truth
  source. This spec removes latency, not polling.
- **The quote PDF.** A download, not a state mutation.

### A prior decision, reversed

`2026-07-29-aito-board-rules-and-task-steps-design.md` put per-step progress on
the card out of scope, reasoning that "the column already says which stage a
project is in; a second, finer indicator on the card would say it twice."

That reasoning is narrower than it first looks. The column says *which stage*;
it does not say *how far through the whole job* a project is. A card sitting in
Printing may have one step left or nine. And with the quote-status badge
removed by this spec, the card carries one signal fewer than it did when that
call was made. The bar is added deliberately, overriding that entry.

## Part 1 — The board rules, mirrored and pinned

### The obstacle

`backend/app/services/aito_board_rules.py` opens by stating that it is the only
definition of the board's rules, that it is "never mirrored in TypeScript", and
that "the frontend renders `column` and `move_lock` as the server computes them
and derives nothing of its own".

That rule is what makes optimism impossible for the actions that matter. Every
significant Aito action — accepting a quote, ticking a step, deleting the last
unticked task — moves the card between columns. Without predicting the column,
"reflect directly" can only ever mean "the badge changes and the card sits
still".

### The resolution

The rules are mirrored into TypeScript, and the mirror is pinned by a generated
contract fixture so that drift cannot land green.

**`frontend/src/utils/aitoBoardRules.ts`** mirrors, from the Python module:

- `AWAY_STATUSES`, `STAGES`, `SERVICES`, `COLUMN_ORDER`
- `evaluate(quoteStatus, storedColumn, pending) -> [column, moveLock]`
- `summariseTasks(tasks) -> { count, total, services, pending, stepsTotal, stepsDone }`

`summariseTasks` takes `TaskDraft[]` — the client shape the panel already holds
— not the wire shape. That is what the optimistic layer has in hand at the
moment a step is ticked. The Python original is duck-typed over
`<service>_cost` / `<service>_done` for the same reason, so the two stay
structurally parallel.

`summariseTasks` mirrors `summarise()`, including the two new step counters
introduced in Part 4. It subsumes `taskTotal` in `frontend/src/utils/taskDraft.ts`,
which already mirrors `TaskSummary.total` today under nothing but a comment
reading "if this definition changes, change that one too". `taskTotal` and
`projectTotal` stay where they are as thin wrappers over the shared
computation, so `TaskEditor`'s import does not change.

### The contract fixture

`backend/scripts/gen_aito_board_rules_fixture.py` emits
`frontend/src/__tests__/fixtures/aitoBoardRules.cases.json`, containing two case
sets:

**`evaluate` cases** — the full cartesian product of

- `quote_status` ∈ {null, draft, sent, viewed, expired, declined, accepted, and
  one unrecognised value} — 8
- `stored_column` ∈ `COLUMN_ORDER` — 7
- `pending` ∈ the powerset of `SERVICES` — 16

= 896 cases, each recording `(column, move_lock)`.

**`summarise` cases** — a hand-picked set of task shapes covering the traps this
codebase has already been bitten by: a cost of `0` (a real, free step) against a
cost of `null` (an absent one); a `*_done` flag set on a service whose cost is
`null`; an empty task list; a task with every service priced; and float totals
that must not be rounded.

Two tests consume it:

- `backend/tests/unit/services/test_aito_board_rules_contract.py` asserts the
  checked-in fixture equals what the generator produces from the current Python.
  It reads and never writes, so it is safe under `pytest -n 30`.
- `frontend/src/__tests__/utils/aitoBoardRules.test.ts` asserts the TS mirror
  reproduces every case in the fixture exactly.

The chain: change `evaluate()` or `summarise()` in Python → the backend test
goes red until the fixture is regenerated → regenerating turns the frontend test
red until the TS mirror is updated. Neither language can move alone.

`aito_board_rules.py`'s docstring is rewritten to describe this arrangement
rather than to forbid mirroring, and to name the generator script as the thing
to re-run.

### Why not the alternatives

Serving the rules as data from an endpoint was considered. The tables
(`AWAY_STATUSES`, `STAGES`) transport cleanly, but `evaluate()`'s *ordering* is
control flow, not data — waiting outranks the steps, and the stage search must
run before the nothing-left-to-do fallback. Both orderings would still be
hand-written in TypeScript, unpinned, which is the part that actually drifts.

Partial optimism — instant in-panel feedback with the card's column move still
waiting on the server — was considered and rejected: the card leaving the Quote
column is the single most visible consequence of accepting a quote, and leaving
it laggy would miss the point of the exercise.

## Part 2 — The optimistic layer

### `frontend/src/utils/aitoOptimistic.ts`

Pure `AitoProject[] -> AitoProject[]` transforms. No React, no network, no query
client — unit-testable without mounting anything. That constraint is taken
directly from `useProjectTasks`'s own docstring, which records the cost of the
previous arrangement: "All of that reasoning is preserved below — it was
correct, it was just impossible to test without mounting a modal."

```
applyQuoteStatus(projects, id, status)
applyTaskSummary(projects, id, summary)
applyDescription(projects, id, text)
applyDelete(projects, id)
applyRestore(projects, project)
applyCreate(projects, placeholder)
```

Each one reproduces what the server does, `_apply_rules` included
(`backend/app/api/routes/aito.py:170`): recompute the column via `evaluate()`,
and if it changed, append the project to the **end** of the destination column
and renumber the source column contiguously. Getting that relocation wrong is
not a correctness risk — the settle-invalidate corrects it one round trip later
— but getting it right is what stops the card visibly jumping twice.

`toOptimisticProjects` and the board helpers in `frontend/src/utils/aitoBoard.ts`
stay as they are; the new module composes with them rather than replacing them.

### `useOptimisticBoardMutation`

One wrapper around `useMutation`, owning the sequence every board write needs:

| Phase | What it does |
|---|---|
| `onMutate` | `cancelQueries(['aito-projects'])`, snapshot the cache, apply the transform, return the snapshot |
| `onError` | restore the snapshot, flash the affected id, toast |
| `onSettled` | decrement the in-flight count; the **last** one to settle invalidates |

Two rules are inherited from `useBoardDrag`, which already solved both:

**Serialization.** Its `scope: { id: 'aito-move' }` widens to
`scope: { id: 'aito-board' }` and covers every mutation that writes
`['aito-projects']` — move, quote status, delete, restore, create. Without a
shared scope, two overlapping writes race the endpoint and the second's
prediction, computed against a board that assumed the first had landed, can be
persisted first.

**The settle guard.** Only the last mutation to settle invalidates. Invalidating
while another is in flight lets the resulting GET — which predates that
mutation — overwrite its optimistic cache entry.

`pendingMoves` and `syncGeneration` move out of `useBoardDrag` into a shared
`useBoardSync` hook. This is required, not tidiness: `useBoardDrag`'s local
`board` rebuilds from `projects` whenever no move is pending, so a quote-status
change landing mid-drag-settle would rebuild the board from stale data unless
both mutations feed the same counter.

**Known limit, inherited and accepted.** Concurrent rollbacks stack: two
failures in flight, and the second's snapshot restores over the first.
`useBoardDrag` documents this today and the settle-invalidate corrects it one
round trip later. The wrapper carries the same note rather than pretending to
solve it.

### Per-action behaviour

| Action | Instant effect | On rejection |
|---|---|---|
| Mark sent / accept / decline | card relocates via `evaluate()`; panel's action block updates | snap back, flash, `aito.saveFailed` |
| Tick / untick a step | checkbox flips, progress bar slides, card relocates | all three revert, flash |
| Task field edit | already instant; **new:** card's total, badges and bar update too | unchanged (422 rollback from `baselineRef` stays exactly as-is) |
| Add task | row appears at once, inputs inert until its id lands | row removed, flash |
| Delete task | row goes, card summary and column update | row returns, flash |
| Edit description | panel text and card update | reverts, flash |
| Create project | modal closes, placeholder card appears | card removed, `aito.createFailed` |
| Import quote | modal closes, placeholder card appears | card removed, existing 409 `aito.quoteAlreadyHasProject` |
| Delete project | card goes, source column renumbers | card returns, flash |
| Restore from trash | trash row goes, card appears on the board | row returns, existing 409 `aito.restoreBlockedByQuote` |
| Add note | note prepends to the rail | note removed, `aito.history.noteFailed` |
| Retry sync | sync row flips to `pending` | reverts to `error`, flash |

**A task edit writes the board cache but must not refetch it.**
`useProjectTasks` deliberately refreshes the board once, on close, and only if
something was really saved — the counter around `closedRef` / `inFlightRef`
exists to guarantee that. The row above adds an optimistic `setQueryData` on
each debounced save so the card's total and bar keep up; it does **not** add an
`invalidateQueries`. A cache write is free, a refetch is a per-keystroke GET.
The existing close-time invalidation stays the only board refetch on this path.

Two things deliberately do not revert:

- **`zoho_synced === false`** on a successful status change. The board really is
  right; only the push to Books failed. It stays a separate warning toast
  (`aito.zohoNotUpdated`) with no rollback, exactly as today.
- **`syncClientToZoho`.** Already fire-and-forget, touches no board state.

### Placeholder identity

Creates have no id until the server answers. A **module-level** monotonic
counter yields negative ids (`-1`, `-2`, …) — a space real ids never occupy.
Module-level rather than per-hook: the board create, the quote import and the
trash restore can all have placeholders outstanding at once, and a per-surface
counter would hand two of them the same id.

`isPlaceholder(project)` is `project.id < 0`. A placeholder card renders at
`opacity-60`, has no drag grip, does not expand, and offers no mark-sent
control. That inertness is the point: it is what stops a user editing a row
whose id does not exist yet, which is the one way optimistic creates actually
corrupt state. On success the placeholder is swapped for the real row in place;
on failure it is removed.

Tasks need no new concept. `TaskDraft.id === null` already means "not
persisted", `uid` already provides a stable identity for such a row, and
`useProjectTasks.onTasksChange` already returns early for one ("not yet
persisted; nothing to PATCH"). An optimistic add pushes an `emptyTaskDraft()`
into `tasks` immediately and matches the response back by `uid`.

Notes prepend into the first page of the `['aito-events', projectId]` infinite
query with a negative id, and are removed on failure.

## Part 3 — The revert signal

Every failure path today fires a toast and nothing else. Once actions are
optimistic, a rejection also causes something on screen to move *backwards* — a
card jumping back to Quote, a checkbox un-ticking, a deleted card reappearing.
A toast alone leaves that unexplained: the user reads "Save failed", looks at
the panel in front of them, and never notices the card behind it moved.

`useRevertFlash` exposes `flash(id)`, which marks a project id for 600 ms. The
sortable card reads it and renders `ring-2 ring-status-error/60`, fading out.
Under `prefers-reduced-motion` the ring appears and disappears without the fade.

The toast is unchanged in every case — same keys, same wording. The flash adds a
referent, it does not replace the message.

## Part 4 — The card: badge out, bar in

### The quote-status badge is removed

`CardView.tsx:200`'s badge block goes. `quoteStatusLabelKey` stays — the detail
panel uses it — but `quoteStatusStyle` becomes dead and is deleted with it. An
unused *export* draws no ESLint error, so this needs a grep sweep rather than a
compiler run.

**Accepted information loss.** The column is derived from the status, but not
injectively. `evaluate()` collapses `sent`, `viewed` and `expired` all into
Waiting, and puts `declined` in Done alongside a genuinely finished project. The
card therefore stops distinguishing "the client opened it" from "it expired
unanswered", and a declined card becomes indistinguishable from a completed one.

This is accepted rather than overlooked. The detail panel still shows the exact
status, and `aito.quoteDeclinedNoDraft` already renders there for a declined
card specifically because it is otherwise invisible.

### The progress bar

A 2px track flush to the card's bottom edge, inside the rounded corner. Green
fill over a `bg-bambu-dark-tertiary` track. No percentage text — at that size
the number is noise; `role="progressbar"` with `aria-valuenow`, an
`aria-label`, and a `title` of "3 / 10" carry it for assistive technology and
on hover.

The bar is hidden entirely when `steps_total === 0`. An unpriced project has
nothing to measure, and an empty bar on every fresh card is clutter, not
information.

Width transitions on `--ease-signature`, so an optimistic tick visibly slides
it. Static under `prefers-reduced-motion`.

**What it measures.** A step is one (task, service) pair whose cost is not
null — the same membership rule `summarise()`, `taskSteps` and `enabledServices`
all already use. Three tasks carrying ten steps between them with three ticked
reads 30%.

A step quoted at `0` counts as a full step. This is the rule the whole codebase
already insists on: `null` means the service is absent from the job, `0` means
it is quoted free, and free is real work. Cost-weighting was considered and
rejected for exactly this reason — a free step could never move the bar, and a
project priced entirely at zero would divide by zero.

**The wire.** `summarise()` already loops tasks × services, so the counters fall
out of the existing pass at no extra cost:

- `TaskSummary` gains `steps_total: int` and `steps_done: int`
- `AitoProjectResponse` gains both, set in `_to_response`
- The TS `AitoProject` interface gains both
- `summariseTasks` in the mirror computes both, so an optimistic tick moves the
  bar in the same frame it relocates the card

Both counters join the contract fixture's `summarise` case set.

## Part 5 — Tasks as a list of cards

### What goes

`expanded` and `onToggle` leave `TaskRowProps`. `expandedKeys` and its `toggle`
leave `TaskEditor`. The row header stops being a toggle button and becomes a
plain heading: name, finished check, total. The chevron goes, along with the
`aria-expanded` / `aria-controls` pairing.

The collapsed-only `ServiceBadges` in the row header go too — the step list
below now always renders and names every service, so the badges would be saying
it twice.

### What that simplifies

`editing` becomes derived rather than purely stateful:

```ts
const editing = editingKeys.has(key) || taskSteps(task).length === 0;
```

A row with no steps *is* the form — there is nothing else it could show but
"No steps yet". That one line deletes `addRequestedRef`, `previousKeysRef` and
the effect between them, whose entire purpose was to open a newly added row in
edit mode.

It also fixes the create modal, which shares `TaskEditor`. Today its first task
starts both collapsed and not editing, so pricing it costs two clicks before the
user can type anything. With this rule the modal opens straight into the form.

The pencil is hidden on a stepless row: there is no other mode to switch to, so
an inert toggle would explain nothing.

### No performance regression

The collapse was documented as keeping a closed row cheap by not mounting
`ImpressionFields`' three reference-data queries. Those live in
`TaskStepFields`, which still only mounts behind the pencil. An always-open row
in read mode renders `TaskStepList`, whose only query is the shared `['settings']`
entry the card and the calculator page already populate.

### Test sweep

`frontend/tsconfig.app.json` excludes `src/__tests__`, so neither
`npx tsc --noEmit` nor `npm run build` type-checks test files. Removing props
from `TaskRowProps` will produce **no compiler error** in any fixture. The
affected suites are found and swept by grep:

- `AitoTaskStepList.test.tsx`
- `AitoTaskStepFields.test.tsx`
- `AitoCardView.test.tsx`
- `AitoPage.test.tsx`
- `AitoQuoteStatusActions.test.tsx`

## Build order

Five stages, each one shippable and testable on its own:

1. **The mirror and its pin** — `aitoBoardRules.ts`, the generator, both
   contract tests, plus the `steps_total` / `steps_done` counters through
   `TaskSummary`, the schema and `_to_response`. Nothing user-visible changes;
   this is the foundation the rest stands on.
2. **The optimistic layer** — `aitoOptimistic.ts`, `useOptimisticBoardMutation`,
   `useBoardSync`, `useRevertFlash`, and the counter extraction from
   `useBoardDrag`. Still nothing user-visible until a call site adopts it.
3. **Call-site adoption** — the twelve actions in the Part 2 table, one at a
   time. Quote status first: it is the most visible and exercises column
   prediction, placeholder-free.
4. **The card** — badge removal and the progress bar.
5. **The task list** — flattening, the derived `editing` rule, and the grep
   sweep of the five test suites.

Stage 1 must land before 2; 4 depends on the counters from 1; 3 and 5 are
independent of each other.

## Files

**New**

- `frontend/src/utils/aitoBoardRules.ts` — the mirror
- `frontend/src/utils/aitoOptimistic.ts` — pure cache transforms
- `frontend/src/hooks/useOptimisticBoardMutation.ts` — the wrapper
- `frontend/src/hooks/useBoardSync.ts` — shared in-flight counter and generation
- `frontend/src/hooks/useRevertFlash.ts` — the 600 ms flash
- `frontend/src/components/aito/ProjectProgress.tsx` — the bar
- `backend/scripts/gen_aito_board_rules_fixture.py`
- `frontend/src/__tests__/fixtures/aitoBoardRules.cases.json` (generated)
- `backend/tests/unit/services/test_aito_board_rules_contract.py`
- `frontend/src/__tests__/utils/aitoBoardRules.test.ts`
- `frontend/src/__tests__/utils/aitoOptimistic.test.ts`

**Modified**

- `backend/app/services/aito_board_rules.py` — step counters, rewritten docstring
- `backend/app/schemas/aito.py` — `steps_total`, `steps_done`
- `backend/app/api/routes/aito.py` — `_to_response`
- `frontend/src/api/client.ts` — `AitoProject` gains both counters
- `frontend/src/pages/AitoPage.tsx` — create, import, delete
- `frontend/src/hooks/useBoardDrag.ts` — counter extracted, scope widened
- `frontend/src/hooks/useProjectTasks.ts` — optimistic add/delete, board projection
- `frontend/src/hooks/useQuoteStatusMutation.ts` — optimistic
- `frontend/src/components/aito/CardView.tsx` — badge out, bar in
- `frontend/src/components/aito/TaskEditor.tsx` — collapse removed
- `frontend/src/components/aito/TaskRow.tsx` — collapse removed
- `frontend/src/components/aito/ProjectDetailPanel.tsx` — optimistic description, retry
- `frontend/src/components/aito/TrashModal.tsx` — optimistic restore
- `frontend/src/components/aito/history/ActivityRail.tsx` — optimistic note
- `frontend/src/components/aito/quoteStatus.ts` — `quoteStatusStyle` deleted
- `frontend/src/utils/taskDraft.ts` — `taskTotal` delegates to the mirror
- `frontend/src/index.css` — the flash keyframe

## Testing

- **Pure transforms** (`aitoOptimistic`, `aitoBoardRules`) — unit tests, no
  mounting. This is the bulk of the new coverage and the reason both modules are
  pure.
- **Contract** — the two paired tests described in Part 1.
- **Revert paths** — one component test per action asserting the optimistic
  write lands, the failure reverts it, and the toast fires.
- **Regression** — the existing drag, accept-gate and task-step suites must pass
  unchanged apart from the prop sweep in Part 5.

Full gate before completion: `cd frontend && npm run build`, `./test_frontend.sh`,
`./test_backend.sh`.

## i18n

New user-facing strings need entries in all thirteen locales under
`frontend/src/i18n/locales/`. The i18n gate rejects English text left in a
non-English file, so placeholders will not pass. Expected new keys are few — the
progress bar's `aria-label` and title. Every toast this spec fires reuses an
existing key.
