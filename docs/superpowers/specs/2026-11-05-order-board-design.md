# Order Board — design

Date: 2026-11-05. Status: approved by the user 2026-11-05.

Companion files:

- `2026-11-05-order-board-brief.md` — the user's brief, verbatim. It defines the allocation
  mechanism, the page layout, the list states and the polling rules. **Everything in the brief
  applies unless this document says otherwise.**
- `2026-11-05-order-board-demo/index.html` — the clickable mockup the user reviewed (fake data,
  real allocation logic in its `<script>`). It shows the layout, variant B of the expanded panel
  and the Settings tab. Its colours are stand-ins; the real page uses this app's components.

"Theirs" marks what the user decided. "My call" marks what I chose and the user has not
explicitly confirmed.

## Intent

The shop resells 3D-printing goods (and sailing gear) and holds open customer orders against
limited stock. Each morning the operator needs one answer: which orders can ship today, and what
holds back the others. The page is read-only towards Zoho: it never changes an order, a purchase
order or stock.

## Goals

- A new page, **Orders** (`/orders`), in the sidebar after Aito (theirs: "add in Navbar").
- A new Settings tab, **Orders** (theirs: "a special tab for it in settings").
- The board is computed on the server from a local copy of Zoho data, so opening the page is one
  local read.
- An empty or half-built board never looks like a verified answer.

## Non-goals

- Writing anything to Zoho.
- A back-orders / purchasing page. The brief's "View in Back Orders" link is left out (theirs,
  by the brief's own rule: no such page here).
- Which line went into which package (one extra Zoho call per package). Package numbers are shown
  per order, not per line.
- Purchase-order expected dates, WebSocket push (polling only), API-key access, loading the whole
  item catalogue.

## Anti-goals

- The sync must not starve the Aito Kanban of Zoho call budget. A 429 from Books has frozen Kanban
  pushes for 15 minutes before. Passes are bounded and back off on `ZohoRateLimited`.
- No all-red board on a cold start (see "Readiness").

## What this app has, and what it lacks

The brief assumes orders, purchase orders and stock are already stored. They are not. The app
talks to Zoho Books v3 through `backend/app/services/zoho.py` (`zoho_service._request`), for
estimates, invoices, contacts and item searches only. So this feature adds a read-only sync.

Verified on 2026-11-05 with read-only GETs through the stored token:

| Endpoint | Works | Notes |
|---|---|---|
| `GET /salesorders` | yes | 206 rows. Header fields used: `salesorder_id`, `salesorder_number`, `customer_name`, `date`, `status`, `total`, `quantity`, `quantity_shipped`, `quantity_packed`, `last_modified_time` |
| `GET /salesorders/{id}` | yes | `line_items[]`: `line_item_id`, `item_id`, `name`, `sku`, `quantity`, `quantity_shipped`, `quantity_packed`, `quantity_cancelled`, `quantity_invoiced`. `packages[]`: `package_number`, `status` (`not_shipped`, `delivered`, …), `date`, `quantity`, `shipment_number` |
| `GET /purchaseorders` | yes | 124 rows. `status` in `open`, `partially_billed`, `billed`, `cancelled` |
| `GET /purchaseorders/{id}` | yes | `line_items[]`: `item_id`, `quantity`, `quantity_billed`, `quantity_received`, `quantity_cancelled` |
| `GET /items?item_ids=a,b,c` | yes | Returns `stock_on_hand`, `brand`, `track_inventory`, `sku`, `name` for exactly those ids. (`/itemdetails` also works but lacks `brand` and `track_inventory`; do not use it.) |

Also verified the same day: the org has a single location, so org-wide `stock_on_hand` is the
shelf figure. `quantity_packed` is cumulative (a shipped line reads packed 1, shipped 1). A sales
order's header `last_modified_time` moves when a package is created. Inside the last 365 days
only one unshipped order is fully invoiced with nothing packed, and it is one day old, so the
"invoiced and never marked shipped" orders are an old-orders problem that the age limit covers;
no extra rule for them.

Sizes: 68 non-draft, non-void sales orders have unshipped units, 37 of them dated 2020–2025;
15 purchase orders are open or partly billed; the catalogue has 3,000+ items.

The Zoho org is the same kind of source the brief describes (same brands, stock lowered when the
invoice is created), so the brief's `invoiced` rule is kept as written.

## Adaptations to the brief

1. **"Arrived" on a purchase-order line** (my call): Books records both billed and received
   quantities. Incoming = `max(0, quantity − max(quantity_billed, quantity_received) −
   quantity_cancelled)`. A purchase order counts while its status is `open` or
   `partially_billed`.
2. **Old orders** (theirs): orders older than X days are ignored. X is a setting, default 365;
   0 means keep every order. Ignored orders are left off the board **and take no stock** from the
   pools (my call, stated in the mockup and not objected to). Age is `ageDays` as the brief
   defines it, compared at compute time.
3. **Partly shipped orders** (theirs: variant B of the mockup). See "Expanded panel".
4. **Packed units** (theirs: reserved first): Books has a middle state,
   units in a package with no delivery yet (16 orders today). See "Allocation: packed units".
5. **Core brands** (my call): the list is editable in the Settings tab instead of a config
   constant. Default: Bambu Lab, eSUN, SUNLU, Polymaker, Inslogic, Magigoo. The toggle keeps the
   brief's label "3D only".
6. **Stock-tracked** comes from the item's `track_inventory`. A line whose item id is not in the
   local item copy is treated as tracked with stock 0 and no brand (my call).
7. **Stock is loaded only for items on live order lines** (my call), with `GET /items?item_ids=`.
8. **Permissions** (theirs): two new permissions; Administrators and Operators get both.
9. **"Open in Zoho Books"**: built from `zoho_service._books_app_base(db)` plus the sales-order
   fragment (builder: confirm the fragment, `#/salesorders/{id}`, against the estimate one in
   `books_app_url`).

## Allocation: packed units (extends the brief's step 3)

The brief's pure function is written in Python on the server:
`compute_board(orders, purchase_orders, items, today, *, max_age_days, core_brands) -> rows`.
No I/O.

Per line, in addition to the brief's quantities:

- `packed_waiting = min(remaining, max(0, quantity_packed − quantity_shipped))`
- `reserve = max(0, packed_waiting − invoiced)` — packed units that are still counted in stock on
  hand (invoiced units have already left it).

Two passes instead of one:

1. **Reservation pass.** Walk every non-ignored order in the brief's sequence. For each
   stock-tracked live line take `reserved = min(reserve, stock left)` out of the stock pool.
   Goods already in a box cannot be claimed by an older order.
2. **The brief's walk**, unchanged except `fromStock = reserved + min(remaining − invoiced −
   reserved, stock left)`, and `stockAvailable` = the pool just before this line takes from it in
   pass 2, plus its own `reserved`.

With no packed units anywhere the result is identical to the brief, so the brief's worked case
holds as written. Each line also carries `packed_waiting` for display.

Known limit, same as the source app and not addressed: units shipped but not yet invoiced are
still inside Books' `stock_on_hand`.

## Storage (left to the builder, within these bounds)

- A local copy of the Zoho documents: sales orders (header + detail), purchase orders
  (header + detail), items. One table keyed by kind + Zoho id holding the JSON is enough; no need
  for normalised line tables.
- The computed board (rows as JSON), `computed_at`, `stock_loaded_at`, and the sync status
  (`running`, `last_error`, `last_error_at`, `last_success_at`). `pending` is derived from the
  document copy.
- New tables come from `create_all`. Follow CLAUDE.md's registration checklist for new models.

## Sync

A service runs **one bounded pass**; a background loop calls it on an interval, and the Refresh
button calls it once on demand. Passes never overlap (single-flight; a Refresh during a running
pass just returns the current state).

One pass:

1. List **all** sales orders and purchase orders (200 per page: three calls today). No
   watermark (my call): the lists are small, a full list also catches documents deleted in Zoho
   (a stored document missing from the list is removed), and nothing depends on which events move
   Zoho's timestamp. Upsert headers.
2. Mark a document **pending** when it is a candidate and its header differs from the stored one
   in `last_modified_time`, `status` or any quantity field (sales order: `quantity`,
   `quantity_packed`, `quantity_shipped`, `quantity_invoiced`; purchase order: `billed_status`,
   `received_status`, `quantity_yet_to_receive`), or when it has no stored detail. Sales order
   candidate: status not `draft`/`void`, `quantity_shipped < quantity`, and inside the age limit.
   Purchase order candidate: status `open` or `partially_billed`. Non-candidates lose their
   detail and stop counting.
3. Fetch details for at most **20** pending documents.
4. Re-read stock for every item on a stored live sales-order line, in batches (builder picks the
   batch size; verify the URL-length limit). Stock has no change feed, so this happens every pass.
5. Recompute the board and store it.

Rules:

- **Readiness.** `computed_at` stays empty until the first time a pass ends with nothing pending
  and stock loaded. Until then the page shows the brief's cold-start state with "N documents
  remaining". After that, a pass that leaves documents pending still recomputes; the header shows
  "Syncing · N remaining".
- **Failure.** Any Zoho error ends the pass, records `last_error`, and leaves the stored board
  untouched. On `ZohoRateLimited` the loop waits at least the server's retry hint.
- **Pace** (my call). While documents are pending the loop runs the next pass 60 seconds after
  the last one instead of waiting for the interval. A pass is about 25 to 30 calls (3 lists, up to
  20 details, a few item batches), so a cold start of roughly 85 details takes about five minutes.
- **Budget.** The loop interval is a setting (default 15 minutes). The builder checks how the Aito
  sync meters calls (`zoho_service.calls_in_last_minute`) and keeps a pass well under the shared
  per-minute budget.
- The loop runs only when the sync setting is on and Zoho is configured.
- Changing the age limit or the core brands recomputes the board from the local copy without
  calling Zoho. Raising the age limit can make older orders pending.
- Tests stub Zoho. The dev database talks to the real org; this feature only issues GETs.

## API

A new router (`/api/v1/order-board`, own module, not an Aito router):

| Route | Permission | Does |
|---|---|---|
| `GET /order-board` | `orders:read` | rows, `computed_at`, `stock_loaded_at`, sync status (`running`, `pending`, `last_error`, `last_error_at`, `last_success_at`) |
| `POST /order-board/refresh` | `orders:update` | one bounded pass, then the same payload |
| `GET /order-board/settings` | `orders:update` | the four settings below |
| `PUT /order-board/settings` | `orders:update` | saves them, recomputes |

Each row carries the brief's fields plus `is_core`, `zoho_url`, `packages[]` and per-line
`packed_waiting`.

## Permissions (theirs)

- `orders:read` — open the page. `orders:update` — Refresh and the Orders settings tab.
- Administrators and Operators get both, on fresh installs (`DEFAULT_GROUPS`) and on upgrade (the
  existing backfill block for the Operators group in `database.py`). Viewers get neither.
- API keys: denied (`_APIKEY_DENIED_PERMISSIONS`), like `aito:read`, because rows carry customer
  names.
- Follow CLAUDE.md's checklist for a new `Permission` member, including a new "Orders" entry in
  `PERMISSION_CATEGORIES` and the frontend `Permission` union.
- The Orders settings tab has its own endpoint because Operators hold `settings:read` only; the
  Projects tab (`canManageProjectsSettings`) is the precedent.

## Page

As the brief lays it out, built from this app's components (read `AitoPage`'s stats view,
`QueuePage` and `FinancePage` first). Route `/orders`, guarded by `orders:read`; sidebar item
`orders` after `aito` in `defaultNavItems`, hidden without the permission. Money uses the
formatting the Aito screens use (XPF, no decimals).

Filtering, sorting and summary counts are pure TypeScript functions with tests, following the
brief's rules on which numbers follow which filters. "3D only" filters on the row's `is_core`.

### Expanded panel (theirs: variant B)

One table, same five columns as the brief, split into groups. Empty groups are not rendered.

A group header must not read as a product row (theirs, after seeing a first version where both
were plain lines). Each header is a tinted band across the table with an icon, the group name in
the group's tone and a unit-count pill; the product rows under it are indented behind a rail in
the same tone, with rules only between product rows. Tones: To prepare = the app accent,
Packed = info, Shipped and Other lines = neutral and greyed.

| Group | Rows | Qty shows | Look |
|---|---|---|---|
| **To prepare** · N units | live lines with `remaining − packed_waiting > 0` | that number, with "of <ordered>" when it differs | normal; Available, Short and State as in the brief |
| **Packed, awaiting delivery** · N units | live lines with `packed_waiting > 0` | `packed_waiting` | "Packed" state; the group header lists the order's `not_shipped` packages ("PKG-00034 · packed 4 Nov") |
| **Shipped** · N units | every line with shipped units | shipped quantity | greyed; header lists the delivered/shipped packages |
| **Other lines** | Service and Cancelled lines | ordered quantity | greyed |

A partly shipped line appears in "To prepare" with what is left and in "Shipped" with what has
gone. The brief's "invoiced" tag stays on the To prepare row. Under the collapsed row's progress
bar the caption reads "X/Y shipped · N packed" when N > 0. The progress bar itself is unchanged
(packed units are part of "ready").

## Settings tab "Orders"

Placed after the Zoho tab, visible with `orders:update`. Two cards, as in the mockup:

- **Zoho sync**: on/off (default on); check interval (5, 15 or 60 minutes, default 15); last-sync
  line; "Sync now" (same call as Refresh).
- **What the board shows**: "Ignore orders older than [365] days" (0 keeps every order); core
  brands as removable chips plus an add field.

The mockup's "Reload everything" button is dropped (my call: nothing needs it yet).

## Text

All new strings go in every locale file (16 today) with real translations, per CLAUDE.md.

## Tests

- Python, pure function: the brief's worked case and its listed cases, plus the purchase-order
  "arrived" rule, the age limit (ignored orders take no stock), and the packed reservation (an
  older order cannot take boxed goods; no packed units gives the brief's numbers).
- Python, sync with Zoho stubbed: a pass is bounded at 20 details; pending counts down across
  passes; nothing is computed before the first complete load; an error keeps the last board and
  records the reason.
- Python: the routes' permissions, and the default-group grants.
- TypeScript: filter, sort, summary; the page's list states in the brief's sequence, including
  cold start and the sync-failure notice; the grouped panel.

## Done when

The brief's "Done when" list, with the hand check done against the dev database (real Zoho data,
read-only), plus: Operators can open the page, refresh, and edit the Orders settings tab.

## Left to the builder

Table and module names, the batch size for item lookups, how the loop is scheduled alongside the
existing background loops, which existing components serve as tile, chip, badge and skeleton, and
the settings keys.

## As built (2026-11-05, branch `order-board`)

Differences from the text above, each found while building or checking on real data:

- **A boxed unit is never short.** Units in a package with no delivery count as covered even
  when Books shows no stock for the item (real case: an order with all its units boxed read
  "To order"). Only the unboxed part of a line can be short. Formula: `covered =
  max(invoiced, packed_waiting) + taken from stock for the rest`.
- **Two stock figures exist in Books.** `stock_on_hand` (accounting, never negative) is used.
  `actual_available_stock` (physical) differs for 31 of 88 items on open orders and is negative
  for 20, so it is not maintained in this org. The known limit stands: accounting stock still
  counts units shipped and not yet invoiced.
- **Permission backfill runs once** (flag `_backfill_orders_permissions_done`), so a revoked
  permission is not restored on restart.
- **The loop wakes when settings are saved**, looks again after 60 s when sync is off or Zoho is
  not connected, sends nothing during a 429 back-off (Refresh included), and stops its own
  cadence below 5,000 daily calls left.
- **Reading the board never writes**; only a sync pass creates the state row.
- **The page says "Order sync is off" / "Zoho Books is not connected"** instead of loading
  forever when no board exists and none can arrive.
- **"3D only" is read at first render** (no server rendering here). The row stacks below 1024 px.
  Settings tabs are sorted alphabetically, so Orders sits between Notifications and Projects.
  The Orders cards are not in the Settings search box.
- Deferred, minor: only Zoho errors show on the page; "Available" on a half-boxed line includes
  its own boxed units; order age uses the server's calendar day; the progress bar's segments
  have no text alternative.
