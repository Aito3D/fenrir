# Revenue dashboard (« Chiffre d'affaires ») — design

Date: 2026-11-18. Status: design, not started.

## What and why

Rebuild loki's `/revenue` dashboard inside Fenrir: Aito3D turnover by day / ISO week / month / year, HT and TTC, read
from Zoho Books, with filters, comparisons, customer and product analysis, margin, projection, monthly targets and
chart notes. Same behaviour as loki, Fenrir's design and Fenrir's permission system.

**Source of truth for behaviour:** loki at `../loki`, commit `f150c2e2` (2026-11-09). The `reference/loki-revenue/`
copy the brief mentions does not exist; read `../loki` instead and never import from it. Read in this order:

1. `../loki/docs/superpowers/specs/2026-10-15-revenue-dashboard-design.md`, the « Revenue cache » and « Revenue page »
   sections of `../loki/docs/subsystem-notes.md`
2. `../loki/src/config/revenue.ts`, `REVENUE_SYNC` / `REVENUE_POLL` in `../loki/src/config/back-order-sync.ts`
3. `../loki/src/lib/revenue-*.ts`, `sync-loop.ts`, `background-gate.ts`, `search.ts`
4. `../loki/src/app/api/zoho/revenue/**/route.ts`
5. `../loki/src/components/revenue/*`
6. `../loki/src/lib/__tests__/revenue-*.test.ts` — the executable specification (287 cases)

The operator's brief (the pasted « Mission » prompt of 2026-11-18) summarises that code; where the two disagree, the
code wins. Known disagreements are listed at the end.

## Assumed answers to the Phase 0 questions

The user has not answered yet. The plan is written on these assumptions; each is cheap to change before its task runs.

| # | Question | Assumed answer |
|---|---|---|
| 1 | Same Zoho org as loki? | Yes (same `66407000…` id prefix). Figures must match loki exactly; « Client de passage » = `66407000001237340`. |
| 2 | Time zone / currency | `Pacific/Tahiti` hard-coded as the org zone (not the container `TZ`); XPF shown « FCP », `fr-FR`, whole units. |
| 3 | Natures, brands, history start | Unchanged from loki. |
| 4 | `view_customers`, `view_margin` | Adopted. Server strips; memo/ETag key includes the two flags. |
| 5 | Defaults for non-admin roles | None. |
| 6 | Item cache / pacing | New `revenue_items` table filled in the revenue loop. No global gate in `ZohoService`; the revenue lane honours the shared per-minute meter. |
| 7 | Nav | `/revenue`, sidebar item after Orders, `nav.revenue` = « Chiffre d'affaires » (fr) / « Revenue » (en). |
| 8 | Dormant-list link | Dropped (no stock page). |
| 9 | Language | `revenue.*` i18n keys in all 16 locales with real translations; French text = loki's wording verbatim. Permission labels in Settings stay English like every other one. |

## Architecture

loki computes every read model on the server and the browser renders, plus a set of browser-only helpers. Fenrir
keeps that split:

- **Python (backend), pure:** dates, scope, customers, series, insights (customer breakdown, movers, yoy, calendar days,
  targets), analysis (ABC, margin, dormant), products (product list, filter parsing, review list), sync plan.
- **Python, I/O:** store (async SQLAlchemy), Zoho reads, sync batch + loop, memo/ETag, routes.
- **TypeScript (browser), pure:** labels/ranges/shift/drill-down (dates + bucket helpers), chart shaping, KPI tiles,
  summary text, pace, calendar layout, basket/stack rules, brand options/search, URL ↔ controls, dashboard rules
  (poll, banner, stored controls, CSV + file name).

Some date/bucket helpers exist in both languages. Both sides port the same loki tests, which keeps them in step.

### Deliberate deviations from Fenrir conventions

- **camelCase JSON** on every `/revenue` payload (Fenrir is snake_case). The payloads are loki's shapes field for field,
  so the TS helpers and their tests port verbatim and a loki ↔ Fenrir JSON diff is a direct acceptance check. Routes
  return plain dicts built by the pure modules (no Pydantic response models); request bodies still use Pydantic.
- **Raw `fetch` with `If-None-Match`** for the series poller instead of TanStack Query, because a 304 must keep the
  rendered data and out-of-order answers must be dropped (loki's `startSeriesPoller`). Other panels use the same
  small hook. Auth headers come from `client.ts` (`bearerAuthHeaders`, exported for this).

### Backend layout

```
backend/app/models/revenue.py            7 models (below)
backend/app/services/revenue/
  config.py      constants (history start, natures, brands, passage ids, SYNC, POLL-free)
  dates.py       org_today(), day math on 'yyyy-MM-dd' strings, ISO weeks
  scope.py       ScopeItem, classify, ttc, unit cost, review list
  customers.py   segments
  series.py      buckets, ranges, build_revenue_series, item_breakdown, matching_lines
  insights.py    customer_breakdown, acquisition, movers, yoy_pivot, calendar_days, targets
  analysis.py    abc, margin_by, dormant
  products.py    build_product_list, parse_series_filters (422 messages)
  store.py       async reads/writes, snapshot, data stamp
  sync_plan.py   plan_revenue_sync, merge_day_rows, count_legacy_days
  sync.py        run_revenue_sync_batch, item-facts refresh, status, ensure_revenue_sync_loop
  memo.py        etag + bounded memo
backend/app/api/routes/revenue.py        all 19 endpoints under /api/v1/revenue
```

### Storage

New tables come from `create_all` (no ALTER needed), so the migration is "import the models in the three registration
lists". Works on SQLite and PostgreSQL.

| Model / table | Key | Columns |
|---|---|---|
| `RevenueDay` / `revenue_days` | `day` String(10) | `closed` bool, `fetched_at` String (ISO), `format` int |
| `RevenueDayLine` / `revenue_day_lines` | (`day`, `item_id`, `customer_id`) | `name`, `sku`, `quantity` float, `amount` float (HT). FK `day` → `revenue_days.day` ON DELETE CASCADE. Indexes on `item_id`, `customer_id`. `customer_id` is `""` when Zoho gave none (PK columns cannot be NULL). |
| `RevenueCustomer` / `revenue_customers` | `customer_id` | `name`, `company_name`, `sub_type` nullable, `found` bool, `fetched_at` |
| `RevenueScopeDecision` / `revenue_scope_decisions` | `item_id` | `included` bool, `decided_at` |
| `RevenueTarget` / `revenue_targets` | `month` String(7) | `amount_ht` float, `updated_at` |
| `RevenueAnnotation` / `revenue_annotations` | `id` autoincrement | `day`, `label` String(80), `created_at` |
| `RevenueItem` / `revenue_items` | `item_id` | `name`, `sku`, `brand`, `nature` (`cf_nature_du_produit`), `item_type`, `tax_percentage` nullable, `purchase_rate` nullable, `dealer_price` nullable (`cf_prix_dealer_usd_unformatted`), `status`, `fetched_at` |

`itemsSyncedAt` is the `Settings` row `revenue_items_synced_at` (ISO), written when a full item refresh completes.
Lines are stored in format 2 (customer-grouped) from day one; the `format` column stays so a later format change can
re-fetch, and `legacyDays` is always 0.

**Snapshot reads.** loki wraps multi-table reads in one SQLite read transaction. Here `store.snapshot()` is an async
context manager yielding a connection on which every read sees one point in time: PostgreSQL →
`isolation_level="REPEATABLE READ"`; SQLite → `isolation_level="AUTOCOMMIT"` plus an explicit `BEGIN` (pysqlite never
emits BEGIN before a SELECT, so without it each read sees fresh commits). The test needs a file DB (memory note:
`:memory:` + StaticPool cannot hold two sessions).

### Zoho access (read-only)

Three new methods on `ZohoService`, nothing else in the client changes:

- `sales_by_item_by_customer(db, day, page) -> (groups, has_more)`: `GET /reports/salesbyitem` with
  `from_date=to_date=day`, `page`, `per_page=200`,
  `group_by=[{"field":"customer_name","group":"report"}]` (JSON, URL-encoded by httpx).
- `get_contact(db, contact_id) -> dict` (raises `ZohoNotFound` on 404).
- `list_items_page_all(db, page) -> (items, has_more)`: `GET /items` 200 per page, no filter.

**Pacing.** Fenrir has no 700 ms gate. The revenue loop is its own lane (it is the only caller of these methods, and it
calls serially) and, before each call: waits so call starts are ≥ 700 ms apart; waits while
`zoho_service.calls_in_last_minute() >= 20`, ten below Order Board's `CALL_CEILING` of 30 so that lane keeps
headroom during a back-fill; stops the batch when
`zoho_service.daily_remaining` is known and < 5 000 (`DAILY_BUDGET_FLOOR`). A `ZohoRateLimited` ends the batch and the
loop sleeps `max(error_backoff, retry_after)`. Interactive routes never call Zoho.

### Sync

Port of `revenue-sync-plan.ts` / `revenue-sync.ts` / `sync-loop.ts` with loki's constants: batch 10 days, pause 3 s,
idle wake 60 s, error back-off 2 min, idle after 30 min without reads, live TTL 60 s, recent 7 days / 12 h, 5 customer
lookups per batch, item facts refreshed when older than 10 min (loki `itemsTtlMs`). The item refresh runs in the same
loop, before the day batch, so the two never call Zoho concurrently.

Process-global state is module state in `sync.py` (one uvicorn process, no `--reload` in production): `_inflight`
(the current batch's `asyncio.Task`), `_last_batch_at`, `_last_error` (public-safe: the exception class name and
Fenrir's own error message, never a URL or token), `_last_read_at`, `_loop_task`. `ensure_revenue_sync_loop()` is
called by every authorised revenue read; it records the read and starts the loop task if none is alive.
`run_revenue_sync_batch(full=True)` waits for an in-flight batch, then clears the cache and runs its own.

### API

All under `/api/v1/revenue`, permission first, 422 messages verbatim from loki. Every GET goes through
`revenue_json(request, user_flags, build)`: key = data stamp + item stamp + org day + path+query + flags (+ live sync
status for `/revenue`); weak ETag `W/"<sha1>"`, `Cache-Control: no-cache`, 304 on `If-None-Match`, memo of 64.

| Endpoint | Permission |
|---|---|
| `GET /revenue`, `/items`, `/products`, `/review`, `/sync`, `/movers`, `/yoy`, `/daily`, `/analysis`, `/targets`, `/annotations` | `revenue:read` |
| `GET /customers` | `revenue:read` + `revenue:view_customers` |
| `PUT`/`DELETE /scope/{item_id}` | `revenue:manage_scope` |
| `PUT`/`DELETE /targets/{month}` | `revenue:manage_targets` |
| `POST /annotations`, `DELETE /annotations/{id}` | `revenue:manage_notes` |
| `POST /sync[?full=1]` | `revenue:sync` |

Stripping when the caller lacks a flag:
- no `view_customers`: buckets lose `bySegment` / `bySegmentTtc`; `segment=` filter → 403; `/customers` → 403.
- no `view_margin`: buckets lose `cost` / `costedHt`; item rows lose `cost`; `/analysis` drops `marginByBrand` /
  `marginByNature`.

### Permissions

```
REVENUE_READ = "revenue:read"
REVENUE_EXPORT = "revenue:export"                 # CSV + copy summary (UI only)
REVENUE_MANAGE_SCOPE = "revenue:manage_scope"
REVENUE_MANAGE_TARGETS = "revenue:manage_targets"
REVENUE_MANAGE_NOTES = "revenue:manage_notes"
REVENUE_SYNC = "revenue:sync"
REVENUE_VIEW_CUSTOMERS = "revenue:view_customers"
REVENUE_VIEW_MARGIN = "revenue:view_margin"
```

Category "Revenue" in `PERMISSION_CATEGORIES`; English labels via `_PERMISSION_LABEL_OVERRIDES` (« View revenue »,
« Export revenue », « Classify revenue items », « Edit revenue targets », « Edit revenue notes », « Sync revenue from
Zoho », « See revenue customers », « See revenue margin »). Administrators get them through the startup sync to
`ALL_PERMISSIONS`; no other default group lists them. All eight go in `_APIKEY_DENIED_PERMISSIONS`. Frontend: added to
the `Permission` union, `<PermissionRoute permission="revenue:read">`, nav gate `revenue: 'revenue:read'`.

### Frontend

```
frontend/src/pages/RevenuePage.tsx              shell: header, view switch, state, wiring (lazy route)
frontend/src/components/revenue/lib/            pure TS ports + their Vitest specs
  types.ts dates.ts buckets.ts chart.ts kpis.ts analysis.ts insights.ts products.ts basket.ts url.ts dashboard.ts
  search.ts format.ts csv.ts
frontend/src/components/revenue/                one component per loki component
  useRevenueResource.ts RevenueSyncBanner RevenueControls RevenueProductSearch RevenueHero RevenuePace
  RevenueChart RevenueNotes RevenueMovers RevenueTable RevenueCustomers RevenueAnalysis RevenueYoy
  RevenueCalendar RevenueReview RevenueTargets
```

Design mapping: loki `Surface tier="card"` → Fenrir `Card` / Aito stats `Panel`; `Segmented` → the segmented-pill
pattern of `components/aito/stats/ScreenTabs`; `Popover` → `SwitchbarPopover` / `ContextMenu`; toasts → the app's
toast context; `Skeleton` → `components/Skeleton`; empty state → `Empty` from Aito stats primitives. Charts: recharts
for the stacked columns (with `stackOffset="sign"`, right axis for the cumulative line, custom bar shape for the
projection ghost, per-column target ticks and note diamonds via `Customized`), the pace lines and the yoy lines; plain
SVG for the hero ring, sparkline and calendar heatmap. Series colours: 5 categorical slots + neutral « Autres »,
derived from the app's chart tokens and checked ≥ 3:1 on the card in both themes; up/down carry ▲/▼ and signs.

Persistence: `localStorage` with loki's keys (`revenue-granularity`, `revenue-tax-mode`, `revenue-stack`,
`revenue-range`, `revenue-kind`, `revenue-segment`, `revenue-view`), every access in try/catch. URL mirrored with
`history.replaceState`, restored after mount, URL wins.

## Disagreements and limits found

1. `reference/loki-revenue/` missing → `../loki` @ `f150c2e2` used instead.
2. Brief: « keep French labels » vs Fenrir's 16-locale gate → translated keys, French verbatim.
3. TTC uses the item's **current** tax rate, not the invoice's (loki accepted limitation; kept).
4. Back-fill time: ~1 050 day calls at ≤ 20/min ≈ 53 min, vs ~17 min in loki.
5. Fenrir's `zoho_service` has no global 700 ms gate; the revenue lane paces itself (above).

## Approved look (mockup of 2026-11-19)

The user reviewed a browser mockup and approved it: `docs/superpowers/specs/2026-11-18-revenue-dashboard-mockup/revenue.html`
(static; to view it, serve the folder with the built `static/assets/index-*.css` copied beside it as `fenrir.css`).
Numbers, brands, natures and client names in it are fake. It is the visual reference for every UI task; where it and
the « Design mapping » paragraph above differ, the mockup wins. Behaviour still comes from loki.

- The page copies the Aito statistics view (`components/aito/stats/`): every block is a `Panel` (uppercase grey
  eyebrow title, legend at top right with round dots), every figure a `Tile` on the darker ground with a `DeltaBadge`.
- Segmented controls and the view switch use the `ScreenTabs` look (grey track, selected = raised grey), never green
  pills. Inside a panel the track is one step darker.
- Lists are rows on the darker ground, not ruled tables: `Facts` rows for movers and dormant products, `HBars` rows
  for best customers, ABC, margin and weekday average, grid rows for the period detail.
- Header: title + sync line on the left, HT/TTC and ⋯ on the right; below a rule, the period controls and granularity
  on the left and the view tabs on the right; filters on a second row.
- Évolution opens with a `Finding` sentence (lead clause white, rest muted) above the hero. This is an addition to
  loki; it is built from the same figures as the hero (share of target, change vs previous period) and omitted when
  neither is available.
- Reuse the stats primitives by import; move them only if a lint rule forces it.
