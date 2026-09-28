# File Manager: server-side paging and remembered view settings

Date: 2026-09-27
Status: approved design, awaiting implementation plan

## Problem

On a library of ~2,000 files the File Manager page is slow to open. Today
`FileManagerPage` calls `api.getAllLibraryFiles`, which loops over
`GET /api/v1/library/files` at 2,000 rows per request until a short page comes
back, then searches, filters and sorts the whole array in the browser and
renders every card at once. Two costs stack: the server serialises every row
(with creator and tag relations, duplicate and variant counts), then the
browser mounts ~2,000 cards, issues ~2,000 thumbnail requests and runs the
FLIP-reorder measurement over all of them.

Separately, only some of the view settings survive a reopen. Sort field and
direction, view mode, tag filter, folder sort, sidebar width and the
"show modified" toggle are persisted; search text, type filter, username
filter, the internal/external top-level view and the selected folder are not.

## Goals

- Opening the page with thousands of files feels instant: only the first
  100 rows are requested and rendered.
- Scrolling never visibly waits: the next page is requested before the user
  reaches the bottom, and rows append without the grid flashing or jumping.
- Every view setting comes back the way it was left when the page is
  reopened, stored per browser.
- No behaviour change for other callers of the list endpoint.

## Non-goals

- Per-user settings stored on the server.
- The printer SD-card `FileManagerModal`.
- `ProjectDetailPage`, which keeps using `getAllLibraryFiles`.
- Virtualised rendering. Rows that have been loaded stay mounted.

## Backend

### `GET /api/v1/library/files` gains five optional parameters

| Parameter    | Type                                          | Semantics |
|--------------|-----------------------------------------------|-----------|
| `search`     | `str \| None`                                  | Case-insensitive substring match on `filename`, on `file_metadata->>'print_name'`, or on the name of any tag attached to the file. `%` and `_` in the input are escaped. Blank or whitespace-only is treated as absent. |
| `file_type`  | `str \| None`                                  | Exact match on `LibraryFile.file_type`. |
| `created_by` | `str \| None`                                  | Case-insensitive substring match on the creator's `username` (outer join on `users`). Mirrors the browser filter it replaces. |
| `sort`       | `Literal["name","date","size","type","prints"]`, default `"name"` | See sort keys below. |
| `direction`  | `Literal["asc","desc"]`, default `"asc"`       | Applied to the primary key only. |

The default page size (`limit`) drops from 500 to 100. The cap stays 2,000.

Sort keys mirror the comparator the browser uses today:

| `sort`   | Primary key |
|----------|-------------|
| `name`   | `coalesce(file_metadata->>'print_name', filename)`, using SQLAlchemy's JSON path accessor so it works on SQLite and Postgres. Case-insensitive via `lower()`. |
| `date`   | `coalesce(fs_modified_at, created_at)` |
| `size`   | `file_size` |
| `type`   | `file_type` |
| `prints` | `print_count` |

Every ordering appends `LibraryFile.id ASC` as a tie-breaker so consecutive
pages never overlap or skip a row when the primary key ties.

The new filters compose with the existing ones (folder, recursive, tags,
scope, project, include_root) and are applied before the `X-Total-Count`
subquery, so the header reports the filtered total. Existing callers that
pass none of the new parameters get the same rows in the same order as
today, just with the new default page size where they did not pass `limit`.
`getAllLibraryFiles` always passes `limit`, so it is unaffected.

### `GET /api/v1/library/files/file-types`

Returns the sorted distinct `file_type` values in the current scope so the
type dropdown no longer depends on which rows happen to be loaded. Accepts
the same scoping parameters as the list endpoint (`folder_id`,
`include_root`, `internal_only`, `external_only`, `recursive`, `tag_ids`)
and the same ownership permission. The scoping query builder is extracted
from `list_files` into a helper so both endpoints share it. Response:
`list[str]`. The route is declared before `/files/{file_id}`.

## Frontend

### API client

- `api.getLibraryFilesPage(params)` fetches one page and returns
  `{ items: LibraryFileListItem[]; total: number }`. It uses `fetch`
  directly (the shared `request` helper hides response headers) and reads
  `X-Total-Count`, following the precedent of the upload endpoints. Errors
  are mapped through the same message extraction as `request`.
- `api.getLibraryFileTypes(scope)` for the facet endpoint.
- `api.getLibraryFiles` and `api.getAllLibraryFiles` are unchanged.

### View settings hook

`useLibraryViewSettings()` in `frontend/src/hooks/` owns:

```
{ search, filterType, filterUsername, topLevelView, selectedFolderId,
  sortField, sortDirection }
```

- Stored as one versioned JSON blob under `library-view-settings`
  (`{ v: 1, ... }`). On first run with no blob it seeds `sortField` and
  `sortDirection` from the legacy `library-sort-field` /
  `library-sort-direction` keys, then keeps writing those two legacy keys as
  well so nothing else that reads them breaks.
- Reads once on mount inside `useState` initialisers, validates each field
  (unknown sort field falls back to `name`, non-numeric folder id to `null`),
  and writes on every change inside try/catch.
- A `?folder=` URL parameter wins over the saved folder, as today.
- If the folder tree has loaded and the saved folder id is not in it, the
  hook's consumer resets the folder to `null` ("All files").
- The existing per-key settings (view mode, wrap/collapse folders, folder
  sort, sidebar width, show modified, tag filter) are left as they are.

### Infinite query

`FileManagerPage` replaces the single `useQuery` with `useInfiniteQuery`:

- Key: `['library-files', 'paged', folderId, topLevelView, searchExpandsSubfolders, tagIds, debouncedSearch, filterType, filterUsername, sortField, sortDirection]`.
  The `'library-files'` prefix keeps every existing
  `invalidateQueries({ queryKey: ['library-files'] })` working.
- Page size 100. `initialPageParam: 0`; `getNextPageParam` returns
  `offset + items.length` while that is below `total`, else `undefined`.
- `placeholderData: keepPreviousData` so changing a filter or sort keeps
  the old rows on screen until the new first page lands.
- Search input is debounced 250 ms before it reaches the key.
- `files` (the flat list used by the rest of the page) becomes
  `data.pages.flatMap(p => p.items)`; the client-side
  `filteredAndSortedFiles` memo goes away, and the recursive-search and
  tag-filter behaviours stay exactly as they are server-side.
- `total` from the last page drives a "Showing N of M" line in the toolbar.
- Select-all and bulk actions operate on the rows loaded so far.

### Sentinel hook

`useInfiniteScrollSentinel({ rootRef, enabled, onReach })` returns a ref
for a sentinel element. It creates an `IntersectionObserver` whose root is
the scroll container (the `lg:overflow-y-auto` pane in grid and list
views; `null` when the document scrolls) with a bottom `rootMargin` of
150 % of the root's height, and calls `onReach` when the sentinel
intersects. `enabled` is `hasNextPage && !isFetchingNextPage`. After a
page lands, the hook re-checks intersection once so a viewport taller than
one page keeps filling. Observer is recreated on resize.

### Loading states

- First load: existing skeleton/spinner behaviour.
- Next page in flight and the sentinel visible: a row of six skeleton cards
  (grid) or three skeleton rows (list) below the last item.
- All loaded: nothing extra; the count line reads "Showing M of M".
- Error on a later page: a small inline "Couldn't load more · Retry" row.

### Animations

Cards that arrive on a later page get the `animate-rise-lg` entrance with a
capped stagger (first 12 cards only) so a 100-card append does not take
several seconds to finish. `useFlipReorder` stays wired to the grid; its
order key is built from the loaded ids as today. If profiling shows the
per-render measurement is noticeable above ~500 loaded cards, the hook is
skipped past that count.

### i18n

New keys under `fileManager.*`: `showingCount` ("Showing {{shown}} of
{{total}}"), `loadMoreFailed`, `retry` if absent. Real translations in all
15 locale files; no `{{count}}` interpolation.

## Testing

Backend (`backend/tests/unit/test_library_list_paging.py`):

- each `sort` value in both directions returns the expected order, with
  `name` honouring `print_name` over `filename`;
- two consecutive pages with a tied sort key neither overlap nor skip;
- `search` matches filename, print name and tag name, and escapes `%`;
- `file_type` and `created_by` filter, and compose with folder scoping;
- `X-Total-Count` reflects the filtered total;
- `/files/file-types` returns distinct sorted types for the scope;
- a request with none of the new parameters returns rows in filename order.

Frontend:

- `useLibraryViewSettings.test.ts`: round-trip, legacy sort migration,
  invalid blob falls back to defaults, URL folder wins.
- `useInfiniteScrollSentinel.test.ts`: mocked `IntersectionObserver`
  triggers `onReach` when intersecting and not when disabled.
- `FileManagerPage.test.tsx` additions: first page renders 100 cards and
  the count line; simulating sentinel intersection requests offset 100 and
  appends; changing sort resets to offset 0 with the new `sort` parameter.
- Full `./test_frontend.sh`, `./test_backend.sh`, `npm run build`.
- Manual check in Brave against the running dev stack.

## Risks and mitigations

- Sorting by a JSON-extracted print name has no index; on 2,000 rows this
  is a few milliseconds in SQLite. Acceptable.
- `invalidateQueries` on an infinite query refetches every loaded page in
  sequence. With ten pages loaded that is ten requests after, for example,
  a tag edit. Acceptable for now; `maxPages` can cap it later.
- Callers relying on the old default page size of 500 without passing
  `limit`: none in the repo (`getAllLibraryFiles` passes 2,000). External
  API users get 100 rows and the same `X-Total-Count` header to page with.
