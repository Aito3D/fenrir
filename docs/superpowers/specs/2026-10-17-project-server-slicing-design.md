# Projects: source .3mf only, server-side slicing, card layout

Date: 2026-10-17
Status: draft, awaiting approval (builder-check answers folded in)

## Why

Today an operator slices in Bambu Studio on their own computer and uploads the
resulting `.gcode.3mf` to the project. The editable source `.3mf` stays on that
computer. A second operator who needs to change the part cannot get at it, and
sometimes the original is lost for good. The project ends up holding a sliced
file locked to one printer that nobody can edit.

The project should keep the **editable source `.3mf`** as the record of each
revision. The server slices it, keeps the gcode attached to that revision, and
uses that gcode when the operator prints. Changing a part becomes: download the
`.3mf`, edit it in Bambu Studio, upload it as the next revision, and the server
slices that one too.

## Goals

- A project revision holds only source files. Sliced files can no longer be uploaded.
- Every uploaded `.3mf` is sliced on the server as soon as it is uploaded, all plates,
  using the printer/process/filament setup saved inside the file ("slice as designed").
- The resulting gcode is attached to the same revision, not to a new revision, and
  is not shown as a separate file.
- Print from a project queues that gcode. An operator can click Print right after
  uploading, before the slice has finished; the job appears in the queue straight
  away in a slicing state with progress and is only dispatched once the gcode exists.
- The Printing panel is redesigned as a grid of cards (layout "D" from the demo).

## Non-goals

- Slicing for a different printer than the one set up in the file. The file's own
  setup is the only one used for now.
- Editing the `.3mf` in the browser.
- Converting or re-slicing revisions that already hold a `.gcode.3mf`.
- Any change to the File Manager, Archives or the general print queue outside what
  the "slicing" queue state needs.

## Anti-goals (failure even if it works)

- A printer ever receives an unsliced `.3mf` from a project print. (Today this can
  happen: the Print button shows on any `.3mf` and the file is sent as-is.)
- A failed slice that silently drops the queued job, or leaves it waiting forever
  with no visible reason.
- Losing the source `.3mf`: the gcode is derived data; the `.3mf` is the record.

## Decisions made with the user

1. **Upload is source-only.** A project revision accepts `.3mf` only. `.gcode.3mf`,
   `.gcode` and `.bgcode` are refused with a clear message, in both the upload
   dialog/drop zone and the backend. (Detection of a sliced 3MF must look at the
   content, i.e. a `Metadata/plate_*.gcode` member, not only the `.gcode.3mf`
   suffix, since a sliced file can be renamed to `.3mf`.)
2. **Slice on upload.** Slicing starts as soon as the revision's `.3mf` is stored.
3. **All plates.** Every plate is sliced; the operator picks the plate when printing,
   as the existing PrintModal already does for multi-plate sliced files.
4. **Settings come from the file, no presets.** The file is a Bambu Studio project
   `.3mf`, so the headless slicer opens it and slices with the printer, process and
   filament setup saved inside it. No preset is picked or matched. The sidecar client
   already has this mode: `SlicerApiService.slice_without_profiles` (model only, no
   profile triplet; `plate=0` slices every plate; `export_3mf=True` returns a
   `.gcode.3mf`). The slicer used is the one in Settings (`preferred_slicer` →
   `bambu_studio_api_url` / `orcaslicer_api_url`). Do not go through the File Manager
   Slice modal's preset-matching path.
5. **The gcode lives behind the `.3mf`.** It is not listed as its own file in the
   revision. It shows as the card's slice state ("Slicing… 62%", "Sliced",
   "Slice failed") and can be downloaded from the ⋯ menu.
6. **Print while slicing.** If the operator prints before the slice is done, the job
   is added to the print queue immediately in a **slicing** state that shows the
   slice progress. The scheduler skips it until the gcode exists, then it becomes
   a normal pending job.
7. **Failed slice.** The queued job stays in the queue marked "Slice failed" with a
   retry action; it is not removed. The card shows the same failure with a retry.
8. **Pipeline re-slice is hidden.** The Re-slice button / ResliceDialog is no longer
   shown in projects. The backend code stays (turned off, not deleted) so it can come
   back later for "slice for another printer".
9. **Existing revisions.** Revisions that already contain a sliced `.gcode.3mf`
   keep working and printing as today; no upload can add one any more. Existing
   revisions that hold an **unsliced** source `.3mf` are not sliced in bulk: they
   are sliced on demand, either from a Slice action on the card or automatically
   when someone clicks Print (through the same queue "slicing" state). From now on
   no project print may send an unsliced `.3mf` to a printer, old revision or new.
10. **One source, one gcode per revision.** A new revision holds exactly one source
   `.3mf` and gets exactly one sliced output. Several gcodes per revision (one per
   printer model, same part) is a possible later step, not now.
11. **A `.3mf` without slicer setup is refused at upload.** If the file has no
   `Metadata/project_settings.config` (a plain model exported from CAD), the upload
   is refused with a message telling the operator to open it in Bambu Studio, set
   the printer, and save it as a project. Routing such files through a pipeline is
   a possible later step.
12. **Printing before the slice is done.** The operator picks the plate and the
   printer from what the source `.3mf` already holds (plate list and thumbnails from
   `Metadata/plate_*.png` / `plate_*.json`). AMS slot matching is done automatically
   at dispatch by the scheduler (`_compute_ams_mapping_for_printer`, already used
   for queued jobs). The user agreed to try this; watch it in practice.
13. **All plates in one slice (builder-check call, not the user's).** One sidecar
   call with `plate=0`. If any plate fails, the whole slice is "Slice failed" and the
   retry re-runs all plates. Per-plate slicing can come later if this bites.
14. **Card layout D** (demo: `docs/superpowers/specs/2026-10-17-project-server-slicing-demo/index.html`, tab "D · B + C mix"):
    - One card per item, up to 5 per row on wide screens (File Manager grid widths).
    - Coloured strip on top following the shown revision's status
      (amber in progress, teal approved, grey obsolete).
    - Square thumbnail of the part with a file-type badge; OUTDATED badge when relevant.
    - Revision chips (R3 R2 R1, newest first) and a `+` for a new revision under the
      thumbnail. Picking an older revision switches the whole card to it and dims
      the picture with an "Older revision" label.
    - Name, size, print time and grams (once sliced), printer · nozzle · layer · filament,
      slice state line (with a progress bar while slicing), author and date.
    - **Icon-only** action row with hover labels: Print, Open in slicer, Preview,
      Download, ⋯ more. (The demo still shows a Re-slice icon; leave it out, see
      decision 8.)
      Delete stays hold-to-delete (shipped just before this design).
    - A dashed "Drop a .3mf" card at the end of the grid creates a new item.

15. **Open in slicer (added by the user after approval).** Each card has an "Open in
    slicer" icon that opens the revision's **source `.3mf`** in the desktop slicer on
    the operator's computer, so they can edit it and upload the result as the next
    revision. Reuse the File Manager's handoff as-is: `api.createLibrarySlicerToken`
    + `api.getLibrarySlicerDownloadUrl` + `openInSlicer(url, preferredSlicer)` from
    `frontend/src/utils/slicer.ts` (see `handleOpenInSlicer` in
    `FileManagerPage.tsx`), with the same toast on failure. Which desktop slicer
    opens follows the existing preferred-slicer setting, like the File Manager
    (builder-check call; the user said "Bambu slicer", which is the default). It
    never opens the sliced output. Shown only to users who may download the file,
    mirroring the File Manager's permission rule for this handoff.

## Telling a source .3mf from a sliced .gcode.3mf

Both end in `.3mf` and both are ZIP packages, but they are different things. The
system must classify by **content**, never by file name. Observed on 2026-10-17
(a Bambu Studio 02.05 `.gcode.3mf` from `archive/temp/` vs. the LookUp Space
project `.3mf`, Bambu Studio 02.08):

| Member | Source `.3mf` (project) | Sliced `.gcode.3mf` |
|---|---|---|
| `Metadata/plate_N.gcode` (+ `.gcode.md5`) | absent | present, **only for the plates that were sliced** (the sample had 9 plate images but only `plate_6.gcode`) |
| `3D/Objects/object_*.model` (meshes) | present (the 2.7 MB of geometry) | **absent**: `3D/3dmodel.model` is a ~1 KB stub, so the part cannot be edited or re-sliced from it |
| `Metadata/project_settings.config` | present (printer, process, filament setup) | present (the settings it was sliced with) |
| `Metadata/model_settings.config`, `cut_information.xml`, `filament_sequence.json` | present | present |
| `Metadata/slice_info.config` | header only (client version) | per sliced plate: `printer_model_id`, nozzle diameters, `prediction` (seconds), `weight` (g), filaments with `used_g`/`used_m`/type/colour, `filament_maps`, slicer `warning`s, objects on the plate |
| `Metadata/plate_N.json` | present per plate | present for the sliced plate |
| `Metadata/custom_gcode_per_layer.xml` | may be absent | present |
| Plate images `plate_N.png`, `_small`, `no_light`, `top_N`, `pick_N` | present per plate | present for all plates of the project |

Rules that follow:
- **Sliced** = has at least one `Metadata/plate_*.gcode` member. Refuse at upload.
- **Source** = no gcode member, has mesh data (`3D/Objects/*.model` or mesh inside
  `3D/3dmodel.model`) and `Metadata/project_settings.config`. Accept.
- No gcode and no `project_settings.config` → refuse (decision 11).
- The sliced output's `slice_info.config` is where print time, grams per plate and
  filament use come from for the card and the PrintModal once slicing is done.
- Keep the source; never replace it with the sliced output (the output has no meshes).

## Current state the builder starts from

(From a code survey on 2026-10-17; verify before relying on line numbers.)

- Accepted types: `PRINTABLE_EXTENSIONS` in `backend/app/services/project_storage.py`
  and `PRINTABLE_ACCEPT` in `frontend/src/components/projects/files/filesUi.ts`;
  upload check `require_printable_uploads` in `backend/app/services/project_files.py`.
- Files are `LibraryFile` rows with `revision_id`; bytes under the project folder.
- Project print: `PrintRevisionFlow.tsx` → order picker → `PrintModal` → `api.addToQueue`
  with `library_file_id`; `backend/app/api/routes/print_queue.py` does not check the
  file is sliced.
- Sliced/source detection today: the revision snapshot sets `sliced` from a
  `Metadata/plate_*.gcode` member; the File Manager uses the `.gcode.3mf` suffix
  (`is_sliced_file`), which this design must not rely on.
- Slicing: `library.slice_and_persist` talks to the slicer sidecar
  (`services/slicer_api.py`, Bambu Studio or Orca by `preferred_slicer`), run in the
  background through `slice_dispatch` which already tracks percent progress
  (`useResliceJobs.ts` polls it). Re-slice today writes a **new revision**
  (`services/project_reslice.py`); this design does not.
- Revision profile line (`services/project_snapshot.py`) is read from the first 3MF
  and includes a `sliced` flag.

## Left to the builder

- Data model for "the gcode of this revision": a new column/table vs. a
  `LibraryFile` row flagged as derived. It must not appear in revision file lists,
  must count as "used" by the queue/archives logic, and must be removed with its
  revision.
- How the queue item references a not-yet-existing gcode (e.g. pointing at the
  revision or the slice job and resolving to the gcode when it lands) and the exact
  status name, as long as it is visibly "slicing" with progress in the Print Queue
  page and the scheduler cannot dispatch it.
- Retry mechanics, concurrency (one slice per revision at a time), and what happens
  to the queued job if its revision or project is deleted mid-slice.
- What happens when the slicer sidecar is turned off or unreachable: the upload
  must still succeed and keep the `.3mf`; the slice state shows the failure with retry.
- Card behaviour on phones and tablets, empty states, i18n keys (15 locales),
  permissions reuse.
- Whether the old per-revision list view stays reachable anywhere (e.g. inside a
  card's details); the user only asked for the card grid.
