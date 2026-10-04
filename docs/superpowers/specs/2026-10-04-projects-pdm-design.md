# Projects as a PDM — design

Date: 2026-10-04. Supersedes the earlier draft of the same name on branch `projects-pdm-spec`
(which assumed a NAS-only store and delivery locking; both are dropped here).

Agreed in chat with the operator (Aito3D). Status: **design under review — nothing approved
for implementation yet.**

## 0. Summary

- A **Projet** is a reusable part or product: "Support caméra FX3", code `P-0042`. It owns
  every engineering file of that part: scans, CAD, print files, documents.
- An **Aito task** (the thing a client pays for) **links** to a project. Many tasks, from many
  orders and many clients, can link to the same project. A reprint six months later is a new
  order and a new task, linked to the same project.
- Inside a project: **sections** (Scan, Modélisation, Impression, Usinage, Docs, matching the
  Aito services) → **items** (one logical part or document) → **revisions** R1, R2, R3…, each
  holding 1..n files.
- Revisions are **never locked**. A project keeps evolving: R3 made for client A, R4 reworked
  for client B, and A's reprint still uses R3. Each task records **which revisions it
  delivered**.
- **Impression revisions are the manufacturing builds.** Every printable 3MF is an Impression
  revision; the slicer settings embedded in the 3MF are parsed into an immutable snapshot.
  Prints (queue items and archives) record the revision and the task they were for.
- Files live in a **separate local projects space** in Fenrir's data directory, as a
  human-readable folder tree. The whole data directory (archives, library, projects) moves to
  the NAS later as one mount change; nothing here is NAS-specific.
- The **project page is the only door** to project files. They are hidden from the File
  Manager, which stays unchanged as the place for loose files (MakerWorld, one-offs) with a
  "Move to project…" bridge.

Wording in the UI (French first): **Commande** = the Aito card (`AitoProject` in code),
**Tâche** = `AitoTask`, **Projet** = the project (`projects` table). New code and comments call
`aito_projects` "the order" to avoid confusion.

### Non-goals

- No NAS integration in this feature (no NAS mount setting, no 503 "NAS unavailable" path, no
  `_inbox/` drop folder). These arrive with the later whole-data-directory NAS move.
- No approval workflow beyond the three statuses; no locking; no automatic status changes.
- No automatic Aito board moves.
- No changes to File Manager internals (upstream code; see §6).
- No STEP / PLY / OBJ 3D preview in this feature (type icons only).

---

## 1. Data model

All schema changes are additive: new tables come from `create_all`; new columns are
`ALTER TABLE` statements in `core/database.py:run_migrations()` using `_safe_execute`, valid on
SQLite and Postgres. New models are registered in the three import lists (models
`__init__`, `init_db()`, test `conftest.py`).

### 1.1 `projects` (existing table, extended)

Kept so `print_archives.project_id`, `print_queue.project_id`, `library_files.project_id`,
`library_folders.project_id` and `project_bom_items` keep working without a data move.

New columns:

| Column | Type | Notes |
|---|---|---|
| `code` | `String(16)`, unique | `P-0001`… Assigned at creation from a counter (a settings row), never reused, even after a delete. |
| `storage_dir` | `String(255)`, nullable | Folder name under the projects space, e.g. `P-0042_support-camera-fx3`. Fixed at creation; renaming the project does not rename the folder. |

Kept as is: `name` (the title), `description`, `status`, `notes`, `due_date`, `priority`,
`budget`, `target_*`, `cover_image_filename`, BOM. `tags` (text) and `attachments` (JSON) are
migrated (§7) and then no longer written. `parent_id`, `is_template`, `template_source_id` stay
in the schema and are not shown in the new UI.

### 1.2 `project_tags` (new)

`(project_id → projects CASCADE, tag_id → library_tags CASCADE)`, PK on the pair. Reuses the
global `library_tags` catalogue and its case-insensitive `name_key` dedupe, so one tag works on
files and projects.

### 1.3 `project_items` (new)

| Column | Type | Notes |
|---|---|---|
| `id` | int PK | |
| `project_id` | FK projects CASCADE, indexed | |
| `section` | `String(16)` | `scan` · `modelisation` · `impression` · `usinage` · `docs` — the Aito service keys plus `docs`. |
| `name` | `String(255)` | "Mesh brut", "Support — H2D PETG-CF 0.6". Unique per (project, section), case-insensitive. |
| `forked_from_revision_id` | FK project_revisions SET NULL, nullable | Set by "Fork as new item" (§2.4). |
| `position` | int | Order inside the section. |
| `created_by_id`, `created_at`, `updated_at` | | |

### 1.4 `project_revisions` (new)

| Column | Type | Notes |
|---|---|---|
| `id` | int PK | |
| `item_id` | FK project_items CASCADE, indexed | |
| `number` | int | Shown as `R{number}`. Unique per item; next = max + 1; never reused. |
| `status` | `String(16)`, indexed | `wip` (En cours) · `valide` (Validé) · `obsolete` (Obsolète). New revisions start `wip`. |
| `note` | Text, nullable | What changed. |
| `derived_from_id` | FK project_revisions SET NULL, nullable, indexed | Lineage across items and sections: Impression "Support — H2D" R2 ← Modélisation "Support" R3 ← Scan "Mesh brut" R1. |
| `config_snapshot` | JSON, nullable | Impression only, see §5.1. Written once, never updated. |
| `config_hash` | `String(64)`, nullable | SHA-256 of the canonical snapshot JSON. |
| `slicer_name`, `slicer_version` | `String(64)`, nullable | From the 3MF. |
| `print_profile` | JSON, nullable | Display summary parsed from the snapshot: printer model, nozzle, filament(s), layer height, process name. |
| `pipeline_id`, `pipeline_name` | nullable | Only for pipeline-sliced revisions (§9 phase 6); the name is a snapshot. |
| `status_changed_by_id`, `status_changed_at` | nullable | Last status change; the full history is in events (§4.4). |
| `created_by_id`, `created_at` | | |

Rules:
- **Several revisions of one item may be `valide` at the same time.** `obsolete` is a manual
  "don't use this" (bad scan, wrong model), never automatic.
- **Files of a revision are immutable.** A revision cannot gain, lose or replace files once it
  has been printed or delivered (§3.4) — make a new revision instead. Before that, while
  `wip`, files can be added or removed (fixing a wrong upload).
- A revision can be deleted only if it was never printed or delivered and the user has
  `projects:delete`. Its number is not reused; its files go to the project's `_trash/` folder.

### 1.5 Files of a revision

Each file is a normal `library_files` row so print, queue, slice, thumbnails, 3D preview and
download keep working unchanged. Project files have:

- new column `library_files.revision_id → project_revisions SET NULL`, nullable, indexed;
- `project_id` set, `folder_id` NULL, `is_external = false`;
- `file_path` relative to `base_dir`, inside the projects space (§2);
- `file_hash` (SHA-256), `file_size`, `thumbnail_path`, `file_metadata` as today.

`revision_id IS NOT NULL` is **the marker** that hides a file from the File Manager (§6.1).

### 1.6 Aito links (new)

- `aito_tasks.linked_project_id → projects SET NULL`, nullable, indexed. A task links to at
  most one project; a project has many tasks across orders. (`aito_tasks.project_id` already
  exists and means the order, hence the different name.)
- `aito_task_deliveries`: `(task_id → aito_tasks CASCADE, revision_id → project_revisions
  CASCADE, created_by_id, created_at)`, PK on the pair. Records which revisions a task used:
  "ACME #187 got Support R3; client B #203 got Support R4". No locking.

### 1.7 Print traceability

New nullable, indexed columns on both `print_queue` and `print_archives`:

- `revision_id → project_revisions SET NULL`
- `aito_task_id → aito_tasks SET NULL`

The scheduler copies both from the queue item onto the archive where it already sets
`item.archive_id` in `_start_print` (`print_scheduler.py`). `project_id` is set too, so the
existing project prints views keep working.

---

## 2. Storage: the projects space

### 2.1 Location

`{data}/projects/` (a sibling of `archive/`, under the same data directory), created at
startup. The NAS move later points the whole data directory at the NAS; this layout needs no
change for it. Every resolved path is checked to stay under the projects root (path-traversal
guard on every read, write and rename).

### 2.2 Folder layout

```
{data}/projects/
  P-0042_support-camera-fx3/
    Scan/Mesh brut/R1/scan_raw.ply
    Scan/Mesh brut/R1/texture.jpg
    Modélisation/Support/R3/support.step
    Impression/Support — H2D PETG-CF 0.6/R2/support_x4.gcode.3mf
    Docs/Plan client/R1/plan.pdf
    _trash/
```

- **Project folder:** `{code}_{slug(title at creation)}`, fixed for life.
- **Section folders:** French labels (`Scan`, `Modélisation`, `Impression`, `Usinage`, `Docs`).
- **Item and revision folders:** item name sanitised (separators, `..`, control characters,
  Windows-reserved names and characters removed; ≤ 100 chars), then `R{n}`.
- **Filenames:** the original filename is kept (sanitised the same way). Two files with the
  same name in one revision get a ` (2)` suffix.
- **Renaming an item** renames its folder (same filesystem, instant) and updates the affected
  `library_files.file_path` values in one transaction; a failed rename rolls back the DB.

### 2.3 Writing files

- Uploads stream to `R{n}/{filename}.part` and are renamed when complete. Size limits come
  from the existing upload settings.
- SHA-256 and thumbnails run in a background task after the upload returns, reusing the
  existing thumbnailers (STL, 3MF, PDF; STEP via the existing client-rendered thumbnail path).
  PLY / OBJ / E57 and meshes over a size threshold get a type icon.
- Duplicate hash inside the same item → a warning ("identique à R1"), not a block.

### 2.4 Item actions

- **Fork as new item:** copies a revision's files into a new item's R1 in the same section,
  with `forked_from_revision_id` and `derived_from_id` set. For a permanent divergence
  ("Support — version client B").
- **Duplicate project:** structure only (sections/items), no files.

---

## 3. Project pages

### 3.1 List — `/projects` (replaces `ProjectsPage`)

- Table (default) or card grid. Columns: code chip, title, tags, clients (distinct names from
  linked orders), number of orders, latest revision activity, updated.
- Search `q`: code, title, description, tag names, item names, file names, client names and
  order numbers of linked tasks — case-insensitive `LIKE` over joins (SQLite + Postgres).
- Filters: tags, client, status, "has WIP revisions", updated date range. Paginated.
- Actions: New project; per row Open, Duplicate, Archive.

### 3.2 Detail — `/projects/:id`

Header: code chip, title, description, tags, status, cover image. Title and description use the
existing `AiTextField` pattern (French reformulation via `services/openrouter.py`); tags get AI
suggestions (§3.5).

Tabs:
1. **Fichiers** (default) — the PDM view (§3.3).
2. **Commandes** — linked tasks grouped by order (number, client, column, date) with each
   task's delivered revisions; "Nouvelle commande" (§4.5).
3. **Impressions** — existing archives, queue items and timeline, now showing revision and order.
4. **BOM** — existing.
5. **Notes** — existing.
6. **Historique** — project events (§4.4).

### 3.3 Fichiers (PDM view)

- Sections as collapsible blocks in fixed order; empty sections collapsed, except sections
  matching the services of linked tasks, which are always shown.
- **Item row:** name, newest revision chip (`R3 · Validé`), file count and size, thumbnail,
  "dérivé de Modélisation › Support R3" link, OUTDATED chip (§5.3).
- **Expanded item:** revisions newest first, each with files, note, author, date, status, print
  profile summary (Impression), deliveries it was part of, print count.
- **Revision actions:** new revision (upload; drag-and-drop on the item), change status,
  set/clear "dérivé de", download a file or all as zip, preview (existing STL / 3MF viewer),
  Print / Add to queue (3MF and G-code only, §5.2), Fork as new item, delete (§1.4 rules).
- Drag-and-drop on a section creates a new item (name from the file name).

### 3.4 What "printed or delivered" means

A revision is *used* if any `print_queue`/`print_archives` row has its `revision_id`, or any
`aito_task_deliveries` row references it. Used revisions keep their files immutable (§1.4).

### 3.5 AI helpers

- `POST /projects/ai/reformulate` — French rewording of a title or description draft.
- `POST /projects/ai/suggest-tags` — up to 5 tags, existing `library_tags` first; at most 2 new
  names, only when nothing existing fits. The user accepts each chip; nothing is auto-applied.

---

## 4. Aito integration

### 4.1 Projet row on a task (order detail panel)

- **Not linked:** "Nouveau projet" (title + description pre-filled from the task, AI
  reformulation offered, tags suggested) and "Lier un projet existant" (search picker; likely
  matches first: same client's projects, then title similarity).
- **Linked:** code chip + title → project page; "Délier".

### 4.2 Sub-task summaries

Under each enabled service step of a linked task, one line from the matching section:

- Scan: `Mesh brut R1`
- Modélisation: `Support R3 · Validé`
- Impression: `Support — H2D PETG-CF R2 · 12/20 imprimées · 2 rejetées`

Clicking opens the project at that section. **Printed count** = sum of `print_archives.quantity`
over archives with `aito_task_id` = this task where (`status = completed` and
`user_verdict != 'reject'`) or `user_verdict = 'good'`. Target = `impression_quantity`. The
operator corrects it with the existing archive verdict controls. Reaching the target shows a
"cocher l'étape ?" suggestion; `impression_done` is never ticked automatically.

### 4.3 Delivered files and drops

- **Fichiers livrés:** a picker of the project's revisions. Default suggestion: newest `valide`
  revision of each item in the task's service sections. "Reprendre les fichiers de la commande
  #187" copies another task's delivery list (the reprint case). Stored in
  `aito_task_deliveries`.
- **Dropping files** on a task (panel) or on its board card: the section is guessed from the
  extension, editable before confirming —

  | Extensions | Section |
  |---|---|
  | `.ply` `.obj` `.e57` `.xyz` `.pts` | Scan |
  | `.step` `.stp` `.iges` `.f3d` `.stl` `.sldprt` | Modélisation |
  | `.3mf` `.gcode` `.bgcode` | Impression |
  | `.nc` `.tap` `.dxf` | Usinage |
  | anything else | Docs |

  Item name = file name without extension; an existing item with that name gets the next
  revision. With no linked project the drop first offers to create or link one. On a card with
  several linked tasks, the drop asks which task.

### 4.4 Events

Project file actions write `AitoEvent` rows on the order timeline of every task linked to the
project at that moment (`revision.added`, `revision.status_changed` with previous/new status,
`revision.delivered`, `print.queued_from_revision`), registered in the
`services/aito_events.py` kind registry. The project's Historique tab reads a project-scoped
event log: a new `project_events` table (`project_id`, `kind`, `actor`, `subject` snapshot,
`detail` JSON, `occurred_at`) mirroring `AitoEvent`'s shape, merged with the existing print
timeline.

### 4.5 New order from a project

"Nouvelle commande" creates an Aito card in Devis for a chosen client, with one task linked to
the project and its description pre-filled from the project.

### 4.6 Board card

The project code chip(s) of the card's tasks. One optional warning chip: OUTDATED print file in
a delivery, or an Impression step with no Impression revision yet. Nothing else.

---

## 5. Production

### 5.1 Config snapshot

When a `.3mf` / `.gcode.3mf` is added to an Impression revision (any route: upload, drop,
auto-file, pipeline), Fenrir reads, inside the zip, `Metadata/project_settings.config` (the
effective settings the slicer used) and the slicer name/version from the 3MF metadata, and
stores them as `config_snapshot` / `config_hash` / `slicer_*` / `print_profile`. If the 3MF is
an unsliced project file, the snapshot still records its settings and `print_profile` notes
"non tranché". Parsing failures leave the fields NULL and never block the upload. The snapshot
is written once.

### 5.2 Printing from a revision

"Imprimer" / "Ajouter à la file" on an Impression revision file opens the existing print modal
(printer or model, plate, AMS mapping, copies). The queue item gets `library_file_id`,
`project_id`, `revision_id` and `aito_task_id`:

- from a task's panel → that task;
- from the project page → "pour quelle commande ?" picker, defaulting to the only open linked
  task; "aucune" allowed (internal / test print).

### 5.3 OUTDATED

An Impression revision is **outdated** when its `derived_from` revision belongs to an item that
now has a newer `valide` revision. Computed at read time, never stored. Shown as a chip with
"Basé sur Support R3 — R4 validée depuis (commande #203)". Printing an outdated revision shows
the same text in the print modal as a warning; it never blocks (it may be the intended reprint).

### 5.4 Traceability chain

archive → queue item → Impression revision (config snapshot, slicer version) → derived from
Modélisation R3 → Scan R1 → project → task → order → client. Each step is a foreign key.

---

## 6. File Manager

### 6.1 Hiding project files

A central helper next to `LibraryFile.active()` — `LibraryFile.file_manager()` (active **and**
`revision_id IS NULL`) — replaces `active()` in File Manager listings, search, stats, duplicate
check, bulk operations and trash. A test sweeps every library list endpoint and asserts no
project file appears. Bulk delete and trash purge can never touch a project file. Direct
by-id routes (download, thumbnail, preview, print) keep working for project files, since print
and preview reuse them.

### 6.2 Move to project…

A File Manager action on any non-project file: choose a project (or create one), section, and
item (existing → next revision; new → R1). The file is moved into the projects space and its
row gets `revision_id` (it disappears from the File Manager). Read-only external-mount files
are copied instead of moved.

### 6.3 Helpers

- **Suggested project:** on unfiled files, a suggestion by filename similarity to item names
  and project titles, with an optional AI ranking via `openrouter.py`. One click accepts.
- **Auto-filing by code:** a file whose name starts with `P-0042_` (case-insensitive, also
  `P-0042 ` / `P-0042-`) is filed into that project's Impression section — item = the rest of
  the name without extension, next revision — when it arrives through File Manager upload or
  the virtual printer ingest (archive / pending upload path). Unknown codes fall back to normal
  behaviour. A setting turns it off.

---

## 7. Migration of existing projects

**Step 1 — at startup (`core/database.py`):**
1. Add the new tables and columns.
2. Assign `code` in `created_at` order (`P-0001`…); set the counter past the highest.
3. Split `projects.tags` on commas, trim, get-or-create `library_tags` by `name_key`, fill
   `project_tags`, set `tags` NULL.
4. Leave `storage_dir` NULL (folder created lazily on first file operation).

Idempotent: each step checks whether it already ran.

**Step 2 — files (phase 5; a background job started from Settings with a progress view):**
for each project, `attachments` entries → a Docs item per file (R1); library files with this
`project_id` → section from extension, item from file name, R1, moved into the projects space
(rows updated, local copy removed after the row update); read-only external files are copied.
One transaction per project; failures leave that project untouched and listed.

---

## 8. API (under `/api/v1`)

| Method & path | Purpose |
|---|---|
| `GET /projects` | List with `q`, `tag_ids`, `client`, `status`, `has_wip`, pagination |
| `POST /projects` · `PATCH /projects/{id}` · `DELETE /projects/{id}` | As today plus `tag_ids`; delete refused while tasks are linked; files kept (folder renamed `_deleted_{code}…`) |
| `GET /projects/{id}/tree` | Sections → items → revisions → files, with outdated flags and print counts, in one payload (one query per table + grouped counts, no N+1) |
| `POST /projects/{id}/items` · `PATCH/DELETE /projects/items/{id}` | Items |
| `POST /projects/items/{id}/fork` | Fork a revision as a new item |
| `POST /projects/items/{id}/revisions` (multipart) | New revision from uploaded files |
| `POST /projects/revisions/{id}/files` · `DELETE /projects/revisions/{id}/files/{file_id}` | Edit files of an unused `wip` revision |
| `PATCH /projects/revisions/{id}` | Status, note, `derived_from_id` |
| `DELETE /projects/revisions/{id}` | Unused revisions only |
| `GET /projects/revisions/{id}/download` | One file (`?file_id=`) or zip |
| `GET /projects/revisions/{id}/lineage` | Up (derived-from chain), down (derived revisions), prints, deliveries |
| `POST /projects/ai/reformulate` · `POST /projects/ai/suggest-tags` | AI helpers |
| `POST /projects/{id}/orders` | New Aito order with a linked task |
| `PATCH /aito/tasks/{id}` | Accepts `linked_project_id` |
| `PUT /aito/tasks/{id}/deliveries` | Replace a task's delivered revisions |
| `POST /aito/tasks/{id}/files` | Drop on a task → file into its project |
| `POST /library/files/{id}/move-to-project` | §6.2 |
| `GET /library/files/{id}/project-suggestions` | §6.3 |

Queue creation (`POST /queue/`, library add-to-queue) accepts optional `revision_id` and
`aito_task_id`, validated (the file must belong to that revision).

**Permissions:** reuse `projects:read|create|update|delete`. Changing a revision status
(including Validé) needs `projects:update`; deleting a revision or item needs `projects:delete`.
Linking a task and editing deliveries need `aito:update` plus `projects:read`. Printing keeps the
existing `queue:create` / printer permissions.

---

## 9. Delivery plan

Each phase ships alone and keeps the app working.

1. **Foundation** — migration step 1 (codes, tags), projects space + path guards, new list page
   with search/filters, detail header with AI title/description/tags. Old detail tabs stay.
2. **Files** — items, revisions, uploads into the tree, statuses, notes, derived-from, fork,
   previews, downloads, 3MF config snapshot, File Manager hiding (§6.1).
3. **Aito link** — `linked_project_id`, Projet row, sub-task summaries, drops on panel and card,
   deliveries with "reprendre de la commande", Commandes tab, Nouvelle commande, events.
4. **Production traceability** — print / queue from revisions, `revision_id` + `aito_task_id`
   on queue and archives, printed count vs `impression_quantity`, OUTDATED.
5. **File Manager bridge** — Move to project, suggestions, `P-0042_` auto-filing, migration
   step 2.
6. **Pipeline slicing** — Slice / Slice + Queue on Modélisation STL/STEP revisions through the
   existing `SlicerPipeline` run path; output becomes the next revision of a chosen Impression
   item with `derived_from`, `pipeline_id` and `pipeline_name`; queue items carry
   `revision_id` + `aito_task_id`. (The shop slices by hand today; this is an optimisation.)

## 10. Testing

- Backend pytest per route and service, with a temporary directory as the projects root:
  migration step 1 (codes in order, counter, tag conversion + dedupe, idempotence), path
  traversal on every path-building helper, revision numbering, status rules, immutability of
  used revisions, File Manager hiding sweep, snapshot parsing (fixture 3MFs from Bambu Studio
  and OrcaSlicer, plus a corrupt one), outdated computation, archive inherits `revision_id` /
  `aito_task_id` from the queue item, printed-count verdict rules, cross-project and cross-task
  isolation, permissions.
- Frontend Vitest for the list page, PDM view, Projet row, delivery picker, drop flow.
- `npm run check:i18n` for the new `projects.*` keys in all 15 locales, French first.

## 11. Open points

- **Hand-sliced 3MF snapshot coverage:** confirm on real shop files that Bambu Studio's
  exported `.gcode.3mf` carries `project_settings.config` and a version header (expected; to be
  checked against a sample before phase 2 is planned).
- **Auto-filing target item:** phase 5 files `P-0042_*` uploads into Impression by name; whether
  operators want a confirmation toast with "move to another item" is to be seen in use.
