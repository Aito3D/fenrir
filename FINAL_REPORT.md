# Refactor loop — campaign O7: the order page (/orders)

Run 2026-11-22 → 2026-11-23 on `/refactor-loop:refactor-loop focus on order page`. Auto mode, defaults (MAX_ITER 8,
MAX_ROUNDS 3, BATCH 3, TRIAGE P2,P3, grouped commits, merge at exit).

- Worktree `../bambuddy-refactor-o7`, branch `auto-refactor-loop-o7`, cut from main `6672584de` (order quotes pushed).
- Names deviate from the skill defaults (user-approved): a peer session ran campaign RV2 (Revenue page) at the same time
  in `../bambuddy-refactor` with the default `refactor-base` / `loop-N` tags. O7 uses `o7/refactor-base` (setup
  `e770d4d83`) and `o7/loop-1` … `o7/loop-8`.
- **8 iterations, 3 survey rounds, 8 squashed commits + setup, 9 tags.**
- **Why it ended:** the plan was exhausted after iteration 8, and the RESURVEY cap check stopped it (round 3 = MAX_ROUNDS).
  The iteration budget (8/8) was spent at the same time. It did not converge: round 3 was still productive.

## User-approved behavior changes (BASELINE-CHANGELOG.md, 2026-11-22)
All are in the new quote **Undo** ("Annuler" after Accepté), which deletes the sales order in Books. That path had never
been run live.
- **T-149 + T-155:** Undo deletes only the order that this board's own accept / create-order click made. The board
  remembers it in a bounded in-process map, so after a restart Undo is refused. The accept and order responses carry
  `undoable`, and the notice's Annuler button follows it instead of the cached `has_draft_order`.
- **T-156:** Undo is refused (`undo_too_late`) while a payment link is pending or a terminal charge is pending or
  processing. The undo route holds the order's payment lock, and a held lock means `undo_too_late`.
- **T-159:** Undo is also refused when the last terminal charge is `needs_attention` (outcome unknown), or is paid but
  not booked in Books (`booking_status != "booked"`, which includes Heimdall's `not_booked`).
- **T-158 + T-160:** the order payment-link route takes the same per-order payment lock (409 `terminal_in_progress`
  when held), so creating a link and undoing can't overlap. Side effect: sending a link is refused while a terminal
  start or a manual payment holds that order's lock.
- **T-168:** a regression from T-158, found by the round-3 auditors. A pending link blocks Undo only once it was
  minted (it has a heimdall_id). A failed-mint placeholder no longer blocks Undo forever (nothing clears it when
  Heimdall isn't configured). A link being minted right now is still covered by the lock.
- Declined: **T-165**, moving the lock to `_common.py` and making `_made_here` public. It was renaming churn that would
  move SURFACE.

No golden was re-recorded for any of them, and SURFACE.md never moved. The new `undoable` key is not in a response model.

## What each survey round found
- **Round 1:** the Undo authorization gap (security and robustness found it independently), the payment-in-flight race,
  5 test gaps in the quotes backend, and 3 cleanliness items.
- **Round 2:** money taken by the terminal but not in Books still allowed Undo (high); a link-creation race (security and
  robustness again); 3 test gaps; 1 dead field. Worker leads checked and rejected: "edit wipes kept-line discounts" and
  "numeric discount → 500" are not bugs.
- **Round 3:** T-168 (above); a lock-release test gap; 4 small cleanliness items; the customer-credit display untested.
  Security found nothing.

## Findings by auditor (filed into PLAN.md this campaign → outcome)
| Auditor | Filed | DONE | BLOCKED | WONTFIX |
|---|---|---|---|---|
| audit-security | 2 | 2 | 0 | 0 |
| audit-robustness | 5 | 5 | 0 | 0 |
| audit-cleanliness | 7 | 5 | 1 (T-146) | 1 (T-165) |
| audit-tests | 10 | 10 | 0 | 0 |

**Triaged this campaign:** 17 in total: cleanliness 7, tests 10, security 0, robustness 0. You promoted 16 of them into
the plan by hand. One is still in TRIAGE.md: **T-148**, cross-module imports of underscore-private helpers between the
quote modules. Fixing it means renaming to public names, which moves SURFACE. Promote it later with
`plan.py promote T-148 --iteration N` (the flag is required).

## Gates
- **Coverage, scoped statements:**
  - backend 97.09% → **99.42%** (4000/4120 at base)
  - frontend 97.56% → **97.72%**
- **Final full suites on `o7/loop-8`:**
  - backend 29,508 passed, 0 failed
  - frontend 12,475 passed, 0 failed
- **Known-broken tests:** 1 → 1. `test_migration_backfills_calibrated_at_from_offset` is time-of-day dependent and out of scope; it passed in every run of this campaign.
- **Snapshot probes:** 31/31 matching at every iteration. At setup, 7 goldens were re-recorded for post-O6 drift and the 4 `revenue-*` probes were dropped (they shared /tmp with RV2).
- **SURFACE.md:** unchanged throughout (`tools/gen_surface_orders.sh`).
- **Diff vs base:** 20 files, +725 / −35. Production code: 9 files, +86 / −32. Tests: 10 files, +634 / −3.

## Left for humans
- **T-146** (BLOCKED, no change made): one shared `BOARD_KEY` for `['order-board']` needs a new export, which moves SURFACE.
- **T-148** (TRIAGE): see above.
- **T-165** (WONTFIX, declined).
- The quote Undo is still unproven live: watch it on one real quote. The in-process `_made` map and the payment lock only protect a single-worker deployment.
- **Worker oddity, iteration 3:** a worker reported killing "stuck" `snapshot.py` processes, some of which it hadn't started. Later dispatches forbid that. Nothing visibly broke; the dev server on :8000 survived.

## Merge notes
- Merging `auto-refactor-loop-o7` into main conflicts with RV2 on PROBES.json, snapshots/ and SURFACE.md (the loop's own
  machinery). Whichever campaign merges second takes its own copy of those files.
- The frontend changed (`OrderBoardPage.tsx`, `useQuoteActions.ts`, `QuoteAcceptedNotice.tsx`, `api/client.ts`), so
  rebuild static/ and restart :8000 after the merge.
- Loop state is preserved in `plans/refactor-campaign-orders-o7/` in the main checkout.
