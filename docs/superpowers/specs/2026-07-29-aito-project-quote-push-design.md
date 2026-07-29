# Aito: a project writes its Zoho quote (Phase 1 — push)

**Date:** 2026-07-29
**Status:** approved, ready for an implementation plan

## Goal

One project on the Aito board *is* one quote in Zoho Books. Creating a project
creates the quote; editing the project rewrites it. The project's tasks become
the quote's line items, grouped under headers named after the tasks, with the
board's own data filling the shop's catalogue description templates.

This is the mirror of the import feature shipped on 2026-07-28
(`2026-07-28-aito-quote-import-design.md`), which reads a quote into a project.
That module's vocabulary — SKU prefixes, label rows, weight and time grammar —
is reused verbatim in the opposite direction, which is what makes the
round-trip test in *Testing* a genuine invariant rather than a tautology.

## Scope

The full ambition is bidirectional sync. It is built in two phases:

- **Phase 1 (this spec) — push.** Project → quote. The data model, the builder,
  the outbox worker, the lifecycle rules.
- **Phase 2 — pull.** Quote → project. A poller compares each linked quote's
  `last_modified_time` against the `quote_synced_at` watermark this phase
  already maintains, and applies Books-side edits silently. It adds **no
  migrations and no new columns** — the model below is designed for both.

Splitting here is not arbitrary: push is useful on its own (the board stops
being a place you retype a quote), and pull is meaningless without the
watermark and echo suppression that push establishes.

## What the live API actually does

Established by probing and then writing to the shop's live Books org
(`DEV26-2471`, created and deleted during the design), not assumed from docs.

- **The four catalogue items and the services tax:**

  | SKU | `item_id` | template |
  |---|---|---|
  | `P3DSCAN` | `66407000006501192` | `Info: [TITLE]` / `*Fichier non cédé*` |
  | `P3DMOD` | `66407000006485001` | `Info: [TITLE]` / `*Fichier non cédé*` |
  | `P3DIMP` | `66407000006485012` | `Projet: [TITLE]` / `Matériau: [MATERIAL]` / `Poids: [WEIGHT]` / `Temps: [TIME]` / `Couleur: [COLOR]` |
  | `U3DIMP` | `66407000006884825` | `Usinage: [TITLE]` |

  All `unit: "Projet"`, `tax_id: 66407000009281008` (TVA services 13 %),
  `is_inclusive_tax: true`, `price_precision: 0`.

- **Headers are rows, not attributes.** `header_id` / `header_name` on a line
  item are read-only and stayed empty even on a quote that genuinely had
  headers. The writable mechanism is a line item of its own with
  `line_item_category: "header"` and a `name`. A header is **positional**: it
  covers every line after it until the next header.
- **A partial PUT preserves the rest of the document.** `PUT /estimates/{id}`
  carrying only `line_items` left `customer_id`, `notes`, `terms`,
  `reference_number`, `template_id` and `salesperson_id` untouched.
- **A foreign line survives if you echo its id.** Sending
  `{"line_item_id": "..."}` and nothing else carried a line through with its
  name, rate and description intact. Omitting a line deletes it. Aito lines get
  fresh `line_item_id`s on every push, which costs nothing.
- **Zoho enforces no lock whatsoever.** `sent`, `accepted` *and* `declined`
  estimates all accepted a PUT without complaint. Every guard in this design is
  ours; none is Zoho's.
- **Status transitions are one-way.** `POST /estimates/{id}/status/sent`,
  `/accepted` and `/declined` all work. There is **no** `/status/draft`, and a
  PUT on a declined estimate leaves it declined. Nothing can return a quote to
  draft through the API.
- **`last_modified_time` is in the list payload.**
  `GET /estimates?sort_column=last_modified_time&sort_order=D` sorts by it and
  returns it per row, so Phase 2 costs one call per tick for the whole board.
  `last_modified_by_id` is also present.
- **`impression_cost` is the total for all units**, not per unit —
  `ImpressionFields` reports `total_ttc_qty`. A line item is `rate × quantity`.
  See *The rounding write-back*.

## Decisions

| Question | Decision |
|---|---|
| Who wins on divergence | The app. Project edits push; Books edits are pulled (Phase 2) |
| Auto-refresh | Yes, silent — the card just updates, no toast, no badge to clear |
| When the quote is created | On project create, always |
| Minimum project | ≥ 1 task, and ≥ 1 priced service per task. Enforced in the modal |
| Locked quote | Push continues while `sent`/`accepted`; stops once invoiced |
| Foreign lines in Books | Preserved untouched; the app owns only the four AITO SKUs |
| Task free text | Appended to the task's **first** service line only |
| Trash | Quote marked `declined`, previous status snapshotted |
| Restore | Previous status re-applied when it was `sent`/`accepted`; a `draft` cannot be recovered and the panel says so |
| Existing quote-less projects | Left alone, permanently |
| Where the push runs | Outbox column + background worker, never on the request path |

## Data model

Additive `ALTER TABLE` in `run_migrations()` (`backend/app/core/database.py`),
the house pattern. The import feature's `quote_*` columns are the link and are
reused as-is: `quote_id`, `quote_number`, `quote_date`, `quote_total`,
`quote_url`, `quote_salesperson` and — importantly — **`quote_status`
(`String(30)`) already exists**, is already carried through
`AitoProjectCreate`/`AitoProjectResponse`, and is already rendered on the card.
This phase does not add it; it *writes* it.

That is worth stating plainly, because it fixes a limitation the model
currently documents: `quote_status` is a snapshot taken at import, so "accepting
a quote in Zoho does not update the card". Every push now refreshes it, and
Phase 2 refreshes it for quotes the app never wrote.

`aito_projects` gains five genuinely new columns:

| column | type | purpose |
|---|---|---|
| `quote_sync_state` | `String(20)`, default `'idle'`, indexed | `idle` \| `pending` \| `error` \| `locked` — the worker's queue and the card's badge |
| `quote_sync_error` | `Text`, nullable | last failure message, shown in the detail panel |
| `quote_sync_failures` | `Integer`, default `0` | consecutive upstream failures; escalates to `error` at 5 |
| `quote_synced_at` | `String(30)`, nullable | the `last_modified_time` we last wrote or read. Echo suppression, and Phase 2's change detection |
| `quote_status_before_trash` | `String(30)`, nullable | so restore can re-apply `sent`/`accepted`. Widened to 30 to match `quote_status`, which it snapshots |

No `dirty_at` column. The worker drains everything `pending` on each tick, so a
burst of edits inside one interval coalesces on its own.

**The migration default is load-bearing.** Existing projects get
`quote_sync_state = 'idle'`, and the worker only ever selects `'pending'`. So
"leave old quote-less cards alone forever" is a consequence of the column
default rather than a rule anyone has to remember. Correspondingly,
`pending` + `quote_id IS NULL` is precisely the state "this project needs a
quote created".

### Settings

Catalogue ids belong in the `settings` table, not in code — a catalogue change
in Books must not need a redeploy. Defaults are the verified values above.

```
zoho_item_scan_id            zoho_item_modelisation_id
zoho_item_impression_id      zoho_item_usinage_id
zoho_service_tax_id
aito_quote_sync_enabled      (bool, default true)
aito_quote_poll_seconds      (int,  default 60)
```

### Schemas

`AitoProjectResponse` gains `quote_sync_state` and `quote_sync_error`.
`quote_status` is already exposed. `quote_synced_at`, `quote_sync_failures` and
`quote_status_before_trash` are internal to the worker and stay unexposed.

## The quote builder

A new I/O-free module `backend/app/services/aito_quote_export.py` — no DB, no
HTTP, the whole surface testable from fixtures. It is the mirror of
`aito_quote_import.py` and imports that module's constants
(`SERVICE_LABEL`, `LABEL_DISPLAY`) rather than restating them.

```python
build_line_items(project, tasks, existing_line_items, catalogue) -> list[dict]
```

### 1 · Structure

Walk `tasks` in `position` order. For each task:

1. **Header row**, emitted only when the project has more than one task *and*
   the task title is non-empty:
   `{"line_item_category": "header", "name": title[:200]}`.
   A single-task project gets no header — a header naming the only thing on the
   quote is noise on the PDF, and this is what "if the project has multiple
   tasks, separate them with headers" asks for.
2. **One line per enabled service**, in canonical order
   scan → modelisation → impression → usinage. A service is enabled when its
   cost column is non-NULL (0 stays meaningful as "free").

Then, **once, after all tasks**, the foreign lines: each line of the current
estimate whose `sku` maps to no Aito service and whose `line_item_category` is
not `header`, echoed as `{"line_item_id": id}` and nothing else. They keep
their relative order among themselves and land as one block after the Aito
lines. `item_order` is assigned sequentially across the whole result.

Header rows the app previously wrote are *not* foreign — they are re-derived
every push. A header row typed by hand in Books is indistinguishable from one
of ours and is therefore also dropped; this is a known, accepted limitation of
headers being positional and identity-free.

### 1b · The importer must learn about headers

Writing headers exposes two flaws in the import direction, both of which this
phase fixes because the round-trip invariant depends on them:

- **A header row is currently "skipped".** `parse_lines` classifies by `sku`,
  and a header has none, so every header the app writes would show up in the
  import modal's *not imported* list.
- **`group_lines` would merge tasks the app deliberately separated.** Its
  heuristic opens a new group only when a service rank repeats or falls, so a
  project of `[scan]` then `[modelisation]` — ranks 0 then 1, strictly rising —
  re-imports as a *single* task. The board's task boundaries would not survive a
  round trip.

The fix is small and improves import on its own: `ParsedLine` gains
`starts_group: bool` (default `False`), set on the first recognised line
following a `line_item_category == "header"` row; `group_lines` opens a new
group whenever `starts_group` is true. Header rows stop being reported as
skipped.

An explicit boundary written by whoever built the quote beats a rank heuristic
guessing at one. Quotes with no headers — every quote that exists today — hit
neither branch and group exactly as they do now.

### 2 · Money

| service | `rate` | `quantity` |
|---|---|---|
| scan, modelisation, usinage | the cost | `1` |
| impression | `round(impression_cost / quantity)` | `impression_quantity or 1` |

`is_inclusive_tax: true` on the estimate means `rate × quantity` is the TTC
figure, which is what the board stores — the two line up with no conversion.

#### The rounding write-back

`impression_cost` is a total and `price_precision` is 0, so a cost of 2401 over
2 units cannot be expressed as `rate × quantity`. Rather than leave the two
sides disagreeing by a few XPF — which Phase 2's poller would later "fix" as a
visible jitter on the card — the worker **writes the achievable total
(`rate × quantity`) back to `impression_cost`** in the same transaction as the
push. The project and the quote agree immediately.

### 3 · Descriptions

Each service line's description is its catalogue template with the placeholders
filled. A row whose value is empty is **dropped entirely** rather than emitted
as a bare `Poids:` — and the placeholders themselves (`[TITLE]`, `[MATERIAL]`,
`[WEIGHT]`, `[TIME]`, `[COLOR]`) are never emitted, since the importer strips
them as unfilled markers.

| line | rows |
|---|---|
| `P3DSCAN`, `P3DMOD` | `Info: {title}`, then `*Fichier non cédé*` |
| `P3DIMP` | `Projet: {title}`, `Matériau: {material}`, `Poids: {weight}`, `Temps: {time}`, `Couleur: {color}` |
| `U3DIMP` | `Usinage: {title}` |

- `{material}` is `filament.type` for `impression_filament_id` — `PETG`, `PLA`,
  `ASA`. Not the brand: the importer found `Matériau: PETG` unmappable back to a
  brand-prefixed inventory row, and the shop's real quotes say the bare type.
  Omitted when no filament is set.
- `{color}` is `impression_color` verbatim.
- The task's free-text `description` is appended, after the templated rows, to
  the task's **first** service line only — Scan3D if present, else
  Modelisation3D, else Impression3D, else Usinage. It says it once, it prints
  where the reader expects it, and the importer already preserves unlabelled
  free text verbatim, so it round-trips.

#### Formatting, mirrored exactly from the importer

Both formatters are written against `parse_weight_g` and `parse_time_min` so
that parsing the output reproduces the input.

**Weight** — `f"{value:g} gr"`. `210.0` → `210 gr`; `1.5` → `1.5 gr`
(`_WEIGHT_RE` accepts `[.,]` decimals). Omitted when NULL.

**Time**, from minutes:

| condition | output | example |
|---|---|---|
| `m < 60` | `{m}min` | `26` → `26min` |
| `m % 60 == 0` | `{m//60}h` | `780` → `13h` |
| otherwise | `{m//60}h{m%60:02d}` | `150` → `2h30`, `125` → `2h05` |

`parse_time_min` accumulates tokens, so `2h05` reads back as `120 + 5 = 125`.
Omitted when NULL.

**A constraint on free text.** `_LABEL_RE` only treats a row as a labelled value
when its prefix is one of the known labels, so a task description beginning
`Note:` stays free text — but one beginning `Poids:` would be absorbed as a
field on re-import. This is inherent to the format, is preserved by the
importer's "first value wins, the loser survives as free text" rule, and is
covered by a round-trip test rather than by escaping.

## The sync engine

### Marking dirty

These handlers set `quote_sync_state = 'pending'`, clear
`quote_sync_failures`, and return. **Nothing calls Zoho on the request path.**

```
POST   /aito/                    create — also needs the quote created
PATCH  /aito/{id}                description, client
POST   /aito/{id}/tasks          add task
PATCH  /aito/tasks/{id}          edit task or service
DELETE /aito/tasks/{id}          remove task
DELETE /aito/{id}                trash    — status reconciliation
POST   /aito/{id}/restore        restore  — status reconciliation
```

`PATCH /aito/{id}/move` deliberately does **not**: which board column a card
sits in is production state and is invisible to the quote.

### The worker

`backend/app/services/aito_quote_sync.py`, a singleton started in `main.py`'s
lifespan beside the existing background services, and skipped entirely when
`aito_quote_sync_enabled` is false or Zoho is not configured. Every
`aito_quote_poll_seconds`, it selects projects with
`quote_sync_state = 'pending'` — **active and trashed alike**, since a trashed
project still owes Books a status change — and for each:

**No `quote_id`** → `POST /estimates`:

```json
{ "customer_id": "<project.client_id>",
  "reference_number": "AITO-<project.id>",
  "is_inclusive_tax": true,
  "line_items": [ ... ] }
```

Everything else — template, salesperson, notes, terms, expiry, numbering —
is left to the org defaults. Store the returned `estimate_id`,
`estimate_number`, `date`, `total`, the Books deep link from the existing
`books_app_url()`, `status` and `last_modified_time`.

**Has a `quote_id`** → `GET /estimates/{id}`, then:

1. **Lock check, first and short-circuiting.** `is_transaction_created` or
   `invoiced_amount > 0` → `quote_sync_state = 'locked'` and **nothing else in
   this list runs**, including the status reconciliation: a quote that has been
   invoiced must not be declined because someone tidied the board. Edits stay
   local; the board is otherwise unaffected. Per the decision above, `accepted`
   still pushes.
2. **Status reconciliation, declaratively** — no action column, just facts:
   - project soft-deleted and `status != 'declined'` → snapshot the current
     status into `quote_status_before_trash`, then `POST /status/declined`.
   - project active, `status == 'declined'`, and the snapshot is `sent` or
     `accepted` → re-apply it, then clear the snapshot.
   - a snapshot of `draft` stays declined. The API cannot undo it; the detail
     panel says so rather than pretending.
3. **Rebuild and write.** `PUT /estimates/{id}` with **only** `line_items` —
   the partial PUT that preserves the rest of the document.
4. Store `last_modified_time` → `quote_synced_at`, `status` → `quote_status`,
   `total` → `quote_total`, apply the rounding write-back,
   `quote_sync_state = 'idle'`, `quote_sync_failures = 0`.

A project soft-deleted *and* never given a quote is dropped from the queue
without a call.

### Failure

| failure | behaviour |
|---|---|
| `ZohoRequestRejected` (400) | the payload is wrong and retrying cannot help → `error`, message stored, stop |
| `ZohoUpstreamError` (network, 5xx) | stays `pending`, `quote_sync_failures += 1`, retries next tick; escalates to `error` at 5 so a permanently broken project stops polling forever |
| `ZohoNotConfiguredError` | the worker idles entirely; nothing is marked failed |
| 404 on `GET /estimates/{id}` | the quote was deleted in Books → `error` with a message offering to clear the link |

`error` clears on the next edit to the project, or on the panel's Retry button.

### Ordering

One project is pushed at a time, sequentially. The board's volume is a handful
of cards, Zoho's rate limits are per-org, and a serial loop makes the failure
accounting above trivial to reason about. No concurrency.

## Frontend

### `NewProjectModal` and `TaskEditor`

The modal seeds **one task row** on open, and submit stays disabled until
**every** task has at least one service priced. `TaskEditor` refuses to remove
the last remaining task. A project with no task is not a project, and a task
with no service produces no line item — the two rules together guarantee every
project yields a non-empty quote, and that no task is silently absent from it.

Every task, not merely one of them: a service-less task emits no line, so under
the weaker rule it would sit on the board and be invisible in Books, its header
included. That is the state the builder's header gate would otherwise have to
have an opinion about.

### `CardView`

The `quote_number` chip already exists. It gains:

- a quiet placeholder while the quote is being created (`pending` +
  no `quote_number`),
- a badge for `error` and for `locked`.

### `ProjectDetailPanel`

A sync row below the existing Quote row: the state, the last error when there
is one, and a Retry button that flips the project back to `pending`. When the
quote is `declined` and the pre-trash snapshot was `draft`, the row explains
that Books cannot restore a draft.

### i18n

New `aito.*` keys with real translations across all twelve locales — the i18n
gate rejects English placeholders.

## Error handling

| case | behaviour |
|---|---|
| Zoho not configured | the project is still created; sync state stays `idle`, the panel says sync is off |
| Books unreachable | stays `pending` and retries; `error` after 5 consecutive failures |
| Zoho rejects the payload (400) | `error` plus the message; no retry |
| quote invoiced | `locked`; edits stay local, the board is unaffected |
| quote deleted in Books | `error`, with the option to clear the link |
| worker crashes | the lifespan task is restarted; `pending` rows are picked up on the next tick — nothing is lost, because the queue is a column |

## Testing

**The round-trip invariant.** Because both directions now exist as I/O-free
modules, the strongest test is composition: build line items from a project,
wrap them in a synthetic estimate (`is_inclusive_tax: true`,
`price_precision: 0`, each line's `sku` derived from its `item_id`), feed that
to `aito_quote_import.build_preview`, and assert the same tasks come back —
titles, costs, weight, time, colour and free text. This covers the weight and
time formatters, placeholder omission, the free-text label collision, and task
boundaries in one assertion per fixture.

It only holds once the importer is header-aware (§1b), which is why that change
is part of this phase rather than a nicety. The test is therefore also the
regression guard for it.

- `backend/tests/unit/services/test_aito_quote_export.py` — fixtures for a
  single-task project (no header), a multi-task project (headers), a
  four-service task, a task with only Usinage, an impression line with
  `quantity > 1` (the rounding write-back), a project whose estimate carries
  foreign lines (preservation and ordering), and NULL weight/time/colour
  (row omission). Plus the round-trip tests above.
- `backend/tests/unit/services/test_aito_quote_sync.py` — the worker through
  the existing `zoho_service.transport` `httpx.MockTransport` seam: create,
  update, the invoiced lock, 400 → `error`, 502 → retry then escalate,
  trash → decline, restore → re-apply, restore-from-draft → stays declined,
  404 → error, and `pending` + `idle` selection (an old card is never touched).
- Route tests: every handler above marks `pending`; `/move` does not.
- `NewProjectModal.test.tsx` — one task present on open, submit disabled until
  a service is priced, last task not removable.
- `ProjectDetailPanel` — the sync row's states.

## Out of scope

- **Phase 2, the pull.** No poller, no `last_modified_time` comparison. The
  watermark is written but not yet read.
- Emailing the quote, converting it to an invoice, or any status transition
  other than the trash/restore reconciliation.
- Mapping `L3DIMP` (laser) or `P3D2024` (legacy generic) onto a service. They
  remain foreign lines, preserved and invisible to the board.
- Surfacing foreign lines on the card. The quote total already exceeds the
  project total in the detail panel; itemising the gap is separate work.
- Backfilling quotes for existing quote-less projects.
- Per-task `subtotal` rows, which Books supports and this design does not use.

## Assumption to verify in the first implementation step

Changing `customer_id` on an existing estimate was **not** tested — the
throwaway quote had already been deleted when the question arose. Everything
else in *What the live API actually does* was verified against the live org.
If Books rejects a customer change on a `sent` estimate, the client-change push
degrades to leaving the customer alone and surfacing it as a `locked`-style
note; that fallback is cheap and does not disturb the rest of the design.
