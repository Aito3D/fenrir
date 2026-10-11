# Refactor loop — campaign 25 final report (Projects-as-PDM feature, follow-on to campaign 24)

Campaign 25 · 2026-10-09 → 2026-10-11 · worktree `../bambuddy-refactor`, branch `auto-refactor-loop` · BASE `refactor-base` = 15148b938, cut from local main 9a082aa90 (campaigns 23 + 24 merged and pushed).
Parameters: SCOPE = the Projects-as-PDM feature (backend `project_*` / `projects_pdm` / `aito_project_links` routes, services, models, schemas and the PDM hunks of shared files; frontend `pages/Project*Page`, `components/projects/**` and PDM hunks of `client.ts`, `hooks/useWebSocket.ts`, `hooks/useProjectTasks.ts` and friends — full text in `scope-brief.md`) · TRIAGE none (campaign 24's 35 triaged findings were promoted into the plan) · MAX_ITER 12, raised to 20 and then to 28 each time the user said "continue" after a MAX_ITER exit · MAX_ROUNDS 3 · BATCH 3 · auto · grouped commits · merge at exit.

## Outcome

| | |
|---|---|
| Iterations run | 28 (`loop-1` … `loop-28`); 27 worked and verified blind, all PASSED (iterations 6, 13 and 22 needed one coverage follow-up commit each; iteration 19 produced no commits because both selected tasks were behaviour changes) |
| Survey rounds | 2 of 3 (round 2 after the plan emptied at iteration 19; round 3 not reached) |
| Commits on the branch | 27 squashed iteration commits + the setup commit + this report |
| Tags | `refactor-base` 15148b938 · `loop-1` f23927dd3 · `loop-2` 59fd42503 · `loop-3` 2cb932a46 · `loop-4` 162c55a2c · `loop-5` e79b60dbf · `loop-6` 187cf1f79 · `loop-7` 18f6cfd87 · `loop-8` 2df38cb46 · `loop-9` 1c7449386 · `loop-10` eabe13f85 · `loop-11` 80234eac8 · `loop-12` 8b17e951f · `loop-13` d9453f1da · `loop-14` 7a48c1213 · `loop-15` e103ff046 · `loop-16` 41d99e6f0 · `loop-17` 310a54b98 · `loop-18` 1dc57e36b · `loop-19` 1dc57e36b (no commits) · `loop-20` ea4db65d0 · `loop-21` e0a0670fc · `loop-22` 6d9236fa2 · `loop-23` 6b3c3b9fd · `loop-24` a15e8a52e · `loop-25` 0e0820263 · `loop-26` dabdb979e · `loop-27` b0b5bec1a · `loop-28` f417f1ca1 |
| Why the loop ended | **MAX_ITER** three times: at iteration 12 (20 open), at iteration 21 (26 open) and now at iteration 29 with **one** task open (T-254) and 30 awaiting the user |
| Tasks | 116 in PLAN.md: **81 DONE, 1 OPEN, 30 BLOCKED** (behaviour changes or surface removals awaiting the user), 4 WONTFIX-AUTO · 0 in TRIAGE.md |
| Diff since BASE | 122 files, +6,578 / −1,551 lines (49 test files: +5,182 / −472; 73 production files: +1,396 / −1,079) |

### Coverage (scoped statements, the ratchet)

| | BASE | Final (loop-28) |
|---|---|---|
| Backend | 92.79 % (3498/3770) | **98.04 %** (3760/3835) |
| Frontend | 87.94 % (1467/1668) | **89.30 %** (1487/1665) |

Per-loop ratchet: BE 92.84 → 92.86 → 93.27 → 93.29 → 93.30 → 93.55 → 93.60 ×4 → 93.68 → 93.71 → 95.93 → 96.01 → 96.36 → 96.42 → 96.44 ×2 → (no change) → 96.55 → 96.55 → 96.88 → 97.63 → 97.73 → 97.73 → 98.04 → 98.04 → 98.04; FE 87.94 → 87.96 ×6 → 88.82 → 88.99 → 89.03 ×7 → 89.04 ×2 → 89.06 ×2 → 89.30 ×7. Uncovered backend statements fell from 272 to 75; uncovered frontend statements from 201 to 178. The ratio dipped four times when duplicated covered code was deleted or a new cleanup branch was added (iterations 6, 8, 13 and 22) and was restored each time with behaviour-asserting tests, never by re-baselining. Iteration 25 removed one covered alias statement with no real offset (the worker's offset tests targeted lines a subset run reported as missed that the full run already covered); the printed two-decimal metric stayed level and iteration 26 added the margin back.

### Other metrics

| | Before (BASE) | After (loop-28) |
|---|---|---|
| Backend tests | 19,831 passed, 0 failed, 1 skipped | 20,225 passed, 0 failed, 1 skipped |
| Frontend tests | 8,969 passed, 0 failed | 9,030 passed, 0 failed, 1 skipped |
| known_broken | 0 | 0 |
| Golden probes | 11 recorded | 11/11 matching at every verification |
| SURFACE.md | — | 30 names added, one public def renamed (`project_filing.find_item` → `find_item_by_key`), 3 exception-class lines show a new base; `utcnow` was made public (T-034) and removed again (T-228) within the campaign; nothing that existed at BASE was removed |
| Static gates | ruff, eslint, tsc, i18n parity clean | clean |
| ruff C901 in scope | `suggest_projects_for_filename` 12, `_rename_item_locked` 12 | 5, clean |
| `project_filing.py` coverage | 93 % | 100 % |
| `project_files.py`, `project_tags.py`, `routes/projects_pdm.py` | 97 %, 100 %, 100 % | 100 %, 100 %, 100 % |
| Route-level `try/except → HTTPException` copies | 12 in project_files, 4 in aito_project_links, 2 in projects_pdm | one context manager per router |
| Hand-written duplicates removed since the second exit | — | "Item Rn" label ×5, `RevisionRef` constructor, sha256 loop, LIKE-escape ×3, `delete_project` 409 pair, `actor_class/actor_name` pair ×5, `utcnow`, `_committing_trash`, `_committing` alias, lazy `User` import, `_SliceJobError.__init__`, `reachesDocument` ×3 |

## User-approved behavior changes

**None.** The user did not answer any approval request during the campaign (30 are pending, below). BASELINE-CHANGELOG.md gained twenty *sanctioned* entries this campaign, none of them behaviour changes:

- T-193 `project_suggestions.similar_projects` · T-198 `project_reslice.load_pipeline` / `prepare_reslice` · T-203 `components/projects/files/revisionLabel.ts`
- T-027 `snapshots/pdm-i18n.golden` re-recorded after deleting three never-referenced `projectsPdm` keys from all 15 locales (no rendered string changed)
- T-035 `project_files.upload_basename` · T-034 `clean_item_name` / `name_key` / `fresh_item` / `utcnow` · T-037 `find_item` / `find_revision` · T-036 `services/http_status_error.HttpStatusError` as the base of `ProjectFilesError`, `LinkError`, `PrintTraceError`
- T-044 `components/projects/projectQueries.ts` (`projectKeys`, `useProjectTree`, `useProjectOrders`) · T-045 `useInvalidateProjects` · T-042 `dialogStyles.ts` (`OVERLAY_CLS`, `DIALOG_CARD_CLS`, `RADIO_ROW_CLS`, `stopDrag`) and `DialogShell.tsx`
- T-197 `aito_project_links.revision_added_payload` · T-201 `project_tags.unique_clean_names` · T-204 `DropShield.tsx` · T-205 `files/CollapsibleHeader.tsx`
- Third run: T-227 `project_files.revision_label` · T-228 `utcnow` removed in favour of `utils.local_time.utcnow_naive` (surface modification) · T-231 `project_files.revision_ref` · T-236 `revision_file_path` made public · T-241 `project_filing.find_item` renamed `find_item_by_key` (surface modification)

Also new but outside the SURFACE scan: `services/actor.py` (now also `record_as`), `services/db_quiet.py`, `utils/sql_like.py`, `hooks/useDebouncedValue.ts`.

## What each round found

- **Round 1 (setup, 2026-10-09):** 32 filed — cleanliness 20 (T-187…T-206), security 1 (T-207), tests 5 (T-208…T-212), robustness 6 (T-213…T-218, four held for approval). Plus the 35 campaign-24 triage entries promoted as OPEN and the 13 unanswered campaign-24 approvals re-filed as BLOCKED (T-174…T-186).
- **Round 2 (after loop-18, 2026-10-10):** 36 filed — security 3 (T-219…T-221; T-219 held), robustness 5 (T-222…T-226, all held — T-222 is a HIGH: printer-card upload-and-print of a `P-code` file is auto-filed and then refused by the queue), cleanliness 19 (T-227…T-245; mostly duplication exposed by the earlier refactoring), tests 9 (T-246…T-254; T-252 held). The cleanliness and tests auditors returned thin first passes and were resumed with read-in-full lists. 29 workable; iterations 20–28 worked 25 of them, two were closed WONTFIX-AUTO (T-238, T-245), one was held for approval by the orchestrator (T-220), one remains open (T-254).
- **Round 3:** not reached (the cap was hit with a task still open each time).

## Findings by auditor (PLAN.md, `plan.py stats`)

| Auditor | In plan | DONE | OPEN | BLOCKED | WONTFIX-AUTO |
|---|---|---|---|---|---|
| audit-cleanliness | 66 | 59 | 0 | 5 | 2 (T-238, T-245) |
| audit-robustness | 21 | 2 | 0 | 18 | 1 (T-068) |
| audit-tests | 21 | 18 | 1 | 1 | 1 (T-210) |
| audit-security | 8 | 2 | 0 | 6 | 0 |

Triaged this campaign: **0** (TRIAGE none). TRIAGE.md is empty.

## What was done (81 tasks, by iteration)

1. **loop-1** T-208 API-key permission matrix for every project route · T-187 `_TrashGuard` / `_committing_trash` · T-190 `load_tree` split with a full `model_dump` pin.
2. **loop-2** T-193 shared similar-project scan · T-198 `prepare_reslice` / `load_pipeline` out of the route · T-203 one `revisionLabel` helper at 12 sites.
3. **loop-3** T-207 `_revision_file_path` symlink + containment guard on revision reads · T-209 route sweep with 28 anonymous-401 cases · T-010 filing failure-branch tests.
4. **loop-4** T-018 rename-back when a case-only rename fails halfway · T-019 `_restore_and_rollback` always rolls back · T-022 `backend/tests/project_fixtures.py` (−390 lines across 11 test files; absorbed T-206, T-074, T-023).
5. **loop-5** T-030 three suggestion passes share one ranker · T-032 fork copies use `_WrittenFile` + `_cleanup_written` · T-027 three dead i18n keys removed.
6. **loop-6** T-033 one module-level `to_absolute_path` import · T-035 `upload_basename` · T-034 four cross-module helpers made public · coverage follow-up.
7. **loop-7** T-038 `MoveToProjectResult.revisions()` · T-037 `find_item` / `find_revision` · T-036 `HttpStatusError` base.
8. **loop-8** T-039 one OpenRouter error mapper · T-040 `is_resliceable` delegates to `is_3mf` · T-041 `useDebouncedValue` hook · coverage follow-up (15 component tests).
9. **loop-9** T-043 `noOrderNeeded` · T-044 `projectKeys` + query hooks · T-042 shared dialog shell, class constants and `stopDrag`.
10. **loop-10** T-053 unused parameter · T-048 `URL.createObjectURL` descriptors restored after the export test · T-045 `useInvalidateProjects`.
11. **loop-11** T-071 `_usage_selects` (compiled SQL pinned byte-for-byte) · T-054 unreachable post-read size check removed from `project_snapshot._read` (lying-header zips pinned) · T-055 closed as a duplicate of T-048.
12. **loop-12** T-075 public `required_name` validator · T-085 shutdown-cancel pins for add-files / rename / fork · T-073 `bearerAuthHeaders` in `postForBlob` / `uploadSpoolsCsv`.
13. **loop-13** T-188 `_remove_empty` in the add-revision undo · T-089 actor-name lookup pins · T-087 absorbed by a loop-8 test · coverage follow-up (7 attachment/archive/queue route tests, +83 statements).
14. **loop-14** T-192 `_legacy_candidates_query` shares the legacy-file filter (SQL pinned on sqlite and postgresql) · T-189 keyword-only `_apply_snapshot` · T-191 `_CommitGuard` takes the factory signature, `_committing` kept as an alias.
15. **loop-15** T-195 `_link_errors` context manager · T-196 `services/actor.py` (`actor_user_id` / `actor_name` / `actor_class`) · T-194 `services/db_quiet.rollback_quietly` at the three guarded sites.
16. **loop-16** T-199 module-top imports in `project_reslice` · T-200 `ProjectFilesError.stored_count` annotation (a golden pins that a fresh error has no such attribute, so no default) · T-197 `revision_added_payload` at four sites.
17. **loop-17** T-201 `unique_clean_names` for the three tag loops · T-204 `DropShield` · T-202 blocked (see below).
18. **loop-18** T-205 `CollapsibleHeader` · T-211 merge copies deliveries as-is (real, dangling and deleted-project cases pinned) · T-212 fr-locale render tests.
19. **loop-19** no commits: T-217 and T-218 blocked for approval at selection.
20. **loop-20** T-248 reuse-row re-check 409 pinned (deleted / trashed / filed / moved) · T-230 `_file_errors` context manager across the project-file routes · T-244 `projectKeys` factories at the remaining hand-written sites.
21. **loop-21** T-249 "links never queue a Zoho push" pinned for unlink, create-from-task, deliveries and drop (a merge *does* queue one — pinned the other way) · T-250 "stream to disk before any DB write" pinned for `add_files_to_revision` and `add_revision_from_sources` (the drop path commits its item row first — pinned as-is) · T-251 `NewProjectModal` tests (6).
22. **loop-22** T-227 `revision_label(item_name, number)` at five sites · T-228 `utcnow` → `utils.local_time.utcnow_naive` · T-221 `_open_claimed` reopens the O_EXCL-claimed placeholder with `O_NOFOLLOW`, `_copy_claimed` replaces `shutil.copy2` in fork copies · coverage follow-up (cleanup branch, cover-image-gone 404, project queue).
23. **loop-23** T-229 `_TrashGuard` constructed directly · T-231 `revision_ref` public, used by `orders_for_project` · T-232 `project_filing` hashes through `library.calculate_file_hash` (+ BOM list/create and template tests).
24. **loop-24** T-233 `utils/sql_like.escape_like` (projects_pdm search; library and usage_tracker delegate) · T-234 `_refuse_if_in_use` for `delete_project`'s pre- and post-flush 409 checks · T-235 `services/actor.record_as` at five `aito_events.record` sites.
25. **loop-25** T-236 `revision_file_path` public · T-237 `_committing` alias gone · T-238 closed (frozen probe reads the aliases).
26. **loop-26** T-241 `find_item_by_key` · T-240 `library_tags._name_key` delegates to `tag_name_key` · T-239 `_rename_item_locked` → `_move_item_folder` + `_repoint_file_paths` (+ 5 PATCH scalar-field tests).
27. **loop-27** T-242 module-level `User` import · T-243 `_SliceJobError(HttpStatusError)` with str/args/repr pinned · T-245 closed (dialogs differ observably).
28. **loop-28** T-246 `test_http_status_error` pins behaviour instead of MRO tuples · T-253 shared `reachesDocument` in `frontend/src/__tests__/dragHelpers.ts` · T-247 `CardProjectChips` drop tests wait on an `AuthLoaded` probe and prove refusals with a synchronous spy instead of sleeps.

## Tasks left for humans

### BLOCKED — awaiting the user's approve/decline (30)

Read any record with `python tools/plan.py show T-xxx`; the digest with every `user-visible change:` fragment is in `plans/refactor-campaign25/c25-approvals.md`. Five were blocked by the orchestrator rather than an auditor: **T-028** (delete the public `legacy_migration_status_running()` — a SURFACE removal), **T-069** (coalesce the project-codes refetch into the existing debounce — fewer, later refetches), **T-202** (`formatFileSize` prints "1.0 GB" where `formatSize` prints "1024.0 MB"), **T-220** (closing the check-then-open window on revision downloads means serving from a file descriptor through a `StreamingResponse`, which drops `Content-Length`, `ETag`/`Last-Modified` and HTTP Range support), and the behaviour notes on **T-223 / T-224 / T-226** were written by the orchestrator.

Round-2: **T-222 (P1)** printer-card upload-and-print of a P-code file is auto-filed then refused with a 400 · T-219 library by-id download/slicer/gcode routes bypass the symlink guard · T-220 check-then-open window · T-223 unguarded rollback after a partial drop · T-224 best-effort undo in `_CommitGuard` · T-225 upload note length cap · T-226 zip download racing a delete · T-252 production seam for the rename-failure tests.
Carried from before: T-174 API-key auto-filing permission · T-175 pending-upload auto-filing permission · T-176 move-to-project partial failure · T-177 drop partial failure · T-178 dead re-export · T-179 plain `db.commit()` at three sites · T-180 byte-based path caps · T-181 abandoned intermediate on reslice · T-182 concurrent same-name create → 409 · T-183 `_delete_item_locked` post-flush re-check · T-184 chunked upload cap · T-185 bounded commit wait · T-186 PostgreSQL row locks · T-213 `remove_file` post-lock re-check · T-214 task re-check in deliveries/link · T-215 merge copies print traceability · T-216 `storage_dir` fixed once · T-217 concurrent tag creation → 500 · T-218 orphaned `.part` uploads.

Approve with `python tools/plan.py set-status T-xxx OPEN --iteration N --reason "user-approved behavior change"`, decline with `set-status T-xxx WONTFIX-AUTO`.

### OPEN — workable, out of iteration budget (1)

- **T-254** (P3 tests) `MoveToProjectModal` toast severity is asserted via Tailwind icon class names rather than a role or label.

Resume in the same worktree: raise MAX_ITER and run the loop again (strip this report commit first with `git reset HEAD~1`; FINAL_REPORT.md is a tracked file on main, so the reset leaves it modified — restore it with `git checkout -- FINAL_REPORT.md`). A round 3 survey is still available under MAX_ROUNDS 3.

### WONTFIX-AUTO (4)

- **T-210** force-sync panel test — Aito board code, outside this campaign's scope.
- **T-068** `run_reslice` idle-in-transaction during slicing — the transaction is opened by `routes/library.py::_run_slicer_with_fallback` (shared with File Manager slicing, out of scope). **Lead for a library.py campaign.**
- **T-238** the two `SIMILAR_*_THRESHOLD` aliases — the frozen `pdm-rules` golden probe (`tools/probe_pdm_rules.py`) reads them by name; delete them once the probe reads `SIMILAR_NAME_THRESHOLD`.
- **T-245** one `DialogShell` for `PrintRevisionPicker`, `MoveToProjectModal` and `NewProjectModal` — `NewProjectModal` renders inline (no portal) with no backdrop click or form `stopPropagation`, `MoveToProjectModal` has its own card class and attribute order; a shared shell cannot be byte-identical. Align the three dialogs deliberately first (UI decision), then share the shell.

## Leads recorded by workers and auditors (not filed)

- `print_from_revision` and `_make_thumbnail` still read revision bytes without `revision_file_path`; the scheduler's print-dispatch read follows the library by-id path (see T-219).
- A copy failure during auto-filing or move leaves the `find_or_create_item` item behind, empty (judged a normal state by the round-2 robustness auditor); `drop_files_on_task` commits its item row before streaming (pinned as-is by T-250).
- `load_tree(item_ids=…)` would stop every mutation reloading the whole tree (changes which usage checks run).
- `drop_files_on_task` sets `stored_count` on any exception though only the ProjectFilesError branch reads it; `AitoTaskDelivery.revision_id` and `AitoTask.linked_project_id` have no FK, so merges carry dangling references.
- `schemas/printer_location.py` has its own `_required_name`; `routes/aito.py` has its own `_actor`, `"user" if actor else "system"` and `_rollback_quietly`; other `user.id if user` copies live in library_variants, scheduled_dryings, library_folder_access, cloud, slicer_presets; `core/auth.py` and `model_providers/manyfold` still inline the LIKE-escape chain (all out of scope).
- `project_filing` ↔ `aito_project_links` import each other (one direction lazily); `project_files` ↔ `project_print_trace` likewise (the `revision_label` import is lazy for that reason); `routes/library.py::_run_slicer_with_fallback` holds a transaction open during the slice.
- `utils/file.formatFileSize` prints "512.0 undefined" for 0 < bytes < 1 (bug in an out-of-scope file).
- `pages/FileManagerPage.tsx:2575` and `pages/ProjectsPage.tsx` (unguarded `localStorage` read) are upstream files left alone; the radio rows differ only by `min-h-[40px]` vs `[44px]` (UI decision); `DeliveriesPicker` has its own `z-[60]` backdrop.
- Remaining `root` / `_project` / `_engine` fixture copies in test_aito_project_links_api, test_file_manager_hides_project_files, test_project_storage*, test_aito_project_links_schema, test_print_trace_queue, test_project_pdm_migration.
- Thin tests noted by verifiers: `NewProjectModal.test.tsx` "does not navigate" uses a substring `toHaveTextContent('/')`; `test_projects_api.py` unknown-priority PATCH test does not re-read the project; `test_project_tags_service.py:144` only checks tags unchanged; `CardProjectChips.test.tsx` restores its `getOrderProjectLinks` spies at test end rather than in `afterEach`.
- `_project_name_suggestions`'s empty-name guard is unreachable; `_require_reuse_rows_unchanged` branch 417→415 is partial.

## Lessons for the loop machinery

- Deleting duplicated *covered* code shrinks the ratchet denominator; from iteration 14 on, workers were told up front to pair every deletion with behaviour-asserting tests on currently-uncovered lines in the same commit. A NEW cleanup branch (`except BaseException: os.close(fd); raise`) counts the same way (iteration 22). Moving code out of the scope globs (a hook into `hooks/`, helpers into `services/actor.py` or `utils/`) has the same effect.
- Offsets must target lines the FULL scoped run reports as missed (`coverage-pdm-backend.json` from the last verifier); a subset run reports lines as missed that other test files cover (iteration 25).
- A verifier that runs the full suite concurrently with both coverage scripts drives the load average to ~27 and takes seven hours (iteration 25); run the suite first, then coverage. Verifier helper loops that `pgrep -f "coverage_pdm.sh backend"` match their own command line and never exit — kill them.
- `plan.py select` marks its picks IN_PROGRESS; a second `select` in the same iteration skips them — reset the extras with `set-status OPEN`.
- The cleanliness and tests auditors return thin first passes; resuming them with an explicit read-in-full list is what produces the real survey.
- zsh: backticks inside a double-quoted `git commit -m` are command-substituted (use `-F -` with a heredoc); an unquoted `--include=*.py` fails silently under `2>/dev/null` and reports "no references". `tools/gen_surface_pdm.sh` prints to stdout; redirect it into SURFACE.md.
- Never set `COVERAGE_FILE` with pytest-cov + xdist; clear stray `.coverage.*` before the ratchet combine; a test parameter computed as "tomorrow" at collection flakes across midnight.
- FINAL_REPORT.md is tracked on main (campaign 24's report came in with its merge), so an EXIT-THEN-RESUME `git reset HEAD~1` leaves it modified rather than untracked.

## Preserved state

Every untracked loop file was copied to `plans/refactor-campaign25/` in the main checkout before this report was written: PLAN.md (and the campaign-23/24 archives), TRIAGE.md, BASELINE.md, BASELINE-CHANGELOG.md, VERDICTS.log (30 verdicts, three of them FAIL-then-PASS pairs), the round-1 and round-2 `findings-audit-*.json` (including the auditors' first-pass files), the already-filed lists, the per-iteration batch files, the pending-approval digest (`c25-approvals.md`, now with the orchestrator-blocked section) and the first two exits' reports (`FINAL_REPORT.campaign25-exit1.md`, `FINAL_REPORT.campaign25-exit2.md`).
