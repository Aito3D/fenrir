# Order Board: edit an order's lines, edit a packed parcel

Date: 2026-11-07. Status: mockup approved by the user ("ok parfait"); design awaiting their read.
Mockup (French UI, fake data): `docs/superpowers/specs/2026-11-07-order-edit-demo/index.html`.
Hash for a given state: `#SO-00441,<state>` (states: `edit`, `edited`, `packed`, `pkg`, `pkgsaved`).
Builds on the Order Board designs of 2026-11-05 and 2026-11-06 (board, payment view, picklist / parcel /
hand-over / invoice). Vocabulary from those: "À préparer" = the green group of units left to prepare,
"Emballé" = the blue group of units in a parcel that is not handed over yet, "picklist" = the Books
prélèvement that precedes a parcel, "the pass" = the sync loop that re-reads orders from Books.

## Why

A customer changes their mind at the counter: one more spool, drop the AMS, take the 0.6 nozzle instead.
Today the operator has to open Books, edit the sales order there, come back and wait for the pass. Same
when a parcel was packed wrong: an item is missing from the carton, or one too many went in. Both
corrections happen several times a week; both should be done on the opened order in Fenrir, with Books
updated and re-read, like the picklist, parcel and hand-over already are.

## Goals

1. On an order with units left to prepare, **edit the order**: change a line's quantity, remove a line,
   add a Books item as a new line. Save writes the sales order to Books and re-reads it.
2. On a parcel that is not handed over yet, **edit the parcel**: lower or raise a line's units, take a
   line out, bring in a line from "À préparer" that the shelf covers, or empty it (which deletes it). Save
   writes the picklist and the package to Books and re-reads the order.
3. The operator sees the money consequence of an order edit before saving: new total, what is paid, what
   is left to pay, or the credit that would be left over — as an estimate, only when Fenrir can reproduce
   Books' arithmetic (see "Money shown before the save").

## Non-goals

- No edit of prices, discounts, taxes, notes, dates, customer, addresses, delivery method, reference, or
  service lines: only the quantity of physical lines and the set of physical lines. Prices of a new line
  are Books' item rate.
- No edit of a handed-over or shipped parcel, a shipment, an invoice, or a picklist on its own.
- No change to Shopify. A Shopify order edited here diverges from the shop's record; the operator is told.
- No stock adjustment, no serial numbers, no units beyond what the shelf covers for a parcel.
- No undo. The operator makes a second edit.
- The Aito board, its quotes and invoices are untouched.

## Anti-goals

- **Never a quantity below what already left, is already picked or is already billed.** The floor of a
  line is max(`quantity_packed`, `quantity_picked`, `quantity_invoiced`) (Books' figures are cumulative:
  packed includes shipped, picked includes packed, as `order_board.py` already reads them); a line with a
  floor above zero cannot be removed. Fenrir enforces it before writing and
  Books' own refusal, if any, reaches the operator as it is.
- **Never a parcel and its picklist that disagree in Books.** Both are written, picklist first; a failure
  between the two leaves a state the pass shows and the operator can finish by saving again.
- **Never a duplicate line or parcel** from a double click, a retry or two operators (same lock and
  same busy check as the existing writers).
- **Never an edit on a stale copy.** Both saves start from a fresh read of the order (and of the package)
  and refuse if what the operator saw no longer matches.

## What the operator sees (decided by the user on the mockup)

### Edit the order

- A **"Modifier"** button in the "À préparer" band, left of "Préparer" (or of the picklist's buttons).
  While a picklist of the order is open the button is replaced by a lock marker "Prélèvement PL-… ouvert"
  with a tooltip saying to create its parcel or cancel it first.
- In edit mode the band is outlined; the "Qté" column reads **"Commandé"**; the "État" column is replaced
  by a trash button per line. Each physical line of the group shows a **stepper on the ordered quantity**
  (−, number field, +, no maximum), with a "min n" caption when the floor is above zero. A line at its floor
  cannot go lower; a line with a floor above zero has its trash disabled (tooltip: already packed, shipped
  or invoiced). A removed line stays in place, struck through, with a "Rétablir" link.
- A dashed **"Ajouter un article · nom ou SKU dans Zoho Books"** search field under the lines. From two
  characters it lists up to five Books items (name, SKU, stock on hand, rate) that are not already on the
  order or already added; a click, or Enter on the first hit, adds the item as a **new line** at
  quantity 1, highlighted "Nouvelle ligne · price", with its own stepper (minimum 1) and trash.
- An **edit bar** under the group: the list of changes in words ("PLA : 6 → 8 · retire AMS Lite · ajoute
  Buse 0,4 × 1"), the new total with the old one beside it when it changed, a sentence saying the whole
  order is saved to Books then re-read, a yellow note on a Shopify order ("la boutique n'est pas mise à
  jour"), a yellow note when the customer already paid more than the new total ("… de trop : reste en
  avoir"). Buttons "Annuler" and "Enregistrer" (disabled until there is a change; spinner while saving).
- The **Paiement card** follows the edit live: the bar and "Reste à payer" use the new total; when paid
  exceeds it the caption reads "Avoir restant n". The row's own total and pill change only after the save.
  When the estimate is not possible (below), the bar shows no total, the card does not move, and the
  sentence reads "Total recalculé par Zoho Books à l'enregistrement".
- Escape cancels, as for the other bars. A refetch that removes the order's "À préparer" group closes the
  edit.
- After the save: toast "Commande SO-… mise à jour dans Zoho Books · n modifications · total …"; the row
  flashes; the lines, total and payment show the re-read order.

### Edit the parcel

- A **"Modifier"** button in the "Emballé" band beside each "Remettre le colis" (suffixed with the parcel
  number when several wait). Only parcels not handed over have one.
- In edit mode the column reads **"Dans le colis"**. The parcel's lines show a **stepper from 0 to
  (units in this parcel + what the shelf still covers for the line)**, with a green "+n" or yellow "−n"
  tag next to it when changed; at 0 the state reads "Retiré du colis". Lines of another waiting parcel are
  dimmed and untouched, with "n dans un autre colis" under the name. Under them, each "À préparer" line the
  shelf covers appears as a **dashed "Ajouter au colis" row** at 0 with a stepper up to what the shelf
  covers; above 0 it turns solid and reads "Ajouté au colis".
- A **parcel bar**: "PKG-… : n unités (était m) · +a depuis le stock · −r de retour dans À préparer", a
  sentence saying the picklist PL-… is set to the same quantities then the package, in Books; at 0 units the
  sentence says the parcel and its picklist are deleted and the button turns red **"Supprimer le colis"**.
  Buttons "Annuler" and "Enregistrer le colis" (disabled until something changed).
- After the save: toast "Colis PKG-… mis à jour dans Zoho Books · n unités · +a · −r de retour dans
  À préparer" (or "… supprimé …"); the blue group flashes; the groups show the re-read order.

### Both

- Only one bar at a time on an order (edit, parcel edit, pick, pack, hand-over): opening one while another
  is open is refused silently, as today for the row icon.
- `orders:update` is required for both, like every other write of the board.

## Facts about Books this design relies on

Already probed read-only on 2026-11-05/06 (see the earlier designs):

- The SO detail carries the lines with `line_item_id`, `item_id`, `quantity`, `quantity_packed`,
  `quantity_shipped`, `quantity_invoiced`, `quantity_picked`, `product_type`, `rate`, `is_invoiced`; its
  `packages[]` (number, status, date) but **not** which line is in which package; its `picklists[]`.
- `GET /packages/{id}` returns `line_items[]` with `so_line_item_id`, `quantity`, `picklist_item_id`,
  `is_invoiced`.
- `GET /items?search_text=` is served and used (`zoho_service.list_items`); `/items?item_ids=` returns
  `stock_on_hand`, `brand`, `track_inventory`.
- `PUT /picklists/{id}` replaces the rows; rows left out are removed (used by "Créer le colis").

Not verified, from Zoho's API reference (Books and Inventory share `/books/v3` for these):

- `PUT /salesorders/{id}` takes the full `line_items[]`: a row with `line_item_id` updates that line, a row
  without one is a new line (`item_id`, `quantity`, `rate`), a line left out is deleted. The customer,
  date, discount and other header fields are not required when left out (if they are, send them back from
  the stored detail).
- Books refuses to lower a line under `quantity_shipped` / `quantity_invoiced`; it may also refuse under
  `quantity_packed`. Fenrir never asks for it.
- `PUT /packages/{id}` takes `date` and the full `line_items[]` (`so_line_item_id`, `quantity`, and
  `picklist_item_id` for a line that comes from a picklist); a line left out is removed.
- `PUT /picklists/{id}` on a **completed** picklist is accepted. If it is not: see "Fallback" below.
- `DELETE /packages/{id}` and `DELETE /picklists/{id}` remove them (a package with a shipment first needs
  the shipment deleted; an edited parcel never has one).

## Behaviour

### Money shown before the save

Same rule as the hand-over preview of the 2026-11-06 design: Fenrir never invents an amount. The estimate
new total = Σ quantity × `rate` over the physical and service lines is shown only when the order is
tax-inclusive, no line carries a discount, and the header has no discount, shipping charge or adjustment
(`_ORDER_MONEY`). Otherwise no figure is shown before the save. For this, each board line gains `rate`
and a boolean `estimable` on the row (computed server-side from the stored detail); the frontend does the
multiplication. The credit note ("de trop : reste en avoir") and the live Paiement card exist only when
`estimable` is true.

### Edit the order (`PUT /order-board/orders/{id}/lines`)

Request: `{ version, lines: [{ line_id, quantity } | { item_id, quantity }] }` — every physical line the
order should have after the edit, existing ones by their Books line id, new ones by item id. A line
omitted is removed. `version` is the stored copy's `last_modified_time` the client was showing.

1. Take the order's write lock and the busy check, like the other writers. Refuse (409) if a picklist of
   the order is open in Fenrir's stored copy. A completed picklist with picked-but-unboxed units does not
   lock the edit: its units are in the floor instead (the "min n" tooltip names the picklist).
2. Re-read the order from Books (the stored copy may be older than the operator's screen). Refuse (409,
   "the order changed, look again") if its `last_modified_time` differs from `version`.
3. Validate against the fresh detail: every `line_id` exists and is a physical line; every quantity ≥ its
   floor max(`quantity_packed`, `quantity_picked`, `quantity_invoiced`) (the row carries this `floor` per
   line, computed server-side, so the client shows the same figure); no existing physical line with a
   floor above zero is omitted; no `item_id` is already a line or repeated; every new `item_id` is a Books
   item (one `/items?item_ids=` call) that is not a service. Quantities are floats, > 0, at most three
   decimals (rope by the metre).
4. Build the body: the fresh detail's `line_items` in order, service lines and untouched lines sent back
   as they are (`line_item_id`, `item_id`, `quantity`, `rate`, `discount`, `tax_id`, `description`, `unit`,
   the fields `_LINE_FIELDS` already lists for invoices), edited lines with the new quantity, new lines as
   `{ item_id, quantity, rate }` with the item's rate, omitted lines left out. Send with `note_write`
   before and after, step `lines`.
5. On a Zoho error: best-effort refresh, raise (the operator sees Books' reason). On success:
   best-effort refresh, return the recomputed row.

The frontend keeps the edit state (`qty` per line id, `gone` set, `added` list, search text) in the panel,
like `OrderCheck`; the Paiement card takes an optional `total` override for the live figures. The item
search calls `GET /order-board/items?q=` (new, read-only, `orders:read`), which returns
`{ id, name, sku, rate, stock_on_hand, product_type }` for up to five matches, excluding nothing (the
client filters what is already on the order). Debounced 250 ms, two characters minimum.

### Edit the parcel (`PUT /order-board/orders/{id}/packages/{package_id}`)

Request: `{ version, was: [{ line_id, quantity }], lines: [{ line_id, quantity }] }` — `version` is the
order's stored `last_modified_time`, `was` the parcel's lines as the editor showed them, `lines` every
line the parcel should hold after the edit, at its new quantity; a line omitted or at 0 leaves the parcel.
An empty list deletes the parcel.

Opening the editor calls `GET /order-board/orders/{id}/packages/{package_id}` (new): Fenrir reads the
package from Books and returns its lines (`line_id`, `quantity`, `picklist_item_id`) and, per line of the
order, the ceiling `quantity in this parcel + packable units the shelf still covers`, the same `packable`
figure the picklist preview uses minus units on an open picklist. Lines at ceiling 0 are not offered.

1. Lock, busy check, re-read the order and the package. Refuse (409, "look again") if the fresh package's
   lines differ from `was` or the order's `last_modified_time` from `version`. Refuse if the package is
   shipped, or holds a line of another order (a shared package is never edited), or its picklist is open
   (then "Créer le colis" is the way).
2. Validate: every `line_id` is a physical line of the order; each quantity within 0 and the ceiling
   recomputed from the fresh detail; at least one line changed.
3. Writes, each with `note_write`, each skipped when Books already shows its result (so a retry finishes
   the job). Books never sees a package row above its picklist row, so the order depends on direction:
   - **step A, picklist up:** if any line rises, `PUT /picklists/{picklist_id}` with every row at
     max(old, new) quantity (`line_item_id` = `picklist_item_id` for a line already on it; a line new to
     the parcel is added with `salesorder_id`, `so_line_item_id`, both quantities). A row's quantity keeps
     the units another parcel boxed from the same picklist (`_to_box` already knows them).
   - **step B, package:** `PUT /packages/{id}` with `date` kept and the new `line_items`
     (`so_line_item_id`, `quantity`, `picklist_item_id` from the fresh picklist for new lines), rows at 0
     left out.
   - **step C, picklist down:** if any line fell, `PUT /picklists/{picklist_id}` with every row at its new
     quantity (plus the other parcel's units), rows at 0 left out.
   - **empty:** `DELETE /packages/{id}` then `DELETE /picklists/{id}` (the picklist only when no other
     parcel boxed from it; otherwise step C).
   The picklist is the one all of the parcel's lines point to (`picklist_item_id`); a parcel whose lines
   point to two picklists or to none is refused (`picklist_shared`, same reason as today). A failure after
   step A or B leaves picklist ≥ package in Books: the pass shows it and the same request repeated skips
   what is done.
4. Best-effort refresh, return the recomputed row.

**Fallback if Books refuses `PUT` on a completed picklist** (found in the first live run, not before):
replace instead of edit, in this order, each step skipped when already done: `DELETE /packages/{id}`,
`PUT` or `DELETE` the picklist while no package holds it (if the PUT is still refused: `DELETE` it and
`POST` a new one with the new rows), `POST /packages` with the new rows, exactly as "Créer le colis" does.
Same screen, same request, same result; one more Books call. The builder keeps the two write sequences in
one function behind a flag so the switch is a one-line change after the live run.

### What the pass needs

Nothing new: both saves end with the existing best-effort refresh, and the pass already drops a copy
fetched before a write. The board's `packable`, `picked`, `packed_waiting` and `remaining` come from the
re-read detail.

## Interfaces (names are the builder's; the shape is decided)

- Backend routes in `order_board.py`: `GET /items`, `PUT /orders/{id}/lines`,
  `GET /orders/{id}/packages/{package_id}`, `PUT /orders/{id}/packages/{package_id}`. The permission test
  (`test_order_board_permissions.py`) classifies them (two read, two write).
- `zoho.py`: `update_salesorder(db, id, body)`, `update_package(db, id, body)`, `delete_package(db, id)`,
  `delete_picklist(db, id)`, and `list_items_by_ids` as it is.
- `order_board_actions.py`: `edit_lines(db, id, version, lines)`, `package_content(db, id, package_id)`,
  `edit_parcel(db, id, package_id, lines)`; `_wanted` / `_within` reused for the quantity checks.
- `client.ts`: `searchOrderItems(q)`, `updateOrderLines(id, body)`, `getOrderPackage(id, packageId)`,
  `updateOrderPackage(id, packageId, body)`; `OrderPanelRow` gains `version` (the stored copy's
  `last_modified_time`) and `estimable`; `OrderBoardLine` gains `rate` and `floor`.
- Frontend: `OrderLinesPanel` grows two states beside `check`; the edit bar and parcel bar are two new
  components next to `OrderPackBar`; the stepper is `OrderQtyStepper` with an optional `min` and an optional
  unbounded `max`; the item search is one component with its own query. i18n keys under `orders.edit.*` and
  `orders.parcelEdit.*` in all 16 locales.

## Left to the builder

- Exact Tailwind for the outlined band, the struck-through line, the dashed add rows (the mockup is the
  reference; the React side already has the tones in `orderStatus.ts`).
- How the item search avoids a request storm (debounce, abort the previous query).
- Whether `version` compares `last_modified_time` or a hash of the lines; both satisfy the anti-goal.
- Test fixtures: a stored detail with a shipped+packed line, a service line, two waiting parcels.

## Calls I made (to check while reading)

1. Editing the order is locked while a picklist is open, rather than cutting the picklist on the fly.
2. Prices, discounts and service lines are out of scope; a new line takes the item's Books rate.
3. A line whose floor is above zero cannot be removed, only lowered to its floor.
4. Adding to a parcel is capped by what the shelf covers, the same rule as "Préparer".
5. Both saves re-read the order first and refuse on a changed `last_modified_time` (order edit) or a changed
   package (parcel edit) instead of merging.
6. Picklist first, then package, for a parcel edit; an emptied parcel deletes both.
7. Shopify orders get a warning, not a refusal.
8. Overpayment after an edit stays as customer credit in Books; Fenrir only names it.
9. The item search is a new read route on the board (not a reuse of the Aito quote item routes, whose
   permission is `aito:*`).
10. One bar at a time on an order, no stacking of edit mode on top of a pick or hand-over.

Settled after the builder check (a reviewer read the document as the person who would build it):

11. The pre-save total is an estimate shown only for tax-inclusive orders without any discount, shipping
    charge or adjustment, the hand-over preview's rule; otherwise no figure until Books answers.
12. The floor uses Books' cumulative figures: max(packed, picked, invoiced). A line picked on a completed
    picklist and never boxed cannot go under its picked units (clean the picklist in Books first); the
    alternative, locking the whole edit on such picklists, would block more orders in this shop.
13. Parcel edit writes in direction order: picklist up, package, picklist down; an emptied parcel deletes
    the package then the picklist. The replace sequence stays the fallback behind a flag.
14. The parcel edit carries the lines the operator saw and the order's version; a changed package or
    order refuses the save instead of merging.

## First live run (needs the user)

Added to the watched first live run already owed for the board's writes, on one real order:

- order edit: raise a line, remove a line, add an item; Books shows the three changes, `quantity_*`
  figures untouched, total recomputed by Books; a Shopify order's shop record unchanged.
- parcel edit: lower a line, add a line from the shelf; Books shows the picklist and the package at the
  same quantities (check whether `PUT` on the completed picklist was accepted; if not, flip the fallback
  flag); the freed units show in "À préparer" after the pass.
- empty a parcel: both documents gone in Books; the units back in "À préparer".

## Risks

- `PUT /salesorders` may require header fields Fenrir does not send back; found in the live run, fixed by
  sending more of the stored detail.
- The completed-picklist `PUT` (fallback above).
- A Books edit of a Shopify-imported order might be refused by Books itself (the integration may lock
  them); then the feature is Books-only for direct orders and the Shopify note becomes a refusal.
