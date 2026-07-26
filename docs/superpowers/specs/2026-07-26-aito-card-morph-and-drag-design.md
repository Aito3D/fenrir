# Aito board: drag landing, card face, and expandable detail panel

**Date:** 2026-07-26
**Status:** Approved design, ready for implementation planning
**Touches:** `frontend/src/pages/AitoPage.tsx`, new `frontend/src/components/aito/*`, `backend/app/api/routes/aito.py`, all 12 locale files

## Problem

Three things are wrong or missing on the Aito production board:

1. **Dropping a card animates it back to where it started.** The card lands in the
   old slot, then jumps to the new one a frame or two later.
2. **The card leads with `#12`,** an internal row id, while the client name — the
   thing the board is actually organised around — is secondary.
3. **A card shows only a truncated description.** There is no way to read the full
   text, see when a project was created or last touched, or correct a typo without
   deleting the card and making a new one.

## Root cause of the drop animation

Not a CSS problem — a state race. In `handleDragEnd`:

1. `setActiveId(null)` and `setBoard(nextBoard)` are called in the same tick.
2. The board-sync effect (`AitoPage.tsx:503`) is gated on `activeId !== null`, so
   the moment `activeId` clears it re-runs and **rebuilds the board from
   `aitoQuery.data`** — still the pre-move server ordering.
3. The optimistic `queryClient.setQueryData` meant to prevent that
   (`AitoPage.tsx:570`) sits behind `await queryClient.cancelQueries(...)` inside
   `onMutate`, so it lands *after* the effect in some renders.

The list therefore reverts for a frame, and dnd-kit's `DragOverlay` drop animation
targets the dragged node's *current* rect — which is back at the origin. The card
visibly flies home, then the optimistic write lands and it jumps forward.

Two aggravating factors:

- `SortableCard` carries `animate-rise` unconditionally (`AitoPage.tsx:259`). A
  cross-column move remounts the node under a new parent, replaying the entrance
  animation mid-interaction.
- `DragOverlay` has no explicit `dropAnimation`, so it uses dnd-kit's default
  250ms ease, which neither matches `var(--ease-signature)` nor unwinds the
  overlay's `rotate-2 scale-[1.03]` lift — the card lands still tilted.

## Decisions taken

| Question | Decision |
| --- | --- |
| Detail reveal | Card morphs into a centered panel via the View Transitions API |
| Editing | Click-to-edit per field (Notion-style), with per-field save state |
| "Last update" semantics | Show `updated_at` as-is, labelled **Last activity** |
| Client-less legacy cards | Muted `No client` placeholder as the title |
| Delivery | Both phases in one pass |

`updated_at` is bumped by `move_project` for every card whose `position` shifts, so
it measures "last touched", not "last edited". Labelling it *Last activity* keeps
the display honest without a new column.

---

## Part 1 — Drag landing

### 1.1 Board ownership during an in-flight move

Replace the `activeId !== null` guard with an explicit in-flight count, so the local
board stays authoritative for the whole move rather than only for the drag:

```ts
const pendingMoves = useRef(0);
const [syncGeneration, setSyncGeneration] = useState(0);

// sync effect deps: [aitoQuery.data, activeId, syncGeneration]
// skip when:       activeId !== null || pendingMoves.current > 0

// handleDragEnd:   pendingMoves.current += 1  (before mutate)
// onSettled:       pendingMoves.current -= 1; setSyncGeneration((g) => g + 1)
```

The ref keeps the guard synchronous — no render is needed to close it. The
generation counter forces exactly one re-sync once the server agrees.

### 1.2 Synchronous optimistic write

Move the `queryClient.setQueryData(['aito-projects'], optimistic)` call out of the
async `onMutate` and into `handleDragEnd`, immediately before `mutate()`.
`cancelQueries` stays in `onMutate` — it still cancels in-flight refetches — it just
no longer gates the write.

Because the write now happens outside `onMutate`, the rollback snapshot must be
captured there too: `handleDragEnd` reads
`queryClient.getQueryData<AitoProject[]>(['aito-projects'])` *before* writing the
optimistic value and passes it in the mutation variables as `previous`. `onMutate`
returns `{ previous: variables.previous }` as its context, so `onError`'s existing
`context?.previous` rollback is unchanged.

Together with 1.1, this makes the reverted frame impossible, so the drop animation
always has a stable target rect.

### 1.3 Explicit drop animation

```ts
const dropAnimation: DropAnimation = {
  duration: 250,
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)', // var(--ease-signature)
  sideEffects: ({ dragOverlay, active }) => {
    dragOverlay.node.classList.add('aito-card-dropping');
    active.node.style.opacity = '0';
    return () => {
      active.node.style.opacity = '';
    };
  },
};
```

with one rule in `index.css` so the lift unwinds *during* the flight instead of
snapping at the end:

```css
.aito-card-dropping [data-aito-card] {
  rotate: 0deg;
  scale: 1;
  transition:
    rotate 250ms var(--ease-signature),
    scale 250ms var(--ease-signature),
    box-shadow 250ms var(--ease-signature);
}
@media (prefers-reduced-motion: reduce) {
  .aito-card-dropping [data-aito-card] {
    transition: none;
  }
}
```

Note the individual `rotate` / `scale` properties rather than `transform`. Tailwind 4
compiles `rotate-1` to `rotate: 1deg` and `scale-[1.02]` to `scale: 1.02` — a
`transform: none` override would be a no-op here.

The overlay lift drops from `rotate-2 scale-[1.03]` to `rotate-1 scale-[1.02]`. At
the larger values the card reads as thrown rather than lifted, and the smaller the
lift, the less there is to unwind on landing.

### 1.4 Entrance animation only for genuinely new cards

Keep a `seenIdsRef = useRef(new Set<number>())`. `SortableCard` gets `animate-rise`
only when its id is not yet in the set; the id is added on mount. Created and
restored-from-trash cards still animate in; a card moving between columns does not
replay its entrance.

### 1.5 Two supporting changes

- `DndContext` gets `measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}`.
  The board mutates its own DOM during `dragOver`, so cached droppable rects go
  stale and cross-column drops can land at the wrong index.
- `useSortable` gets `transition: { duration: 250, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }`
  so neighbours settling and the card landing share one curve.

### 1.6 Reduced motion

Under `prefers-reduced-motion: reduce`, `dropAnimation` is `null` (instant landing)
and the sortable `transition` is `null`. This matches the existing policy in
`index.css`, where every motion utility is neutralised under the same query.

---

## Part 2 — Card face

```
┌────────────────────────────┐
│ ACME SARL                ⌄ │  client name — text-sm font-medium text-white
│ +33 6 12 34 56 78          │  tel: link, unchanged
│ Support GoPro for helmet   │  description, line-clamp-3 (was 5)
│ mount, 2 parts…            │
│ 2 days ago              🗑 │  elapsed + hold-to-delete, unchanged
└────────────────────────────┘
```

- `#{project.id}` (`AitoPage.tsx:222`) is removed.
- The client name becomes the card title. Cards with `client_name === null` (the
  localStorage-migrated legacy cards) show a muted `aito.noClient` placeholder.
- The description clamp tightens from 5 lines to 3. With a detail panel one click
  away, a card that shows nearly everything makes the panel pointless.
- A chevron button (`⌄`) sits top-right. It is the keyboard and screen-reader path
  to expanding — see §3.3.
- The card root carries `data-aito-card` so the drop-animation CSS can target it.

The id stays in the trash modal (`AitoPage.tsx:459`), where it is the only stable
identifier for a card whose client may be null.

---

## Part 3 — Detail panel

### 3.1 Shape

Clicking a card opens a centered panel over the board; the card's rectangle morphs
into the panel's. Escape and backdrop mousedown close it, morphing back — matching
the dismissal behaviour of `NewProjectModal` and `TrashModal`.

```
╔══════════════════════════════════╗
║ ACME SARL                      ✕ ║  ← click to change client (§3.4)
║ +33 6 12 34 56 78                ║
║                                  ║
║ Support GoPro — full text, no    ║  ← click to edit description (§3.4)
║ clamp, as many lines as needed.  ║
║ ──────────────────────────────── ║
║ Created         3 Jul, 14:02     ║
║ Last activity   24 Jul, 09:41    ║
║ Stage           Quote            ║
╚══════════════════════════════════╝
```

Dates render with `toLocaleString(i18n.language)`, as `CardView` already does for
its `title` tooltip. Stage shows the translated column label with its colour dot.

### 3.2 The morph

Only one element may hold a given `view-transition-name` at a time, so the handoff
is imperative and lives in a `useCardMorph` hook:

**Opening**

1. `cardNode.scrollIntoView({ block: 'nearest' })` — a card scrolled out of its
   column's `overflow-y-auto` viewport would otherwise snapshot clipped.
2. Set `cardNode.style.viewTransitionName = 'aito-card'`.
3. Set `document.documentElement.dataset.vt = 'aito-card'`.
4. `document.startViewTransition(() => { flushSync(() => setExpandedId(id)); })`.
   The panel renders with `view-transition-name: aito-card`; inside the same
   callback, clear the name from `cardNode`.
5. On `transition.finished`, delete `documentElement.dataset.vt`.

**Closing** runs the same sequence in reverse. The panel already holds the name, so
it is the old snapshot; inside the update callback, `flushSync(() => setExpandedId(null))`
unmounts the panel and then — still inside the callback, before it returns and the
browser captures the new snapshot — the name is set back on the card node. It is
cleared on `transition.finished`.

Keeping the name assignment imperative keeps React out of the critical frame — no
extra render is needed before the browser captures the old snapshot.

**Finding the card node.** Rather than threading refs up through `BoardColumn` and
`SortableCard`, each card root carries `data-aito-card-id={project.id}` alongside its
`data-aito-card` marker, and `useCardMorph` resolves the node with
`document.querySelector('[data-aito-card-id="…"]')` at the moment it needs it. A
missing node (card scrolled out and virtualised away, or deleted underneath) falls
back to the no-morph path rather than throwing.

**State ownership.** `expandedId` lives in `AitoPage`, next to `activeId` — it is
board-level state, and the panel is rendered as a sibling of `DndContext` so it is
never inside a droppable. `AitoPage` threads an `onExpand(id)` callback down through
`BoardColumn` → `SortableCard` → `CardView`, the same way `onDeleteCard` is threaded
today.

**Scoping.** `index.css` already animates `::view-transition-old/new(root)` at 350ms
and `(page-title)` likewise. Left alone, expanding a card would crossfade the entire
page. The `data-vt` attribute scopes it:

```css
html[data-vt='aito-card']::view-transition-old(root),
html[data-vt='aito-card']::view-transition-new(root),
html[data-vt='aito-card']::view-transition-old(page-title),
html[data-vt='aito-card']::view-transition-new(page-title) {
  animation: none;
}
::view-transition-old(aito-card),
::view-transition-new(aito-card) {
  animation-duration: 350ms;
  animation-timing-function: var(--ease-signature);
}
```

350ms and `--ease-signature` match the existing page-title morph — a card expanding
into a panel is the same class of scene change.

The backdrop is new in the post-transition state and cannot morph from anything, so
it gets its own `view-transition-name: aito-backdrop` with a fade-in keyframe on
`::view-transition-new(aito-backdrop)`.

**Fallback.** When `document.startViewTransition` is undefined or
`prefers-reduced-motion: reduce` is set, the panel opens with the existing
`animate-overlay-in` / `animate-modal-in` classes and no morph. The feature detect
follows the pattern already established in `AnimatedOutlet.tsx:19` — evaluated at
mount, not import, so tests can stub it.

### 3.3 Opening without breaking drag

`PointerSensor` has `activationConstraint: { distance: 8 }`, so a click that does not
move never starts a drag and the card's `onClick` fires cleanly. Pointer interaction
needs no special handling.

Keyboard does. `KeyboardSensor` claims Enter/Space on the focused card for drag
activation, so the card itself cannot also open on Enter. The chevron is a real
`<button>` with `onPointerDown` / `onKeyDown` stopping propagation — it is the
keyboard and assistive-technology path to expanding, and doubles as the visual
affordance that a card has more behind it. The phone `<a>` and the delete button
already use this same `stopPropagation` pattern.

The panel traps nothing beyond what the existing modals do: Escape closes, backdrop
mousedown closes, focus moves to the panel's close button on open and returns to the
chevron on close.

### 3.4 Click-to-edit

Two editable regions. Each owns its own save state — `idle | saving | saved | error`
— shown as a small inline indicator that settles to a check and fades after ~1.5s.

**Description.** Renders as a `<p>` with a hover tint and a text cursor. Clicking
swaps in a `<textarea>` seeded with the current value, focused, cursor at the end.

- `Cmd/Ctrl+Enter` or blur → save
- `Escape` → revert and exit edit mode
- Empty or whitespace-only on save → revert silently. The backend enforces
  `min_length=1`; rejecting it client-side avoids a pointless round-trip and a
  confusing error toast for what is almost always an accidental select-all-delete.
- Unchanged value on save → exit edit mode without a request

**Client.** The name + phone header swaps into the existing `ClientCombobox`
(`components/aito/ClientCombobox.tsx`). Selecting a client saves immediately and
writes all three snapshot fields (`client_id`, `client_name`, `client_phone`).
Escape or blur without a selection reverts.

**Persistence.** Each save PATCHes only the changed fields, then writes the returned
project into the `['aito-projects']` query cache. On error, the field reverts to the
server value and a `aito.saveFailed` toast fires, matching how `moveFailed` is
handled today.

**Freshness.** The panel reads its project from the query cache by id, so background
refetches keep it current. A field that is in edit mode keeps its draft — an
incoming refetch never clobbers text the user is typing.

---

## Part 4 — Backend

New endpoint in `backend/app/api/routes/aito.py`:

```
PATCH /api/v1/aito/{project_id}
```

Guarded by the existing `Permission.AITO_UPDATE`. No new permission is introduced,
so no API-key permission classification work is needed.

```python
class AitoProjectUpdate(BaseModel):
    description: str | None = Field(default=None, min_length=1)
    client_id: str | None = None
    client_name: str | None = None
    client_phone: str | None = None
```

Semantics:

- Only fields present in the request body are written — `model_dump(exclude_unset=True)`,
  so `null` can explicitly clear `client_phone` while an omitted field is untouched.
- A `model_validator` requires `client_name` whenever `client_id` is set: the client
  fields are a snapshot and must stay internally consistent.
- 404 when the project is missing or `status != "active"` — deleted projects are not
  editable, matching `move_project` and `delete_project`.
- `column` and `position` are **not** accepted here; ordering stays owned by
  `/move`, which maintains the position invariants across a whole column.
- `updated_at` is bumped by the model's `onupdate=func.now()`, no explicit write.

No schema migration. No model change.

---

## Part 5 — File organisation

`AitoPage.tsx` is 796 lines before any of this work and holds five components plus
all board orchestration. Phase 2 would push it past 1,100. Split as part of this
change:

| File | Contents |
| --- | --- |
| `components/aito/DeleteHoldButton.tsx` | hold-to-delete button (moved) |
| `components/aito/CardView.tsx` | presentational card (moved, reworked per Part 2) |
| `components/aito/BoardColumn.tsx` | column + `SortableCard` (moved) |
| `components/aito/NewProjectModal.tsx` | moved unchanged |
| `components/aito/TrashModal.tsx` | moved unchanged |
| `components/aito/ProjectDetailPanel.tsx` | **new** — panel, click-to-edit fields |
| `hooks/useCardMorph.ts` | **new** — view-transition open/close choreography |
| `utils/aitoBoard.ts` | **new** — pure board helpers (see below) |
| `pages/AitoPage.tsx` | queries, mutations, `DndContext` orchestration |

`utils/aitoBoard.ts` extracts the pure logic currently inlined in the page, which is
both the hardest part to get right and the only part that is cheap to test:

- `buildBoard(projects: AitoProject[]): Board` — group by column, sort by position
- `applyCrossColumnMove(board, activeId, overId): Board` — the `dragOver` relocation
- `computeMoveTarget(board, activeId, overId, originColumn): { column, position } | null`
  — returns `null` for a no-op drop, replacing the inline early-return at
  `AitoPage.tsx:686`
- `toOptimisticProjects(board): AitoProject[]` — flatten with rewritten positions

---

## Part 6 — i18n

New keys, added to `en.ts` and genuinely translated into all 12 locales. The parity
script (`frontend/scripts/check-i18n-parity.mjs`) fails on any non-English leaf that
is byte-identical to English unless allow-listed, so English cannot be pasted in as a
placeholder.

| Key | English |
| --- | --- |
| `aito.noClient` | No client |
| `aito.showDetails` | Show details |
| `aito.createdLabel` | Created |
| `aito.lastActivity` | Last activity |
| `aito.stage` | Stage |
| `aito.editDescription` | Edit description |
| `aito.changeClient` | Change client |
| `aito.saved` | Saved |
| `aito.saveFailed` | Could not save your changes. Please try again. |

`common.close` is reused for the panel's close button. The existing
`aito.created` / `aito.updated` interpolated strings stay — they still back
`CardView`'s tooltip.

---

## Part 7 — Testing

**Backend** — extend `backend/tests/unit/test_aito_routes.py`:

- PATCH updates description only, leaving client fields untouched
- PATCH updates all client snapshot fields together
- PATCH with `client_id` but no `client_name` → 422
- PATCH with empty description → 422
- PATCH on a soft-deleted project → 404
- PATCH on a missing id → 404
- PATCH does not change `column` or `position`

**Frontend unit** — new `frontend/src/__tests__/utils/aitoBoard.test.ts`:

- `buildBoard` groups and sorts, and drops unknown column values
- `applyCrossColumnMove` inserts at the hovered index, and appends when hovering the
  column itself
- `computeMoveTarget` returns `null` for a same-slot release, and a target for a
  cross-column move whose destination index happens to match the source index
- `toOptimisticProjects` renumbers positions contiguously from 0

This is where the drop-animation fix is actually verified. Simulating a dnd-kit drag
in jsdom is unreliable; extracting the ordering logic makes the part that broke
testable, and the animation itself is verified by hand on the real board.

**Frontend component** — extend `frontend/src/__tests__/pages/AitoPage.test.tsx`:

- card renders the client name as its title and no longer renders `#12`
  (updates the existing assertions at `:34` and `:44`)
- a client-less card renders the `No client` placeholder
- clicking a card opens the panel showing the full description, Created, Last
  activity and Stage
- the chevron opens the panel via keyboard
- `document.startViewTransition` is called when present, and the panel still opens
  when it is absent (stubbed as in `AnimatedOutlet.test.tsx:29`)
- clicking the description opens a textarea; editing and blurring PATCHes with the
  new description
- Escape during an edit reverts without a request; Escape outside an edit closes
  the panel
- a failing PATCH reverts the field and shows a toast

The trash-modal assertions at `:153` and `:159` still expect `#12` and are unchanged.

**Full suite** — `cd frontend && npm run build`, then `./test_frontend.sh`,
`./test_backend.sh`, `./test_security.sh`.

---

## Out of scope

- Editing `column` or `position` from the panel — dragging owns ordering
- Attachments, notes, or per-project history
- A dedicated `content_updated_at` column; "Last activity" is the agreed label for
  the existing `updated_at`
- Any change to the trash modal beyond leaving it as-is
