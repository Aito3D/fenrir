# Refactor-loop campaign 32 — final report

Scope: the Aito BOARD page + the Aito backend it calls. Branch `auto-refactor-loop-aito`, BASE tag `refactor-base-aito`
(cut from main 484da88b5). 2026-11-05 → 2026-11-06.

## Summary
- Iterations run: 12 (loopA-1 … loopA-12), one squashed commit + tag each. Survey rounds: 2.
- Exit reason: **MAX_ITER** (12). Round 2 filed new workable tasks, but iteration 13 exceeds the cap.
- Tasks: 51 filed, 35 DONE, 16 OPEN (all round-2 leftovers, two of them user-approved behavior changes).
- Diff BASE..HEAD: 66 files, +1490 / −797.
- Blind verifier: every iteration PASS; two iterations failed first (loopA-1: T-584 import slowdown + T-583 unapproved;
  loopA-6: T-587 unapproved) and passed after a fix-up / user approval.

## Gates at exit (loopA-12 verifier)
- Coverage (scoped statements): backend 98.82% (7619/7710 → 7630/7721) · frontend 94.38% (6015/6373) → 94.60% (6028/6372)
- Known-broken tests: none before → none after
- Snapshot probes: 35/35 match · SURFACE.md: changed only by sanctioned additive exports / one count change (below)
- Backend 25886 passed / 10 skipped; frontend 10695 passed. Lint, typecheck (tsc + basedpyright lock), knip, i18n, build clean.

## User-approved behavior changes (BASELINE-CHANGELOG.md)
- T-581 hand-made cards (no quote_id) ignore client-supplied quote number/total/url/date (no 422)
- T-583 board cards refresh due badge / age / heat on a minute tick and on tab-visible
- T-584 project version bump computed SQL-side (no lost update between background writer and PATCH)
- T-585 Extend quote no longer waits on a busy background payment-link pass
- T-588 TabletBoard uses useSnapPager (tablet WebKit check still owed)
- T-582 login `?next=` refuses backslash and control characters
- T-586 extend-quote failure toast carries the server reason on 409/502; 409 refreshes the board
- T-587 a repeated `?card=` link to the same card refetches board + trash before deciding
Re-baselines (additive internal exports): BoardColumnBody, moreMenuViewItems, useColumnSummaries (T-589), useHoverReveal
(T-592), useCardUrlMirror, useCardResolver, useNewFromProject (T-593); Permission.AITO_READ count 21→22 (T-604).

## Work done by iteration
1 T-581 T-583 T-584 · 2 T-585 T-588 T-589 · 3 T-590 T-605 T-606 · 4 T-607 T-609 T-612 · 5 T-613 T-582 T-586 ·
6 T-587 T-591 T-592 · 7 T-593 T-594 T-595 · 8 T-596 T-597 T-598 · 9 T-599 T-600 T-601 · 10 T-602 T-603 T-604 ·
11 T-608 T-610 T-611 · 12 T-614 T-615

## Findings by auditor (filed / DONE / OPEN; no BLOCKED or WONTFIX-AUTO)
- audit-security: 3 / 2 / 1 · audit-robustness: 7 / 5 / 2 · audit-cleanliness: 26 / 17 / 9 · audit-tests: 14 / 10 / 4
- verifier lead: 1 / 1 / 0. Triaged: 0 (TRIAGE: none).

## Resurvey rounds
- Round 1 (setup): 35 tasks (6 behavior changes approved at setup).
- Round 2 (after loopA-12): 16 new — cleanliness 9, tests 4, robustness 2 (1 behavior change), security 1 (behavior change).

## Left OPEN for humans / a later campaign
- T-630 [P2, user-approved] apply_retainers() folds a Books 429/timeout into "applied 0" (force sync says "refused", sweep keeps calling)
- T-629 [P3, user-approved] zoho `_seg` lets a client_id of "."/".." re-target Books contact paths
- T-631 [P3] extend_quote_expiry `_pass_lock.locked()` pre-check is racy (await before the lock) — follow-up to T-585
- T-625 [P2] useNewFromProject refusal branch untested · T-627 [P2] NotificationBell tests read rows before render (likely the loopA-11 flake)
- T-626 settleProject({refetchBoard}) unpinned · T-628 AitoDialogShell test no longer pins flex-col
- T-616 useDuplicateProject re-declares two queries · T-617 terminal_payment setQueryData written twice (+ PaymentLinkModal replaceBoardRow)
- T-618 startViewTransition recipe ×3 · T-619 NewProjectDrawer double onCreate (tests pin 6 args) · T-620 rating spec mentions removed GOOD_MIN_SETTLED
- T-621 record_manual_payment · T-622 _build_task · T-623 rate_invoices/read_client_rating · T-624 update_project — oversized

## Notes
- T-610 partial: AitoAiTextField negative tests still use 20 ms real sleeps (they wait on msw round-trips).
- Owed manual checks: tablet WebKit snapping (T-588); a live Books force sync to watch T-584's SQL version bump.
- Full loop state (PLAN.md, VERDICTS.log, BASELINE.md, findings JSON) copied to plans/refactor-campaign32/ in the main repo.
