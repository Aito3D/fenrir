# Aito Kanban Layout Rework — Design

Date: 2026-08-04
Status: Approved via visual companion demo (mockup: `.superpowers/brainstorm/4181-1785841269/content/kanban-rework.html`)

## Goal

Maximize the space the Kanban board gets on `AitoPage`:

1. Kill the dead band at the bottom of the page — the board should run to the bottom of the viewport.
2. The 6 board columns must always fit the width of the app — no cut-off column at any zoom level, no dead space on the right on wide screens.
3. Collapse the two header rows (title/subtitle/actions + search/toggles) into **one line** so the board gets the vertical space back.

**Layout changes only.** All existing components, icons, colors, animations, and behaviors are kept as they are.

## Root causes (current code)

- `AitoPage.tsx:418` sizes the page as `lg:h-[calc(100vh-64px)]`, assuming a 64px top header. The desktop shell (`Layout.tsx:882`) has a *sidebar* and no top header at ≥1144px, and a 56px top bar (`mt-14`) between 1024–1143px. The board is therefore 64px (or 8px) shorter than its container — the visible bottom gap.
- Columns are fixed-width (`w-72 sm:w-80 flex-shrink-0` in `BoardColumn.tsx:216`), so on wide/unzoomed screens there is unused space on the right, and on zoomed screens the last column gets cut with only a hidden scrollbar (`scrollbar-hide` on the board container, `AitoPage.tsx:539`) to reach it.

## Design

### 1. One-line header (≥ `lg`)

Single flex row containing, left to right:

- Kanban icon + **Aito** title + in-production count badge (existing markup, unchanged)
- `BoardSearch` with `flex-1 min-w-0` — the search bar fills the middle and **gives up width first** as the window narrows (user picked option A)
- `ViewToggleButton` × 2 (Show done, Trash) — unchanged components
- Import + New Project buttons — unchanged components

Removals:

- The subtitle line (`aito.subtitle`, "Follow each order from quote to finished part") is removed from the page (and its i18n keys deleted from both locales if nothing else uses them).
- The separate toolbar row disappears; its contents merge into the header row.

Below `lg`, the header stacks (title row, then search, then the controls wrapping in one group) and the page scrolls normally — phones were never the problem.

Button labels: keep text labels at `lg`+ as long as they fit; if a squeeze breakpoint is needed, labels may hide leaving icons (existing icons, `title`/`aria-label` retained). Only introduce this if the one-line row actually overflows at 1024px — YAGNI otherwise.

### 2. Full-height board

Replace the phantom-offset height on the page container (`AitoPage.tsx:418`) with values matching the real shell:

- `< lg` (1024px): keep `min-h-…` behavior — page scrolls normally.
- `lg`–1143px: `h-[calc(100dvh-3.5rem)]` (56px compact top bar).
- `≥ 1144px` (arbitrary variant `min-[1144px]:`): `h-dvh` — no top offset.

The board row keeps `flex-1 min-h-0`; each column still scrolls its own cards. Trim the container's bottom padding stack (`p-8` + `pb-4`) so cards end near the viewport edge, consistent with the demo.

### 3. Six fluid columns

- Column width (`BoardColumn.tsx:216`): at `lg`+ replace fixed `w-72 sm:w-80` with fluid `flex-1 min-w-[230px]`; below `lg` keep the fixed width for touch-friendly horizontal panning.
- The per-column wrapper in `AitoPage.tsx:542` (`flex flex-shrink-0`) becomes a matching fluid flex item (`flex-1 min-w-0` at `lg`+).
- The board is always exactly the 6 visible columns (Done and Trash are separate views), so `flex-1` divides the width evenly.

### 4. Visible scrollbar fallback

When the window is so narrow (or zoomed) that 6 × 230px doesn't fit, columns stop shrinking and the board scrolls horizontally — with a **visible slim scrollbar**: remove `scrollbar-hide` from the board container and style a thin, theme-matching scrollbar (dark track, subtle thumb) instead. This is a fallback, not the primary mechanism.

## Out of scope

- No changes to cards, drag-and-drop, column rules, Done/Trash grids, drawers, or any behavior.
- No redesign of any component's visuals — icons, colors, and styling stay exactly as today.

## Error handling

Pure CSS/layout change — no new failure modes. Error/empty states render inside the same container and are unaffected.

## Testing

- Existing suites must stay green: `./test_frontend.sh` (tsc + ESLint + Vitest), plus `cd frontend && npm run build`.
- Frontend tests that assert layout classes on the board/columns (e.g. `AitoPage.test.tsx`, `AitoBoardColumnDrag.test.tsx`) are updated where a class string they assert changed — behavior assertions must not change.
- Manual check across widths: ≥1144px (no top bar), 1024–1143px (56px top bar), <1024px (stacked header, page scroll), plus browser zoom 110–150% to confirm the min-width floor + visible scrollbar.
