# Order Board: payment, contact and finished orders — design

Date: 2026-11-05. Status: description approved by the user in chat 2026-11-05; document handed
over the same day and answered "ok". One assumption stands unanswered, see "Assumption: Shopify
payments".

Companion files:

- `2026-11-05-order-board-design.md` — the Order Board this extends. Its rules (read-only towards
  Zoho, bounded sync passes, "an empty or half-built board never looks like a verified answer")
  all still apply.
- `2026-11-05-order-payment-demo/index.html` — the clickable mockup the user reviewed. Open it
  with `#c,side,on` for the chosen variant. Fake data. Its English labels and simplified lines
  table are stand-ins; the real page keeps its own lines table and components. Variants A and B
  and the "Above the lines" layout in the mockup were rejected.

"Theirs" marks what the user decided. "My call" marks what I chose and the user has not
explicitly confirmed.

## Intent

The operator opens the Order Board to decide what ships today. Two questions follow at once and
today need a trip to Zoho Books: has this order been paid, and how do I reach the customer. A
third comes up less often: what happened with an order that has already gone.

## Goals

1. Each order row shows whether the order is unpaid, partly paid or paid, with a percentage and
   a progress fill when partly paid (theirs).
2. The opened order shows a payment block and a contact block with phone and email (theirs).
3. Finished orders can be listed, searched and opened (theirs: "if operator have to check older
   order").

## Non-goals

- Writing anything to Zoho. Theirs, for later: generating a payment link or starting a card
  terminal payment from an order. Not in this build.
- Linking a payment to a specific order. Theirs, for later: they plan to tie payments to orders,
  possibly through a retainer invoice linked to the quote. See "Advance payments".
- A delivery address or destination. Books never has one on these orders (0 of 31 open orders).
- Which payment settled which invoice. The sales-order document lists payments and invoices but
  not the link between them, so the payment mode shown per invoice in the mockup is dropped.
- New sort keys, new settings, API-key access.

## Anti-goals

- A prepaid order must not read "Unpaid". This is the trap in the data: see "Advance payments".
- The Finished view must not eat the Zoho call budget the Aito Kanban shares.
- Contact details are personal data: never logged, served only under `orders:read`.

## What Zoho gives (read from a local copy of 206 real sales orders, 31 with detail)

Everything below is already inside the sales-order detail the sync stores. No new endpoint is
needed for open orders.

| Field (detail) | Use | Filled on open orders |
|---|---|---|
| `invoices[]`: `invoice_id`, `invoice_number`, `date`, `due_date`, `total`, `balance`, `status` | paid, due, overdue | 6 of 31 have an invoice |
| `contact.unused_customer_credits` | advance payments | above 0 on 20 of 31 |
| `contact_person_details[0]`: `first_name`, `last_name`, `email`, `phone`, `mobile` | contact block | email 28, phone 21, mobile 6 |
| `billing_address.phone` | fallback phone | 11 |
| `customer_id` | grouping a customer's orders | all |
| `sales_channel_formatted`, `reference_number` | reference chip: Shopify order number, or quote number (`DEV…`) on direct sales | 29 have a reference |
| `marketplace_so_id`, `account_identifier` | Shopify order id and store handle, for the Shopify link | 13 of 13 Shopify orders |
| `estimate_id` | link to the quote in Books | 12 of 18 direct orders |
| `delivery_method` | facts chip ("PICK UP") | 12 |
| `payment_terms_label` | facts chip; `-` means none | 14 |

List rows (headers, stored for every sales order) carry `paid_status` (`paid`, `partially_paid`,
`unpaid`), `total`, `customer_name`, `date`, `reference_number`, but no paid amount. Header
`balance` is always 0 and is not used.

Two facts that shape the design:

- **Books' `paid_status` on a sales order only mirrors invoicing.** Every invoice on today's open
  orders is paid, and `partially_paid` always comes with `partially_invoiced`. The amounts are
  computed from the invoices instead.
- **Customers pay before the invoice exists.** Of the 25 open orders Books calls unpaid, 20 belong
  to a customer holding unused credit, typically the exact order total or a 50 to 70% deposit.
  Theirs, confirmed: payments are stored on the customer account and are not linked to an order.
  The invoice is raised at shipping and the credit is applied then.

## Payment per order

Computed in `compute_board` (pure, no I/O), for every board row. Money is in the order's
currency; the org is single-currency (XPF), so customer credit is taken to be in the same one.

With `total` the order total, `today` the server's calendar day. Invoices whose `status` is
`void` or `draft` are ignored throughout (my call: a void invoice has balance 0 and would read
as paid; a draft is not yet a demand for payment). Every invoice in today's sample is `paid`.

- `invoice_paid = min(total, Σ over invoices of (total − balance))`
- `overdue = Σ balance` of invoices with `balance > 0` and `due_date < today`
- `due = Σ balance` of the other invoices with `balance > 0`
- `advance` = this order's share of the customer's unused credit (next section)
- `paid = invoice_paid + advance`
- `left = max(0, total − paid)`
- `rest = max(0, total − paid − due − overdue)` — still to pay and not invoiced yet
- `pct = floor(100 × paid / total)`, so 100 only ever means fully paid
- `state`: `paid` when `paid ≥ total`, else `partial` when `paid > 0`, else `unpaid`
- `next_due`: earliest `due_date` among invoices with a balance, or none

An order whose total is missing or 0 has no payment (`payment: null`); the row shows a dash.

### Advance payments (theirs: "count advance payments, for the moment")

Books keeps credit per customer, so it has to be shared out. My call, shown in the mockup notes
and not objected to:

1. Group board rows by `customer_id`. The customer's credit is `contact.unused_customer_credits`
   from the most recently fetched detail among that customer's open orders (builder: stamp the
   fetch time on the stored document).
2. Walk the customer's rows in board sequence (oldest order first, the stock rule). Each takes
   `advance = min(credit left, max(0, total − invoice_paid − due − overdue))`.

Credit covers only what is not invoiced yet: an open invoice stays "awaiting payment" until
Books applies the credit to it. Orders left off the board (age limit, draft, void) and finished
orders take none.

Which credit figure: `contact.unused_customer_credits` is taken as the customer's whole unspent
credit, quote deposits (retainers) included. Evidence, not proof: on quote-linked open orders
the figure is 50%, 70%, 71%, 90% or 100% of the order total, which is what a deposit looks
like, and on one order a payment's `unused_amount` equals it exactly. The builder confirms on
one customer with a paid retainer; if retainers turn out to be excluded, fall back to
`aito_customer_credit.unused_credit_total` over `GET /customerpayments?customer_id=` (one call
per customer with an open order, only when the payments poll names that customer).

Worked case: a customer has credit 381 100 and two open orders, 339 500 (older) and 59 422.
The older one is paid in full by advance; the newer one gets 41 600 and reads "70% paid".

Keep this in one function. When the user links payments to orders (retainer invoice on the
quote), that function is what gets replaced; nothing else should know how `advance` is found.

### Keeping the credit fresh

A payment recorded on the customer does not touch the sales order, so the stored detail would
keep an old credit figure. Each sync pass therefore makes one extra call,
`zoho_service.list_customer_payments_modified_since` (it exists, the Kanban's change poll uses
it; watermark helpers in `aito_poll_watermark`), and marks every candidate sales order of the
customers it returns as pending. The normal detail fetch then brings the new credit. The
watermark lives in the board's state row, in Books' timestamp spelling (`aito_poll_watermark`
has the parsing; its storage helpers write settings and do not fit, so the builder stores the
value itself). It is set to the moment a pass starts, as soon as what the poll decided (the pending marks) is
committed, so a pass that fails later does not mark the same orders again. The first
pass that finds no watermark makes no poll call and instead marks every candidate pending once:
details stored before this feature carry a credit figure as old as their last fetch. That is
about 31 detail calls spread over two passes by the existing bounds. A truncated result does
the same.

`paid_status` and `invoiced_status` join the list-row fields whose change marks an open order
pending (`_SO_FIELDS`), so an invoice being paid refreshes the order even if Books does not
move `last_modified_time`. The existing per-pass bounds
(`MAX_DETAILS_PER_PASS`, `CALL_CEILING`) are unchanged.

Known limit: a credit note changes the credit without a payment; the figure then waits for the
order's next change.

## Row payload

Each board row gains:

- `customer_id`
- `payment`: `state`, `pct`, `paid`, `invoice_paid`, `advance`, `due`, `overdue`, `rest`, `left`,
  `next_due`, and `invoices[]` (`number`, `date`, `due_date`, `total`, `balance`, `url`). `url`
  comes from `zoho_service.books_invoice_url`, added where `zoho_url` is added today.
- `contact`: `name`, `email`, `phone`, `mobile`, or null when the order has no contact person.
  `phone` falls back to `billing_address.phone` when the person has neither phone nor mobile
  (my call).
- `facts`: `channel`, `reference`, `delivery_method`, `payment_terms` (each may be empty), plus
  `shopify_url` and `quote_url` (null when the ids are missing):
  - `shopify_url` = `https://admin.shopify.com/store/{account_identifier}/orders/{marketplace_so_id}`.
    Not opened by me: the builder checks it on one real Shopify order before relying on it.
  - `quote_url` = `zoho_service.books_app_url(db, estimate_id)`.

Books' own text is shown as given for channel, delivery method and terms; it is not translated.

## Page

### Row (theirs: variant C, pills all the same width)

A payment pill sits between the status pill and the total, in a fixed-width column (9.5rem in
the mockup; the app's root rem is 14.4px, so measure). Icon and label are left-aligned so icons
line up down the column.

| State | Label | Look |
|---|---|---|
| unpaid | Unpaid | grey, dashed-circle icon |
| partial | "40% paid" | neutral pill, green fill from the left as wide as `pct` |
| paid | Paid | green, check icon |
| any, with `overdue > 0` | label + "· overdue" | red text, alert icon |

Below `lg`, where the row already stacks, the pill takes its own line under the progress bar
(my call).

### Opened order (theirs: beside the lines)

From `lg` up the panel is two columns: the existing lines table on the left, a 27rem column on
the right holding the contact block, then the payment block. The right column is sticky so it
stays in view while a long order scrolls (theirs; the longest real order has 26 lines). The
card must use `overflow-clip`, not `overflow-hidden`, or sticky does nothing; the builder
measures the top offset against the app shell. Below `lg` the order is contact, payment, lines
(my call).

Chips sit above the lines table. Theirs: the reference is shown for both kinds of order and is
clickable, opening the order in Zoho or in Shopify. Shape (my call):

- "Zoho Books · SO-00418" opens the sales order in Books. It replaces the "Open in Zoho Books"
  link at the bottom of today's panel.
- A Shopify order adds "Shopify · #1042", opening the order in the Shopify admin. A direct sale
  with a quote adds "Quote · DEV26-2655", opening the quote in Books. A reference with no id
  behind it is shown as plain text.
- Then the plain facts: delivery method, payment terms. Empty ones are left out.

All links open in a new tab.

Contact block (theirs: phone and email; copy buttons kept):

- Contact person's name, then mobile, phone, email, each a `tel:` or `mailto:` link with a copy
  button. The mail link carries the order number as subject.
- A missing phone or email says so ("No phone in Zoho") instead of disappearing. No contact
  person at all says that.
- "Also open for this customer: SO-…" lists the customer's other board rows (theirs). The link
  opens that order and scrolls to it, clearing whatever filter would hide it.

Payment block:

- Header: the pill, and "Left to pay {amount}" or "Nothing left to pay" (theirs).
- A bar in up to four segments: paid on invoice (green), paid in advance (hatched green),
  invoiced and awaiting payment (yellow), overdue (red). The empty track is `rest`.
- A legend with the amount of each non-zero part. When there is an advance, one line explains
  it: the customer's unused credit in Zoho, waiting for the next invoice.
- The invoices: number (link to Books), date, state ("Paid", "Due 11 Nov", "Overdue 9 d", with
  the amount left when part-paid), total. "No invoice yet for this order" when there are none.

The bar's segments need a text alternative; the legend is it.

### Filters

- Payment chips after the status chips: Any payment, Unpaid, Partially paid, Paid. An Overdue
  chip appears only while at least one order is overdue (my call: the user kept the red overdue
  state but did not answer on a filter, and overdue is rare in their data).
- Counts follow the same rule as the status chips (brand toggle + search). The list applies
  brand, search, status and payment.
- Search also matches the reference.
- The "In progress" tile's hint becomes "{total value} · {n}% paid" over the same orders the
  tile counts (my call, shown in the mockup).

## Finished orders

Definition (my call): a sales order that is not draft or void and has nothing left to ship,
that is `quantity_shipped ≥ quantity > 0` on its list row, or it has stored detail and produces
no board row. Fully shipped orders older than the age limit are included: this is an archive.
Unshipped orders hidden by the age limit stay hidden.

Page (theirs: "a way to show finished orders"; shape is my call, shown in the mockup):

- A "Finished" chip after the status chips, set apart by a divider. Selecting it swaps the list
  for finished orders, newest first, 50 at a time behind "Show older orders".
- A finished row shows number, customer, date, a full grey bar "Shipped n/n", a "Shipped" pill,
  the payment pill and the total. No age chip.
- Search applies. From the open list, when the query also matches finished orders, a line under
  the list says "{n} finished orders match … · Show" and switches the view.
- Payment chips apply. The "3D only" toggle and the tiles do not: tiles keep counting open
  orders, and a finished row has no brand without its detail.
- Opening a finished order shows the same panel. The first time, it loads from Zoho behind a
  short loading state.

Data:

- The list comes from the stored list rows, one local read, no Zoho call. Until an order's
  detail is stored, its pill shows Books' `paid_status` as Paid, Partially paid or Unpaid with
  no percentage. Once stored, the payment is computed as above, with `advance` always 0.
- `GET /order-board/finished` returns every finished row at once (120 today, about 100 more a
  year); search, payment filter and paging are done in the browser. Shortcut: revisit with
  server paging when the list reaches a few thousand rows.
- `GET /order-board/finished/{salesorder_id}` returns the full row. It fetches the detail from
  Books when none is stored or the stored one is stale, and stores it. Stale means the list
  row's `last_modified_time`, `paid_status` or `invoiced_status` differs from the detail's
  (checked on real data: the list row and the detail carry the same `last_modified_time`
  string, 31 of 31), or the payments poll has named this order's customer since the fetch. A
  stale finished order is not fetched by the sync; its row falls back to Books' paid flag until
  someone opens it again. It sends nothing during a 429 back-off or above the call ceiling and
  answers 503 with a "try again shortly" message instead. Both routes need `orders:read`.
- The sync stops discarding the detail of a sales order that becomes finished (today it sets
  `detail = None` for every non-candidate). Finished orders are never marked pending, so the
  sync never fetches for them. The stock re-read and the board computation must then read
  candidates only, not "every sales order with detail".

## Left to the builder

- Where the fetch time is stamped, the exact response models, React Query keys and stale times.
- The copy-button feedback (reuse the app's existing copy pattern) and the scroll-to behaviour.
- All new strings in every locale file, real translations, with the parity gate green.
- Tests: the payment maths as a table of cases (no invoice, part-paid invoice, overdue, advance
  capped by credit, two orders sharing credit oldest first, order ignored by age takes none,
  total 0); the payments poll marking orders pending; finished detail kept, fetched once, served
  from the copy, refused during back-off; the two new routes' permissions; the page's filter and
  hint logic in `orderBoard.ts`. Zoho is stubbed throughout.
- CLAUDE.md's registration checklist for whatever the change touches.

## Assumption: Shopify payments

Asked, not answered: how a Shopify payment reaches Books. Of 10 open Shopify orders with no
invoice, 3 have customer credit equal to the order total and 7 have none. The build assumes the
7 are pay-later orders (transfer, pay at pick-up), so "Unpaid" is right for them. If they were
paid at checkout, the payment maths needs another signal for Shopify orders; it lives in one
function, so that is a contained change. The user checks this on the first real board.

## Risks

- Credit is customer-wide. A deposit paid for a print job on the Kanban is credit on the same
  customer, so it can make that customer's unrelated goods order read "paid in advance". Theirs,
  accepted "for the moment" until payments are linked to orders.

- Advance is an estimate whenever a customer has several open orders (4 customers today). The
  block says "paid in advance" and explains the source, so it is not read as an invoice payment.
- The server's calendar day decides "overdue" and age, as on the board today.

## As built (2026-11-05, branch `order-payment`)

Differences from the text above, each found while building or on the first render in a browser:

- **The row pill never shows "· overdue".** The fixed 9.5rem pill cannot fit "40 % payé · en retard"
  (French needs about 150 px, 137 are available; German and Russian need more). An overdue row
  reads as a red alert icon, with a red outline on a partly paid pill and red text on an unpaid
  one; the full wording is in the pill's tooltip and accessible name. The pill inside the payment
  block keeps the visible suffix. A partly paid pill's label is white on a translucent green fill.
- **The side column is not sticky; the lines scroll in their own pane.** The app shell's `<main>`
  is `overflow-auto` and never scrolls (the document does), so `position: sticky` had nothing to
  stick to. From `lg` up the lines table sits in a pane of at most 70vh with a pinned header, and
  contact and payment sit beside it. Below `lg` the page scrolls as before.
- **A finished row has no "Shipped n/n" caption.** The finished list row carries no quantities.
  The bar is full and neutral and the pill says "Shipped".
- **"Stored detail and no board row" counts as finished only once a board has been computed.**
  Before the first compute every candidate with a detail would otherwise look finished.
- **Opening a finished order while a sync pass writes the same row** keeps the pass's stale mark:
  the fetch notices the row changed while its Zoho call was in flight and stores its result as
  stale, so the next open fetches again.
- **Status codes of the on-demand route:** 503 for the back-off window, the call ceiling, a 429
  from the fetch itself, and Zoho not connected; 502 for any other Zoho error; 404 for an order
  that is unknown or not finished.
- **The Finished chip shows its count only once the finished list has loaded** (it loads in the
  Finished view or when a search is typed).
- **Copy buttons use the app's shared clipboard helper**, which also works over plain HTTP.

Not verified, because this build made no Zoho call at all (the page was rendered in a browser
from a local copy of earlier Zoho data with stubbed requests):

- the Shopify admin link on a real order;
- that `unused_customer_credits` includes quote deposits (the fallback in "Advance payments" is
  not built);
- a finished order fetched from Zoho for real, and the one-off refetch of every open order on the
  first pass after the update;
- the "Assumption: Shopify payments" above.

Known limits left as they are:

- Russian, Ukrainian and Polish need plural forms this app does not ship (`_few`, `_many`); the
  existing `orders.units` key already shows as a raw key for some counts, and the new
  `orders.finished.match` key shares that.
- The status pill's column is still `auto`, so progress bars shift by up to 30 px between rows.
- Smaller points are listed in the build ledger's deferred-minor lines and were triaged by the
  final review.
