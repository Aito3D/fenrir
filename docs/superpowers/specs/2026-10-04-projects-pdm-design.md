# Projects as a PDM — design

Date: 2026-10-04. Replaces the Bambuddy "group prints" project feature.

Agreed in chat with the operator (Aito3D). In short:

- An Aito **task** is the thing a client pays for. The **project** is the work behind it: the
  scan, the model, the print files. A project can be reused by later tasks from other orders
  and other clients (a reprint is a new order and a new task, but the same project).
- Every project has a PDM-like structure: **sections** (Scan, Modélisation, Impression,
  Usinage, Docs) → **items** (one logical part or document) → **revisions** R1, R2, R3…
- **Every project file lives on the NAS.** The folder tree is organised by project, never by
  client.
- Files reach a project three ways: dropped on an Aito task card, uploaded on the project
  page, or put in the project's `_inbox/` folder on the NAS.
- The library stays the storage layer (file rows, hashes, thumbnails, tags). Projects are the
  structured view on top of it. The file manager keeps non-project files and shows project
  folders read-only.
- Old projects are migrated into the new model. BOM, target counts and the print timeline are
  kept. Sub-projects (`parent_id`) are not used and stop being shown.

Wording in the UI: **Commande** is the Aito card (`AitoProject` in code), **Projet** is the
new project. In code, `projects` keeps its name; `aito_projects` keeps its name too, but new
code and comments call it "the order".

---

## 1. Data model

### 1.1 `projects` (existing table, extended)

The table is kept so that `print_archives.project_id`, `print_queue.project_id`,
`library_files.project_id`, `library_folders.project_id` and `project_bom_items` keep working
without a data move.

New columns:

| Column | Type | Notes |
|---|---|---|
| `code` | `String(16)`, unique, not null after migration | `P-0001`, `P-0002`… Assigned at creation from a counter, never reused. |
| `storage_dir` | `String(255)`, nullable | Folder name under the projects root, e.g. `P-0042_support-camera-fx3`. Fixed at creation (see §2.2). |
| `storage_state` | `String(16)`, default `ready` | `ready` or `pending` (folder not created yet because the NAS was unreachable). |

Existing columns: `name` is the title. `description`, `status`, `notes`, `due_date`,
`priority`, `budget`, `target_*`, `cover_image_filename` and the BOM relation stay.
`attachments` (JSON) and `tags` (text) are emptied by the migration (§7) and no longer
written. `parent_id`, `is_template` and `template_source_id` stay in the schema but are not
shown in the new UI.

### 1.2 `project_tags` (new)

`(project_id → projects.id CASCADE, tag_id → library_tags.id CASCADE)`, primary key on the
pair. It reuses the global `library_tags` catalog, so one tag ("drone", "pièce auto") works on
both files and projects, and the existing case-insensitive `name_key` dedupe applies.

### 1.3 `project_items` (new)

| Column | Type | Notes |
|---|---|---|
| `id` | int PK | |
| `project_id` | FK projects CASCADE | |
| `section` | `String(16)` | `scan` · `modelisation` · `impression` · `usinage` · `docs` (same keys as the Aito services, plus `docs`) |
| `name` | `String(255)` | "Mesh nettoyé", "Support". Unique per (project, section), case-insensitive. |
| `position` | int | Order inside the section. |
| `created_at` | datetime | |

### 1.4 `project_revisions` (new)

| Column | Type | Notes |
|---|---|---|
| `id` | int PK | |
| `item_id` | FK project_items CASCADE | |
| `number` | int | Shown as `R{number}`. Unique per item. Next number = max + 1. Numbers are never reused, even after a delete. |
| `status` | `String(16)` | `wip` · `valide` · `livre` · `obsolete`. New revisions start as `wip`. |
| `note` | Text, nullable | What changed. |
| `derived_from_id` | FK project_revisions SET NULL, nullable | Lineage, e.g. Impression R3 ← Modélisation R2 ← Scan R1. |
| `locked_at` | datetime, nullable | Set when the revision is delivered (§5.4). A locked revision cannot take files or be deleted. |
| `created_by_id` | FK users SET NULL | |
| `created_at` | datetime | |

### 1.5 Files of a revision

A revision holds 1..n files (a scan is often `.ply` + texture + `.mtl`). Each file is a normal
`library_files` row with a new nullable column `revision_id → project_revisions.id`
(SET NULL). Those rows have `is_external = true`, an absolute `file_path` on the NAS,
`project_id` set, and `folder_id` = the project's managed library folder (§6).

New columns on `library_files` to detect edits made directly on the NAS:
`fs_size` (bigint) and `fs_mtime` (datetime), recorded at filing time.

### 1.6 Aito links (new)

- `aito_tasks.linked_project_id → projects.id SET NULL`, nullable. A task points to at most
  one project; a project has many tasks across orders. (`aito_tasks.project_id` already exists
  and means the order, hence the different name.)
- `aito_task_deliveries`: `(task_id → aito_tasks CASCADE, revision_id → project_revisions
  RESTRICT, created_at)`, PK on the pair. It records exactly which revisions a task delivered:
  "Client A got Mesh R2 + Print R1, Client B's reprint got Print R3".

### 1.7 Print traceability

`print_archives.revision_id` and `print_queue.revision_id` → `project_revisions` SET NULL,
nullable. They are set when a print is started from a revision file (§5.5).

All migrations are additive and go in `core/database.py` in the existing hand-written style
(`_safe_execute` for `ALTER TABLE`), working on both SQLite and Postgres.

---

## 2. NAS storage

### 2.1 Projects root

- A new setting, `projects_root`: an absolute path inside the container where the NAS is
  mounted, e.g. `/mnt/nas/Projets`. The NAS is mounted on the host (SMB or NFS) and
  bind-mounted into the container. `docker-compose.yml` gets a commented example volume.
- The Settings page shows the path, whether it can be read and written, and the free space.
  Health check: create, then delete, a `.fenrir-write-test` file.
- **No silent local fallback.** If the root is not configured or not writable, project file
  operations return HTTP 503 with `projects.nasUnavailable`, and the UI shows a banner on the
  projects pages. Projects can still be created and edited (title, tags); their folders are
  created later (`storage_state = pending`, retried on the next file operation and by a
  "Retry" button).

### 2.2 Folder layout

```
{projects_root}/
  P-0042_support-camera-fx3/
    _inbox/
    _meta/cover.jpg
    Scan/Mesh nettoyé/R1/scan_raw.ply
    Scan/Mesh nettoyé/R1/texture.jpg
    Scan/Mesh nettoyé/R2/scan_clean.ply
    Modélisation/Support/R1/support.step
    Impression/Support/R3/support_x4.3mf
    Docs/Plan client/R1/plan.pdf
```

- **Project folder:** `{code}_{slug(title at creation)}`. Renaming the project does not
  rename the folder, so NAS shortcuts and paths in other tools keep working. The code is the
  stable part; the slug is only a hint.
- **Section folder names:** human-readable French (`Scan`, `Modélisation`, `Impression`,
  `Usinage`, `Docs`).
- **Item and revision folders:** the item name, sanitised (path separators, `..`, control
  characters and Windows-reserved characters/names removed; at most 100 characters), then
  `R{n}`.
- **Renaming an item:** renames its folder. This is a rename on one filesystem, so it is
  instant. The `library_files.file_path` values are updated in the same transaction; if the
  rename fails, the DB change is rolled back.
- **Every resolved path** is checked to stay under `projects_root` (no path traversal).

### 2.3 Writing files

- **Uploads** stream to `R{n}/{filename}.part` and are renamed once complete, so a
  half-written file is never visible under its real name. There is no full in-memory read,
  and size limits come from the existing upload settings.
- **SHA256 hash and thumbnails** are computed by a background task after the upload returns.
  Existing thumbnailers are used for STL, 3MF and PDF. Meshes over a size threshold (setting,
  default 200 MB) and formats without a thumbnailer (PLY, OBJ, E57) get a type icon.
- **Duplicates:** a file whose hash already exists in the same item gives a warning ("same as
  R1"), not a hard block.

### 2.4 Integrity

When a revision is shown, each file's current size and mtime are compared with `fs_size` /
`fs_mtime` (cheap `stat`). If they differ, or the file is missing, the revision shows a
"modified outside Fenrir" / "missing" badge. "Re-check" recomputes the hash. Nothing is ever
changed or deleted on the NAS automatically.

---

## 3. Inbox

Each project has `{project}/_inbox/`. People drop files there from any computer, mainly the
scanner PC for large scans.

- **Listing:** `GET /projects/{id}/inbox` lists the folder on request (name, size, mtime).
  Files are hidden while still being written: `.part`, `.tmp`, `~$*`, dotfiles, or files
  whose size or mtime changed in the last 30 seconds (the file shows as "copying…").
- **Badge:** a background job (every 60 s) stores the inbox counts in memory, which drive the
  badge on the project list and project page. SMB and NFS do not deliver inotify events
  reliably, so it polls instead of watching.
- **Filing:** the user selects one or more inbox files and picks a section plus either an
  existing item (→ new revision) or a new item name (→ R1). The section is pre-selected from
  the extension (§5.3). The server **moves** the files (rename, instant even for very large
  scans) into `Section/Item/R{n}/` and creates the revision and library rows.
- **Sub-folders** dropped in `_inbox/` are filed as a whole: every file inside goes into the
  same revision.
- **Global inbox:** the projects list has an "Inbox" filter showing all projects with files
  waiting.

---

## 4. Projects pages

### 4.1 List (`/projects`, replaces `ProjectsPage`)

- **Table** (default) or **card grid**. Columns: code, title, tags, clients (distinct names
  from linked orders), number of orders, latest revision activity, inbox count, updated.
- **Search box** matches code, title, description, tag names, item names, file names, and the
  client names and order numbers of linked tasks. It is a case-insensitive `LIKE` over joined
  tables (works on SQLite and Postgres); full-text search can come later if needed.
- **Filters:** tags (any/all), client, status, section has files, "has WIP revisions",
  "inbox not empty", updated date range.
- **Actions:** "New project", and per row Open, Duplicate (structure only, no files), Archive.

### 4.2 Detail (`/projects/:id`)

Header: code chip, title, description, tags, status, cover image.

Tabs:

1. **Fichiers** (default): the PDM view, §4.3.
2. **Commandes:** linked tasks grouped by order (order number, client, date, board column)
   with the revisions each task delivered. "Link to a task…" opens a picker.
3. **Impressions:** the existing print archives and queue items, plus the existing timeline,
   now showing the revision used.
4. **BOM:** the existing BOM.
5. **Notes:** the existing rich-text notes.

### 4.3 PDM view

- **Sections** are collapsible blocks, in the fixed order Scan, Modélisation, Impression,
  Usinage, Docs. Empty sections are collapsed. Sections matching the services of linked tasks
  are always shown.
- **Item row:** name, latest revision chip (`R3 · Validé`), file count and total size,
  thumbnail, and a "derived from Modélisation › Support R2" link.
- **Expanding an item** shows its revision history, newest first. Each revision shows its
  files, note, author, date, status, lock and integrity badges, and the deliveries it was
  part of.
- **Revision actions:** new revision (upload or from inbox), change status, set "derived
  from", download one file / all as zip, print (3MF / G-code files only), delete (unlocked
  revisions only, and the files are moved to `_trash/` in the project folder rather than
  deleted).
- **Drag and drop:** dropping files on a section creates a new item; dropping on an item
  creates a new revision.
- **Inbox panel:** a drawer with the count in the header.

### 4.4 AI

These use `services/openrouter.py`, in French, following the `AiTextField` pattern:

- **Title and description:** reformulate a draft. When creating a project from a task, the
  task description is the draft.
- **Tag suggestions:** returns up to 5 tags, existing ones from `library_tags` first. New tag
  names are only proposed when nothing existing fits (at most 2). The user accepts each chip;
  nothing is applied automatically.

---

## 5. Aito integration

### 5.1 Creating or linking a project from a task

The task panel gets a **Projet** row:

- If no project is linked: buttons "Nouveau projet" and "Lier un projet existant".
  - **New:** title and description are pre-filled from the task (AI reformulation offered),
    and tags are suggested.
  - **Link:** a search picker using the same search as §4.1. This is the reprint case.
- If a project is linked: its code chip and title link to the project page, with an "Unlink"
  action.

The board card shows the project code chip.

### 5.2 New order from a project

"Nouvelle commande" on the project page creates an Aito card in the Devis column for a chosen
client, with one task already linked to the project. Its description is pre-filled from the
project description.

### 5.3 Dropping files on a task card

- If no project is linked, the drop first asks to create one (pre-filled as in §5.1).
- The section is guessed from the extension, and the user can change it before confirming:

  | Extensions | Section |
  |---|---|
  | `.ply` `.obj` `.e57` `.xyz` `.pts` | Scan |
  | `.step` `.stp` `.iges` `.f3d` `.stl` `.sldprt` | Modélisation |
  | `.3mf` `.gcode` `.bgcode` | Impression |
  | `.nc` `.tap` `.dxf` | Usinage |
  | anything else (`.pdf`, images…) | Docs |

  `.stl` defaults to Modélisation; a 3MF/G-code is what gets printed.
- **Item name:** the file name without extension. If an item with that name exists in the
  section, the files become its next revision.

### 5.4 Deliveries

- The task's **Projet** row has "Fichiers livrés": a picker of the project's revisions.
  - Default suggestion: the latest `valide` revision of each item in the sections matching
    the task's enabled services.
  - Picks are stored in `aito_task_deliveries`.
- When the order reaches **Done**, every revision in its deliveries is set to `livre` and
  locked (`locked_at`). An `AitoEvent` records it on the order timeline.
- Moving the order back out of Done does not unlock. A locked revision can only be unlocked
  by a user with `projects:delete`, with a confirmation.

### 5.5 Printing from a revision

"Print" on a revision file opens the existing print flow (printer pick, plate, AMS mapping).
The queue item and the resulting archive get `project_id` and `revision_id`. The Impressions
tab and the order timeline show "printed Support R3 on X1C-2".

---

## 6. File manager

- **Root folder:** a managed root library folder "Projets" is created, with one child
  `library_folders` row per project. That row has `is_external = true`,
  `external_readonly = true`, `external_path` = the project folder and `project_id` set,
  plus a new `is_managed` boolean column.
- **Managed folders in the file manager:**
  - Read-only: no upload, move, rename or delete there.
  - The "Ouvrir le projet" button goes to `/projects/:id`.
  - Search and tags still find their files.
- **Everything else is unchanged:** catalog models, MakerWorld downloads, external mounts,
  print-from-library and trash.
- **"Move to a project…"** is a new action on non-project library files. It files them into
  a chosen project, section and item (as a new revision) and moves them to the NAS.

---

## 7. Migration of the old projects

It is in two steps, because the NAS may not be reachable when the app starts.

**Step 1 — schema and metadata (at startup, in `core/database.py`):**

1. Add the new tables and columns.
2. Assign `code` by `created_at` order: `P-0001`…
3. Split `projects.tags` on commas, trim, and get-or-create `library_tags` by `name_key`;
   fill `project_tags`; then set `tags` to NULL.
4. Set `storage_state = 'pending'` on every project.

**Step 2 — files (a background job, started once `projects_root` is writable, and re-runnable
from Settings with a progress view):**

For each pending project:

1. Create its folder.
2. Each `attachments` entry → a Docs item named after the original file → R1. Copy the file
   to the NAS, check the hash, then remove the local copy. The cover image goes to
   `_meta/cover.jpg`.
3. Library files with this `project_id` (non-external): section from the extension (§5.3),
   item = file name without extension, R1. Copy them to the NAS, check the hash, then point
   the `library_files` row at the NAS path. The local file is deleted only after the row is
   updated.
4. Library files with this `project_id` that are on a **read-only external mount**: same,
   but **copy only**. The original is left in place, and the new row keeps its own hash.
5. Set `attachments` to NULL and `storage_state = 'ready'`.

Each project is migrated in its own transaction, so a failure leaves that project
`pending` with the error shown, and the others carry on. `parent_id` is left as is (unused).

---

## 8. API (new or changed, under `/api/v1`)

| Method & path | Purpose |
|---|---|
| `GET /projects` | List with `q`, `tag_ids`, `client`, `status`, `section`, `has_wip`, `has_inbox`, pagination |
| `POST /projects`, `PATCH /projects/{id}`, `DELETE /projects/{id}` | As today, plus `tag_ids`. Delete is refused while tasks are linked; files stay on the NAS (the folder is renamed `_deleted_{code}…`). |
| `GET /projects/{id}/tree` | Sections → items → revisions → files, with integrity flags |
| `POST /projects/{id}/items` · `PATCH/DELETE /projects/items/{id}` | Items |
| `POST /projects/items/{id}/revisions` (multipart upload) | New revision from uploaded files |
| `PATCH /projects/revisions/{id}` | Status, note, `derived_from_id` |
| `POST /projects/revisions/{id}/unlock` | `projects:delete` only |
| `DELETE /projects/revisions/{id}` | Unlocked only; files go to `_trash/` |
| `GET /projects/revisions/{id}/download` | One file (`?file_id=`) or a zip |
| `POST /projects/revisions/{id}/recheck` | Rehash |
| `GET /projects/{id}/inbox` · `POST /projects/{id}/inbox/file` | List / file inbox entries into an item |
| `POST /projects/ai/reformulate` · `POST /projects/ai/suggest-tags` | AI helpers |
| `POST /projects/{id}/orders` | New Aito order with a task linked to this project |
| `PATCH /aito/tasks/{id}` | Accepts `linked_project_id` |
| `PUT /aito/tasks/{id}/deliveries` | Replace the list of delivered revisions |
| `GET /settings/projects-storage` | Root path, health, free space, migration progress |

Permissions reuse `projects:read|create|update|delete`. Aito task changes keep their existing
Aito permissions.

---

## 9. Delivery plan

Each phase ships on its own and keeps the app working.

1. **Foundation:** the schema migration (step 1), `projects_root` setting and health check,
   folder creation, project codes, tags, and the new list page with search and filters. The
   detail header gets AI title, description and tags. The old detail tabs (prints, BOM,
   notes) stay.
2. **PDM:** items, revisions, uploads to the NAS, the Fichiers tab, integrity badges,
   downloads.
3. **Inbox:** listing, filing, badges, global inbox filter.
4. **Aito:** `linked_project_id`, the task panel Projet row, drop on card, "Nouvelle
   commande" from a project, deliveries and the lock on Done.
5. **Traceability:** derived-from links, printing from a revision, the revision shown in
   prints and timelines.
6. **Old data and file manager:** migration step 2 with its progress view; managed read-only
   project folders in the file manager; "Move to a project…".

Tests follow the repo's existing pattern: backend pytest per route and service, using a
temporary directory as `projects_root`, with path traversal, NAS-unavailable and migration
cases. Frontend Vitest for the PDM view and inbox. `npm run check:i18n` covers the new `projects.*`
strings in all locales (French first).

---

## 10. Still to decide

- **The rest of the data on the NAS:** "every file on the NAS" is applied to project files
  here. Should the non-project library and print archives move to the NAS too? That would
  be done by pointing the whole data/archive directory at the NAS, which is separate from
  this feature.
- **Who can mark a revision Validé?** Anyone with `projects:update` (proposed), or a
  narrower role?
- **PLY/OBJ previews:** are type icons enough for scans at first, or is a mesh thumbnailer
  needed early?
