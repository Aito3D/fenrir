# Aito: the accept gate — steps, quote actions, imported dates, and the Books transition

**Date:** 2026-07-29
**Status:** approved, ready for an implementation plan

## Goal

Make acceptance the one visible gate on the Aito board, and fix the Books
transition that gate depends on.

Four changes, one theme. The rule engine already treats acceptance as the
single gate — `evaluate()` in `backend/app/services/aito_board_rules.py` sends
every non-accepted status to `devis`, `waiting` or `done`, so ticking a step on
an unaccepted quote moves nothing. The UI has not caught up: it still offers
the controls, and it still tells an imported card it was created today.

1. **The step Done toggle only exists on an accepted quote.** Today it renders
   on every step of every project, where for most statuses it is a control that
   demonstrably does nothing.
2. **An imported card is as old as its quote.** A quote imported from three
   weeks ago currently reads "Today" on the board.
3. **The quote actions show only what is still possible.** Mark-as-sent is
   offered on quotes the client already has; a declined quote still offers
   actions.
4. **Zoho refuses `accepted` on a draft estimate.** Confirmed from the live
   org, not inferred — see Evidence.

## Evidence

`logs/bambuddy.log:2319-2327`, 2026-07-29 11:41:

```
WARNING [backend.app.api.routes.aito] Could not set Zoho estimate
        66407000009527651 to accepted for project 21
backend.app.services.zoho.ZohoRequestRejected:
        Le statut du devis ne peut être changé en Accepté
```

Books returned **400** refusing the direct move to Accepted. The board wrote
`accepted` locally (correct, and by design — the local write always wins so the
board renders with Zoho unreachable) and reported `zoho_synced=False`.

Two facts this settles:

- Books enforces the documented estimate lifecycle: `draft` → `sent` →
  `accepted`/`declined`. There is no shortcut.
- **The rejection message is localised.** It came back in French, the org's
  locale. Nothing may pattern-match Zoho's message text to detect this
  condition; the status must be read, not parsed out of prose.

## Change 1: the Done toggle requires an accepted quote

### Frontend

`TaskStepList` gains a required `canTick: boolean`. When false the `<button>`
is not rendered at all and the row is name + cost — not a disabled button, not
a hint line. Before acceptance there is no authorised work to tick, so there is
nothing to explain.

`TaskRow` and `TaskEditor` pass the prop through. **Required, not defaulted:** a
default is exactly how `NewProjectModal` would silently inherit the wrong
answer as this code changes.

- `ProjectDetailPanel` passes `project.quote_status === 'accepted'` — the same
  comparison `QuoteStatusActions.tsx:55` already makes. No new response field,
  and nothing re-derived that the rule engine owns; this is one status
  equality, not a second copy of the rules.
- `NewProjectModal` passes `false`. A project being created has no quote.

Deliberately untouched, because they render stored state rather than offer a
control: `TaskStepFields` (edit mode has no Done toggles), the collapsed row's
`ServiceBadges`, and the green `isTaskFinished` border. A project whose quote
was declined after work was ticked keeps showing those ticks as history.

### Backend

One helper beside the existing merge loop in `update_task`: reject
`<service>_done: true` when the parent project's `quote_status != "accepted"`,
**422**, shaped like the no-cost rule already there ("a done flag may not be
set for a service with no cost").

Applied at all three writers, because `AitoTaskBase` carries all four `*_done`
flags and every one of them accepts a payload:

- `update_task` — needs the parent project loaded **before** the merge loop.
  Today `_mark_project_pending_for_task` loads it afterwards; that call moves up
  and its return value feeds both the guard and the existing `_apply_rules`.
- `add_task` — the project is already in hand.
- `create_project` — checked against `payload.quote_status`, so an import that
  legitimately arrives already-accepted may carry ticked steps.

Clearing a flag to `false` stays legal at every call site. A tick stranded by a
status flip must always be undoable.

### Leaving accepted

When a quote moves off `accepted` the stored ticks are **kept**, not cleared.
The rule engine already sends a declined project to `done` with
`move_lock: "declined"`, so the ticks are inert history rather than live state,
and clearing them would be unrecoverable if the flip was a mistake.

## Change 2: an imported card is as old as its quote

`create_project` sets `created_at` from `quote_date` when the payload carries a
`quote_id`. Import posts through the same `POST /` as a manual card
(`AitoPage.tsx:357-373`), so the `quote_id` guard is what distinguishes them and
a hand-made card keeps the real creation instant.

**The hour is 12:00, and that is load-bearing.** `quote_date` is a date-only
`VARCHAR(10)`, `created_at` is an instant, and `parseUTCDate`
(`frontend/src/utils/date.ts:206`) reads backend timestamps as UTC. Midnight UTC
renders as the previous calendar day everywhere west of Greenwich — every
install in the Americas would show the wrong date. Noon keeps the rendered day
correct from UTC−11 to UTC+11. UTC+12/+13 (NZ, Fiji) still read a day late; no
single instant can satisfy every offset, and this band covers the deployment
that exists.

`quote_date` is a client-supplied string, so it is parsed with
`datetime.strptime(value, "%Y-%m-%d")` inside a `ValueError` guard — anything
unparseable or absent falls through to the column's `server_default`. Python
3.10 target: the value is naive, matching the column, with no `datetime.UTC`.

`updated_at` stays *now*. The panel then reads "Created 15 Jul / Last activity
today", which is accurate for a card imported today from an older quote.

Consumers that change as a result, both intended: `formatElapsedTime` on the
card (`CardView.tsx:64`) and the "Created" row in the detail panel. Board
ordering is by `board_column`/`position` and the trash by `updated_at`, so
neither reorders.

## Change 3: the quote actions show only what is still possible

`QuoteStatusActions` renders nothing at all when `quote_status` is `accepted`
**or** `declined`. Acceptance authorises the work and a decline ends it; past
either, the quote is settled and a correction belongs in Books, not next to a
job on the board.

Mark-as-sent renders only while the client does not yet have the quote —
`quote_status` null or `draft`. On `sent`, `viewed` and `expired` the client has
it already, so offering to mark it sent says nothing true.

Accept and Decline render in every remaining case (null, `draft`, `sent`,
`viewed`, `expired`) and are never disabled-with-a-check: the only statuses that
would have drawn a check now hide either that single button or the whole block.
`isSent`, `isDeclined` and the `Check` import all leave the component.

Resulting matrix:

| `quote_status`             | Block                        |
|----------------------------|------------------------------|
| null, `draft`              | Mark sent · Accept · Decline |
| `sent`, `viewed`, `expired`| Accept · Decline             |
| `accepted`, `declined`     | *(nothing)*                  |

This **reverses** the component's current documented reasoning ("whichever
action matches the current status is disabled rather than hidden: a control that
vanishes reads as a bug, and its check mark is how the panel says where the
quote already stands") and the deliberate choice to keep mark-as-sent live on
`viewed`/`expired` for re-sending. The docstring is rewritten to the hide rule;
the old argument is not left standing next to code that contradicts it.

**Accepted consequence:** re-accepting a declined quote must happen in Books,
since the board offers no way back. Symmetric with the existing accepted rule,
and both actions are hold-to-confirm, so intent is already proven before the
state becomes terminal.

## Change 4: Books needs the estimate sent before it can be accepted

`zoho.py` keeps `set_estimate_status` as the primitive — one POST, no
cleverness — and gains:

```
advance_estimate_status(db, estimate_id, target, *, current=None) -> None
```

When `target` is `accepted` or `declined` and the estimate is still a draft, it
POSTs `/status/sent` first, then the target. `current` lets a caller that
already holds the authoritative status skip the read; when it is `None` the
method reads the estimate with the existing `get_estimate`.

Call sites:

- `set_quote_status` (`routes/aito.py`) passes no `current` and pays for one
  `get_estimate`. It could instead read the local `quote_status`, but the
  model's own docstring says that snapshot goes stale
  (`aito_project.py:42-47`: accepting a quote in Zoho does not update the card),
  and one extra read on a user-initiated action costs nothing worth saving.
- `_reconcile_status` (`aito_quote_sync.py:278`) passes `current="declined"`
  from the estimate it was already handed — no extra read. Its restore branch
  puts a quote back to `sent` or `accepted`, so it has the same exposure.

The status is always read, never inferred from Zoho's message text. See
Evidence.

`/status/sent` marks the estimate sent; it does not email the client (Books
emails through a separate endpoint). That is the same meaning our own
mark-as-sent button carries, so chaining through it changes nothing for the
client.

## Testing

**pytest**

- `test_aito_routes.py` — the 422 matrix: `PATCH done=true` on a non-accepted
  project → 422; on an accepted one → 200; `done=false` on a declined project →
  200 (an untick is always possible); `POST` a task with `done=true` on an
  unaccepted project → 422; `POST /` with `quote_status="accepted"` and a ticked
  task → 201.
- `test_aito_routes.py` — `created_at` is the quote date at 12:00; an
  unparseable `quote_date` falls back to *now*; a create with no `quote_id`
  keeps *now*. These belong here, not in `test_aito_quote_import.py`: that file
  unit-tests the `aito_quote_import` parser and never touches the route.
- `test_aito_quote_sync.py` — with a mocked service: a draft estimate produces
  `/status/sent` then `/status/accepted`, **in that order**; an already-sent one
  produces a single POST; `_reconcile_status`'s restore issues no extra
  `get_estimate`.

**Vitest**

- `AitoTaskStepList.test.tsx` — the toggle renders with `canTick`, and is absent
  without it while name and cost still render.
- `AitoQuoteStatusActions.test.tsx` — rewritten to the matrix above, including
  the two statuses that render nothing.

**The type checker will not help here.** `frontend/tsconfig.app.json` excludes
`src/__tests__`, so neither `npx tsc --noEmit` nor `npm run build` type-checks
test files: the new required prop produces **no compiler error** in them. The 17
existing render sites — 12 in `TaskEditor.test.tsx`, 5 in
`AitoTaskStepList.test.tsx` — are swept by grep, not by the build.

**No new i18n keys**, so no 12-locale sweep: change 1 adds no hint string and
change 3 only removes rendering.

## Verification limits

Change 4 is derived from a confirmed 400 plus Books' documented lifecycle, but
the chain cannot be verified from this environment without writing to a real
customer estimate. It needs one live confirmation: accept a card whose quote is
still a draft and check that the `Could not set Zoho estimate` warning no longer
appears in `logs/bambuddy.log`.

## Out of scope

- **Clearing ticks when a quote leaves accepted.** Decided against above.
- **An escape hatch for re-accepting a declined quote.** Books is the place for
  that correction, per change 3.
- **A timezone-exact rendering of a date-only quote date.** Change 2 buys the
  correct calendar day across a −11..+11 band with one constant; a display-side
  fix would be exact everywhere but would make "Created" mean two different
  things depending on the card, and would leave an API consumer reading the
  import instant.
- **Re-querying Zoho to refresh a stale `quote_status` snapshot.** The snapshot
  is a deliberate trade (`aito_project.py:42-47`); change 4 reads the
  authoritative status only where it is about to write.
