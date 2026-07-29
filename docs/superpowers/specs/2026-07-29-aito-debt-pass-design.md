# Aito: debt pass — one derived truth, debounced saves, three extractions

**Date:** 2026-07-29
**Status:** approved, ready for an implementation plan

## Goal

Pay down the debt the Aito board accumulated across four features shipped in
quick succession (tasks and services, quote import, quote push, board rules).
No user-visible feature changes, one user-visible *fix*: a card whose quote is
still being created now resolves on screen instead of waiting for a window
blur.

Three things, in descending order of payoff:

1. **Task edits stop PATCHing per keystroke.** A 40-character description
   currently costs 40 requests, each running the rule engine and handing the
   project to the Zoho worker.
2. **The board's derived state gets one definition** instead of two — a SQL
   aggregate and a pure-Python function that compute the same thing.
3. **Three logic-owning units come out of two oversized files.**

## Why now

This is the only one of the three tracks that gets harder with time: every new
board feature lands in `AitoPage.tsx` (626 lines) and
`ProjectDetailPanel.tsx` (579 lines) as they stand, and every one adds a field
that `diffTaskDraft` must be manually taught about.

## Scope

Deliberately excluded, and why:

- **Presentational splits** (`DescriptionEditor`, `ProjectMetadata`,
  `SyncRow`). These hold no logic; the win is readability only, against churn
  in files another workstream just edited.
- **A shared combobox hook.** `ClientCombobox` and `QuoteCombobox` differ in
  255 of roughly 356 lines. They share a debounce-and-listbox *shape*, not an
  implementation; a shared hook would be forced.
- **The `taskTotal` TS/Python duplication.** `taskDraft.ts` mirrors the backend
  total and cannot share code with it. Both sites already carry a comment
  saying so. A generated schema is the real fix and is its own project. The
  backend nonetheless goes from two definitions to one.
- **Pushing sync state over the WebSocket.** Better than polling, bigger than
  this pass.

## 1 · Backend: one source of derived truth

### The problem

`total`, `services` and `pending` are each defined twice:

| concept | definition A | definition B |
|---|---|---|
| enabled services | `MAX(CASE(cost IS NOT NULL))` in `_task_summaries` | — |
| pending services | `MAX(CASE(cost IS NOT NULL AND done IS FALSE))` in `_task_summaries` | `pending_services()` in `aito_board_rules.py` |
| task total | `SUM(COALESCE(...))` in `_task_summaries` | `taskTotal` in `taskDraft.ts` |

The read path (`list_projects`) believes the SQL. The write path
(`_apply_rules`) believes the Python, and pays its own
`SELECT * FROM aito_tasks WHERE project_id = ?` to get it — on **every** task
mutation, which today means every keystroke.

### The shape

`aito_board_rules.py` — already pure, already the sole owner of `evaluate()` —
absorbs the aggregate:

```python
@dataclass(frozen=True)
class TaskSummary:
    count: int = 0
    total: float = 0.0
    services: tuple[str, ...] = ()   # enabled, canonical order
    pending: tuple[str, ...] = ()    # enabled but unticked


def summarise(tasks: Iterable[Any]) -> TaskSummary:
    """Everything the board card and the rule engine derive from a project's
    tasks, in one pass."""
```

Still duck-typed over `<service>_cost` / `<service>_done`, so the module
imports no model, needs no database, and stays exhaustively unit-testable.
`pending_services()` collapses into `summarise()`; its callers move over.

`routes/aito.py` drops `_task_summaries`, `_one_summary`, `_SERVICE_COLUMNS`
and `_SERVICE_DONE_COLUMNS`, and gains one plain loader:

```python
async def _tasks_by_project(db: AsyncSession, project_ids: list[int]) -> dict[int, list[AitoTask]]:
    """One query, grouped in Python. Returns {} for an empty id list, and omits
    projects with no tasks — callers fall back to an empty tuple."""
```

`_TaskSummary` and `_EMPTY_SUMMARY` in the routes module are replaced by the
pure module's `TaskSummary` and `TaskSummary()`.

### Query cost: unchanged. This buys one implementation, not fewer queries.

Worth stating plainly, because it is tempting to claim otherwise:

| endpoint | before | after |
|---|---|---|
| `GET /aito/` | projects + 1 aggregate | projects + 1 task load |
| `PATCH /aito/tasks/{id}` | task + project + task load + up to 2 column listings | task + project + task load + up to 2 column listings |

`update_task` returns `_task_to_response(task)` and never asks for a summary,
so the task load it pays today is `_apply_rules`' own — and after the change it
is the caller's, feeding `summarise()`. One query either way. The board swaps an
aggregate for a row load at the same count and slightly more bytes.

**The request-volume win in this pass comes entirely from the debounce
(§2), not from this dedupe.** What the dedupe buys is a single definition of
the rules, in the module that is pure and exhaustively testable, so the read
and write paths can no longer disagree about which services are pending.

`_apply_rules` changes signature to receive the summary rather than compute it:

```python
async def _apply_rules(db: AsyncSession, project: AitoProject, summary: TaskSummary) -> None
```

It has **seven** callers: `create_project`, `add_task`, `update_task`,
`delete_task`, `import_legacy_projects`, `set_quote_status` and
`restore_project`. Each loads the project's tasks once and passes
`summarise(rows)` through.

Two of them get genuinely cheaper, because they already know the answer:

- **`import_legacy_projects` calls `_apply_rules` inside a loop**, so it
  currently runs one task `SELECT` per imported project — an N+1 querying for
  rows that cannot exist, since imported projects are task-free by
  construction. It passes `TaskSummary()` instead and the N queries vanish.
- **`create_project`** likewise knows the tasks it just inserted, so it
  summarises them in memory rather than reading them back.

Row volume is a non-issue: a board of 50 projects averaging 5 tasks is 250
rows. The aggregate saved bytes that were never the bottleneck, at the cost of
a second implementation of the rules.

`_to_response` is unchanged — it still makes exactly one `evaluate()` call to
derive `move_lock`.

## 2 · Frontend: the save path

### The debounce

A new `hooks/useProjectTasks.ts` owns the whole task-editing lifecycle, keyed
**per task id** — the diff is per task and a PATCH carries one task's fields:

```
edit  -> diff vs baseline -> MERGE into that task's pending patch -> reset its 500 ms timer
timer -> flush(id)
blur  -> flush(id)          one onBlur on the row; focusout bubbles in React
close -> flush all, then arbitrate the board refresh
```

**Merge, never replace.** Typing a cost, then a colour, then closing inside one
window must send both fields. A replace-based accumulator would send only the
colour, and the cost would be silently lost — the exact class of bug the
current per-keystroke design cannot have, and the one this change could
introduce if built carelessly.

```ts
useProjectTasks(projectId: number): {
  tasks: TaskDraft[]
  onTasksChange: (next: TaskDraft[]) => void
  onRemoveTask: (index: number) => void
  onRowBlur: (taskId: number) => void
  markClosed: () => void
}
```

### What this does not remove

`closedRef` and the in-flight counter still have to exist. "The panel closed"
and "the last PATCH landed" remain independent events, either can happen
first, and the board must refresh on whichever is last — refreshing while a
PATCH is open races it, and refreshing on the dirty flag alone misses the
mirror case. All of that reasoning, and the 40 lines of comment explaining it,
moves into the hook intact.

What changes is the pressure on it: it now arbitrates one or two requests
instead of forty, so it stops being a hair trigger. And it becomes testable
directly, rather than only through a mounted panel.

### Side effects

`_apply_rules` and the Zoho mark-pending run once per typing pause rather than
once per character. Nothing was designed around the old frequency, so nothing
else has to change.

## 3 · The three extractions

| new file | moved from | owns |
|---|---|---|
| `components/aito/TrashModal.tsx` | `AitoPage.tsx` | the trash list and its restore mutation. A straight move. |
| `hooks/useProjectTasks.ts` | `ProjectDetailPanel.tsx` | tasks query, editable array, `baselineRef`, four mutations, the debounce map, the close/settle counter |
| `hooks/useBoardDrag.ts` | `AitoPage.tsx` | local board, `activeId`, `allowedDropColumns`, `pendingMoves`, `syncGeneration`, the resync effect, the move mutation, `presentIds`, the sensors, all four dnd-kit handlers |

```ts
useBoardDrag(projects: AitoProject[] | undefined): {
  board: Board
  activeProject: AitoProject | null
  dropTarget: ColumnId | undefined
  allowedDropColumns: ColumnId[] | null
  shouldAnimateIn: (id: number) => boolean
  sensors: SensorDescriptor<SensorOptions>[]
  dndHandlers: {
    onDragStart: (e: DragStartEvent) => void
    onDragOver: (e: DragOverEvent) => void
    onDragEnd: (e: DragEndEvent) => void
    onDragCancel: () => void
  }
}
```

Expected sizes: `AitoPage.tsx` about 330, `ProjectDetailPanel.tsx` about 300.

## 4 · The one-time localStorage migration is deleted

`AitoPage.tsx` loses roughly 45 lines plus `LegacyProject`,
`LegacyColumnId`, `LegacyBoard`, `LEGACY_COLUMN_IDS`, `STORAGE_KEY`, the
`migrationAttempted` ref and the `pickup` remapping.

It is gated on the backend board being **empty**, so it cannot fire on any
install that has ever created a card — including this one, which holds 16 rows.
`POST /aito/import` and the server-side column migration
(`_migrate_aito_board_columns`) both stay; only the browser-side import goes.

## 5 · Small fixes

**`diffTaskDraft` becomes field-driven.** It already compares two
`AitoTaskCreate` wire shapes, so:

```ts
function diffTaskDraft(baseline: TaskDraft, next: TaskDraft): AitoTaskUpdate {
  const before = taskDraftToTaskCreate(baseline);
  const after = taskDraftToTaskCreate(next);
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(after) as (keyof AitoTaskCreate)[]) {
    if (after[key] !== before[key]) patch[key] = after[key];
  }
  return patch as AitoTaskUpdate;
}
```

Thirty-four hand-written comparisons become eight lines, and a field added to
`taskDraftToTaskCreate` starts saving automatically instead of silently not
saving. The four `*_done` flags each needed a remembered line; the next field
needs none.

**`quote_sync_state` gains `'unmanaged'`** in `client.ts`. The backend returns
it today and the type denies it exists. `SYNC_LABEL_KEY` has no `unmanaged`
entry, so the detail panel already renders no sync row for a legacy card —
which is the desired behaviour and needs no change.

**The board polls while anything is pending.** `refetchInterval: 10_000` when
any project's `quote_sync_state` is `'pending'`, `false` otherwise. This is
the missing half of the approved "apply silently, the card just updates"
decision: today the placeholder sits until the window blurs, because the
app-wide `staleTime` is 60 s and nothing refetches while focused. Bounded by
construction — the worker ticks every 60 s, so a card resolves within about six
polls, and polling stops dead when nothing is in flight.

## Testing

**The golden payload test is the load-bearing one.** Assert `GET /aito/`
returns byte-identical JSON before and after the aggregation swap, over a
fixture covering: a project with no tasks, one with a zero-cost service, one
with mixed done flags, and one in every board column. Section 1 is a refactor;
this test is what proves it.

Alongside it:

- Exhaustive pure tests for `summarise`: no tasks, all-null costs, a `0` cost
  (enabled and free — must appear in `services`), a ticked step, a service
  enabled on one task and ticked on another.
- A query-count assertion on `POST /aito/import` proving the N+1 is gone: a
  ten-project import must not run ten task `SELECT`s.
- Fake-timer tests for the debounce: N keystrokes produce one PATCH; blur
  flushes early; `markClosed` flushes; and edits to two different fields inside
  one window arrive in the **same** patch.
- `diffTaskDraft`: every field round-trips, and an unchanged field is absent
  from the patch.

**The extractions have a different bar: they must require no test changes at
all.** `TrashModal`, the detail panel and the board are covered by the existing
suite. If a move forces a test edit, the move changed behaviour and is wrong.

## Risk

The debounce is the only change that can lose user data, and it can do so in
exactly one way: a pending patch that is never flushed. Three flush triggers
cover it (timer, blur, close), and the merge rule keeps a second field from
evicting the first. The fake-timer tests exist for this and nothing else.

The extractions are mechanical but touch files a concurrent workstream edited
as recently as this session. They should land last, one commit each, so a
conflict is cheap to resolve.
