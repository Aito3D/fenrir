# Aito Done Grid and Board Search — Design

**Date:** 2026-07-30
**Status:** Approved

## Problem

The Aito board carries seven columns, and Done is the largest and least useful
of them. It is an archive: cards land there and stay, so it grows without bound
while consuming a full column of horizontal space that the six working columns
need. Scanning it as a narrow vertical list is the wrong shape for the volume it
holds.

Separately, the board has no way to find a card. Once past a few dozen projects,
locating one means reading every column.

## Scope

Frontend only. The server already permits `finish ⇄ done` moves through
`PATCH /aito/{id}/move` for released cards (`aito_board_rules.evaluate` returns
`move_lock: None` once nothing is pending), so no backend, schema, or API change
is required.

## Design

### 1. Done leaves the board

`components/aito/columns.ts` drops the `done` entry from `COLUMNS`; the board
renders six columns. The Done metadata moves to a separate `DONE_COLUMN` export
so the grid can reuse its label and dot colour.

`COLUMN_IDS` in `utils/aitoBoard.ts` **keeps** `done`. The data model is
unchanged: `buildBoard` still buckets done cards, `toOptimisticProjects` still
flattens them, and the cache still holds them. Only the rendering changes.

`AitoPage`'s empty-state check currently sums all seven columns. It becomes a sum
of the six *rendered* columns, so a board whose only projects are done reads as
empty rather than falsely populated. When done cards exist, the empty hint points
at the Done grid.

### 2. Mark done and restore

With the Done column gone, the drag that was the board's only manual state
transition is replaced by explicit card actions.

**`applyColumnMove(previous, id, column)`** — new pure transform in
`utils/aitoOptimistic.ts`. Moves the card to the head of the target column and
renumbers both affected columns contiguously. Returns `previous` unchanged when
the id is absent or already in the target column.

**`useColumnMoveMutation`** — new hook wrapping the existing
`useOptimisticBoardMutation`, with
`mutationFn: () => api.moveAitoProject(id, { column, position: 0 })` and
`transform: applyColumnMove`. It inherits the shared `aito-board` mutation scope,
snapshot/rollback, revert-flash, and settle-invalidate arbitration unchanged.

**Buttons** — `HoldButton` at 500 ms, matching the existing mark-sent action:

| Action  | Icon    | Renders when                                          | Target   |
|---------|---------|-------------------------------------------------------|----------|
| Done    | `Check` | `column === 'finish' && move_lock === null`           | `done`   |
| Restore | `Undo2` | `column === 'done' && move_lock === null`             | `finish` |

The `move_lock === null` gate is the server's own derived release value, not a
frontend re-derivation. It is also what hides Restore on declined quotes: the
rules pin those to Done with `move_lock: 'declined'`, and the move endpoint would
409 the attempt.

**CardView action slot.** `CardView` currently special-cases `onMarkSent` with an
inline `project.column === 'devis'` check. Adding two more such prop pairs would
give it three. Instead `onMarkSent`/`markSentPending` are replaced by a single
optional `actions?: ReactNode` footer slot; `SortableCard` and the grid card each
inject their own button and own their own gate. Net two fewer props, and the
column-specific logic leaves the shared presentational component.

### 3. Search

New `utils/aitoSearch.ts`:

```ts
export function matchesSearch(project: AitoProject, query: string): boolean
```

The haystack is `description`, `client_name`, and `quote_number` joined. Matching
is lowercased and accent-folded (`NFD` normalise, strip combining marks) so
`Pièce` matches a typed `piece` — the deployment is French-facing. Space-separated
terms are ANDed: every term must appear somewhere in the haystack. An empty or
whitespace-only query matches everything.

`AitoProject` has no field named `title`; `description` is the card's title text,
so "title and description" resolve to that one field.

**Filtering is applied at the render layer only.** `AitoPage` passes
`board[col].filter(p => matchesSearch(p, query))` into each `BoardColumn`, while
`useBoardDrag` continues to receive the full unfiltered list. This is a hard
requirement stated in that hook's own contract comment: it writes to the
hard-coded `['aito-projects']` key, so a filtered input would make
`setQueryData` overwrite the full cache entry with the filtered subset, deleting
every hidden card until the next settle-invalidate.

**Drag is disabled while filtering.** A drop index computed against a filtered
column would persist a wrong `position`. While the query is non-empty, grips are
inert (`useSortable({ disabled })`) and columns refuse drops
(`useDroppable({ disabled })`). Clearing the search restores dragging. With
mark-done now a button, drag serves only priority reordering — done on the
unfiltered board anyway.

Column count badges show the filtered count, matching what is visible.

The input itself is a small `BoardSearch` component — a `Search` icon, a
controlled text field, and a clear button that appears once there is text. The
query lives in `AitoPage` state; `BoardSearch` is presentational.

The same query filters the Done grid. State is shared between the two views, so
toggling preserves it.

### 4. Done grid

New `components/aito/DoneGrid.tsx`. Replaces the board region when toggled on.

- Responsive: 1 column, to 2 at `sm`, 3 at `lg`, 4 at `xl`.
- Sorted by `updated_at` descending — newest completions first. Stored board
  position is arbitrary drop-order history and is ignored here.
- Reuses `CardView` with no drag handle and no mark-sent, plus the Restore
  action. Cards keep their `data-aito-card-id`, so the existing card-morph into
  `ProjectDetailPanel` works from the grid without change.
- A private `DoneCard` wrapper inside the module owns the per-project
  `useColumnMoveMutation` and renders the Restore button into `CardView`'s
  `actions` slot. Same one-hook-per-project layering `SortableCard` already uses
  for mark-sent; the grid itself holds no mutation.
- Its own empty state ("nothing done yet"), and a distinct no-results state when
  a search hides every card.

The header button flips between `Show Done (N)` — where N is `board.done.length`
— and `Back to board`.

Neither the toggle nor the search text persists. The page always opens on the
Kanban with an empty query.

### 5. Scrollbars

`.scrollbar-hide` already exists in `index.css:413` (`scrollbar-width: none` plus
the `::-webkit-scrollbar` rule). It is applied to every scroller in the feature:

- `AitoPage` board horizontal scroller
- `BoardColumn` card list
- `DoneGrid`
- `ProjectDetailPanel`, `TrashModal`, `NewProjectModal`, `NewContactForm`,
  `ImportQuoteModal`
- `ClientCombobox` and `QuoteCombobox` dropdowns

## Files

**New**
- `frontend/src/utils/aitoSearch.ts`
- `frontend/src/hooks/useColumnMoveMutation.ts`
- `frontend/src/components/aito/DoneGrid.tsx`
- `frontend/src/components/aito/BoardSearch.tsx`

**Modified**
- `frontend/src/components/aito/columns.ts` — drop `done`, export `DONE_COLUMN`
- `frontend/src/components/aito/CardView.tsx` — `actions` slot replaces
  `onMarkSent`/`markSentPending`
- `frontend/src/components/aito/BoardColumn.tsx` — filtered projects, drag
  disable, mark-done button, `scrollbar-hide`
- `frontend/src/pages/AitoPage.tsx` — search and toggle state, header controls,
  board/grid switch, empty-state count
- `frontend/src/utils/aitoOptimistic.ts` — `applyColumnMove`
- The five modals/comboboxes listed above — `scrollbar-hide`
- All 13 locale files

## Testing

**New**
- `utils/aitoSearch.test.ts` — accent folding, multi-term AND, empty query,
  null `client_name`/`quote_number`, case insensitivity.

**Extended**
- `utils/aitoOptimistic.test.ts` — `applyColumnMove`: renumbering both columns,
  unknown id, already-in-target no-op.
- `pages/AitoPage.test.tsx` — Done column absent from the board; toggle shows the
  grid and the count; search filters cards across columns; empty state counts
  only rendered columns.
- `components/AitoCardView.test.tsx` — the `actions` slot; existing mark-sent
  assertions moved to the injecting parent.
- `pages/AitoPageDragLock.test.tsx` — drag disabled while a query is active.

Done-grid coverage (sort order, restore gate, declined cards showing **no**
restore button) goes in a new `components/AitoDoneGrid.test.tsx`.

## i18n

New keys, added to all 13 locales with real translations — the parity test
rejects English placeholders:

`aito.showDone`, `aito.backToBoard`, `aito.doneEmpty`, `aito.markDone`,
`aito.restoreToFinish`, `aito.searchPlaceholder`, `aito.searchNoResults`,
`aito.clearSearch`.

## Out of scope

- Server-side search or pagination for Done. The board already loads every
  project in one request; the grid renders from the same cached list.
- Any change to the board rules, the move endpoint, or Zoho sync.
- Reordering within the Done grid. Done is an archive; its order is derived
  from `updated_at`.
