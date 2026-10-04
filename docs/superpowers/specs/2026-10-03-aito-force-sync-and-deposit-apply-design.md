# Aito: force Zoho sync, apply deposit to invoice, deposit link after invoicing

Date: 2026-10-03 · Branch: `aito-sync-and-deposit` · Base: `605d734fb`

## Goal

Four operator-facing changes to the Aito detail panel, agreed in chat:

1. Once a card is invoiced, the quote's deposit can no longer be collected from the panel, and a deposit
   that lands anyway goes onto the invoice at once instead of within the hour.
2. A "Force Zoho sync" row in the ⋯ menu that checks every Zoho-backed part of the card, fixes what drifted,
   and reports per step what it found.
3. An "Apply deposit" button on the invoice row: the operator spends this quote's own deposit on the open
   invoice, with a prefilled, editable amount.
4. The client name loses its hold-to-open-history gesture; the history button next to it is the only path.

## Non-goals

- The hourly sweep (`aito_invoice_sweep.settle_with_deposits`) is unchanged (option A). A manual partial
  apply may be topped up by the next sweep; splitting a deposit across invoices stays a Books task.
- No spending of customer credit that is not this quote's (other quotes' retainers, plain advances).
- No new permission: everything rides `AITO_UPDATE`.

## 1. Deposit link once invoiced

Today `wanted_link` already returns `None` for `quote_invoiced`, but the live deposit link is only cancelled
on the payment-link loop's next pass, and `BillingCard` keeps rendering the quote's `PaymentBlock`
("Deposit due" with Terminal/Manual) because `quoteDocument` ignores `quote_invoiced`.

- **Frontend (`BillingCard`):** do not render the quote `PaymentBlock` when `project.quote_invoiced`, unless
  a quote-kind terminal payment is in flight (`terminalFor(project, 'quote')` non-null and not terminal),
  so a tap in progress is never hidden mid-way.
- **Backend, create-invoice route (`POST /{id}/invoice`):** after `quote_invoiced = True` is committed, call
  `reconcile_payment_links(db, only_project_id=project.id, force=True)`, best-effort (logged, never fails the
  create — the invoice exists by then). The live deposit link is cancelled with reason `invoiced` right away.
- **Backend, counter routes (`aito_payments.py`):** `start_terminal_payment_route` and
  `record_manual_payment_route` refuse `document_kind == "quote"` on an invoiced card with 409,
  code `quote_invoiced` (via `_refuse`), so a stale tab cannot record a deposit.
- **Late deposit settles at once:** `aito_manual_payments.refresh_after_payment(kind="quote")`, after its
  `sync_project`, runs `settle_with_deposits` for the card when `project.quote_invoiced` (newest invoice read
  via `list_project_invoices`, balance > 0). `_became_paid` for a quote-kind link calls the same refresh when
  the card is invoiced (today it only does so for invoice links). Best-effort, same contract as the rest of
  `refresh_after_payment`; the hourly sweep remains the fallback.

## 2. Force Zoho sync

### Route

`POST /aito/{project_id}/force-sync` → `AitoForceSyncReport`. `AITO_UPDATE`, active card only (404 on trashed,
via `_get_active_project_or_404`), per-user rate limit (same shape as `_check_payment_link_refresh_rate_limit`,
its own bucket). Registered before any parameterised sibling that could swallow it.

Steps, in order; each produces `{key, outcome, detail}` where `outcome` ∈ `in_sync | fixed | failed | skipped`
and `detail` is a short machine-friendly dict the frontend formats (never a raw exception string with
credentials; upstream error text is fine, as elsewhere):

1. **`quote`** — card has no `quote_id` and is not pending → `skipped` (`reason: no_quote`). `unmanaged` →
   `skipped` (`reason: unmanaged`). Otherwise snapshot `(quote_total, quote_status, quote_sync_state,
   quote_sync_error)`, mark pending exactly as `POST /{id}/sync` does (`_mark_pending_if_ours`, same
   `sync.queued` event rule), then `flush_and_wait(project_id)`. Worker not serving (`can_flush()` false) or
   timeout → `failed` (`reason: worker_unavailable | timeout`). After: `error`/`locked`-with-reason →
   `failed` with the recorded message; any snapshot field changed → `fixed` with before/after; else `in_sync`.
   The push itself is the worker's, so every existing guard applies and the request never races the loop.
2. **`credit`** — refresh `retainer_paid_total` (estimate-linked + reference-matched retainers, the worker's
   own helpers) and `customer_credit_total` (`read_customer_credit`). Changed → `fixed` with before/after.
3. **`invoice`** — skipped when no `quote_id` or not `quote_invoiced`. Read the newest invoice; balance > 0 →
   `settle_with_deposits`. Something applied → `fixed` (`applied: [{retainer_number, amount}]`); else
   `in_sync`. Updates the cached invoice columns the same way `refresh_after_payment(kind="invoice")` does.
4. **`payment_links`** — `reconcile_payment_links(db, only_project_id=id, force=True)`; compare the card's
   link rows (status, amount, heimdall id) before/after → `fixed` / `in_sync`; a row left with `sync_error`
   → `failed`. Heimdall not configured → `skipped`.

`ZohoRateLimited` in any step → that step `failed` (`reason: rate_limited`), every later Zoho step `skipped`
(`reason: rate_limited`), and the shared throttle armed as the worker does. Step 4 (Heimdall) still runs.
`ZohoNotConfiguredError` → Zoho steps `skipped` (`reason: not_configured`). Each step is isolated: a failure
in one never prevents the next (except the 429 rule). Records one `project.force_synced` event with the
outcome per step (new KINDS entry + `aito.history.*` label in 15 locales).

### Frontend

- `ProjectActionsMenu`: new row `forceSync` (RefreshCw icon, label `aito.forceSync`), placed after `watch`
  before `duplicate`; disabled via `reason([trashed, hintTrashed], [!p.canUpdate, hintNoPermission])`.
  Invoiced cards stay enabled.
- `ForceSyncModal` (same shell/z-index as `MergeProjectModal`): on open it fires the POST once; while
  waiting it shows the four step rows with a spinner; then each row shows ✓ in sync / ↻ fixed + detail /
  ✕ failed + reason / – skipped + reason. Close button; Escape closes. On settle it invalidates the project,
  board, invoice, retainers and events queries. 429 from our own rate limit → inline message, no report.
- `client.ts`: `forceSyncAitoProject(id)` + `AitoForceSyncReport` types.
- `test_aito_permissions.py`: route count +1, classified WRITE.

## 3. Apply deposit to invoice

### Routes (`aito.py`, literal paths before parameterised siblings)

- `GET /aito/{project_id}/invoice-deposits` (`AITO_READ`) → `{invoice: {id, number, balance, currency_code}
  | null, deposits: [{id, number, applicable, total}]}`. Deposits = `linked_credits(estimate,
  customer_credits(...), quote_number)`, oldest first (the order `customer_credits` already gives). Invoice =
  newest from `list_project_invoices`. No quote / not invoiced → `{invoice: null, deposits: []}`. Zoho
  failure → 502, as the other live reads.
- `POST /aito/{project_id}/invoice-deposits/apply` (`AITO_UPDATE`) body `{invoice_id, retainer_id, amount}`.
  Re-reads invoice and credits from Books (never trusts the client's figures). 404 if `invoice_id` is not
  this project's newest invoice or `retainer_id` is not among `linked_credits` (membership check, same
  reasoning as `_resolve_project_retainer`). 409 `amount_too_high` if `amount > min(balance, applicable)`
  (cent tolerance), 422 for `amount <= 0`. Spends the retainer's payments oldest first up to `amount` (a
  `share_out`-style split over that one credit) via `zoho_service.apply_invoice_credits`. Records
  `invoice.deposit_applied` with `source: "manual"` and the actor. Re-reads the invoice by id, refreshes the
  cached invoice columns and `customer_credit_total`, returns the invoice response. Books failure → 502;
  `ZohoRateLimited` → 429 with the throttle armed.
- `test_aito_permissions.py`: +2 routes (GET read-only, POST write).

### Frontend

- `useAitoInvoiceDeposits(project, enabled)` query, enabled when `canUpdate && invoice && invoice.balance > 0`.
- `InvoiceCard`: new `applyDeposit` action icon (PiggyBank) in the row's action group, rendered when the
  query returns ≥ 1 deposit with `applicable > 0`. Title/aria `aito.applyDeposit`.
- `ApplyDepositModal`: deposits as radio rows (number, unused amount), oldest preselected; a `CalcInput`
  amount prefilled with `depositPrefill(balance, applicable) = min(balance, applicable)` rounded to cents,
  re-prefilled when the selection changes; hint under it: `aito.applyDepositPaysInFull` when the prefill
  equals the balance, `aito.applyDepositUsesAll` when it equals the deposit; client-side cap with the same
  rule as the server; confirm button "Apply {{amount}}". On success: close, toast, invalidate invoice,
  retainers, project, events. 409/502 → inline error, modal stays.
- `depositPrefill` lives in its own `.ts` (react-refresh rule).

## 4. Client name hold removed

- `ProjectDetailPanel`: the client name renders as the plain truncating span in both branches; `HoldButton`
  and the wrapper span go. `aito.clientHistoryHint` is deleted from all 15 locales (no other user).
- The history button gets `pointer-coarse:opacity-100` so touch devices, which have no hover, always see it.
- Tests asserting the hold on the name are updated to the button.

## Testing

- Backend (pytest, Zoho/Heimdall stubbed — never live): force-sync per-step outcomes (in_sync, fixed,
  failed, skipped), 429 skip chain, not-configured, trashed 404, rate limit; invoice-deposits GET shapes;
  apply caps/membership/422/409/success and event; counter routes 409 on invoiced quote payments;
  create-invoice cancels the deposit link; `refresh_after_payment(quote)` settles on an invoiced card.
- Frontend (Vitest): menu row enabled/disabled; ForceSyncModal states; BillingCard hides deposit block when
  invoiced (and keeps it with a terminal in flight); InvoiceCard shows/hides the apply icon;
  ApplyDepositModal prefill, re-prefill, cap, submit; `depositPrefill` unit; name has no hold.
- `./test_frontend.sh`, `./test_backend.sh`, `npm run build`; i18n parity across 15 locales.

## Implementation notes

Deviations and details settled during implementation:

- Force sync `credit` step refreshes `customer_credit_total` only; `retainer_paid_total` stays the quote worker's figure (recomputing it with other rules would flip-flop against the worker).
- The invoice step's `fixed` detail is `{number, balance_before, balance_after}`, not an `applied` list.
- The route marks a card pending only when it has a quote_id or is already pending (a check must not create a quote).
- Quote step: a card left `pending` after the attempt reports failed (`rate_limited` -> later Zoho steps skipped, or `upstream` + message); an error cleared with no other change reports `fixed` with `error_cleared`. The invoice step reports failed/`unreachable` when the deposit settle could not run. The links step reports skipped/`rate_limited` when the Heimdall pass did nothing for a visitable card; the credit step reports skipped/`not_configured` without Zoho.
- Apply-deposit: the `invoice.deposit_applied` event is committed right after Books accepts the application; every later read degrades (stale balance minus the applied amount, url "", invoice_count 1) so a retry cannot double-apply. The amount is rounded to cents server- and client-side.
- The deposit block on an invoiced card stays only while the quote terminal derives to `terminal_processing` / `terminal_attention` (reuses `derivePaymentState`), not a raw status list.
- The menu label key is `aito.forceZohoSync` (`aito.forceSync` already existed for the Billing card button).
- Aito route count is now 59 / 38 write.
- The hold test lives in ProjectDetailPanel.test.tsx, not AitoClientHistory.test.tsx.
