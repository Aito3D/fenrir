# Aito: cards fly between columns instead of teleporting

**Date:** 2026-08-01
**Status:** approved, ready for an implementation plan

## Goal

When a quote transition relocates a card — mark sent, accept, decline, mark
done — the card travels from the column it left to the column it lands in. It
does not vanish from one and materialise in another.

## Why it teleports today

Every board relocation is a React remount. The optimistic write
(`useOptimisticBoardMutation.onMutate` → `applyQuoteStatus`) changes
`project.column`, `buildBoard` re-buckets it, and the card unmounts from one
column's list and mounts under a different parent. Nothing carries between the
two DOM nodes.

The board already animates everything AROUND that move, which is what makes the
teleport conspicuous rather than merely unanimated:

- `useColumnReflow` slides the source column's survivors up to close the gap,
  and slides the destination column's cards down to open the slot.
- `useBoardDrag.shouldAnimateIn` deliberately WITHHOLDS the `.animate-rise`
  entrance from a card that is merely relocating, because an entrance is the
  wrong story for a card that was already on the board.

So the neighbours move, the slot opens, and the card itself is the one thing on
screen that jumps. This spec fills exactly that hole and changes nothing about
the two behaviours above.

## Scope

In scope: a board-level flight for any card that changes column, the archive
flight for a card that leaves the board for Done, the board's horizontal pan
when the destination is off-screen, and the suppression rules.

Out of scope, deliberately:

- **Drag moves.** dnd-kit owns those, overlay and drop animation included. The
  flight suspends for the duration of a drag and its settle window, the same
  way `useColumnReflow` does, because two systems animating one node fight
  visibly.
- **A flight for delete.** A card moved to the trash also leaves the board, and
  flying it into the "Show Done" button would state something false. The
  departure resolver (below) makes a Trash-bound flight a small addition later
  if it is ever wanted; it is not part of this work.
- **Reordering within a column.** `useColumnReflow` already slides those, and
  the flight explicitly ignores same-column moves so the two can never animate
  one node at once.
- **Any change to the mutations.** No call site learns about this. See the
  contract below.

## Part 1 — The mechanism

### `useCardFlight(boardRef, options)`

A new hook in `frontend/src/hooks/`, sibling to `useColumnReflow` and written
in the same idiom: a `useLayoutEffect` with no dependency array that measures
every render and animates only when something moved, WAAPI rather than CSS
transitions, and `offset*`/`getBoundingClientRect` read before any animation is
cancelled.

Mounted once in `AitoPage`, on the flex row that holds the columns.

**Per-render bookkeeping.** For each `[data-flip-key]` card inside the board it
records: the element, its viewport rect, and its parent column element.

**Parent identity is the cross-column signal.** All six columns are permanently
mounted — `visibleColumns` maps over `COLUMNS` and filters each column's
CONTENTS, never the columns themselves — so a card whose parent node differs
from last render has genuinely changed column, and nothing else can produce
that signal. No prop threading, no column id plumbed through the DOM.

**Arrival** (id still on the board, parent changed): the previous element is
detached by now but still referenced, so `cloneNode(true)` yields a pixel-exact
copy with no event handlers. The clone flies; the real card sits at
`opacity: 0` in its new slot until it lands.

**Departure** (id gone from the board): resolved by a caller-supplied
`departureTarget(id)` rather than assumed. `AitoPage` answers `'archive'` only
when the id is now in `board.done`. This is what keeps the archive flight off a
card that was deleted (gone, not done), off a card the search query just hid
(still in its column, merely unrendered), and off a card the server dropped.

**The ghost layer** is one `position: fixed` container the hook creates lazily
on `document.body`: `pointer-events: none`, `z-40` — above every column and
card, below the `z-50` detail panel, so a flight can never paint over the
modal.

**The clone must not answer to `[data-aito-card-id]`.** `useCardMorph` finds
the card to morph the detail panel into by exactly that selector, and a ghost
in the DOM would be a second match. The clone is stripped of
`data-aito-card-id` and `data-flip-key` on creation.

### Suspension

Measure always, animate only when live — the rule `useColumnReflow` already
follows, and the reason it takes a nullable key. Positions keep being recorded
while suspended, so resuming never replays a stale delta.

Suspended when:

- **A drag is live or settling** (`dragging || dragSettling`, the same flags
  `BoardColumn` already receives as `dragActive`).
- **The detail panel is open.** The panel is a fullscreen modal over the board,
  so a flight underneath it animates where nobody can see it. This is not a
  loss: `useCardMorph.close` looks the card up by id at close time and morphs
  the panel back into it wherever it now lives, so a transition taken from the
  panel footer still reads as a move — the panel shrinks into the card's NEW
  column.
- **`prefersReducedMotion()`**, or `typeof element.animate !== 'function'`.

### Failure modes

- **A mutation that fails** rolls the cache back, the card returns to its old
  column, and the hook flies it back. That is the honest picture, and it
  composes with the existing `flashRevert` ring.
- **A relocation pushed by the server** — the Zoho reconciler, another browser
  — animates identically. The hook keys on the DOM, not on who wrote the cache.
- **A flight interrupted** by a second relocation of the same card cancels the
  first ghost and starts the new one from the live position, the retarget trick
  both existing FLIP hooks use (read `getComputedStyle().transform` BEFORE
  `cancel()`, which would otherwise change what is reported).
- **A card unmounted mid-flight** removes its ghost and releases the
  `opacity: 0` unconditionally. No path may strand a real card invisible: the
  reveal runs from `finish`, `cancel` and hook teardown alike.
- **A missing archive target** (the toolbar not rendered) degrades to no
  flight, not to a throw.

## Part 2 — The motion

**Path: a straight line.** The board is a rail of columns; a card moving
between them is travelling along it. An arc would be decoration pretending to
be physics.

**Lift, not tilt.** The ghost scales to `1.02` over the first ~15% of the
flight and settles back to `1.0` on landing, carrying `shadow-2xl` throughout:
it picks up off the board, travels, sets down. Deliberately NO rotation, even
though `CardView`'s drag overlay uses `rotate-1` — rotation reads as a hand
holding the card, and nothing is holding this one.

**Duration scales with distance:** `clamp(280, 280 + distance × 0.22, 560)` ms,
where distance is between rect centres. A one-column hop (~330px) lands at
~350ms; a full-board flight at ~520ms. A constant is wrong at both ends —
leisurely for a hop, a blur across 1100px.

**Easing is in-out.** New token in `index.css` beside the existing three:

```css
--ease-flight: cubic-bezier(0.55, 0, 0.2, 1);
```

`--ease-signature` (easeOutQuint) opens at maximum velocity, which is right for
entrances — something arriving from off-screen is already moving — and wrong
here. A flight starts at rest in one slot and ends at rest in another, so it
needs a departure as well as a settle. `--ease-morph` is the closest existing
curve but is also front-loaded, for the same entrance-like reason. The token
carries this reasoning in a comment so it is not "corrected" back to the
signature curve later.

**The landing slot is already open.** The real card holds its space at
`opacity: 0` while the ghost is in the air, so the destination column's reflow
has finished opening the gap before the card arrives, rather than shoving
neighbours aside on arrival. The swap on landing needs no cross-fade: the ghost
is a pixel copy at the same rect.

**The pan rides the same timeline.** When the destination column is outside the
board's horizontal scroller, we do not pan and then fly — two beats, and the
landing point drifts mid-air. The hook computes the final `scrollLeft`,
expresses the landing rect in post-scroll coordinates
(`rect + (currentScrollLeft − finalScrollLeft)`, arithmetic only — nothing has
scrolled yet), and drives `scrollLeft` from a rAF loop on the same duration and
the same curve. Board and card settle on the same frame.

**Departure to the archive** is the identical tween aimed at the "Show Done"
button's rect, with the ghost shrinking to `0.28` toward the button's centre,
holding full opacity to 55% and fading out by the end — it stays legibly a card
for most of the trip, so you read WHAT went in, not merely that something did.
The button answers with a single `1 → 1.06 → 1` pulse over 180ms as the
receipt; its count has already ticked by then.

## Part 3 — Integration

Three small edits outside the new hook:

1. **`AitoPage`** gets a ref on the columns row, mounts the hook, and passes
   `suspended: dragging || dragSettling || expandedId !== null` plus the
   `departureTarget` resolver reading `board.done`.
2. **`ViewToggleButton`** forwards an optional `data-flight-target` onto its
   `Button` (which already spreads rest props onto the `<button>`), and
   `AitoPage` sets it on the Show Done toggle. The attribute is the hook's only
   knowledge of the toolbar.
3. **`index.css`** gains `--ease-flight` and the ghost layer's base styles.

`useColumnReflow`, `useBoardDrag`, `CardView`, `BoardColumn` and every mutation
are untouched.

## Testing

jsdom has no layout engine, so the hook's tests build a board DOM by hand and
stub `getBoundingClientRect` and `Element.prototype.animate` — the approach
`useCardMorph.test.tsx` already takes with `startViewTransition`. They assert
decisions, not pixels:

- A card whose parent column changed produces exactly one ghost, starting at
  the old rect's offset and ending at zero.
- A same-column reorder produces none (that is `useColumnReflow`'s job).
- Distance drives duration, and the clamp holds at both ends.
- A departure with `departureTarget → 'archive'` aims at the element carrying
  `data-flight-target`; a departure resolving to `null` (deleted, filtered)
  produces no ghost.
- Drag-active, panel-open and `prefers-reduced-motion` each produce no ghost,
  and positions are still recorded while suspended — a relocation that happened
  during suspension does not fly when it lifts.
- An interrupted flight removes its ghost AND restores the real card's opacity.
- The clone carries neither `data-aito-card-id` nor `data-flip-key`.

Plus one `AitoPage` assertion that the Show Done toggle renders
`data-flight-target`, so the hook's only external contract cannot be renamed
out from under it.

## Files

| File | Change |
|---|---|
| `frontend/src/hooks/useCardFlight.ts` | new |
| `frontend/src/__tests__/hooks/useCardFlight.test.tsx` | new |
| `frontend/src/pages/AitoPage.tsx` | ref, hook, resolver, `data-flight-target` |
| `frontend/src/components/aito/ViewToggleButton.tsx` | forward the data attribute |
| `frontend/src/index.css` | `--ease-flight`, ghost layer styles |
