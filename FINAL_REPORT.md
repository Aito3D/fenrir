# Refactor loop — campaign 24 final report (Projects-as-PDM feature)

Campaign 24 · 2026-10-09 · worktree `../bambuddy-refactor`, branch `auto-refactor-loop` · BASE `refactor-base` = 7c347319e, cut from local main fd54f5560 (upstream merge of 2026-10-08).
Parameters: SCOPE = the Projects-as-PDM feature (backend `project_*` / `projects_pdm` / `aito_project_links` routes, services, models, schemas and the PDM hunks of shared files; frontend `pages/Project*Page`, `components/projects/**` and PDM hunks of `client.ts` and friends) · TRIAGE P3 · MAX_ITER 12, raised to 15 when the user said "continue" after the first exit · MAX_ROUNDS 3 · BATCH 3 · auto · grouped commits · merge at exit.

## Outcome

| | |
|---|---|
| Iterations run | 15 (`loop-1` … `loop-15`), every one verified blind and PASSED (iteration 5 needed one coverage follow-up) |
| Survey rounds | 3 of 3 |
| Commits on the branch | 15 squashed iteration commits + the setup commit + this report |
| Tags | `refactor-base`, `loop-1` ba166f5c6, `loop-2` a65b04b1f, `loop-3` 3a72a9908, `loop-4` 57c30ca64, `loop-5` daf174098, `loop-6` fc62fd250, `loop-7` efc50af68, `loop-8` 580222f11, `loop-9` d49866835, `loop-10` 162ba954e, `loop-11` 2d3570336, `loop-12` 676f2a2d4, `loop-13` 0461bc03e, `loop-14` 5aaae1ca9, `loop-15` 5cbd743b6 |
| Why the loop ended | first exit at iteration 12 on **MAX_ITER**; resumed with MAX_ITER 15; final exit on **MAX_ROUNDS** — the plan is empty and all three survey rounds are used |
| Tasks | 54 filed in PLAN.md: **41 DONE, 0 OPEN, 13 BLOCKED** (behavior changes awaiting the user), 0 WONTFIX · 35 more in TRIAGE.md |
| Diff since BASE | 43 files, +6,657 / −401 lines (≈5,000 of them tests) |

### Coverage (scoped statements, the ratchet)

| | BASE | Final (loop-15) |
|---|---|---|
| Backend | 90.00 % (3304/3671) | **92.79 %** (3498/3770) |
| Frontend | 75.14 % (1288/1714) | **87.94 %** (1467/1668) |

Per-loop ratchet: BE 90.74 → 90.94 → 91.19 → 91.66 → 91.99 → 92.23 → 92.51 → 92.52 → 92.55 → 92.55 → 92.60 → 92.64 → 92.70 → 92.76 → 92.79; FE 75.14 → 75.14 → 84.42 → 84.42 → 85.88 → 86.27 → 86.27 → 86.27 → 86.27 → 87.11 → 87.17 → 87.17 → 87.17 → 87.17 → 87.94. Totals shrank where duplicates were removed (loop-5, loop-6); the ratio never dropped except transiently in loop-5 (fixed in the same iteration).

### Other metrics

| | Before | After |
|---|---|---|
| Backend tests | 18,957 passed, 1 failed (macOS-only) | 19,203 passed, 0 failed |
| Frontend tests | 8,813 passed, 1 failed (load flake) | 8,948 passed, 0 failed |
| known_broken | 1 (`test_fd_limit_2883` macOS KeyError) | 0 (fixed on the test side, T-001) |
| Golden probes | 11 recorded | 11/11 matching at every verification |
| SURFACE.md | 1,680 lines | unchanged except two sanctioned additive exports (below) |
| Static gates | ruff, eslint, tsc, i18n parity clean | clean |
| Security scanners | semgrep, bandit, gitleaks, npm audit | no in-scope hits; pip-audit (round 3, against the venv) lists advisories for python-multipart 0.0.26, starlette 0.52.1, requests 2.32.5 — dependency manifests are outside this campaign's scope, fix versions unchecked |
| `move_library_files_to_project` complexity | C901 22 | 7 |

## User-approved behavior changes

**None.** The user did not answer any approval request during the campaign. BASELINE-CHANGELOG.md gained two *sanctioned additive exports* (not behavior changes): `aito_project_links.record_and_broadcast` (T-024) and `components/projects/files/useFileDropZone` (T-026).

## What each round found

- **Round 1 (setup):** 22 filed (tests 10, security 2, robustness 5, cleanliness 5) + T-001 by hand; 22 triaged; 4 held for approval.
- **Round 2 (after loop-7):** 15 filed (tests 6, security 1, robustness 8, cleanliness 3); 6 triaged; 5 more held.
- **Round 3 (after loop-12):** 16 filed (tests 5, security 1, robustness 5, cleanliness 2 + T-072); 7 triaged; 4 more held. Its 9 workable tasks were worked in iterations 13–15 after the resume.

## Findings by auditor (PLAN.md)

| Auditor | Filed | DONE | BLOCKED | Triaged (campaign-wide, by round) |
|---|---|---|---|---|
| audit-tests | 21 | 21 | 0 | 7 (3 + 1 + 3) |
| audit-robustness | 18 | 12 | 6 | 4 (2 + 2 + 0) |
| audit-cleanliness | 10 | 7 | 3 | 24 (17 + 3 + 4) |
| audit-security | 4 | 0 | 4 | 0 |
| survey (hand-filed) | 1 | 1 | 0 | — |

Triaged total this campaign: **35** (TRIAGE.md holds every one with full evidence; promote with `python tools/plan.py promote T-xxx --iteration N`).

## What was done (41 tasks, by iteration)

1. **loop-1** T-001 macOS `fds_by_type` test gated on `/proc/self/fd` · T-002 28-route permission matrix (112 cases, `test_project_files_permissions.py`) · T-003 restore-from-trash rollback tests.
2. **loop-2** T-013 `download_revision` temp zip removed in a `finally` (`_TempFileResponse`) · T-004 `run_reslice` failure branches (84 → 95 %) · T-005 `useResliceJobs` on real timers.
3. **loop-3** T-007 AI route 502/409 tests (`projects_pdm.py` 100 %) · T-008 route edge cases · T-006 `ProjectDetailPageActions.test.tsx` + panel refusal tests (page 48 → 92 %).
4. **loop-4** T-017 `allocate_code_number` takes the SQLite write lock before reading (race reproduced 20/20 → 0/40) · T-014 `_commit_through_cancel` keeps files when a cancelled commit lands (4 sites) · T-009 link-service branches.
5. **loop-5** T-024 `record_and_broadcast` shared by three fan-out sites, per-site failure drift preserved (19 pin tests) · T-021 deterministic waits in two tests · T-020 files-panel action contracts (files/** 90 → 98 %) · coverage follow-up (+13 statements).
6. **loop-6** T-025 `useFileActions` reuses `useAcceptsPrintable` · T-026 `useFileDropZone` for four drop zones, each site's quirks kept as parameters · T-029 `move_library_files_to_project` split (C901 22 → 7).
7. **loop-7** T-031 `_new_library_row` / `_point_row_at` for the three LibraryFile row sites.
8. **loop-8** T-046 pin of the pending-upload archive permission behavior · T-060/T-061 cancel-safe commits for add-files and rename.
9. **loop-9** T-062 cancel-safe fork commit (all 7 sites) · T-049 remaining cancel-then-fail cases · T-047 rename recorder in the panel test.
10. **loop-10** T-050 `postFormData` helper for the three upload methods (23 request-pin tests) · T-057 ProjectListPage pager/grid tests · T-058 ProjectLinkPicker tests (100 %).
11. **loop-11** T-063 an outside-cancelled commit task counts as "may have landed" (`_CommitTask`) · T-065 `set_deliveries` / `_delete_revision_locked` post-flush re-checks · T-059 move-result toast tests.
12. **loop-12** T-066 `delete_project` and `create_item` re-check each other after the write lock.
13. **loop-13** T-077 `_delete_item_locked` post-flush usage re-check (3 race tests) · T-078 `link_task` re-checks the project after flush · T-070 one `_committing` context manager owns the commit guard at all seven sites (73 pins unchanged).
14. **loop-14** T-079 `delete_project` clears only non-live-order links and re-checks live links after flush (the auditor's `status == 'deleted'` filter was not used: it would have stopped clearing orphan tasks' links, pinned by a control test) · T-082 / T-083 remaining delete-item race and add-revision IntegrityError cases.
15. **loop-15** T-084 fork name-collision cases · T-086 `DeliveriesPicker` tests · T-088 ProjectListPage filter / view-switch / modal tests (97 %).

## Left for humans

### OPEN
None.

### BLOCKED — behavior changes awaiting the user's decision (13)
Each needs an explicit approve/decline; `python tools/plan.py show T-xxx` prints the auditor's `user-visible change:` note.
- T-011 (security) API-key uploads skip the projects:update check when auto-filing by `P-0042_` prefix.
- T-012 (security) archiving a pending upload auto-files with no project permission check (current behavior pinned by T-046).
- T-015 (robustness) move-to-project aborts mid-loop on a non-OSError after earlier groups committed (would return 200 + skipped).
- T-016 (robustness) a file drop failing on a later group returns a bare error (would return the partial result).
- T-051 (cleanliness) delete the unused `inZone`/`isFileDrag` re-export from `dropFiles.ts` (export removal).
- T-052 (cleanliness) the same three commit sites as T-060/061/062 — **already done** by those tasks; approve or decline for the record.
- T-056 (security) cap path components by UTF-8 bytes (100 CJK chars = 300 bytes > ext4 NAME_MAX on the shop container).
- T-064 (robustness) retry/sweep the sliced intermediate when `_drop_intermediate` fails.
- T-067 (robustness) racing duplicate item create → 409 instead of 500.
- T-072 (cleanliness) `_delete_item_locked` post-flush re-check — **already done** by T-077 (filed with behavior_change=false by robustness); approve or decline for the record.
- T-076 (security) upload cap skipped when Content-Length is absent (chunked multipart spooled unbounded).
- T-080 (robustness) `_commit_through_cancel` waits forever for a commit that never completes (bound the wait).
- T-081 (robustness) the post-flush usage re-checks are SQLite-only; PostgreSQL needs row locks (and `print_queue.library_file_id ON DELETE CASCADE` hides a just-queued print from them).

### WONTFIX-AUTO
None.

## Leads surfaced by workers and verifiers (not filed as tasks)
- `_deleted_revision_is_used` short-circuits to False for a revision with no file rows, so a delivery on such a revision escapes the re-check (unclear whether such revisions can exist).
- `fork_revision` builds a `ProjectItem` directly, outside `create_item`'s project re-check (robustness round 3 judged it safe: the item lock + `delete_project`'s items guard cover it).
- Fan-out failure handling still differs across the three `record_and_broadcast` callers and `project_reslice`/`print_trace` (preserved on purpose; unifying = behavior change).
- The files-panel drop zones claim non-file drags and SectionBlock lets drops bubble, unlike the board zones (preserved; unifying = behavior change).
- `_drop_intermediate` failure leaves the sliced row in the File Manager for good (T-064).
- `project_snapshot.py` line 60 size check looks unreachable (T-054 triaged); routes `_item_out`/`_revision_out` 404 raises look unreachable.
- `useResliceJobs` has no injectable poll interval; its real-timer test file takes ~26 s.
- `aito_task_deliveries.revision_id` and `aito_tasks.linked_project_id` have no FK; `projects.id` has no AUTOINCREMENT, so SQLite can reuse a deleted project's id.
- A move-to-project group whose files all skip leaves its newly created item behind empty (pinned as current behavior).
- `client.ts`: `postForBlob`/`uploadSpoolsCsv` still inline the bearer header (T-073 triaged); an object `detail` renders as `[object Object]`.
- T-063 side effect accepted: shutdown cancelling a commit task before COMMIT leaves files with no rows.
- No startup sweep for stale download zips (they have no distinctive prefix).
- pip-audit advisories (see the metrics table) — out of scope here, worth a dependency bump.

## Verifier log (VERDICTS.log, one line per iteration)
1 PASS · 2 PASS (temp-zip subclass header-identical) · 3 PASS · 4 PASS · 5 FAIL on the ratchet arithmetic (dedup removed covered statements) → follow-up → PASS · 6 PASS (`npm run build` green) · 7 PASS · 8 PASS · 9 PASS (one out-of-scope load flake added to known_flaky) · 10 PASS (`npm run build` green) · 11 PASS · 12 PASS · 13 PASS (seven-site guard proven exception-identical by a scratch comparison) · 14 PASS (link-clearing UPDATE proven row-identical incl. orphan tasks) · 15 PASS.

## Lessons for the next campaign
- A dedup task on a well-covered file lowers the scoped ratio with zero lost tests; pair every dedup with a small coverage-adding test in the same iteration.
- The test auditor returns thin first passes (≈1 minute); resume it with an explicit read-in-full list — it returned 4 and 3 more findings that way.
- "Isolate this failure so the rest still runs" and "return the partial result" are behavior changes; "keep disk and DB consistent on a failure path" and "re-check after the write lock" were accepted by the verifier as bug fixes every time.
- Auditor-suggested filters can themselves be behavior changes (T-079): a worker that pins the current row set first catches it.
- macOS has no `timeout`; `/tmp` must be `.resolve()`d before `relative_to`; 204 responses carry `application/json` with an empty body.

## Preserved loop state
Copies of PLAN.md, TRIAGE.md, BASELINE.md, VERDICTS.log, BASELINE-CHANGELOG.md, the scope brief, the round briefs, all `findings-audit-*-r{1,2,3}.json` and the first-exit report (`FINAL_REPORT.campaign24-exit1.md`) are in the main checkout at `plans/refactor-campaign24/` (gitignored); the originals stay in the worktree until it is removed.
