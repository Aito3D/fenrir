# Aito: import a .3mf into the new project modal

Date: 2026-11-14. Mockup: `docs/superpowers/specs/2026-11-14-aito-3mf-import-demo/index.html`
(static, made-up data; four steps switchable in its top bar).

## Intent

When the shop quotes a print job, the operator already has the Bambu Studio project `.3mf`.
Today they retype each plate into the new project modal: name, printer, filament, weight,
time, and a description of the parts. This feature lets them drop the `.3mf` in and get one
ready-priced print task per plate.

## What the user decided

- A button "Import a .3mf" in the new project modal (Aito page). Drag-and-drop onto the
  Work section does the same.
- The file is a **Bambu Studio project `.3mf`** ("only .3mf from a slicer"). **Already
  sliced files are refused**, whatever their name.
- **Colour is left empty** on imported tasks; the operator types it in the task if wanted.
- **Each plate becomes one task.** A task from a file has **only the Impression 3D service**.
- **All print values are filled**: printer, filament, weight, time, price (colour excepted, see above).
- **Task name** = the plate's name by default.
- **Note** on the task lists the plate's objects, one per line, as
  `2 x marteau [120x30x50mm]` (quantity, name, dimensions). The note is the print service's
  existing description (`impression_description`), so it **appears on the customer's quote**
  as the "Info" line. No new field.
- **A plate with several filaments** takes the **main filament** (most grams) and the
  **plate's total weight**.
- The mockup's flow was approved: import → server slicing with progress → review of the
  plates → tasks created.

## Goals

1. From a project `.3mf`, create one editable print-task draft per plate, priced by the
   existing calculator rule, with no retyping in the common case.
2. Make every guess visible and correctable before the tasks land (review step) and after
   (they are ordinary task drafts).

## Non-goals

- Importing into an existing card. Only the new project modal.
- Keeping the file: it is not stored, not attached to the card, not linked to a Projects
  (PDM) project. (My call; the user did not ask for it.)
- Pricing per object, or any service other than Impression 3D.
- Remembering a filament/printer choice for next time.

## Anti-goals

- A wrong price entering a quote silently. A plate whose printer or filament could not be
  matched must show no price and a warning, never a guessed one.
- Losing the drafts already typed in the modal. Imported tasks are appended.

## Flow

1. **Pick** a `.3mf` (button or drop). Other extensions are refused client-side.
2. **Slice** on the server, always, with the server slicer using the file's own embedded
   settings, all plates, the way Projects do (`SlicerApiService.slice_without_profiles(plate=0,
   export_3mf=True)`, after `check_source_within_caps` and
   `sanitize_project_settings_sentinels`; see `services/project_slice.py::_slice_source`).
   - A file that already contains G-code is refused before slicing. Decide by content, never
     by name (`classify_3mf`, `Metadata/plate_*.gcode`), as Projects do.
   - While slicing, the Work section shows the file name, a progress bar and elapsed time.
     The rest of the modal (client, due date) stays usable. The import can be cancelled.
3. **Review**: one row per plate — checkbox (all ticked), thumbnail, name, the object lines,
   printer, filament, time, weight, price. Rows needing a choice show an amber picker in
   place of the match and "—" as price. "Add N tasks" appends the ticked plates and is
   **disabled until every ticked row has a printer and a filament** (my call): the task
   editor only opens a service whose cost is set (`TaskStepFields.tsx`), so an unpriced
   imported task would land with Impression 3D closed and its values hidden. The mockup's
   step-4 row with a warning and no price therefore never happens.
4. **Tasks**: ordinary drafts in the existing task editor. Nothing distinguishes them
   afterwards except that their fields are filled. (The mockup's green edge and ".3mf ·
   plate N" chip are optional polish; builder's call, default: leave them out.)

## What a plate turns into

| Task field | Value |
|---|---|
| `title` | plate name (`plater_name` in `Metadata/model_settings.config`); if empty, "Plate N" (translated); if the file has a single unnamed plate, the file name without extension. Truncated to 200. |
| `impression_time_min` | slicer `prediction` seconds, rounded up to the minute |
| `impression_weight_g` | plate total `weight` (all filaments, supports included) |
| `impression_quantity` | 1 |
| `impression_printer_id` | calculator printer matched from the slicer's printer model (below) |
| `impression_filament_id` | calculator filament matched from the main filament's material (below) |
| `impression_color` | empty |
| `impression_cost` | `computeImpressionCost` (`utils/taskDraft.ts`), as if typed by hand; null until printer and filament are both set |
| `impression_description` | the object lines |
| every other service | off (NULL cost) |

**Object lines.** Objects on the plate are grouped when name and rounded dimensions are
equal; quantity is the group size. Format: `{qty} x {name} [{X}x{Y}x{Z}mm]`, millimetres
rounded to the nearest integer, axis-aligned as placed on the plate (so a rotated part shows
its footprint as printed). The name drops a trailing `.stl`/`.step`/`.stp`/`.3mf`/`.obj`.
Lines are sorted by the order objects first appear. (Grouping and rounding rules are my call.)

**Dimensions source.** X×Y×Z comes from the project file's meshes (`3D/3dmodel.model` and the
object files it references, with their build transforms). This is new code; nothing in the
app measures meshes today. Read vertices in a streaming way: combined plates can hold
hundreds of MB of vertex rows (see the #3162 note in `services/archive.py`).

**Main filament.** Among the plate's `<filament>` rows in `slice_info.config`, the one with
the highest `used_g`. The review row mentions "+N other filament(s)" so the operator knows
the weight includes them.

**Matching to the calculator.**
- Printer: normalise the slicer's model (`normalize_printer_model`, e.g. `BL-P001` → `X1C`)
  and match a calculator printer whose name contains it, case-insensitive. Exactly one →
  set. Otherwise the review row asks.
- Filament: calculator filaments have brand + material and no colour. Match on material
  equal to the slicer's `type` (e.g. `PETG`), case-insensitive. Exactly one → set. Several →
  keep those whose brand equals the file's filament vendor (`filament_vendor` in
  `project_settings.config`, case-insensitive; "Generic" never matches); exactly one left →
  set, otherwise a picker limited to the material matches. None → picker with all
  filaments. The plate facts therefore carry the vendor per filament. (Brand tie-break is
  my call.)
- Matching runs in the frontend, which already holds the calculator lists and the pricing
  function. The backend returns raw facts only.

## Backend shape

One new Aito capability: "give me the plate facts of this `.3mf`". Requires the same
permission as creating an Aito project. Returns, per plate: index, name (nullable), print
time (s), total weight (g), printer model, filaments (type, colour hex, grams), objects
(name, count, x/y/z mm), and the plate thumbnail.

Constraints:
- Slicing can take minutes and the shop is reached through a tunnel that cuts long
  requests. The import therefore cannot be one long HTTP request: start a job, report
  progress, fetch the result (the Projects slice does this with `slice_dispatch`; reuse it
  if it fits, builder's call on mechanics).
- Nothing is persisted. The uploaded file and the slicer's output live in temp storage and
  are removed when the job ends or is cancelled.
- The upload is untrusted: same size caps and zip-bomb guard as Projects
  (`check_source_within_caps`), XML through `defusedxml`.
- A `.3mf` with no `Metadata/project_settings.config` (plain CAD export) is refused with a clear message, as Projects refuse it.
- Registration: new Aito routes must be counted and classified in
  `backend/tests/unit/test_aito_permissions.py`.

## Errors the operator can see

- No slicer configured / slicer unreachable → message in the Work section, drafts untouched.
- Slice failed → the slicer's message (trimmed) and a Retry button.
- Already sliced → "This file is already sliced; import the Bambu Studio project .3mf."
- Not a Bambu project file → "This .3mf has no slicer settings; open and save it in Bambu
  Studio first."
- A plate with no objects or zero weight is listed unticked.

## Testing

- Backend unit: plate facts from a slicer-output fixture (names, time, weight, main filament
  with several filaments); refusal of an already-sliced upload; mesh dimensions including a rotated instance;
  object grouping. Route test with the slicer stubbed (never call a real slicer or Zoho).
  Fixture zips need fixed timestamps.
- Frontend: plate → task-draft mapping (naming fallbacks, matching: one / several / none,
  price null when unmatched, note text); the review panel appends to existing drafts.
- All new strings in every locale file under `frontend/src/i18n/locales/` (16, including `pl`).

## Known limits

- No slicer runs on the dev Mac; the import can only be exercised end to end against the
  shop server. Locally it is covered by tests with the slicer stubbed.
- The slicer uses the settings embedded in the file. A file saved for a printer the
  calculator does not list needs a manual printer choice.

## Left to the builder

Component split, endpoint names, job mechanics, where the button sits relative to "Add
task" (the mockup puts it right beside), thumbnail transport, and the optional polish
named above.
