# Projects catalog: browser layout with folders

Date: 2026-10-31. Supersedes §12.2.3 "List page — En production first" of
`2026-10-04-projects-pdm-design.md`. Demo: `2026-10-31-project-catalog-demo/index.html#b`.

## Intent

The Projects page becomes a catalog: find a project fast, see what matters about it, and reach its
printing files without leaving the page. The user picked proposition **B** (dense list on the left,
the selected project's printing files on the right) and asked for **folders**: a tree such as
`Car › Wheel cap` holding several projects (`350Z 60mm WheelCap`, `Toyota Wheel Cap`).

## User decisions

- Layout B. Folders, nested, projects filed inside them.
- One search over code, title, description, tags, client, order number, item and file names,
  printer, material and folder names. "Focus on important info."
- Selecting a project shows its printing files; printing from there.

## My calls (stated, not asked)

1. **Folder model**: a new `project_folders` table (`id`, `name`, `parent_id` nullable self-FK,
   `created_at`) and `projects.folder_id` (nullable FK, `ON DELETE SET NULL`). A project is in one
   folder or none. Depth is unlimited. Sub-projects (`projects.parent_id`) are untouched: they are a
   different relation (a master project and its parts), folders are shelves.
2. **Deleting a folder loses nothing**: its projects and sub-folders move up to its parent (or to the
   root). Renaming and re-parenting are allowed; re-parenting into its own subtree is refused (409).
3. **Permissions**: reading the tree and the catalog is `projects:read`; creating, renaming, moving
   and deleting folders, and filing a project, are `projects:update`.
4. **Catalog endpoint** `GET /projects/catalog` returns every matching project (no paging; capped at
   500, sorted by last activity) with the facts the row and the pane show. The existing `/search`
   stays for other callers.
5. **"Open order"**: an Aito order linked to one of the project's tasks whose status is not
   `deleted` and whose board column is not `done` (the §12.2.3 rule).
6. **Recommended revision**: per project, the newest Impression item revision with
   `status == valide` and a sliced file, else the newest sliced revision, else none. Its item name,
   `R#`, status, printer model, nozzle, filament types, print time and grams feed the row and the
   "Ready to print" filter.
7. **Right pane reuses `ProjectFilesPanel`** (the project page's files panel) for the selected
   project, so Print, preview, download, upload and the new-item drop zone behave exactly as on the
   project page. Above it: code, title, open-order badge, setup line, printed count, last activity,
   tags, "Open project".
8. **Phones (< lg)**: the list fills the screen and selecting a project navigates to the project
   page. The table / grid toggle is removed.
9. **Filtering flattens the tree**: with a search term or an active chip, the list shows matching
   projects flat, each with its folder path; without one, it shows the tree with counts per folder
   (projects inside, in production inside) and "Not in a folder" last. Collapsed folders are
   remembered in localStorage; the selected project and the query live in the URL
   (`?project=13&q=cap`).
10. **Filing a project**: drag a project row onto a folder row (or onto "Not in a folder"), or the
    row's move button with a folder picker. New folder: a button in the list header opens an inline
    row (name + parent). Folder row menu: rename, new sub-folder, delete.
11. **Materials chips** are derived from the loaded catalog (distinct filament types of recommended
    revisions), so the chip row never shows a material no project uses.

## API

- `GET /projects/folders` → `{ folders: [{id, name, parent_id, project_count, in_production_count}] }`
  (counts are for the folder's own subtree; computed from the same open-order rule).
- `POST /projects/folders` `{name, parent_id?}` → folder. `PATCH /projects/folders/{id}`
  `{name?, parent_id?}` (parent `null` = root). `DELETE /projects/folders/{id}` → 204.
- `PATCH /projects/{id}/folder` `{folder_id: int | null}` → `{id, folder_id}`.
- `GET /projects/catalog?q&status&tag_ids&tag_mode` → `{ items: CatalogItem[] }` where
  `CatalogItem = {id, code, name, status, folder_id, tags, client_names, open_orders:[{order_id,
  client_name}], files_count, recommended: {item_id, item_name, revision_id, number, status,
  printer_model, nozzle_diameter, filament_types, print_time_seconds, filament_used_grams} | null,
  has_unsliced_only: bool, printed_count, target_count, last_activity, thumbnail_file_id}`.
- Search term matching (case-insensitive LIKE, both dialects): code, name, description, tag names,
  folder names (the project's own folder and its ancestors), linked Aito orders' `client_name`,
  order id (`#1098` or `1098`), Impression item names, revision file names.

## Frontend

- `pages/ProjectListPage.tsx` rebuilt as the browser; pieces under `components/projects/catalog/`:
  `CatalogToolbar`, `CatalogTree` (folders + rows, drag/drop, inline new-folder and move),
  `CatalogRow`, `CatalogPane` (header + `ProjectFilesPanel`), `useProjectCatalog` (query + client
  filtering/sorting), `catalogRules.ts` (pure: filter, sort, tree building, path, highlight).
- Keyboard: `/` focuses search, `↑/↓` move the selection, `Enter` opens the project page, `Escape`
  clears the search.
- i18n: new keys under `projectsPdm.catalog.*` in all 15 locales.

## Tests

Backend: folders CRUD + move-up-on-delete + cycle refusal + permissions matrix entries; catalog
fields (recommended revision rule, open orders, counts, last activity); each new search field.
Frontend: `catalogRules` unit tests (filter, sort, tree, path); page tests for tree vs flat, selection
URL, new folder, move via button, drag/drop, keyboard.

## Out of scope

Visual restyle of the project page; folders in the File Manager; bulk filing; sub-project semantics.
