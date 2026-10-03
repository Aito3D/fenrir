# Archive page fast load — design

Date: 2026-10-02 · Branch: `archive-fast-load`

## Problem

Opening the Archives page takes 5–10 s. The page has pagination, but it is
client-side only: since upstream #843 the page calls
`GET /api/v1/archives/?limit=10000` and filters, sorts and slices pages in the
browser. Nothing loads progressively.

Measured on a sandboxed copy of the dev DB (3,074 archives, localhost):

| request | body | time |
|---|---|---|
| `limit=10000` (today) | 31.4 MB JSON, not compressed | ~1 s backend, then transfer + parse |
| `limit=50` | 534 KB | 70 ms |

95 % of the body is `extra_data._print_data`, a diagnostic snapshot of
~9 KB per archive. The frontend never reads it (the page only reads
`extra_data.slicer_ams_mapping`); backend consumers (Spoolman tracking,
usage tracker) read it from the ORM row, not the API. Without it the full
list is ~490 KB gzipped and the newest 50 rows ~10 KB gzipped.

The list query also sorts through a temp B-tree: `print_archives` has an
index on `deleted_at` only.

## Goals

- First page of archives visible almost immediately (target: well under 1 s
  on the shop LAN), because ~90 % of lookups are for recent archives.
- Full list (needed for search, filters, other pages) arrives much faster
  than today.
- No feature loss: every existing filter, sort, collection, duplicate
  grouping and highlight-jump keeps working once the full list is loaded.

## Non-goals

- Moving filtering/sorting/pagination server-side (approach C). Revisit if
  archive counts grow by an order of magnitude.
- Changing what is stored in `extra_data`.

## Part A — backend: slim the list

1. **Strip `_print_data` from list responses.** `archive_to_response` gains
   `include_print_data: bool = True`. When false, the returned `extra_data`
   is a shallow copy without the `_print_data` key (the ORM object is never
   mutated). `GET /archives/` and `GET /archives/search` pass `False`.
   `GET /archives/{id}` and every other caller keep the default, so the
   single-archive response is unchanged.
2. **Gzip JSON responses.** A small pure-ASGI middleware compresses a
   response only when all of these hold: the request's `Accept-Encoding`
   includes `gzip`, the response `Content-Type` is `application/json`, the
   response has no `Content-Encoding` yet, and the body is at least 1 KB.
   It sets `Content-Encoding: gzip`, fixes `Content-Length` and appends
   `Accept-Encoding` to `Vary`. Starlette's `GZipMiddleware` is not used
   because it would also compress streamed responses (camera MJPEG,
   file/timelapse downloads); anything not `application/json` passes
   through byte-for-byte.
3. **Index.** Declare `Index("ix_print_archives_deleted_created", "deleted_at",
   "created_at")` on `PrintArchive` (new installs via `create_all`) and add
   `CREATE INDEX IF NOT EXISTS ix_print_archives_deleted_created ON
   print_archives (deleted_at, created_at)` to `run_migrations()` (existing
   SQLite and PostgreSQL installs).

## Part B — frontend: newest first, then background fill

Two queries start in parallel on mount, both keyed under `['archives', …]`
so every existing `invalidateQueries({ queryKey: ['archives'] })` refreshes
both:

- **head** — `['archives', filterPrinter, 'head']`,
  `api.getArchives(printer, undefined, HEAD_SIZE)` with
  `HEAD_SIZE = max(pageSize, 50)`; skipped (`enabled: false`) when page size
  is "show all".
- **full** — `['archives', filterPrinter]`, unchanged from today.

The page's data is `full ?? head`. A flag `isPartial = !full && !!head`.

Behaviour while `isPartial`:

- The loading skeleton shows only until head arrives (today: until full).
- Page 1 renders from head. A small "Loading older archives…" hint (spinner
  + text) shows above the grid/list. Pagination needs no change: it only
  counts head rows, so it naturally offers just the head's pages (usually
  one, in which case the bar hides itself) until full arrives.
- If `sortBy !== 'date-desc'`, the page waits for full exactly as today
  (skeleton), because head holds the newest rows only and any other order
  over it would be misleading.
- Search and filters apply to head rows; the same hint stays visible so an
  empty result is not read as "not found".
- The highlight-jump effect does not show its "original print not visible"
  toast while partial; it retries when full arrives.

When full arrives it replaces head; the existing FLIP reorder animates any
movement (e.g. older duplicate-group members joining their group).

One new i18n key (`archives.loadingOlder`) with real translations in all
15 locales.

## Error handling

- head fails, full succeeds: page renders from full as today.
- full fails, head succeeded: page keeps showing head with the hint replaced
  by the existing query-error handling (React Query retry, then error state).
- Gzip middleware failures cannot corrupt streams because it never buffers
  or touches non-JSON responses.

## Testing

Backend (pytest):
- list and search responses omit `extra_data._print_data` but keep other
  `extra_data` keys (`slicer_ams_mapping`); `GET /archives/{id}` still
  returns `_print_data`; the ORM row still has it after a list call.
- gzip middleware: JSON ≥ 1 KB with `Accept-Encoding: gzip` is compressed and
  decodes to the same body; small JSON, no `Accept-Encoding`, and a
  non-JSON / streaming response are untouched.
- migration creates `ix_print_archives_deleted_created` (idempotent).

Frontend (Vitest):
- head result renders before full resolves; skeleton gone.
- "Loading older archives…" hint visible while partial, gone after full.
- non-date sort shows the skeleton until full resolves.
- highlight "not visible" toast suppressed while partial.

Measurement: re-run the sandbox timing (payload size, TTFB) before/after and
note the numbers in the PR/merge message.
