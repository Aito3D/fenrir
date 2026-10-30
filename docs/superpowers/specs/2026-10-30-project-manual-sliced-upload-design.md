# Project revisions: manual sliced-file upload after a failed server slice

Date: 2026-10-30. Builds on `2026-10-17-project-server-slicing-design.md`.

## Intent

When the slicer sidecar is down (card shows `Slice failed: Slicer sidecar unreachable: …`), the
operator slices the same project on their own PC in Bambu Studio and hands the result to the
revision, so the print can go on without waiting for the sidecar. The upload takes the place the
server slice would have taken: same hidden `derived_slice` row, same `sliced` state, same queue
settlement (`slice_failed` queue items move to `pending`).

## User request (verbatim intent)

Next to **Retry** on a failed slice, a button to add the file manually: the user uploads the
G-code file; the server checks it really is G-code and that its settings match the revision's
(printer, filament, nozzle…).

## Decisions (mine, stated for the user)

1. **File kind: the sliced plate file (`.gcode.3mf`)**, not a raw `.gcode`. Every downstream
   reader (dispatch, plate G-code, print time, filament types, cross-model gate) reads a sliced
   3MF; a raw `.gcode` has neither plates nor `project_settings.config` to compare. The dialog
   tells the user to use *Export plate sliced file* in Bambu Studio. A `.gcode` is refused with
   that hint, client-side and server-side.
2. **"Actually G-code" = content, not name**: `classify_3mf(path) == "sliced"` (carries plate
   G-code). A source `.3mf` renamed `.gcode.3mf` is refused.
3. **Settings check is strict (400 on mismatch)**, no "use anyway" override: the user asked for a
   check. Compared keys, each only when present on both sides: `printer_model` (via
   `normalize_printer_model`, case-insensitive), `nozzle_diameter` (float), `layer_height`
   (float), `filament_types` (ordered list, case-insensitive). A file with no
   `project_settings.config` while the revision has a profile is refused ("carries no settings
   to check").
4. **Only a `failed` revision takes an upload** (409 otherwise: slicing now / already sliced /
   never sliced). The button only shows in the `failed` state.
5. **Stored like a server slice**: `project_slice._store` with `output_filename(source)` as the
   name and metadata `{print_time_seconds, filament_used_grams, sliced_for_model}` read from the
   file (`ThreeMFParser`, falling back to the revision's printer for `sliced_for_model`).
   A concurrent Retry that lands first makes `_store` return `{}` → 409 already sliced.
6. Permissions: `projects:update`, same capped multipart route class as the revision upload.
7. No project event is recorded (server slices record none either).

## API

`POST /api/v1/projects/revisions/{revision_id}/sliced-file` — multipart `file` (one). 200 →
`ProjectRevisionOut`. Errors: 404 revision; 409 `{code: "not_failed", message}`; 400 string for
name/content refusals; 400 `{code: "settings_mismatch", message, mismatches: [{field, file,
revision}]}` for the settings check (`field` ∈ printer_model | nozzle_diameter | layer_height |
filament_types; values are display strings).

## UI

- `SliceLine` (failed state): **Retry** · **Upload sliced file** (Upload icon). Also in the ⋯ menu.
- `UploadSlicedDialog`: title, hint (export plate sliced file, same settings), the revision's
  profile line (what must match), file input (`.gcode.3mf,.3mf`), inline error (mismatch list
  with translated field labels; other refusals as text), Cancel / Add. Success toasts
  `Sliced file added` and the tree refetches.

## Tests

Backend integration (`test_project_slice_manual_upload.py`): happy path moves a failed revision
to `sliced` with the hidden row and settles a `slice_failed` queue item; refusals: raw `.gcode`,
source `.3mf` content, settings mismatch (structured detail), not-failed revision (409).
Frontend: `SliceLine`/`ItemCard` shows the button only on failure; dialog posts the file, shows
the mismatch list, closes on success.
