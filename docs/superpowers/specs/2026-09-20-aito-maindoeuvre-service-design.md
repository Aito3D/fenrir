# Aito: "Main d'œuvre" — a fifth task service

**Date:** 2026-09-20
**Status:** approved, ready for an implementation plan

## Problem

An Aito task can carry four services today: Scan, Modélisation, Impression,
Usinage. Labour billed by itself — assembly, finishing, on-site work — has no
line of its own, so it is either folded into a machining price that then lies,
or typed into Books by hand where the app immediately classifies it as a
foreign line.

The shop's Books catalogue already has the item: **Prestation - Main d'oeuvre -
P**, SKU **PM-CM-D**, item id **66407000001604625**.

## What is being built

A fifth service, `maindoeuvre`, on every Aito task. It differs from the other
four in exactly three ways:

1. **No quantity.** Always one unit.
2. **No discount.** No percent select, no discount on the Books line.
3. **Its description is mandatory**, where the other four are optional.

Everything else — the chip in the editor, the done-tick, the board progress
bar, the badge on the card, the quote line, the AI proofreader on the
description, the stats palette — follows the pattern the four existing
services already establish.

## Decisions taken

| Question | Decision |
|---|---|
| Board stage | The **Finish** column owns it: `STAGES += ('finish', ('maindoeuvre',))` |
| Books item id | Hardcoded default `66407000001604625`, overridable via the `zoho_item_maindoeuvre_id` setting, exactly like the other four |
| Mandatory description | Enforced **twice**: a visible required-field warning in the UI, and a terminal guard that blocks the quote push |
| Label | Translated in all 13 locales — EN "Labour", FR "Main d'œuvre" |
| Chip order | Last, after Machining |
| Block layout | One `Cost` row + the required description. No quantity row, no discount select, no line-total footer |

### Rejected alternatives

- **A service child table (EAV)** replacing the 4×6 column block on
  `aito_tasks`. The right long-term shape, but it rewrites the board rules,
  both quote codecs, the migrations and every test fixture to add one line
  item.
- **A subtype flag on `usinage`.** Cheapest diff, but two Books items, two
  stages and two done-ticks would then contend for one cost column.

## Consequences of staging labour in Finish

Both are new behaviour, both accepted:

- A card with a priced but unticked labour step sits in Finish with
  `move_lock: 'steps'`. `canMarkDone` requires a null lock and the server's
  `move_project` mirrors that refusal, so **Mark done is unavailable until the
  labour step is ticked**. A job whose labour is outstanding cannot be closed.
- A card whose only priced service is labour goes from accepted straight to
  Finish, skipping Scan / Model / Print.

Finish therefore stops being purely the "nothing left to do" resting place and
becomes a work stage like the other three. `evaluate()` needs no structural
change for this: the stage search already runs before the stored-column
fallback, so a pending labour step simply wins the search and returns
`('finish', 'steps')`, and the fallback still returns `('finish', None)` once
nothing is pending.

## Data model

Three additive columns on `aito_tasks`, via `ALTER TABLE` in
`backend/app/core/database.py:run_migrations()` beside the existing
per-service loops:

```
maindoeuvre_cost         FLOAT    NULL
maindoeuvre_description  TEXT     NULL
maindoeuvre_done         BOOLEAN  NOT NULL DEFAULT 0
```

No `maindoeuvre_quantity`, no `maindoeuvre_discount_pct`. Absent quantity
already reads as 1 and absent discount as none throughout the stack.
`COST_KEYS` and `TaskLike` gain the new cost field like any other service;
the maps that a service can now legitimately be *missing* from —
`DISCOUNT_KEYS` in `aitoBoardRules.ts`, and the dict literals in
`aito_quote_export.quantity_of` / `discount_of` — become partial, returning
`null`/`None` for a service that owns no such field instead of raising a
`KeyError` or resolving to `undefined` by accident.

The `NULL` cost means "service absent"; `0` means "quoted free". That rule is
unchanged and every new reader must test for null, never for falsiness.

The two historical backfills in `database.py` that carry their own
`MAX(CASE WHEN <service>_cost IS NOT NULL AND <service>_done = FALSE …)`
pattern — `_migrate_aito_board_columns` (gated on `scan_done` not having
existed) and `_heal_invoiced_quote_status` (marker-gated, already run) — are
deliberately **not** touched. Both are one-shots over rows that predate this
feature, both can run before the labour columns exist, and no pre-existing
task can carry a labour step, so their pending-set SQL stays correct as it
is.

## Rule engine and its contract

`SERVICES` gains `'maindoeuvre'` in last position and `STAGES` gains
`('finish', ('maindoeuvre',))`, in **both**
`backend/app/services/aito_board_rules.py` and
`frontend/src/utils/aitoBoardRules.ts`.

`scripts/gen_aito_board_rules_fixture.py` is then re-run to rewrite
`frontend/src/__tests__/fixtures/aitoBoardRules.cases.json`. The backend
contract test fails until the fixture is regenerated and the frontend mirror
test fails until the TypeScript is brought back in line, so neither side can
move alone. The existing "every service is staged exactly once" test covers
the new stage entry.

`net_cost` / `netCost` return the raw cost for `maindoeuvre` — there is no
percent to apply — and `taskCost` reads the new column.

## Zoho

**Export** (`aito_quote_export.py`):

- `SERVICES` tuple gains `"maindoeuvre"` last.
- `cost_of` / `description_of` gain the service; `quantity_of` and
  `discount_of` return `None` for it.
- `Catalogue` gains `maindoeuvre_item_id`, included in `item_id()` and in
  `item_ids()` — the latter matters: without it the app's own labour line
  reads back as foreign and duplicates itself on every push.
- `build_description` emits the `Info:` row only. The `*Fichier non cédé*`
  boilerplate stays scan/modelisation-only.
- The line is `rate = cost`, `quantity = 1`, `unit = "Projet"`, no `discount`
  key.

**Catalogue loading** (`zoho.py`): `maindoeuvre_item_id=await
value("zoho_item_maindoeuvre_id", "66407000001604625")`.

**Import** (`aito_quote_import.py`):

- `_SKU_PREFIXES` gains `("PM-CM", "maindoeuvre")`. A prefix, not an equality
  test, so `PM-CM-D` and any later catalogue variant both map — consistent
  with how `U3DIMP-VENTE` is handled today.
- `SERVICE_RANK` gains `"maindoeuvre": 4`, which also places it last within a
  header group and makes a repeat of it open a new group.
- `SERVICE_LABEL` gains `"maindoeuvre": "Main d'oeuvre"` — the shop's own
  wording, not the translated UI label, since that text is a record of what
  the quote said.

The governing round-trip rule is unchanged: what the exporter writes, the
importer must read back unchanged.

## The mandatory description

Two independent layers. Neither alone is sufficient: the UI one cannot bind an
API client or an import, and the backend one is invisible until a push is
attempted.

**UI.** The labour block's description is always visible — no `+ Note` reveal
— and its placeholder drops the word "Optional". When the labour step is
priced and the description is blank, a `FieldError` renders under it.

- In `NewProjectDrawer`, that error joins the `canCreate` gate, following the
  drawer's existing reveal-on-click convention: Create is disabled only once
  the error is visible, so the button is never dead with nothing on screen
  explaining why.
- In `ProjectDetailPanel` there is no Save button — task edits autosave
  through the debounced patch — so the inline warning is the whole of the UI
  layer there, and the push guard below is what actually holds the quote.

**Backend.** A terminal guard in `aito_quote_sync`, beside the existing
"Project has no priced service yet" one: a project carrying a task with a
non-null `maindoeuvre_cost` and a null-or-blank `maindoeuvre_description` sets
`quote_sync_state = "error"` with the message "Main d'oeuvre line has no
description", and nothing is written to Books.

Deliberately **not** a 422 on task create/PATCH: a quote imported from Books
can legitimately carry a labour line with no `Info:` row, and rejecting the
write would strand the import with no way forward. The project is allowed to
hold the invalid state; only the push is refused.

## Frontend surface

- `TaskStepFields`: a fifth chip after Machining, and a `maindoeuvre` block
  rendered by its own small branch rather than `renderPlainService` (which
  assumes a quantity and a discount key).
- `TaskDraft`: `maindoeuvreCost`, `maindoeuvreDescription`, and
  `done.maindoeuvre`, threaded through `blankTask`, `normalizeTask`,
  `taskFromApi`, `taskToApi`, `taskTotal` and `hasPricedService`.
- `api/client.ts`: the three wire fields on the task create/update/response
  types.
- Also enumerating services, each needing the new member: `TaskStepList`
  (description field map; the quantity map loses its "everything but
  impression" typing, since labour has no count either),
  `ImportQuoteDrawer`'s service list, `aitoSummary`, `useProjectTasks`'s
  ticked-step field list, and `stats/palette.ts` (a fifth colour, distinct
  from the four in use). `ServiceBadges` needs no change: it renders through
  `AITO_SERVICE_LABEL_KEYS` and already falls back to the raw id for an
  unknown service.

`aito_tracking.task_quantity` is left alone: it derives an unambiguous
per-task count from services that *have* a quantity, and labour has none, so
it must not contribute to that set.

## Backend surface

- `schemas/aito.py`: the three fields on `AitoTaskCreate`, the update schema
  and the response schema, with the same constraints their `usinage`
  counterparts carry (`cost` `ge=0`, `description` `max_length=10_000`).
- `api/routes/aito.py`: the response mapping.
- `services/aito_quote_sync.load_export_tasks`: the three fields onto
  `ExportTask`.
- `services/openrouter.py`: `_SERVICE_FIELDS` gains
  `("maindoeuvre_cost", "maindoeuvre_description", "main d'œuvre")`, so the
  generated project summary can mention it.

The AI rewriter on the description needs no work: `AiTextField` posts to
`/aito/proofread`, which is field-agnostic.

## i18n

`aito.serviceMainDoeuvre` and one error key
(`aito.maindoeuvreDescriptionRequired`) in all 13 locale files, translated per
locale — EN "Labour", FR "Main d'œuvre", DE "Arbeitszeit", ES "Mano de obra",
IT "Manodopera", NL "Arbeidsloon", and so on for the rest. `npm run
check:i18n` rejects a value left identical to English, so no placeholders.

## Testing

Test-first throughout.

- **Contract:** regenerate the board-rules fixture; the backend contract test
  and the frontend mirror test both have to pass on the new five-service,
  four-stage rule set.
- **Rules:** a card whose only priced service is labour lands in Finish with
  `move_lock: 'steps'`; ticking it releases the lock to `null`; `canMarkDone`
  is false in the first case and true in the second.
- **Migration:** the new columns exist after `run_migrations()` on a database
  created before this change, and existing rows read `NULL`/`false`.
- **Export/import round trip:** a labour line written by the exporter is read
  back by the importer as the same service, cost and description; a
  `PM-CM-D` line in a captured estimate maps to `maindoeuvre` rather than
  being reported as skipped; the labour item id is in `item_ids()` so the line
  is not treated as foreign.
- **Push guard:** a project with a priced labour step and a blank description
  ends in `quote_sync_state = "error"` with the documented message and no HTTP
  call to Books; filling the description clears it and the push proceeds.
- **Editor:** the chip reveals the block; the block has no quantity input and
  no discount select; a priced step with an empty description shows the
  warning and blocks Create in the drawer; the description field carries the
  AI rewrite affordance.
- **i18n:** the parity gate over all 13 locales.

## Out of scope

- Per-hour labour pricing (rate × hours). The field is a flat cost.
- Any quantity or discount on the labour line.
- Backfilling existing tasks — no historical task gains a labour step.
- Changing how the other four services behave.
