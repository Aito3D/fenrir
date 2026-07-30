# Reorder a locked Aito card inside its own column

Date: 2026-07-29
Status: approved, ready to plan

## Problem

Commit `30695ad45` ("make a rule-locked card ungrabbable instead of unmovable")
removed the drag grip from any card whose `move_lock` is non-null and passed
`disabled: true` to its `useSortable`. The commit message names the trade-off it
took deliberately:

> a locked card can no longer be reordered inside its column either, so the
> Quote column can't be re-prioritised by drag while its cards wait on
> acceptance.

That trade-off is the thing we now want back. The Quote and Waiting columns
accumulate cards that are all locked by the same rule, and there is no way to
say which of them matters most.

The objection that motivated `30695ad45` was real and is not dismissed here: a
grip that lifts a card and then refuses every destination reads as broken. This
design keeps the grip *and* removes the ambiguity, rather than trading one for
the other.

## What already permits this

Reordering inside a column is already legal at every layer except the one that
renders the grip. Nothing in the rule model has to change.

- `backend/app/api/routes/aito.py` — `move_project` only raises 409 when
  `payload.column != project.board_column`. A same-column reorder from a locked
  card is accepted and renumbers positions normally. The comment there already
  says so: "Reordering inside a column is always allowed: it changes priority,
  not state."
- `frontend/src/utils/aitoBoard.ts` — `allowedColumns()` returns
  `[project.column]` for a locked card, so the card's own column is always an
  allowed drop destination.
- `frontend/src/hooks/useBoardDrag.ts` — `isDropAllowed()` resolves the
  destination column for the hovered id and checks it against
  `allowedDropColumns`. A same-column drop passes; every cross-column drop from
  a locked card is refused before `applyCrossColumnMove` runs.
- `computeMoveTarget()` handles the same-column case as the `movedColumns ===
  false` branch, and the optimistic write, rollback, and settle-refetch in
  `useBoardDrag` are shared with cross-column moves.

The only blocker is `disabled: locked` in `BoardColumn.tsx` and the withheld
handle props in `CardView.tsx`.

## Design

### 1. Restore the grip — `frontend/src/components/aito/BoardColumn.tsx`

In `SortableCard`:

- Delete the `locked` const and its explanatory comment.
- Remove `disabled: locked` from the `useSortable` call. With it gone both the
  pointer and keyboard sensors work on every card.
- Pass `setActivatorNodeRef` and `{ ...attributes, ...listeners }`
  unconditionally, as they were before `30695ad45`.
- Replace the removed comment with one stating the new rule: every card is
  grabbable because reordering inside a column is always allowed; the
  destination gate in `useBoardDrag` (and the server's 409) is what stops a
  locked card leaving its column.

### 2. Show the lock *and* the grip — `frontend/src/components/aito/CardView.tsx`

The header currently renders `lockTitle ? <lock> : dragHandleProps ? <grip> :
<static grip>`. Change it so the lock badge and the grip are siblings, not
alternatives:

```
[ client name (flex-1) ] [ lock badge, if move_lock ] [ grip ]
```

- The lock badge keeps its `role="img"`, `aria-label`, `title`, and
  `LOCK_LABEL_KEYS` lookup — the "why" stays discoverable at a glance and its
  wording ("Locked to Quote until the quote is accepted") remains accurate,
  because the card is still locked *to a column*.
- The grip keeps `aria-label={t('aito.dragHandle')}`, `touch-none`,
  `cursor-grab`/`active:cursor-grabbing`, and its focus ring.
- The existing fallback — a static, non-interactive `GripVertical` when
  `dragHandleProps` is absent — stays, and is what the DragOverlay clone
  renders.
- The badge and grip both carry `-m-2` negative margins today; with two
  elements adjacent, the spacing must be checked so they do not overlap. Use
  the header's existing `gap-2` and adjust the badge's padding rather than
  introducing a new spacing scale.

No new i18n keys. Both strings already exist in EN and FR.

### 3. Make a refused column look refused — `BoardColumn.tsx`, `AitoPage.tsx`

`AitoPage` already computes `dropDisabled={allowedDropColumns !== null &&
!allowedDropColumns.includes(column.id)}` and `BoardColumn` already forwards it
to `useDroppable({ disabled })`. Today that is invisible: the column silently
stops accepting drops.

Give it a visual. When `dropDisabled` is true the column dims (`opacity-40`),
with the fade added to the wrapper's existing
`transition-[border-color,box-shadow]` so it animates rather than snapping.

This is not locked-card-specific and should not be. During any drag the board
now shows which columns are open:

- dragging a locked card → only its own column stays lit;
- dragging an unlocked card (always in Finish or Done) → Finish and Done stay
  lit, the other five dim.

Dimming is purely visual; `useDroppable({ disabled })` remains what actually
refuses the drop.

### Out of scope

- `useBoardDrag.ts` and `aitoBoard.ts` are unchanged.
- All backend code is unchanged.
- No change to which columns a card may cross into. Finish <-> Done for an
  unlocked card remains the only cross-column move, enforced in
  `allowedColumns()`, `isDropAllowed()`, and `move_project`.

## Testing

Three existing specs assert the behaviour being reverted and must be inverted.
Each keeps its counterpart assertion so the cross-column lock stays guarded.

`frontend/src/__tests__/components/AitoBoardColumnDrag.test.tsx`
- Replace "disables the sortable and renders no grip when the rules lock the
  card" with a test that a locked card is grabbable: `useSortable` is called
  without `disabled: true`, the grip button renders, `setActivatorNodeRef` is
  called, and the lock badge is still present alongside it.
- Keep "leaves an unlocked card draggable".
- Add: a column rendered with `dropDisabled` carries the dimmed class, and one
  without it does not.

`frontend/src/__tests__/components/AitoCardView.test.tsx`
- Replace "gives a locked card no grip — the lock stands where the handle would
  be" with "shows both the lock and the grip on a locked card": the grip button
  and the lock `title` are both in the document.
- Keep "keeps the grip on an unlocked card" and "shows no lock on a card free to
  move between Finish and Done".

`frontend/src/__tests__/pages/AitoPageDragLock.test.tsx`
- Restore "still reorders a locked card inside its own column" as a
  user-reachable path, replacing the `30695ad45` comment claiming these handlers
  never fire in the real UI — that claim is false again.
- Leave the cross-column refusal test untouched. It is the regression guard for
  the rule this change must not weaken.

Backend tests are unaffected; `move_project`'s same-column path already has
coverage.

Verification: `cd frontend && npm run build`, then `./test_frontend.sh` from the
project root.

## Risks

**A locked card can be dragged toward a column that will refuse it.** This is
the exact objection `30695ad45` raised. Step 3 is the answer and is therefore
not optional or deferrable: the dimming tells the user which columns are open
before they commit to the gesture. If step 3 were dropped, this change would
reintroduce the ambiguity that commit removed.

**Two adjacent negative-margin controls in the header.** The lock badge and grip
both use `p-2 -m-2` for hit area. Rendering them side by side needs a spacing
check so their touch targets do not overlap or push the client name.
