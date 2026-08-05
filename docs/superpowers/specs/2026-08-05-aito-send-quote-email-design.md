# Send Quote by email — Aito detail panel

Date: 2026-08-05
Status: approved, ready for planning

## Problem

The Aito detail panel's Quote card can print a quote but cannot send one. Emailing
a quote to the client today means leaving the app for Zoho Books, doing it there,
and then coming back to hold "Mark as sent" so the card leaves the Quote column.
Two systems, one act, and a board that is only correct if the user remembers the
second half.

## Goal

A **Send quote** button beside **Print quote** in the Quote card. It opens a small
modal with a recipient dropdown (defaulted to the client's email), and Send emails
the quote through Zoho Books using the organisation's default estimate template.
When the card is in the Quote column, a successful send marks the quote sent and
moves the card to Waiting.

## Decisions

| Question | Decision |
| --- | --- |
| Where the dropdown's addresses come from | Zoho's own recipient list for this estimate (`GET /estimates/{id}/email` → `to_contacts`) |
| Subject and body | Read-only preview. Zoho's template is the single source of truth |
| Card not in the Quote column | Send anyway; status and column untouched |
| Zoho refuses the send | Nothing changes locally — no event, no status, no move |
| Backend shape | One dedicated endpoint pair, `GET`/`POST /aito/{id}/quote-email` |

### Why Zoho-first, against the local-first convention

Every other Aito write is local-first: the board records a decision a human already
made, and the Zoho push is best-effort and reported as `zoho_synced`. That is right
there and wrong here. In `POST /aito/{id}/quote-status`, the decision exists whether
or not Books hears about it. In this feature the email **is** the act — a card parked
in Waiting after a failed send is a lie about a message the client never received.
So the local write happens only after Zoho confirms.

### Why the recipient is validated server-side

`to` must be one of the addresses Zoho offered for this estimate, or the project's
`client_email`. Without that check the endpoint is an open relay: any authenticated
user could send arbitrary addresses mail from the company's Zoho account, over the
company's own template and branding.

## Backend

### `backend/app/services/zoho.py`

```python
async def get_estimate_email_content(db, estimate_id) -> dict
```

`GET /estimates/{id}/email`. Books answers under `data` with `subject`, `body`,
`emailtemplates` (the org default flagged `selected`) and `to_contacts` — each
carrying `contact_person_id`, `email`, `first_name`, `last_name`, `selected`.
Mapped to a flat shape by a module-level `_map_email_recipient`, following the
`_map_contact` / `_map_estimate_summary` convention already in the file:

```python
{"subject": str, "body": str, "recipients": [{"email", "name", "contact_person_id"}]}
```

`name` is built with the existing `normalize_display_name` so a contact person
reads the same here as everywhere else in the app.

```python
async def email_estimate(db, estimate_id, *, to_mail_ids: list[str]) -> None
```

`POST /estimates/{id}/email`, body containing **only** `to_mail_ids`. Subject and
body are deliberately omitted so Books renders its own default estimate template —
that is what "the right default template" means here. The GET is preview-only;
echoing its HTML back through our layer would round-trip the template for no gain
and give us a way to corrupt it.

Both go through the existing `_request`, so token refresh, org scoping, the
401-retry-once and the error mapping are inherited unchanged.

### `backend/app/api/routes/aito.py`

**`GET /aito/{project_id}/quote-email`** — `Permission.AITO_READ`.

Returns `{subject, recipients[], default_email}`. 404 when the project is missing,
deleted, or has no `quote_id`. `default_email` prefers the recipient matching
`project.client_email` (case-insensitive), then Zoho's own `selected` entry, then
the first. When Zoho returns no recipients but the project has a `client_email`,
that address is served as the sole recipient — a hand-attached email is still a
real address to send to.

**`POST /aito/{project_id}/quote-email`** — `Permission.AITO_UPDATE`, body `{to: str}`,
response `{project, marked_sent: bool}`.

1. Load the project; 404 when missing, deleted, or without `quote_id`.
2. Fetch the estimate's email content and build the allowlist (its recipients plus
   `client_email`). A `to` outside it is a **422**, raised before any send. This
   costs a second Zoho round trip per send, deliberately: an allowlist the client
   supplies is not an allowlist, and the addresses may have changed in Books since
   the modal opened.
3. `email_estimate(...)`. Any Zoho exception aborts here: nothing is written, no
   event is recorded, the card does not move.
4. On success, `record(..., "quote.emailed", detail={"email": to})`.
5. **If `project.column == "devis"`**: `adopt_quote_status(project, "sent")`, clear
   `quote_status_block` and `quote_status_remote`, `await _apply_rules(...)`,
   `record(..., "quote.sent")`, and `marked_sent = True`.
6. Commit, refresh, return `_to_response(project, summary, await _shipping_names(db))`.

Step 5 gates on `column`, not on `quote_status`, because that is the rule as stated —
and `aito_board_rules.evaluate` derives one from the other, so the two cannot disagree.

It deliberately does **not** call `advance_estimate_status`: Books already marks the
estimate sent as a side effect of emailing it, and a second status POST would be a
redundant round trip that can fail on its own.

### Error mapping

Matching `GET /aito/{id}/quote.pdf`, and ordered so subclasses are caught first:

| Raised | HTTP |
| --- | --- |
| `ZohoRequestRejected` | 400, with Books' own message (this is what surfaces "no email address for this contact") |
| `ZohoNotFound` | 404 |
| `ZohoUpstreamError`, `ZohoNotConfiguredError` | 502 |

`ZohoRequestRejected` and `ZohoNotFound` both subclass `ZohoUpstreamError`, so the
`except` order is load-bearing.

### Event registration

`quote.emailed` must be added to `KINDS` in `backend/app/services/aito_events.py`
at level `"story"`. `record()` refuses and logs an unregistered kind rather than
writing it, so an unregistered event is silently lost.

## Frontend

### `components/aito/SendQuoteButton.tsx`

Same gate as print (`project.quote_id`, else render nothing), same pill styling as
`QuotePrintButton`'s `withLabel` form, `Mail` icon from lucide. Owns the modal's
open state and nothing else.

### `components/aito/SendQuoteModal.tsx`

A small dedicated modal on the existing `Card` / `Button` primitives, following
`ConfirmModal`'s structure — fixed overlay, Escape to close (but not mid-send).

Overlay at **`z-[110]`**: `ProjectDetailPanel`'s own backdrop is `z-50`
(`ProjectDetailPanel.tsx:704`), so anything lower renders behind the panel that
opened it.

Contents:

- **Recipient `<select>`**, options from `recipients`, pre-selected by
  `default_email`. Single-select, no free-text entry — the server-side allowlist is
  the security boundary and the UI must not offer what the API will reject. Widening
  the sources later widens `recipients` server-side and this dropdown grows for free.
- **Subject**, read-only muted text.
- **Body preview**, read-only, in a bounded `max-h` scroll container. Zoho returns
  HTML; it is rendered as **plain text**. No `dangerouslySetInnerHTML` — a preview
  is not worth an injection surface fed by an upstream template.
- **Cancel / Send**, Send showing a spinner while in flight.

Three prefill states beyond the happy path: loading (spinner, Send disabled), error
(Zoho's message plus Retry, Send disabled), and empty — no recipients and no
`client_email` — which says the client has no email address instead of showing an
empty dropdown.

### `hooks/useSendQuoteMutation.ts`

Mirrors `useQuoteStatusMutation`'s success handling: write `result.project` into the
`['aito-projects']` cache, invalidate `['aito-events', project.id]`, success toast
`aito.quoteEmailed`.

**Not optimistic**, and this is the one place it deliberately departs from
`useQuoteStatusMutation`: the card must not move before Zoho confirms the send. On
error the modal stays open and shows the failure, so the user can retry or pick a
different address without rebuilding their selection.

### `components/aito/ProjectDetailPanel.tsx`

Line 902 becomes a `flex gap-2 mt-3` row holding both buttons at `flex-1`. The
comment above it currently argues full-width *because print is alone in the card*;
it is rewritten, not left to contradict the code.

### Registration

- `quote.emailed` → `components/aito/history/eventKinds.ts` with an icon and label key.
- New i18n keys in **all 13** locale files with real translations. The parity gate
  rejects English placeholders in non-English locales.

## Testing

### `backend/tests/unit/test_aito_quote_email.py`

Following `test_aito_quote_status.py`. Monkeypatching goes on the `zoho_service`
**instance**, not the class — a class-level patch leaks across tests in this suite.

- GET: 404 without a project, 404 without `quote_id`, 502 on upstream failure.
- GET: `default_email` prefers `client_email` over Zoho's own `selected` flag.
- GET: no Zoho recipients but a `client_email` present → that address is the sole option.
- POST rejects an address outside the allowlist with 422 and **without calling Zoho at all**.
- POST with a Zoho failure: 502, project asserted unchanged — still `devis`, same
  `quote_status`, zero events written.
- POST success from `devis`: column `waiting`, status `sent`, `marked_sent` true,
  both `quote.emailed` and `quote.sent` recorded.
- POST success from `waiting`, and from an accepted card: mail sent, column, status
  and `quote_accepted_at` untouched, `marked_sent` false, only `quote.emailed` recorded.
- An explicit assertion that `advance_estimate_status` and `set_estimate_status` are
  never called on this path.

### Frontend

`frontend/src/__tests__/components/AitoSendQuoteButton.test.tsx` and
`AitoSendQuoteModal.test.tsx`, alongside the existing `AitoQuotePrintButton.test.tsx`.

- Button renders nothing without `quote_id`.
- Dropdown preselects the client's email.
- Send disabled while loading, and when there are no recipients.
- The selected address is what reaches the API call.
- A body containing `<script>` / `<img onerror=...>` renders as text, not markup.

## Open item to confirm on the first real send

This design assumes emailing an **already accepted** estimate does not demote it to
`sent` in Books. If it does, the status reconciler (`aito_quote_status.py`) will
later see Books at `sent` against our `accepted` and record a conflict.

Unverified — it cannot be checked without a live org, and the Aito shipping work
carries the same caveat. If the first real send against an accepted quote produces a
conflict, the fallback is to hide the Send button once
`quote_status === 'accepted'`.

## Out of scope

CC and BCC, attachments, multiple recipients in one send, editable subject or body,
choosing a template, and any resend history beyond the event log.
