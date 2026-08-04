# Aito Subtask Descriptions & Quote Header Rework — Design

Date: 2026-08-03
Status: approved

## Goal

Rework how an Aito task's identity and prose reach the Zoho Books quote:

1. The task **title** appears on the quote **only as a header line** (`header_name`),
   never inside a product/service line's description — and the header is now
   emitted for every task with priced services, including a single-task project.
2. The task-level **description field is removed**.
3. Each of the four services (scan, modelisation, impression, usinage — the
   "subtasks") gains an **optional description**.
4. A service line's description starts with `Info: {subtask description}` when
   the description exists; when it does not, **no `Info:` row is emitted**.
5. The AI project-summary prompt is amended: numbers must be written as digits
   (« 3 pièces »), never spelled out in words.

## Non-goals

- No change to costs, discounts, done-flags, board rules, or quote status flow.
- No child table — the fixed service set stays columns on `aito_tasks`,
  matching the existing pattern (four cost columns, four done flags).
- The legacy `description` DB column is not dropped (additive-migration house
  style); it is only abandoned after a one-time copy.

## 1. Data model & migration

`backend/app/models/aito_task.py`:

- Remove the `description` mapped column from the ORM model.
- Add four nullable `Text` columns: `scan_description`,
  `modelisation_description`, `impression_description`, `usinage_description`.

`backend/app/core/database.py:run_migrations()`:

- ALTER TABLE to add the four columns (guarded by column-existence check, as
  the existing migrations are).
- On the run that adds the columns (first run only), copy each task's old
  `description` into the description of its **first enabled service**, in
  scan → modelisation → impression → usinage order (enabled = cost IS NOT
  NULL). Raw SQL — the ORM no longer maps the old column.
- A task with no enabled service keeps its text in the old DB column:
  invisible from the app, but not destroyed.

`backend/app/schemas/aito.py` — `AitoTaskBase`:

- Remove `description`.
- Add the four `*_description: str | None` fields (no length cap, mirroring
  the old field; blank collapses to null in the frontend serializer as today).

## 2. Quote export

`backend/app/services/aito_quote_export.py`:

- `ExportTask`: replace `description` with `scan_description`,
  `modelisation_description`, `impression_description`, `usinage_description`.
- `_rows(service, task)` becomes uniform:
  - scan / modelisation → `[("Info", <that service's description>)]`
  - usinage → `[("Info", usinage_description)]` (the `Usinage: {title}` row is
    gone)
  - impression → `[("Info", impression_description), ("Matériau", …),
    ("Poids", …), ("Temps", …), ("Couleur", …)]` (the `Projet: {title}` row is
    gone; Info leads)
  - The existing empty-row rule already drops an absent `Info:` — a service
    with no description emits no `Info:` row.
- scan/modelisation keep appending `*Fichier non cédé*`.
- `build_description` loses `include_free_text` and the task-free-text append
  entirely.
- `build_line_items`: remove the `len(emitted) > 1` condition — every task
  with priced services and a non-blank title gets `header_name` stamped on its
  lines. A blank title still means no header (Books needs a name).

`backend/app/services/aito_quote_sync.py`:

- Build `ExportTask` from the four new columns instead of `row.description`.

## 3. Quote import

`backend/app/services/aito_quote_import.py`:

- `parse_lines` already tracks `header_name`/`header_id` per line; it now also
  carries the header **text** through so `_build_task` can use it.
- Title resolution, in order:
  1. The group's `header_name` (new format — wins when present).
  2. Legacy fallback, unchanged: impression's `Projet:`, else first
     `Projet:`/`Info:`/`Usinage:` label in canonical order — only when the
     group has **no** header.
- `Info:` on a recognised line → that **service's description** (unless it was
  consumed as the legacy title above).
- Relocated preservation rule: unparsed/leftover labels and free text on a
  line now land in **that line's service description** instead of the defunct
  task description. Nothing the quote said may vanish — same rule, new home.
- Impression's `Poids`/`Temps`/`Couleur` parsing into fields is unchanged;
  partially-parsed values are preserved into `impression_description`.
- `_build_task` output dict: drop `description`, add the four
  `*_description` keys.
- `build_preview.suggested_description` (joined titles) is unchanged.

Round-trip guarantee: export → import must reproduce title (via header) and
each service description (via `Info:`). Round-trip tests updated to the new
format; legacy-format fixtures keep passing via the fallbacks.

## 4. AI summary

`backend/app/services/openrouter.py`:

- `_SYSTEM_PROMPT` gains an instruction: write all numbers as digits
  (e.g. « 3 pièces »), never in words.
- `_task_lines`: replace the single task-description append with the enabled
  services' descriptions (each bounded to 500 chars, as today).

## 5. Frontend

- `frontend/src/utils/taskDraft.ts` — `TaskDraft`: remove `description`, add
  `scanDescription` / `modelisationDescription` / `impressionDescription` /
  `usinageDescription` (strings, `''` default; blank → null on serialize).
- `frontend/src/components/aito/TaskStepFields.tsx`: remove the task-level
  textarea; each enabled service's `StepBlock` gains an optional description
  textarea beneath its cost input.
- `frontend/src/components/aito/TaskRow.tsx` / `TaskStepList.tsx`: read mode
  shows each step's description with its step row instead of one task blurb.
- `frontend/src/components/aito/ImportQuoteDrawer.tsx`: preview renders
  per-service descriptions.
- `frontend/src/api/client.ts`: task types updated to match the schema.
- i18n: new keys get real French translations (the i18n gate rejects EN
  placeholders).
- Affected tests updated — including test fixtures, swept by grep (tsconfig
  never type-checks `src/__tests__`).

## Error handling

- Old-format quotes import via the legacy fallbacks; nothing 422s.
- Migration is idempotent: the copy runs only on the run that adds the
  columns.
- Empty descriptions everywhere collapse to null / emit nothing — the
  null-vs-empty rule matches the existing cost-field convention.

## Testing

- Backend: unit tests for `_rows`/`build_description`/`build_line_items`
  (header always; no title in lines; Info optional), importer title-from-header
  and description relocation, export→import round-trip in the new format,
  legacy import fixtures unchanged, migration copy behavior, `_task_lines` and
  prompt content.
- Frontend: TaskStepFields per-service textarea, TaskRow read mode,
  ImportQuoteDrawer preview, serializer null-collapse.
