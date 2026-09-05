# Aito follow-ups strip — design

Date: 2026-09-04. Status: approved in chat, awaiting written review.

Second of six features from the 2026-09-03 brainstorm (after the due date +
rush surcharge, merged 2026-09-04 as a14c96bfb). The four signals below do
not read `due_date`: the card badge already covers lateness. This feature is
the "who do I chase today" summary above the board.

## Goal

A strip above the Aito board that counts, and on click filters the board to,
the cards that are waiting on the operator to chase someone:

1. **Quotes out with no answer** — sent, viewed or expired for at least N days.
2. **Finished but client not told** — Finish column, no contact recorded.
3. **Told but not collected** — Finish column, contacted at least N days ago,
   not shipped.
4. **Unpaid invoices** — invoiced, balance above zero, past the invoice due date.

Thresholds N are two integer settings with defaults. No push notification in
this iteration.

## Non-goals

- No morning push, no digest entry. The rule module is written so a Python
  mirror can feed one later.
- No new endpoint: the strip computes from the cached board list.
- No per-chip threshold control; no persistence of the active filter.
- No invoice list UI; the Invoice card in the panel stays the place to read
  an invoice.
- No change to card visuals: the Finish column's cyan "call the client" glow
  and the contacted control are untouched.

## 1. Data model

Additive columns on `aito_projects`, all via `run_migrations()`:

| Column | Type | Meaning |
|---|---|---|
| `quote_sent_at` | `DATETIME` nullable | When the quote first left the shop. Naive UTC like `quote_accepted_at`. |
| `invoice_status` | `VARCHAR(30)` nullable | Zoho invoice status as last read (`unpaid`, `paid`, `partially_paid`, `overdue`, …). NULL = never read. |
| `invoice_balance` | `FLOAT` nullable | Amount still owed as last read. NULL = never read. |
| `invoice_due_date` | `VARCHAR(10)` nullable | ISO `YYYY-MM-DD` from Zoho. |
| `invoice_checked_at` | `DATETIME` nullable | Last successful invoice read. |

None of the five joins `VERSIONED_FIELDS`: they are background facts, never
edited in the panel.

### `quote_sent_at` — who writes it

Stamped **once**: every writer does `if project.quote_sent_at is None:`.
Re-sending a quote does not restart the clock; a withdrawn acceptance
(`quote.unaccepted`) does not clear it.

- `set_quote_status` when the new status is `sent`.
- `send_quote_email` after the email is confirmed sent.
- `adopt_quote_status` (`services/aito_quote_status.py`) when the adopted
  status enters `AWAY_STATUSES` (`sent`, `viewed`, `expired`) — this covers
  the poller reading a status change from Books.
- `create_project` when the create payload already carries an away or
  decided status (an import of an already-sent quote): `quote_sent_at` =
  `quote_date` parsed at midnight UTC, or `created_at` when `quote_date` is
  missing.

### Backfill

A one-time marker-gated migration `_backfill_aito_quote_sent_at`, modelled on
`_backfill_aito_quote_accepted_at`: for every project with `quote_sent_at`
NULL and `quote_status` in `sent`, `viewed`, `expired`, `accepted`,
`declined`, set it to the earliest `quote.sent` or `quote.emailed` event's
`occurred_at`, else `quote_date` at midnight, else `created_at`. Projects
with no quote status stay NULL.

### Invoice sweep

`services/aito_invoice_sweep.py`, one function `sweep_invoices(db) -> int`
(rows updated), called from `run_sync_loop` at most once per hour (the loop
already ticks every 300 s; the sweep keeps its own `_last_run` and returns
early). Selection:

```
status == "active" AND quote_invoiced IS TRUE AND quote_id IS NOT NULL
AND (invoice_balance IS NULL OR invoice_balance > 0)
```

For each selected project: `zoho_service.list_project_invoices(db, quote_id,
client_id)`; take the newest (index 0, the list is date-sorted); write
`invoice_status`, `invoice_balance`, `invoice_due_date`, `invoice_checked_at
= now`. No invoices → leave the three fields NULL but still stamp
`invoice_checked_at`. One `ZohoUpstreamError` logs a warning and skips that
project; the sweep continues. Once `invoice_balance` reaches 0 the project
drops out of the selection for good, so the steady-state cost is one Books
call per hour per invoice still owed — bounded by the shop's open receivables,
never by board size.

Every write path commits through the sync loop's existing session handling.
No event is recorded for these background reads (they are `trace`-level
noise at best and would fill the timeline hourly).

## 2. API

`AitoProjectResponse` gains the five fields verbatim (`quote_sent_at:
datetime | None`, `invoice_status: str | None`, `invoice_balance: float |
None`, `invoice_due_date: str | None`, `invoice_checked_at: datetime | None`).
The golden board fixture is regenerated (only new null keys).

Two settings in `schemas/settings.py` and the route's integer-key list:

| Key | Default | Bounds |
|---|---|---|
| `aito_followup_quote_days` | 5 | 1..365 |
| `aito_followup_pickup_days` | 7 | 1..365 |

The frontend reads them through the existing `['settings']` query.

## 3. Rules — `frontend/src/utils/aitoFollowups.ts`

Pure, no React. Input: the board list (`AitoProject[]`), thresholds, and
`today` (ISO local date, `localDateKey(new Date())`) plus `now` (ms) for
timestamp maths. Output:

```ts
type FollowupKey = 'quoteOut' | 'notTold' | 'notCollected' | 'unpaid';
interface FollowupBucket { key: FollowupKey; ids: number[]; maxDays: number }
followups(projects, { quoteDays, pickupDays }, now, today): Record<FollowupKey, FollowupBucket>
```

Rules, evaluated only on `status === 'active'` projects not in `done`:

| Bucket | Condition | Days |
|---|---|---|
| quoteOut | `quote_status ∈ {sent, viewed, expired}` and `quote_sent_at` not null and `days(quote_sent_at) ≥ quoteDays`; for `expired`, no minimum | days since `quote_sent_at` |
| notTold | `needsClientContact(project)` (existing helper: column finish, `client_contacted_at` null) | days since `ageAnchor(project).at` |
| notCollected | column `finish`, `client_contacted_at` not null, `shipping_island` null, `days(client_contacted_at) ≥ pickupDays` | days since `client_contacted_at` |
| unpaid | `invoice_balance > 0` and `invoice_due_date` not null and `invoice_due_date < today` (string compare) | days since `invoice_due_date` |

`days(ts)` = `floor((now − parseUTCDateStrict(ts)) / 86 400 000)`, never
negative. Each bucket's `ids` are sorted by days descending; `maxDays` is the
first entry's days or 0.

## 4. Strip — `components/aito/FollowupStrip.tsx`

Rendered by `AitoPage` between the header row and the columns, only when at
least one bucket is non-empty. Four chips in fixed order (quoteOut, notTold,
notCollected, unpaid); a chip with count 0 is omitted. Each chip:
`<button aria-pressed>` with the label (`aito.followups.<key>`), the count,
and `aito.followups.longest` ("{{days}} d") when `maxDays > 0`. Colours:
quoteOut amber, notTold cyan (matches the card glow), notCollected orange,
unpaid red — as complete class strings. `data-testid="aito-followup-<key>"`.

Page state: `followup: FollowupKey | null`. Clicking the active chip, or
pressing Escape while the strip has focus, clears it. When set, every
column's visible list is `board[col].filter(p => bucket.ids.includes(p.id) &&
matchesSearch(p, search))`; the Done grid count follows the same rule, and the
filter clears whenever the view leaves the board (the strip is board-only, so
a filter surviving into Done or Trash would be invisible, unclearable, and
would still make the Show Done badge read 0 over a full grid). The existing
empty-column copy already handles
a filtered board. The filter is not persisted and clears when the page
unmounts. The strip's accessible name: `aito.followups.title` ("To chase").

Counts are derived from the same `['aito-projects']` cache the board renders,
so optimistic writes (contact marked, quote accepted) update them in the
same render.

## 5. Settings UI

Two number inputs (`min=1 max=365 step=1`) in the Aito block of the settings
page where the pickup-SMS URL lives (`components/AiSettings.tsx`), labelled
`settings.aitoFollowupQuoteDays` / `settings.aitoFollowupPickupDays` with a
one-line description each. Saved through the existing settings update path.

## 6. i18n

All 13 locales, no EN-identical values: `aito.followups.title`,
`aito.followups.quoteOut`, `aito.followups.notTold`,
`aito.followups.notCollected`, `aito.followups.unpaid`,
`aito.followups.longest` (`{{days}}`), `aito.followups.clear`,
`settings.aitoFollowupQuoteDays`, `settings.aitoFollowupQuoteDaysDescription`,
`settings.aitoFollowupPickupDays`, `settings.aitoFollowupPickupDaysDescription`.

## 7. Testing

Backend:
- `quote_sent_at` stamped once on each of the four write paths; a second
  send does not move it; unaccept does not clear it.
- Backfill: earliest sent/emailed event wins; falls back to `quote_date`,
  then `created_at`; NULL for never-quoted projects; marker-gated idempotent.
- Sweep: selection excludes paid (`balance == 0`), un-invoiced, trashed and
  quote-less projects; one `list_project_invoices` call per selected project
  (assert call count); fields written from the newest invoice; a Zoho error
  skips one project and the others still update; the hourly gate skips a
  second call within the hour; an empty invoice list stamps
  `invoice_checked_at` only.
- Settings: defaults, round trip, bounds rejected; integer coercion on read.
- Golden fixture regenerated; response carries the five fields.

Frontend:
- `aitoFollowups.test.ts`: one table per bucket at the boundary (N−1 days
  out, N days in), the expired-no-minimum rule, done/trashed exclusion,
  shipped jobs excluded from notCollected, partially paid counts as unpaid,
  future due dates excluded, sort and `maxDays`.
- `FollowupStrip.test.tsx`: hidden when empty; chips with counts and longest
  wait; `aria-pressed` toggling; Escape clears.
- `AitoPage.test.tsx`: clicking a chip narrows every column to that bucket;
  search narrows within it; clicking again restores the board.
- Settings form: the two fields save.

## Open decisions, resolved

| Question | Decision |
|---|---|
| Signals | All four |
| Delivery | Strip only, no push |
| Thresholds | Defaults 5 / 7 days, editable in settings |
| Chip click | Filters the board |
| Where rules run | Client, over an enriched board list |
| Invoice cost | Hourly sweep, one call per open invoice, stops when paid |
