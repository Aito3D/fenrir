# Projects catalog on a phone: folder browser (design B)

Date: 2026-11-01. Demo: `docs/superpowers/specs/2026-11-01-projects-mobile-demo/` (`frame.html` compares A/B/C; the user chose **B**).

## Intent

`/projects` below 768 px is today the desktop catalog squeezed: title, subtitle, a wide "New project" button, search, two selects and wrapping chips take the top 40 % of the screen; the list scrolls inside a 72 vh box inside a page that also scrolls; folders are drag-and-drop only. The phone gets its own page: one folder at a time, like the Files app, with the Aito board's floating create button.

## User decisions

- Proposition B (folder browser, drill in) over A (one folding list) and C (visual grid).
- The add-project button is the Aito board's floating + (bottom-right, + turns into ×, a two-row menu).

## Design

**Breakpoint.** `(max-width: 767px)` renders `MobileCatalog`; from 768 px up nothing changes (tablets keep the current narrow layout, `lg` and up the pane).

**Page.** Exactly the screen under the shell's top bar (`h-[calc(100dvh-3.5rem)]`, the Aito phone board's recipe): a fixed header, only the list scrolls. No `position: sticky` (cannot engage in the shell's unbounded `<main>`).

**Header.** Title row: back chevron + current folder name (root: "Projects") with a breadcrumb line under it, and the counts (shown · in production · ready) on the right. Search row: the search field and one filter button (sliders icon; a green dot when status or sort is off its default) that opens the filter sheet. Chip rail: In production / Ready to print / No file yet, the materials, the tags, on one horizontally scrolling line.

**List.**
- Not searching: the current folder's sub-folders first (folder tile, name, "n projects · n folders · 🔥 n in production", chevron), then "Projects here" (root: "Not in a folder") as 72 px rows: 56 px thumbnail, code + production flame + printed count, name, client · order, recommended file · material · activity. An empty folder says so and that + creates here.
- Searching or filtering: one flat list of the matches across every folder, each row carrying its folder path. Folders are not shown.
- A row opens the project page (`/projects/:id`), as today below `lg`.

**Current folder** lives in the URL (`?folder=`), so the browser's back works. Drilling in slides the list from the right, back slides from the left (opacity + 28 px; none under reduced motion).

**Filter sheet** (bottom sheet): Status as four segments, Sort as a list with a check, Done. Replaces the two selects.

**Folder actions** (⋯ on a folder row → bottom sheet): Rename (inline input in the sheet), New folder inside, Move to folder… (a select, own subtree excluded), Delete folder (hint: contents move up a level). Projects are moved from the project page; no drag and drop on phones.

**Floating +.** Only with `projects:create`. Fixed `right-4 bottom-[calc(1.5rem+safe-area)]`, 56 px rounded square, z-30 (under the shell drawer), z-60 while its own menu is open; glyph rotates 45°. Menu (the Aito `ActionMenu`, placement above): New project / New folder (needs `projects:update`); inside a folder the caption says where the new item will be filed and the new project is moved there after creation. Hidden while a sheet or the new-project modal is open.

## Files

- `components/projects/catalog/mobile/MobileCatalog.tsx` (page body, header, rows, FAB), `mobile/Sheet.tsx` (bottom sheet base), `mobile/sheets.tsx` (filter, folder, new-folder sheets).
- `pages/ProjectListPage.tsx`: `usePhone()` and the `?folder=` param; the rest of the state is shared with the desktop page.
- `CatalogTree.tsx` exports `Thumb`, `factsLine`, `printedCell` for reuse.
- i18n `projectsPdm.catalog.mobile.*` × 15 locales.

## Tests

- `MobileCatalog.test.tsx`: root and folder views, back, flat search results, row opens, filter sheet, FAB menu, new folder, folder sheet (rename, delete), FAB hidden without permission or under a sheet.
- `ProjectListPage.test.tsx`: a phone media query renders the mobile catalog with the folder in the URL; the existing narrow test (768–1023) is unchanged.

## Out of scope

Moving a project from the phone list; the project detail page on a phone; a grid view.
