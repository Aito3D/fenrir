# Refactor-loop campaign Q1 — the print queue — final report

Date: 2026-11-25 → 2026-11-26 · Branch `auto-refactor-loop-q1` · UPSTREAM `5ff727a4d` (main) · BASE tag `q1/refactor-base` (`1a43aeee4`)

## Outcome
- Campaign Q1 (first on this scope). 8 iterations, 2 survey rounds, 8 squashed commits, tags `q1/loop-1` … `q1/loop-8`.
- Ended on **MAX_ITER** (8 of 8), with 3 approved tasks still open. Round 3 was not surveyed.
- 23 of 28 planned tasks DONE and verified; 2 closed as duplicates; 3 OPEN; 6 parked in TRIAGE.md.
- Every iteration passed the blind verifier (iteration 2 on its second attempt: the first failed the basedpyright gate on three `rowcount` reads; fixed with `cast(CursorResult, …)`).

## Scope
`backend/app/api/routes/print_queue.py`, `services/queue_*.py`, `models/print_queue.py`, `schemas/print_queue.py`;
`frontend/src/pages/QueuePage.tsx`, `components/Queue*.tsx`, `PrinterQueueWidget.tsx`, `components/queue/**`, `utils/queue*.ts`; their tests.
`services/print_scheduler.py` was out of scope by the user's choice.

## User-approved behavior changes (BASELINE-CHANGELOG.md has the exact entries)
| Task | Change |
|---|---|
| T-010 | Drag reorder only in ascending position sort with Shortest-Job-First off |
| T-030 | Phone up/down arrows follow the same rule (hidden in descending sort) |
| T-011 | Reordering a filtered view keeps hidden jobs' positions (visible jobs reuse the positions they hold) |
| T-031 | Tied positions are nudged apart instead of falling back to 1..n |
| T-012 | Cancel, batch cancel and single delete are guarded writes; a job that started printing in the gap → 409 |
| T-032 | Stop is a guarded write; a job that finished in the gap → 409 and stays completed (the stop command is still sent to the printer first, as before) |
| T-033 | Single edit re-checks status before saving; a job that started printing in the gap → 409 |
| T-013 | `quantity` on POST /queue/ capped at 999 (0 or negative still treated as 1) |
| T-004 | `position` removed from the PATCH schema; a sent `position` is ignored (200), not rejected |
| T-005 | An ownerless batch needs `queue:update_all` |
| T-027 | Duplicate skips a job linked to an Aito task for a user without `aito:read` (duplicate route only) |
| T-014 | Bulk cancel continues past failures; a mixed result shows one new toast with both counts (16 locales) |

## Survey rounds
- Round 1: cleanliness 0 new + 2 triaged; security 3 new (all behavior changes); tests 0 new + 4 triaged; robustness 5 new (all behavior changes). 7 approved, 1 closed as duplicate (T-003 = T-013), 4 test items promoted.
- Round 2: cleanliness 0 new + 4 triaged; tests 2 new + 6 triaged; security 3 new; robustness 5 new. Found two half-applied round-1 rules (T-030, T-031) and no regression. 8 approved, 1 closed as duplicate (T-024 = T-030), 6 test items promoted.
- Round 3: not run (iteration budget spent).

## Findings by auditor (plan.py stats)
| Auditor | Filed in PLAN | DONE | OPEN | Closed as duplicate | Triaged at ingest |
|---|---|---|---|---|---|
| audit-security | 6 | 3 | 2 | 1 | 0 |
| audit-robustness | 10 | 9 | 1 | 0 | 0 |
| audit-tests | 12 (2 filed + 10 promoted) | 11 | 0 | 1 | 10 |
| audit-cleanliness | 0 | 0 | 0 | 0 | 6 |
16 findings were triaged over the campaign (cleanliness 6, tests 10); 10 were promoted and done, 6 remain in TRIAGE.md
(`plan.py --file TRIAGE.md render --iteration 8`; promote with `plan.py promote <id> --iteration N`, the flag is required).

## Metrics
- Coverage (queue scope, statements, full suites): backend 93.28% → 95.08%; frontend 80.58% → 84.94%.
- Tests: backend 30,165 → 30,220 passing; frontend 12,765 → 12,797 passing. 17 test files added or extended, +1,532 lines.
- Production diff: 19 files, +124 / −29 lines (16 of the files are the locale files, one line each).
- Golden probes: 38/38 matching at every verdict. Re-recorded under approved changes: queue-openapi, queue-schemas (T-013, T-004), queue-http, app-openapi-index (T-004), queue-i18n (T-014).
- SURFACE.md: two sanctioned changes (PrintQueueItemUpdate loses `position`; new key `queue.toast.bulkCancelledSome`).
- known_broken before → after: unchanged. `test_project_files_permissions.py::test_permission_matrix_covers_every_swept_route` still fails (out of scope; the primary checkout had an uncommitted edit to that file). `test_printer_hours_migrations.py::test_migration_backfills_calibrated_at_from_offset` is time-of-day dependent.

## Left for humans
OPEN, already approved by the user on 2026-11-26 (not worked: budget):
- T-028 hide `aito_task_id` in GET /bulk/printer-queues for users without `aito:read` (fix sits in `bulk.py`; user allowed that edit).
- T-029 cap the id lists of reorder, bulk update and create-batch at 500.
- T-034 Clear history skips a row that is no longer history.
Closed as duplicates: T-003 (of T-013), T-024 (of T-030).
TRIAGE.md (no behavior change, not promoted): T-001 dead `useKg` branch, T-002 stale TODO, T-015 dead `position` prop on SortableQueueItem, T-016 shared helper for the two cancel guarded writes, T-017 redundant inner except in queue_announcements, T-018 shared test fixture.

Not filed, needs a decision:
- T-027 covers only the duplicate route. Batch dispatch and PATCH `add_copies` still copy an Aito link without checking `aito:read`; neither has a per-copy "skipped" convention.
- `frontend/src/api/client.ts` still declares `position?` on PrintQueueItemUpdate (out of scope; harmless).
- The Aito MCP server's code is not in this repo: if its queue-reorder tool moves jobs through PATCH `position`, it stops moving them once this merges.
- T-031 edge: a tie nudged up by one can land on a position a hidden job holds.
- Tests pin outcomes, not each guard, where two guards overlap (edit route dispatch 409; duplicate printer-scope check).
- Unpinned: out-of-scope-printer 404 on edit, budget-failure rollback on duplicate, stop with no printer assigned.
- Frontend eager preload is at 289.3 KB of a 290.0 KB build budget (not caused by this campaign).
- The 15 non-English translations of the new toast were written by the worker and not proofread.

## Not verified
- The race fixes (cancel, delete, stop, edit) against a live scheduler on PostgreSQL: read by eye and covered by SQLite integration tests only.
- Dependency CVE scanners (pip-audit, npm audit, semgrep) in round 2.
- React rendering, auth-on behavior and billing are outside the golden probes; covered by unit tests and the verifier's reading of each diff.
