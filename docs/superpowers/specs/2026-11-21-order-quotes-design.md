# Product quotes on the Order Board

Date: 2026-11-21. Status: builder-checked and probed against Books, awaiting the user's approval.
Mockups (chosen variants A and X): `.superpowers/brainstorm/53795-1795255573/content/quotes-placement.html`
and `quote-open-accept.html`.

## Why

The shop has two activities. **Services** (a customer brings a part to remake: scan, modelling, fabrication,
pick-up) run on the Aito Kanban. **Products** (a machine ordered, filament bought in the shop) run on `/orders`.
Between the two sits the customer who asks for a price on products, by mail or at the counter, and does not buy
right away. In Zoho Books that is a quote (estimate): once confirmed it becomes a sales order, then an invoice.

Today `/orders` starts at the sales order. Product quotes are made in Zoho Books by hand. The goal is to cover
the step before the order on the same screen: create a quote, follow it, and turn it into the sales order when
the customer accepts, with no retyping.

The user's words on the interface: "fluide et intuitive, clean et moderne, sans confusion entre les devis et
les bons de commande". And on the split: "il est mieux de les séparer, car des devis il peut y en avoir
beaucoup". On acceptance: "je veux rester dans le même process".

## Goals

- `/orders` gets a top-level switch **Devis | Commandes** (variant A). Each side has its own list, its own
  "new" button and its own colour: quotes violet, orders the current teal. The count of quotes in progress
  shows on the Devis tab.
- **Devis tab**: search (customer, number, item) and three state chips: **En cours** (default: draft, sent,
  accepted-without-order), **Expirés**, **Refusés**.
- **Nouveau devis** opens the same in-place draft as the counter order (item search and scan, quantity,
  line discount, customer picker, persistent draft, hold-to-reset). The final button is **Créer le devis**.
  Nothing reaches Books before that click.
- **An opened quote** shows: editable lines with a stock dot per line ("14 dispo" / "à commander"), the
  customer block, the PDF (print, download, open in Zoho), the activity, and the actions **Envoyer par mail**,
  **Refusé**, **Accepté**.
- **A quote is always editable** while it is not converted (Books would accept the edit; the board refuses it). Editing an expired quote sets its date
  to today and a fresh expiry, so it returns to En cours.
- **Accepté** (variant X) marks the quote accepted in Books, creates the sales order from it, stores the
  order on the board, and switches to the Commandes tab with that order opened. From there everything is the
  existing order flow (pay, pack, "Facturer maintenant", hand over). The order keeps its link to the quote
  (the existing quote reference chip).
- Right after acceptance, a notice offers **Annuler**: it voids the order just created and puts the quote
  back in En cours.

## Non-goals

- **Aito is not touched.** No change to the Kanban, its quote sync, or its estimates.
- No quote → invoice shortcut. In-stock products go through the order and its existing "Facturer maintenant".
- No follow-up tooling: no reminders, no automatic expiry handling, no quote versions. Unanswered quotes
  simply wait (the user: "pour le moment on ne fait rien").
- A quote reserves no stock. The stock dot is information only.
- No new permission: `orders:read` sees quotes, `orders:update` writes them.
- No payment on a quote (deposit links stay on the order).

## Anti-goals

- A quote row must never be mistakable for an order row, and the reverse.
- A service quote owned by an Aito card must never appear in the Devis tab or be written from it.
- A double click on Accepté or Créer le devis must not create two documents in Books.
- An accepted quote must never be left with no order and no visible trace: if the order creation fails after
  the quote was marked accepted, the quote stays in En cours as "Accepté" with a **Créer la commande** button.
- Undo must only ever delete the order that this acceptance just created, and only while it has no payment,
  parcel or invoice. Otherwise Annuler is not offered.

## Constraints (found in the code)

- Storage: `order_board_docs` (`models/order_board_doc.py`) is already generic: `kind`, `zoho_id`, `header`,
  `detail`, `pending`. Quotes are stored there with a new kind. No new table.
- The sync pass (`services/order_board_sync/_pass.py`) is GET-only, bounded by `MAX_DETAILS_PER_PASS` and
  `CALL_CEILING` because Aito shares Zoho's per-minute budget. Quotes must live inside the same bounds.
  `zoho_service.list_estimates_modified_since` returns only id, customer id and modified time, so it cannot
  supply the header. The org holds about 3,000 estimates (16 list calls), too many to relist every pass
  against a ceiling of 30 shared with Aito.
- The board keys everything quote-related on the order's `estimate_id` (`order_board_payment.py`,
  `order_board_actions/documents.py`, `order_board_sync/_retainers.py`). Converting through Books keeps that
  link (verified, below).
- An estimate belongs to Aito when its id equals some `AitoProject.quote_id`. The Books org also holds
  sailing-gear documents; "3D only" is a per-viewer frontend toggle on a backend `is_core` flag, not a sync
  exclusion, and quotes get the same flag and toggle.
- `create.py` already tells service lines apart (`product_type` ending in `service`).
- Books estimate lifecycle is draft → sent → accepted/declined and is enforced: accepted/declined need the
  estimate out of draft first (`zoho.advance_estimate_status` handles it). There is no way back to draft;
  sent is reachable again from accepted and from declined (verified, below).
- Existing Zoho methods to reuse: `create_estimate`, `update_estimate_lines`, `update_estimate_fields`
  (expiry), `get_estimate`, `get_estimate_pdf`, `get_estimate_email_content`, `email_estimate` (Books marks
  the estimate sent itself), `advance_estimate_status`, `create_salesorder`, `mark_salesorder_open`,
  `void_salesorder`.
- Order writes follow one pattern (`services/order_board_actions/`: `writing()`, `sync.zoho_busy()`, 429
  back-off, `_log` history events, store the fresh detail, recompute, broadcast). Quote writes follow it too.
  `create.py` (counter order) is the model for "create in Books, insert the doc, return it opened".
- Counter orders are tax-inclusive, item-level discount before tax, single location. Quotes are created the
  same way so the converted order matches the board's assumptions.
- Frontend: the page is `pages/OrderBoardPage.tsx`, list at every width. The draft is
  `components/orders/NewOrderDraftRow.tsx` + `NewOrderLines.tsx`, one dialog at all widths, persisted in
  `localStorage` under `orders.newOrderDraft.v1` (`useNewOrderDraft.ts`). `OrderMobileView.tsx` is the phone
  layout of one opened card, not of the list.
- `line_edit.py` (order edit) only changes quantities and adds items. Quote lines also need the discount, so
  the opened quote edits with the draft's `NewOrderLines`, not the order's edit rows.
- `order_board_events.salesorder_id` is free text, so estimate ids fit with no schema change; new event kinds
  must be registered in `KINDS` or they are dropped. Quote events do not ring the notification bell.
- `create.py`'s `client_ref` dedupe and the `writing()` lock are the double-submit guard to reuse. Filters are mirrored in the URL by
  `useOrderFilters.ts`. 16 locales are gated for parity, and `{{count}}` keys are avoided on this page.

## Approaches

1. **Local copy of the quotes, like the orders (chosen).** The existing pass also keeps Books estimates in
   `order_board_docs`. The tab opens from a local read, search covers everything, the stock dot costs no call.
   Every action writes to Books then refreshes the stored copy. Books stays the reference.
2. **Read Books live on every open.** Less code, always fresh, but one to two seconds per open, search limited
   to Books' own, and it spends the call budget shared with Aito. Not fluid with many quotes.
3. **Quotes kept in Fenrir, pushed to Books only on acceptance.** Rejected: Books would lose unaccepted
   quotes, and PDF, numbering and email would have to be rebuilt. It contradicts "dans Zoho, tout passe par
   les devis".

The user approved approach 1.

## Design

### Data and sync

- New doc kind `estimate` in `order_board_docs`. Header = the Books list row; detail = the full estimate.
- Listing: one full listing to start (16 calls, spread over passes so no pass nears the ceiling), then each
  pass asks only for estimates modified since the last one (a full-row variant of the modified-since
  listing). A slow full sweep (for example nightly) catches deletions. Details are fetched when a row's
  `last_modified_time` changes, within the pass's existing limits; order details keep priority.
- Only rows that can show need a detail: draft, sent, accepted, expired, declined within the age limit.
  `invoiced` rows (1,868) are dropped at the listing, with no detail call.
- Left out: estimates whose id is an `AitoProject.quote_id`; estimates older than the board's existing
  `max_age_days` setting; `invoiced` estimates; accepted estimates whose detail shows an order
  (`salesorders` non-empty) or an invoice. No service-line exclusion: the user makes no service quotes by
  hand in Books.
- Derived state per quote, computed locally: `draft`, `sent`, `accepted` (no order yet), `expired` (Books
  status expired, or expiry date passed while draft/sent), `declined`.
- The stock dot per line uses the item stock the board already loads. A quote's items are added to the set of
  items whose stock the pass reads. Availability shown = stock on hand minus units the open orders reserve.
- One read endpoint returns the quote list (rows with customer, number, dates, state, total, line summary,
  search text). Detail comes with the row or on open, whichever matches how orders do it today.

### Actions (all `orders:update`, all through the order-board writer guards)

| Action | Books calls | After |
|---|---|---|
| Create quote | `create_estimate` (draft, tax-inclusive, item-level discounts) | insert doc, return it opened |
| Edit lines / customer | `update_estimate_lines`; if expired also `update_estimate_fields` (date = today, new expiry) | refresh stored copy |
| Send by mail | `get_estimate_email_content` then `email_estimate` (reuse the order document email modal) | Books marks it sent; refresh |
| Refuse | `advance_estimate_status(declined)` | moves to Refusés |
| Reopen (refused quote) | `set_estimate_status(sent)` | back in En cours |
| Accept | `advance_estimate_status(accepted)`, `GET /salesorders/editpage/fromestimate`, `POST /salesorders` with `estimate_id` and the prefill's lines, `mark_salesorder_open` | insert the order doc, drop the quote from En cours, return the order id |
| Undo accept | DELETE the sales order (a void keeps the quote converted), then `set_estimate_status(sent)` | drop the order doc, quote back in En cours |
| Create order (accepted quote with no order) | the second half of Accept | same as Accept |

Quotes accepted directly in Books without an order appear in En cours as "Accepté" with **Créer la commande**:
the same state the failure path of Accept produces, so there is one code path.

Every action logs a history event like order actions do, keyed by the estimate id, so the opened quote's
activity block can list them. The events of a converted quote are not copied to the order; the order's quote
chip leads back.

### Screen

- The switch **Devis | Commandes** sits in the page header and is mirrored in the URL (`view=quotes`).
  The Commandes side is exactly today's page, tiles and "Terminées" included.
- Quote rows reuse the order row's grid: customer and number/date, line summary, state pill, total. Violet
  left border and tint. No payment pill, no fulfilment status.
- State pills: Brouillon, Envoyé, Accepté, Expiré, Refusé.
- The draft reuses `NewOrderDraftRow`/`NewOrderLines` with a mode (quote or order): violet accent, "Créer le
  devis", its own persisted draft key so a quote draft and a counter-order draft do not overwrite each other.
- The opened quote reuses the order panel's pieces where they fit: line rows in edit form, contact block,
  document row, activity. Footer: Envoyer par mail, Refusé (hold), Accepté.
- After Accepté: switch to Commandes with `?order=<id>`, the order opened and scrolled into view, and a
  notice "Devis DEV-… accepté, commande SO-… créée" with Annuler. The notice goes away on the next action or
  navigation.
- Phone: the switch lives in `OrderBoardPage` for both widths; the opened quote gets a phone layout in the
  manner of `OrderMobileView`. The draft dialog is already the same at every width.
- All new strings in the 16 locales.

## My calls (not discussed, correct them if wrong)

- "Terminées" stays inside the Commandes side as today rather than becoming a third tab (the first mockup
  drew it as a tab). Least change; the decision made was to separate quotes from orders.
- Which quotes show: every non-Aito estimate in Books, including ones made directly in Books, within the
  board's age limit and brand filter. (Stated to the user, not objected to.)
- New expiry on editing an expired quote: today plus the quote's own validity (`expiry_date - date`).
- A quote with no customer picked falls back to the walk-in default contact, as the counter order does.
- Refusé needs no hold-to-confirm: a refused quote has a **Rouvrir** button.
- Old quotes accepted in Books with no order or invoice (up to 161, fewer within the age limit) show in
  En cours as "Accepté" with Créer la commande. The user chose to leave them for now; no "Classer" button.
- Converted and invoiced quotes disappear from the Devis tab; there is no "Acceptés" archive chip.
- No tiles/stat strip on the Devis side in this version: tab count, search and the three chips only.
- Editing goes through a **Modifier** button that opens the quote in the same dialog as "Nouveau devis",
  rather than lines editable in place as the mockup drew: one editor to build and test instead of two.
- A quote that holds a free-text line (no Books item) is shown but edited in Zoho ("Modifier dans Zoho"):
  the board's line editor only knows catalogue items. Lines that came from Books keep their own price.
- The order created from a quote carries the quote number as its reference, as existing direct orders do.

## Verified against live Books (2026-11-21)

Read-only listing plus one throwaway estimate (DEV26-3066, deleted; its sales order SO-00279 deleted too, so
both numbers are now gaps). Nothing was emailed.

- **Volume:** 3,056 estimates, 3,032 not linked to an Aito card, 1,385 dated 2026. Non-Aito by status:
  invoiced 1,868, expired 437, sent 272, accepted 161, declined 153, draft 141. A full listing is 16 calls.
- **Conversion:** `GET /salesorders/editpage/fromestimate?estimate_id=` returns Books' own sales-order
  prefill (lines included). `POST /salesorders` with `estimate_id` in the body creates a draft order whose
  `estimate_id` is the quote: the link is kept. The fallback is not needed.
- **Markers:** the estimate stays `accepted` after conversion. "Has an order" is only in the estimate
  DETAIL: `is_transaction_created` true and `salesorders` non-empty (`invoice_ids` for a direct invoice,
  whose list status is `invoiced`). The list row has no such field.
- **Undo:** voiding the order does NOT release the quote (`is_transaction_created` stays true). Deleting
  the order does. `status/sent` on an accepted estimate works.
- **Editing:** Books accepts line edits on a draft, sent, accepted, declined and even converted estimate.
  The "not editable once converted" rule is therefore ours to enforce.
- **Expiry:** a back-dated estimate reads `expired`; it can be accepted as is; a PUT of `date` + `expiry_date`
  returns it to `sent`. Default validity on a new estimate was 16 days.
- **Refusal is reversible:** `status/sent` on a declined estimate works (only draft has no way back).

No send-by-mail and no `mark_salesorder_open` ran in this test. A watched first run of the finished feature on
one real quote is still owed.

## Left to the builder

- Module layout for the quote sync and actions inside `order_board_sync/` and `order_board_actions/`.
- Whether quote detail ships with the list or loads on open.
- Exact reuse boundary between order components and quote components (a mode prop or thin siblings).
- Test set: sync filtering (Aito, age, converted), state derivation, each action's happy path and its
  half-failure (accepted but order creation failed; double submit), draft-key separation, i18n parity.
