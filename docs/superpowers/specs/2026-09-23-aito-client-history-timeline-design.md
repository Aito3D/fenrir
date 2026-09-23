# Aito client history timeline — design

Date: 2026-09-23. Branch `aito-client-timeline`. Chosen from three static
propositions shown in Brave (A · Spine); the demo page lives in the session
scratchpad only.

## Goal

From the expanded project card, the operator can see every project the same
client ever had, in chronological order, each identified by its project id,
its quote number and its total. The list opens from the client name itself
(a 0.5 s hold) and from a small history button beside the existing pencil.

## What the operator sees

### Trigger

- In the panel masthead the client name becomes a `HoldButton`
  (`durationMs={500}`, `progress="bar"`, `pressEffect="none"`,
  `hintPlacement="bottom"`, `radiusClassName="rounded-md"`, a green fill
  `bg-bambu-green/20`). The button's `label` is the client name, so the `<h2>`
  keeps announcing the client name; the `hint` is the hold instruction
  (`aito.clientHistoryHint`). A short tap shows the hint the way every other
  hold button does; releasing before 500 ms does nothing.
- A `History` (lucide) icon button appears next to the pencil, revealed by the
  same `group-hover/client` rule and reachable by keyboard, `aria-label` =
  `aito.clientHistory`. It opens the same dialog on click. It sits BEFORE the
  pencil so the pencil keeps its place at the end of the row.
- Both affordances render only when the card has a client that can have a
  history: `project.client_id` is set AND is not the walk-in default contact
  (`['zoho-status', { probe: false }]` → `default_contact_id`, the same query
  and `isWalkIn` rule `ClientEditor` uses). Until the status resolves, the
  name is the plain span it is today. Walk-in and no-client cards keep the
  plain span and no history button.
- They are not gated on `canUpdate`: reading history needs `aito:read`, which
  anyone who can open the panel has.

### Dialog

`ClientHistoryModal` — a centred overlay dialog in the pattern of
`CreateInvoiceModal` (`fixed inset-0 bg-black/50 z-[110]`,
`animate-overlay-in/out`, `Card role="dialog" aria-modal="true"`,
`useDismissableDialog(onClose, { animationMs: 170 })`, `max-w-[600px]`,
`max-h-[88vh]`, scrolling body). Escape and a backdrop click close it. It is
rendered by `ProjectDetailPanel` (panel state `historyOpen`), so it is its own
layer above the panel and never touches the masthead's height.

Header:
- kicker `aito.clientHistory` ("Client history");
- the client name with the company/person glyph, same rule as the masthead;
- a summary line `aito.clientHistorySummary`:
  "{{count}} projects · {{total}} · since {{date}}" with `_one`/`_other`
  forms. `count` = number of rows; `total` = `formatMoney` of the sum of the
  totals of the rows whose `quote_status` is not `declined` (a declined quote
  was never revenue); `date` = the oldest row's `created_at` as a month + year.
  With one row the "since" part still shows that row's month.

Body — an ordered list (`<ol>`), newest first, exactly the endpoint order:
- A year marker (`<li>` with the year, diamond on the rail) precedes the first
  row of each year.
- Each row: date (day + short month, year underneath), a dot on the rail, and
  a block with:
  - `#id` in mono + the quote number in mono, or `aito.clientHistoryNoQuote`
    ("no quote") in italics when `quote_number` is null;
  - the total (`formatMoney(total, currency)`), right-aligned, bold;
  - the description on one line, `truncate`;
  - a chip: `Declined` (red, `quote_status === 'declined'`), else the column
    label from `columns.ts` (`Done` cyan, anything else neutral).
- Dot colour: cyan on `done`, green on any other column, red ring when
  declined.
- The row for the card the dialog was opened from is tinted green
  (`bg-bambu-green/[0.07] border-bambu-green/35`), carries `aria-current="true"`,
  its chip reads `aito.clientHistoryThisCard` ("This card · {{stage}}") and it is
  NOT a button.
- Every other row is a `<button type="button">` whose accessible name is the
  row's text. Activating it calls `onOpenCard(id)`. If the panel does not pass
  `onOpenCard` the rows render as plain blocks (tests, or a caller without the
  page's swap handler).

States:
- Loading: the header renders at once; the body shows a `Loader2` spinner with
  `aria-busy`.
- Error: `aito.clientHistoryError` in the body with a Retry button.
- Empty (`cards` is `[]`, e.g. a client whose only card is this one after a
  trash): `aito.clientHistoryEmpty` — cannot happen for a normal card because
  the current card is itself a row, but the state exists for an unknown id.

### Opening another card

`ProjectDetailPanel` gets an optional prop `onOpenCard?: (id: number) => void`.
`AitoPage` passes `(id) => setExpandedId(id)` — a plain swap, no card morph:
the panel already holds the shared view-transition name, and
`useCardMorph.open` would claim it twice. The page keys the panel on
`expandedProject.id` so the swap is a fresh mount (draft state and the
contact sheet never bleed from one project to the next; the tab is
session-sticky on purpose — see `usePanelTab` — so it survives the swap).
Because the swap
replaces `project`, the dialog itself is unmounted by the remount; the panel
closes `historyOpen` before calling `onOpenCard` anyway.

`expandedProject` is looked up in the board query and the trash query; every
history row is an active card and therefore in the board query, so the swap
always finds it. (The board query holds `done` cards too — `DoneGrid` renders
from it.)

## Data

Extend `GET /api/v1/aito/clients/{client_id}/history`, additively:

- `AitoClientHistoryCard` gains `quote_number: str | None`,
  `quote_status: str | None`, `description: str`. The drawer ignores them.
- `limit` ceiling rises from 20 to 200 (`le=200`). The dialog asks for 200
  (`CLIENT_TIMELINE_LIMIT` exported by the modal), which is more cards than any
  client of the shop has; the drawer keeps asking for 5. Two limits mean two
  React Query keys: the dialog uses
  `['aito-client-history', clientId, CLIENT_TIMELINE_LIMIT]`, `staleTime
  60_000`, and never collides with the drawer's `['aito-client-history', id]`.
- Semantics unchanged: active cards only (trashed excluded, `done` included),
  newest `created_at` first with id as tiebreak, walk-in default contact
  returns `[]`, tasks still included (the drawer needs them; 200 × a few tasks
  is small).
- Currency for `formatMoney`: the same source the panel's `BillingCard` uses
  (`project.currency` / the settings currency it already reads).

The TS mirror `AitoClientHistoryCard` gains the three fields as REQUIRED
(`quote_number: string | null`, `quote_status: string | null`,
`description: string`). `tsconfig.app.json` excludes tests, so every fixture
that builds a history card must be swept by grep on `latest_social` /
`column:` — `__tests__/components/AitoClientHistory.test.tsx`,
`NewProjectDrawer.test.tsx`, `mocks/handlers.ts`.

## Files

Backend:
- `backend/app/schemas/aito.py` — three fields on `AitoClientHistoryCard`.
- `backend/app/services/aito_client_history.py` — populate them.
- `backend/app/api/routes/aito.py` — `le=200` on the history `limit`.
- `backend/tests/unit/test_aito_client_history.py` — fields present, limit 200
  accepted and 201 rejected.

Frontend:
- `frontend/src/api/client.ts` — TS mirror.
- `frontend/src/components/aito/ClientHistoryModal.tsx` — new (dialog +
  timeline + `CLIENT_TIMELINE_LIMIT` + summary helper). If the react-refresh
  export rule objects to the constant/helper, they move to
  `clientHistoryTimeline.ts` beside it.
- `frontend/src/components/aito/ProjectDetailPanel.tsx` — `historyOpen`
  state, the HoldButton name, the History button, `onOpenCard` prop, the modal
  render.
- `frontend/src/pages/AitoPage.tsx` — `onOpenCard`, `key`.
- `frontend/src/i18n/locales/*.ts` (14 locales) — keys `aito.clientHistory`,
  `clientHistoryHint`, `clientHistorySummary_one/_other`,
  `clientHistoryNoQuote`, `clientHistoryThisCard`, `clientHistoryDeclined`,
  `clientHistoryOpenCard` ("Open project #{{id}}", the row button's title),
  `clientHistoryEmpty`, `clientHistoryError`. Real translations everywhere —
  the parity gate rejects values identical to EN. `clientHistoryClose` above
  was never added: the close button reuses the pre-existing `common.close`
  instead.
- Tests: `__tests__/components/AitoClientHistoryModal.test.tsx` (new) and
  cases in `ProjectDetailPanel.test.tsx`.

## Tests

Backend:
- the three new fields come back for a card with a quote and are
  `None`/`None`/description for a hand-made card;
- `limit=200` is accepted, `limit=201` is a 422;
- existing ordering/exclusion tests unchanged.

Frontend, modal:
- rows come out in endpoint order with a year marker before each year's first
  row; ids, quote numbers, totals and descriptions render; "no quote" for a
  null number;
- the current card's row has `aria-current` and no button; other rows are
  buttons; clicking one calls `onOpenCard` with the id; without `onOpenCard`
  no buttons;
- summary counts every row but sums only non-declined totals;
- loading, error (Retry refetches), empty;
- Escape calls `onClose`.

Frontend, panel:
- holding the name for 500 ms (fake timers, `fireEvent.pointerDown` +
  `advanceTimersByTime(500)`, the `AitoHoldButton.test` pattern) opens the
  dialog; releasing at 200 ms does not;
- the History button opens it; it is absent on a walk-in card and on a card
  with no `client_id`; before `zoho-status` resolves the name is a plain span;
- choosing a row closes the dialog and calls the panel's `onOpenCard`.

Page: `AitoPage` passes a handler that swaps `expandedId` (one test: with two
projects in the board mock, open card A, trigger the panel's `onOpenCard(B)`,
the panel now shows B's client). Panel `key` verified by the same test (A's
contact sheet open → B mounts closed).

## Out of scope

- Any change to the drawer's recall block.
- Rows for trashed cards, or a link to the trash.
- Filtering, search, or export of the list.
- Persisting the dialog across a card swap (it closes by design).
