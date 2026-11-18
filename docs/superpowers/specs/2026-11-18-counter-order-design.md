# Counter order: create an order from the Order Board

Date: 2026-11-18. Status: approved (stock option A chosen by the user).
Mockups: `.superpowers/brainstorm/63071-1795003004/content/new-order-focus-v3.html` (variant D, chosen).

## Why

A walk-in customer picks products in the shop. Today the operator has to create the sales order in Zoho Books,
wait for the board to sync, find the order and open it before taking payment. The goal is to do it all from
`/orders`: build the order, create it, see it opened, take the payment at the Heimdall terminal, then use the
invoice and hand-over actions the order panel already has.

## Goals

- **Nouvelle commande** on the Order Board opens a draft in place (variant D): the filters and the other orders
  hide while the draft is open, with a strip saying how many are hidden and a way back.
- The draft looks like the opened order panel: the same line table as "Modifier la commande" (item search with
  barcode scan, quantity stepper, unit price, line total, stock, state), plus a **discount per line**. The TTC
  total updates live.
- Right-hand column: client (search, **Nouveau client**, starts on the **client de passage**), the client's
  **order history**, the totals and **Créer la commande**.
- The draft is **persistent** in the browser (survives leaving the page or a reload) and has the same
  hold-to-reset button as Aito's New project drawer.
- **Create** writes the sales order to Books, confirms it, stores it on the board and returns it. The list comes
  back with that order opened (`?order=<id>`), so the operator does not have to look for it.
- **Pay** is the existing terminal button of the opened order. The amount is already editable there (pre-filled
  with what is left to pay), which covers cash + card: charge part, the rest stays "left to pay".

## Non-goals

- No new payment code. A fresh order without a quote is already payable on the sales order itself
  (`_target` → kind `salesorder`; Heimdall books a retainer referencing the order number).
- No new invoice or hand-over flow: the opened order's existing actions (invoice, print/email, pack, hand over)
  are used as they are.
- No discount editing on existing orders (only in the new-order draft).
- No price override, order-level discount, auto-email receipt, "re-buy" button, or "Comptoir" tag on the row.

## Anti-goals

- A draft must never reach Books before **Créer**. Abandon/reset sends nothing.
- A double click on **Créer** must not create two orders in Books.
- The board must not show the new order in a half-known state (e.g. without its lines) after Create.

## Constraints (found in the code)

- The board skips Books orders in `draft` or `void` status (`order_board.py:_SKIPPED_STATUSES`,
  `order_board_sync/_common.py`). Create must therefore mark the new order **open** (confirmed) in Books.
- `refresh_order()` (`order_board_sync/_recompute.py`) only re-reads an order already stored; it raises
  `OrderNotStored` otherwise. Create must insert the `OrderBoardDoc` (kind `salesorder`, header built from the
  Books response) before refreshing it, then `recompute`, commit and broadcast like other writes do.
- Books writes go through the order-board writer guards (`writing()`, `sync.zoho_busy()`, 429 back-off window,
  `_log` for history events). Create follows the same pattern as `edit_lines`.
- Line discount: Books SO lines carry `discount` (percentage `"10%"` or amount); the board already reads it
  (`order_board.py`, `line_edit._SO_LINE_FIELDS`). Quantities may be fractional (rope by the metre).
- Tax and location (read from the 88 stored orders, 2026-11-18): 86 are `is_inclusive_tax: true`,
  `discount_type: item_level`, `is_discount_before_tax: true`; all share one `location_id`. A counter order is
  created the same way: tax-inclusive prices (TTC, as on the shelf), item-level discounts, the org's single
  location (Books default).
- The client de passage always resolves: `get_default_contact()` falls back to built-in constants when the
  setting is empty, so the button needs no gate on it.
- Client search/creation exists at `/zoho/contacts` (GET/POST), gated by `AITO_CREATE`. Operators and
  Administrators hold both that and `orders:update`, so it is reused as is.
- The client de passage comes from `zoho_service.get_default_contact()` (settings `zoho_default_contact_id`/
  `_name`), exposed on `/zoho/status` as `default_contact_id` / `default_contact_name`.
- Aito draft persistence: `hooks/useNewProjectDraft.ts` (localStorage key, versioned) and the reset `HoldButton`
  in `NewProjectDrawer.tsx` (RotateCcw icon, 500 ms hold, perimeter progress, `aito.resetDraft` label).
- New Aito-style i18n keys need real translations in all 16 locale files (`pl` included).

## Approaches considered

1. **New create endpoint; payment reuses the existing terminal flow** — chosen. One new Books write path;
   everything after Create is code that already exists and is already tested.
2. One "create and pay" endpoint — fewer clicks, but two Books writes plus the terminal in one request make a
   halfway failure hard to explain, and it blocks "create now, pay later".
3. Create in Books and let the next sync pass pick it up — almost no code, but the order appears seconds to
   minutes later, which defeats "it opens right away".

## The design

### Backend

`POST /api/v1/order-board/orders` (permission `orders:update`), body:

```json
{ "customer_id": "…", "lines": [ { "item_id": "…", "quantity": 2, "discount": "10%" } ], "client_ref": "uuid" }
```

- Validates: at least one line; quantities finite, > 0, 3 decimals max (same rule as `edit_lines`); items exist
  in Books and are goods, not services (same check as `edit_lines`); discount is a percentage 0–100 or an amount
  ≥ 0 and ≤ the line total.
- `client_ref` is a UUID minted by the draft. A second request with the same `client_ref` returns the order
  created by the first one instead of creating another (kept in memory or a small stored marker; builder's call).
- Creates the SO in Books (new `zoho_service.create_salesorder`), with the item's own rate and tax (Books
  defaults), today's date, then marks it open (`POST /salesorders/{id}/status/open`, new helper). If the confirm
  step fails, the draft SO is voided (or deleted) in Books so nothing half-made remains, and the error is shown.
- Stores the `OrderBoardDoc`, refreshes it from Books, recomputes, commits and broadcasts; records an
  `order.created` history event with the operator's name.
- Returns `{ "board": …, "row": …, "salesorder_id": "…" }` like the other write routes.
- Registration: Order Board route tests/permission sweeps updated for the new route.

### Frontend

- `OrderBoardPage`: a **Nouvelle commande** button. While a draft is open, the filters and other rows are hidden
  (strip: "N autres commandes masquées pendant la création" + Abandon), the draft row is shown full width.
- Draft row (new component, built from the existing pieces): header "Nouvelle commande" + Draft pill + Abandon;
  line table reusing `OrderItemSearch`, `OrderQtyStepper`, the stock/state cells and the barcode scan; discount
  cell per line (% or amount); a live TTC total (prices are tax-inclusive). The HT/TVA split is Books' and shows
  on the created order, not in the draft.
- Right column: client picker (Aito's `ClientCombobox` + `NewContactForm`), seeded with the client de passage;
  client history (below); totals; reset `HoldButton` + **Créer la commande** (Aito's layout and behaviour).
- Persistence: `useNewOrderDraft` mirrors the draft (lines, discounts, client, `client_ref`) into localStorage on
  every change, versioned key like Aito's. Reset clears it. A successful Create clears it.
- After Create: the board query is updated from the response, the draft closes, and `?order=<id>` opens the new
  order. The opened order shows its usual payment block (terminal, payment link) and actions.

### Client history

- Shown in the right column once a real client (not the client de passage) is picked, like Aito's
  `ClientHistory`.
- Lists the client's orders from the board's stored sales-order headers (`customer_id` is on every stored
  header, finished orders included): number, date, total, paid/unpaid, status. Newest first, a handful shown,
  "show all" for the rest.
- Expanding an order shows what was bought (product, quantity, price), read from the stored detail when present,
  else from the existing finished-order detail endpoint.
- No new route: the page already holds the open board rows (with `customer_id`) and the finished list; the
  finished rows gain a `customer_id` field (from the stored header) and the history filters both on the client.

### Stock priority (user decision 2026-11-18: option A)

- The board hands out stock oldest order first (`compute_board` sorts by date, number). A counter order
  (`reference_number == "Comptoir"`) goes **first** in that sort, so it is covered by shelf stock and can be
  packed and handed over with the existing actions. An older order relying on the same unit drops to
  backorder / to order, which matches the shelf.
- Selling above the board's stock is allowed: the draft line shows a warning ("n à commander") but Create is not
  blocked (the customer holds the item).

## Left to the builder

- Exact component split and file names; whether the draft table shares code with the edit mode table.
- Where the `client_ref` dedupe lives (memory vs stored marker), as long as a double click cannot create two.
- Void vs delete for a failed confirm.
- How many history orders are shown before "show all".

## Calls I made (not discussed with the user)

- No "Comptoir" tag on the order row (dropped from the mockup to keep it small).
- Discount only in the new-order draft, not in "Modifier la commande".
- Client search keeps its Aito permission.
- Rate and tax come from the Books item; the operator only sets quantity and discount.
- Discount: per line, either a percentage (`"10%"`) or an amount off the whole line, both taken off the TTC line
  total (orders are tax-inclusive), sent as Books' line `discount`; `discount_type: item_level`.
- The order carries `reference_number: "Comptoir"` in Books so counter sales can be found in Books reports
  (not shown as a tag on the board).
