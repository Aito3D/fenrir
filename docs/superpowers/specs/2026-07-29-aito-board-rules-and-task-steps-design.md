# Aito: board rules, task steps and quote acceptance

**Date:** 2026-07-29
**Status:** approved, ready for an implementation plan

## Goal

The Aito board stops being a place where cards are dragged and becomes a place
where work is *recorded*. A project's column is derived from two things — has
its quote been accepted, and which of its task steps are ticked off — rather
than from wherever someone last dropped it.

Three changes deliver that:

1. **The board gains a rule engine.** Seven columns, and a card's column is a
   pure function of its quote status and its task steps.
2. **Tasks gain steps.** Each of the four services a task can carry becomes a
   step with its own "Done" toggle, shown in a restructured task form.
3. **The quote gains sent/accept/decline controls** on the card. Acceptance is
   what releases a project onto the board at all.

## Scope

In scope: the column set and migration, the derivation rules, per-step done
flags, the task form rework, the drag restrictions, and the sent/accept/decline
controls including their best-effort write back to Zoho Books.

Out of scope, deliberately:

- **Per-step progress on the board card.** The column already says which stage
  a project is in; a second, finer indicator on the card would say it twice.
- **Zoho → board pull.** Phase 2 of `2026-07-29-aito-project-quote-push-design.md`
  owns that. This spec writes to Zoho and never reads back.
- **Per-step assignee or due date.** A step is done or it is not.

## Columns

`pickup` is removed. `waiting`, `scan` and `done` are added. The board becomes:

| id | label (EN) | label (FR) | accent |
|---|---|---|---|
| `devis` | Quote | Devis | sky |
| `waiting` | Waiting | En attente | amber |
| `scan` | Scan | Scan | teal |
| `model` | Modeling | Modélisation | violet |
| `print` | Printing & Machining | Impression & Usinage | orange |
| `finish` | Finish | Finition | brand green |
| `done` | Done | Terminé | neutral grey |

Printing and machining stay merged in one column, as they are today. They
remain **separate steps** on a task — the column is simply left once both are
ticked on every task that has them.

Finish keeps the brand green because it is the accomplishment; Done is neutral
because it is the archive. The board is a horizontally-scrolling flex row
(`AitoPage.tsx:544`), so seven columns need no layout change.

## The rule engine

A new pure module, `backend/app/services/aito_board_rules.py`.

A **step** is a (task, service) pair whose cost column is not NULL. `NULL`
means the service is absent from the job; `0` means it is quoted at zero — a
real step, which still shows, still needs its tick, and still holds the card in
its column. This is the same NULL/0 distinction the rest of the Aito code
already enforces (`services.ts`, `_task_summaries`), extended to steps.

Stages map to services:

| stage | services |
|---|---|
| `scan` | `scan` |
| `model` | `modelisation` |
| `print` | `impression`, `usinage` |

```
derive_column(quote_status, stored_column, tasks) -> column

  1. quote_status == 'declined'                     → 'done'
  2. quote_status in (sent, viewed, expired)        → 'waiting'
  3. quote_status != 'accepted'                     → 'devis'   (NULL included)
  4. first stage, in board order, holding at least one
     enabled-but-unticked step                      → that stage
  5. otherwise                                      → 'done' if stored_column == 'done'
                                                       else 'finish'
```

Rules 2 and 3 split the pre-acceptance life of a quote in two. **Quote** means
the shop is still writing it — a draft, or a card with no Zoho quote at all.
**Waiting** means it has left the shop and the answer is the client's to give:
`viewed` only says they opened it, and `expired` says they never answered, so
both are still waiting on them. An expired quote parked in Waiting is a visible
prompt to chase it, which it would not be buried back in Quote.

Acceptance remains the single gate onto the work columns, whichever side of it
a card is waiting on. A project with no Zoho quote is accepted locally, with no
Zoho call.

Rule 5's carve-out is the only place the stored column is believed, and it is
what lets **Finish ↔ Done** be a genuine manual drag inside a derived model.
Un-tick anything and rule 4 fires first, pulling the card back out of Done.

### Where it runs

**Backend only.** The frontend gets no second copy in TypeScript.

The board response already carries `column`; it gains one field, `move_lock`,
computed from which rule fired:

| rule | `move_lock` | meaning |
|---|---|---|
| 1 | `'declined'` | the quote was declined |
| 2 | `'waiting'` | the quote is with the client |
| 3 | `'quote'` | pinned to Quote until the quote is accepted |
| 4 | `'steps'` | the column is set by the task steps |
| 5 | `null` | free to move between Finish and Done |

The card renders its lock badge and tooltip from that value, and a drag enables
exactly the droppables it allows. Nothing derives anything client-side, so the
two languages cannot drift — unlike the `taskTotal` / `_task_summaries` pair,
which the codebase has to keep in sync by hand and documents as such.

### When it runs

The column is stored, not computed on read: per-column ordering and `position`
depend on it. It is recomputed on every mutation that can change it —
project create, task create/update/delete, any quote status change, project
restore — and the result is written to `board_column`.

When a recompute moves a project, it is **appended to the end** of the
destination column and the source column is renumbered contiguously. Work
arriving at a stage joins the back of that stage's queue; the operator reorders
by hand from there.

## Drag rules

Reordering **within** a column is always allowed, on every card, whatever its
lock. Priority order inside Scan, Modeling and Printing is what tells the
operator what to do next, and changing it changes no state.

Cross-column drag is allowed only when `move_lock` is `null`, and then only
between `finish` and `done`.

Signalled in one place and enforced in two, deliberately redundant:

- **`CardView`** (signal) — the grip keeps its `GripVertical`, because the card
  is still reorderable, and gains a small lock badge with a `title` naming the
  reason.
- **`BoardColumn`** — `useDroppable({ disabled })` for every column outside the
  allowed set, so `dragOver` never relocates the card there in the first place.
- **`PATCH /aito/{id}/move`** — 409 when `payload.column` differs from the
  project's current column and the Finish↔Done exception does not apply.

## Data model

`aito_tasks` gains four booleans mirroring its four cost columns:

| column | type |
|---|---|
| `scan_done` | `BOOLEAN NOT NULL DEFAULT 0` |
| `modelisation_done` | `BOOLEAN NOT NULL DEFAULT 0` |
| `impression_done` | `BOOLEAN NOT NULL DEFAULT 0` |
| `usinage_done` | `BOOLEAN NOT NULL DEFAULT 0` |

Two invariants, both enforced in `PATCH /aito/tasks/{id}`:

- Clearing a cost to `NULL` also forces its done flag to `false`, so a
  re-enabled step never comes back pre-ticked.
- Setting a done flag `true` for a service whose cost is `NULL` is a **422**.
  A step that does not exist cannot be completed.

No new columns on `aito_projects`: `board_column` and `quote_status` already
carry everything the rules read, and `move_lock` is derived, never stored.

## Migration

Additive `ALTER TABLE`s in `run_migrations()`, per the project's convention,
followed by a one-time data fix. The fix runs **only in the branch where the
`ALTER` actually added the columns** — that is its guard, and it is
self-limiting without a version table.

Without a back-fill, day one would derive every existing card to its *earliest*
incomplete stage and collapse the board leftward. So the migration
reconstructs the history from where each card already sits:

1. Add the four boolean columns.
2. Back-fill done flags from `board_column`:

   | card is in | flags set |
   |---|---|
   | `devis` | none |
   | `model` | scan |
   | `print` | scan, modelisation |
   | `pickup`, `finish` | all four |

3. `UPDATE aito_projects SET quote_status = 'accepted'` where
   `board_column != 'devis'` and `quote_status` is NULL or not already
   `accepted`/`declined`. A card that is already past Quote was accepted in
   reality; a `declined` one is left alone and will derive to `done`.
4. `board_column`: `'pickup'` → `'finish'`.
5. Run `derive_column` over every project — soft-deleted rows included, so a
   later restore lands correctly — and renumber `position` contiguously per
   column.

Step 5 matters: the migration leaves the board *self-consistent under the new
rules*, not merely close to its old shape.

Step 3 leaves cards in `devis` with their status untouched, which is what lets
rule 2 sort them on first load: an imported card whose quote was already `sent`,
`viewed` or `expired` lands in Waiting without the migration knowing the column
exists.

**Known consequence:** every card sitting in the Quote column on the day this
ships becomes locked in Quote or Waiting until Accept is held on it. That is
the intended workflow, but without warning it reads as the board having frozen.

## API

### Schemas

- `AitoTaskCreate`, `AitoTaskUpdate`, `AitoTaskResponse` gain the four
  `*_done` booleans. On create they default to `false`.
- `AitoProjectResponse` gains `move_lock: 'quote' | 'declined' | 'steps' | null`.

### `POST /aito/{project_id}/quote-status`

Body `{"status": "sent" | "accepted" | "declined"}`, guarded by
`Permission.AITO_UPDATE`.

`sent` is here because nothing else in the app can produce it: the status
otherwise only ever arrives by importing a quote that was already sent in Zoho,
which would leave the Waiting column unreachable for a hand-made card.

1. Write `quote_status` locally and re-derive the column. This happens first
   and always: the board must be correct with Zoho unreachable, which is the
   rule the rest of the Aito code follows.
2. When `quote_id` is set, call Zoho. When it is not — a hand-made card — skip
   silently; there is nothing to update.

Response is a wrapper, `{"project": AitoProjectResponse, "zoho_synced": bool}`,
rather than a field bolted onto the project: the frontend writes `project`
straight into the board cache with `setQueryData`, and a transport detail has
no business living in a cached board row.

A Zoho failure is logged and returned as `zoho_synced: false` — never a
non-200. The frontend toasts "saved locally, Zoho not updated".

### `ZohoService.set_estimate_status(db, estimate_id, status)`

`POST /estimates/{estimate_id}/status/{status}`, with `status` restricted to
`sent`, `accepted` and `declined`. Zoho has no `/status/draft`, and a declined
estimate cannot be returned to draft — established by probing in the push
design.

`/status/accepted` and `/status/declined` were both exercised against the live
org during that design. **`/status/sent` was not** — it is documented by Zoho
but unverified here, so its failure path is the one to watch on first use. It
costs nothing if it is wrong: the local write has already happened and the
response simply reports `zoho_synced: false`.

## Frontend

### Task list

`TaskRow` currently carries the header, four cost inputs, the impression block
and remove — enough that it is the file to split while working in it. It
becomes a shell plus two bodies:

- **`TaskRow`** — chevron, title, service badges, total, then `[Edit] [Remove]`
  (edit before remove).
- **`TaskStepList`** (new) — read mode.
- **`TaskStepFields`** (new) — edit mode.

**Read mode** lists only steps that exist, each with its cost and a Done
toggle. A `0`-cost step is listed like any other. A task with no steps yet
shows a short empty state and its Edit button.

Done is a one-click toggle both ways, with `aria-pressed` — no hold. Un-ticking
is the undo, and it must be cheap. When every step on a task is ticked the row
turns green with a check by its title, legible collapsed as well as expanded,
and the collapsed row's service badges dim per ticked step. That dimming is an
optional prop on `ServiceBadges` used only by the task row — the board card's
badges are project-level and stay as they are, per the scope note above.

**Edit mode** replaces the current three-column cost grid plus the bolted-on
impression section with one titled block per step: Scan, Modeling, Printing
(cost plus the existing `ImpressionFields`), Machining. All four blocks are
always present here; a block with no cost is dimmed, and typing a cost is what
creates the step. That is the "hidden outside edit mode" rule's other half.

Edit state lives in `TaskEditor` beside the existing expanded-keys set, keyed
identically by `rowKey`. A freshly added task opens **expanded and in edit
mode** — read mode on a task with no steps would be an empty box.

### Toggling a step

A tick is a deliberate click, not a keystroke, so unlike the cost fields it
invalidates `['aito-projects']` immediately rather than on panel close. The
panel's Stage row and the card behind it update together. The existing
on-close, in-flight-counted invalidation for cost edits is untouched.

### Quote actions

A new `QuoteStatusActions` in the panel's left column, directly under the quote
rows where the quote number and salesperson already sit. Three hold-500ms
buttons — Mark as sent, Accept, Decline — all always visible; whichever matches
the current status is disabled and shows a check.

`DeleteHoldButton`'s press-and-hold mechanic is extracted into a `HoldButton`
that all three controls share, rather than copying the timer twice.

### Files

| file | change |
|---|---|
| `api/client.ts` | `AitoColumnId` union, `move_lock`, task done fields, `setAitoQuoteStatus` |
| `components/aito/columns.ts` | new column set and accents |
| `utils/aitoBoard.ts` | `COLUMN_IDS`, `emptyBoard` |
| `components/aito/CardView.tsx` | lock badge and reason tooltip |
| `components/aito/BoardColumn.tsx` | `useDroppable({ disabled })` |
| `pages/AitoPage.tsx` | allowed-target set for the active drag |
| `components/aito/TaskRow.tsx` | reduced to the shell |
| `components/aito/TaskStepList.tsx` | new |
| `components/aito/TaskStepFields.tsx` | new |
| `components/aito/TaskEditor.tsx` | edit-mode key set |
| `components/aito/ServiceBadges.tsx` | dim a ticked step's badge |
| `components/aito/HoldButton.tsx` | new, extracted |
| `components/aito/DeleteHoldButton.tsx` | built on `HoldButton` |
| `components/aito/QuoteStatusActions.tsx` | new |
| `components/aito/ProjectDetailPanel.tsx` | wire the actions in |
| `utils/taskDraft.ts` | done flags on `TaskDraft` and its mappers |

## Edge cases

- **A project with no tasks, or no enabled steps, once accepted → Finish.**
  Rule 4, and it is correct: there is no work to do. Adding a task with a cost
  derives it back to that stage, pulling it out of Finish or Done.
- **A step ticked, then its cost cleared.** The done flag is cleared with it,
  and the step no longer holds the card — it does not exist any more.
- **A task deleted.** Recompute; a project can jump forward because the only
  task holding it back is gone.
- **A declined card.** Sits in Done with `move_lock: 'declined'`. Accepting it
  reopens it and re-derives normally.
- **A card in Waiting.** Locked there whatever its tasks say — the work has not
  been authorised yet, so ticking a step on it changes nothing on the board.
  Accept releases it and rule 4 then places it by its steps, so a quote
  accepted after some steps were already ticked lands correctly rather than at
  Scan.
- **A soft-deleted project.** Off the board entirely; restore re-derives.

## Testing

**Backend**

- `test_aito_board_rules.py`: table-driven over `derive_column` — every rule,
  the three statuses that mean Waiting, and the two easy to get wrong:
  un-ticking pulling a card back *out* of Done, and rule 5 believing the stored
  column only between Finish and Done.
- Migration: back-fill produces the expected flags per source column, `pickup`
  lands in `finish`, and every project's column satisfies `derive_column`
  afterwards.
- `PATCH /tasks/{id}`: clearing a cost clears its done flag; ticking a
  non-existent step is 422; a tick recomputes the project's column.
- `PATCH /{id}/move`: 409 on an illegal column, 200 on a reorder within a
  column, 200 on Finish↔Done when `move_lock` is null.
- `POST /{id}/quote-status`: local write and column change for all three
  statuses, including `sent` landing the card in Waiting; Zoho called with the
  right status; Zoho raising still returns 200 with `zoho_synced: false`; a
  project with no `quote_id` never calls Zoho.

**Frontend**

- Read mode hides absent steps and shows a `0`-cost one.
- The Done toggle PATCHes and invalidates the board.
- An all-ticked task renders green, collapsed and expanded.
- A newly added task opens in edit mode.
- The lock badge and tooltip render per `move_lock`, and the disabled-droppable
  set matches it.
- Hold-to-accept fires at 500ms and not before.

## Risks

- **i18n across 12 locales.** New keys for the Scan and Done columns, the
  Done/undo toggle, Edit, three lock reasons, accept/decline and their toasts —
  each needing a real translation, since the i18n gate rejects English
  placeholders.
- **`pickup` is referenced outside type-checked code.** `AitoColumnId` is a
  union in `client.ts`, so production code fails to compile — but
  `tsconfig.app.json` excludes `src/__tests__`, so `aitoBoard.test.ts`,
  `AitoBoardColumnDrag.test.tsx` and `AitoPage.test.tsx` compile fine and fail
  at runtime. They must be swept by grep, not trusted to the compiler.
- **The migration is one-way.** Rolling back leaves cards in `scan` and `done`,
  which the old column set drops from the board (`buildBoard` filters unknown
  columns). A DB backup before deploy is the mitigation.
