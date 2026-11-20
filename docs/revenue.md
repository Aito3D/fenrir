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

The time of the last complete item listing is the `revenue_items_synced_at` row of `settings`.

## Permissions

Administrators get all eight at startup; no other default group has any. All eight are refused to API keys.

| Permission | Unlocks |
|---|---|
| `revenue:read` | the page and every read endpoint |
| `revenue:export` | Copy summary and CSV export (UI only) |
| `revenue:manage_scope` | include / exclude items under « À classer » |
| `revenue:manage_targets` | edit monthly targets |
| `revenue:manage_notes` | add and delete chart notes |
| `revenue:sync` | « Réessayer » after a failed sync and the full rebuild |
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
- Sync state lives in the process: one uvicorn worker, no `--reload` in production.
- The back-fill takes about an hour, three times loki's, because the revenue lane stays below Order Board's call
  ceiling.
- Amber warnings (`text-amber-400`, as on the rest of the app) are hard to read in the light theme.
