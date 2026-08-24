# Filament Profile Manager — bambuddy port design

Date: 2026-08-24
Status: approved-by-spec (user supplied a complete feature spec; this doc records the
mapping of that spec onto bambuddy's stack). The source spec is embedded verbatim in
Appendix A and is normative for every behavior, flow, and edge case; this first half is
normative for *where* each piece lives in bambuddy and which house conventions replace
the source app's primitives.

## 1. Scope

A new top-level page **Filament Profiles** (`/filament-profiles`) implementing the
Filament Profile Manager spec: user preset CRUD (full slicer JSON per record), base-preset
index of the Bambu Studio app bundle, disk import/scan, mirror sync back to the Bambu
Studio user folders (dry-run previewed), ZIP export, and the tabbed inheritance-aware
editor modal with delta-writing save semantics.

The existing `profiles` page/nav (cloud slicer presets) is untouched; this is a separate
feature with its own nav id `filament-profiles`.

## 2. Backend mapping

- **Route module**: `backend/app/api/routes/filament_profiles.py`,
  `APIRouter(prefix="/filament-profiles", tags=["filament-profiles"])`, registered in
  `main.py` (import block + `include_router` with `app_settings.api_prefix`).
  Static segments (`/base-presets`, `/base-content`, `/bambu-scan`, `/bambu-sync`,
  `/sync-base`) declared **before** `/{preset_id}` routes.
- **Endpoint map** (spec §3 → bambuddy):

  | Spec | bambuddy |
  |---|---|
  | GET /api/profiles | GET /api/v1/filament-profiles |
  | POST /api/profiles | POST /api/v1/filament-profiles |
  | PATCH /api/profiles/[id] | PATCH /api/v1/filament-profiles/{id} |
  | DELETE /api/profiles/[id] | DELETE /api/v1/filament-profiles/{id} |
  | POST /api/profiles/[id]/duplicate | POST /api/v1/filament-profiles/{id}/duplicate |
  | GET /api/profiles/bambu-scan | GET /api/v1/filament-profiles/bambu-scan |
  | GET /api/profiles/base-content | GET /api/v1/filament-profiles/base-content |
  | GET /api/profiles/base-presets | GET /api/v1/filament-profiles/base-presets |
  | POST /api/profiles/sync-base | POST /api/v1/filament-profiles/sync-base |
  | POST /api/profiles/bambu-sync | POST /api/v1/filament-profiles/bambu-sync |

- **Models** (`backend/app/models/filament_profile.py`):
  - `FilamentPreset` → table `filament_presets`: `id` PK, `name`, `brand`, `material`,
    `color`, `color_hex`, `filename` (all `String`, default `""`), `content` (`Text`,
    default `""`), `created_at`, `updated_at` (naive UTC `DateTime`).
  - `BaseFilamentPreset` → table `filament_base_presets`: `id` PK, `name`, `inherits`,
    `brand`, `material`, `color`, `color_hex`, `filename` (indexed). No content column.
  - Case adaptation: the spec's `Id`/`CreatedAt`/`UpdatedAt` become snake_case everywhere
    (DB, API, frontend types) — spec §10 permits adapting shapes uniformly.
  - Registration in all 4 places: `models/__init__.py` import + `__all__`,
    `database.py::init_db()` module tuple, `tests/conftest.py::test_engine` tuple.
    Nothing in `run_migrations()` (new tables only; `create_all` handles them).
- **Schemas** (`backend/app/schemas/filament_profile.py`): `FilamentPresetCreate`
  (all fields optional str, absent → ""), `FilamentPresetUpdate` (partial: only provided
  keys written — use `model_dump(exclude_unset=True)`), `FilamentPresetResponse`,
  `BaseFilamentPresetResponse`, `BambuSyncRequest` **with `presets` as a required field**
  (the §9.1 delete-everything guard: an omitted `presets` key must 400/422, never default
  to `[]`), `SyncStats`, sync/scan response models. `max_length` on string columns is not
  needed (unbounded `String`/`Text` columns, SQLite), but element validation for
  bambu-sync (non-null object, string filename/content, bare basename: non-empty, no
  `..`, no `/`, no `\`) is hand-rolled in the route to produce the spec's indexed error
  messages (entry/filename/content naming the offending index).
- **Service** (`backend/app/services/bambu_studio.py`): filesystem layer.
  - Paths: user folders `~/Library/Application Support/{BambuStudio,BambuStudioBeta}/user/<uid>/filament`;
    bundle dir `/Applications/BambuStudio.app/Contents/Resources/profiles/BBL/filament`.
  - Settings fields in `core/config.py`: `bambu_user_id: str = "1961034787"`
    (env `BAMBU_USER_ID`, digits-only validated — invalid → warn + fall back to default),
    plus `bambu_studio_user_dirs` / `bambu_studio_bundle_dir` overrides (used by tests,
    default `None` → the computed defaults above).
  - All client-supplied filenames go through `safe_join_under`
    (`backend/app/utils/safe_path.py`); the CI AST scan
    (`test_no_unsafe_path_joins.py`) covers routes and services automatically —
    use `# SEC-PATH-OK:` only for constant joins.
  - Scan: first-folder-wins dedupe by filename; missing folder silently skipped.
  - bambu-sync: mkdir -p folders; read disk state; stats added/updated/unchanged/removed
    exactly per spec §3.10 (unchanged = byte-identical in *every* folder; removed = on
    disk but not in payload); dryRun stops before writing; execute writes per-folder
    diffs then unlinks removals per folder.
  - sync-base: parse every bundle `*.json` (unparseable → record with name from filename,
    rest empty), resolve inheritance closure (name→filename lookup, visited-set cycle
    guard), diff by filename (bulk insert / bulk update when name/inherits/brand/material
    changed / count unchanged), return `{added, updated, unchanged, total}`.
- **Errors**: house convention `HTTPException(404, "Preset not found")` etc. — FastAPI
  emits `{"detail": ...}` instead of the spec's `{error}`; the frontend client adapts
  uniformly (its `request<T>` already surfaces `detail`). DELETE is idempotent and
  returns `{"success": true}`.
- **Permissions**: reuse existing `FILAMENTS_*` — `FILAMENTS_READ` on all GETs,
  `FILAMENTS_CREATE` on create/duplicate, `FILAMENTS_UPDATE` on PATCH + sync-base +
  bambu-sync, `FILAMENTS_DELETE` on DELETE. Already classified for API keys; zero
  permission churn.
- **Duplicate**: appends the literal `" (copie)"` (spec-mandated copy, kept in French).
- **Tests**: `backend/tests/integration/test_filament_profiles_api.py` modeled on
  `test_filaments_api.py`; filesystem endpoints tested against `tmp_path` dirs injected
  via the settings overrides. Cover every §3.10 validation case (missing presets key →
  4xx, malformed element index errors, traversal rejection), dry-run vs execute, the
  remove phase, sync-base diffing and cycle guard, PATCH partiality, duplicate 404.

## 3. Frontend mapping

- **Page**: `frontend/src/pages/FilamentProfilesPage.tsx` (named export), route
  `/filament-profiles` in `App.tsx` via `lazyWithReload`.
- **Nav**: `Layout.tsx defaultNavItems` gets
  `{ id: 'filament-profiles', to: '/filament-profiles', icon: <lucide>, labelKey: 'nav.filamentProfiles' }`.
  Update the hardcoded nav-id lists in `src/__tests__/pages/SettingsPage.test.tsx`
  (3 places) and check `Layout.test.tsx` hrefs.
- **Components**: `frontend/src/components/filament-profiles/` —
  `types.ts`, `constants.ts` (material lists, alias map, vendor list, family colors),
  `presetJson.ts` (pure logic: parse→form mapping, `mergeWithParent`, `buildResolvedParent`
  chain walk, `buildJson` delta writer, PA-K regex, nozzle regex, "nil" handling,
  unknown-key pass-through), `PresetCard.tsx`, `PresetEditorModal.tsx` (+ per-tab section
  files as needed), `SyncModal.tsx`, `SyncBaseResultModal.tsx`, `TagInput.tsx`,
  `filamentProfilePrefs.ts` for localStorage (keys verbatim from spec §8:
  `profiles-filter-brand`, `profiles-filter-material`, `profiles-grid-size`, validated
  reads).
- **API client**: wrappers + types appended in `src/api/client.ts` house style
  (`getFilamentPresets`, `createFilamentPreset`, `updateFilamentPreset`,
  `deleteFilamentPreset`, `duplicateFilamentPreset`, `scanBambuStudio`,
  `getBaseFilamentPresets`, `getBaseFilamentPresetContent`, `syncBaseFilamentPresets`,
  `syncFilamentPresetsToBambu`).
- **House primitives replacing source-app primitives** (spec's "semantic intent" rule):
  - Modal: hand-rolled fixed overlay + `max-w-5xl h-[88vh]` panel, `animate-modal-in`,
    `useDismissableDialog` for exit animation + deferred unmount; nested confirm via
    `ConfirmModal` with `overlayZIndex`.
  - Toasts: `useToast().showToast` (success/error); the sequential-import progress toast
    uses `showPersistentToast(id, msg-with-current/total, 'loading')` updated in place,
    `dismissToast` at the end.
  - Selects: `SearchableSelect` (project bans native `<select>`); tri-state nil/Off/On
    rows and small enums may use compact segmented buttons — same semantics.
  - Grid-size segmented control: 3 icon buttons in the house segmented style.
  - ZIP export: `jszip` (already a dependency) via dynamic `import()` so it stays out of
    the main bundle; download via object-URL anchor (`filament-presets.zip`).
  - Cards: house `Card` hover/lift idiom; skeletons per house `SkeletonGrid` style.
- **React Query**: `['filamentPresets']`, `['filamentBasePresets']`; mutations invalidate
  after re-fetching flows per spec (spec's explicit re-fetch after save/duplicate/delete
  = `invalidateQueries`). Extra material names (spec §5.1's `GET /api/filaments`) come
  from `api.getFilaments()` (`/api/v1/filament-catalog/`) distinct `type` values;
  failures toast but never block the page.
- **i18n**: new `filamentProfiles.*` namespace + `nav.filamentProfiles` in **all 13
  locale files** with real translations (cognate allowlists for loanwords). French copy
  from the spec ("Sync vers PC") stays the *French* string; other locales translate the
  semantic meaning ("Sync to PC" in en, etc.). No `{{count}}` unless plural suffixes
  everywhere — use `{{n}}`/`{{total}}`.
- **Frontend tests**: Vitest for the pure logic (`presetJson` delta writer, merge rules,
  alias map, name/filename computation, chip parsers) — these carry the domain
  invariants §9.3–9.7; component tests for page filters/persistence and editor
  happy-paths per existing MSW patterns.

## 4. Editor logic — normative pointers

Implement exactly per spec §6–7. The invariants that must survive review (spec §9):
presets-key sync guard; bare-basename checks; `"nil"` = unset; index-0 array reads;
delta rule (skip values equal to resolved parent); unknown-key pass-through;
`color` never in JSON; computed name is the identity (no free-text name);
duplicate opens editor on the copy; sequential import; user presets shadow base
presets in chain lookups; visited-set cycle guards; failed saves keep the modal open.

## 5. Out of scope / notes

- Docker/remote deployments won't see a Bambu Studio install; the four filesystem
  endpoints then behave per spec (scan skips missing folders → 0 files; base-content /
  sync-base 404/empty). No special remote transport is built.
- `static/` bundle is never committed with feature work; it gets its own rebuild commit
  at deploy time.

---

# Appendix A — Source specification (verbatim, normative)

> **Purpose of this document**: hand it to an AI agent so it can rebuild this feature from scratch in a different application. Every behavior, data shape, API contract, UI element, and edge case below must be reproduced identically. **Only the visual styling changes**: keep the exact same layout, information hierarchy, interactions, and UX flows, but express them in the target app's own design system (colors, fonts, spacing tokens, component library). Anywhere this spec mentions concrete colors or CSS classes, treat them as *semantic intent* (e.g. "accent", "danger", "muted") to be mapped onto the new design.

---

## 1. What the feature is

A **filament preset manager** for FDM 3D-printing slicer profiles (Bambu Studio / OrcaSlicer format). It is a single page ("Filament Profiles") that:

1. Stores **user presets** — one record per filament profile, each carrying the *complete slicer JSON file* as text — in the app's own database (CRUD).
2. Maintains a read-only library of **base presets**: the factory profiles shipped inside the Bambu Studio application bundle, indexed into the database so user presets can *inherit* from them.
3. **Imports** preset JSON files from the local Bambu Studio user folder on disk.
4. **Syncs** the database presets *back to* the Bambu Studio user folder (mirror write: add / update / delete on disk), with a dry-run preview before anything is written.
5. **Exports** all presets as a ZIP archive.
6. Provides a rich **editor modal** that presents ~60 slicer parameters as a structured, tabbed form — with full understanding of Bambu's *inheritance* model — plus a raw-JSON escape hatch that stays bidirectionally in sync with the form.

The critical domain insight the whole feature is built on: **a Bambu Studio user preset is a *delta file***. It names a parent via `"inherits"` and only stores the keys that differ from the resolved parent chain. The editor therefore (a) resolves and merges the full inheritance chain so the form shows *effective* values, and (b) when saving, writes back *only* the fields that differ from the resolved parent — reproducing the delta format Bambu Studio itself writes.

---

## 2. Data model

### 2.1 User preset (`FilamentPreset`)

Stored in a database table (`filament_presets` in the source app; SQLite, auto-increment integer PK). The API and UI speak this exact shape:

```ts
type FilamentPreset = {
  Id: number;          // primary key
  name: string;        // display name, e.g. "SUNLU PETG - Magenta"
  brand: string;       // filament vendor, e.g. "SUNLU"
  material: string;    // filament type, e.g. "PETG"
  color: string;       // human color label, e.g. "Magenta" (app-level metadata, NOT in the slicer JSON)
  color_hex: string;   // "#RRGGBB" swatch color
  filename: string;    // target filename on disk, e.g. "SUNLU PETG - Magenta.json"
  content: string;     // the FULL slicer JSON file, verbatim, as plain text
  CreatedAt?: string;  // ISO timestamp, set on create
  UpdatedAt?: string;  // ISO timestamp, set on create + every update
};
```

All string columns default to `""` (never null). `content` is the source of truth for slicer parameters; `brand`/`material`/`color`/`color_hex` are denormalized metadata used for filtering, display and file naming. `color` exists **only** at the app level — it is never written into the slicer JSON.

### 2.2 Base preset (`BaseFilamentPreset`)

Indexed from the Bambu Studio app bundle (`filament_base_presets` table; index on `filename`):

```ts
type BaseFilamentPreset = {
  Id: number;
  name: string;      // profile name from the JSON, e.g. "Bambu PLA Basic @BBL X1C"
  inherits: string;  // parent profile name ("" if none)
  brand: string;     // first element of filament_vendor array
  material: string;  // first element of filament_type array
  color: string;     // always "" for base presets
  color_hex: string; // first element of filament_colour array
  filename: string;  // basename inside the bundle dir
};
```

**No `content` column** — base preset JSON is read on demand from the app bundle on disk (endpoint §3.7). The DB row is only an index (name → filename) used to populate dropdowns and resolve inheritance chains.

### 2.3 Sync stats

```ts
type SyncStats = { added: number; updated: number; removed: number; unchanged: number };
```

---

## 3. Backend API

All endpoints return JSON; errors return `{ error: string }` with an appropriate HTTP status (404 for missing records, 400 for bad input, 500 otherwise).

### 3.1 `GET /api/profiles`
Returns **all** user presets as a JSON array, sorted by `name` ascending.

### 3.2 `POST /api/profiles`
Body: a `FilamentPreset` without `Id`/`CreatedAt`/`UpdatedAt`. Creates the record (only known keys are read; each coerced to string, absent → `""`; timestamps set to now). Returns the created record with its new `Id`.

### 3.3 `PATCH /api/profiles/[id]`
**Partial** update: only the keys present in the body are written; an absent key leaves the column untouched. `UpdatedAt` is always refreshed. 404 if the id doesn't exist. Returns the updated record.

### 3.4 `DELETE /api/profiles/[id]`
Deletes the record. Returns `{ success: true }` (idempotent — no error if already gone).

### 3.5 `POST /api/profiles/[id]/duplicate`
Loads the preset, strips `Id`/`CreatedAt`/`UpdatedAt`, appends **`" (copie)"`** to the name, creates a new record, returns it. 404 if the source doesn't exist.

### 3.6 `GET /api/profiles/bambu-scan`
Reads the local Bambu Studio **user filament folders** (§4) and returns every `*.json` file found: `{ files: [{ filename, content }] }`. When the same filename exists in more than one folder, the first folder wins (deduped by filename). A missing/unreadable folder is silently skipped, not an error.

### 3.7 `GET /api/profiles/base-content?filename=X`
Reads one file from the **app bundle** filament directory (§4) and returns `{ content }`. Rejects with 400 any filename that is empty, contains `..`, or contains `/` (path-traversal guard). 404 if the file doesn't exist.

### 3.8 `GET /api/profiles/base-presets`
Returns all indexed base presets (array of `BaseFilamentPreset`), sorted by name.

### 3.9 `POST /api/profiles/sync-base`
Re-indexes the app bundle into the `filament_base_presets` table:

1. List every `*.json` in the bundle filament dir; parse each one, extracting `name` (fallback: filename without `.json`), `inherits`, `brand` = `filament_vendor[0]`, `material` = `filament_type[0]`, `color_hex` = `filament_colour[0]`, `color` = `""`. An unparseable file still produces a record (name from filename, everything else empty).
2. Resolve the **full inheritance closure**: starting from every file, follow `inherits` (name → filename lookup) recursively with a visited-set cycle guard, adding every ancestor file to the sync set. (In practice all parents live in the same directory.)
3. Diff against existing DB rows **keyed by filename**: create missing rows in bulk; update rows where any of `name` / `inherits` / `brand` / `material` changed (bulk, in one transaction); count untouched rows as unchanged.
4. Return `{ added, updated, unchanged, total }` (`total` = size of the sync set).

### 3.10 `POST /api/profiles/bambu-sync` — **the destructive one**
Mirrors the given preset list onto the local Bambu Studio user folders. Body: `{ presets: [{ filename, content }], dryRun?: boolean }`.

**Validation (all → 400):**
- Body must be a JSON object.
- `presets` key must be **present** (an omitted key must not default to `[]` — the remove phase below would then delete *every* file on disk) and must be an array.
- Every element must be a non-null object with string `filename` and string `content`, and the filename must be a **bare basename**: non-empty, no `..`, no `/`, no `\`. The error names the offending index and field (`entry` / `filename` / `content`). The null/non-object check must run *before* touching `.filename` so a malformed element yields 400, not a crash.

**Algorithm:**
1. Ensure the user filament folders exist (`mkdir -p` each).
2. Read every `*.json` currently on disk into a map: `filename → (folder → content)`.
3. Compute stats over the incoming presets (skipping any with empty filename or empty content):
   - **added** — filename exists in no folder;
   - **unchanged** — present in *every* folder with byte-identical content in each;
   - **updated** — anything else (present but different, or missing from some folder).
4. **removed** = every on-disk filename not in the incoming set.
5. If `dryRun` — stop; return `{ stats }`.
6. Otherwise, for each folder: write each preset whose on-disk content in *that* folder differs (or is absent); then unlink each to-remove filename that exists in that folder. Return `{ stats }`.

---

## 4. Filesystem integration (Bambu Studio paths)

Two distinct locations, both macOS in the source app (adapt to the target platform):

- **User filament folders** (read by scan, written by sync): `~/Library/Application Support/<App>/user/<USER_ID>/filament` for each app name in `["BambuStudio", "BambuStudioBeta"]`. `<USER_ID>` is the numeric Bambu account id: read from the `BAMBU_USER_ID` env var, validated as digits-only (invalid → warn and fall back), with a hardcoded default.
- **App bundle filament dir** (read-only; source of base presets): `/Applications/BambuStudio.app/Contents/Resources/profiles/BBL/filament`.

The sync treats *all* user folders as mirror targets: every preset is written to every folder, and removals happen in every folder.

---

## 5. Main page — layout & behavior

One page, titled **"Filament Profiles"**, composed of: a page header with action buttons, a filter bar, and a responsive card grid.

### 5.1 Initial load
Three parallel fetches on mount:
- `GET /api/profiles` → presets (drives a `loading` flag; failure shows an error state with the message and a **Retry** link that re-fetches).
- `GET /api/profiles/base-presets` → base presets for the editor (failure → error toast, page still works).
- `GET /api/filaments` → the app's canonical material name list, used to *extend* the editor's material dropdown (failure → error toast). *Porting note: this comes from an unrelated subsystem; in a new app either wire an equivalent source of extra material names or drop it — the editor has its own built-in material list (§7.3) and works without it.*

### 5.2 Header actions (right-aligned row of buttons)
In order:
1. **Sync base** (secondary button, database icon) — POST `sync-base`. While running, the button is replaced by a small spinner + "Syncing base…" text. On completion opens a small result modal: success shows a green check header "Base profiles synced", subtitle "*N* files scanned", and stat rows **New** (green) / **Updated** (accent) / **Unchanged** (muted); error shows "Sync failed" + the message. Close button dismisses.
2. **Import** (secondary, upload icon) — the disk-import flow (§5.7). Disabled while an import is in progress.
3. **Sync vers PC** (secondary, circular-arrows icon) — the sync-to-disk flow (§5.8).
4. **Export ZIP** (secondary, download icon) — client-side ZIP (§5.9). Disabled when no preset has both a filename and content.
5. **New preset** (primary/accent, plus icon) — opens the editor modal in create mode.

### 5.3 Filter bar
- **Search input** (left, with magnifier icon, fixed ~52-char width): case-insensitive substring match over `name`, `brand`, `material`, `color`.
- Right-aligned cluster:
  - **Grid-size segmented control**: three icon buttons — small / medium / large — drawn as abstract grid glyphs (4 squares / 3 columns / 2 columns). Selected = accent tint. Persisted (§8).
  - **Sort select**: "Sort: Name | Brand | Material | Color". Sorts by the chosen field with locale-aware, case/accent-insensitive comparison (French locale, `sensitivity: "base"`), ties broken by `name`.
  - **Count**: when filtered, "`<filtered>` / `<total>`"; otherwise "`<total>` preset(s)" (pluralized). Tabular numerals.
- **Brand pills row** (only if ≥1 distinct brand): "All brands" pill + one pill per distinct non-empty brand, sorted. Clicking a pill selects it; clicking the active pill deselects (back to all). Active pill = accent-tinted; inactive = ghost/outline.
- **Material pills row** (only if ≥1 distinct material): same interaction, monospace font on the pills. **The material list is scoped to the selected brand** — it's derived from the presets of the current brand filter. If the active material filter disappears from that list (e.g. after switching brands), it auto-clears (but never while loading and never when the preset list is empty, so a persisted filter isn't wiped before data arrives).
- Filter order applied: material → brand → search, then sort.

### 5.4 Grid
Responsive CSS grid; column counts by grid size (breakpoints are the source app's — reinterpret in the target design):
- small: 2 / 3 / 4 / 5 columns (base / sm / lg / xl), tight gap
- medium: 1 / 2 / 3 / 4, medium gap
- large: 1 / 2 / 2 / 3, large gap

**Loading**: 6 skeleton cards (fixed card height, shimmer).
**Empty**: if there are zero presets — empty state "No presets yet" / "Create a preset manually or import from a folder."; if filters exclude everything — "No results".

### 5.5 Preset card
A horizontal card. Whole card is clickable → opens editor. Hover: border tint to accent, slight lift + stronger shadow.

Left to right:
1. **Color swatch**: a full-height vertical strip (~64px wide, rounded on the outer edge) filled with `color_hex` (fallback `#444`); tooltip shows the hex.
2. **Body** (fills):
   - Brand in small bold uppercase, wide letter-spacing, muted (only if non-empty).
   - **Display material** in bold, colored by material family. It is derived **from the name**, not from `material`: strip the brand as a prefix (regex-escaped), take the segment before the first `" - "`, trim; fall back to `material`. (So "SUNLU PA12-CF - Black" → "PA12-CF" even if `material` says "PA-CF".) Fallback display "—".
   - Material family color map (semantic: pick analogous hues in the target palette): PLA family → green; PETG/PCTG/PET-CF/PETG-CF → light blue; ABS/ASA families → orange; TPU family → teal; PA/nylon families (PA, PA6, PA12, *-CF, *-GF, PAHT-CF, PPA-*) → violet; PC family → rose; PP/PPS families → amber; unknown → the default light blue.
   - Color label in small muted text (if non-empty).
   - **Chips row** (bottom of body, only if any chip resolves) — parsed live from `content` JSON (all failures → no chips):
     - `nozzle_temperature` (first element if array) → "`230°C`" chip (rose tint, monospace);
     - `filament_flow_ratio` → "`×0.98`" chip (sky tint);
     - Pressure-advance K: regex `M900 K([\d.]+)` over the **raw content string** → "`PA 0.040`" chip (amber tint).
3. **Top-right column**:
   - Nozzle-size pill: from the first entry of `compatible_printers`, regex `([\d.]+)\s*nozzle` (case-insensitive) → "`⌀0.4mm`" (accent tint, monospace).
   - **Three-dot menu button**: hidden until card hover (opacity 0 → 100). Click (stopPropagation so the card doesn't open) toggles a dropdown anchored top-right: **Edit** (pencil icon), **Duplicate** (copy icon), separator, **Delete** (trash icon, danger color). Click-outside closes it; the dropdown has a short pop in/out animation; while open the card gets a raised z-index so the menu overlays neighbors.

### 5.6 CRUD flows from the page
- **Edit / card click** → editor modal with the preset.
- **Save** (from modal): create mode → POST, edit mode → PATCH with the full payload; success toast `"<name>" created` / `"<name>" updated`; then re-fetch the whole list. A failed save throws back into the modal, which toasts the error and stays open.
- **Duplicate** → POST duplicate, then re-fetch the list and **immediately open the editor on the new copy** (found by the returned `Id`). Failure → error toast.
- **Delete** → always via a **confirm modal** first ("Delete preset?" / "*name* will be permanently deleted." / Cancel + danger Delete). Confirm → DELETE, close confirm, re-fetch. Failure → error toast. The editor's own Delete button closes the editor and opens this same confirm.

### 5.7 Import-from-disk flow
1. Set a busy flag (disables the Import button). GET `bambu-scan`. Failure → toast "Error reading BambuStudio folder: …" and stop.
2. Filter out files whose `filename` already exists among current presets (dedupe key = filename).
3. If nothing new: success toast "*N* file(s) found — all already imported." and stop.
4. Otherwise show a **progress toast** ("Importing presets…", current/total). For each new file **sequentially**: parse the JSON to build the payload — `name` = JSON `name` (fallback filename minus `.json`), `brand` = `filament_vendor[0]`, `material` = `filament_type[0]`, `color_hex` = `filament_colour[0]`, `color` = `""`, `filename`, `content` = raw text (unparseable file → all-metadata-empty payload with raw content) — then POST it. Count successes/failures; tick the toast after each.
5. Final toast: all ok → success "Imported N preset(s)"; else error "X succeeded, Y failed". Re-fetch the list.

### 5.8 Sync-to-PC flow (two-phase, previewed)
The payload is always: every preset with non-empty `filename` **and** `content`, mapped to `{ filename, content }`.

1. **Preview**: open the sync modal in a "syncing" state (spinner, not dismissible), call bambu-sync with `dryRun: true`, then show the **preview** state: title "Sync to PC", subtitle "Changes will be applied to the BambuStudio filament folder.", stat rows **New** (green) / **Updated** (accent) / **Removed** (danger) / **Unchanged** (muted). If added+updated+removed = 0, show "Everything is already up to date." and disable the confirm button. Buttons: Cancel / **Sync**.
2. **Execute**: back to the spinner state, call again with `dryRun: false`, then show the **done** state: green check, "Sync complete", stat rows Added / Updated / Removed, Close button.
3. Any failure at either phase: close the modal and toast "Sync preview failed: …" / "Sync failed: …".

The preview is not optional UI sugar — the execute phase **deletes** on-disk files absent from the app, so the user must see "Removed: N" before confirming.

### 5.9 Export ZIP
Client-side: take every preset with filename + content; if none, error toast "No presets with JSON content to export." Otherwise build a ZIP (one entry per preset, entry name = `filename`, DEFLATE), and trigger a browser download named **`filament-presets.zip`** via a temporary object URL.

---

## 6. Editor modal — structure

A large modal (~88vh tall, fixed height, internal scroll) with header / segmented tab bar / scrollable content / footer. It receives: the preset (or `null` for create mode), the full user-preset list, the base-preset list, and the extra material names. Closing animates out before unmounting (the modal manages an internal open flag; the parent unmounts on the exit-complete callback).

### 6.1 Internal state model
- **`baseData`**: the parsed JSON object of the preset's `content` (`{}` if new/unparseable). Holds **every key**, including ones the form doesn't know — those unknown keys are passed through untouched on save.
- **`form`**: a flat struct of ~60 editable fields (full list in §7), all strings except `enable_pressure_advance` (boolean) and `filament_extruder_variant` (string[]). Initialized from `baseData` via a mapping that: takes the **first element** of array values, treats the literal string `"nil"` as empty, joins `compatible_printers` into a comma-separated string, and derives two **synthetic fields**:
  - `pa_k_value`: extracted from `filament_start_gcode` with regex `M900 K([\d.]+)`;
  - `nozzle_size`: default `"0.4"`; on open, also recovered from the preset *name* via regex `@BBL H2S ([\d.]+)mm` when present.
  - `color` is populated from the **preset record's** `color` field (it does not live in the JSON).
- **`resolvedParent`**: the fully-merged inheritance chain (§6.2), or null.
- **`rawJson`** + `jsonError`: the Raw JSON tab's text and validity.
- New-preset mode extras: `selectedBase` (the base-preset picker) and its loading flag.
- `saving` flag; active tab.

On mount: focus the Brand select. If editing a preset whose JSON has `inherits`, immediately resolve the chain (spinner state on the header's inherits line) and merge it into the form.

### 6.2 Inheritance resolution (`buildResolvedParent`)
Given a parent name, walk the chain:
1. Loop while there's a current name not yet visited (visited-set = cycle guard). Find its content: first among **user presets** (by `name`, content is in memory), else among **base presets** (by `name` → fetch its file via `base-content?filename=`). Not found / fetch failed → stop the walk.
2. Parse it, convert to form shape, push onto the **front** of a chain list, continue with *its* `inherits`.
3. If the chain is empty → null. Otherwise fold it root-first: `merged = chain[0]`, then for each descendant `merged = mergeWithParent(child, merged)`.

**`mergeWithParent(child, parent)`**: returns child where every field that is *empty* (equal to its empty-form default; for arrays, length 0) is filled from the parent. Three fields are **never** inherited: `color`, `nozzle_size`, `pa_k_value` (they're app-synthetic).

So the form always shows **effective** values — the user sees the real temperatures even though the stored file only contains deltas.

### 6.3 Header
- A colored dot (the `default_filament_colour` value; neutral surface if empty).
- **Computed name** as the title (or "New preset" / "Edit preset" placeholder): `"{vendor} {type}"` (skipping empty parts) plus `" - {color}"` if a color label is set. This computed name **is** the saved `name` — there is no free-text name field.
- A small pill showing the material type when set.
- If `inherits` is set, a second line: "↳ *parent name*" — pulsing while resolving; accent-tinted when resolved; muted with an amber "(not found)" suffix when resolution failed — plus a small **Reload** button that re-runs resolution and re-merges into the form.
- Close (×) button.

### 6.4 Tab bar
A segmented control with 6 tabs (short labels): **General · Temps · Cooling · Extrusion · Retract · JSON**. Switching **to** the JSON tab regenerates `rawJson` from the current form (§6.6) and clears any JSON error.

### 6.5 Footer
- Left: the target **filename** in small monospace (computed name + `.json`; falls back to the preset's existing filename when the name is empty), and — when the name is empty — an amber hint "Brand and material required".
- Right: **Delete** (danger, edit mode only — closes modal and triggers the page's confirm), **Cancel**, **Save/Create** (primary; disabled while saving, when the computed name is empty, or when the JSON tab holds invalid JSON; label "Saving…" while pending).

### 6.6 Save semantics
`content` = the Raw JSON textarea verbatim if the JSON tab is currently active, else the generated JSON (§7.9). Payload: `name` = computed name; `brand` = trimmed vendor; `material` = trimmed type, falling back to `filament_type[0]` parsed from the content; `color` = trimmed color label; `color_hex` = the `default_filament_colour` value; `filename`; `content`. On success close; on failure toast and stay open.

---

## 7. Editor modal — tabs, fields, and rules

Shared primitives: labeled fields (tiny uppercase label + optional unit suffix); text inputs; numeric inputs (monospace, tabular); tri-state toggle rows rendered as a select with options **nil / Off / On** (values `"" / "0" / "1"`) — "nil" meaning *inherit / unset*; section dividers (tiny uppercase caption + hairline).

### 7.1 General tab
- **Base preset picker** (create mode only): a bordered panel with a select — "— None (start blank) —", then optgroup **My presets** (all user presets) and optgroup **Base presets** (all base presets), both by name. Choosing one sets `inherits` to that name, resolves the chain (panel shows "Loading…", select disabled), and merges the resolved values into the form (only filling fields still empty). Choosing "None" clears `inherits` and the resolved parent. If resolution fails, `inherits` is still set.
- **Brand** select (autofocused): fixed vendor list — Bambu Lab, eSUN, Inslogic, Polymaker, Prusa, SUNLU (plus "— Select —").
- **Material** select: the sorted union of (a) the built-in list (§7.3) and (b) the app-provided extra material names.
- **Color label** text ("White, Black…") — feeds the computed name only.
- **Nozzle size** select: 0.2 / 0.4 / 0.6 / 0.8 mm. Changing it **rewrites the compatible-printers list**: every tag matching `^(Bambu Lab (H2S|H2D|H2C|X2D)) [\d.]+ nozzle$` gets its size replaced.
- **PA K value** number (step .001, unit hint "M900"): setting it **generates the start G-code**: non-empty → `filament_start_gcode` = `"M900 L1000 M10\nM900 K{value}"`; cleared → `""`.
- **Cost** (€/kg) and **Density** (g/cm³) numbers.
- **Filament colour**: native color-picker swatch + a monospace `#RRGGBB` text input, both bound to `default_filament_colour`.
- **Extruder** divider → multi-select chip toggles: "Direct Drive Standard", "Direct Drive High Flow", "Bowden" (array field `filament_extruder_variant`).
- **Compatible printers** divider → a **tag input**: tags parsed from the comma-separated string; type + Enter adds (dedup, trimmed), Backspace on empty input removes the last, blur commits the draft, each tag has an × button; placeholder "Bambu Lab X1C 0.4 nozzle…" when empty. Above it: hint "Enter to add · Backspace to remove" and a quick-add link "**+ H2S / H2D / H2C / X2D**" that appends `Bambu Lab {model} {nozzle_size} nozzle` for each of the four models not already present.
- **Notes** textarea (2 rows) → `filament_notes`.
- New presets start with `compatible_printers` pre-filled: "Bambu Lab H2S 0.4 nozzle, Bambu Lab H2D 0.4 nozzle, Bambu Lab H2C 0.4 nozzle, Bambu Lab X2D 0.4 nozzle".

### 7.2 Temps tab
- **Nozzle**: Initial °C, Print °C, Range min °C, Range max °C (`nozzle_temperature_initial_layer`, `nozzle_temperature`, `nozzle_temperature_range_low/high`).
- **Material**: Glass Tg °C (`temperature_vitrification`).
- **Chamber**: Chamber °C (`chamber_temperatures`).
- **Bed plates**: a 3-column table (Plate / Print °C / Initial layer °C) with five rows: SuperTack, Cool Plate, Engineering, Hot Plate, Textured → `supertack_plate_temp`, `cool_plate_temp`, `eng_plate_temp`, `hot_plate_temp`, `textured_plate_temp`, each with its `_initial_layer` twin.

### 7.3 Material lists (built-in)
Canonical output types: PLA, ABS, ASA, ASA-CF, PETG, PCTG, TPU, TPU-AMS, PC, PA, PA-CF, PA-GF, PA6-CF, PLA-CF, PET-CF, PETG-CF, PVA, HIPS, PLA-AERO, PPS, PPS-CF, PPA-CF, PPA-GF, ABS-GF, ASA-AERO, PE, PP, EVA, PHA, BVOH, PE-CF, PP-CF, PP-GF.

Slicer-alias → canonical map (applied **only when writing** `filament_type` into the JSON — the form keeps the alias the user picked): PA12-CF→PA-CF, PA6-GF→PA-GF, PAHT-CF→PA-CF, PA12→PA, PA6→PA, PC-ABS→PC, PC-HT→PC, PLA+→PLA, "PLA Basic"→PLA, PLA-ST→PLA, PLA-LW→PLA-AERO, LW-PLA→PLA-AERO, PPS-GF→PP-GF, "TPU 95A"/"TPU 90A"/"TPU 87A"/"TPU 64D"→TPU.

The material dropdown shows the union of canonical types + all alias keys, sorted.

### 7.4 Cooling tab
- **Part cooling fan** (3-col grid): Max speed %, Min speed %, Overhang speed %, No fan (part) layers (`close_fan_the_first_x_layers`), No fan (additional) layers, Initial layer fan % (`first_x_layer_fan_speed`), Min layer time s (`fan_cooling_layer_time`), Overhang threshold (free text, e.g. "10%"), Pre-start fan s, Additional fan %.
- Toggle row: **Overhang / bridge fan** (`enable_overhang_bridge_fan`, nil/Off/On).
- **Chamber ventilation**: During print % / End of print % (`during_print_exhaust_fan_speed`, `complete_print_exhaust_fan_speed`).

### 7.5 Extrusion tab
- **Flow**: Flow ratio (number, step .001, bounds 0.5–1.5) with an adjacent tiny "**cal**" button opening a click-outside-dismissable popover: "Adjust flow ratio by %", a number input (autofocus; Enter applies, Escape closes), Apply button → `new = (current || 1) × (1 + pct/100)` rounded to 3 decimals. Also: Max vol. flow mm³/s, Prime volume mm³, Shrinkage (free text, e.g. "99.25%").
- **Layer slow-down**: Min time per layer s (`slow_down_layer_time`), Min speed mm/s (`slow_down_min_speed`).
- **G-code**: Start G-code textarea (3 rows, monospace, no spellcheck) and End G-code textarea (2 rows) — note Start G-code is coupled to the PA K field (§7.1).

### 7.6 Retract tab
- Grid: Length mm (step .1), Speed mm/s, Deretract speed mm/s, Z-hop mm (step .1), Z-hop type select (nil / Normal Lift / Slope Lift / Spiral Lift), Wipe distance mm (step .1), Retract before wipe (free text, e.g. "85%").
- **Options** toggle rows: Retract when changing layer; Wipe on retraction (both nil/Off/On).

### 7.7 JSON tab
Caption "Direct edit — other tabs update automatically" + a red "Invalid JSON" badge when broken. A 24-row monospace textarea. **Bidirectional**: entering the tab regenerates the text from the form; every keystroke re-parses — on success, `baseData` is replaced by the parsed object and the *entire form* is rebuilt from it (preserving only the `color` label); on failure, the error flag is set (blocks Save) and the form is left as-is.

### 7.8 Full form field list
`color`ᐩ, `inherits`, `filament_vendor`, `filament_type`, `default_filament_colour`, `filament_notes`, `nozzle_temperature`, `nozzle_temperature_initial_layer`, `nozzle_temperature_range_low`, `nozzle_temperature_range_high`, `cool_plate_temp`(+initial), `eng_plate_temp`(+initial), `hot_plate_temp`(+initial), `textured_plate_temp`(+initial), `supertack_plate_temp`(+initial), `fan_max_speed`, `fan_min_speed`, `close_fan_the_first_x_layers`, `close_additional_fan_first_x_layers`, `fan_cooling_layer_time`, `overhang_fan_speed`, `during_print_exhaust_fan_speed`, `complete_print_exhaust_fan_speed`, `enable_pressure_advance` (bool), `pressure_advance`, `filament_flow_ratio`, `filament_max_volumetric_speed`, `filament_prime_volume`, `filament_retraction_length`, `filament_retraction_speed`, `filament_retract_when_changing_layer`, `filament_wipe`, `filament_z_hop`, `filament_z_hop_types`, `filament_deretraction_speed`, `filament_wipe_distance`, `filament_retract_before_wipe`, `slow_down_layer_time`, `slow_down_min_speed`, `filament_cost`, `filament_density`, `filament_shrink`, `temperature_vitrification`, `chamber_temperatures`, `additional_cooling_fan_speed`, `enable_overhang_bridge_fan`, `first_x_layer_fan_speed`, `pre_start_fan_time`, `overhang_fan_threshold`, `filament_extruder_variant` (string[]), `compatible_printers`, `filament_start_gcode`, `filament_end_gcode`, `pa_k_value`ᐩ, `nozzle_size`ᐩ. (ᐩ = app-synthetic, never written to JSON directly.)

### 7.9 JSON generation (`buildJson`) — the delta writer
Producing `content` from the form:

1. Start with every key of `baseData` **not** in the known form-key set (pass-through of unknown keys, so hand-added or future slicer keys survive a form edit round-trip). The known set also includes `name`, `filament_settings_id`, `from`, `version`.
2. Force: `name` = computed name; `filament_settings_id` = `[name]`; `from` = `"User"`; `inherits` = form value; `version` = `baseData.version` if present else `"2.4.0.8"`.
3. For every form field: **skip it if empty**, and **skip it if it equals the resolved parent's value** (that's what makes the file a delta). Only differing, non-empty values are written. Most values are written as **single-element string arrays** (`["230"]`) — the Bambu convention; `filament_notes` is a plain string; `filament_type` goes through the alias→canonical map; `enable_pressure_advance` is written as `["1"]`/`["0"]` (compared against the parent's boolean); `filament_extruder_variant` is the raw array (element-wise compared); `compatible_printers` is split on commas into a real string array (order-sensitive compare against the parent's).
4. Serialize with 4-space indentation.

With no resolved parent (blank preset or unresolvable inherits), every non-empty field is written.

---

## 8. Client persistence (localStorage)

| Key | Content |
|---|---|
| `profiles-filter-brand` | active brand filter ("" = all) |
| `profiles-filter-material` | active material filter |
| `profiles-grid-size` | `small` / `medium` / `large` (validated on read; default `medium`) |

Read once on mount, written on every change. Search text and sort order are **not** persisted.

---

## 9. Invariants & edge cases worth preserving

1. **The sync remove-phase guard**: `presets` must be an explicitly-present array. This is the difference between "sync my presets" and "delete everything in the Bambu folder".
2. **Filename safety** everywhere a client-supplied filename touches the filesystem (bambu-sync write/unlink, base-content read): bare basenames only.
3. **`"nil"` is Bambu's null**: reading, both the string `"nil"` and `["nil", …]` mean *unset*; the tri-state toggles must be able to write nothing at all (inherit), not just Off/On.
4. **Only-first-element reads**: Bambu arrays are per-extruder; this feature reads and writes index 0 only.
5. **The delta rule**: an effective value equal to the resolved parent's must *not* be written; otherwise saving an untouched inherited preset bloats it into a full copy and future parent updates stop flowing through.
6. **Unknown-key pass-through** (§7.9 step 1): the editor must never destroy JSON keys it doesn't model.
7. **`color` never enters the JSON**; `color_hex` in the record is the JSON's `default_filament_colour`.
8. **Computed name is the identity**: name, filename, and `filament_settings_id` all derive from vendor + type + color label; there is deliberately no free-text name.
9. **Duplicate opens the editor** on the fresh copy — the "(copie)" name is meant to be immediately renamed by adjusting vendor/type/color.
10. **Metadata denormalization**: brand/material/color_hex are re-derived from the form at each save; imports derive them from the file. They can drift from `content` if the JSON tab is edited directly — the save fallback (`material` from parsed content) partially covers this; the card's display-material-from-name rule covers the rest.
11. **Sequential import** (one POST at a time) keeps the progress toast truthful and the server unstressed; keep it sequential.
12. **Inheritance lookups check user presets before base presets** — a user preset may serve as another preset's parent, and shadows a same-named base preset.
13. Cycle-guarded chain walking (visited set) — malformed files must not hang the editor.
14. Error paths never lose data: failed save keeps the modal open; failed scan/sync/duplicate/delete toast and leave state untouched.

---

## 10. Porting checklist for the target app

- Replace the two DB tables + 8 endpoints (§2–3) with the target stack's equivalents; keep the request/response shapes or adapt the client uniformly.
- The filesystem endpoints (§3.6, 3.7, 3.9, 3.10) require server access to the machine running Bambu Studio. If the target app is remote-hosted, these four need a different transport (e.g. a local agent, or the browser File System Access API) — the *flows and stats UI* stay identical.
- Bundled dependency: a client-side ZIP library for the export.
- Toast system with three types: success, error, and progress (current/total, updatable in place).
- Modal system supporting: sizes, non-dismissible state (while syncing), and exit animations with an unmount callback.
- Re-skin every visual element with the target design system; keep layout, hierarchy, copy (including the French bits: "Sync vers PC", "(copie)"), interactions, keyboard behavior (Enter/Backspace/Escape in tag input and calibration popover), autofocus targets, hover reveals, and disabled-state logic exactly as specified.
