# Final report — refactor-loop campaign O4: the Order Board

Campaign O4 (fourth refactor-loop campaign on /orders; first on this branch). Ran 2026-11-18 → 2026-11-19.

- Branch `auto-refactor-loop`, worktree `../bambuddy-refactor-o4` (moved off the default `../bambuddy-refactor` after
  another session deleted that worktree during setup; branch and tags were unaffected).
- UPSTREAM: main `e90b2b333`. BASE: `refactor-base` = `b56175657` (setup commit: goldens re-recorded + SURFACE regenerated).
- Iterations run: 8 (MAX_ITER 8). Survey rounds completed: 2 of MAX_ROUNDS 3.
- Commits: 1 setup + 8 squashed iteration commits. Tags: `refactor-base`, `loop-1` … `loop-8`.
- Parameters: BATCH 3, TRIAGE P3, mode auto, grouped commits, merge at exit.
- **Why it ended: MAX_ITER** (iteration 9 would exceed 8). Three user-approved tasks were still OPEN.

## User-approved behavior changes (BASELINE-CHANGELOG.md, all approved 2026-11-18)

| Task | Change an operator can see |
|------|----------------------------|
| T-062 (+T-054 merged) | Cancelling an invoiced order is refused upfront (`order_invoiced`) without touching its parcels; a cancel that fails partway records an `order.cancel_failed` history line naming the parcels/picklists it deleted. |
| T-063 | Recording a manual payment while the card terminal is pending/processing on that order → 409 `terminal_in_progress`. |
| T-064 | A counter-order resubmit reusing a `client_ref` with a different client or lines → refused `ref_reused` (identical retry still returns the first order). |
| T-065 | After a 429 at counter-order confirm, the cleanup void of the half-made draft is deferred to the sync pass; a failed deferred void records `order.void_failed`. In-memory (lost on restart, marked `shortcut:`). |
| T-066 | A rate-limited order Sync answers 503 "Zoho is busy" and opens the back-off window (was 502 with Books' text). |
| T-067 | After a Books gateway error (ZohoAmbiguous) on a quote/deposit email, an immediate resend to the same address is refused as a duplicate. Invoice email unchanged. |
| T-055 | Contact edit rejects a malformed email (422); quote/deposit/invoice email to an address set by a contact edit in the last 10 minutes → 409 `recipient_recently_edited`. `contact.edited` now stores the new email. |
| T-082 (+T-072 merged) | That 10-minute block applies across all orders of the same client (event also stores `customer_id`). |
| T-084 | A deferred draft void that hits a network error is retried on later passes (cap 5) instead of being dropped at once. |
| T-083 | A contact edit whose Books write times out / is ambiguous still records `contact.edited`, so the block applies. |

Goldens re-recorded under these entries: fe-i18n-parity, orders-frontend-pure, orders-i18n, orders-rules. SURFACE.md
gained 5 i18n keys: `aito.emailRecipientRecentlyEdited`, `orders.history.orderCancelFailed`, `orders.history.orderVoidFailed`,
`orders.history.short.cancelFailed`, `orders.history.short.voidFailed`. New translations in all 16 locales were written
by the workers: a native-speaker skim is worthwhile.

## Survey rounds

- **Round 1** (focus: ~9.4k lines of order code added after the O3 merge): 14 filed — security 2 (both behavior
  changes), robustness 6 (all behavior changes), cleanliness 1, tests 5 — plus 3 triaged. The two cancel findings
  (T-054/T-062) were one bug. All 8 behavior changes approved.
- **Round 2** (user asked to focus on frontend test coverage): 13 filed — security 1, robustness 6 (all behavior
  changes, mostly gaps in round-1 fixes), tests 6 frontend coverage tasks — plus 7 triaged (4 cleanliness, 3 tests).
  T-072/T-082 were one bug. All 7 behavior changes approved.
- Round 3 never ran (iteration budget spent first).

## Findings by auditor (`plan.py stats`)

| Auditor | Filed to PLAN | DONE | OPEN | BLOCKED | WONTFIX-AUTO | Triaged (campaign) |
|---------|---------------|------|------|---------|--------------|--------------------|
| audit-security | 3 | 1 | 0 | 0 | 2 (merged duplicates T-054, T-072) | 0 |
| audit-robustness | 12 | 9 | 3 | 0 | 0 | 0 |
| audit-cleanliness | 1 | 1 | 0 | 0 | 0 | 6 |
| audit-tests | 11 | 11 | 0 | 0 | 0 | 4 |

Triaged this campaign: **10** (cleanliness 6, tests 4), all P3, all in TRIAGE.md with full evidence. Review them with
`python tools/plan.py --file TRIAGE.md render --iteration 0` and promote with `plan.py promote <id> --iteration N`
(the flag is required).

## Quality gates

- **Coverage (scoped statements):** backend 98.59% → **99.07%**; frontend 91.04% → **95.89%** (branches 86.76% → ~89%).
- **Known-broken tests:** 1 → 1 (`test_printer_hours_migrations::test_migration_backfills_calibrated_at_from_offset`, time-of-day; passed in every run, not fixed).
- **Golden snapshots:** 43/43 matching at every verified iteration.
- **SURFACE.md:** changed only by the 5 sanctioned i18n keys.
- **Verifier:** 9 runs, 8 PASS + 1 FAIL. The FAIL was iteration 5: T-055 didn't re-record the goldens/SURFACE for its new key. A bookkeeping commit fixed it and the re-verify passed.
- **Full suites at the last verified HEAD:** backend 28,493 passed. The one failure, `test_aito_terminal_payments::test_concurrent_starts_are_serialized_by_the_lock`, is a load flake that passes alone. Frontend: 11,655 passed.
- **Diff since BASE:** 53 files, +2242 / −132.
  - Production code (backend/app, components, pages): 15 files, +253 / −85.
  - Tests: 16 files, +1512 / −16.
  - The rest is locale strings, goldens, SURFACE.md and the changelog.
- **Test counts:** backend 28,444 → 28,493 (+49); frontend 11,603 → 11,655 (+52).

## Left for humans

OPEN, user-approved, not reached (the budget ran out):
- **T-085:** `_void_pending_drafts` voids the remembered order without checking it is still a draft. Someone may have confirmed it in Books during the back-off.
- **T-086:** `cancel_order` logs `order.cancel_failed` when the void timed out but may have gone through.
- **T-087:** a waiting duplicate counter-order submit calls Books inside the 429 window opened by the attempt it waited on.

WONTFIX-AUTO: T-054 (merged into T-062), T-072 (merged into T-082). Both were approved duplicates, not declined.

Triaged (P3): T-052, T-053, T-061, T-068, T-069, T-070, T-071, T-079, T-080, T-081.

Leads noted by workers, not filed:
- ContactEditor shows only the generic "edit failed" toast for the server's new 422 (malformed email).
- `printLabel`'s `if (!service || !island) return` guard in OrderShippingLabelModal is unreachable.
- An order stored without `customer_id` refuses a contact edit (`no_contact`) before the write.

## Preserved state

Per the user's choice at exit, PLAN.md, TRIAGE.md, BASELINE.md, VERDICTS.log, the findings JSON, the briefs and the
archived O3 plans are copied to `plans/refactor-campaign-orders-o4/` in the main checkout (gitignored).
