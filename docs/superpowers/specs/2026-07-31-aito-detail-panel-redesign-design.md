# Aito Detail Panel Redesign — Design

Date: 2026-07-31
Status: approved (variant F, "Rail")

## Problem

`ProjectDetailPanel` shows everything about a project at one visual weight. A
1600px-wide dialog holds three columns; the left column is ten `label: value`
rows styled identically, so "Created by: admin" reads as loudly as the client's
name. The three facts an operator actually wants at a glance — who it is, what
it is worth, where it is — are the hardest to find: the client name is row one
of a spec sheet, the money lives in the tasks column header, and the stage is a
2px dot at the bottom of the list.

Three further problems, in descending order of how often they bite:

1. **The Done control is small.** A step is ticked through a 60×20px outline
   pill at the end of a row. It is the most-pressed control in the panel and the
   smallest.
2. **Progress is only ever a step count.** Seven steps on this project are worth
   between 3 500 and 10 000 FCFP each. "3/7" says nothing about how much of the
   job's value is done.
3. **Delete sits beside Close.** `DeleteHoldButton` and the close button are
   12px apart in the header — the most destructive control adjacent to the most
   routine one. The hold gesture mitigates a misclick; it does not justify the
   adjacency.

## Shape of the solution

Keep the three-column skeleton — it is right for the wide desktop this is used
on — and rebuild the hierarchy inside it. Add one new object, the **stage rail**,
which answers "where is this project and what is left before it moves" in a
single widget.

### 1. Header

The header carries the identity of the record instead of a bare `Project #28`.

```
PROJECT #28 · DEV26-2461 ↗ [Accepted]
SARL Sécurité Tahiti Import                         ◔  42 000 FCFP
📞 +689-89384863   ✉ sacha.mostarac@outlook.com        11 500 done · 3/7 steps
```

- Eyebrow: project ref, quote number (linking to Zoho when `quote_url` is set),
  quote status pill.
- Title: `client_name`, falling back to `t('aito.noClient')`. This is already the
  dialog's `aria-label`; it becomes its visible name too.
- Contacts: the existing `CopyableValue` components, promoted out of the `<dl>`.
  Rendered only when the field is non-null, as today.
- Right: a progress ring and the project total. The ring is **value-weighted** —
  money done over money total — not step count. The line beneath gives both
  numbers so neither reading is lost.

**No close button.** Escape (already handled) and click-outside (already handled)
are the two ways out. This is a deliberate call by the user; the consequence is
handled in "Focus" below.

### 2. Stage rail (new)

Replaces the `Stage:` row. A vertical list of the seven columns, in board order,
in the left column of the body. Each stage that owns work carries a progress bar
and the money still outstanding at that stage.

```
STAGE & WORK LEFT
● Quote
● Waiting
◉ Scan
  ▰▰▰▰▰▰▰▰▰▰  0 FCFP
○ Modeling
  ▰▰▰▱▱▱▱▱▱▱  4 500 FCFP
○ Printing & Machining
  ▱▱▱▱▱▱▱▱▱▱  26 000 FCFP
○ Finish
○ Done

Parked in Scan until every Scan step is ticked.
```

**The rail is read-only.** This is not a simplification, it is a correctness
requirement: a project's column is *derived* by the board rule engine
(`evaluate` in `utils/aitoBoardRules.ts`, mirroring
`backend/app/services/aito_board_rules.py`) from the quote status and the set of
services with unticked steps. The only manual transition in the whole model is
Finish ↔ Done, and that already lives on the card. A clickable stage would have
to either no-op or fight the rule engine.

Stage-to-service mapping comes from the existing `STAGES` constant, which is
already the authority and is pinned by the contract fixture. It is **read**, not
extended — `aitoBoardRules.ts` is a mirror of the Python rule engine held in
place by a generated fixture, so the UI's aggregation helper lives in
`components/aito/services.ts` instead:

| Stage    | Services                  |
| -------- | ------------------------- |
| `scan`   | `scan`                    |
| `model`  | `modelisation`            |
| `print`  | `impression`, `usinage`   |

Printing and machining share one column while remaining two steps on a task, so
the `print` row aggregates both. Stages with no services (`devis`, `waiting`,
`finish`, `done`) render as a labelled node with no bar.

The closing sentence is driven by `project.move_lock`, which the backend already
computes and ships:

| `move_lock` | Sentence                                                    |
| ----------- | ----------------------------------------------------------- |
| `quote`     | Waiting for the quote to be accepted.                       |
| `waiting`   | Out with the client.                                        |
| `declined`  | The quote was declined.                                     |
| `steps`     | Parked in {stage} until every {stage} step is ticked.       |
| `null`      | (nothing — the card is free to move between Finish and Done) |

This is the first surface that explains *why* a card sits where it does. Today
that reasoning is invisible everywhere.

### 3. Left column

Grouped cards instead of one flat `<dl>`:

1. **Product description** — unchanged behaviour (click to edit, Escape reverts,
   Cmd/Ctrl+Enter saves, blur saves, `SaveIndicator`). First, because it is what
   the job *is*: the rail tells you where the work has got to, but only after
   you know what the work is.
2. **Stage & work left** — the rail above.
3. **Fine print** — seller, created, last activity, plus `QuoteStatusActions`.
   Borderless, `text-bambu-gray`, smaller. These are the rows that currently
   compete with the client name; they stop competing.

#### Who, after the when

`Created by` stops being a row of its own and joins the timestamp it belongs to.
Both timestamp rows read `{when} · {who}`:

```
Seller          Paul Theis
Created         7/28/26, 2:00 AM · admin
Last activity   7/30/26, 10:07 PM · admin
```

The fine print drops to a **short** date-time —
`toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' })`
rather than the current bare `toLocaleString()`. `{when} · {who}` has to fit one
line in a 16.5rem column and the full form does not; second-level precision in a
greyed-out footnote is precision nobody reads, and the exact timestamps are
still in the timeline a column away.

**Created** takes its actor from `project.created_by`. When that is null — auth
disabled, an API-key request, or a card predating the column — the row still
says so rather than trailing off: `{when} · unknown`. The current design makes
the same point with an em dash on its own row, and the information is worth
keeping.

**Last activity** has no `updated_by` to read: `AitoProject` carries
`created_by` and nothing equivalent for writes, and adding one would mean
touching every mutation path (description edits, task CRUD, the quote worker,
the status reconciler) to write a column that would be null or "system" for most
of them. The event log already models exactly this, properly, with `actor_class`
distinguishing user from client from system.

So the row is sourced from **the newest event**, fetched with the existing API:

```ts
api.getAitoEvents(projectId, { depth: 'everything', limit: 1 })
```

`depth: 'everything'` is required, not incidental. Reusing the events the
`ActivityRail` has already loaded would be free, but that list is filtered by
the rail's depth toggle — so the name in the fine print would silently change
when the reader flipped Story/Detail/Everything. A separate one-row query is one
request and always the same answer.

**Both halves come from that event** — its `occurred_at` and its actor, not
`updated_at` paired with someone else's name. These can genuinely disagree: a
mirrored Zoho comment carries Books' timestamp rather than ours, which is the
whole point of storing `occurred_at` separately from `created_at`. Pairing
`updated_at` with the newest event's actor would produce a line where the time
and the name describe two different things.

Actor rendering follows the timeline's own rules, so the two surfaces never
disagree about a name:

| Case | Renders |
| ---- | ------- |
| `actor_name` set | the name (`admin`, `Zoho Books`, `Co-gérants`) |
| null, `actor_class: 'user'` | unknown user |
| null, `actor_class: 'client'` | the client |
| null, `actor_class: 'system'` | automatic |

When the project has **no events at all** — one created before the history
feature landed — the row falls back to `updated_at` with no actor suffix. That
is the one case where the timestamp does come from the project row, and it
carries no name precisely because none is known.

The query is `staleTime`-shared with nothing and invalidated by the same
`['aito-events', projectId]` key the note mutation and the update mutation
already invalidate, so adding a note or editing the description refreshes this
row for free.

Precisely where each surviving row goes:

| Row today | Where it goes |
| --------- | ------------- |
| Company / client name | Header title |
| Phone, Email | Header contacts |
| Quote number + Zoho link | Header eyebrow; the print button moves to the footer |
| Seller | Fine print |
| Created + Created by | Fine print, folded into one `{when} · {who}` row |
| Last activity | Fine print, gains its actor from the newest event |
| Stage | Replaced by the rail |
| Sync state / retry button | Full-width row above the fine print |
| Status block, declined message | Full-width row above the fine print |

The sync, status-block and declined messages keep their current logic and copy
**verbatim**, including which `quote_sync_state` values each renders for and the
deliberate independence of the block message from the sync row. Those are the
conflict reports the current design went to some trouble not to lose, and this
redesign must not lose them either. They stay full-width and keep
`text-status-error` where they have it.

### 4. Task column

`TaskEditor` and `TaskRow` keep their structure. Three changes:

- **Per-task progress**: a hairline bar under the task header and an `n/m`
  count beside the money. Reuses `ProjectProgress`, which already takes
  `{done, total}` and already renders nothing at zero.
- **The whole step row becomes the toggle.** `TaskStepList` currently wraps only
  the Done pill in a `<button>`; the button expands to the row and gains a
  checkbox on the left. Roughly a 3× larger target for the most-used control.
  The `canTick` rule is untouched: with no accepted quote there is no toggle at
  all, and an already-ticked step still renders ticked.
- **Stage swatch**: a 2px stage-coloured bar at the head of each step row, using
  the same colours as the board columns (`ColumnMeta.dot`). The board and the
  step list start speaking the same colour language.

### 5. Footer bar (new)

```
[🗑 Move to trash]                      [🖨 Print quote]  [↗ Open in Zoho]
```

Destructive action at the far left, safe actions at the far right, maximum
distance between them. Solves a second problem for free: `QuotePrintButton` and
the Zoho link are currently bare icons crammed into a `<dd>`, and they get a
real home.

The trash control stays `DeleteHoldButton` — same hold-to-confirm, same copy,
new location. It remains absent entirely for a project already in the trash
(`onDelete` undefined), exactly as today.

## Focus

Removing the close button removes the element that currently receives focus on
mount (`closeRef`). Without a replacement, focus stays on whatever was behind
the dialog: Escape still works (the handler is on `window`), but Tab order
starts outside the modal and screen readers announce nothing on open.

The dialog element itself takes `tabIndex={-1}` and receives focus on mount
instead. It already has `role="dialog"`, `aria-modal="true"` and an `aria-label`,
so focusing it announces the panel by its client name. The existing
`editingRef` guard — Escape closes the panel unless a description edit is open —
is unchanged.

## Motion

Everything reuses tokens already in `index.css`:

- Panel entrance keeps the existing view-transition morph from the card
  (`AITO_CARD_VT_NAME` / `useCardMorph`). Untouched.
- Progress bars and the ring animate width/`stroke-dashoffset` over 300ms
  `var(--ease-signature)`, matching `ProjectProgress`'s existing transition.
- Ticking a step keeps the current split: the check mark pops immediately
  (`animate-tick-in`), the row's colours settle over 300ms. The rail's bar and
  the header ring join that 300ms settle, so one tick produces one coordinated
  motion across three places rather than three unrelated ones.
- Every transition carries `motion-reduce:` variants, as the existing components
  do.

## Non-goals

- No backend change. Every field needed — `column`, `move_lock`, `task_pending`,
  `steps_total`, `steps_done`, `tasks_total` — is already on `AitoProject`, and
  the last-activity actor comes from the existing events endpoint rather than a
  new `updated_by` column.
- No change to the board, the card, `NewProjectModal`, or `ImportQuoteModal`.
  `TaskEditor` is shared with the create modal, so its changes must stay
  behaviour-compatible there (`canTick={false}` already yields no toggles).
- Not making the rail interactive. See above.
- No new dependency.

## Risks

- **`TaskEditor` is shared.** Changes to `TaskStepList`'s markup affect
  `NewProjectModal`. Mitigated by `canTick` already gating the toggle, but the
  create modal must be checked by hand.
- **Tests reference the old structure.** `aito-progress-fill` is an existing
  `data-testid`; adding per-task bars means several elements will carry it
  unless the per-task bars get their own. They will.
- **i18n.** New copy needs keys in all 13 locales, and the i18n gate rejects
  English placeholders. Every new string must be translated, not stubbed.

## Files

| File | Change |
| ---- | ------ |
| `components/aito/ProjectDetailPanel.tsx` | Rebuilt layout; header, footer, focus |
| `components/aito/StageRail.tsx` | New |
| `components/aito/TaskStepList.tsx` | Row-wide toggle, checkbox, stage swatch |
| `components/aito/TaskRow.tsx` | Per-task progress bar and count |
| `components/aito/columns.ts` | Export a raw stage colour alongside `dot` |
| `components/aito/services.ts` | New `stageOf(service)` / per-stage aggregation helper |
| `i18n/locales/*.ts` | New keys, 13 locales |

`ProjectDetailPanel.tsx` is 525 lines before this change and will grow. The
header, the fine-print list and the footer come out as local components in the
same file; the stage rail is big enough and independent enough to be its own
file.
