# Aito mobile board — one column at a time (design "D3")

Date: 2026-09-27
Status: approved in chat, awaiting spec review
Branch / worktree: `aito-mobile-board` (`.claude/worktrees/aito-mobile-board`)

## Why

On a phone (see the 2026-09-27 screenshot, ~390 px wide) the Aito board spends
~45 % of the screen on chrome before the first card: title row, a backlog badge
wrapped on two lines, three rows of follow-up pills, the search box and two rows
of buttons. The board below it is the desktop layout — 288 px columns that
scroll sideways, the next column cut mid-word, and nothing that says which of
the six columns you are on.

On a phone the work is "one column at a time" ("which quotes need chasing?").
The design gives the cards the screen and makes the column the unit of
navigation.

The user reviewed four static mockups (A tabs, B carousel, C stacked list, D =
C with one column at a time), then three D variants, and chose **D3 — merged
header**. Mockup: scratchpad `mobile-demo/index.html` (not in the repo).

## Decisions taken in chat

| Question | Decision |
|---|---|
| Direction | D3: one full-width column at a time, horizontal swipe, merged sticky header |
| Breakpoint | Below 768 px — the existing `useIsMobile()` (`max-width: 767px`) |
| Follow-up pills | Removed on mobile |
| Search | Hidden behind a magnifier button; opens on tap |
| Moving a card between columns | Only from the detail panel (see "Moves" below — this is already true today) |
| Cards | Compact variant on mobile (one footer line) |
| Done / Trash / Stats views on mobile | Unchanged — out of scope |

## Scope

In scope: `AitoPage` in the **board** view, below 768 px.

Out of scope, and must not change:

- Everything at ≥ 768 px (tablet and desktop render exactly as today).
- The Done, Trash and Stats views at any width. Reached from the mobile ⋯ menu,
  they render their current layout, whose own toggle button returns to the
  board.
- `ProjectDetailPanel`, the drawers (`NewProjectDrawer`, `ImportQuoteDrawer`),
  the rule engine, the backend. No API change.

## Moves (no new UI)

A card's column is derived by the board rule engine from the quote status and
the services with unticked steps (`StageRail` doc, `utils/aitoBoardRules.ts`).
Drag never changes a column: `allowedColumns(project)` in `utils/aitoBoard.ts`
returns `[project.column]`, so drag only **reorders within a column**. Column
changes already happen only through panel actions (quote status, step ticks,
Finish ↔ Done).

So on mobile the board simply has **no drag**: no `DndContext`, no grip, no
within-column reordering. Tapping a card opens the panel exactly as it does
today. The stage selector drawn in the mockup is not built.

## Layout (mobile, board view)

```
┌──────────────────────────────┐
│ ☰  AITO3D                    │  shell top bar (Layout, unchanged, 56 px)
├──────────────────────────────┤
│ ● Devis 6 ▾  9 j      ⌕  ⋯  │  MobileBoardHeader, sticky, 44 px
│ [ ⌕ Rechercher un projet… ✕] │  ← only while search is open
│ ▬▬▬▬▬▬ ▬▬ ▬ ▬▬ ▬▬▬ ▬         │  3 px segment strip = header bottom edge
├──────────────────────────────┤
│ ┌──────────────────────────┐ │
│ │ ◯ Tetuaura JENNINGS      │ │  compact card
│ │ Impression 3D d'un …     │ │
│ │ ▬▬ 0/1          4 jours ➤│ │
│ └──────────────────────────┘ │  one column's cards, vertical scroll
│              …               │
│                         [+]  │  floating create button
└──────────────────────────────┘
```

Hidden on mobile in the board view: the `h1` row (title, in-production count,
`PrintBacklogBadge`), `FollowupStrip`, the inline `BoardSearch`, and the whole
toolbar (Done / Trash / Stats toggles, Import, New project). Everything they
offered is reachable from the new header, the column sheet, the ⋯ menu or the
floating button.

### 1. `MobileBoardHeader` (new, `components/aito/`)

A plain bar (`flex-none`) at the top of the mobile board. The mobile board is
exactly `100dvh − 3.5rem` tall (the viewport under the shell's fixed 56 px top
bar) and each column page scrolls inside itself, so the header never scrolls
away and nothing relies on `position: sticky` — which cannot engage here: the
shell's `<main>` is `overflow-auto` with no height bound, so the DOCUMENT
scrolls and a sticky child measures against `<main>`'s off-screen edge.

- **Column picker button** (left): colour dot of the current column, column
  name, card count pill, `▾`. Opens the column sheet. `aria-haspopup="dialog"`,
  `aria-expanded`.
- **Oldest-card chip**, right of the picker: the age of the oldest card in the
  current column (the maximum age, measured with the card's own `ageAnchor`),
  in days, reusing `aito.followups.longest` ("9 j", "59 j" — the same form the
  follow-up pills used), coloured with `agingColorCls` so it uses the
  same heat ramp as the cards. `title` / sr-only text explains it ("Carte la
  plus ancienne"). Hidden when the column is empty.
- **Search button**: magnifier icon button, `aria-expanded`. Tapping opens the
  search row and focuses the input; tapping again closes it. When the row is
  closed while the query is non-empty, a small accent dot sits on the icon
  (the board is still filtered).
- **⋯ button**: opens the more-menu (below).
- **Search row** (collapsible, under the button row): the existing `search`
  state, the same one `BoardSearch` drives on desktop, so switching widths
  keeps the query. ✕ clears the query and closes the row; Escape closes the row
  and keeps the query. The row expands with a `grid-template-rows 0fr → 1fr`
  transition; with reduced motion it is an opacity fade only.
- **Segment strip** (the header's bottom edge, 3 px): six segments in column
  colours, each `flex-grow` = that column's visible card count (min 0.4 so an
  empty column keeps a sliver). The current column is at full opacity, the
  others at 25 %. Each segment is a button with a ≥ 24 px tall invisible hit
  area and an accessible label ("Devis, 6 projets"); tapping jumps to that
  column.

### 2. Column sheet (new)

A bottom sheet over a dimmed scrim.

- Header: "Aito", in-production count pill, and the `PrintBacklogBadge`
  content (the figures the removed title row showed).
- One row per board column (the six active columns; Done is not a column on the
  board): dot, name, oldest-card chip, count pill, small load bar (count
  relative to the largest column). The current column's row is highlighted.
- Tapping a row jumps to that column (instant, no smooth scroll: the sheet
  closing is the transition) and closes the sheet.
- Closes on scrim tap, Escape, and a downward swipe on the sheet. Built on
  `useDismissableDialog` like the drawers: focus moves into the sheet on open,
  Escape closes, the exit animation plays before unmount; the page returns
  focus to the picker button on close. `role="dialog"`, `aria-modal`,
  labelled.

### 3. More-menu (new)

A popover anchored under the ⋯ button, over a transparent-dark scrim.

- Caption: in-production count and the `PrintBacklogBadge` itself (same
  props as the desktop title row).
- Items: **Terminés (N)** → `changeView('done')`, **Corbeille** →
  `changeView('trash')`, **Statistiques** → `changeView('stats')`. The same
  visibility rules as today's toggles.
- Closes on item, scrim tap, Escape. `role="menu"` with menu items.

### 4. Board pager (mobile branch of the board render)

- A horizontal scroll container with `scroll-snap-type: x mandatory`; one page
  per visible column, each page `100 %` wide with `scroll-snap-stop: always`, so
  a swipe moves exactly one column.
- Each page lists that column's cards (the same `projects` the desktop
  `BoardColumn` receives, with search applied) using `CardView`, with the
  existing tap → `openCard` behaviour and card morph, and the same footer
  actions (mark sent, accept, contacted, invoice, done) — extracted from
  `BoardColumn`'s `SortableCard` into a shared `BoardCardActions` so both
  surfaces render one implementation. Each page scrolls vertically inside
  itself, so every column keeps its own scroll position.
- Card flights (`useCardFlight`) are desktop-only: its board ref is simply not
  attached on mobile, which the hook already treats as "board not on screen".
- An empty column shows the same dashed empty box `BoardColumn` shows today.
- The current column index is derived from `scrollLeft` on scroll and drives
  the header. Jumps (strip, sheet) set `scrollLeft` (strip: smooth unless
  reduced motion; sheet: instant).
- The current column is remembered per session in `sessionStorage` (same
  pattern as the panel tab / stats tab, wrapped in try/catch); default Devis.
- The existing first-fetch loading state (dimmed, dash counts, grace-period
  pill) carries over: the header shows "–" for counts while pending and the
  pill renders over the pager.

### 5. Compact cards (mobile only)

`CardView` gets a `compact` prop used only by the mobile pager. The real card
is already leaner than the mockup — the step count lives in the body's
`TaskStepsSummary` and the footer is already one line — so compact means:

- Contact name inline after the client name ("SAS ONATI · Jeffrey") instead of
  its own line.
- No grip, not even the inert one (no drag on mobile).

Everything else on the card (flag, presence, paid badge, locks, tooltips,
aria labels) is unchanged. Desktop cards are untouched.

### 6. Floating create button

Only when `canCreate`. Fixed bottom-right (inside the safe area, respecting
`env(safe-area-inset-bottom)`), 56 px, accent colour. Tapping rotates the `+`
45° and opens a two-item menu above it: **Importer un devis** → the existing
`setShowImport(true)`, **Nouveau projet** → `setShowModal(true)`. Closes on
item, scrim, Escape. Hidden while the detail panel or a drawer is open.

### 7. Follow-up filter on mobile

The pills are not rendered on mobile, so the `followup` filter must not apply
there: the mobile branch filters with `followup = null` (search only). The
desktop state is left alone, so widening the window restores it.

## i18n

New strings (French shown), added to all 15 locales — the parity gate requires
every locale, and it rejects values identical to English, so each locale needs
a real translation:

- column sheet title / label ("Colonnes")
- "Carte la plus ancienne" (chip label)
- more-menu button label ("Plus d'options")
- create button label ("Créer")
- column picker hint ("Changer de colonne")
- segment label ("{{column}}, {{count}} projets", pluralised)

Existing keys are reused where they fit: `common.search` (search button),
`aito.searchPlaceholder`, `aito.clearSearch`, `aito.followups.longest` (chip),
`aito.importQuote` / `aito.newProject` (create menu), `aito.showDone`,
`aito.trash`, `aito.statistics`, `aito.inProduction`, column names.

## Accessibility

- All new controls are buttons with labels; the sheet and menus take focus on
  open (as the drawers do) and return it to their trigger on close.
- The segment strip and the picker give two ways to reach any column; swiping
  is never the only way.
- `prefers-reduced-motion`: no smooth scroll, no sheet slide (fade), no
  search-row height animation.

## Testing

Vitest (jsdom, `matchMedia` mocked for `max-width: 767px`):

- `AitoPage` at mobile width renders `MobileBoardHeader` and the pager, and
  does **not** render the title row, `FollowupStrip`, the inline search, the
  toolbar, or a `DndContext`; at desktop width it renders exactly as before
  (existing tests keep passing untouched).
- Header: picker shows the current column, count and oldest chip; search button
  toggles the row, focuses the input, ✕ clears, Escape keeps the query, dot
  appears when closed with a query.
- Strip and sheet: tapping a segment / a row sets the pager's `scrollLeft` to
  that page; the sheet opens/closes (scrim, Escape) and returns focus.
- Pager: a scroll event updates the header's column (mock `clientWidth` /
  `scrollLeft`); `sessionStorage` restore picks the saved column; storage
  throwing does not break the page.
- More-menu items call `changeView` with done / trash / stats.
- FAB: hidden without `canCreate`; items open the import / new-project drawers.
- Follow-up filter is ignored on mobile.
- Compact `CardView`: contact inline, no grip; the full card is unchanged.
- `BoardCardActions`: the extraction keeps every existing `BoardColumn` test
  green, and the mobile card shows the same action for a devis card.
- i18n parity check passes (`npm run check:i18n`).

Manual: the real `AitoPage` at 390 × 844 in Brave through the msw harness
(no login), checking swipe snap, header, per-column scroll, sheet, menu, FAB, and the panel
opening from a card. Then `npm run build`, `./test_frontend.sh`.

## Risks / notes

- The main checkout has uncommitted `AitoPage.tsx` edits from a parallel
  session; merging this branch back may need a hand-resolved conflict there.
- A Layout banner (debug / dev / update) rendered inside `<main>` above the page
  adds its height on top of the `100dvh − 3.5rem` board; the page then scrolls
  by that amount. Known, pre-existing for every full-height page (see the
  2026-08-04 kanban layout follow-ups); not addressed here.
- iOS Safari edge-swipe (back gesture) can steal a swipe that starts at the
  very edge; `overscroll-behavior-x: contain` on the pager limits the page
  bounce.
