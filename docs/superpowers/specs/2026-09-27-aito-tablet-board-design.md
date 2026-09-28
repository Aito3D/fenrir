# Aito tablet board — a window of columns (design "T2 base")

Date: 2026-09-27
Status: approved in chat, awaiting spec review
Branch / worktree: `aito-tablet-board` (`.claude/worktrees/aito-tablet-board`), from local main 7b1c90bc7
Builds on: `2026-09-27-aito-mobile-board-design.md` (the phone board, merged 7b1c90bc7)

## Why

On an iPad (screenshot 2026-09-27, ~1366 px landscape, sidebar expanded) the
desktop board squeezes six columns into ~165 px each: client names and column
titles are cut ("Tetuaura JE…", "Impression & …"), descriptions hold ~20
characters per line, the header spends three rows (~150 px), and portrait has
no design at all (the desktop board scrolls sideways in 288 px columns).

The user reviewed T1 (readable 6-column board), T2 (a window of columns, the
phone model widened), T3 (focus + rails), then T2 variants (A tabs, B minimap,
C density), and chose **T2 base**. Mockups: scratchpad `tablet-demo/`.

## Decisions taken in chat

| Question | Decision |
|---|---|
| Direction | T2 base: 2–4 full columns visible at a time, horizontal snap, one-line header with a range picker, 3 px segment strip, ‹ › arrows |
| Which screens | **Touch screens only**: `min-width: 768px` AND `(pointer: coarse)`. PCs and laptops (primary pointer = mouse, even with a touchscreen) keep today's 6-column board at every width. Phones (< 768 px) keep the phone board. |
| Drag on tablet | **None**, like the phone (drag only ever reordered within a column) |
| Sidebar | Untouched — it is a global user preference in `localStorage`. The board adapts to the width it actually gets instead. |

## Scope

In scope: `AitoPage`, **board view**, when `useIsTablet()` is true.

Unchanged: desktop (non-touch) at every width; the phone board; Done / Trash /
Stats views; `Layout` / the sidebar; the panel, drawers, rule engine, backend.

## Detection — `useIsTablet()` (new, `hooks/useIsTablet.ts`)

`useMediaQuery('(min-width: 768px) and (pointer: coarse)')`, with an initial
value from `window.matchMedia` so the first paint is right. Primary pointer
(`pointer`), not `any-pointer`: a touchscreen laptop's primary input is the
mouse and it must keep the desktop board; an iPad (even with a trackpad)
reports a coarse primary pointer.

`AitoPage` decides the board once: `isMobile` → phone board; else
`isTablet` → tablet board; else desktop board.

## Layout (tablet, board view)

```
┌─────────────────────────────────────────────────────────────────────┐
│ ▎▎ ● Devis → ● Scan ▾  52        ●12 ●3 ●7 ●1  [⌕ Rechercher…] ⋯ [+ Projet] │  one row
│ ▬▬▬▬▬▬▬▬▬▬▬▬▬▬ ▬▬▬▬▬▬▬▬▬▬▬▬▬▬ ▬▬▬▬ ▬ ▬ ▬                              │  3 px strip (window lit)
│ ┌─ Devis 13j 13 ─┐ ┌─ En attente 60j 16 ┐ ┌─ Scan 11j 6 ──┐ ┌─ M    │
│ │ compact cards  │ │                    │ │               │ │  peek │
│‹│  (scrolls on   │ │                    │ │               │ │      ›│
│ │   its own)     │ │                    │ │               │ │       │
└─────────────────────────────────────────────────────────────────────┘
```

The page is exactly the viewport under the shell: `h-[calc(100dvh-3.5rem)]`
below 1144 px (compact shell top bar), `h-dvh` from 1144 px. Each column
scrolls vertically inside itself (same reason as the phone board: `position:
sticky` cannot engage inside the shell's unbounded `overflow-auto` `<main>`).

Hidden on the tablet board: the desktop title row, the full-size follow-up
strip, the toolbar (Done / Trash / Stats toggles, Import, New project).

### 1. Header (one row, `TabletBoardHeader`)

- **Range picker button**: board glyph, the first visible column's dot + name,
  "→", the last visible column's dot + name, `▾`; `aria-haspopup="dialog"`,
  `aria-expanded`. Opens the column popover (§3).
- **In-production count pill** (same fact as the desktop title's count).
- **Follow-up badges**: `FollowupStrip` with a new `compact` prop — each pill
  shows only its count (colour + number, plus the × glyph while pressed); the
  label and longest wait move to `title` (the `aria-label` already carries
  label + count + worst offender). Same click-to-filter behaviour and same
  `followup` state as desktop.
- **Search**: the existing `BoardSearch`, inline, ~190 px (`w-[190px]`).
- **⋯** (`aria-label` = `aito.mobile.moreOptions`): `MobileMenu` anchored below,
  caption = in-production count + `PrintBacklogBadge`; items Terminés (N) →
  done view, Corbeille → trash, Statistiques → stats, Importer un devis →
  import drawer.
- **+ Projet**: the existing primary `Button` → new-project drawer; only with
  `canCreate`.

### 2. Segment strip

The phone header's six-segment strip, extracted to a shared `ColumnStrip`
component (`components/aito/ColumnStrip.tsx`) and used by both boards. For
the tablet it lights every column in the visible window (`from`..`to`), not
just one; tapping a segment brings that column into view (§4 "ensure
visible"). The phone keeps its single-column behaviour (window of one).

### 3. Column popover

Anchored under the range picker (reusing `MobileMenu`'s positioning pattern
and `useDismissableDialog`), `role="dialog"`, labelled `aito.mobile.columns`.
Rows = the phone sheet's rows (dot, name, oldest-card chip, count pill, load
bar), extracted from `MobileColumnSheet` into a shared `ColumnList` so both
use one implementation. Rows inside the window are highlighted. Tapping a row
brings that column into view and closes the popover; scrim / Escape close it;
focus returns to the picker.

### 4. Board (`TabletBoard`)

- A horizontal scroll container, `scroll-snap-type: x mandatory`, one snap
  point per column (`snap-start`), `overscroll-behavior-x: contain`, padding
  16 px each side, 12 px gaps.
- **Visible count `k`** = clamp(floor((boardWidth + 12) / (280 + 12)), 2, 4),
  measured from the board's own width with a `ResizeObserver` (so an open
  sidebar, a rotation or a split-screen all adapt). Column width =
  (boardWidth − 32 − 30 − (k − 1)·12) / k — the extra 30 px is the peek of the
  next column. At least 2 columns always.
- **First visible column** is derived from `scrollLeft` on scroll (rounded to a
  column), stored per session in `sessionStorage` under `aito.tablet.first`
  (the phone's `useMobileColumn` hook, generalised to take its storage key),
  and restored on mount, clamped to `6 − k`.
- **Ensure visible(i)**: if `i` is left of the window, scroll so `i` is first;
  if right of it, so `i` is last; otherwise do nothing. Smooth unless reduced
  motion. While a smooth jump runs, scroll events do not change the header
  (same jump-target guard as the phone).
- **Arrows ‹ ›**: round buttons at the vertical middle of the board's left and
  right edges, `aria-label`s "Colonne précédente" / "Colonne suivante"; move the
  window by one column; hidden (not just disabled) at the ends.
- **Columns**: the desktop column look — dot, name (never truncated at ≥ 280
  px), oldest-card chip (`OldestCardChip`), count pill — then the column's
  cards, vertically scrolling, using the phone's `MobileCard` (compact
  `CardView` + `BoardCardActions`): no grip, contact inline, same actions. An
  empty column shows the dashed box; while searching, "No projects match your
  search". The first-fetch loading pill renders over the board.
- **No drag**: no `DndContext`. Card flights are off (no board ref), as on the
  phone.

### 5. Follow-up filter on tablet

Applies as on desktop (the badges are rendered and clickable). Only the phone
ignores it.

## i18n

New keys under `aito.tablet.*` in all 15 locales: `previousColumn`,
`nextColumn`, `range` (accessible label for the picker: "{{from}} to {{to}},
change columns"). Everything else reuses existing keys (`aito.mobile.*`,
`aito.followups.*`, `aito.importQuote`, `aito.newProject`, `aito.showDone`,
`aito.trash`, `aito.statistics`, `aito.searchPlaceholder`, …).

## Accessibility

- All controls are labelled buttons; the popover and menu take focus and
  return it to their trigger; arrows are real buttons, removed at the ends.
- Columns are `section`s labelled with the column name; off-window columns are
  NOT inert (several are visible at once and a partly visible one must stay
  reachable).
- Reduced motion: instant jumps, fade-only popovers.

## Testing

Vitest:
- `useIsTablet`: true only for ≥ 768 px with a coarse pointer.
- `AitoPage`: touch 1180 px → tablet board (no desktop title row, no
  `DndContext`, header with range picker); mouse 1180 px → desktop board
  unchanged; touch 390 px → phone board.
- `TabletBoard`: `k` from a stubbed board width (560 → 2, 900 → 3, 1250 → 4,
  2000 → 4); ensure-visible scrolls left/right/not at all; arrows move one
  column and hide at the ends; scroll updates the range picker; sessionStorage
  restore + clamp; empty page vs "no results" while searching; ⋯ items route
  to done/trash/stats/import.
- `ColumnStrip`: lights the whole window; the phone board still passes all its
  tests unchanged.
- `ColumnList` extraction: the phone sheet tests pass unchanged.
- `FollowupStrip compact`: count only, label in `title`, click still filters.
- i18n parity.

Manual: the real `AitoPage` in the msw harness (`frontend/demo-mobile/`, a
tablet frame at 1180 × 820 and 820 × 1180 with touch emulation), then
`npm run build`, `./test_frontend.sh`.

## Risks / notes

- `(pointer: coarse)` on an iPad with a Magic Keyboard trackpad: iPadOS keeps
  reporting a coarse primary pointer; if not, the iPad simply gets the desktop
  board (graceful).
- A Layout banner inside `<main>` adds its height on top of the fixed-height
  board (pre-existing, same as the phone board).
- The main checkout carries another session's uncommitted `AitoPage.tsx`
  edits; landing may again need a three-way merge-file (clean last time).
