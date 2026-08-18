# Aito task drag-to-reorder — design

**Date:** 2026-08-18
**Status:** Approved

## Goal

Let the user reorder a project's tasks by dragging, from the expanded project
card (detail panel) and from the New Project drawer. The persisted order drives
the quote: reordering tasks reorders the lines on the Zoho quote (and therefore
the printable PDF, which is Zoho's own render).

## Context (what already exists)

- `AitoTask.position` is the persisted order; every consumer already sorts by
  `position, id`: the task list endpoints (`aito.py:158`, `aito.py:993`) and
  the Zoho quote sync (`aito_quote_sync.py:291`). The quote PDF proxies Zoho's
  render, so quote order == synced line order. **No quote code changes.**
- `@dnd-kit/core` / `@dnd-kit/sortable` / `@dnd-kit/utilities` are already
  installed and power the board drag.
- `TaskEditor` renders the rows for BOTH callers (detail panel, create
  drawer), keyed by `rowKey` (server id, or draft uid) — a stable identity
  dnd-kit can use directly.
- `TaskRow` already has the grid-row fold animation (`grid-rows-[0fr/1fr]`,
  200/250ms, `--ease-exit` / `--ease-signature`) used by the drawer's
  accordion.
- Task edits mark the quote pending via `_mark_project_pending_for_task` →
  `_mark_pending_if_ours` (which protects `unmanaged` imported projects), then
  `_commit_and_wake` wakes the sync worker and `_broadcast_changed` notifies
  other viewers.

## 1. Interaction & motion

- A **grab handle** (`GripVertical`, lucide) in each task card's header,
  top-right, immediately before the pencil. Muted (`text-bambu-gray`) at rest,
  white on hover, `cursor-grab` / `cursor-grabbing`, same `p-1 -m-1` hit-area
  idiom and `focusRingCls` as the pencil. Localized `aria-label`
  (`aito.reorderTask`).
- Drag is **handle-only** (listeners attached to the handle, not the card), so
  the Done ticks, inputs, and the accordion header button are unaffected.
- **On drag start, every row folds to its one-line header** by driving
  `TaskRow`'s existing `collapsed` fold (the prop's grid fold works without
  `onToggleCollapse`; the header stays a plain heading). The user shuffles
  compact cards; on drop the rows unfold and settle. `TaskStepFields` keeps
  its `!collapsed` mount gate — a row folded mid-edit remounts its form after
  the drop (edit state lives in `TaskEditor`'s `editingKey`, which survives).
- Neighbors slide out of the way via dnd-kit sortable transforms; transition
  ~250ms with `var(--ease-signature)` to match the house motion language. The
  dragged card gets slight scale (~1.02), an elevated shadow, raised z-index,
  and `will-change-transform` while in flight. No `DragOverlay` — plain
  transform-based sorting keeps the DOM (and focus) stable.
- `motion-reduce:` disables the transitions, as everywhere else in the panel.
- **Keyboard & SR:** `PointerSensor` (small activation distance) +
  `KeyboardSensor` with `sortableKeyboardCoordinates`; the handle is a real
  `<button>`, so focus → space → arrows reorders. dnd-kit's default
  announcements are acceptable for v1.
- The handles are **absent** (not disabled) when: ANY row's create POST is
  still in flight (`pendingUids` non-empty — a row with no server id cannot
  be placed in a persisted order, and reordering around it would misnumber
  its landing slot; the window is one POST round-trip), the caller lacks
  reorder rights (detail panel passes `onReorder` only with `aito:update`;
  drawer always allows), or the list has fewer than 2 rows.

## 2. Frontend wiring

- `TaskEditor` gains an optional `onReorder(next: TaskDraft[])` prop. When
  present, rows render inside `DndContext` + `SortableContext`
  (`verticalListSortingStrategy`), items keyed by `rowKey`. On `dragEnd` it
  calls `onReorder(arrayMove(value, from, to))`. When absent, markup is
  unchanged (no context, no handles). Nesting inside the board page's
  `DndContext` is safe — separate contexts, and the panel is modal anyway.
- An `isDragging` local state (set on `dragStart`/`dragEnd`/`dragCancel`)
  drives the fold: `collapsed={collapsed || isDragging}` per row.
- **Create drawer (`NewProjectDrawer`)**: `onReorder` = reorder the local
  draft array in place (`onChange`-style state update). Order persists through
  the existing create POST, which already writes `position` = array index.
- **Detail panel (`useProjectTasks`)**: gains `reorderTasks(next)`:
  1. Optimistically `setTasks(next)` (instant UI).
  2. Fire one mutation: `api.reorderAitoTasks(projectId, ids)` where `ids`
     is the full ordered list of server ids (guaranteed non-null: handles
     are hidden while any create is in flight, see §1).
  3. Participates in the hook's existing guards: bumps `inFlightRef` around
     the request so the resync effect can't stomp the optimistic order, bumps
     `tasksSyncGeneration` on settle, sets `tasksDirtyRef` so the board (task
     mini-rows) refreshes once on panel close via `resyncIfIdle`.
  4. Consecutive drags serialize; each request carries the complete latest
     order, so the last one to run wins. A drop while a reorder request is in
     flight queues (latest-order ref), sent when the in-flight one settles —
     never two racing reorder requests.
  5. On error: toast (reuse the task-save error toast pattern) and resync
     from the server (invalidate `['aito-tasks', projectId]`).
- `client.ts`: `reorderAitoTasks(projectId: number, taskIds: number[])` →
  `PATCH /api/v1/aito/{projectId}/tasks/reorder`.

## 3. Backend

New endpoint in `backend/app/api/routes/aito.py`:

```
PATCH /api/v1/aito/{project_id}/tasks/reorder
body: {"task_ids": [int, ...]}        # complete desired order
perm: Permission.AITO_UPDATE          # existing; no new permission
resp: list[AitoTaskResponse]          # the tasks in new order
```

Behavior:

1. 404 if the project is missing or deleted (same `_get_active_project_or_404`
   idiom as `move_project`).
2. Load the project's tasks; **409 if `task_ids` is not exactly the current
   task-id set** (duplicates, missing, or foreign ids) — this catches a
   concurrent add/delete; the client resyncs and the user drags again.
3. Renumber: `task.position = index` per the payload order.
4. Record one `task.reordered` event (actor from `current_user`,
   `subject_type="project"`) — one event per gesture, not per task.
5. Mark quote sync pending via the same gate as every task edit
   (`_mark_pending_if_ours` on the loaded project; emit `sync.queued` only on
   a genuine idle→pending transition, mirroring `update_task`).
6. `_commit_and_wake`, `_broadcast_changed("task", project_id, actor)`.
7. **No `_apply_rules`**: order affects neither costs nor ticks, so the board
   column cannot change.

Schema: `AitoTaskReorder` (`task_ids: list[int]`) in `schemas/`. No DB
migration — `position` already exists.

Route-ordering check: `PATCH /{project_id}/tasks/reorder` must not be
shadowed; the only other PATCH routes are `/tasks/{task_id}`, `/{project_id}`,
`/{project_id}/move`, `/{project_id}/flag` — no collision, but register it
before `PATCH /{project_id}` regardless, matching the project's established
specific-before-generic ordering.

## 4. Quote propagation

Nothing new: sync worker wakes → pushes lines ordered by `position, id` →
Zoho quote (and its PDF) reflect the new order. Unmanaged/imported projects
are never touched (`_mark_pending_if_ours`). A project whose quote is
`locked`/sent follows the exact same rules as any other task edit today.

## 5. i18n & events

- `eventKinds.ts`: `'task.reordered': 'aito.history.taskReordered'`.
- New keys, EN + **real French** (the i18n gate rejects EN placeholders):
  `aito.reorderTask` ("Reorder task" / "Réordonner la tâche"),
  `aito.history.taskReordered` ("reordered the tasks" / "a réordonné les
  tâches" — match surrounding history-key phrasing).

## 6. Testing

- **Backend** (`backend/tests/unit/.../test_aito*`): renumbering persists and
  `GET /tasks` returns the new order; 409 on id-set mismatch (missing, extra,
  duplicate); pending gating (idle→pending marks + `sync.queued`; `unmanaged`
  untouched; already-pending emits no second `sync.queued`); 404 deleted
  project; permission enforced.
- **Frontend** (Vitest): `TaskEditor` renders handles only when `onReorder`
  present and ≥2 rows, hides them all while any row is pending; `onReorder` receives the
  moved array (simulate via dnd handlers, not real pointer events);
  `useProjectTasks.reorderTasks` — optimistic order, serialized second drag,
  error path resyncs; `eventKinds` mapping covers `task.reordered`.
- **Full suites**: `cd frontend && npm run build`, `./test_frontend.sh`,
  `./test_backend.sh` from project root.

## Out of scope

- Reordering from the board card (mini-rows) — panel and drawer only.
- Custom screen-reader announcement strings (dnd-kit defaults for v1).
- Multi-select / cross-project task moves.
