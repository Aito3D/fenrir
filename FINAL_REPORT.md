# Refactor loop — final report, campaign O5 (the order page)

Date: 2026-11-20 · Branch `auto-refactor-loop` · Based on main `bc5d2f08a` · BASE tag `refactor-base` (`1b5e4b3b8`)

## Outcome

- **Why it ended:** MAX_ITER (8 iterations run, cap 8). Not converged: 8 low-priority tasks remain open.
- **Iterations:** 8, all verified PASS by a blind verifier (iteration 1 needed a second pass, see below).
- **Survey rounds:** 2 of 3.
- **Commits:** 8 squashed iteration commits + the setup commit + this report. Tags `loop-1` … `loop-8`.
- **Tasks:** 32 filed · 21 DONE · 8 OPEN · 3 closed without change.
- **Diff vs BASE:** 22 files, +841 / −32 (mostly tests).

## Scope

`backend/app/api/routes/order_board/*.py`, `frontend/src/components/orders/**`, `frontend/src/pages/OrderBoardPage.tsx`, plus their tests.

Seven files were hands-off for the whole campaign because the primary checkout had uncommitted edits to them; none was touched:
`OrderBoardPage.tsx`, `OrderCard.tsx`, `OrderLineRow.tsx`, `OrderLinesPanel.tsx`, `orderBoard.ts`, `OrderBoardPage.test.tsx`, `OrderPackFlow.test.tsx`.

## User-approved behaviour changes (from BASELINE-CHANGELOG.md)

| Task | Where | What the operator sees now |
|---|---|---|
| T-090 | `NewOrderLines.tsx` | Removing a cart line no longer erases an item added or scanned during the 200 ms fold-out. |
| T-091 | `OrderPaymentBlock.tsx` | A failed status check on a card-terminal charge keeps "charge in progress" on screen and keeps polling. |
| T-116 | `OrderPaymentBlock.tsx` | Opening the terminal dialog when the charge lookup fails shows the live charge's waiting screen, or an error toast; never a fresh charge form. |
| T-115 | `useOrderFilters.ts` | Picking a filter before saved board settings have loaded no longer wipes the other saved settings. After a failed load, picks apply on screen but are not saved. |
| T-117 | `useOrderFilters.ts` | Filter saves reach the server in pick order. |
| T-119 | `board.py` batch prep sheet | An order that left the board mid-request is skipped (not stamped, not in the PDF); the rest print. Still 404 if none remain. |

Declined by the user: T-088 (item-search accent folding), T-101 (finished-order Zoho error text).

## What each survey round found

| Round | Security | Robustness | Cleanliness | Tests |
|---|---|---|---|---|
| 1 (code new since the previous campaign) | clean | 2 | 2 | 4 |
| 2 (whole scope, end to end) | clean | 5 | 9 | 10 |

Round 3 was not run (iteration budget spent).

## Findings by auditor

| Auditor | Filed | DONE | OPEN | Closed without change |
|---|---|---|---|---|
| audit-security | 0 | 0 | 0 | 0 |
| audit-robustness | 7 | 7 | 0 | 0 |
| audit-cleanliness | 11 | 4 | 4 | 3 |
| audit-tests | 14 | 10 | 4 | 0 |

**Triage:** 25 findings were first set aside as P2/P3 (round 1: cleanliness 1, robustness 1, tests 3; round 2: cleanliness 8, robustness 2, tests 10). The user asked for all 25 to be promoted, so `TRIAGE.md` is empty at exit and they are counted in the table above.

## Done, by iteration

| Tag | Tasks |
|---|---|
| `loop-1` | T-094 test manual-payment "amount above balance" refusal · T-090 · T-091 |
| `loop-2` | T-092 test order client-rating route · T-093 test sync refused while Zoho is busy |
| `loop-3` | T-095 tests for every order event kind |
| `loop-4` | T-115 · T-096 shared default-email helper for the two email routes · T-105 test refused cancel |
| `loop-5` | T-106 tests for the barcode scan hook · T-107 tests for the new-order client picker · T-108 tests for payment block error paths |
| `loop-6` | T-109 test SMS sent but recording failed · T-110 test quote/deposit PDF downloads · T-116 |
| `loop-7` | T-118 prep-sheet PDFs rendered off the event loop · T-119 · T-117 |
| `loop-8` | T-099 dangling comment removed · T-098 shared actor-name helper · T-097 existing open-link helper used |

## Metrics

| | Baseline | Final |
|---|---|---|
| Backend scoped statements (ratchet) | 99.04% (3421/3454) | 99.13% (3434/3464) |
| Frontend scoped statements (ratchet) | 95.79% (2074/2165) | 97.31% (2137/2196) |
| Backend tests passing | 29,138 | 29,146 |
| Frontend tests | 12,259 | 12,323 |
| Golden snapshot probes | 31/31 | 31/31 |
| SURFACE.md | — | unchanged |
| known_broken | 1 (time-of-day test in `test_printer_hours_migrations.py`, out of scope) | 1 (unchanged) |

Coverage is measured over the wider Order Board globs of `tools/coverage_orders.sh` (frozen), not only this campaign's narrower scope.

## Verification notes

- **Iteration 1, first verdict FAIL:** the T-090 cart fix is observable and had no changelog entry. The user had picked that bug for fixing; a changelog entry was added and the re-verification passed.
- **Load flakes:** full-suite runs on a busy machine produced failures outside the diff that all pass alone: frontend `OrderPackFlow` scan test, `ArchivesPage`, `StreamOverlayPage`, `useResliceJobs`; backend (one 26-minute run) `test_mfa_api` email matrix, `test_spoolman_api` unlink, `test_stock_alert_producer_2955`, two in `test_timelapse_clock_match`.
- Every iteration from the re-run of iteration 1 onward ran ruff, basedpyright (lock mode), typecheck, ESLint, knip, i18n parity and the frontend build.

## Left for humans

**OPEN (8, all low priority, none changes behaviour):**

- T-100 `board.py` module docstring describes only part of the module.
- T-102 `OrderSidePanel.tsx` double-submit guard for invoice creation is copy-pasted in two handlers.
- T-103 `useOrderFilters.ts` follow-key validation written twice.
- T-104 `OrderRefActions.tsx` needless type cast.
- T-111 `OrderMobileFilters.tsx` follow-up chips untested on the phone layout.
- T-112 `useOrderFilters.ts` `setFollow` and its persistence untested.
- T-113 `NewOrderLines` test has a redundant assertion; quantity edit and animation end unreached.
- T-114 real-time sleeps in several order tests (`useOrderActions`, `OrderPhoneTabs`, `OrderParcelEditFlow`, `OrderInvoicesBlock`, `OrderHandoverBar`) can pass vacuously under load.

**Closed without change (3):** T-088 and T-101 (behaviour change declined), T-089 (the four identical `money` closures can only be merged with a new exported name, which moves the frozen surface).

**Leads never audited (noted by workers and verifiers):**

- T-119 leaves a narrow window: an order that leaves the board right after its stamp is saved stays marked printed but is missing from the PDF.
- Reopening the terminal dialog fetches the current charge twice (on open and from the dialog's own polling).
- `OrderInvoicesBlock` `spend()` guard `if (!row.id || applyCredit.isPending) return;` is dead in practice (button disabled while pending, only rendered with an id).
- `NewOrderDraftRow`'s `onChange` writes a captured draft with a value-only setter; round 2 found no caller that loses a change, but the pattern is fragile.
- Security auditor's unfiled hygiene notes: a customer email containing `?` is not encoded in the operator's `mailto:` link.

## Working files

`PLAN.md`, `BASELINE.md`, `VERDICTS.log`, the auditor findings JSON and the briefs are untracked in the worktree and archived to `plans/refactor-campaign-orders-o5/` in the primary checkout.
