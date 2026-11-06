# Order Board: prep sheet, create the parcel, hand it over, invoice

Date: 2026-11-06. Status: approved by the user and built (see "As built" at the end). No write has been tried against live Books yet.
Mockup (approved, French UI, fake data): `docs/superpowers/specs/2026-11-06-order-package-demo/index.html`.
Hash for a given state: `#,,,SO-00433,ship` (states: `printed`, `confirm`, `slip`, `packed`, `ship`, `shipped`).
Builds on the Order Board (`2026-11-05-order-board-design.md`) and its payment view (`2026-11-05-order-payment-design.md`).

## Why

Today the Order Board only reads Zoho Books. To pack an order the operator leaves Fenrir, creates the
package in Books, creates the shipment, marks it delivered, then converts the order to an invoice. That is
four screens in Books for something that happens many times a day, 99% of the time as a pick-up at the shop.

The operator should do it from the opened order: print a sheet, pack, confirm the parcel, hand it over.
Books stays the system of record; Fenrir writes to it and then re-reads the order.

## Goals

1. From an order that has units in stock, print a **prep sheet** (PDF) listing what to pack.
2. After packing, **create the parcel** in Books with the quantities the operator confirms.
3. For a packed parcel, **hand it over**: Books gets the shipment, and for a pick-up it is marked delivered.
4. The hand-over **creates the invoice** for what left the shop and has no invoice yet, and applies the
   customer's credit to it.
5. The order shows its **invoices as a card**: number, amount, status, and download / print / open in Books.

## Non-goals

- No email to the customer, for the parcel or the invoice.
- No carrier, no tracking number (0 of the 50 newest shipments in Books has one).
- No editing or deleting a parcel, shipment or invoice from Fenrir, and no undo. Corrections happen in Books.
- No payment collection (payment link or TPE): the user wants it later, separately.
- No pick lists, no stock adjustment, no serial numbers.
- The Aito board and its invoices are untouched.

## Anti-goals

- **Never a duplicate** parcel, shipment or invoice from a double click, a retry or two operators.
- **Never an invoice whose amounts Fenrir computed itself.** Discounts, taxes (all sampled orders are
  tax-inclusive) and charges come from Books' own prefill.
- A failure half-way must leave a state the operator can see and finish, not a silent gap.
- No Zoho call in tests. No contact details or credentials in logs.

## What the operator sees (decided by the user on the mockup)

### Row of the list

One extra small icon button before the chevron, showing the next step:
- printer, when the order has at least one unit ready to pack: prints the prep sheet;
- hand, when nothing is left to pack and a parcel waits: opens the order with the hand-over bar open;
- nothing otherwise.

Once a sheet was printed the row shows "En préparation" next to the date, and the printer icon gets a small tick.

The row is a `<button>` today; the icon must be a sibling of it, not a child.

### "À préparer" band (opened order)

Right side of the band, only when at least one unit is ready:
- **"Bon de préparation"** (printer). After a print it reads "Réimprimer", preceded by "Imprimé à 14:02 par Paul".
- **"Créer le colis"**. Outlined before a print, solid green after. It never requires a print.

"Créer le colis" turns the group into a check:
- each line with packable units gets a stepper in the quantity column, prefilled with that figure, range 0 to it;
- lines with nothing ready are dimmed and cannot be packed;
- a bar under the group: "Colis de N unités sur M en stock · daté du … · numéro attribué par Zoho", a note
  "K unités restent à préparer" when N < M, then "Annuler" and "Créer le colis" (disabled at 0, spinner while sending).

On success the packed units move to "Emballé, en attente de livraison" under a new parcel chip, with a toast
"Colis PKG-… créé dans Zoho Books · N unités". The printed marker is cleared.

### "Emballé, en attente de livraison" band

One **"Remettre le colis"** button per waiting parcel (the parcel number is appended when there are several).
It opens a bar under the group:
- line 1: parcel number, units, today's date, and a two-way switch **"Retrait en boutique"** (default) /
  **"Livraison"**. Pick-up says "Le colis passe à « livré » dans Zoho".
- line 2: what the hand-over will invoice. Either "Crée la facture de ce colis : 14 400 FCFP" with a ticked
  box "Appliquer l'avoir du client (10 400 FCFP)" and the outcome ("Reste dû 4 000 FCFP" or "Facture soldée"),
  or "Déjà facturé (FAC-…) : aucune nouvelle facture".
- "Annuler" and the confirm button: "Remis au client" (pick-up) or "Marquer expédié" (delivery).

On success the lines move to "Expédié", the parcel chip reads "remis le …" or "expédié le …", the new invoice
flashes in the Factures card, toast "Colis PKG-… remis au client · facture FAC-… créée".
When everything is shipped the order leaves the open list at the next sync and is found under "Terminées".

### "Factures" card (side column, under Payment)

One entry per invoice of the order, same shape as a document row of the Aito billing card:
number and amount on the first line; date, status ("Payée" / "Reste à payer X" / overdue as today) and three
icon buttons on the second: download the PDF, print it, open it in Books.
Empty state: "Aucune facture pour l'instant. Elle est créée à la remise du colis."
When shipped units have no invoice (see "Failure handling"), the card shows "N unités remises sans facture"
with a **"Créer la facture"** button.

The invoice list leaves the Payment card (it would show twice). The Payment card keeps the bar, the legend
and "Reste à payer". The card also appears on finished orders.

### Permissions

- Printing the sheet and the invoice PDFs: `orders:read`.
- Creating a parcel, handing over, creating an invoice: `orders:update`. Without it those buttons are not shown.

## Facts about this shop's Books (probed read-only on 2026-11-06, field names only)

- The stored token has scope `ZohoBooks.fullaccess.all`.
- The Books API (`/books/v3`) serves `/packages`, `/packages/{id}` and `/shipmentorders`, although only the
  Zoho Inventory API documents them (`POST /packages?salesorder_id=`, `POST /shipmentorders?salesorder_id=&package_ids=`,
  `POST /shipmentorders/{id}/status/delivered`).
- A package detail lists `line_items` with `so_line_item_id`, `quantity`, `is_invoiced`. The sales-order
  detail does not say which line is in which package.
- Package numbers are `PKG-00000`; shipment numbers are bare integers. Both look auto-generated.
- Delivery method is `PICK UP` on 48 of 50 shipments and `Aito3D` (the shop's own delivery) on 2. 49 of 50
  are `delivered`.
- `delivery_method` is free text on the order; `PICK UP` and `Aito3D` both already exist in this Books.
- `GET /invoices/editpage/fromsalesorder?salesorder_id=` returns the invoice Books would create from the
  order: `invoice.line_items[]` carry `salesorder_item_id`, the quantities are what is left to invoice, and it
  answers "nothing to invoice" for a fully invoiced order. `GET /invoices/fromsalesorder` answers 405.
- An invoice raised from an order has `salesorder_id` at the top and `salesorder_item_id` on its lines.
- Six sampled open orders with a waiting parcel: all tax-inclusive with a tax per line, none with an order
  discount, shipping charge, adjustment, line discount or service line; two already had invoiced lines.

**Not verified (no write was made):** the exact bodies Books accepts for `POST /packages`,
`POST /shipmentorders`, the delivered call, and `POST /invoices` with `salesorder_item_id`; that numbers are
auto-assigned when omitted; that a shipment which is shipped but not delivered already raises the order
lines' `quantity_shipped` (the invoice step and the "Expédié" group rely on it); that a draft invoice counts
in `quantity_invoiced`.
The first live run (see "First live run") settles these.

## Behaviour

### What "ready to pack" means (one definition, used everywhere)

Per line, **packable** = the units the board counts as covered for this order, minus the units already in a
waiting parcel: `covered − packed_waiting` in `order_board.py` terms, never below 0, and 0 for service
lines, shipped lines and cancelled lines. It is a new figure on each row line.

- A partly covered line is packable for its covered part.
- Units invoiced but not shipped count as covered today (they are physically in the shop), so they are packable.
- The row icon, the band buttons, the stepper maximum, the sheet quantities and the server-side check all
  use this figure. A unit already in a parcel can therefore not be packed twice.

### Prep sheet

- A4 PDF made by the backend with reportlab (already a dependency; `label_renderer.py` has the QR helper).
  French wording, fixed: the shop's documents are French and the PDF is not translated. *(my call)*
- Content, as on the mockup's sheet B: shop name; "BON DE PRÉPARATION"; order number; print date and time;
  customer; contact name and phone; order date; reference (Shopify number or quote number); delivery
  ("Retrait en boutique" when the order's delivery method is `PICK UP`, else the method, else blank);
  payment ("Payée" or "Reste à payer X", from the board's payment figures); a QR code;
  one row per line with units ready: tick box, quantity to pack, name, SKU, quantity ordered; totals
  "N articles · M unités"; a dashed box "Pas en stock, reste à livrer" listing the short quantities;
  four boxes "Préparé par", "Contrôlé par", "Nombre de colis", "Poids".
- Quantities are the packable figures above, so the sheet matches the screen.
- QR code: `{external_url}/orders?order={salesorder_id}`, using the `external_url` setting the Aito tracking
  links use. No QR when the setting is empty. The Orders page learns to open and scroll to `?order=`, for an
  order in the open list only; otherwise the page opens as usual. A scan while logged out goes through the
  login page. *(my call)*
- Shop name on the sheet: "AITO3D" is what the mockup shows. Use the organisation name Books returns if it
  is already at hand, else a constant. *(builder's choice)*
- Requesting the sheet stamps the order: who and when. One request does both (it returns the PDF), so a
  print cannot be recorded without a sheet. The stamp is local to Fenrir, survives a re-sync of the order,
  and is cleared when a parcel is created for the order.
- In the browser the click fetches the PDF and opens the print dialog, with the existing
  `usePrintBlob` / `PdfPrintButton` machinery from `components/aito` (fallback: download).

### Create the parcel

- Request: order id and a list of `{line id, quantity}`.
- Checks before any Zoho call: at least one quantity above 0; every line belongs to the order; each quantity
  is at most that line's packable quantity on the current board. A refusal is a 4xx with a reason the UI can show.
- One Books write: a package for that order, dated today (server's local date, as the board's ages),
  `line_items` = `{so_line_item_id, quantity}`. No package number is sent.
- Then the order is re-read from Books, stored, and the board recomputed, so the answer carries the fresh row.
- Stock is not checked against Books at that moment: the operator has the goods in hand. Books is the judge
  and its refusal is shown as is.

### Hand-over preview

Opening the bar asks the backend what the hand-over would do (one read of the package in Books):
units in the parcel, the amount that would be invoiced, the credit that would be applied, or the numbers of
the invoices that already cover it. The amount comes from Books' prefill restricted to the parcel's units
(below), not from Fenrir's arithmetic. If Books cannot answer, the bar still opens, without the amount, and
says so.

### Hand over the parcel

Request: order id, package id, mode (`pickup` or `delivery`), `apply_credit` (bool). Steps, in order:

1. **Shipment.** Create the shipment for that package, dated today. Delivery method: `PICK UP` for a pick-up;
   for a delivery, the order's own delivery method when it has one that is not `PICK UP`, else `Aito3D`.
   No shipment number, no tracking number.
2. **Delivered.** Pick-up only: mark the shipment delivered.
3. **Re-read the order.**
4. **Invoice.** For each order line: units to invoice = units shipped − units invoiced, when positive,
   read from Books' raw `quantity_shipped` and `quantity_invoiced` (the row's `invoiced` figure is clamped
   and cannot be used). A service line (never in a parcel) that is not invoiced yet is added in full, so it
   rides on the first invoice. If there is nothing, skip to 6. Otherwise ask Books for its prefill of an invoice from this order, keep only those
   lines with those quantities (never more than the prefill offers), and create the invoice from it, dated
   today, linked to the order through `salesorder_item_id`. Order-level money (discount, shipping charge,
   adjustment) is taken from the prefill as Books gives it. Then mark the invoice **sent**
   (`POST /invoices/{id}/status/sent`, documented for Books). No email.
   **Exception:** when the order carries an order-level discount, shipping charge or adjustment AND this
   invoice would not cover everything the prefill offers, Fenrir creates no invoice. Splitting those amounts
   would be Fenrir's arithmetic. The step reports "à facturer dans Zoho" and the card links to the order. *(my call)*
5. **Credit.** When `apply_credit` is set and the customer has unused payments: apply them to the new
   invoice, oldest payment first, up to the smaller of the invoice balance and the advance the board
   attributes to this order (so an older order's share is not consumed), and the unused amounts that exist.
   Nothing to apply is not an error: the invoice simply stays due. Uses the existing
   `list_customer_payments` and `apply_invoice_credits`. Applying credit cannot be undone from Fenrir.
6. **Re-read the order**, store it, recompute the board, answer with the fresh row and a per-step outcome.

Both modes create the invoice. A delivery stops at "shipped": it is not marked delivered.

One invoice is created per hand-over, so an order delivered in several parcels gets several invoices.
Units invoiced before shipping (orders paid and invoiced up front) are simply not invoiced again.

### Failure handling

- **Busy or rate-limited Books** before step 1: nothing is done, the UI says to retry in a moment (the
  board's existing busy rule: call ceiling per minute and the rate-limit pause).
- **A step fails**: stop, re-read the order if possible, answer with what was done and the failing step's
  message. The toast names it ("Colis remis. La facture n'a pas pu être créée : …").
- **Every step is skipped when its result already exists**: package already shipped → no new shipment;
  already delivered → no delivered call; nothing shipped-but-uninvoiced → no invoice. So repeating the same
  request finishes the job instead of duplicating it.
- **"Créer la facture"** on the Factures card runs steps 3 to 6 alone. It is shown whenever the board sees
  shipped units without an invoice, which also covers parcels shipped in Books by hand.
- **One writer per order**: a second write request for an order while one runs is refused (409), in this
  server process. Writers do not take the sync's pass lock (a pass can run for minutes).
- **A sync pass must never replace an order's stored detail with a copy it fetched before a write finished.**
  The stored detail already carries `_fetched_at`; the pass has to check, at the moment it stores, that
  nothing newer than the start of its own fetch is there, and drop its copy if so. `read_finished_order`
  shows the same concern from the other side (snapshot, refresh, mark stale). The mechanism is the builder's.
- **A draft left behind**: if the invoice is created but "mark sent" fails, the draft exists in Books. The
  Factures card lists drafts too, labelled "Brouillon", with the Books link; the payment figures keep
  ignoring drafts as today. No second invoice is offered, since Books already counts those units as invoiced.
- An unverified Books answer (timeout after the request left): treat as failed, re-read, and let the
  skip-if-done rule decide on retry.

### Sync and budget

Create a parcel: 1 write + 1 read. Preview: up to 2 reads. Hand-over: up to 4 writes + 5 reads.
Well under the board's 30 calls a minute. Each write logs the user id, order number and step, never
contact details.

## Interfaces (names are the builder's; the shape is decided)

Backend, under `/api/v1/order-board`:
- prep sheet: returns `application/pdf`, stamps the print (`orders:read`);
- create parcel (`orders:update`);
- hand-over preview (`orders:read`);
- hand-over (`orders:update`);
- create invoice for shipped units (`orders:update`);
- invoice PDF by invoice id, only for an invoice that belongs to a stored order (`orders:read`).

Row additions: each package gains its Books id; each line gains `packable`; the row gains the print stamp
(`at`, `by`), the number of units shipped without an invoice (from the raw quantities) and its draft invoices. Line ids are already on the row (`line_item_id`).

Zoho service: new methods for create package, get package, create shipment, mark delivered, invoice prefill
from an order, mark invoice sent. `create_invoice`, `get_invoice_pdf`, `list_customer_payments`,
`apply_invoice_credits` exist.

Storage: the print stamp needs a home on `order_board_docs` that a detail refresh does not erase (a new
nullable column; new columns go through `run_migrations` and must be dialect-aware, see the PostgreSQL
upgrade check).

Frontend: `OrderCard` (row icon), `OrderLinesPanel` (band actions, stepper, both bars), new invoices card
(replacing the list inside `OrderPaymentBlock`), `FinishedOrderCard` gets the card for free through the
panel, `client.ts` types and calls, `?order=` on the page, 16 locale files (use `{{n}}`, not `{{count}}`).

## Left to the builder

File and function names, the stamp's column shape, how the per-order lock is held, the exact reportlab
layout (the mockup's sheet is the reference), test structure, whether the preview is cached for the click
that follows it.

## Calls I made (to check while reading)

1. The sheet is French only and made by the backend.
2. A QR code to the order, and the `?order=` deep link it needs.
3. The second delivery mode is the shop's own delivery ("Livraison", method `Aito3D`), not a carrier with
   tracking as first drawn in the mockup: Books shows no carrier and no tracking number in use.
4. The invoice is built from Books' prefill, restricted to shipped-but-uninvoiced units.
5. Credit applied is capped at this order's share of the customer's credit.
6. "Créer la facture" also appears for parcels shipped in Books by hand.
7. Dates are the server's local date.
8. "Packable" as defined above, including the covered part of a partly covered line.
9. No automatic invoice for a partial hand-over of an order with an order-level discount, charge or adjustment.
10. Service lines ride on the first invoice Fenrir creates for the order.
11. A draft invoice shows in the card as "Brouillon"; nothing else is done about it.

## First live run (needs the user)

The write bodies are unverified until one real order goes through. Before relying on it:
one order, watched: print, create a parcel, hand over as pick-up, check in Books the package, the shipment
(delivered, `PICK UP`), the invoice (linked to the order, sent, right total, right tax), and the credit applied.
Then one delivery ("Livraison") to confirm that a shipped, undelivered parcel counts as shipped on the order.
If Books refuses a body, the message will say which field; that fix is expected work, not a surprise.

## Risks

- These are the board's first writes, and they create accounting documents in the real Books account.
- The package, shipment and prefill endpoints are not in the Books API documentation; Zoho can change them.
- An invoice created "sent" cannot be made a draft again from Fenrir; a wrong one is voided in Books.
- Two server processes would defeat the per-order lock (the shop runs one).
- The refactor campaign on the order board is still open and touches the same files.

## As built (2026-11-06)

Built on branch `order-package`, eight tasks, each reviewed, then a whole-branch review. What differs from the text above:

- **Print stamp storage:** a row of kind `prep` in `order_board_docs` (no new column, no migration).
- **Service lines:** only lines Books marks `product_type = "service"` ride on the first invoice. A physical item that is
  not stock-tracked is shown under "other lines" by the board, cannot be packed from Fenrir, and is not invoiced by
  Fenrir: it is packed, shipped and invoiced in Books. (Replaces call 10.)
- **Draft invoice:** when the order already has a draft invoice and units are waiting for an invoice, Fenrir creates no
  new invoice and says so ("a draft invoice … is waiting in Zoho: send it there first"). (Stricter than call 11.)
- **No automatic invoice** also when a line carries a fixed-amount discount and is invoiced only in part.
- **Outcome reasons:** the answer of a hand-over carries `manual_reason` (`order_money`, `line_discount`, `draft`) and
  error codes `credit_off_board` (invoice created after the order left the board: the credit was not applied) and
  `prefill_refused` (Books refused to prepare the invoice).
- **Refusal codes** of the write routes: `nothing_to_pack`, `unknown_line`, `too_many`, `bad_quantity`, `unknown_package`
  (400), another writer on the same order (409), Books busy (503), Books' own message (502).
- **Unconfirmed writes:** after a Books write the order is re-read; until a re-read succeeds (or while the stored copy is
  marked pending) the next action on that order re-reads it first. A sync pass drops a copy it fetched before a write.
- **After the last parcel** the order leaves the open list at once and appears under "Terminées" after the next sync pass.
- **Hand-over preview amount** is shown only for tax-inclusive orders without line discounts; otherwise the bar says the
  invoice will be created, without an amount. The invoice itself is always Books' own figures.
- **Prep sheet:** text outside Latin-1 is folded (macrons dropped, ʻokina as an apostrophe, other scripts as "?");
  labels are in mixed case, not capitals.
- **Phone:** the action buttons stay within the screen while the lines table scrolls sideways; the row icon sits beside
  the payment pill.
- **Not built:** nothing from the non-goals. The invoice card's empty text on a finished order still says the invoice is
  created at hand-over.

Verified: backend suite 26,191 passed (2 unrelated failures: a known afternoon date test and a timing test that passes
alone); 1,137 Zoho and order tests on the final code; frontend suite 10,806 passed (3 unrelated files failed under load
and pass alone); lint, type checks, unused-code check, translation parity, build. Screens checked in a headless browser
with offline data at desktop, 900 px and phone width.

**Still owed (needs the user):** the first live run. Check in Books, on one order: the package; the shipment
(delivered, `PICK UP`); the invoice (linked to the order so `quantity_invoiced` rises, status sent, right total and tax);
which customer payment the credit took. Then one "Livraison": does a shipped, undelivered parcel raise
`quantity_shipped`? If not, its invoice is not created and nothing on the board says so.
