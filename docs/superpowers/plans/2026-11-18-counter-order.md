# Counter Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a walk-in ("comptoir") sales order from the Order Board, see it opened at once, then pay it with the existing terminal flow.

**Architecture:** One new Books write (`POST /order-board/orders`: create SO, confirm it, store it, refresh, recompute) following the `edit_lines` writer pattern; counter orders sort first in stock allocation. Frontend: a persistent draft row on `OrderBoardPage` shown in "focus" mode (other rows hidden), built from existing order and Aito pieces; client history filters data the page already has.

**Tech Stack:** FastAPI, SQLAlchemy async, pytest (xdist); React 19, TanStack Query, Vitest + Testing Library, i18n (16 locales).

**Spec:** `docs/superpowers/specs/2026-11-18-counter-order-design.md`

## Global Constraints

- Books order: `is_inclusive_tax: true`, `discount_type: "item_level"`, `is_discount_before_tax: true`, `reference_number: "Comptoir"`, line `rate` from the Books item, no `location_id` (single location, Books default).
- Discount per line: `"N%"` with 0 ≤ N ≤ 100, or an amount ≥ 0 and ≤ quantity × rate; off the TTC line total.
- Quantity rule = `edit_lines`: finite, > 0, `round(q, 3) == q`.
- A draft never reaches Books before **Créer**; reset/abandon send nothing.
- Same `client_ref` twice → one Books order.
- Counter orders (`reference_number == "Comptoir"`) go first in `compute_board`'s allocation sort.
- Selling above stock is allowed (warning only).
- The draft starts on the client de passage (`/zoho/status` `default_contact_id` / `default_contact_name`); history hidden for it.
- Draft persisted in localStorage key `orders.newOrderDraft.v1`; reset = Aito's `HoldButton` (RotateCcw, `durationMs={500}`, `progress="perimeter"`).
- New i18n keys under `orders.newOrder.*` in all 16 locale files (incl. `pl`), real translations.
- Never call real Zoho/Heimdall in tests (the root `bambuddy.db` is DEV but talks to real accounts).
- Never stash, never `git add -A` in the main checkout (parallel sessions share it); add explicit paths. Do not push.

## Review Focus

1. Confirm step fails after the SO was created → Books order voided, operator sees an error, nothing on the board. (Task 2 test `test_confirm_failure_voids_the_draft`.)
2. Double click / retried request with the same `client_ref` → one Books create. (Task 2 test `test_same_client_ref_creates_once`.)
3. Zoho 429 during create → `ZohoBusy` (503-style refusal), no partial store. (Task 2 test `test_rate_limited_create_is_busy`.)
4. A stored draft from an older shape (missing keys, junk JSON) → draft opens empty, no crash. (Task 4 test `restores nothing from junk storage`.)
5. Create answers but the board refresh fails → the order still opens once the next pass stores it; the draft is cleared only on a 2xx. (Task 6 test `keeps the draft when create fails`.)

---

### Task 1: Zoho helpers for creating and confirming a sales order

**Files:**
- Modify: `backend/app/services/zoho.py` (next to `void_salesorder`, ~line 1466)
- Test: `backend/tests/unit/test_zoho_salesorder_create.py` (new; `ls` first, it must not exist)

**Interfaces:**
- Produces: `ZohoService.create_salesorder(db, payload: dict) -> dict` (POST `/salesorders`, returns `payload["salesorder"]`); `ZohoService.mark_salesorder_open(db, salesorder_id: str) -> None` (POST `/salesorders/{id}/status/open`).

- [ ] **Step 1: Failing tests** — monkeypatch `zoho_service._request` to record calls:
  - `test_create_salesorder_posts_and_returns_the_order`: returns `{"salesorder": {"salesorder_id": "9"}}` → result `{"salesorder_id": "9"}`, call `("POST", "/salesorders", json=payload)`.
  - `test_mark_salesorder_open_posts_status_open`: call path `/salesorders/9/status/open`; id goes through `_seg`.
- [ ] **Step 2:** `./venv/bin/python3 -m pytest backend/tests/unit/test_zoho_salesorder_create.py -v` → FAIL (attribute missing).
- [ ] **Step 3:** Implement both methods, modelled on `create_estimate` / `void_salesorder`.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit `feat(orders): Zoho helpers to create and confirm a sales order`.

### Task 2: `create_counter_order` action + `POST /order-board/orders`

**Files:**
- Create: `backend/app/services/order_board_actions/create.py`
- Modify: `backend/app/services/order_board_actions/__init__.py` (re-export + `__all__`)
- Modify: `backend/app/api/routes/order_board/fulfilment.py` (route + body schema)
- Test: `backend/tests/unit/test_order_board_create.py` (new), `backend/tests/unit/test_order_board_routes.py` (permission sweep)

**Interfaces:**
- Consumes: Task 1 helpers; `zoho_service.list_items_by_ids`; `sync.zoho_busy`, `sync._busy_on_rate_limit`, `sync.open_rate_limit_window`, `sync.refresh_order`, `_log`, `OrderActionRefused` (codes below).
- Produces: `async def create_counter_order(db, customer_id: str, lines: list[dict], client_ref: str, *, by: str | None) -> str` returning the new `salesorder_id`. Route `POST /api/v1/order-board/orders`, permission `ORDERS_UPDATE`, body `CounterOrderBody { customer_id: str (min 1), client_ref: UUID, lines: list[{item_id: str, quantity: float, discount: str | None}] (min 1) }`, response `{"board": read_board(...), "row": find_board_row(...) or None, "salesorder_id": str}` (201).

Behaviour (in order):
1. `sync.zoho_busy()` → raise `sync.ZohoBusy`.
2. `client_ref` seen → return its stored id (module-level `dict[str, str]`, bounded to the last 200 entries; also guard concurrent duplicates with an `asyncio.Lock` keyed per ref). `# shortcut: in-memory dedupe, lost on restart; upgrade to a stored marker if restarts mid-sale matter`.
3. Validate quantities (`bad_quantity`), duplicate item ids (`unknown_item`), discount format/range (`bad_discount`).
4. `list_items_by_ids` → missing or service item → `unknown_item`. 429 → `open_rate_limit_window` + `ZohoBusy`.
5. `create_salesorder` with `customer_id`, `date` = today ISO, `reference_number: "Comptoir"`, `is_inclusive_tax: True`, `discount_type: "item_level"`, `is_discount_before_tax: True`, `line_items: [{item_id, quantity, rate, discount?}]`.
6. `mark_salesorder_open`; on any failure: `void_salesorder` (best effort, logged), re-raise as `OrderActionRefused("create_failed")`.
7. Insert `OrderBoardDoc(kind="salesorder", zoho_id=id, header=<created SO dict>, pending=True)`, commit, `refresh_order`, `_log(db, id, "order.created", by)`.
8. Remember `client_ref → id`; return id.

Route maps `OrderActionRefused` through the existing `_run` (add the new codes to its message table if it has one; check `_common._run`).

- [ ] **Step 1: Failing tests** in `test_order_board_create.py` (stub every `zoho_service` call with monkeypatch, use the stored-board fixture pattern from `test_order_board_actions.py`):
  - `test_creates_confirms_stores_and_logs`: payload sent equals the Global Constraints fields; `mark_salesorder_open("9")` called; an `OrderBoardDoc` with `zoho_id="9"` exists; an `order.created` event exists; returns `"9"`.
  - `test_same_client_ref_creates_once`: two calls (and two concurrent `asyncio.gather` calls) → `create_salesorder` called once, both return `"9"`.
  - `test_confirm_failure_voids_the_draft`: `mark_salesorder_open` raises `ZohoUpstreamError` → `void_salesorder("9")` called, `OrderActionRefused("create_failed")`, no `OrderBoardDoc`.
  - `test_rate_limited_create_is_busy`: `create_salesorder` raises `ZohoRateLimited` → `sync.ZohoBusy`, no doc.
  - `test_refuses_bad_quantities_discounts_and_services` (parametrized): `0`, `-1`, `1.0004`, `nan` → `bad_quantity`; `"101%"`, `"-5"`, amount > q×rate, `"abc"` → `bad_discount`; service item → `unknown_item`; nothing sent to Books.
  - `test_valid_discounts_are_sent_verbatim`: `"10%"` and `"5"` arrive on the line as given.
  - In `test_order_board_routes.py`, add `("post", "/api/v1/order-board/orders", <valid body>)` to the needs-`orders:update` parametrization (`none` and `read` → 403), and `test_create_order_route_returns_201_with_the_id` (action monkeypatched).
- [ ] **Step 2:** `./venv/bin/python3 -m pytest backend/tests/unit/test_order_board_create.py backend/tests/unit/test_order_board_routes.py -v` → FAIL.
- [ ] **Step 3:** Implement `create.py`, the re-export and the route.
- [ ] **Step 4:** Same command → PASS; then `ruff check backend/ && ruff format --check backend/`.
- [ ] **Step 5:** If the new body schema trips `test_not_null_update_schemas.py`, list it in `NOT_A_ROW_UPDATE`. Commit `feat(orders): create a counter order from the board`.

### Task 3: Counter orders first in allocation; `customer_id` on finished rows

**Files:**
- Modify: `backend/app/services/order_board.py:327` (sort key)
- Modify: `backend/app/services/order_board_sync/_finished.py` (`read_finished` row)
- Modify: `frontend/src/api/client.ts` (`FinishedOrderRow.customer_id: string`)
- Test: `backend/tests/unit/test_order_board_compute.py`, `backend/tests/unit/test_order_board_sync.py` (or wherever `read_finished` is tested; grep)

**Interfaces:**
- Produces: sort key `(o.get("reference_number") != "Comptoir", date, number)`; finished row field `"customer_id": header.get("customer_id") or ""`.

- [ ] **Step 1: Failing tests:**
  - `test_counter_order_takes_stock_before_older_orders`: stock 1 of item A; order SO-1 (older, 1×A) and SO-2 (today, `reference_number: "Comptoir"`, 1×A) → SO-2 line `ready`, SO-1 line `to_order`.
  - `test_finished_rows_carry_customer_id`.
- [ ] **Step 2:** run both files → FAIL.
- [ ] **Step 3:** Implement the sort key and the field (update the docstring "in allocation sequence" note: counter orders first).
- [ ] **Step 4:** run → PASS; also run the whole `test_order_board_compute.py` (other expectations may depend on order).
- [ ] **Step 5:** Commit `feat(orders): counter orders take shelf stock first`.

### Task 4: API client + `useNewOrderDraft`

**Files:**
- Modify: `frontend/src/api/client.ts` (near `searchOrderItems`)
- Create: `frontend/src/hooks/useNewOrderDraft.ts`
- Test: `frontend/src/__tests__/hooks/useNewOrderDraft.test.ts`

**Interfaces:**
- Produces:
  - `export interface CounterOrderLine { item_id: string; quantity: number; discount?: string }`
  - `api.createCounterOrder(body: { customer_id: string; client_ref: string; lines: CounterOrderLine[] }): Promise<OrderEditResult & { salesorder_id: string }>`
  - `export interface NewOrderDraftLine { item: OrderItemHit; quantity: number; discount: string }` (discount `''` = none)
  - `export interface NewOrderDraft { lines: NewOrderDraftLine[]; client: { id: string; name: string; isDefault: boolean } | null; clientRef: string }`
  - `export function useNewOrderDraft(): { draft: NewOrderDraft; setDraft: (d: NewOrderDraft) => void; reset: () => void }` — reads `orders.newOrderDraft.v1` once, normalises (drops malformed lines, mints `crypto.randomUUID()` when `clientRef` missing), writes debounced 400 ms, `reset()` clears storage and mints a new `clientRef`. Same try/catch and clear-epoch approach as `useNewProjectDraft.ts`.
  - `export function clearNewOrderDraft(): void`

- [ ] **Step 1: Failing tests:** `persists and restores lines, client and clientRef`; `restores nothing from junk storage` (`'{'`, `'[]'`, lines with no `item`); `reset clears storage and mints a new clientRef`; `storage that throws does not crash` (mock `localStorage.setItem` to throw).
- [ ] **Step 2:** `cd frontend && npx vitest run src/__tests__/hooks/useNewOrderDraft.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS.
- [ ] **Step 5:** Commit `feat(orders): persistent new-order draft`.

### Task 5: `OrderClientHistory`

**Files:**
- Create: `frontend/src/components/orders/OrderClientHistory.tsx`
- Test: `frontend/src/__tests__/components/orders/OrderClientHistory.test.tsx`

**Interfaces:**
- Consumes: board rows (`OrderBoardRow[]`, have `customer_id`, lines), finished rows (`FinishedOrderRow[]` with Task 3's `customer_id`), `api.getFinishedOrder`.
- Produces: `export function OrderClientHistory({ customerId, open, finished, currency }: { customerId: string; open: OrderBoardRow[]; finished: FinishedOrderRow[]; currency: string })` — renders nothing for `''`; lists that customer's orders newest first (number, date, total, paid state, open/finished), 5 shown then "Tout afficher"; clicking an order expands its lines (open rows: from the row; finished: `useQuery(['order-finished', id], () => api.getFinishedOrder(id))`, same key the finished panel uses — grep it).
  Visual pattern: Aito's `ClientHistory.tsx`.

- [ ] **Step 1: Failing tests:** `lists only this customer's orders, newest first`; `shows five then all`; `expands an open order's lines without a request`; `expands a finished order via getFinishedOrder`; `renders nothing without a customer`.
- [ ] **Step 2:** run the file → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat(orders): client order history`.

### Task 6: `NewOrderDraftRow` + page wiring (focus mode, open after create) + i18n

**Files:**
- Create: `frontend/src/components/orders/NewOrderDraftRow.tsx`
- Modify: `frontend/src/pages/OrderBoardPage.tsx`
- Modify: `frontend/src/i18n/locales/*.ts` (16 files)
- Test: `frontend/src/__tests__/components/orders/NewOrderDraftRow.test.tsx`, `frontend/src/__tests__/pages/OrderBoardPage*.test.tsx` (extend the existing page test; grep its name)

**Interfaces:**
- Consumes: Task 4 (`useNewOrderDraft`, `api.createCounterOrder`), Task 5, `OrderItemSearch` (`orderItemIds`, `currency`, `disabled`, `onAdd`), `OrderQtyStepper` (`checkbox={false}`, `positive`), `ClientCombobox`, `NewContactForm`, `HoldButton`, `api.getZohoStatus`.
- Produces: `export function NewOrderDraftRow({ hiddenCount, currency, open, finished, onCreated, onClose }: { hiddenCount: number; currency: string; open: OrderBoardRow[]; finished: FinishedOrderRow[]; onCreated: (result: OrderEditResult & { salesorder_id: string }) => void; onClose: () => void })`.

Behaviour:
- Header: "Nouvelle commande" + Draft pill + "Abandonner" (`onClose`, keeps the persisted draft — abandoning hides it; reset is the hold button). Strip under it: `orders.newOrder.hidden` with `{{count}}` plural keys.
- Table columns: Produit (name, SKU), Qté (stepper), PU (rate), Remise (text input, `%` or amount, invalid → red border + `aria-invalid`, blocks Create), Total (q×rate − discount), Dispo (`stock_on_hand`), État (`n à commander` in yellow when q > stock, else "Prête"), remove ✕. Adding an existing item bumps its quantity.
- Right column (sticky): live TTC total, client picker seeded with the client de passage when `draft.client` is null, `NewContactForm` toggle, `OrderClientHistory` when client is not default, reset `HoldButton` + **Créer la commande** (`aria-disabled` while no lines / invalid discount / pending; click on disabled reveals why, like Aito).
- Create: `api.createCounterOrder({customer_id, client_ref, lines})`; on success → `clearNewOrderDraft()` then `onCreated(result)`; on error → toast with the server code (`orderErrors.ts` mapping; add `bad_discount`, `create_failed`), draft kept.
- Page: "Nouvelle commande" button (needs `orders:update`); while the draft row is shown: filters, stats strip and other rows hidden; `onCreated` → `queryClient.setQueryData(['order-board'], result.board)`, close draft, `setSearchParams({ order: result.salesorder_id })`.
- i18n `orders.newOrder.*`: `button`, `title`, `draft`, `abandon`, `hidden_one`, `hidden_other`, `search`, `discount`, `discountInvalid`, `toOrder` (`{{n}} à commander`), `ready`, `total`, `create`, `creating`, `reset`, `holdToReset`, `historyTitle`, `showAll`, `empty` — French copy from the mockup; real translations in all 16 locales.

- [ ] **Step 1: Failing tests (`NewOrderDraftRow.test.tsx`):** `starts on the client de passage`; `adding the same item twice bumps quantity`; `discount 10% and 5 change the line total; 120% blocks create`; `shows "2 à commander" when quantity exceeds stock but still creates`; `create sends customer, client_ref and lines then clears the draft`; `keeps the draft when create fails` (reject `ApiError('create_failed')` → draft still in storage, toast shown); `reset needs a hold and clears lines`.
- [ ] **Step 2: Failing page tests:** `new order hides other rows and filters`; `after create the new order is open (?order=9) and the list is back`.
- [ ] **Step 3:** run both files → FAIL.
- [ ] **Step 4:** Implement component, page wiring, i18n.
- [ ] **Step 5:** run both files → PASS; then `./test_frontend.sh` (typecheck, lint, knip, vitest, i18n parity) → read the `FAILED:` summary line, must be clean.
- [ ] **Step 6:** Commit `feat(orders): new counter order on the board`.

### Task 7: Full suites + build

- [ ] **Step 1:** `./test_backend.sh` → green (rerun a lone failing file alone before debugging: xdist load).
- [ ] **Step 2:** `cd frontend && npm run build` → green (Safari 16 baseline). Do not commit `static/` unless the user asks.
- [ ] **Step 3:** Browser check on the dev server with Zoho calls stubbed or a sandbox DB (never a live create from the DEV DB without the user's go): new order → focus mode → create → opened → terminal button present.
