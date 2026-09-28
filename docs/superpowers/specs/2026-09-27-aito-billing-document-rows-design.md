# Aito Billing card: one row per document, deduplicated payment block

**Date:** 2026-09-27
**Branch:** `aito-billing-actions`
**Status:** draft for review

## Goal

Rework the Billing card of the expanded Aito project card (Details tab) so that:

1. Every Zoho document the project has — the quote, each retainer (deposit) invoice, the invoice — is one compact row with the same four actions: print, download PDF, send by email, open in Zoho Books.
2. The online payment link appears once, not twice.
3. The retainer invoice, which the card does not show at all today, gets its place between the quote and the invoice.

Proposition A of the 2026-09-27 demo (`scratchpad/demo/billing.html`), approved by the user with the retainer row carrying the email action too.

## Non-goals

- No change to how money is collected (link / terminal / manual modals, reconciler, Heimdall).
- No change to the quote sync rows (sync state, retry, force sync, declined, status block).
- No change to Create invoice (footer) or to the Record / Shipping cards.
- No retainer creation from the card. Retainers keep being raised by the payment flows or by hand in Books.
- No quote-send behaviour change (the quote's send modal still moves the board column).

## Current state (what is being replaced)

`BillingCard.tsx` renders, in order: a `<dl>` (Quote number linking to Books, Status, Deposit available), the quote's `PaymentBlock`, a three-cell `ACTION_GROUP` (print / download / send), the sync facts, then `InvoiceCard.tsx` under a hairline: a `<dl>` (Invoice number linking to Books, Date, Total, Balance, Status), the invoice's `PaymentBlock`, the "N more invoices" note, and a second identical `ACTION_GROUP`.

`PaymentBlock.tsx` shows the amount due, a state line, and a three-cell `ACTION_GROUP` (Link / Terminal / Manual). In the `link_pending` state the state line already offers open + copy for the link, and the Link cell opens `PaymentLinkModal`, which offers open + copy again plus cancel (invoice) or retry (quote).

Problems: two identical three-cell bars with different meanings stacked in one card; the link offered twice; no retainer document.

## UX design

### Card layout

```
FACTURATION
Devis                         DEV26-2638
Accepté                     🖨 ⬇ ✉ ↗
──────────────────────────────────────
Acompte                       AC-26-0031
Payée · 17 500 FCFP         🖨 ⬇ ✉ ↗
──────────────────────────────────────
Facture                       FA-26-4100
Impayée · 35 000 FCFP       🖨 ⬇ ✉ ↗
──────────────────────────────────────  (hairline, mt-2 pt-2)
Acompte disponible            17 500 FCFP   (only when customer_credit_total > 0)
Solde dû                      17 500 FCFP
Paiement en ligne   Expire dans 2 j  ↗ ⧉
[   Terminal   ][   Manuel   ]
──────────────────────────────────────
Synchro …  (sync facts, unchanged)
```

### Document row (`DocumentRow`)

One component, three uses. Two lines on a `grid grid-cols-[auto_1fr]`:

- **Line 1:** label (`text-bambu-gray`) and number (`text-white`, right-aligned, `truncate`). The number is plain text: Books is reached through the row's last icon, so the number no longer carries a link. The number cell carries a `title` with the document's secondary facts (see per-document below).
- **Line 2:** spans both columns, `flex items-center justify-between gap-2 text-xs`. Left: the status in its tone class, then ` · amount` where noted below, `truncate min-w-0` with `title` = full text. Right: the icon cluster.

Icon cluster: four icon-only buttons, each `p-1 rounded-md` around a `w-4 h-4` glyph (24 px square), in this order: **print**, **download**, **send** (rendered only when `canUpdate`), **open in Books** (an `<a target=_blank rel=noopener noreferrer>`). Names live on `aria-label` + `title`, the way the action group and the link rows do today. The cluster gets `-my-1 -mr-1` so the glyphs align with the values above and do not grow the line. Hover/focus classes match `LINK_ICON_BUTTON_CLS` (a 24 px sibling constant `DOC_ICON_BUTTON_CLS` is added next to it in `linkActionHelpers.ts`).

Width check: at the rail's worst case (230.4 px usable), the cluster is 4 × 24 + 3 × 2 = 102 px, leaving ~120 px for the status text at 12.96 px, enough for "Impayée · 35 000 FCFP"; anything longer truncates with an ellipsis and its `title`.

Rows are separated by `border-t border-bambu-dark-tertiary` (`.doc + .doc`), each `py-1.5`.

Disabled states: print and download are disabled with `title = aito.pdfSyncPending` while `quote_sync_state === 'pending'`, for all three document kinds (same rule the two cards apply today). The send button is never disabled by sync state (same as today).

Per document:

| Row | Label key | Number | Line 2 | Number `title` | Books link |
|---|---|---|---|---|---|
| Quote | `aito.quoteSearchLabel` (existing "Devis") | `quote_number` | `quoteStatusText` in `QUOTE_STATUS_TEXT_TONE_CLASSES` tone; nothing else | `quote_date` when present | `quote_url` |
| Retainer | `aito.retainerLabel` (new) | `number` | retainer status (new `aito.retainerStatus.*`) · `total` in the retainer's currency | date | `url` from the API |
| Invoice | `aito.invoiceLabel` (existing "Facture") | `number \|\| id` | invoice status (existing `invoiceStatusLabelKey`) · `total` in the invoice's currency | `date` + `due_date` ("{{date}} · échéance {{due}}", new key `aito.invoiceDatesTitle`) | `url` |

The quote row renders whenever `project.quote_number` is set (same gate as today). The status text is omitted when `quote_status` is null (line 2 then holds only the cluster).

The invoice's Date / Total / Balance / Status `<dl>` rows are removed: the total moves to line 2, the date to the number's tooltip, the balance is already the `PaymentBlock`'s "Solde dû" line, and status is line 2. The "N more invoices" note (`aito.invoiceMoreCount`) stays, rendered as a `text-xs text-bambu-gray` line directly under the invoice row.

### Order and gating

1. Quote row.
2. One retainer row per retainer returned by the new endpoint, newest first (Books' own order).
3. Invoice row (newest invoice, as today).
4. Hairline, then: the "Acompte disponible" row (unchanged rule: `customer_credit_total > 0`), the quote's `PaymentBlock`, the invoice's `PaymentBlock` (each keeps its own `blockVisible` rule, so nothing renders when nothing is due and nothing is in flight).
5. Sync facts / declined / status block (unchanged markup and rules).

The hairline and the section in step 4 render only when at least one of its three parts renders.

### Payment block deduplication

`PaymentBlock` keeps its structure (due line, `StateLine`, cells) with one rule change:

- In the `link_pending` state the cell row shows **Terminal and Manual only**. The link row is the link: open and copy stay where they are, and the label "Paiement en ligne" becomes a button (`text-left`, dotted underline on hover, `aria-label = aito.paymentLink.manage`) that opens `PaymentLinkModal` for cancel (invoice) or retry (quote). For a viewer without `canUpdate` the label stays a plain span, matching how the terminal state line degrades.
- In every other state the cells are unchanged: Link / Terminal / Manual, with the same `cellsEnabled` rule.

`ACTION_GROUP` / `ACTION_CELL` remain and are now used by `PaymentBlock` only; the comment block in `quoteActionGroup.ts` is rewritten to say so (the measurements it records stay valid).

### Empty and error states

- No quote number and no sync message: card absent (unchanged).
- Retainer query loading, failing or empty: no retainer rows. Nothing else in the card waits for it (same policy as the invoice: additive information, never a spinner or a hairline over nothing).
- Invoice query loading, failing or empty: no invoice row (unchanged).

## Backend

All new routes live in `backend/app/api/routes/aito.py`, use the existing `AITO_READ` / `AITO_UPDATE` permissions (no new `Permission` member, so no API-key scope or default-group edits), and follow the invoice routes line for line.

### Zoho client (`backend/app/services/zoho.py`)

- `books_retainer_url(db, retainer_id) -> str`: `f"{base}#/retainerinvoices/{id}"` beside `books_invoice_url`.
- `get_retainer_invoice_pdf(db, retainer_id) -> bytes`: `GET /retainerinvoices/{id}` with `accept=pdf`, twin of `get_invoice_pdf`.
- `get_retainer_email_content(db, retainer_id) -> dict`: `GET /retainerinvoices/{id}/email`, same `{subject, body, recipients}` mapping as `get_invoice_email_content` (recipients without an address dropped).
- `email_retainer(db, retainer_id, *, to_mail_ids)`: `POST /retainerinvoices/{id}/email` with `{"to_mail_ids": [...]}` only, so Books renders its own template.

Kept as separate methods rather than a parameterised one, for the reason the invoice methods' docstrings give.

### Resolver (`backend/app/services/aito_retainers.py`, new)

```python
async def list_project_retainers(db, project) -> list[dict]
```

Reads the estimate (`get_estimate(project.quote_id)`) and the customer's retainers (`list_customer_retainers(estimate["customer_id"])`), and returns the customer rows that are either attached to the estimate (`retainerinvoice_id` in `estimate["retainerinvoices"]`) or reference this quote (`aito_invoice_sweep._same_reference(row["reference_number"], project.quote_number)`), deduplicated by id, in Books' list order. The estimate's customer is used, not `project.client_id`, for the reason `plan_invoice` gives. Empty `quote_id` returns `[]` without touching Books (the empty-filter hazard `list_project_invoices` documents applies to `/retainerinvoices` too, and `list_customer_retainers` already refuses an empty customer id).

Each row is normalised to:

```python
{"id", "number", "date", "total", "balance", "currency_code", "status", "reference_number"}
```

with `number` falling back to the id, numbers parsed tolerantly (missing or non-numeric → 0.0), and `currency_code` falling back to the estimate's.

```python
async def resolve_project_retainer(db, project, retainer_id: str) -> dict
```

Membership check mirroring `_resolve_project_invoice`: `retainer_id` is required, and a miss raises 404 ("Retainer not found"), never 403. Both the PDF and the email routes go through this one function.

### Routes

| Route | Perm | Behaviour |
|---|---|---|
| `GET /aito/{id}/retainers` | READ | 404 for a missing/deleted project. `[]` (200) when the project has no `quote_id`. Otherwise `list_project_retainers`, each mapped to `AitoRetainerInvoiceResponse` with `url = books_retainer_url`. Zoho not configured / upstream error → 502 with the message, like `get_invoice`. |
| `GET /aito/{id}/retainer.pdf?retainer_id=` | READ | Like `get_invoice_pdf`: resolve, fetch, return `application/pdf` inline with `build_content_disposition("{number}.pdf")` after control-character stripping. Missing `retainer_id` → 422 (Pydantic query required). |
| `GET /aito/{id}/retainer-email?retainer_id=` | READ | Like `get_invoice_email`: resolve, `get_retainer_email_content`, response `AitoRetainerEmailContent` (subject, body, recipients, default_email, retainer_id, retainer_number). `default_email` chosen the same way `_load_invoice_email_content` chooses it. |
| `POST /aito/{id}/retainer-email` | UPDATE | Body `AitoRetainerEmailRequest {to: str, retainer_id: str}`. Zoho-first like `send_invoice_email`: rate limit (`_check_zoho_email_rate_limit`, same bucket), resolve, re-read the email content and validate `to` against Books' recipients (400 otherwise), duplicate guard `_email_guard_key_or_409("retainer", …)`, `email_retainer`, record a `retainer.emailed` event (`{retainer_id, retainer_number, to}`), then re-read the retainer via `resolve_project_retainer` and return it as `AitoRetainerInvoiceResponse`. On re-read failure return the pre-send row (the mail has gone out). The locals-before-send discipline of `send_invoice_email` applies. |

### Schemas (`backend/app/schemas/aito.py`)

- `AitoRetainerInvoiceResponse`: `id, number, date, total, balance, currency_code, status, url` (all `str` except the two floats), documented as read live like `AitoInvoiceResponse`.
- `AitoRetainerEmailContent`: `subject, body, recipients: list[AitoQuoteEmailRecipient], default_email: str | None, retainer_id, retainer_number`.
- `AitoRetainerEmailRequest`: `to: str`, `retainer_id: str`.

### Events

`retainer.emailed` is added to `aito_events.py` with kind `"story"` next to `invoice.emailed`, and to the frontend `eventKinds.ts` map with a new history key `aito.history.retainerEmailed` ("Retainer invoice {{number}} emailed to {{to}}").

## Frontend

### API client (`frontend/src/api/client.ts`)

- `interface AitoRetainerInvoice { id; number; date; total; balance; currency_code; status; url }`.
- `interface AitoRetainerEmailContent` mirroring `AitoInvoiceEmailContent` with `retainer_id` / `retainer_number`.
- `getAitoRetainers(projectId): Promise<AitoRetainerInvoice[]>`
- `getAitoRetainerPdf(projectId, retainerId): Promise<Blob>` (blob fetch, same shape as `getAitoInvoicePdf`)
- `getAitoRetainerEmail(projectId, retainerId)`
- `sendAitoRetainerEmail(projectId, { to, retainer_id })`

### Hooks

- `useAitoRetainers(project)` in `components/aito/useAitoRetainers.ts`: `queryKey ['aito-retainers', project.id]`, `enabled` when `mayHaveRetainers(project)`, `staleTime` five minutes, `retry: false` (same reasoning as `useAitoInvoice`).
  `mayHaveRetainers(project) = Boolean(quote_id) && (retainer_paid_total > 0 || customer_credit_total > 0 || quote_invoiced || quote_sync_state === 'unmanaged')`. Documented limit: a retainer raised by hand in Books and still unpaid shows up once it is paid, once the quote is invoiced, or on the next sweep that reports credit, never before, because the project row has no cheaper signal and the card must not cost two Books calls on every quoted job.
- `useSendInvoiceMutation` becomes kind-aware: `useSendDocumentEmailMutation(projectId, document: { kind: 'invoice' | 'retainer'; id: string }, onDone)`. For `invoice` it is byte-for-byte today's behaviour (cache write to `['aito-invoice', projectId]`, `aito.invoiceEmailed` toast). For `retainer` it calls `sendAitoRetainerEmail`, replaces the matching row inside `['aito-retainers', projectId]`, and toasts `aito.retainerEmailed`. The old name stays exported as a one-line wrapper so `useSendInvoiceMutation.test.tsx` keeps passing unchanged.
- `SendInvoiceModal` takes the same `document` prop instead of `invoiceId`; title, load-failed text and the email query key branch on `document.kind` (`aito.sendRetainerTitle`, `aito.sendRetainerLoadFailed`; query key `['aito-retainer-email', projectId, id]`). `SendInvoiceButton` gains the same prop; `SendRetainerButton` is not a new file, the invoice button renders with `document.kind === 'retainer'` and label `aito.sendRetainer`.

### Components

- `DocumentRow.tsx` (new, `components/aito/`): props `{ label, number, status?: { text, toneClass }, amount?: string, numberTitle?: string, booksUrl?: string | null, booksLabel, print: ReactNode, download: ReactNode, send?: ReactNode }`. It owns the layout and the Books anchor; the three action buttons are passed in already bound, so the row stays free of any Zoho or query knowledge and is testable with plain buttons.
- `PdfPrintButton` / `PdfDownloadButton` gain `variant?: 'cell' | 'icon'` (default `'cell'`, so the print-button tests stay green); `'icon'` swaps `ACTION_CELL` for `DOC_ICON_BUTTON_CLS` and the `w-3.5` glyph for `w-4`. `QuotePrintButton`, `QuoteDownloadButton`, `InvoicePrintButton`, `InvoiceDownloadButton` and `SendQuoteButton` / `SendInvoiceButton` accept and forward the same `variant`.
- `RetainerPrintButton` / `RetainerDownloadButton` (new, tiny twins of the invoice ones, bound to `getAitoRetainerPdf`, labels `aito.printRetainer` / `aito.downloadRetainer`, failure toast `aito.retainerPrintFailed` / `aito.retainerDownloadFailed`).
- `BillingCard.tsx`: renders the quote `DocumentRow`, `RetainerRows` (a small inner component calling `useAitoRetainers`), `InvoiceCard` (now returning only the invoice `DocumentRow` plus the "more invoices" note), then the collect section, then the sync facts. Its `ACTION_GROUP` is gone.
- `InvoiceCard.tsx`: keeps `useAitoInvoice`, its `data-testid="invoice-block"`, and renders `DocumentRow` + note. Its `PaymentBlock` moves up to `BillingCard` so the collect section can be ordered after all rows; `InvoiceCard` therefore exposes the invoice to the parent via a render-prop-free approach: `BillingCard` calls `useAitoInvoice(project)` itself (the query is shared and cached, so this is one request) and passes `invoice` down to `InvoiceCard` as a prop. `useAitoInvoice` keeps its signature.
- `PaymentBlock.tsx`: the `link_pending` rule above. `StateLine` gets an `onManageLink` callback; the cells' JSX branches on `state.kind === 'link_pending'`.

### i18n

New keys under `aito` in all 13 locales, run `npm run check:i18n` (cognates go in the per-locale allowlists as usual):

`retainerLabel`, `retainerStatus.{draft,sent,paid,partially_paid,void}`, `printRetainer`, `downloadRetainer`, `sendRetainer`, `sendRetainerTitle`, `sendRetainerLoadFailed`, `retainerEmailed` ("Retainer invoice emailed to {{email}}"), `retainerEmailFailed`, `retainerPrintFailed`, `retainerDownloadFailed`, `retainerOpenInZoho`, `invoiceDatesTitle` ("{{date}} · due {{due}}"), `paymentLink.manage` ("Manage the payment link"), `history.retainerEmailed`.

Removed keys (unused after the change, confirmed by grep before deletion): `aito.invoiceTotalLabel`, `aito.invoiceBalanceLabel`. `common.date` stays (used elsewhere).

## Testing

Backend (`backend/tests/unit/`):
- `test_aito_retainers.py`: resolver membership (attached, referenced, neither, dedupe, empty quote_id), the list route (404 project, `[]` without quote, 502 on Zoho errors, url built), the PDF route (inline disposition, filename from number, 404 for a foreign id), email content, send (Zoho-first ordering, 400 on unknown recipient, 409 duplicate, event recorded, re-read failure returns pre-send row).
- `test_aito_permissions.py`: `POST /retainer-email` added to `WRITE_ROUTES`.
- `test_zoho_service.py`: the four new client methods hit the expected paths and payloads.

Frontend (`frontend/src/__tests__/`):
- `AitoDocumentRow.test.tsx`: label/number/status/amount, tooltip, Books anchor present/absent, send slot hidden when not passed.
- `AitoBillingCard.test.tsx`: row order (quote, retainers, invoice), retainer rows only when the query resolves, no retainer request when `mayHaveRetainers` is false, collect section after the rows, sync facts unchanged, `ACTION_GROUP` no longer in the card (`getAllByRole('button')` counts).
- `AitoInvoiceCard.test.tsx`: reduced to the row + note; the Date/Total/Balance assertions are replaced by the tooltip and line-2 assertions.
- `AitoPaymentBlock.test.tsx`: `link_pending` shows two cells and the label button; every other state shows three; label is a span without `canUpdate`.
- `AitoSendInvoiceButton.test.tsx` + `useSendInvoiceMutation.test.tsx`: unchanged; new cases for `kind: 'retainer'` (cache row replaced, retainer toast).
- `AitoPageAitoPermissions.test.tsx`: send buttons absent without update permission for all three rows.

Manual: the sandboxed server recipe (`sandboxed-test-server` memory) cannot exercise Zoho; the retainer rows are verified against the real dev backend once the branch is merged and `:8000` restarted by the user, on a project known to have a retainer (DEV26-2638 has a paid deposit).

## Rollout notes

- No migration.
- The dev `:8000` instance runs without `--reload`; the new routes are live only after the user restarts it.
- `static/` is rebuilt in its own commit after merge, per repo convention.

## Implementation notes

- `resolve_project_retainer` lives in `routes/aito.py` as `_resolve_project_retainer`, beside `_resolve_project_invoice`, since it raises `HTTPException`; the service module exposes only `list_project_retainers` and `map_retainer`.
- `aito.retainerOpenInZoho` was not added: the retainer row reuses `aito.invoiceOpenInZoho` ("Open in Zoho Books"), the same words.
- `retainerDownloadFailed` was not added: the download button reuses `retainerPrintFailed`, as the invoice's does.
