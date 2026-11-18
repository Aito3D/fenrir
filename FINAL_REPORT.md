# FINAL REPORT — refactor-loop campaign O3: the Order Board (/orders)

Campaign 1 on branch `auto-refactor-loop` (worktree `../bambuddy-refactor`), cut from main `2c8d80901` on 2026-11-16.
BASE `refactor-base` = setup commit `504291e00`. Ended 2026-11-17.

## Summary
- **Iterations run:** 11 of 12 allowed (loop-1 … loop-11), one squashed commit + one tag per iteration.
- **Survey rounds:** 3 of 3.
- **Why it ended:** MAX_ROUNDS. The plan was empty after round 3's tasks, and the round cap was reached.
- **Commits:** 1 setup commit + 11 iteration commits, plus this report.
- **Tags:** `refactor-base`, `loop-1` … `loop-11`.
- **Parameters:** scope = Order Board (routes/order_board/, services/order_board*, order_board_actions/, order_board_sync/, models order_board_*, components/orders/**, OrderBoardPage, OrderTrackPage, utils/orderTracking.ts, and their tests). MAX_ITER 12, MAX_ROUNDS 3, BATCH 3, auto, grouped, at-exit. TRIAGE was P2,P3 at the start and lowered to P3 by the user at the setup sweep.
- **Tasks:** 31 filed in PLAN.md, 29 DONE, 2 WONTFIX-AUTO, 0 OPEN or BLOCKED. 19 findings remain in TRIAGE.md.
- **Verifier:** every iteration passed. Iteration 1 needed one fix: its first verify failed the coverage ratchet arithmetically, because deleted dead code had been covered. Tests were added rather than resetting the baseline.

## Coverage, tests, goldens
| | Baseline (BASE) | Final (loop-11) |
|---|---|---|
| Backend scoped statements | 2815/2913 = 96.64% | 2912/2938 = **99.12%** |
| Backend scoped branches | 701/748 = 93.72% | (not reported per run) |
| Frontend scoped statements | 1554/1636 = 94.98% | 1578/1640 = **96.21%** |
| Backend full suite | 27969 passed, 1 known_broken | 28036 passed, 0 failed |
| Frontend full suite | 11397 passed, 3 load flakes | 11425 passed, 0 failed |

- **known_broken:** `test_printer_hours_migrations.py::test_migration_backfills_calibrated_at_from_offset` is unchanged. It is outside scope and fails between 14:00 and midnight local time.
- **Snapshot probes:** 8/8 match. Two goldens were re-recorded for approved changes: `orders-i18n` for T-003, and `orders-surface-py` for T-016 and T-021.
- **SURFACE.md:** one line changed. Line 215 lists the sync package's `__all__`, where `_stored_query` became `find_stored`. This is the user-approved SURFACE regeneration for T-021.
- **Diff since BASE:** 47 files, +1589/−191, mostly tests. Production code: 31 files, +180/−96, including 16 locale files.
- **Gates at the end:** ruff check and format clean, basedpyright in lock mode 0 errors, tsc, eslint with 0 errors (5 warnings that predate this campaign and sit outside scope), knip, and i18n parity across 16 locales.

## User-approved behavior changes (BASELINE-CHANGELOG.md)
- **T-003:** three refusal codes (`nothing_to_pack`, `unknown_package`, `unknown_picklist`) now show their own message in 16 locales.
- **T-016:** both preparation-sheet routes now require `orders:update`. The print controls are hidden from users without it.
- **T-017:** no Books re-read is sent inside the 429 back-off window after a write.
- **T-018:** the history line for an edited order shows the new total, and none if the re-read failed.
- **T-019:** a sync pass compares an order against the current stored copy, so an operator's own edit is no longer logged as "edited in Books".
- **T-020:** a sync pass that fails for a non-Zoho reason shows a short error on the board, and Refresh returns the board instead of a 500.
- **T-021 (SURFACE only):** a single `find_stored` helper replaces 7 copies of the lookup.
- **T-030:** one failing quote lookup no longer stops the whole pass. A deleted quote is remembered as having no number.
- **T-047:** a quote lookup that keeps failing is retried about once a day, and the warning names the order.
- **T-049:** a parcel edit whose Books call timed out but went through is recorded in the history.
- **T-050:** the order search box keeps fast keystrokes.
- **Declined by the user:** T-048, which would open the back-off window after a 429 on an invoice email.

## What each round found
- **Round 1 (setup):** 20 findings.
  - security 1 (T-016), robustness 4 (T-017 to T-020), cleanliness 7, tests 8.
  - Six were behavior changes, and all six were approved.
  - 14 went to triage, and 8 of those were promoted when TRIAGE was lowered to P3.
- **Round 2:** 21 findings.
  - security 0.
  - robustness 1: T-030 (high). A deleted quote froze the board.
  - cleanliness 9: 2 filed, 7 triaged.
  - tests 11: 8 filed, 3 triaged. One filed finding was a stamp-race test that could never fail.
- **Round 3:** 9 findings.
  - security 0.
  - robustness 4: T-047, T-049 and T-050 approved, T-048 declined.
  - cleanliness 2, both triaged.
  - tests 3: 2 filed, 1 triaged.

## Findings by auditor (PLAN.md, `plan.py stats`)
| Auditor | Filed in PLAN.md | DONE | BLOCKED | WONTFIX-AUTO |
|---|---|---|---|---|
| audit-security | 1 | 1 | 0 | 0 |
| audit-robustness | 9 | 8 | 0 | 1 (T-048, declined) |
| audit-cleanliness | 5 | 4 | 0 | 1 (T-026, no change: the seven mutations differ) |
| audit-tests | 16 | 16 | 0 | 0 |

T-002 (split `_rewrite_parcel`) counts as DONE with no change. T-001's dead-branch removal had already brought that function down to about 70 lines.

## Triaged (TRIAGE.md, for human review)
Campaign-wide, 27 findings were triaged at ingest: 14 in round 1, 10 in round 2 and 3 in round 3. 8 of them were promoted into PLAN.md, so 19 remain: 13 from audit-cleanliness and 6 from audit-tests. All are P3. Each has full evidence in TRIAGE.md. Read it with `python tools/plan.py --file TRIAGE.md render --iteration 11`, and move one into the plan with `python tools/plan.py promote <id> --iteration N` (the `--iteration` flag is required).

- **T-004:** `get_finished_order` repeats `_run`'s Zoho error mapping.
- **T-005:** `_order_for_payment` repeats the `_require_order` lookup. This one is largely resolved by T-021.
- **T-006:** OrderBoardPage is one ~400-line component.
- **T-007:** OrderLinesPanel is one ~340-line component.
- **T-012:** some frontend order tests use fixed `setTimeout` waits.
- **T-015:** a parcel edit that completes the order records no `order.packed` event, and no test pins either outcome.
- **T-022:** the 429 window test is open-coded in 4 modules.
- **T-023:** the `ZohoRateLimited` → `open_rate_limit_window` handling is hand-rolled in 4 places.
- **T-024:** the private `actions._row` is used from `order_board_sms`.
- **T-025:** the `['order-board']` query key is redefined in several places.
- **T-027:** three edit bars share one submit skeleton.
- **T-028:** the refusal toast and invalidate code is repeated.
- **T-029:** ruff SIM105 in `_loop.py`.
- **T-038:** `_line_changes` with a renamed line is untested.
- **T-040:** the `orderEventDetail` money detail lines are untested.
- **T-041:** the `useScan` guards are untested.
- **T-042:** OrderTrackPage copies AitoTrackPage's timeout query and stage gate.
- **T-043:** `_with_unused` repeats the tolerant `_num`.
- **T-045:** the 429 quote test resets the window by hand.

## Left for humans
- **OPEN / BLOCKED:** none.
- **WONTFIX-AUTO:**
  - T-026: no change made. The seven mutations' callbacks differ, so a shared builder would need flags.
  - T-048: behavior change declined. A 429 on the invoice email opens no back-off window.
- **Notes from the verifiers and workers, not filed:**
  - T-034 pins what happens if an order row vanishes mid-pass, a state production can't reach today.
  - T-050's in-flight guard ignores an outside navigation to the exact URL still in flight, within a few milliseconds.
  - The frontend full suite is very load-sensitive: 13 unrelated files flaked at load 70 and all passed alone.

## Preserved state
At the user's request, all untracked loop state is copied to `plans/refactor-campaign-orders-o3/` in the main checkout (gitignored). That covers PLAN.md, TRIAGE.md, BASELINE.md, VERDICTS.log, the findings JSON files and the two briefs.
