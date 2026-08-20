# Aito — Send Invoice by email

**Date:** 2026-08-19
**Status:** approved, ready to plan

## Problem

The Aito project panel can email a quote to the client (`SendQuoteButton` →
`SendQuoteModal` → `POST /aito/{id}/quote-email`). The Invoice card below it
offers only Print. An operator who wants to send the bill has to leave
Bambuddy and do it in Zoho Books.

Add the same affordance to the Invoice card: a Send button that opens a modal
showing the recipient, the subject, and the rendered email body, and sends it
through Books.

## Scope

In scope: preview + send for the invoice shown on the Invoice card, its
timeline event, and the i18n for all 13 locales.

Out of scope: choosing between several invoices (the card already shows the
newest and says how many others exist), editing the subject/body, attaching
files, and any board-column behaviour.

## Decisions

**No board side effects.** Sending a quote moves the card Quote → Waiting
because a quote going out *is* a board transition. An invoice going out is
not: there is no invoice-driven column in `columns.ts`. So the send records
one timeline event and nothing else. This removes the whole `marked_sent`
tri-state and its `except SQLAlchemyError` degrade — there is no local write
that can half-succeed.

**The send is pinned to the invoice the operator saw.** Books can raise
several invoices from one estimate, and the card renders from a read cached
for up to 5 minutes (`INVOICE_STALE_MS`). Resolving "the newest" server-side
at send time would email a document whose number the operator never saw if a
second invoice was raised while the panel sat open. The client therefore
passes `invoice_id`, and the server treats it exactly as `get_invoice_pdf`
does: candidates are always resolved from the project's own estimate via
`list_project_invoices`, and `invoice_id` may only NARROW that set — checked
for membership, never trusted — so it cannot address another customer's
invoice by walking ids.

**Zoho-first, like the quote send.** Nothing is written locally until Books
confirms. A timeline entry for an email that never left is worse than no
entry.

## Backend

### `services/zoho.py`

Two methods, mirroring the estimate pair directly above them:

- `get_invoice_email_content(db, invoice_id) -> dict` — `GET
  /invoices/{id}/email`, unwrapping Books' `data` envelope into
  `{subject, body, recipients}`. Contact persons with no address are dropped:
  offering one is offering a send that must fail.
- `email_invoice(db, invoice_id, *, to_mail_ids) -> None` — `POST
  /invoices/{id}/email` with only `to_mail_ids`. `subject`/`body` are omitted
  on purpose so Books renders its own default invoice template, the one
  carrying the org's branding; echoing back the HTML we were handed would
  round-trip the template through this app for no gain. Books marks the
  invoice `sent` as a side effect.

### `schemas/aito.py`

`AitoQuoteEmailRecipient` is reused as-is — an address is an address, and a
parallel `AitoInvoiceEmailRecipient` with identical fields would be noise.
New:

- `AitoInvoiceEmailContent` — `subject`, `body`, `recipients`,
  `default_email: str | None`, plus `invoice_id` and `invoice_number` so the
  modal can name the document it is about to send and echo the id back on
  POST.
- `AitoInvoiceEmailRequest` — `to: str`, `invoice_id: str | None`.

The POST response is `AitoInvoiceResponse` — the invoice re-read after the
send, so the card's status flips from Draft to Sent without a second round
trip.

### `routes/aito.py`

- `GET /{project_id}/invoice-email?invoice_id=…` (`AITO_READ`)
- `POST /{project_id}/invoice-email` (`AITO_UPDATE`)

Both share a `_load_invoice_email_content` helper that resolves the project,
404s when it has no `quote_id`, resolves candidates through
`list_project_invoices`, applies the `invoice_id` narrowing rule above, and
fetches Books' prefill. Recipients are widened with the project's own
`client_email` when Books does not already offer it, and that address becomes
the default — the same reasoning as `_quote_email_content`: it is an address
a human attached to this card on purpose, and dropping it would leave a
hand-attached client unsendable. Books' failures map through the existing
`_quote_email_http_error` (renamed `_zoho_email_http_error`, since it now
serves four routes): `ZohoNotFound` → 404, `ZohoRequestRejected` → 400,
anything else → 502, and the isinstance order stays load-bearing.

POST re-reads the recipient allowlist and rejects anything outside it with
422. Trusting the caller's address list would make this an open relay: any
authenticated user could send arbitrary addresses mail from the company's
Zoho account on the company's own template. The same accepted residual as the
quote route applies — a holder of `AITO_UPDATE` can widen the allowlist by
editing the card's `client_email` first, which is audited as its own
`project.updated` event.

On success: `record(..., "invoice.emailed", detail={"email", "invoice_number"})`,
commit, `_broadcast_changed("invoice-email", …)`, return the re-read invoice.
A failure re-reading the invoice for the response must not 500 the request —
the mail has gone out and the event is committed — so that read degrades to
returning the pre-send invoice.

`invoice.emailed` is added to `aito_events.py` as a `"story"` event, like
`quote.emailed`.

## Frontend

- `SendInvoiceButton.tsx` — `Mail` icon + label, the same pill classes as
  `SendQuoteButton`, gated on having an invoice. It sits beside
  `InvoicePrintButton` in the Invoice card's action row; both become
  `flex-1 justify-center`, so the row reads as one pair of equals rather than
  a primary and an afterthought.
- `SendInvoiceModal.tsx` — the structural twin of `SendQuoteModal`:
  `z-[110]` overlay (the panel's own backdrop is `z-50`), `max-w-2xl` card
  (Books' templates are fixed-width tables), `max-h-[90vh] flex flex-col`
  with the button row outside the scroll region, single-select recipient
  dropdown with no free-text entry, Escape-to-close disabled mid-send.
- `useSendInvoiceMutation.ts` — a plain `useMutation`, not
  `useOptimisticBoardMutation`: the email IS the act, so nothing is predicted.
  On success it writes the returned invoice into `['aito-invoice', projectId]`
  and invalidates `['aito-events', projectId]`. One success toast; no
  `marked_sent` branch to mirror.
- `QuoteEmailPreview` → `ZohoEmailPreview`. A pure rename plus its `title`
  fallback key: both modals now feed it, and its DOMPurify / `sandbox=""` /
  in-document CSP triple-layer is unchanged. That layering is load-bearing
  and documented in the file — the rename must not touch it.
- `client.ts` — `AitoInvoiceEmailContent` interface, `getAitoInvoiceEmail`,
  `sendAitoInvoiceEmail`.

## i18n

New keys under `aito.`: `sendInvoice`, `sendInvoiceTitle`,
`sendInvoiceRecipient`, `sendInvoiceSubject`, `sendInvoiceMessage`,
`sendInvoiceConfirm`, `sendInvoiceNoRecipients`, `sendInvoiceLoadFailed`,
`invoiceEmailed`, `invoiceEmailFailed`, and `aito.history.invoiceEmailed`.
Written properly in all 13 locales — the parity gate rejects English
placeholders in non-English files.

## Tests

Backend (`backend/tests/unit/test_aito_invoice_email.py`):

- preview returns Books' subject/body and widens recipients with
  `client_email`, which is also the default
- an address outside the allowlist is refused with 422 and no mail is sent
- an `invoice_id` belonging to another project 404s and no mail is sent
- a project with no quote, and one whose estimate has no invoice, 404
- Books failing the send records no event and returns the mapped status
- a successful send records exactly one `invoice.emailed` event
- the invoice re-read failing after a successful send still returns 200 with
  the event committed

Frontend: `AitoSendInvoiceButton.test.tsx` (renders only with an invoice,
opens the modal) and `AitoSendInvoiceModal.test.tsx` (prefill lands and
preselects, send posts the chosen address and the pinned `invoice_id`, error
keeps the modal open), mirroring the existing quote tests.
