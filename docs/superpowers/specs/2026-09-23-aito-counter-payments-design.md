# Aito counter payments: one Encaissement block for link, terminal and manual payments

Date: 2026-09-23
Status: approved in brainstorming, awaiting spec review
Scope: Aito project panel (Billing card), backend Heimdall + Zoho clients, new routes

## 1. Goal

Let the operator collect money for a project's quote deposit or invoice balance
from the expanded project card, through any of three channels:

1. **Payment link** (already exists for quotes, new on invoices): an OSB link
   minted by Heimdall.
2. **Card on the terminal (TPE)**: Heimdall fires the Ingenico terminal at the
   counter and books the money into Zoho Books itself.
3. **Manual payment**: card on another device, cheque or cash, recorded by
   Bambuddy straight into Zoho Books with a payment mode and a reference.

The same component handles the three channels for both documents. The card
shows the amount due, the current payment state, and three actions; each
action opens a modal. Nothing new is shown as a ledger: the Activity log is the
trace and the existing figures (invoice balance, retainer paid, customer
credit) are the result.

Decisions taken during brainstorming:

| Question | Decision |
|---|---|
| Where a manual payment is written | Zoho Books, mirroring Heimdall's own recipe |
| Quote amount | Prefilled with the deposit-due rule, editable in every flow |
| Trace on the card | Event log + refreshed figures, no payments list |
| Placement | Option 3: state line + three labelled cells, actions in modals |
| Cancel a link from the card | Invoice links only; a quote link would be re-minted |
| Reference field | Required for cheques, optional for card and cash |
| Closing the terminal modal mid-wait | Allowed; the card's state line keeps tracking |

## 2. External contract (Heimdall)

Source of truth: `/Users/paultheis/Documents/Code/heimdall/docs/API.md`. Re-read
it before implementing; the payment-links phase was bitten twice by writing
from memory (see the `aito-heimdall-payment-links` memory).

- `POST /api/v1/payments` with `method: "terminal"`, `amount` (integer XPF),
  `currency: "XPF"`, `document: {type: "quote"|"invoice"|"retainer", id}`
  (Zoho's own document id, never the number), `confirm: true`. Needs scope
  `payments:charge`. Requires `Idempotency-Key`.
- Answers: `202` charge started (`status: processing`), `200` replay or
  document-level guard (an existing live debit on that document is returned
  instead), `403` key lacks `payments:charge`, `404` unknown document, `409`
  `terminal_busy` / `idempotency_conflict`, `422` amount above the invoice or
  retainer balance (a quote is uncapped), `503` Zoho or OSB unavailable.
- Poll `GET /api/v1/payments/:id`. Unified `status`: `pending`, `processing`,
  `paid`, `failed`, `cancelled`, `expired`, `needs_attention`. Up to ~180 s for
  PIN entry. `amount_confirmed` is the terminal's own figure once settled.
- `booking: {status: pending|booked|failed|not_booked, zoho_payment_id, error}`
  is reported separately from `status`. **`paid` means the money was taken;
  a failed booking is a bookkeeping problem, never a reason to charge again.**
  `needs_attention` means maybe charged; never retried by anyone.
- No remote cancel of a running terminal exchange; `POST …/cancel` only
  cancels a `draft` terminal payment or a `pending` link. Cancelling anything
  else is `409 conflict`.
- Booking recipe Heimdall applies: quote → retainer invoice raised
  (`reference_number` = quote number, not estimate-linked) + payment on it;
  invoice → payment applied to the invoice; retainer → payment on it.
- Links: `method: "link"`, `reference` must resolve by prefix `DEV…` (quote),
  `FA…` (invoice), `RET…` (retainer), otherwise `422`.

## 3. Frontend

### 3.1 `PaymentBlock`

`frontend/src/components/aito/payment/PaymentBlock.tsx`, rendered twice by the
Billing card: once in the quote half (replacing `PaymentLinkRow`) and once in
`InvoiceCard`. Props:

```ts
{
  project: AitoProject;
  document: {
    kind: 'quote' | 'invoice';
    id: string;            // Zoho document id
    number: string;        // DEV… / FA…
    due: number | null;    // amount still due, whole francs, null = nothing due
    currency: string;
  };
  link: AitoPaymentLink | null;          // this document's link
  terminal: AitoTerminalPayment | null;  // this document's latest terminal payment
  canUpdate: boolean;
  heimdallConfigured: boolean;
}
```

Amount due: quote uses `requiredAmount(quote_total, depositPct, retainer_paid_total)`
(existing helper in `utils/aitoPayment.ts`); invoice uses the live
`invoice.balance` from `useAitoInvoice`.

Render rule: the block renders when `due > 0`, or when there is a state worth
showing (terminal `processing` / `needs_attention`, a paid link or terminal
payment, a pending link). Otherwise nothing.

Layout: head line (label "Acompte dû" / "Solde dû" left, amount right), one
state line, then the cell strip. Reuses `ACTION_GROUP` / `ACTION_CELL`
classes from `quoteActionGroup.ts` for the strip; cells carry icon + short
label (Lien / TPE / Manuel) with `aria-label` + `title` for the long name.

### 3.2 State line (first match wins)

1. Terminal `processing`: spinner, "TPE · en attente de la carte", elapsed
   time since `created_at`.
2. Terminal `needs_attention`: amber warning, "Résultat inconnu · vérifier le
   TPE". Stays until Heimdall reports a terminal state.
3. Link `pending`: "Lien ouvert · expire dans N j" (existing expiry wording)
   with the existing open / copy icon buttons on the same line.
4. Most recent settled payment, any channel, `paid`: green check,
   "Payé {amount} · {channel} · {date}". If the terminal payment's
   `booking_status` is `failed`, a second muted line: "Non enregistré dans
   Zoho — voir Heimdall".
5. Link `expired` / `failed` / `cancelled`: muted state label, as today.
6. Else: "Aucun lien" on an invoice; nothing on a quote.

### 3.3 Cells

Rendered only when `canUpdate && due > 0`. All three disabled while a terminal
payment is `processing`. TPE disabled with a tooltip when
`heimdallConfigured` is false. Lien on a quote opens the modal in read mode
(a quote link is always minted by the reconciler).

### 3.4 Modals

All three use the create-invoice modal frame (`role="dialog"`, `z-[110]`,
`useDismissableDialog`, `Card`/`CardContent`, verbatim server `message`).
Amount fields are whole-francs integer inputs, prefilled with `due`, rejecting
empty, zero, negative and non-integer values client-side.

**PaymentLinkModal**
- Quote with a link, or invoice with a pending link: URL (truncated), Ouvrir /
  Copier, amount, created date. Invoice adds "Annuler le lien" (confirm in
  place, then `POST …/payment-link/{id}/cancel`). Quote shows Fermer only.
- Invoice without a live link: amount field + "Créer le lien"
  (`POST …/payment-link`). Paid / expired / failed / cancelled invoice links
  show their state plus "Créer un nouveau lien".

**TerminalPaymentModal**
1. Amount + "Lancer le TPE" → `POST …/terminal-payment` with `confirm` implied.
2. Waiting: spinner, amount, "En attente de la carte sur le terminal… jusqu'à
   3 minutes". Single button "Fermer, je reviendrai". No cancel button.
   Polls `GET …/terminal-payment/{id}` every 3 s while mounted.
3. Paid: green, confirmed amount, "Paiement accepté · enregistrement dans Zoho
   Books en cours / enregistré / a échoué (voir Heimdall)". Fermer.
4. Failed / cancelled: red, "Rien n'a été débité". Fermer + Relancer (back to 1).
5. Needs attention: amber, "Vérifiez le ticket papier avant toute nouvelle
   tentative". Fermer only.

Closing the modal never stops the charge. While the panel stays open the block
keeps polling the open payment every 3 s (same query), so the state line
follows.

**ManualPaymentModal**
Mode as three cells (Carte / Chèque / Espèces), amount, reference (max 64,
required when Chèque), one hint line stating what will be written to Zoho.
"Enregistrer" → `POST …/manual-payment`. Submit button disabled while pending;
success closes the modal and toasts.

### 3.5 Project response additions

`AitoProject` gains `invoice_payment_link: AitoPaymentLink | null` (same shape
as `payment_link`, which keeps meaning the quote link) and
`terminal_payment: AitoTerminalPayment | null`:

```ts
{
  id: number; document_kind: 'quote' | 'invoice'; document_number: string;
  status: 'pending' | 'processing' | 'paid' | 'failed' | 'cancelled' | 'expired' | 'needs_attention';
  amount: number; amount_confirmed: number | null;
  booking_status: 'pending' | 'booked' | 'failed' | 'not_booked' | null;
  booking_error: string | null;
  created_at: string; settled_at: string | null;
}
```

Adding a field to the project payload means: schema, response builder, TS
type, and every literal test fixture (tsc never checks test files).

`api.client` gains: `createAitoTerminalPayment`, `getAitoTerminalPayment`,
`recordAitoManualPayment`, `createAitoInvoicePaymentLink`,
`cancelAitoPaymentLink`. Query keys: `['aito-terminal-payment', projectId, id]`
for the poll; success paths update `['aito-projects']` and invalidate
`['aito-invoice', projectId]`.

## 4. Backend: terminal payments

### 4.1 Heimdall client (`services/heimdall.py`)

New `create_terminal_payment(db, *, amount: int, document: dict, idempotency_key: str) -> PaymentView`.
Body: `{"method": "terminal", "amount", "currency": "XPF", "document", "confirm": true}`.
Signing, headers and settings as `create_link`. `get_payment` reused for polls.
`PaymentView` extends the current link view with `native_state`, `amount_confirmed`,
`booking: {status, zoho_payment_id, error}`.

New exceptions: `HeimdallForbidden` (403), `HeimdallTerminalBusy` (409
`terminal_busy`), `HeimdallInvalid(message)` (422, message carries the balance
text). Existing `HeimdallConflict`, `HeimdallNotFound`, `HeimdallUpstreamError`,
`HeimdallRateLimited`, `HeimdallNotConfigured` stay. A `200` on create is a
success: the returned payment is adopted (replay or document-level guard).

### 4.2 Model `aito_terminal_payments`

| column | type | notes |
|---|---|---|
| id | int pk | |
| project_id | int, indexed | |
| document_kind | str(10) | quote / invoice |
| document_id | str(50) | Zoho id |
| document_number | str(64) | |
| idempotency_key | str(64) unique | `aito-tpe:{project_id}:{n}` |
| heimdall_id | str(36) unique nullable | NULL while the create is in flight |
| amount | int | requested, whole XPF |
| amount_confirmed | int nullable | terminal's figure |
| status | str(20) | Heimdall unified vocabulary, `pending` at reservation |
| native_state | str(30) nullable | informational |
| booking_status | str(20) nullable | |
| booking_error | text nullable | |
| zoho_payment_id | str(50) nullable | |
| sync_error | text nullable | last poll error |
| created_by | str(100) nullable | actor name |
| created_at, checked_at, settled_at, updated_at | datetime | |

Additive migration in `core/database.py:run_migrations()`; model registered in
the three import lists (see the `new-feature-registration-gotchas` memory).

### 4.3 Route `POST /aito/{project_id}/terminal-payment`

Permission `aito:update`. Body `AitoTerminalPaymentCreate {document_kind, document_id, amount: int > 0}`.

1. Load the project; capture `id`, `quote_id`, `quote_number`, `client_id`
   into locals before any upstream call (expired-attribute trap).
2. Guards: any row for this project with status `pending`/`processing`/
   `needs_attention` → 409 `terminal_in_progress`. Document ownership: quote
   → `document_id == project.quote_id`; invoice → id present in
   `list_project_invoices` for the estimate; else 422 `document_mismatch`.
3. Insert the reservation row (`status: pending`, next `n` for the project),
   commit.
4. Call Heimdall. Success (202/200): store `heimdall_id`, `status`,
   `native_state`, `booking_*`, record `payment.terminal.started`
   (`actor_class: user`, detail: document, amount, heimdall_id), commit,
   return the row.
   Failure: mark the row `failed` with `sync_error`, commit, then answer
   403 → 502 "clé Heimdall sans droit d'encaissement"; busy → 409
   `terminal_busy`; 422 → 422 with Heimdall's message; 404 → 422
   `document_unknown`; 503/upstream/not configured → 502; rate limited → 429.
   Reservation replay: a row left `pending` with no `heimdall_id` and the same
   body is re-sent with its own idempotency key (Heimdall re-fires a draft
   only on an identical body, so the body must be rebuilt from the row).
5. Response model `AitoTerminalPaymentView` (§3.5 shape).

### 4.4 Route `GET /aito/{project_id}/terminal-payment/{row_id}`

Permission `aito:read`. If the row is open (`pending`/`processing`) and
`checked_at` is older than 2 s, refresh from Heimdall through the settle helper;
also refresh when `status == paid` and `booking_status == pending`. Return the
row. Heimdall errors on refresh set `sync_error` and return the stored row
(never 5xx).

### 4.5 Settle helper `apply_terminal_state(db, row, payment, *, now)`

One helper, called from the GET route and from the reconciler tick:

- Copies `status`, `native_state`, `amount_confirmed`, `booking_*`, sets
  `checked_at`; sets `settled_at` on first transition to a terminal status.
- First `paid`: record `payment.terminal.paid` (amount_confirmed, heimdall_id,
  zoho_payment_id when booked); quote → `accept_quote(source="terminal")`
  through the same path a paid link uses; trigger the reconciler's per-project
  sync so figures refresh; commit.
- First `failed` / `cancelled`: record `payment.terminal.failed` with
  native_state. First `needs_attention`: record `payment.terminal.attention`.
- Booking transitions after `paid` update the row and, on `failed`, append the
  error to the paid event's detail (no new event kind).
- Never re-creates, never re-fires, never cancels.

### 4.6 Reconciler tick

The existing 5-minute `aito_payment_links` tick additionally polls every
`aito_terminal_payments` row that is open or paid-with-pending-booking (bounded
by `MAX_POLLS_PER_TICK`), through the settle helper, so a panel closed mid-wait
still settles. Backoff on repeated Heimdall errors mirrors the links' rule.

## 5. Backend: manual payments

### 5.1 Zoho client (`services/zoho.py`)

```python
async def create_retainer_invoice(db, *, customer_id, reference_number, description, amount) -> dict
# POST /retainerinvoices {customer_id, reference_number, date: today, line_items: [{description, rate: amount, quantity: 1}]}
async def record_customer_payment(db, *, customer_id, payment_mode, amount, reference_number, description, invoice_id=None, retainerinvoice_id=None) -> dict
# POST /customerpayments {customer_id, payment_mode, amount, date: today, reference_number, description, invoices: [{invoice_id, amount_applied}] | retainerinvoice_id}
```

No `account_id` is sent: Zoho files the payment under its default
undeposited-funds account. Dates are today in the shop's timezone (same helper
the invoice create uses). Both raise `ZohoUpstreamError` / `ZohoNotConfiguredError`.

### 5.2 Settings

`aito_payment_mode_card` = `creditcard`, `aito_payment_mode_cheque` = `check`,
`aito_payment_mode_cash` = `cash`. Shown in Settings next to the Heimdall card,
plain text inputs. A mode Zoho rejects surfaces Zoho's message verbatim.

### 5.3 Route `POST /aito/{project_id}/manual-payment`

Permission `aito:update`. Body `AitoManualPaymentCreate {document_kind, document_id, mode: card|cheque|cash, amount: int > 0, reference: str | None (max 64)}`.
Validation: `mode == cheque` requires a non-blank reference (422).

1. Same ownership check as §4.3. Customer id from the estimate
   (`estimate.customer_id`, as `plan_invoice` does).
2. Duplicate guard: a `payment.manual.recorded` event for this project with
   the same document, amount and reference in the last 60 s → 409 `duplicate`.
3. Invoice: `get_invoice`; amount above `balance` → 422 naming the balance;
   `record_customer_payment(invoice_id=…)`, description
   `"{invoice_number} · {mode label}"`.
4. Quote: `create_retainer_invoice(reference_number=quote_number, description="Acompte {quote_number}", amount)`,
   then `record_customer_payment(retainerinvoice_id=…, description=quote_number)`.
   If the second call fails: record `payment.manual.partial` (retainer number,
   amount, mode, reference, error), commit, answer 502 with a message naming
   the retainer number so the operator records the payment in Books.
5. Record `payment.manual.recorded` (mode, amount, reference, document,
   zoho_payment_id, retainer number when any; `actor_class: user`). Commit
   before any further read.
6. Refresh figures: invoice → re-read the invoice and update
   `invoice_status` / `invoice_balance`; quote → re-read customer credit and
   the estimate's retainers (`retainer_paid_total`), then run the same
   auto-accept check the sweep runs. Commit, return the fresh project.

## 6. Backend: invoice payment links

### 6.1 Model change

`aito_payment_links` gains `document_kind` (str(10), default `quote`,
server_default `quote`) and `document_number` (str(64), nullable; backfilled
from `reference` for existing rows). Additive migration.

### 6.2 Routes

- `POST /aito/{project_id}/payment-link`, `aito:update`, body
  `{document_kind: "invoice", document_id, amount}`. Ownership check; at most
  one pending invoice link per project (409 `link_exists`); amount above the
  invoice balance → 422. Reservation row first (`aito:{project}:{n}` key, as
  today), `create_link(reference=invoice_number, amount, expires_in_days=setting)`,
  record `payment_link.created` with `document_kind`. Response: the link view.
- `POST /aito/{project_id}/payment-link/{link_id}/cancel`, `aito:update`.
  Quote link → 409 `quote_link_managed`. Invoice link → `cancel_link`;
  Heimdall 409 → mark from a fresh GET; record `payment_link.cancelled`.
- The existing `POST …/payment-link/refresh` stays quote-only.

### 6.3 Reconciler

Minting/renewal loop: `WHERE document_kind = 'quote'` everywhere it selects the
project's link. Polling loop: all pending links. `_became_paid` branches on
`document_kind`: quote → unchanged (accept + figures); invoice → record
`payment_link.paid` with `document_kind` and trigger the figures refresh only.

### 6.4 Project response

`payment_link` = newest quote link (unchanged selection). `invoice_payment_link`
= newest invoice link, any state, or `null`.

## 7. Events

Register in `aito_events.KINDS` (story depth): `payment.terminal.started`,
`payment.terminal.paid`, `payment.terminal.failed`, `payment.terminal.attention`,
`payment.manual.recorded`, `payment.manual.partial`. Reused with a
`document_kind` detail: `payment_link.created`, `payment_link.paid`,
`payment_link.cancelled`. Timeline labels added under `aito.timeline.*` in all
14 locales.

## 8. Errors, permissions, rate limits

- Upstream not configured / unreachable (Heimdall 503, Zoho): 502, `message`
  in the body, nothing created.
- Business refusals: 409 (`terminal_in_progress`, `terminal_busy`,
  `link_exists`, `duplicate`, `quote_link_managed`), 422
  (`amount_above_balance` with the balance, `document_mismatch`,
  `document_unknown`, `reference_required`). Bodies:
  `{"code": ..., "message": ...}` like `set_quote_status`.
- Once an upstream side effect has landed the route never answers 500: it
  commits what it knows and reports the rest in `message`.
- A `paid` terminal payment is never re-sent whatever `booking` says;
  `needs_attention` is never retried. Enforced by the UI (no Relancer in those
  states) and by the in-progress guard.
- Permissions: every new route is `aito:update` except the GET (`aito:read`).
  Each path is added to the API-key route classification.
- Rate limits: the terminal create and the manual record share the existing
  per-user `_check_rate_limit(bucket=…)` at 10/min, same as the link refresh.

## 9. i18n

New keys under `aito.payment.*` (block labels, state line, three cells, three
modals, error codes) and `aito.timeline.*` for the six event kinds, in all 14
locale files with real translations; `npm run check:i18n` must pass.

## 10. Testing

Backend (pytest):
- `test_heimdall_client.py`: terminal create body, signature vector with the
  idempotency key, 202/200/403/409/422/404/503 mapping, `PaymentView` parsing
  with booking.
- `test_aito_terminal_payment_api.py`: guards (in-progress, ownership), the
  reservation + replay path, every error mapping, GET refresh throttle, the
  settle helper for each status including booking failed after paid, quote
  acceptance on paid, event kinds recorded once.
- `test_aito_manual_payment_api.py`: cheque reference rule, over-balance 422,
  invoice and quote recipes against the fake Books server (`/retainerinvoices`,
  `/customerpayments`), the partial-failure 502 + event, duplicate 409,
  figures refreshed in the response.
- `test_aito_payment_links*.py`: `document_kind` split in `_became_paid`, the
  invoice create/cancel routes, quote-cancel 409, migration test for the new
  columns and table.
- Permission tests for each new route (static closure read, per the
  `aito-client-contacted` memory).

Frontend (vitest):
- `PaymentBlock.test.tsx`: state-line priority table, render rule, cell gating
  (canUpdate, due, Heimdall off, processing).
- One test file per modal: validation, verbatim error, terminal polling with
  fake timers through paid / declined / needs_attention, cheque reference,
  invoice link create / cancel.
- Migrate `AitoPaymentLinkRow.test.tsx` and the BillingCard tests to the block.
- 14-locale parity.

Manual, before merge: one real 100 F terminal charge on a `DEV…` test quote and
one manual cheque record, both verified in Books; Settings → Heimdall → test
connection must pass first. The Heimdall key must carry `payments:charge`.

## 11. Out of scope

- A local payments ledger or a payments list on the card.
- Refunds, partial refunds, retries of a failed Zoho booking (done in Heimdall).
- Choosing the Zoho deposit account per mode.
- Payment links in EUR/USD.
- Tracking-page changes: the customer-facing page keeps showing only the quote
  link, as it does today.
