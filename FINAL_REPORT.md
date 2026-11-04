# Refactor campaign 31 — final report

Scope: the Projects feature pages (ProjectDetailPage, ProjectListPage + catalog, components/projects/**) and the backend
they call. Eighth pass on Projects-as-PDM. Started 2026-11-01, exited 2026-11-03.

## Run

| | |
|---|---|
| Campaign | 31 |
| Iterations run | 12 (MAX_ITER 12) |
| Survey rounds | 1 (no resurvey reached) |
| Commits | 12 squashed iteration commits `loop-1`..`loop-12` on `refactor-base` (98d820355), plus this report |
| Tags | `refactor-base`, `loop-1`..`loop-12` |
| Upstream base | main 851c46088 (loop-2 tip was merged and pushed to main as d539b5ac9 mid-campaign) |
| Diff refactor-base..loop-12 | 76 files, +3124 / −3342 |
| Exit reason | MAX_ITER |

Parameters: MAX_ITER 12, MAX_ROUNDS 3, BATCH 3, TRIAGE none, MODE auto, COMMIT_STYLE grouped, MERGE_CADENCE at-exit.

## User-approved behavior changes (full text in BASELINE-CHANGELOG.md)

- **T-524** a reused revision id no longer inherits a deleted revision's pins (approved post-hoc 2026-11-01).
- **T-552 + T-525** a slice whose source .3mf is removed mid-run re-slices the current source, or fails with "The revision's source .3mf is missing".
- **T-555** the unrouted upstream `pages/ProjectsPage.tsx` deleted; ProjectModal moved to components/projects; 30 dead-page tests removed.
- **T-520** GET /projects/catalog hides Aito client names, open orders and order search without aito:read.
- **T-521** POST /revisions/{id}/sliced-file also needs queue:update_all; the default Operators group loses "Upload sliced file".
- **T-529** the catalog response gains `truncated`; the header shows "N of N+".
- **T-527** a ?project= selection inside a collapsed folder stays selected and opens its folders.
- **T-528** file actions and a landed slice refresh the catalog row (no folders refetch, per the user).
- **T-530** a move that stores nothing deletes the item it created, on every filing path.
- **T-580** concurrent slice starts run one job (claim winner holds the in-flight mark; resume claims keyed on the job id).
- **T-568** 18 never-read projectsPdm locale keys removed from all 15 locales.
- **T-571** ProjectModal's legacy (non-pdm) mode removed with 5 legacy tests; the dialog no longer fetches the project list; SURFACE −5 `projects.*` usage lines.
- Standing SURFACE rules (a)/(b)/(c) carried from c30: additive exports SORTS/SORT_KEYS/CHIPS (T-556), CodeMark/InProductionFlame (T-557), DeleteItemButton (T-514).

## Resurvey rounds

None. Round 1 filed 59 findings + 8 carried from c30 = 67; T-579 (known-broken gzip test) and T-580 (race found by
T-551's test, user-approved) were added by hand with source `survey` / `audit-robustness`. 69 tasks total.

## Findings by auditor

| Source | Filed | DONE | OPEN | BLOCKED | WONTFIX-AUTO |
|---|---|---|---|---|---|
| audit-security | 4 | 2 | 2 | 0 | 0 |
| audit-robustness | 11 | 8 | 2 | 0 | 1 |
| audit-cleanliness | 24 | 9 | 15 | 0 | 0 |
| audit-tests | 21 | 12 | 9 | 0 | 0 |
| survey (c30 carry-overs + T-579) | 9 | 4 | 5 | 0 | 0 |
| **Total** | **69** | **35** | **33** | **0** | **1** |

T-580 is counted under audit-robustness although it was hand-filed from a worker's test result with the user's approval.
Triaged: 0 (TRIAGE: none; no TRIAGE.md exists).

## Quality gates

| | refactor-base | loop-12 |
|---|---|---|
| Backend scoped coverage | 5160/5255 = 98.19% | 5233/5309 = 98.57% |
| Frontend scoped coverage | 2519/2823 = 89.23% | 2479/2625 = 94.43% |
| Backend suite | 25026 passed, 1 failed (gzip test) | 25070 passed (loop-10 run; loop-11/12 frontend-only) |
| Frontend suite | 10355 passed (4 load flakes) | 10373 passed, 1 skipped |
| Known-broken tests | 1 (test_json_gzip_middleware) | 0 |
| Golden probes | 11/11 | 11/11 (pdm-route-perms, pdm-openapi, pdm-pydantic-schemas, pdm-i18n re-recorded under approvals) |
| SURFACE.md | — | changed only by the approved/sanctioned lines above |

The frontend denominator shrank with the deleted ProjectsPage (loop-2), so the frontend percentages are not directly
comparable across that commit. Every iteration passed the blind verifier on its first run except iteration 1 (one FAIL:
missing changelog for T-524, fixed and re-verified).

## Left for humans (33 OPEN, 1 WONTFIX-AUTO)

User-approved but not reached: **T-522** (catalog search 500 on Unicode digits / huge order numbers), **T-523**
(Infinity/NaN pin coordinates break GET pins), **T-569** (drop unused searchProjects params and backend filters),
**T-570** (RevisionSliceStarted docstring). T-533 is WONTFIX-AUTO as a duplicate of T-523.
The other 29 are P3 tests and cleanups (T-515..T-519, T-531, T-532, T-535, T-540, T-542, T-543, T-545, T-546, T-549,
T-550, T-554, T-559..T-562, T-565..T-567, T-572, T-574..T-578). Full records: plans/refactor-campaign31/PLAN.md.

## Leads for the next campaign (plans/refactor-campaign31/leads-c31.md)

- Remaining narrow `_starting` gap on a non-resume claim of a just-failed revision; a per-revision counter would close it.
- store_uploaded_slice has the same source-changed race T-525 fixed for server slices; items on a removed source can stay `slicing`.
- POST /revisions/{id}/slice releases other users' waiting queue items on projects:update alone.
- in_production_count on GET /projects/folders still counts orders for callers without aito:read.
- A failed first move leaves an empty project folder and section folder on disk.
- UploadSlicedDialog needs a re-pick before retrying (T-531 covers it).
- `ancestor_ids` and `eligibleParents` have no production caller; catalogKeys/projectKeys import each other.
- `tools/gen_surface_pdm.sh` and `tools/coverage_pdm.sh` still name the deleted ProjectsPage.tsx; `> SURFACE.md` in place empties the file.
- Out of scope: test_printer_hours_migrations::test_migration_backfills_calibrated_at_from_offset fails whenever local and UTC dates differ.

## Preserved state

Copied to the main checkout's gitignored `plans/refactor-campaign31/`: PLAN.md (+ PLAN-render.txt), BASELINE.md,
VERDICTS.log, findings-audit-*-r1.json, leads-c31.md, scope and audit/worker briefs, every batch JSON, already-filed
lists, commits.txt.
