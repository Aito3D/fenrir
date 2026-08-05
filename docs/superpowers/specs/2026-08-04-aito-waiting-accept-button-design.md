# Aito Waiting-Column Accept Button — Design

Date: 2026-08-04

## Goal

Let the worker accept a quote directly from the board card in the Waiting
column, without opening the detail panel — the same way the Quote column's
card carries mark-as-sent and Finish carries mark-as-done.

## Design

One new footer action in `SortableCard` (`frontend/src/components/aito/BoardColumn.tsx`),
gated on `project.column === 'waiting'`:

- **Mechanism identical to the existing card buttons:** `HoldButton`, 500 ms
  hold, perimeter progress trace, icon-only, injected through `CardView`'s
  `actions` slot (which already stops propagation so the hold never also
  opens the card), hidden on placeholders and the drag overlay by the slot
  itself.
- **Mutation:** the `useQuoteStatusMutation(project)` instance the card
  already owns for mark-as-sent, fed `'accepted'` — so the optimistic column
  move, the toast, the Zoho push, and the Zoho-failure warning are all the
  panel's exact behaviour for free. The variable is renamed `markSent` →
  `quoteStatus` to match its widened role.
- **Appearance:** `ThumbsUp` icon in `bambu-green` (mirroring the panel's
  Accept and the amber styling pattern of mark-sent) — green is reserved for
  the one transition that authorises the work.
- **Gate:** the server-derived `project.column`, like the devis button. A
  card is in `waiting` exactly when `quote_status` is sent/viewed/expired
  (`aito_board_rules.evaluate`), so no status logic is re-derived client-side.

## Deliberately out of scope

- **No Decline on the card.** Declining is rarer and destructive-adjacent;
  it stays in the detail panel's `QuoteStatusActions`.
- No backend change: `POST /aito/{id}/quote-status` already handles
  `accepted` from the panel.
- No new i18n keys: `aito.acceptQuote` and `aito.holdToConfirm` exist in all
  locales.

## Testing

New describe block in `AitoBoardCardActions.test.tsx`, mirroring the
mark-sent/mark-done coverage: offered in Waiting, absent in every other
column, absent on placeholders, fires only after the full 500 ms hold, and
asserts the `{ status: 'accepted' }` payload literal.
