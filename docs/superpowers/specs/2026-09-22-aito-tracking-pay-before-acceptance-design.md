# Aito tracking page: pay before acceptance

Date: 2026-09-22. Amends §7.3 of `2026-09-12-aito-heimdall-payment-links-design.md` (the 2026-09-14 "only once accepted" decision is reversed).

> **Amended 2026-09-23 — partial rollback.** The link is offered only once the quote has **left the Devis column**: `quote_status` in `sent`, `viewed` (the client opened a sent quote — it only ever arrives from Books) or `accepted`. A draft, or a card with no Books quote, hides a pending link again: the quote is not finalised, its total can still move. The gate lives in `aito_tracking.PAYABLE_QUOTE_STATUSES`. Everything else below stands — the `accepted` flag, the "Validez votre devis" voice on a sent quote, and "Devis validé" in Accord — except the Devis state-card sub-line `devisPaySub`, which became unreachable and was removed with its 13 translations. Neither the "from the moment it exists" nor the "only once accepted" gate is what the operator wants: paying validates a *sent* quote.

## Goal

A client can validate a quote by paying it online from the public tracking page, from the moment the quote exists in Zoho Books — draft included, before it is sent. Payment already accepts the quote (`aito_payment_links._became_paid` → `accept_quote(source="payment_link")`, which marks a draft sent in Books before accepting it); this change only makes the link visible and words the page so paying reads as validating.

## Backend

- `aito_tracking.payment_state`: drop the `row.status == "pending" and quote_status != "accepted"` gate. A live pending link with a Heimdall id is shown as `unpaid` with its URL whatever the quote status. The reconciler already refuses a link for declined/expired/invoiced/total-less quotes, and `compute_tracking` still 404s a closed quote. Paid still drops the URL.
- `AitoTrackingResponse` gains `accepted: bool` (`quote_status == "accepted"`). Nothing else in the payload moves.
- No Heimdall call from the public route, as before.

## Frontend (`AitoTrackPage`)

`accepted` drives copy in two places; `payable = payment?.state === 'unpaid' && !!payment.url`.

1. Payment card (`TrackingPayment`), unpaid and `!accepted`: title `validateTitle` "Validez votre devis"; sub `validateSub` "Le règlement en ligne vaut acceptation du devis." or, when `deposit`, `validateDepositSub` "Un acompte valide votre devis et lance la fabrication." Button and terms toggle unchanged. Accepted → today's "Projet non réglé" copy.
2. State card (`statusCopy` in `utils/aitoTracking.ts`), given `accepted` and `payable`:
   - `devis` column, payable and not accepted: sub becomes `devisPaySub` "Vous pouvez déjà le valider en réglant en ligne ci-dessous." (title unchanged).
   - `waiting` column, accepted: title `acceptedTitle` "Devis validé", sub `acceptedSub` "Nous planifions la fabrication." (fixes the existing "En attente de votre accord" above "Acompte reçu" gap).
   - Everything else unchanged.

Five new keys under `aito.track` in all 13 locales, real translations (the i18n gate rejects English placeholders). The page does not show the amount; a client paying a draft first sees the total on the checkout page (accepted trade-off, 2026-09-22).

## Not changing

Board panel, operator copy-link flow, retainer sweep, follow-up rules, notification on payment, the paid→accepted path.

## Tests

- Backend `test_aito_tracking_payment.py`: the "hidden until accepted" parametrised test becomes "shown for draft/sent/viewed/accepted"; `accepted` flag asserted true/false in the response test.
- Frontend `AitoTrackPage.test.tsx`: validate copy (full and deposit), Devis sub-line with a payable link, "Devis validé" in waiting when accepted, unchanged copy once accepted. Fixture gains `accepted: false` (tsc never type-checks tests — sweep by grep).
- Locale parity test picks up the keys automatically.
- Verification: `npm run build`, `./test_frontend.sh`, `./test_backend.sh`, screenshots of the three states via the demo backend.
