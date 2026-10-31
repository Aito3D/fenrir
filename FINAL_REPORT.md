# Refactor campaign 30 — final report

Scope: Projects-as-PDM (seventh pass, seeded from campaign 29 leads). Branch `auto-refactor-loop`,
BASE `refactor-base` = 6845b971d (upstream merge 7fba95bc2). Started 2026-10-26, exited 2026-10-31.

**Exit reason: MAX_ITER** (12 of 12 iterations, round 1 of 3; no resurvey ran).
Parameters: MAX_ITER 12, MAX_ROUNDS 3, BATCH 3, TRIAGE none, MODE auto, COMMIT_STYLE grouped, MERGE_CADENCE at-exit.

## Result

| | Start (BASE) | Exit (loop-12) |
|---|---|---|
| Backend scoped coverage (statements) | 4587/4660 = 98.43% | 4668/4725 = 98.79% |
| Frontend scoped coverage (statements) | 1708/1889 = 90.41% | 1685/1861 = 90.54% |
| Backend tests | 23702 passed | 23742 passed, 10 skipped |
| Golden probes | 11/11 | 11/11 (pdm-i18n re-recorded under T-473) |
| basedpyright lock mode | 0 errors | 0 errors (one stale baseline entry removed with T-497) |

Tasks: 53 total — **36 DONE**, 16 OPEN, 1 WONTFIX-AUTO, 0 BLOCKED.
Every iteration passed the blind verifier on its first verdict (iteration 3 first came back incomplete because the
Mac slept on battery; the same verifier then finished with a PASS).

## Iterations

| Tag | Tasks | Summary |
|---|---|---|
| loop-1 | T-479, T-481, T-482 | Re-slice size cap, source removal resets the slice, undo cleans files first |
| loop-2 | T-483, T-484, T-488 | Failed-slice write retried, refused drops leave no empty item, slice-start guard tests |
| loop-3 | T-489, T-490, T-491 | Tests for startup slice recovery, the move-to-project gate and card slice states |
| loop-4 | T-492, T-497, T-498 (+T-495) | Sub-project row tests, dead add-files chain removed, legacy ItemRow read-only |
| loop-5 | T-459, T-460 | Orphan-sweep startup tests, project files service tests split by operation |
| loop-6 | T-462, T-463, T-464 | List grid tests, reslice unmount tests, slice store undo cleans first |
| loop-7 | T-465, T-466, T-467 | Shared quiet rollback, merged error branches, one source-file name |
| loop-8 | T-468, T-469, T-470 | One library path helper, public store_derived_file, slice-status constants |
| loop-9 | T-471, T-472, T-473 | Slice-wait constant in main.py, print_queue wrappers inlined, unused addFiles key removed |
| loop-10 | T-474, T-475, T-476 | Shared file-type badge tone, format and timeline edge-case tests |
| loop-11 | T-477, T-478, T-480 | Reslice test patches only its own sleep, queue routes hide aito_task_id, generic legacy-migration reasons |
| loop-12 | T-485, T-486, T-487 | A slice failing at once returns its job; missing source files are reported as missing |

## By source

| Source | DONE | OPEN | Other |
|---|---|---|---|
| survey (c29 carry-over) | 18 | 0 | 1 WONTFIX-AUTO |
| audit-security | 3 | 0 | |
| audit-robustness | 7 | 0 | |
| audit-tests | 6 | 3 | |
| audit-cleanliness | 2 | 13 | |

## User-approved behavior changes (all in BASELINE-CHANGELOG.md)

Approved 2026-10-26 in the round-1 approval sweep: T-478, T-479, T-480, T-481, T-484, T-485, T-486, T-487, T-504;
T-497 for the unobservable part only.

- **T-479** — POST /projects/revisions/{id}/reslice answers 413 when the source is over the slicing caps.
- **T-481** — removing a revision's source .3mf resets its slice. Consequences accepted 2026-10-28: the old slice
  row is hard-deleted and the file goes to the project _trash.
- **T-484** — a refused drop deletes the empty item it created. Consequences accepted 2026-10-29: this applies to any
  add_revision failure in a drop.
- **T-478** — PATCH /queue/{id}, POST /queue/{id}/start and GET /queue/history hide aito_task_id from callers without
  aito:read. Minimal version: bulk.py and _enrich_response untouched.
- **T-480** — legacy-migration failures[].error shows generic reasons. LegacyMigrationError messages kept verbatim.
- **T-485** — a slice that fails within milliseconds answers 202 with its job id and status 'failed'.
- **T-486 / T-487** — missing source files read "The revision's source .3mf is missing". Consequences accepted
  2026-10-31: the symlink-escape refusal, a missing non-source legacy .3mf, and a no-project retry use the same text.
- **T-473** (approved 2026-10-31) — fork key projectsPdm.files.addFiles removed from 15 locales; pdm-i18n re-recorded.
  The 6 other unused keys are upstream-owned and were left alone.
- **SURFACE re-baselines** — T-497 (add_files_to_revision removed, allowed 2026-10-30); a standing approval
  (2026-10-30) for additive internal-helper exports (T-479 check_source_within_caps, T-469 store_derived_file,
  T-474 fileTypeBadgeTone); extended 2026-10-31 to occurrence-count-only lines (T-468 settings.base_dir 3 -> 2).

**Changes with no changelog entry:** T-482, T-464 (undo deletes files before rollback) and T-483 (_mark_failed
retries 3 times, 0.5 s / 1.0 s backoff; its exception is logged only after the last attempt). They only differ when
a database write or rollback fails. Every verifier judged them non-observable. Add an entry if you want them on record.

## Left over

**OPEN (16, all P3):**
- Tests: T-493 (move-to-project tests patch process-wide Path methods), T-494 (blank-title test uses a fixed 100 ms
  sleep), T-496 (DeliveriesPicker cancel/backdrop untested).
- Cleanliness: T-499, T-500, T-501, T-502, T-503, **T-504 (already user-approved)**, T-505, T-506, T-507, T-508, T-509,
  T-510, T-511.

**WONTFIX-AUTO:** T-461. The confirm dialog it targeted was removed, so the task is obsolete.

The full records are in PLAN.md, copied to plans/refactor-campaign30/.

## Leads for the next campaign (unverified unless stated)

- **project_slice._start race (REPRODUCED).** Two concurrent slice starts can enqueue 2 jobs, or the loser gets None.
  Since T-485, a loser that reads the old slice_job_id after the winner's job failed answers 202 'failed' with that
  old id.
- **Aito task id redaction gaps.** Upstream GET /bulk/printer-queues calls _enrich_response unredacted. The
  add_to_queue response can carry an aito_task_id read from the file (trace.aito_task_id). Making the redaction a
  required parameter of _enrich_response would close both. This touches upstream code and needs approval.
- **project_slice._store** should check the slice came from the current source. A job that read the old source's
  bytes can still land the removed source's G-code (see T-481).
- **library_trash.py:109** lists every soft-deleted row with no `revision_id IS NULL` filter, so project revision rows show.
- **project_filing.** The move/import and auto-file callers may leave empty items when the copy fails (sibling of
  T-484). _skip_failed_group uses an inline literal that could share a constant.
- **FileManagerPage.tsx:3674.** The bulk "Move to project…" gate ignores file ownership.
- **format.ts formatFilament(999.6).** It renders "1000g", not "1.00kg". This is pinned as the current behavior.
- **_error_status_and_message.** It still round-trips through HTTPException in _run_slice.
- **Stale RevisionSliceStarted docstring.** It still says "slicing, or sliced"; it can now be 'failed'. The
  pdm-pydantic-schemas golden pins it.
- **T-486 no-project retry.** It could answer NO_PROJECT_TO_SLICE instead of "missing". The missing-file text names
  "source" even for non-source legacy files.
- **print_cost_estimate._source_path (outside PDM scope, from c29 T-425).** A queued print whose file became a symlink
  out of the data folder errors on every scheduler pass and stays pending.
- **Dead code with baselined basedpyright errors.** Deleting such code needs the same baseline edit; lock mode fails
  on the stale entry.

Older carried leads are in plans/refactor-campaign30/c30-leads.md.

## Merge

Not merged. To land:

    git merge auto-refactor-loop
    git worktree remove --force ../bambuddy-refactor

`static/` was not rebuilt on the branch. Rebuild after merging, because T-473, T-474 and T-498 touch the frontend.
