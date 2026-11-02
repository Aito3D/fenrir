# Refactor-loop campaign H1 — Maintenance > Hours page

Branch `auto-refactor-loop-hours`, worktree `../bambuddy-refactor-hours`, based on UPSTREAM `851c46088`.
BASE = tag `refactor-base-hours` (setup commit `177dae4dd`). Run 2026-11-01 to 2026-11-02, concurrently with
campaign 31 (Projects pages) in `../bambuddy-refactor`, hence the `-hours` branch/tag names.

## Outcome

- **Why it ended:** the plan was exhausted after round 3, which is MAX_ROUNDS (3); iteration 8 was also MAX_ITER (8).
  Not converged: all three survey rounds filed workable tasks.
- **Iterations:** 8, all verified PASS by the blind verifier (iterations 5 and 8 on a second attempt).
- **Commits:** 9 on the branch (setup + one squashed commit per iteration) plus this report. Tags `loopH-1` … `loopH-8`.
- **Tasks:** 20 filed into the plan, 19 DONE, 1 BLOCKED (T-053), 0 OPEN, 0 WONTFIX-AUTO. 33 findings triaged.
- **Diff since BASE:** 47 files, +1257 / −188 lines; 866 of the added lines are tests (7 test files).

| Gate | At BASE | At exit |
|---|---|---|
| Backend scoped statements (routes + service) | 425/436 = 97.48% | 491/495 = 99.19% |
| Frontend scoped statements (hours components + hoursSeries.ts) | 899/985 = 91.26% | 904/985 = 91.77% |
| Golden probes | 11/11 | 11/11 |
| Backend suite | 25026 passed, 1 known-broken | 25057 passed, 1 known-broken |

Known-broken before → after:
- `test_json_gzip_middleware::test_already_encoded_json_is_not_recompressed`: failing → failing (out of scope; fixed on
  another branch, `4fc5e3d6f`).
- `test_printer_hours_migrations::test_migration_backfills_calibrated_at_from_offset`: clock-dependent at BASE (fails
  whenever local and UTC dates differ) → unchanged. Found by verifier 5. Triaged as T-051.

SURFACE.md changed only through approved entries: two `hour_events` unique indexes, the `hour_machines.retired_printer_id`
column and its migrations, the `NON_FK_ID_REFERENCES` line, `MAINTENANCE_DELETE` 2→3 / `MAINTENANCE_UPDATE` 6→5, the
exports `DAY_MS` and `isoDayFormatter`, and the helper `retire_machine_of_printer`.

## User-approved behavior changes (all recorded in BASELINE-CHANGELOG.md)

- **T-005** Hours write routes honour the caller's printer scope (422/404 for out-of-scope machines).
- **T-006** The Hours overview shows a restricted user only in-scope and retired machines with their readings/events.
- **T-007** Deleting a note needs `maintenance:delete`; follow-up: the note delete button follows `canDelete`.
- **T-017** `hour_events` gets partial unique indexes; a migration deletes existing duplicates (keeps the lowest id);
  `sync_events` treats a duplicate insert as already done.
- **T-018** Calibration's "same day" check uses the server's local date.
- **T-001 / T-002** Shared `isoDayFormatter` and `DAY_MS` exports (rendering unchanged).
- **T-020** The sheet import uses one query; more than 20000 readings → 422.
- **T-008** Caps: 500 entries per reading batch, 200 new machines per import, 100-char import keys.
- **T-024** Retired machines keep their last printer's scope (`retired_printer_id`); follow-ups: counted for the SQLite
  id seed, and `delete_printer` retires the machine first so it holds on PostgreSQL (a hunk in upstream `printers.py`).
- **T-037** A sheet import that collides with a concurrent write is retried once.
- **T-038** A concurrent insert of the same reading ends last-writer-wins instead of a 500 (approved after the fact;
  verifier 5 caught it). T-052 later reimplemented it as a dialect upsert inside the caller's transaction.
- **T-039** Reading-pass Save is disabled from the click through the save.
- **T-025** A restricted user colliding with a hidden machine's name gets "This machine name is not available".
- **T-026** Changing the fleet-wide reading interval needs unrestricted printer access (backend only, see follow-ups).
- **T-027** Two unused `maintenance.hours.*` keys removed from all 15 locales.
- **T-046** An import naming two new machines alike → 422 "Duplicate machine name".
- **Probe fix (2026-11-02):** `tools/probe_hours_api.py` pins its printers' `created_at` to local noon; the golden was
  time-of-day flaky at BASE.

Behavior-preserving tasks: T-012 (recalibration branch tests), T-052 (upsert joins the caller's transaction).

## What each survey round found

- **Round 1:** 23 findings. 10 filed (9 behavior changes, all approved, plus T-012), 13 triaged.
- **Round 2:** 17 findings. 5 behavior changes (all approved), 2 promoted from triage at the user's request
  (T-038, T-039), 12 triaged.
- **Round 3:** 13 findings. T-052 (P1, a flaw in T-038's savepoint on SQLite), T-046 and T-053 (both approved),
  10 triaged.

## Findings by auditor (plan.py stats; promoted triage items count under their auditor)

| Auditor | Filed into the plan | DONE | BLOCKED | WONTFIX-AUTO | Triaged (campaign-wide) |
|---|---|---|---|---|---|
| audit-security | 8 | 8 | 0 | 0 | 0 |
| audit-robustness | 8 | 7 | 1 | 0 | 7 (2 later promoted) |
| audit-cleanliness | 3 | 3 | 0 | 0 | 10 |
| audit-tests | 1 | 1 | 0 | 0 | 18 |

TRIAGE.md (copied to `plans/refactor-campaign-hours-h1/`) holds all 33 remaining triaged findings with full evidence;
promote one with `python tools/plan.py promote <id> --iteration N` (the flag is required).

## Left for humans

- **T-053 BLOCKED:** database-level unique machine names. Printer names are not unique and `_sync_machines` copies them
  onto machines, so a unique index would make every Hours request fail once two printers share a name or a new printer
  reuses a retired machine's name. Needs a design choice: a partial index on unlinked machines, disambiguated linked
  names, or unique printer names.
- **Follow-up (T-026 UI half):** hide the interval control for printer-restricted users. The frontend has no scope
  signal; it needs a flag on the current-user response (auth code, out of scope). Today such a user sees the control
  and gets the 403 as a toast.
- **Follow-up (T-024):** machines retired before this change, and machines whose printer is deleted by any path other
  than `delete_printer`, have no `retired_printer_id` and stay visible to all users.
- **PostgreSQL test harness:** `test_printer_hours_migrations.py` tests that drive a SQLite engine fail when
  `TEST_POSTGRES_URL` is set (3 at BASE, plus the new `test_retired_printer_column_is_added_once_without_backfill`).
  CI does not run that suite; `test_backend.sh --full` does.

## Triaged findings (titles; full evidence in TRIAGE.md)

P2:
- T-009 `PrinterHoursService._remind_once_a_day` has no test (same-day short-circuit and failure swallow)
- T-010 Scheduler loop test relies on a wall-clock sleep race and never exercises the reminder or stop path
- T-011 Hours API tests compare against the real `date.today()`; the midnight-crossing flake is unmitigated
- T-013 `_migrate_printer_hours_columns` PostgreSQL branch has no test
- T-014 HoursTab save-pass midnight refetch path, error toast and delete-confirm modals under-tested
- T-015 Nine Hours components have no dedicated test file
- T-019 `_migrate_printer_hours_columns()` backfill re-runs on every startup and marks newly uncalibrated machines calibrated
- T-031 The concurrent `sync_events` test can pass without the unique indexes or the IntegrityError handler
- T-032 `_migrate_hour_events_unique` and `_insert_event` are only tested on SQLite
- T-047 Retired-machine scoping is untested on set-readings and on add/delete note
- T-048 The import retry test simulates the collision, so it cannot show the retry reconciles with the concurrent row

P3:
- T-003 Rounded hours number formatter is copy-pasted in 4 files
- T-004 Eight `useMutation` hooks repeat the same onError toast and invalidation boilerplate
- T-016 HoursChart range/mode switching branches partly uncovered
- T-021 `save_readings()` can return an error after its readings and recalibration are already committed
- T-022 MachineEvents clears the typed note before the create request succeeds
- T-023 `ensure_hour_machines()` IntegrityError retry expires objects the caller loaded beforehand
- T-028 `import_readings` re-implements `upsert_reading`'s find-or-create logic inline
- T-029 HoursChart builds its own UTC formatters instead of using `isoDayFormatter`
- T-030 `save_readings` repeats the `_scoped_machine` scope check inline
- T-033 `test_batch_caps_entries_at_500` asserts the route's own 422 at the cap
- T-034 `test_import_batch_semantics` asserts the count of SELECT statements
- T-035 `machine_for_printer` ValueError branch and the `remind_if_due` empty-recipient branch are uncovered
- T-036 ReadingTimeline lines 16-17 and branch coverage of 72% are not exercised
- T-040 Sweep and reminder failures are logged without a traceback
- T-041 The retired-machine scope rule is encoded twice (Python helper and SQL coalesce)
- T-042 `_retire` docstring omits `retired_printer_id`
- T-043 Three different IntegrityError race-handling idioms
- T-044 Redundant `list()` copy in `update_machine`
- T-045 `_stage_import` mixes validation, machine creation and reading upsert
- T-049 `import_readings` and `update_settings` read `date.today()` directly; new tests inherit that clock dependence
- T-050 The one-save-per-click test can pass before a second POST arrives
- T-051 The known-broken `calibrated_at` backfill test is clock-dependent

## Verifier verdicts

| Run | Verdict | Backend | Frontend | Note |
|---|---|---|---|---|
| loopH-1 | PASS | 446/450 | 899/985 | T-005, T-012, T-017 |
| loopH-2 | PASS | 446/450 | 895/978 | T-006, T-018, T-001 |
| loopH-3 | PASS | 461/465 | 895/976 | T-020, T-007, T-002 |
| loopH-4 | PASS | 461/465 | 895/976 | T-008 |
| loopH-5 #1 | FAIL | 480/484 | 895/976 | T-024 missed `NON_FK_ID_REFERENCES`; T-038 unsanctioned |
| loopH-5 #2 | PASS | 480/484 | 895/976 | after the fix, the approval and the probe fix |
| loopH-6 | PASS | 485/489 | 904/985 | T-039, T-025, T-026 |
| loopH-7 | PASS | 485/489 | 904/985 | T-027 |
| loopH-8 #1 | FAIL | 486/490 | 904/985 | T-024 fails on PostgreSQL (ON DELETE SET NULL) |
| loopH-8 #2 | PASS | 491/495 | 904/985 | delete_printer retires the machine first; Hours tests run on PostgreSQL |

## Lessons

- A fix that turns a 500 under a race into success is a behavior change for this loop; gate it up front.
- On SQLite (pysqlite default mode) a savepoint opened after a commit with only SELECTs autocommits on release; use
  `INSERT … ON CONFLICT DO UPDATE` for upserts.
- Run the touched backend test files with `TEST_POSTGRES_URL` every iteration; the upgrade check alone missed T-024's gap.
- A new id column without a foreign key must be added to `NON_FK_ID_REFERENCES`.
- Only one coverage producer at a time per worktree.
