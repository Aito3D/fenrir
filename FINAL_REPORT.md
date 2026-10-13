# Refactor campaign 26 — final report

Projects-as-PDM feature, third pass. Worktree `../bambuddy-refactor`, branch `auto-refactor-loop`, cut from
main `7262cca50` on 2026-10-11. Ran 2026-10-11 to 2026-10-13.

## Summary

| | |
|---|---|
| Iterations run | 12 of 12 (MAX_ITER) |
| Survey rounds | 1 of 3 (round 1 at setup; the plan never ran out, so no resurvey) |
| Commits | 14 on the branch: the empty setup commit, 12 squashed iteration commits, this report |
| Tags | `refactor-base` (693d73f29), `loop-1` … `loop-12` (loop-12 = c425d7fe7) |
| Verifier verdicts | 13 PASS, 1 FAIL (iteration 1, fixed the same day; see below) |
| Tasks | 57 filed · 36 DONE · 21 OPEN · 0 BLOCKED · 0 WONTFIX-AUTO · 0 triaged (TRIAGE: none) |

**Why the loop ended:** MAX_ITER (12). 21 tasks remain OPEN, none blocked.

Parameters: SCOPE Projects-PDM (`scope-brief.md`), MAX_ITER 12, MAX_ROUNDS 3, BATCH 3, TRIAGE none, MODE auto,
COMMIT_STYLE grouped, MERGE_CADENCE at-exit.

## Approvals

At setup the user decided the 30 behavior-change approvals carried over from campaign 25 plus 3 new ones, one by
one: 31 approved, 1 declined (c25 T-220, fd-served downloads; FileResponse keeps Range/ETag). During the loop the
user also approved T-255 (flagged by verifier 1) and the "consequences beyond the approval text" that workers
reported for T-285, T-286, T-288, T-289, T-290, T-291, T-292, T-293, T-294, T-295, T-303, T-256 and T-259. Every
one of these is recorded in BASELINE-CHANGELOG.md with its consequences.

## User-approved behavior changes landed (BASELINE-CHANGELOG.md)

| Task | Iter | Change |
|---|---|---|
| T-283 (c25 T-222) | 1 | POST /queue/ accepts a project-filed revision file; its post-print cleanup flag is stored false |
| T-255 | 1 | External File Manager sources must resolve under a registered external mount; copies open with O_NOFOLLOW |
| T-257 | 1 | Task-row "New project" creates and links in one POST /aito/tasks/{id}/project |
| T-284 (c25 T-174) | 3 | API-key uploads need projects:update for auto-filing |
| T-285 (c25 T-176) | 3 | Move-to-project skips an unexpectedly failing group as `error` instead of a 500 |
| T-286 (c25 T-177) | 4 | A partly failed task drop returns 201 with the stored files plus `errors` |
| T-288 (c25 T-181) | 4 | Re-slice intermediate delete retried; startup sweep of orphaned intermediates |
| T-289 (c25 T-184) | 5 | Chunked uploads without Content-Length get the same 413 cap |
| T-290 (c25 T-185) | 5 | Post-cancellation commit wait bounded at 30 s |
| T-291 (c25 T-186) | 5 | PostgreSQL revision row locks; new PG-only 409 on POST /queue/ |
| T-292 (c25 T-213) | 6 | File removal re-checks the revision after the flush (409) |
| T-293 (c25 T-214) | 6 | Link/delivery edits re-check the task after the flush (404) |
| T-294 (c25 T-215) | 6 | Card merge re-points print queue items and archives to the copied tasks |
| T-295 (c25 T-216) | 7 | Pre-phase-1 project storage_dir fixed once (migration + conditional claim) |
| T-303 (c25 T-219) | 7 | Library download/slicer/gcode reads of revision files go through the symlink guard |
| T-256 | 8 | Upload revision note capped at 5000 characters (422) |
| T-259 | 8 | A drop with a file name that sanitises to blank is refused whole (400) |

Goldens re-recorded under these entries: pdm-rules (T-285), pdm-openapi + pdm-pydantic-schemas + pdm-i18n
(T-286), pdm-openapi (T-256). SURFACE.md gained only additive names (find_revision_bundle, useProjectSearch,
ProjectOptionLabel, sweep_orphan_intermediates, DropFilesError, lock_revision_rows, revision_lock_statement,
move_task_print_trace, revision_folder_name, split_gcode_3mf, revisionNumberLabel, sectionRevisionLabel, Chevron,
OutdatedChip, DROP_HIGHLIGHT_CLS, canDropFiles, failureMessage, projectTreeQuery), each with a changelog note.
Nothing was removed or renamed.

## Zero-behavior work landed

T-263 shared revision-bundle query · T-270 shared project search hook · T-276 projects_root_fixture everywhere ·
T-278 shared project-tree test fixtures · T-287 already done (no change) · T-311 pydantic floor 2.12.0 ·
T-258 drop broadcast after a cancelled record · T-260 file types classified before the write lock ·
T-261 one revision folder name · T-262 str(exc) details · T-264 one .gcode.3mf split · T-265 revisionNumberLabel ·
T-266 sectionRevisionLabel · T-267 isSectionEnabled · T-268 shared Chevron · T-269 OutdatedChip ·
T-271 drop permission + highlight · T-272 failureMessage · T-273 projectTreeQuery.

## Survey round 1 (only round)

27 findings filed: security 2, robustness 4, cleanliness 18, tests 3. Plus 28 carried approvals re-added from
campaign 25 and T-282 (c25 T-254). One task (T-311) was added by the orchestrator from verifier 4's remark about
the pydantic floor, with `--source survey`; strictly that is outside the "auditors are the only source" rule, and
it is noted here for that reason.

## Findings by auditor (plan.py stats)

| Source | Filed | DONE | OPEN | BLOCKED | WONTFIX-AUTO |
|---|---|---|---|---|---|
| audit-security | 7 | 5 | 2 | 0 | 0 |
| audit-robustness | 21 | 14 | 7 | 0 | 0 |
| audit-cleanliness | 23 | 16 | 7 | 0 | 0 |
| audit-tests | 5 | 0 | 5 | 0 | 0 |
| survey | 1 | 1 | 0 | 0 | 0 |

Triaged this campaign: none (TRIAGE: none). TRIAGE.md was not used.

## Verification

| | BASE | Final (loop-12) |
|---|---|---|
| Backend scoped statement coverage | 98.04% (3760/3835) | 98.13% (3935/4010) |
| Frontend scoped statement coverage | 89.30% (1487/1665) | 89.77% (1510/1682) |
| Backend tests passed | 20225 | 20348 |
| Frontend tests passed | 9030 | 9073 |
| Golden probes | 11/11 | 11/11 (4 re-recorded under sanctioned entries) |
| known_broken | none | none |

The only FAIL was verifier 1: T-255's external-source containment refused inputs that were copied before, with
no changelog entry (the auditor had marked it behavior_change false). The user approved it, a changelog-only commit
followed, and verifier 1b passed. Lesson: a security hardening that refuses or skips inputs accepted today is a
behavior change.

Diff refactor-base..loop-12: 98 files, +4377/−489 (production code in backend/app and frontend/src: 37 files,
+830/−239; the rest is tests, fixtures, SURFACE.md and the changelog).

## Tasks left OPEN (21)

User-approved behavior changes (approved 2026-10-11, carried from campaign 25; each still needs its own changelog
entry when worked): T-296 legacy_migration_status_running only used by a test (surface removal) · T-297 throttle
the project-codes invalidation on aito_changed · T-298 archive_pending_upload auto-files without projects:update ·
T-299 unused re-export of inZone/isFileDrag (surface removal) · T-300 cap path components by bytes (existing
folders must stay resolvable) · T-301 concurrent same-name create_item → 500 · T-302 _delete_item_locked post-flush
re-check · T-304 drop finally lets a failing rollback replace the error · T-305 _CommitGuard undo failure aborts
cleanup · T-306 download_revision zip vs concurrent delete → 500 · T-307 failure tests patch process-wide stdlib
(seam) · T-308 merge RevisionBlock.formatSize onto formatFileSize and fix its 0<x<1 bug · T-309 concurrent tag
creation → 500 · T-310 sweep leftover .part files.

Zero-behavior: T-274 split drop_files_on_task (C901) · T-275 BOM price CalcInputs duplication · T-277 Aito
project-link test helpers copied across three files · T-279 / T-280 sleep-based "nothing happened" tests ·
T-281 DialogShell test pins class strings · T-282 MoveToProjectModal toast severity asserted via icon classes.

Full evidence for every open task is in PLAN.md, copied to `plans/refactor-campaign26/` in the main checkout
(gitignored) together with BASELINE.md, VERDICTS.log, the four raw auditor findings files and the batch files.

## Worker leads (noticed, not filed)

- library.py's own capped upload route has the same chunked-body gap as T-289 (POST /library/files, /extract-zip).
- POST /library/files/add-to-queue and archive reprints take no revision lock (PostgreSQL race of T-291).
- PrintScheduler._get_filament_requirements reads revision bytes without the symlink guard (metadata only).
- The dev venv has pydantic-settings 2.13.1 below the requirements' 2.14.2 security floor.
- merge_project's docstring "Copies, never moves" is partly stale after T-294 (changing it re-records pdm-openapi).
- Other AitoTask ORM updates in routes/aito.py may 500 (StaleDataError) when racing a task delete.
- The pdm-frontend-pure probe pins the export lists of files/filesUi.ts and files/fileDrop.ts.
- pages/ProjectsPage.tsx (53.5%) is the largest uncovered file in scope.
