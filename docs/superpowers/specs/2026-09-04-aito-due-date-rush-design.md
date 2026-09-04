# Aito due date and rush surcharge — design

Date: 2026-09-04. Status: approved in chat, awaiting written review.

First of six features picked in the 2026-09-03 brainstorm (due date, follow-ups
strip, print backlog hours, pipeline widget, repeat-client recall, client
tracking page). Each is its own spec and branch; the follow-ups strip and the
tracking page both read the due date this spec introduces.

## Goal

1. **Due date** — one optional date per Aito project, promised to the client
   and set by hand. Visible on the board card and in the detail panel, editable
   in the panel and the new-project drawer. An overdue card rises to the top of
   its column like an urgent one.
2. **Rush surcharge** — a per-task toggle that adds a configurable percent to
   the task's pre-tax price. Available on the calculator page and on every Aito
   print task through the same pricing function. The due date alone never
   changes a price.

## Non-goals

- No suggested or computed date. The date is whatever the operator typed.
- No requested-versus-promised pair. One date.
- The date does not appear on the Zoho estimate, the quote PDF, the invoice, or
  any email. It is internal until the client tracking page ships.
- The rush surcharge is folded into the impression line's rate. No separate
  Books item, no export or re-import handling, no PDF row.
- No automatic rush from the date, no tiers by lead time.
- No recompute of stored `impression_cost` on existing projects.
- Rush applies to the print service only. Scan, modeling and machining prices
  are typed by hand and the operator can rush them by typing a higher figure.

## 1. Data model

Three additive columns, all via `run_migrations()` ALTER TABLE statements.

| Table | Column | Type | Meaning |
|---|---|---|---|
| `aito_projects` | `due_date` | `VARCHAR(10)`, nullable | ISO calendar date `YYYY-MM-DD`, the day promised to the client. NULL means no promise. Same representation as `quote_date`. |
| `aito_tasks` | `impression_rush` | `BOOLEAN NOT NULL DEFAULT 0` | The print step is quoted at the rush rate. |
| `calculator_defaults` | `rush_pct` | `FLOAT NOT NULL DEFAULT 0` | Surcharge percent, `0 ≤ rush_pct ≤ 500`. |

`due_date` is **not** a member of `VERSIONED_FIELDS`. Like `flag`, it is a
local scheduling fact with no Zoho mirror; setting it must not bump
`version`, must not queue a quote push, and must not churn `quote_sync_state`.
Last write wins between two users, and the board broadcast makes the loser see
it within a second.

`impression_rush` **is** a priced field. It rides through the existing task
create/patch routes and their `_mark_pending_if_ours` call, exactly like
`impression_quantity`, because a change to it changes the Zoho line rate.

### Validation

- `due_date` is validated as a real calendar date (Pydantic `date` in the
  request schema, serialized back to the ISO string). Any past date is
  accepted: a promise already broken is still the promise.
- `impression_rush` on a task with no print step is accepted and stored but
  has no effect, mirroring how `impression_discount_pct` behaves.

## 2. API

### `PATCH /api/v1/aito/{project_id}/due-date`

Body `{"due_date": "2026-09-12"}` or `{"due_date": null}`. Modelled line for
line on `set_project_flag`:

- `Permission.AITO_UPDATE`, no new permission.
- 404 on trashed/missing project via `_get_active_project_or_404`.
- Idempotent: re-sending the stored value returns 200 with no event and no
  broadcast.
- Records exactly one event per real change (see §3), commits, calls
  `_broadcast_changed("due_date", project.id, actor)`, refreshes, returns
  `AitoProjectResponse`.
- Does **not** call `_mark_pending_if_ours`. A test asserts `quote_sync_state`
  and `version` survive the call unchanged.

### Project response

`AitoProjectResponse` gains `due_date: str | None`. The list, trash, create,
move, flag, contacted and restore responses all pick it up through
`_project_response`.

### Create

`AitoProjectCreate` gains optional `due_date` so the drawer sets it in the
same request that creates the project. Creating with a date records
`project.created` as today plus one `project.due.set` event, in that order.

### Tasks

`AitoTaskCreate`, `AitoTaskUpdate` and `AitoTaskResponse` gain
`impression_rush: bool` (default `False` on create, `None` = unchanged on
update). The `/import` route leaves it `False`: a Zoho quote carries no rush
fact.

### Board ordering

`list_projects` orders by `board_column`, then an **overdue term**, then
`_FLAG_ORDER`, then `position`, then `id`:

```
_OVERDUE_ORDER = case(
    (and_(AitoProject.due_date.is_not(None),
          AitoProject.due_date < bindparam("today")), 0),
    else_=1,
)
```

`today` is the server's local calendar date at request time. The `move`
route's Python re-sort (`destination.sort(key=_flag_rank)`) grows the same
term first: `(0 if overdue else 1, _flag_rank(flag))`.

Rule: overdue means strictly before today. A card due today is not overdue.
Done-column cards are never overdue for ordering purposes (they are not on the
board), and finished cards paint no badge (§4).

### Calculator defaults

`CalculatorDefaultsResponse` / `CalculatorDefaultsUpdate` gain `rush_pct`
(`ge=0`, `le=500`). It joins the curve fields in the "Margin curve" settings
tab.

## 3. Events

Two new story-depth kinds in `aito_events.KINDS`:

| Kind | Depth | `changes` |
|---|---|---|
| `project.due.set` | story | `{"due_date": {"from": "2026-09-10" or null, "to": "2026-09-12"}}` |
| `project.due.cleared` | story | `{"due_date": {"from": "2026-09-12", "to": null}}` |

Changing an existing date is one `project.due.set` with both `from` and `to`,
not a clear followed by a set: the operator made one decision. Neither kind
coalesces.

Rush changes on a task fall under the existing `task.updated` detail event,
whose `changes` payload gains the `impression_rush` key when it flips.

## 4. Frontend — board and panel

### Card (`CardView`)

- A date badge beside the age stat: the date formatted short in the current
  locale (`12 sept.` in French, `Sep 12` in English), prefixed by a small
  calendar glyph. Hidden when `due_date` is null.
- Colour by proximity, reusing the aging palette so the board keeps one
  vocabulary:

  | Days until due | Class |
  |---|---|
  | more than 3 | `text-bambu-gray` |
  | 1 to 3 | `text-amber-400` |
  | 0 (today) | `text-orange-500` |
  | past | `text-red-400` |

  Computed by a new `dueDateLevel(dueDate, now)` in `utils/aitoAging.ts`
  beside `agingLevel`, with the class map exported as complete strings
  (Tailwind cannot see fragments).
- Finished cards (`isFinished(project.column)`) paint no badge, as with flags.
- A print task with `impression_rush` shows a lightning glyph after its label
  in `TaskMiniRows`, with `sr-only` text `aito.rush`.

### Board sort (`utils/aitoBoard.ts`)

`buildBoard` sorts each column by `overdueRank(project, today)` (0 overdue,
1 otherwise), then `flagRank`, then `position`. `today` is the browser's local
calendar date. The comment there explaining why the client sort is
load-bearing (cache updates without refetch) applies verbatim.

### Panel (`ProjectDetailPanel`)

A date input in the flag control's row, `type="date"`, with a clear button
when a value is set. Saving goes through a new `useDueDateMutation` that calls
the due-date route and patches the project in the React Query cache, following
the flag mutation's optimistic pattern. Permission gate at the call site, same
as the other panel buttons.

### New-project drawer (`NewProjectDrawer`)

An optional date input under the client section. Persisted in the draft so
"hold to reset" clears it with everything else. Sent as `due_date` on create.

### Task editor (`ImpressionFields`)

A "Rush" checkbox after quantity. Toggling it recomputes `impressionCost`
through `computeImpressionCost` like every other print field. The
`ImpressionCostBand` keeps its three-segment bar; the rush amount is part of
the margin segment, and the detail table under it lists `calculator.rush` as
its own row when non-zero.

`TaskDraft.impression` gains `rush: boolean`; `fromTask`, `toCreate`,
`toUpdate` and `isTaskEmpty` are updated. Fixtures are swept by field name.

## 5. Frontend — calculator and pricing

### `pricing.ts`

- `PricingDefaults` gains `rush_pct: number`; `CURVE_DEFAULTS` gains
  `rush_pct: 0` so a defaults row from an older server prices unchanged.
- `PricingInputs` gains `rush: boolean`.
- Phase C, after the floor:

  ```
  const pre_rush_ht = total_cost + margin_global + margin_filament + margin_stuff;
  const margin_rush = inputs.rush ? pre_rush_ht * (defaults.rush_pct / 100) : 0;
  const marge = margin_global + margin_filament + margin_stuff + margin_rush;
  ```

  `PricingResult` gains `margin_rush`. `total_ht`, `total_ttc`, `margin_pct`
  and the `_qty` totals follow from `marge` unchanged.
- Rush applies after the floor deliberately: the floor is the minimum the shop
  accepts for any task, and a rush is earned on top of that minimum.
- `buildWaterfall` gains a `rush` step between `marge` and `tax`, label key
  `calculator.rush`, dropped when zero like every other step. The `marge` step
  becomes `marge - margin_rush` so the invariant (final cumulative equals
  `total_ttc`) holds.

### Calculator page

- `CalculatorInputsCard`: a "Rush" checkbox at the end of the inputs, off by
  default, not persisted between visits.
- `CalculatorBreakdownCard`: a "Rush" row under the margin group, shown only
  when non-zero.
- `CalculatorSettingsPanel`, Margin curve tab: a "Rush surcharge %" field.
  `MarginCurvePreview` and `CalculatorQuantityCurve` take `rush` from the
  inputs so the live preview reflects the toggle.
- `CalculatorQuotePage`: no change beyond the price it already prints.
  Unit = rounded task ÷ quantity as today.

### Aito

`computeImpressionCost` passes `rush: impression.rush`. Nothing else changes:
the two surfaces share one function by construction.

## 6. i18n

New keys, all thirteen locales, no English placeholders (the i18n gate rejects
EN-identical values):

- `aito.dueDate`, `aito.dueDateClear`, `aito.dueBadge` (aria label with the
  date), `aito.rush`, `aito.events.dueSet`, `aito.events.dueCleared`
- `calculator.rush`, `calculator.rushPct`, `calculator.rushHint`

## 7. Testing

### Pricing (`__tests__/utils/pricing.test.ts`)

- `rush: false` or `rush_pct: 0` reproduces the reference figures exactly.
- Rush applies on the post-floor price: a task that hits the floor with rush on
  prices at `min_task_price × (1 + rush_pct/100)`.
- `margin_rush` equals `total_ht − pre_rush_ht`; the waterfall's last
  cumulative equals `total_ttc` with a rush step present.

### Board (`__tests__/utils/aitoBoard.test.ts`, `aitoAging.test.ts`)

- Overdue ranks above urgent; two overdue cards keep flag rank then position.
- Due today is not overdue; null date ranks as not overdue.
- `dueDateLevel` at the four thresholds, computed against a fixed `now`, so
  the test does not depend on the machine's midnight.

### Backend (`tests/unit/routes/test_aito*.py`)

- Due-date PATCH: sets, changes, clears, each with the right single event;
  idempotent re-send records nothing; `version` and `quote_sync_state`
  unchanged; 404 on trashed; permission denied without `AITO_UPDATE`
  (static-closure permission test, per the client-contacted memory).
- Create with `due_date` stores it and records `project.due.set` after
  `project.created`.
- List ordering: overdue card first regardless of position; server `today`
  patched to a fixed date.
- Move re-sort keeps the overdue card on top of its destination.
- Task round trip: `impression_rush` survives create, patch and list; the
  import route leaves it `False`.
- Export: a rushed task exports one impression line whose rate is the stored
  `impression_cost`, no extra line (pins the "folded in" decision).
- Defaults: `rush_pct` round-trips and rejects negatives.

### Components

- `CardView`: badge text and colour class at each level; no badge on a
  finished card; lightning mark on a rushed task row.
- `ProjectDetailPanel`: date field saves through the due-date route and the
  clear button sends null.
- `NewProjectDrawer`: date is optional, included on create, reset with the
  draft.
- `CalculatorPage`: rush checkbox toggles the breakdown row; Margin curve tab
  renders the new field.

### Sweeps before claiming done

- Every fixture that builds a `PricingDefaults` or a calculator defaults
  response gets `rush_pct` (grep by field name, not type name).
- Every `TaskDraft` / `ImpressionDraft` fixture gets `rush`.
- `npm run build`, `./test_frontend.sh`, `./test_backend.sh`, on an idle
  machine, one Vitest file per command if anything flakes.

## Open decisions, resolved

| Question | Decision |
|---|---|
| Who sets the date | Operator, by hand, one date |
| Rush pricing | Toggle + percent, never automatic |
| Board effect | Overdue rises like urgent; otherwise badge only |
| Rush on the quote | Folded into the impression rate |
| Date on the quote | Internal only |
| Rush in the formula | Margin line after the floor, own waterfall step |
