# Revenue (« Chiffre d'affaires »)

Aito3D turnover read from Zoho Books, at `/revenue` (sidebar: **Chiffre d'affaires**). It is a port of loki's
revenue dashboard (`../loki` at `f150c2e2`); the design is in
`docs/superpowers/specs/2026-11-18-revenue-dashboard-design.md`.

## What the page shows

Turnover by day, ISO week, month or year, HT or TTC, from 1 January 2024 (`REVENUE_HISTORY_START`), for the items in
scope: an item counts when its Zoho nature or brand is one of the 3D natures or brands in
`backend/app/services/revenue/config.py`, or when someone included it by hand. Items that match neither are listed
under **À classer** until someone decides.

- **Évolution**: the month's headline against its target, a pace chart, the current period with its projection,
  « Trésorerie et carnet » (this month's collected vs invoiced TTC, what is owed and overdue, then the order book; see
  [Cash](#cash) and [Order book](#order-book); whole-business figures, so shown only when no filter is set), a
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

A **service** is an item whose Zoho sales account is 70610000 « O'SEA Prestation de service Aito 3D »
(`REVENUE_SERVICE_ACCOUNT_ID` in `config.py`); every other item is goods, whatever its Zoho item type. Amounts are
after discount, so the services total sits below the account's own balance: Zoho posts the price before discount to
70610000 and the discount to 707001 « Remise ». After an upgrade every item reads as goods until the first item sync
(at most 10 minutes) fills the account.

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
- A day whose own report fails gets its own back-off: Zoho refused that day's request (HTTP 400) or its report ran
  past 20 pages (2 minutes, then doubling up to 6 hours), or Zoho answered 5xx (same doubling, capped at 10 minutes,
  since a 5xx may be Zoho itself). A 429, a network error, a token failure or any other Zoho-wide error marks no day.
  A customer lookup or month check that Zoho refuses (400) waits 6 hours on its own instead of failing every batch. Later batches skip it until then, so the rest of the history keeps
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

- When: after a batch's day work, once every day the batch could fetch was fetched (a day waiting out a back-off
  waits; its month is never complete, so it is never checked),
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

Refresh: a step of the batch, after the day work and the month check, once every day the batch could fetch was fetched (a day waiting
out a back-off does not hold it up), at most
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

## Order book

What is sold but not invoiced yet, read from the Aito board in the local database (zero Zoho calls). Every Aito card
is a 3D service, so there is no scope cut; goods orders on the Order Board are not included (that org-wide data also
holds the sailing business). Active cards only (`status = 'active'`; trash is `deleted`). Amounts are the card's
snapshot of the Zoho quote total (TTC), so a quote changed in Zoho shows here once the board syncs it.

- **accepted**: `quote_status = 'accepted'` and not `quote_invoiced` → count, Σ `quote_total`, Σ `retainer_paid_total`
  (deposits already collected on them), and the same per board column. A card without a quote total counts in
  `count` and `missingTotal`, not in the sum.
- **awaiting**: `quote_status` `sent` or `viewed` → count, Σ `quote_total`, and the age in days of the oldest
  `quote_sent_at`.

The ETag moves on any card write (count and max `updated_at` of `aito_projects`) and each org day.

Reads: `GET /api/v1/revenue/pipeline` (`revenue:read`):

```
{
  "accepted": {"count": n, "total": n, "retainerPaid": n, "missingTotal": n,
               "byColumn": [{"column": "print", "count": n, "total": n}]},  // board order, empty columns left out
  "awaiting": {"count": n, "total": n, "oldestDays": n | null}
}
```

## Result and break-even

« Résultat d'exploitation » in Évolution (unfiltered page, `revenue:view_margin`). Zoho is called for the fixed
costs (the running month when the page opens, at most every 15 minutes) and on the refreshes the operator asks for.

The three charges (labour, fixed costs, depreciation) are set under ⋯ → « Charges »: a summary per month and per
minute of the current month, then one table each.

- **Fixed costs** come from Zoho's expense accounts, every account whose code starts with `6` (`GET /chartofaccounts`).
  The books are shared with the other activities, so each account gets a share that is 3D printing's (`percent`, 0 by
  default), a type and a goods/services split (`goodsShare`), saved in the `revenue_fixed_accounts` row of `settings`
  as `{account id: {percent, type, goodsShare}}`. Accounts are keyed by Zoho's id: its codes are not unique. Amounts
  are one `GET /reports/profitandloss` per month (accrual, each account's own `total`), cached in the
  `revenue_fixed_accounts_cache` row; a share and a refresh never overwrite each other. A month's charge per type:
  - `monthly` (rent, electricity): what the books hold for that month. In the **running month only**, a usual amount
    not entered yet is projected: `max(0, mean of the 3 closed months before − entered)`, months without an entry
    counting 0. The projection is always carried apart (`fixedEstimated`), never inside `fixed`.
  - `annual` (insurance): the 12 months ending with that month ÷ 12, always real.
  - `one_off` (equipment): what the books hold for that month, never projected.
  A warning marks the accounts the page already counts elsewhere (`60` purchases, `64` staff, `68` depreciation
  charges); the share stays free. Reading takes `view_margin`, saving and refreshing `view_margin` +
  `manage_targets`. « Actualiser depuis Zoho » re-reads every month since mid-2025 and the account list; opening the
  page re-reads the months since the last read (so a month that closed meanwhile is completed) and reloads only when
  an amount moved. A failed read keeps the cache; an account gone from Zoho keeps its share and stays listed.
- **Depreciation** comes from Zoho Books' fixed assets (`GET /fixedassets`, read on the first opening and on
  « Actualiser depuis Zoho », stored with the selection in the `revenue_depreciation` row of `settings`). Nothing is
  selected by default; a switch per asset and per Zoho asset type chooses what 3D printing bears. A selected asset
  costs `cost ÷ total_life` a month from its depreciation start date to the end of its life (straight line, no
  residual value), spread over the month's days and by the minute during today, never before the print log's first
  day. Only assets Zoho calls `active` count. **As soon as one asset is selected, the print log's `wear` leaves every
  day's costs**: the calculator's usage wear and the books' depreciation are the same machines. The calculator and
  quotes keep their wear. A failed refresh keeps the stored list and selection; an asset gone from Zoho leaves the
  selection.
- **Per month** (last 12): `result = HT − variable − labour − fixed − fixedEstimated − depreciation`, and
  `resultReal` is the same without the estimate (equal on a closed month); the panel shows both for the running
  month as soon as something is estimated. Each row carries its own month's fixed costs. `variable` is the bucket's item costs plus the
  print log's filament, energy and wear; `labour` is the labour list. The current month counts fixed costs up to
  this minute.
- **Per day.** A month's fixed costs are spread evenly over its days and grow by the minute during today. Labour
  weighs on worked days only; today it grows over the 08:00–17:00 window (org time). Both sit in every bucket's
  `costParts` (`fixed`, `fixedEstimated`, `labor`, and `depreciation` likewise) and so in the margin of the charts and the table, from the print log's first day.
  No chart draws the cost parts: the estimate shows as its own « ≈ » line of the margin breakdown.
- **Goods / services filter.** Without a filter a bucket carries both parts of the fixed costs. `kind=services` keeps
  their services part with every other production cost; `kind=goods` carries their goods part and nothing else; an
  item, brand or segment filter carries none. In the margin split the goods part weighs on « Biens » (on the
  unallocated key of the other splits), the rest is shared among the service lines as before.
  Responses to margin viewers are rebuilt at most once a minute while any of the three is non-empty.
- **Break-even** of the current month: `(fixed + fixedEstimated + labour + depreciation of the full month) ÷ rate`
  (a one-off counts as soon as it is entered in Zoho), with
  `rate = (HT − variable) ÷ HT`. Labour of the full month is the labour list over every working day of the month, days
  to come included (scaling the days gone would swing with week-ends). A month with no sale yet borrows the rate of the three closed months before. `breakEven` is `null` when the rate
  is zero or negative (costs above sales) or when there is no charge at all.
- `day` is the day the running HT crossed the amount; when not crossed yet, the day the current daily average would
  reach it (`projected: true`), or `null` when that falls after the month's end.

- **What the result does not know.** Print and labour costs exist since `costsSince` (the print log's first day,
  July 2026): earlier months are `partial` and the panel prints no result for them, since their services would count
  at full margin. `coverage` is the share of a month's HT whose cost is known; goods without a Zoho cost count at full
  margin too, so a low coverage means an optimistic result. The shares have no history: today's share, type and split apply to every month shown.
  A closed month is never projected: a usual charge entered late leaves it too good until it is entered. Zoho posts
  by entry date, so an entry dated in the wrong month lands in the wrong month here too.
- **Depreciation limits.** An asset sold or written off in Zoho stops counting for past months too (the list has no
  disposal date). The per-day spread matches Zoho's monthly total but a first partial month can differ by a few
  francs. Repairs, which the wear rate carried, are no longer in the result once depreciation is on: type them as a
  fixed cost if they matter.

Reads: `GET /api/v1/revenue/result`, `GET|PUT /api/v1/revenue/fixed-accounts`
(`{month, readAt, accounts: [{id, code, name, active, flag, month, year, usual, percent, type, goodsShare}]}`; PUT takes
`{accounts: {id: {percent, type, goodsShare}}}`), `POST /api/v1/revenue/fixed-accounts/refresh?scope=current|all`
(the same shape plus `changed`), `GET|PUT /api/v1/revenue/depreciation`
(`{assets, selected, readAt}`; PUT takes `{selected: [id]}`), `POST /api/v1/revenue/depreciation/refresh`.

```
{"fixedMonthly": n,
 "charges": {"labor": n, "fixed": n, "fixedEstimated": n, "depreciation": n},
 "months": [{"month": "2026-11", "ht": n, "variable": n, "labor": n, "fixed": n, "fixedEstimated": n,
             "depreciation": n, "result": n, "resultReal": n, "coverage": 0.82 | null, "partial": false}],
 "costsSince": "2026-07-01" | null,
 "breakEven": {"amount": n, "reached": 0.6, "day": "2026-11-25" | null, "projected": true} | null}
```

## Aged receivables and expected cash

Three more keys on `GET /api/v1/revenue/cash`, from the same open invoices and 3D shares as « Reste dû »:

- `aging.buckets`: the 3D part of each open balance by days overdue: `notDue` (also invoices without a due date),
  `d30` (1-30), `d60` (31-60), `d90` (61-90), `over`. Invoices whose share is unknown stay in `outstanding.unknown`.
  `aging.byCustomer` (needs `view_customers`): the ten customers owing the most overdue.
- `dso`: outstanding ÷ in-scope TTC invoiced in the last 90 days × 90; `null` when nothing was invoiced.
- `forecast`: cash expected within 30 days, in 31-60 and in 61-90, from due dates. Overdue and undated balances go in
  the first window, and so does the accepted, not yet invoiced order book (quote total less deposits paid), which has
  no date of its own: `{window, invoices, orders}`.

Only open invoices are cached, so there is no history of who paid late in the past.

## Price / volume / mix

« Pourquoi le CA a bougé » in Produits: `GET /api/v1/revenue/pvm?from=&to=` (+ the page's filters) compares the period
with the one of the same length just before it, per item (quantity and HT).

- Items sold with a quantity in both periods: `(q1 − q0) × p0` is their volume part, `(p1 − p0) × q1` their price part.
- The volume parts are cut in two: `volume` = change in total units × the old average price; `mix` = the rest (units
  moving between cheap and dear items).
- Anything else is `new` or `lost`: an item sold in one period only, or a line without quantity (credit note).
- When the period before would start before the history (the default all-time range), `comparable` is `false` and
  the panel says so instead of calling everything new.
- `previous + volume + mix + price + new + lost = current`; mix takes the rounding remainder. `items` are the ten
  largest effects.

Units of different items are added together to get the average price, so `volume` vs `mix` is only as meaningful as the
catalogue is homogeneous; `price`, `new` and `lost` do not depend on it.

## Cohorts and customers to chase

Under the Clients view (unfiltered page, `revenue:view_customers`): `GET /api/v1/revenue/cohorts`, over the whole
cached history, identified customers only (no customer id and the walk-in account are left out).

- A **purchase day** is a day whose in-scope lines for the customer net above zero.
- `cohorts`: the last 12 months of first purchases: size, `retention[k]` = % of the cohort with a purchase day in
  month +k+1 (`null` while that month is ahead), and HT per customer to date.
- `ltv`: per segment, the mean HT of the 365 days following a first purchase, over customers first seen at least a
  year ago.
- `atRisk`: customers with at least 3 purchase days whose silence exceeds 1.5 × their median gap between purchases
  and 30 days;
  the 20 with the highest HT over the last 365 days.

## Quote funnel

« Devis envoyés, 12 derniers mois » beside the order book: `GET /api/v1/revenue/funnel`, from the Aito board (local
database). Cards whose quote was sent (`quote_sent_at`) in the last 365 days, trashed cards included: binning a
card declines its quote in Books, so it counts as declined (a card binned as a duplicate or a mistake lowers the
rate too; until the quote sync has run, a binned card still counts as awaiting).

- `accepted` (accepted or invoiced), `declined`, `expired`, `awaiting` (sent or viewed); `sent` is the four together.
- `conversion`: accepted ÷ decided (accepted + declined + expired), in count and in value, with `decided` so a rate on
  a handful of quotes reads as such.
- `medianDaysToAccept`: from sent to accepted.
- `bands`: the same rate under 10 000, 10 000 to 50 000, and 50 000 XPF TTC and more. A quote without a total counts
  in the counts and in `missingTotal`, in no amount and no band.

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
