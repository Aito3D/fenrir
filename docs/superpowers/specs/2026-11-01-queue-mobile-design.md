# Queue page on a phone, and page names in the top bar

Date: 2026-11-01.

## Intent

Below 768 px the Queue page is the desktop page squeezed: a two-line title, a five-button tab strip that overflows sideways, a five-stat box wrapping onto three rows, three selects, a layout toggle, and only then the list. The phone gets the Aito board's recipe: one tab at a time in a horizontal snap pager, a fixed 44 px header naming the tab, a segment strip, the filters behind a sheet.

Every page below 768 px drops its title block (h1 + subtitle) to win the space back; the shell's top bar shows the current page name instead, so the page is still identifiable with the drawer closed.

## User decisions

- Tabs are reached by swiping, like the Aito kanban on a phone (name + count + chevron header, segment strip, pager), not by a scrolling row of tab chips.
- Title removal applies to all pages, with the page name moved into the shell's top bar.

## Part 1 — page name in the top bar, titles hidden on phones

**Top bar.** The compact header in `Layout.tsx` (menu, logo, bell; shown while `isSidebarCompact`, below 1144 px) gets the page name after the logo: `md:hidden text-[15px] font-semibold text-white truncate min-w-0`, `ml-3`, the bell keeps `ml-auto`. `md:hidden` because the bar exists from 1143 px down but the titles only vanish below 768 px; between the two the page keeps its own title. The name is `t(labelKey)` of the nav item whose `to` matches the route: `/` exact, otherwise the longest `to` that is a prefix of `location.pathname` on a path boundary (so `/projects/12` → Projects, `/files/trash` → Files). A small table, consulted before the nav list, adds routes that are not nav items: `/system` → `system.title`, `/files/trash` → `libraryTrash.title`, `/printer-locations` → `printers.locations.title`, `/groups/new` and `/groups/:id/edit` → `groups.editor.title`. `/gcode-viewer` and `/external/:id` have no page title of their own and show nothing. No match → nothing is shown (logo alone), never a wrong name.

The name is `aria-hidden`: the page's h1 stays in the DOM for screen readers (see below), so the bar would otherwise read the name twice.

**Page title blocks.** The wrapper that carries `vt-page-title` on each page gets `max-md:hidden` when it holds only the h1 and a static subtitle. Where the same row also holds actions, only the h1 (and a static subtitle) is hidden and the actions keep their row; the wrapper's bottom margin is kept so the actions sit where the title was. A subtitle that carries live information (the Archives count, Maintenance due/warning counts, Library trash retention days) stays; only the h1 above it hides. Pages and what hides:

| Page | Hidden below 768 px | Stays |
| --- | --- | --- |
| Queue | whole block (the phone layout replaces it, part 2) | — |
| Notifications, Stats (both blocks) | h1 + subtitle | — |
| Archives, Maintenance | h1 | the live subtitle (count / due state), tabs |
| Printers | h1 | the status summary bar |
| Calculator, Filament profiles, File Manager, Inventory, Profiles, Projects (legacy page) | h1 + subtitle | the action buttons |
| Library trash | h1 | the retention subtitle, Empty trash |
| Settings, System info | h1 + subtitle | search field / Refresh |
| Aito, Projects catalog | nothing new (own phone headers already) | — |
| Project detail | nothing (the header is the project's name, data not a page title) | — |

`max-md:hidden` rather than `hidden md:flex` so each wrapper keeps its own display value. jsdom ignores the class, so every existing heading assertion keeps passing; screen readers still get the h1.

## Part 2 — the Queue page below 768 px

**Breakpoint.** `useIsMobile()` (`max-width: 767px`, the Aito board's rule) renders `MobileQueue`; from 768 px up nothing changes.

**Page.** Exactly the screen under the top bar: `flex flex-col h-[calc(100dvh-3.5rem)]`, header `flex-none`, the pager `flex-1 min-h-0`. No `position: sticky` (cannot engage inside the shell's unbounded `overflow-auto` `<main>`). The page's own `p-4` padding moves inside each pager page.

**Header row (44 px).** Left: a button with the tab's icon, name, count pill (`ColumnCountPill`, `–` while loading) and a chevron; it opens the tab sheet. Right: the filter button (sliders icon, a green dot when any of printer / status / location is set, hidden on Batches and Pipelines) and, on History with items, a ⋯ button with one item, Clear history (opens the existing confirm, `queue:delete_all` gating as today). Under the row, the strip: five equal segments (`flex-1`, 3 px tall, 12 px invisible hit area like `ColumnStrip`), the current one `bg-bambu-green`, the others `bg-bambu-dark-tertiary`; tap jumps. Equal widths, not count-weighted: History's count would swamp the rest and the counts carry no "load" meaning here.

**Tab sheet** (`Sheet` from the projects mobile catalog, lifted to `components/mobile/Sheet.tsx` so both can import it): the five tabs as rows, icon + name on the left, count on the right, a check on the current one. Picking jumps without animation and closes.

**Filter sheet** (same `Sheet`): Printer (All / Unassigned / each printer), Status (All + the eight statuses), Location (when any exist), each a list with a check; on the Queue tab a View section with Position / By printer segments and the SJF toggle (the existing mutation). Reset link at the top clears the three filters. Replaces the three selects and the controls row.

**Pager.** `overflow-x-auto snap-x snap-mandatory overscroll-x-contain scrollbar-hide`, one `section` per tab, `w-full flex-none snap-start snap-always overflow-y-auto overscroll-y-contain`. The mechanics are the Aito board's, extracted (below): land on the current tab before first paint, re-align on width change only, a strip/sheet jump scrolls smoothly with snapping switched off for the ride, and the self-settle that re-snaps to the nearest page 150 ms after the last scroll event with no finger down (WebKit leaves pagers resting between pages).

Only the current tab and its two neighbours render their content; farther pages are empty placeholders of full width. Settling on a page sets `activeTab`, which already drives `localStorage` and the per-tab query gating (`?tab=` is read once on load, as today, never written); the neighbour rule keeps History polling and the Pipelines dashboard from mounting on page load. Non-current pages are `inert`.

**Page contents.**
- Queue, History, Timeline pages open with the five stats on one horizontally scrolling line (`QueueStatsBar` gains a `compact` prop: no box, `flex-nowrap overflow-x-auto`, same icons and labels) instead of the wrapping box.
- The Queue page then shows the gate banners, the active prints and the pending list exactly as today (tap-to-select bulk flow, no drag handle on phones).
- History, Timeline, Batches and Pipelines render their existing views.
- The Timeline has no horizontal scroller of its own (its grid is `overflow-hidden`), so a swipe over it moves the pager like anywhere else. Any sideways-scrolling table inside the Pipelines or Batches views gets `overscroll-x-contain`, so scrolling it never flips the tab.
- The empty-queue card is per page (Queue tab only), not page-wide.

**Dialogs and modals** (edit, requeue, confirm, bulk edit) are unchanged; they already render as fixed overlays.

## Code

- `hooks/useSnapPager.ts`: `{ pagerRef, current, onScroll, onPointerDown, onTouchStart, onTouchEnd, onTouchCancel, jump(index, smooth) }` given `(count, current, setCurrent)`. Lifted verbatim from `MobileBoard.tsx` (scrollToPage, alignedWidthRef, jumpTargetRef + endJump, fingerDownRef + settle timer). `MobileBoard` consumes it; the `AitoMobileBoard` tests guard the move. MobileBoard carries today's uncommitted self-settle change; the hook lifts that version.
- `components/mobile/Sheet.tsx`: the projects catalog's `Sheet`, moved; `catalog/mobile/sheets.tsx` imports it from there.
- `components/queue/mobile/MobileQueue.tsx` (header, strip, pager, tab sheet, ⋯ menu via `ActionMenu`), `components/queue/mobile/QueueFilterSheet.tsx`.
- `pages/QueuePage.tsx`: the phone branch wraps the existing per-tab content; all state stays in the page. The per-tab JSX is pulled into a `renderTab(tab)` so both layouts share it.
- `components/QueueStatsBar.tsx`: `compact` prop.
- `components/Layout.tsx`: page-name lookup (`pageTitleFor(pathname)` in `utils/pageTitle.ts`, unit-tested) and the bar text.
- Title wrappers on the pages listed in part 1.
- i18n `queue.mobile.*` (pickTab, filters, view, resetFilters, moreOptions) × 15 locales.

## Tests

- `MobileQueue.test.tsx` with the `matchMedia` mock `QueuePage.test.tsx` already uses: pager renders five pages; the header names the current tab with its count; the sheet lists the five tabs and picking one shows that tab (and stores `queue.activeTab`); the strip jumps; the filter sheet sets the printer filter and shows the dot; Clear history appears only on History with items; neighbour rule (far pages empty).
- `useSnapPager.test.ts`: settle re-snaps a pager left between pages; a jump ignores intermediate pages; no re-align on a height-only resize.
- `pageTitle.test.ts`: nav matches, longest prefix, the extra table, unknown → null.
- `Layout.test.tsx`: the compact bar shows the name on `/queue`, nothing on an unknown route.
- Existing `AitoMobileBoard` and `MobileCatalog` tests unchanged.

## Out of scope

Redesigning the queue card itself on phones; a phone layout for the Batches or Pipelines dashboards beyond fitting in a pager page; tablets (768–1023 px keep the desktop layout).
