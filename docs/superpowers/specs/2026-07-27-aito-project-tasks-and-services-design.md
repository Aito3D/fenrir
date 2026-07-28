# Aito project tasks and services

Date: 2026-07-27
Status: approved by user (brainstorming session)

## Goal

A project gains a list of **tasks**. Each task has an optional title and
description, and four optional **services**: Scan3D, Modelisation3D,
Impression3D and Usinage. An empty service is a disabled one.

Scan3D, Modelisation3D and Usinage each take a single cost. Impression3D takes
printer, material, weight, print time and colour, and computes its cost through
the existing pricing engine — the same algorithm the calculator page uses.

Tasks are built in the create-project modal, saved with the project, and are
fully editable from the detail panel afterwards.

This is **sub-project 2 of 2**. Sub-project 1 (labelled client fields in the
detail panel) has shipped.

## Decisions made

| Decision | Choice |
|---|---|
| Service storage | Four sets of columns on one `aito_tasks` row, not an EAV child table |
| "Disabled" | `NULL` cost. `0` remains meaningful as "free" |
| Task identity | Optional `title` **and** `description`; empty title falls back to `Task N` |
| Print time | One integer of **minutes**; d/h/m is an input widget only |
| Task deletion | Hard delete, unlike projects |
| Impression3D inputs | Printer, material, weight, time, colour, **quantity** — six fields, nothing else |
| Impression3D cost | Computed via `computePricing`; the **total** is stored, the breakdown is not |
| Which total | `total_ttc_qty` — tax included, quantity applied, matching the calculator's own headline figure |
| Per-job flats | `base_fee_flat` and `consumables_packaging_flat` are **zeroed** per task — see below |
| Tasks in `GET /aito/` | **Not included.** The panel fetches them on open |
| UI architecture | One presentational `TaskEditor`; the modal holds state, the panel PATCHes |
| Removal gesture | `DeleteHoldButton`, the existing 2-second hold |

### Why the breakdown is not stored

The breakdown is derived from org-wide rates that drift — electricity tariff,
labour rate, margins. Storing it would mean a quote reopened next month shows a
breakdown that no longer sums to its own frozen total. So the **total** is the
commercial number, frozen at entry; the breakdown is an editing aid recomputed
live from current rates whenever the task is open for editing.

### Why per-job flat costs are zeroed per task — read this one

`computePricing` adds two flat amounts from `calculator_defaults`:
`base_fee_flat` ("a one-time per-job amount: quotation time, order handling")
and `consumables_packaging_flat`. Both are **per job**, and the engine's own
comment says so.

A project is the job. A project with three print tasks would otherwise be
charged the base fee and the packaging flat **three times** — silently, with
nothing on screen to indicate it. So per-task computation passes a defaults
object with both set to `0`.

The consequence is that a per-task total is *not* the same figure the calculator
page would produce for the same inputs; it is the same minus those two flats.
That is deliberate and is the only place this feature departs from "the same
algorithm". If those flats should instead be added once at project level, that
is a separate, easy addition — but charging them per print line is wrong either
way.

### Why tasks are excluded from the board fetch

`GET /aito/` drives the whole board and is re-fetched on every WebSocket
invalidation. Loading every task of every card, to render cards that do not
display tasks, would bloat the hottest request in the feature. The panel
fetches `GET /aito/{id}/tasks` when it opens.

The consequence: no project total on the *card*. If one is wanted there, the
cheap version is an aggregate column on the project response, not the task list.

### Why hard delete

Projects are soft-deleted so the autoincrement id can serve as a stable, visible
project number. Tasks have no such requirement, and hold-to-remove is already a
deliberate gesture. Project soft-delete leaves tasks attached, so restoring a
project restores its tasks with no extra work.

## Data model

```
aito_tasks
  id                       int PK autoincrement
  project_id               int FK -> aito_projects.id, indexed
  position                 int
  title                    str(200) | NULL      -- falls back to "Task N"
  description              Text     | NULL
  scan_cost                float    | NULL      -- NULL = service disabled
  modelisation_cost        float    | NULL
  usinage_cost             float    | NULL
  impression_printer_id    int      | NULL
  impression_filament_id   int      | NULL
  impression_weight_g      float    | NULL
  impression_time_min      int      | NULL
  impression_quantity      int      | NULL      -- defaults to 1 in the editor
  impression_color         str(100) | NULL
  impression_cost          float    | NULL      -- frozen total, not the breakdown
  created_at, updated_at
```

Four services as columns rather than a `task_services` child table: the set is
**fixed and known**, so an EAV table would add a join and a `service`
discriminator to model something that never varies — and Impression3D's five
inputs do not fit the shape the other three would need.

`impression_printer_id` and `impression_filament_id` are plain integers, **not
foreign keys**. A filament or printer deleted from the calculator must not
cascade into a historical quote, and `impression_cost` is already frozen, so a
dangling reference costs only the ability to re-edit that line — it never
corrupts the stored figure. The editor treats a missing reference as an
unselected dropdown and leaves the stored total alone until the user changes
something.

## API

```
POST   /aito/                     accepts tasks: [...]; created transactionally
GET    /aito/{project_id}/tasks   list, ordered by position
POST   /aito/{project_id}/tasks   add one
PATCH  /aito/tasks/{task_id}      partial update
DELETE /aito/tasks/{task_id}      remove
```

`PATCH` follows the semantics `update_project` already established: only keys
present in the body are written, so an omitted key is left alone and an explicit
`null` clears the field. That distinction is what lets a service be disabled by
sending `null` without disturbing its siblings.

Permissions reuse the existing Aito set: `AITO_READ` for the list,
`AITO_CREATE` for creation, `AITO_UPDATE` for patch, `AITO_DELETE` for removal.
No new permission is introduced.

**Validation.** Costs must be non-negative. `impression_weight_g` and
`impression_time_min` must be non-negative. `position` is server-assigned on
create (append) — clients do not choose it, and reordering is out of scope.

## Cost computation

A pure helper in `frontend/src/utils/taskDraft.ts`:

```ts
computeImpressionCost(
  draft: ImpressionDraft,
  filament: PricingFilament,
  printer: PricingPrinter,
  defaults: PricingDefaults,
): PricingResult | null
```

It returns `null` when printer, filament, weight or time is missing — the
service is disabled and has no cost. Quantity defaults to 1 and is clamped to a
minimum of 1, matching what `computePricing` already does internally.

It calls the existing `computePricing` with:

| Field | Value |
|---|---|
| `weight_g` | from the draft |
| `printing_time_h` | `impression_time_min / 60` |
| `quantity` | from the draft, minimum 1 |
| `modeling_hours`, `modeling_base_price` | `0` — Modelisation3D is its own service line, so including these would double-count |
| `prep_*` (3), `post_*` (4) | `0` — not captured anywhere in this form |
| `stuff_amount` | `0` |
| `defaults.base_fee_flat`, `defaults.consumables_packaging_flat` | **overridden to `0`** — see the decision above |

Everything else — electricity tariff, failure and prototype rates, ads, filament
markup, global markup, tax — comes from `calculator_defaults` unchanged, so the
per-print figure tracks the org's real rates.

`computePricing` itself is **not modified**. The task feature composes on top of
it, exactly as `NewContactForm` composed a required-phone rule on top of the
shared `validatePhone` rather than changing it for every caller.

### Which figure is the line total

`PricingResult` is **per unit**, with `total_ht_qty` and `total_ttc_qty`
carrying the quantity-multiplied figures. The stored `impression_cost` is
**`total_ttc_qty`** — tax included, quantity applied.

That follows the calculator's own presentation, which leads with `total_ttc`
as its headline number (and `total_ttc_qty` when quantity exceeds one), showing
HT as a secondary line. Departing from it here would mean the same inputs
produce different headline numbers in two places in the same app.

**Consequence worth knowing:** Scan3D, Modelisation3D and Usinage are typed by
hand, so whether they are HT or TTC is whatever the user entered. The project
total therefore assumes the manually-entered costs are TTC too. Nothing in the
UI enforces that; it is a convention, and the only alternative — asking for
both figures on three manual services — costs far more than it is worth.

## UI

```
Tasks                                    + Add task
┌────────────────────────────────────────────────┐
│ Boîtier                          8 200 XPF  ⌫  │  hold 2s to remove
│ Description…                                   │
│ ┌ Scan3D ─────────────────────────────────────┐│
│ │ Cost  [        ]   empty = disabled         ││
│ ├ Modelisation3D ─────────────────────────────┤│
│ │ Cost  [  4 000 ]                            ││
│ ├ Impression3D ───────────────────────────────┤│
│ │ Printer [X1C ▾]  Material [PLA Basic ▾]     ││
│ │ Weight  [120] g  Time [0d 4h 30m]           ││
│ │ Colour  [Noir]   Quantity [ 2 ]             ││
│ │ Filament 1 240 · Machine 870 · Margin 890   ││
│ │ Total                            4 200 XPF  ││
│ ├ Usinage ────────────────────────────────────┤│
│ │ Cost  [        ]                            ││
│ └─────────────────────────────────────────────┘│
└────────────────────────────────────────────────┘
                                Project total  20 200 XPF
```

### Architecture

`TaskEditor` is **presentational**: `value: TaskDraft[]`, `onChange`,
`onRemove`. It knows nothing about persistence.

- The **create modal** holds the array in local state and POSTs it with the
  project. Cancel still means cancel — nothing is written until submit.
- The **detail panel** holds the server's task list and wires each change to a
  `PATCH` on that task, an add to `POST`, a removal to `DELETE`.

This mirrors what `ClientSection` / `ClientDraft` already do, and is why the
same editor can serve two quite different data flows.

### Components

| File | Responsibility |
|---|---|
| `components/aito/TaskEditor.tsx` | The list, the "+ Add task" control, ordering |
| `components/aito/TaskRow.tsx` | One task: title, description, the four service blocks, total, remove |
| `components/aito/ImpressionFields.tsx` | The five inputs plus the live breakdown |
| `components/aito/DurationInput.tsx` | Days / hours / minutes, emitting total minutes |
| `utils/taskDraft.ts` | `TaskDraft` type and all pure logic |

`DeleteHoldButton` is reused unchanged for removal.

### Pure logic

`utils/taskDraft.ts` holds everything testable without rendering:
minutes ↔ d/h/m conversion, `computeImpressionCost`, `taskTotal`,
`projectTotal`, and `draftFromTask` / `emptyTaskDraft` builders.

## Testing

**Pure helpers (vitest):**
- d/h/m ↔ minutes round-trips, including `90 → 0d 1h 30m` and zero.
- `computeImpressionCost` returns `null` when any of printer, filament, weight
  or time is missing.
- Quantity multiplies the line total: the same inputs at quantity 2 cost twice
  quantity 1, given the per-job flats are zeroed. Absent or `0` quantity is
  treated as 1.
- It passes `base_fee_flat: 0` and `consumables_packaging_flat: 0` — asserted
  by computing the same inputs with non-zero flats and confirming the result is
  unchanged. This is the decision most likely to be "tidied" away later.
- `taskTotal` sums only enabled services; a `NULL` service contributes nothing
  and a `0` service contributes zero.

**Backend:**
- `POST /aito/` with tasks creates them transactionally, in order, and a
  failure creates neither project nor tasks.
- `GET /aito/{id}/tasks` returns them ordered by position.
- `PATCH` writes a present key, clears on explicit `null`, and leaves an
  omitted key alone — the three-way behaviour, on a service cost.
- `DELETE` removes one task and leaves its siblings' positions usable.
- Soft-deleting a project leaves its tasks attached; restoring brings them back.
- Costs reject negative values.
- `GET /aito/` does **not** include tasks — asserted, because it is a
  performance decision that would be silently undone by a convenience change.

**Components:**
- "+ Add task" appends a task with all four services empty.
- Filling a Scan3D cost enables it; clearing it disables it again.
- Entering printer + material + weight + time shows a total; removing any one
  of them clears it.
- Hold-to-remove removes the right task, and a short press does not.
- The editor emits `onChange` with the whole draft array and never mutates it.

## i18n

New keys under `aito.` in all 12 locale files: the section heading, "+ Add
task", the four service names, the five Impression3D field labels, the
duration units, "Task {{n}}", the breakdown line labels, project total, and the
task title/description placeholders. Roughly 20 keys.

Service names (`Scan3D`, `Modelisation3D`, `Impression3D`, `Usinage`) are
**product names and stay untranslated** — they are the workshop's own service
catalogue, not prose. They go in the locale files as identical values across
languages, which means `check-i18n-parity.mjs` needs them added to its
allowlist, exactly as `Zoho` and `Bambuddy` already are.

## Out of scope

- Reordering tasks (position is append-only for now).
- A project total on the board card.
- Applying `base_fee_flat` / `consumables_packaging_flat` once at project level.
- Modelling hours, prep and post-processing minutes as per-task inputs.
- Exporting a quote to Zoho.
