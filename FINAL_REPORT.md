# Refactor loop — final report, campaign O6 (order code, wide)

Date: 2026-11-21 · Branch `auto-refactor-loop` · Based on main `ce593fab9` · BASE `f827bb26e` (tag `o6/refactor-base`)

## Outcome

- **Why it ended:** stopped by the user after iteration 6 ("stop now, merge all and clean"). Not converged, not at MAX_ITER (6 of 8 used).
- **Iterations:** 6, each verified PASS by a blind verifier. Tags `o6/loop-1` … `o6/loop-6`.
- **Survey rounds:** 2 of 3.
- **Tasks:** 18 filed in the plan · 17 DONE · 1 OPEN (T-143) · 8 in TRIAGE.md.
- **Diff vs BASE:** 25 files, +818 / −111 (mostly tests).

## Scope

The services and integrations under the order page: `zoho.py`, `heimdall.py`, `aito_{payment_links,terminal_payments,manual_payments,customer_credit,payment_documents,client_rating,events,tracking}.py`, routes `aito_payments.py`, `zoho.py`, `heimdall.py`; the order-board services, actions and sync; `OrderTrackPage`; plus O5's 8 leftovers on routes/order_board and components/orders. Out of scope: `aito.py`, `aito_quote_sync.py`. Seven files with uncommitted edits in the primary checkout were hands-off and never touched.

## User-approved behaviour changes (BASELINE-CHANGELOG.md)

| Task | Where | What the operator sees now |
|---|---|---|
| T-136 | `order_board_sync/_finished.py` | A finished order keeps its unused quote deposit after a re-read: "left to pay", payment caps and apply-credit are right again. |
| T-135 | `order_board_actions/create.py` | A new walk-in order is on the board (and in the create response) at once. |
| T-137 | `order_board_sync/_catalog.py` | The item-catalogue refresh re-checks the Zoho budget per page, resumes a cut-short sweep on the next pass, backs off 5 min after a real failure. |
| T-128 | `routes/heimdall.py` | Heimdall Test uses a typed URL only together with a typed token; never signs the saved key for a typed URL. |
| T-142 | `aito_payment_documents.py` | A settled link/terminal payment labels a board event of the same amount, else a summed one (board amount kept), else records its own event. Residual: a board amount below the settled one can still be told twice. |
| T-144 | `order_board_actions/create.py` | A counter order whose confirm and clean-up void both failed goes into the pending-void retry (then `order.void_failed`). |
| T-145 | `routes/order_board/payment.py` | A manual payment and a terminal charge on the same order are serialised; the second gets 409 "A payment is already in progress for this order". |

## What each survey round found

| Round | Security | Robustness | Cleanliness | Tests |
|---|---|---|---|---|
| 1 | 1 (T-128) | 3 (T-135..T-137) | clean (partial: machine load ~200) | 2 + 4 triaged |
| 2 | clean | 4 (T-142..T-145) | 3 triaged | 1 triaged |

## Findings by auditor (plan.py stats)

| Source | DONE | OPEN | Triaged |
|---|---|---|---|
| audit-security | 1 | 0 | 0 |
| audit-robustness | 6 | 1 (T-143) | 0 |
| audit-cleanliness | 0 | 0 | 3 (T-139..T-141) |
| audit-tests | 2 | 0 | 5 (T-131..T-134, T-138) |
| carried from O5 (survey) | 8 | 0 | — |

## Done, by iteration

| Tag | Tasks |
|---|---|
| loop-1 | T-129, T-130 payment-link failure tests · T-136 |
| loop-2 | T-135 · T-137 · T-120 board.py docstring |
| loop-3 | T-121, T-122, T-123 order panel dedupes |
| loop-4 | T-124, T-125, T-126 filter and cart tests |
| loop-5 | T-127 deterministic waits in order tests · T-128 |
| loop-6 | T-142 · T-144 · T-145 |

Orchestrator review sent three fixes back before verification: T-137 (restart-from-page-1 would never refresh a large catalogue), T-127 (microtask flush made msw-backed negatives vacuous), T-142 (exact-match rule double-listed summed passes; user chose the hybrid).

## Gates

- Coverage (scoped statements): backend 98.37% → 98.50% · frontend 97.35% → 97.67%.
- Snapshot probes: 31/31 matching (7 re-recorded at setup for post-O5 drift; `orders-http` re-recorded for T-136).
- SURFACE.md: unchanged.
- known_broken: the printer-hours time-of-day test, unchanged (passes outside 14:00-24:00).
- Load flakes seen and cleared by isolated reruns: PrintModal, FileManagerPage, StreamOverlayPage, ArchivesPage, OrderPackFlow, NotificationBell, timelapse_clock_match, oidc/mfa; `test_order_board_actions.py` fails when a run spans midnight (T-138).

## Left for humans

- **OPEN:** T-143 — order payments don't expire the cached client rating (approved, not worked).
- **TRIAGE.md:** T-131..T-134 (test gaps), T-138 (midnight test flake), T-139..T-141 (small dedupes). `plan.py promote <id> --iteration N` in a future campaign.
- Hands-off files' sleeps (`OrderBoardPage.test.tsx`, `OrderPackFlow.test.tsx`) were not reviewed.
