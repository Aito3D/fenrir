# Revenue (« Chiffre d'affaires »)

Aito3D turnover read from Zoho Books, at `/revenue` (sidebar: **Chiffre d'affaires**). It is a port of loki's
revenue dashboard (`../loki` at `f150c2e2`); the design is in
`docs/superpowers/specs/2026-11-18-revenue-dashboard-design.md`.

## What the page shows

Turnover by day, ISO week, month or year, HT or TTC, from 1 January 2024 (`REVENUE_HISTORY_START`), for the items in
scope: an item counts when its Zoho nature or brand is one of the 3D natures or brands in
`backend/app/services/revenue/config.py`, or when someone included it by hand. Items that match neither are listed
under **À classer** until someone decides.

- **Évolution**: the month's headline against its target, a pace chart, the current period with its projection, a
  stacked column chart (by nature, brand, goods/services, customer segment, or product when products are picked) with
  the running total, targets and notes, a detail list per period with its items, and the period's movers. Click a
  column (or Enter / Space on it) to zoom into it; « Retour » steps back.
- **Clients**: top customers, the pro / private / walk-in / unidentified split, and « Nouveaux et fidèles »: each
  period of the page granularity stacked by sales from new customers (first purchase falls in that period), returning
  customers (bought before) and unidentified sales (no customer or « client de passage »). "First purchase" means the
  first purchase of what the page shows, over the whole cache: the 3D scope narrowed by the page filters, so a 2025
  print customer who buys filament for the first time counts as new on the goods filter. The new / returning tiles
  use the same test. The cache starts in January 2024, so the first months count everyone as new.
- **Produits**: ABC (Pareto) classes, gross margin by brand or nature, and products that sold during the year but
  not in the last 90 days.
- **Saisonnalité**: year-over-year curves, a calendar heatmap of daily sales and the average per weekday.

Filters: goods / services, customer segment, brands, a product basket (search by name or SKU) and the period. The
controls are kept in `localStorage` and mirrored in the URL. The ⋯ menu holds the monthly targets editor, the items
to classify, copy summary, CSV export and the full rebuild.

## How the sync works

Interactive requests never call Zoho. Every authorised read of `/api/v1/revenue*` starts a background loop (one per
process) that keeps a local copy of Zoho's sales-by-item report, one row per day, item and customer:

- Each batch fetches 10 days (`GET /reports/salesbyitem`, grouped by customer) and up to 5 unknown customers
  (`GET /contacts/{id}`), then pauses 3 s while days are missing, 60 s once the copy is complete.
- Today is re-read after 60 s, the last 7 days after 12 h; older closed days are never re-read.
- The item facts (nature, brand, type, tax rate, costs) are re-listed (`GET /items`) when older than 10 minutes,
  before the day batch, so the two never call Zoho at once.
- Pacing: call starts at least 0.7 s apart, a wait while Fenrir made 20 or more Zoho calls in the last minute (Order
  Board stops at 30, so it keeps headroom), and no batch while Zoho's daily budget is known to be below 5 000. A 429
  ends the batch and the loop sleeps the longer of 2 minutes and Zoho's `Retry-After`; any other error backs off
  2 minutes.
- A day whose own report fails (a Zoho error for that day, not a 429 or a network error) gets its own back-off:
  2 minutes, then doubling up to 6 hours. Later batches skip it until then, so the rest of the history keeps
  loading; a successful fetch or a full rebuild clears it. The banner names the failed day (or the count) and the
  next retry, and the page stops fast polling once only failed days are missing.
- The loop stops 30 minutes after the last read and starts again with the next one.
- The page polls every 4 s while the back-fill runs and every 60 s afterwards (with ETags, so an unchanged answer is
  a 304), and not at all while the tab is hidden.

The first back-fill reads about 1 050 days at no more than 20 calls a minute: expect roughly an hour. Without Zoho
credentials the page waits for the item catalogue and the banner shows « Zoho credentials are not configured »; the
server logs that warning once, not on every retry.

## Check against Zoho

A wrong total looks like a right one, so each closed month is checked against Zoho's own total. The check compares
the cache's sum of every line of the month (all items, no scope, no filter) with the sum of `amount` over
`GET /reports/salesbyitem` for the whole month, ungrouped, 200 rows a page. A gap of 1 F or less (rounding) counts
as a match. Same report, different window: it catches a missing or failed day, a lost page or a day filed under the
wrong date. It does not catch an error on an invoice in Zoho itself.

- When: after a batch's day work, only when no day is left to fetch (none missing, stale or waiting out a back-off),
  at most one month per batch, through the same pacing, ceiling and budget rules. First every month never checked,
  newest first; then a month with a day re-fetched since its check; then last month again once its check is a day
  old (late edits to last month's invoices are common). Older months are never re-checked on their own.
- Cost: one or two calls per month once (about 35 for the history), then one or two a day for last month.
- A Zoho error during a check fails that batch like any other error; it never marks a day failed.
- In **Évolution**, by month and unfiltered, the detail list shows ✓ (matches, with the check date) or ⚠ (with
  both totals) beside each checked month; the banner counts the months in gap. **Recharger** beside a ⚠ (needs
  `revenue:sync`), or `POST /api/v1/revenue/checks/{yyyy-MM}/refetch`, deletes that month's days, lines and check:
  the next batches fetch it again (missing days go first) and check it again. A month not closed yet answers 422.
- Reads: `GET /api/v1/revenue/checks` (`revenue:read`), newest month first.

A full rebuild drops every check with the days.

## Cash

The page shows invoiced turnover; cash is what was **collected** each month and what is still **owed** now, for the
3D business only. The Zoho org is shared with the sailing business and payments and balances are per invoice, not
per item, so every amount is cut to its 3D share.

- **3D share.** Each customer is classed from the whole day cache, with the scope rules and decisions: every line in
  scope → `only3d` (share 1); none in scope → `none` (share 0); both, or unknown to the cache → the documents decide.
  For those, a payment's applications are read (`GET /customerpayments/{id}`: which invoices, how much), and each
  invoice's share is its in-scope `item_total` over the `item_total` of all its lines (a line without item, such as
  shipping, only counts in the total; a zero total gives 0). The class is computed at read time; a stored invoice
  share is re-read when Zoho's total for it changes.
- **Collected** (per month, by payment date): `only3d` → the amount; `none` → 0; otherwise Σ applied × invoice share.
  Money whose share is not known yet and money not applied to any invoice go in `collectedUnknown`, never guessed.
- **Invoiced TTC** beside it: the series' in-scope TTC for the month, unfiltered.
- **Outstanding**: Σ balance × share over invoices with a balance; unknown shares go in `unknown`; `overdue` is the
  part whose due date is before today. **topOverdue**: the five largest overdue 3D balances, with the customer's name
  (stripped without `revenue:view_customers`).
- **Coverage**: raw amounts (payments of the 12 months plus open balances) whose share is known vs still unknown.

Refresh: a step of the batch, after the day work and the month check, only when no day is left to fetch, at most
every 10 minutes (process-local). Each run (a) pages through payments modified since the cursor (the
`revenue_payments_since` row of `settings`, Books' `+0000` timestamp; first value: the 1st of the month 12 months
back), at most 10 pages a run, the cursor moving to the last row's `last_modified_time` after each page so a capped
run resumes there; a payment Zoho touched again has its applications read again; (b) lists invoices in status
`unpaid`, `overdue` and `partially_paid` (union by id) with their balance; a stored invoice none of them returned is
set to balance 0, unless a listing hit its page cap; (c) reads at most 20 documents for customers the cache cannot
settle: payments missing their applications, then invoices missing their share, newest first. `only3d` and `none`
customers never cost a document read.

Cost: the first fill lists about 8 pages of payments for 12 months, then up to 20 document reads every 10 minutes
until the mixed customers' shares are known; afterwards about 4 calls every 10 minutes. A Zoho error in this step is
logged and kept in the payload's `error`, and the step waits 10 minutes before trying again; it never fails the day
batch nor shows in the sync banner. A low daily budget stops it quietly like the rest. A full rebuild keeps these
tables.

Caveats: a cash advance (retainer) paid by a mixed customer sits unapplied and counts in `collectedUnknown`; for a
3D-only customer it counts in full when paid. A payment deleted in Zoho stays until a document read finds it gone. An
invoice share is computed with the scope rules of the moment it is read. A customer is classed on the cached lines
only: one whose 3D purchases predate the cache, or a new customer, is read document by document.

Reads: `GET /api/v1/revenue/cash` (`revenue:read`):

```
{
  "months": [{"month": "2026-11", "invoicedTtc": n, "collected": n, "collectedUnknown": n}],  // 12, oldest first
  "outstanding": {"total": n, "overdue": n, "invoices": count, "unknown": n},
  "topOverdue": [{"number", "customerName", "dueDate", "daysOverdue", "balance"}],  // view_customers only
  "coverage": {"known": n, "unknown": n},
  "syncedAt": iso | null,  // last complete cash refresh
  "error": string | null   // last cash refresh failure, process-local
}
```

## Tables

New tables come from `create_all` (no migration); they work on SQLite and PostgreSQL.

| Table | Holds |
|---|---|
| `revenue_days` | one row per fetched day: closed or not, when fetched, line format |
| `revenue_day_lines` | the day's lines: item, customer (`""` when Zoho gave none), name, SKU, quantity, amount HT |
| `revenue_customers` | customer facts used for segments (name, company, `sub_type`), or "not found" |
| `revenue_items` | Zoho item facts used for scope, TTC and margin |
| `revenue_scope_decisions` | items included or excluded by hand |
| `revenue_targets` | monthly HT targets |
| `revenue_annotations` | chart notes (day + label) |
| `revenue_month_checks` | per closed month: Zoho's total, the cache's total, when checked |
| `revenue_payments` | Zoho customer payments: customer, date, amount, unapplied, applications (JSON, read for mixed customers only) |
| `revenue_invoice_shares` | invoices: number, customer, dates, total, balance, 3D share and the total it was computed for |

The time of the last complete item listing is the `revenue_items_synced_at` row of `settings`; the payment listing's
cursor is `revenue_payments_since` and the last complete cash refresh `revenue_cash_synced_at`.

## Permissions

Administrators get all eight at startup; no other default group has any. All eight are refused to API keys.

| Permission | Unlocks |
|---|---|
| `revenue:read` | the page and every read endpoint |
| `revenue:export` | Copy summary and CSV export (UI only) |
| `revenue:manage_scope` | include / exclude items under « À classer » |
| `revenue:manage_targets` | edit monthly targets |
| `revenue:manage_notes` | add and delete chart notes |
| `revenue:sync` | « Réessayer » after a failed sync, the full rebuild and « Recharger » on a month in gap |
| `revenue:view_customers` | the Clients view, the segment filter and stacking, `/revenue/customers` |
| `revenue:view_margin` | costs and margins in every payload and view |

Without `view_customers` or `view_margin` the server strips those figures from the payloads; a `segment=` filter and
`/revenue/customers` answer 403.

## Rebuilding

⋯ → **Reconstruire** → **Oui, reconstruire** (needs `revenue:sync`), or `POST /api/v1/revenue/sync?full=1`. It waits
for a running batch, empties the day cache and starts the back-fill again (about an hour of Zoho calls). Targets,
notes and scope decisions are kept.

## Known limits

- TTC uses the item's tax rate and margins its cost (dealer price, else purchase rate) as they were when the day was
  fetched: each line keeps both, so a later price change leaves past months alone. Days cached before 2026-11-20
  have none and use the item's current values until re-fetched. The rate is the item's, not the one on the invoice.
- Margins only cover lines that have a cost; the coverage is shown next to each margin.
- "Services / machine h" (with `view_margin`) is services HT over the print log's printer hours: every print counts, stock and failed ones included, runs over 72 h (reconciled aborts) count none; periods before the log's first day show a dash.
- Sync state lives in the process: one uvicorn worker, no `--reload` in production.
- The back-fill takes about an hour, three times loki's, because the revenue lane stays below Order Board's call
  ceiling.
- Amber warnings (`text-amber-400`, as on the rest of the app) are hard to read in the light theme.
