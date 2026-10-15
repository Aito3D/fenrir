# Refactor campaign 27 — final report (2026-10-16)

Scope: the Projects-as-PDM feature (fourth pass; follow-on to campaigns 24/25/26). Branch `auto-refactor-loop`,
worktree `/Users/paultheis/Documents/Code/bambuddy-refactor`, UPSTREAM `1e424e52f`, BASE `refactor-base` (= 9d7c23bd5,
an empty setup commit). Parameters: TRIAGE none · MAX_ITER 12 · MAX_ROUNDS 3 · BATCH 3 · MODE auto · COMMIT_STYLE grouped ·
MERGE_CADENCE at-exit.

## Numbers

- Iterations run: 12 (loop-1 … loop-12), all verified PASS by the blind verifier; 12 squashed commits on the branch;
  12 tags created (`loop-1` … `loop-12`).
- Survey rounds completed: 1 (round 1 at setup). The campaign exited on MAX_ITER before a resurvey, so no round 2/3
  and no dry-round decision was ever made.
- Why the loop ended: **MAX_ITER** (iteration 13 > 12) with 5 tasks still OPEN. Not converged.
- Diff BASE..HEAD: 62 files changed, 2453 insertions, 560 deletions.
- Tests: backend 20657 passed at BASE → 20732 passed (1 skipped); frontend 9100-odd → 9112 passed (1 skipped), 639 files,
  i18n parity on 15 locales. Known-broken: none before, none after. New test files: 2 backend integration files
  (archive Aito ids, legacy tags cap), 1 frontend fixture (authPermissions), 1 frontend test (ProjectDetailPageBomPrice).
- Coverage (scope-only statements, the ratchet): backend 3935/4010 = 98.13% → 4057/4131 = 98.21%; frontend
  1510/1682 = 89.77% → 1509/1678 = 89.92%. Never dropped at any tag (see BASELINE.md "Latest verified ratchet").
- Golden probes: 11/11 matching at every verification. Re-recorded under approval: `pdm-openapi.golden` (T-340, one
  description sentence). SURFACE.md: changed only as sanctioned — −`legacy_migration_status_running` (T-319),
  +`clear_task_print_trace` (T-336 re-baseline), +`TooManyNewTagsError` (T-333), `Permission.AITO_READ` 2→3 (T-334),
  −`ResliceRun`/`ResliceJobs` exports (T-339), +`ProjectSearchInput`/`ProjectOptionButton` (T-344). Every line has a
  BASELINE-CHANGELOG.md entry.
- Lint/typecheck/build: ruff, ESLint, `tsc -b`, `check:i18n` and `npm run build` (234 bundles, Safari 16 baseline) clean at
  every verification.

## Findings by auditor (plan.py stats, by_source)

| Source | Filed | DONE | OPEN | BLOCKED | WONTFIX-AUTO |
|---|---|---|---|---|---|
| audit-security | 4 | 4 | 0 | 0 | 0 |
| audit-robustness | 10 | 10 | 0 | 0 | 0 |
| audit-cleanliness | 20 | 15 | 5 | 0 | 0 |
| audit-tests | 7 | 7 | 0 | 0 | 0 |
| survey | 0 | 0 | 0 | 0 | 0 |
| **total** | **41** | **36** | **5** | **0** | **0** |

Of the 41 tasks, 21 were seeds carried from campaign 26 (T-312..T-332, all OPEN at its exit; 14 of them user-approved
behavior changes from 2026-10-11) and 20 came from the round-1 panel on 2026-10-13: cleanliness 13 (3 behavior_change),
robustness 3 (2), security 2 (2), tests 2 (0). All 7 round-1 behavior_change findings were approved by the user at setup.

Triaged this campaign: 0 (TRIAGE was `none`; TRIAGE.md was never created).

## User-approved behavior changes landed (BASELINE-CHANGELOG.md, 2026-10-13 → 2026-10-16)

Round-1 approvals (2026-10-13): T-335 reslice_intermediate marker · T-336 delete_task clears print traces · T-333 legacy
tags string capped at 20 new catalogue tags (422, same body as new_tag_names) · T-334 archive Aito ids need aito:read ·
T-338 'error' skip code reads as retry · T-339 ResliceRun/ResliceJobs unexported · T-340 merge_project docstring sentence.
Carried approvals (2026-10-11, campaigns 25/26): T-319 legacy_migration_status_running removed · T-320 project-codes
resync debounce · T-321 pending-upload auto-file permission gate · T-322 dropFiles re-export removed · T-323 255-byte
path components · T-324 item-name race → 409 · T-325 no-op (already implemented) · T-326 quiet rollback in drop
finisher · T-327 best-effort commit-guard undo · T-328 zip download skips vanished files · T-329 filesystem test seams ·
T-330 shared formatFileSize + unit-index clamp · T-331 tag-create race survives via savepoint · T-332 stale `.part` sweep
before streaming (24 h grace).
Per-iteration consequence approvals are recorded as addenda in BASELINE.md (iterations 1, 5, 6, 7, 8, 9, 10).

## Resurvey rounds

None ran (MAX_ITER reached first). Leads collected for a future round 2 (from workers; also in BASELINE.md addenda):
- test_project_files_service.py still patches `project_files.os.open`/`os.fdopen` process-wide (`_open_claimed` test),
  plus `Path.rmdir`/`Path.unlink`.
- ItemRow.tsx `(renaming ?? '')` fallback looks unreachable; ProjectHeader.tsx uncovered blocks 27-63 / 86-119 (subset
  runs only, unverified).
- list_project_archives still runs the AitoTask lookup when the ids are nulled.
- ProjectOrdersCard.test.tsx and dropZonePins.test.tsx replace useAuth outright; could take a "replace" mode on
  fixtures/authPermissions.ts. projectQueries.test.tsx builds its own QueryClient without retry:false.
- A startup sweep for stale `.part` files would need a hook in upstream-owned main.py (deliberately not done).

## Left for humans

OPEN (all audit-cleanliness P3, the large-component splits; never attempted, attempts = 0):
- T-346 RevisionBlock (~257-line body, 7 useState)
- T-347 MoveToProjectModal (~223-line body: two queries, a mutation, whole dialog)
- T-348 TaskProjectRow (~207-line body)
- T-349 ProjectListPage (~263-line body, 7 useState)
- T-350 ProjectDetailPage (1391 lines, 19 useState)
BLOCKED: none. WONTFIX-AUTO: none.

## Preserved state

Per the user's choice, every loop state file was copied to `plans/refactor-campaign27/` in the main checkout
(PLAN.md, BASELINE.md, BASELINE-CHANGELOG.md, VERDICTS.log, scope-brief.md, c27-worker-brief.md, c27-batch1..12.json,
findings-audit-*-r1.json, already-filed-c27-*.txt, PLAN.campaign23..26.md) — 30 files. The full per-iteration verifier
output is in VERDICTS.log there.

## Merge

Review branch `auto-refactor-loop` in `/Users/paultheis/Documents/Code/bambuddy-refactor` (based on UPSTREAM `1e424e52f`;
main has not moved since) and merge with `git merge auto-refactor-loop` from the main checkout, rebuild `static/`
(`cd frontend && npm run build`) and commit it deliberately, then `git worktree remove --force
/Users/paultheis/Documents/Code/bambuddy-refactor`, `git branch -D auto-refactor-loop`, and delete the `refactor-base`
and `loop-*` tags.
