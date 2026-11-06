# Final report — refactor-loop campaign T1: the client tracking page

Branch `auto-refactor-track` in `../bambuddy-refactor-track`, BASE tag `refactor-base-track` (setup commit
0f332872a on main 484da88b5). Ran 2026-11-05 → 2026-11-06 alongside a separate campaign in `../bambuddy-refactor`.

## Summary

- Iterations: 7 (loopT-1 … loopT-7), survey rounds: 3 (MAX_ROUNDS).
- Commits: setup + 7 squashed iteration commits + this report. Tags: `refactor-base-track`, `loopT-1` … `loopT-7`.
- Tasks: 19 filed to PLAN.md, 19 DONE, 0 OPEN / BLOCKED / WONTFIX-AUTO.
- Why the loop ended: MAX_ROUNDS (round 3 reached). It did not converge: rounds 2 and 3 each produced
  approved work.
- Every iteration passed the blind verifier. One FAIL happened (loopT-1, first pass): a pending link
  repriced after a deposit-% change kept its old deposit flag. It was fixed in the same iteration and
  re-verified PASS.

## Coverage, tests, contracts

| | baseline (refactor-base-track) | final (loopT-7) |
|---|---|---|
| Backend scope (services/aito_tracking.py + models/aito_tracking_view.py), statements | 193/194 = 99.48% | 193/193 = 100.00% |
| Frontend scope (19 tracking files), statements | 625/647 = 96.59% | 685/690 = 99.27% |
| Backend full suite | 25 873 passed (3 load flakes) | 25 887 passed, 1 failed (out of scope, see below) |
| Frontend full suite | 10 663 passed (9 load flakes) | 10 693 passed, 1 load flake |
| known_broken | none | none |
| Snapshot probes | 11/11 | 11/11 (4 goldens re-recorded under approved changes) |

- The backend scope lost one statement because the unused `tracking_url()` helper was deleted (T-035).
- **Diff:** 46 files changed, +1030 / −159 lines in total. App code (non-test, non-i18n) is +265 / −113,
  and tests are +648 / −14.
- **Goldens re-recorded:**
  - app-ddl (T-038, new column)
  - tracking-backend (T-035)
  - fe-i18n-parity and tracking-i18n (T-041, new key `aito.trackingCopyFailed` in all 16 locale files)
- **SURFACE.md:**
  - `tracking_url` removed.
  - Exports added: `useI18nSettleDeadline`, `TrackingUnpaidCard`, `I18N_ENGLISH_EXTRA_MS` and
    `resetI18nDeadlineForTests` (test-only reset).
  - Key added: `aito.trackingCopyFailed`.
- **Out-of-scope failure found:** the final verifier hit
  `backend/tests/unit/test_printer_hours_migrations.py::test_migration_backfills_calibrated_at_from_offset`.
  It fails whenever the local date differs from the UTC date (on this UTC-10 machine, from 14:00 local
  time) and passes with `TZ=UTC`. The test compares `date.today()` to a migration that stamps the UTC date.
  This campaign never touched it, so it fails on main too and needs its own fix.

## User-approved behavior changes (BASELINE-CHANGELOG.md)

Approved at setup (2026-11-05):
- **T-037:** the limiter keys IPv4-mapped clients (`::ffff:a.b.c.d`) as their plain IPv4 address and /24,
  where it used to fold them all into one `::/48` bucket.
- **T-038:** the tracking page's deposit wording follows a new nullable `aito_payment_links.deposit`
  column.
  - The flag is set when a link is minted and kept in step when the reconciler reprices a pending link.
  - Legacy NULL rows fall back to the current setting.
  - The migration is dialect-aware, and the PostgreSQL upgrade check passed.
- **T-039:** when the 10 s locale deadline fires without the visitor's language, both tracking pages load
  English. They used to show raw `aito.track.*` keys.
- **T-035:** the unused `tracking_url()` helper was deleted, together with its test and its probe calls.

Promoted from triage with their effects accepted (2026-11-05):
- **T-040:** the view log is written after the response, in a BackgroundTasks job with its own session.
- **T-041:** board Copy link writes to the clipboard inside the click (ClipboardItem), with a fallback.
  A refused copy now shows its own message.
- **T-042:** leaving `/t` mid-check aborts the check, so a late answer no longer redirects the client.

Approved in the round sweeps (2026-11-06):
- **T-053:** the English fallback load gets 3 s more. After that the page renders anyway and switches to
  English when it lands. T-039 had left an unbounded wait.
- **T-057:** once the deadline has settled on `/t`, the order page `/t/<code>` doesn't re-wait 10 s.
- **T-058:** the browser tab title switches to English when the English fallback lands.
- **T-059:** a lookup that raises (DB locked, connection drop) releases the limiter's reserved miss, so a
  valid link no longer gets 429 after server errors. The calls caps still count every request.

T-036 (`TrackingUnpaidCard` extraction) is zero-behavior: the DOM was compared byte for byte. It is listed
in the changelog only because SURFACE.md gained the export.

## Survey rounds

- **Round 1 (setup):** 13 findings: 3 behavior-change (approved), 10 triaged, all of which you promoted.
  A survey task, T-048 (5 tracking tests failing on PostgreSQL), was added during loopT-2.
- **Round 2:**
  - security: clean
  - cleanliness: 1, a stale comment (T-049; promoted and fixed)
  - tests: 3 weak tests (T-050–052; triaged)
  - robustness: T-053 (approved) and T-054 (triaged)
- **Round 3:**
  - security: clean, after a deep pass over the token lifecycle, payload fields, limiter and page headers
  - cleanliness: clean (knip, eslint and ruff all ran)
  - tests: 2 gaps (T-055, T-056; triaged)
  - robustness: T-057, T-058 and T-059 (all approved)

## Findings by auditor (PLAN.md, `plan.py stats`)

| source | filed to PLAN.md | DONE | BLOCKED | WONTFIX-AUTO |
|---|---|---|---|---|
| audit-security | 1 | 1 | 0 | 0 |
| audit-robustness | 9 | 9 | 0 | 0 |
| audit-cleanliness | 3 | 3 | 0 | 0 |
| audit-tests | 5 | 5 | 0 | 0 |
| survey (orchestrator) | 1 | 1 | 0 | 0 |

Triaged this campaign: 17 across three rounds.

| round | security | robustness | cleanliness | tests | total | promoted |
|---|---|---|---|---|---|---|
| Round 1 | 1 | 3 | 1 | 5 | 10 | all 10 |
| Round 2 | 0 | 1 | 1 | 3 | 5 | T-049 |
| Round 3 | 0 | 0 | 0 | 2 | 2 | none |

**6 remain in TRIAGE.md** with full evidence. Promote one with `plan.py promote <id> --iteration N`; the
`--iteration` flag is required.
- T-050 [P2]: the T-047 unmount test can't fail (it asserts `result.current` after unmount).
- T-055 [P2]: AitoTrackPage has no test for the both-stall path (locale and English late).
- T-051 [P3]: the locale-stall tests assert i18next directly, not the rendered page.
- T-052 [P3]: no test for a reprice PATCH that doesn't converge, where the deposit flag must keep its
  old value.
- T-054 [P3]: the `log_view` dedupe is check-then-insert, so concurrent opens can count twice.
- T-056 [P3]: the English-load rejection and the unmount-between-timers branches are untested.

## Follow-ups noticed outside the plan

- The hours-migration date test above, which fails whenever the local and UTC dates differ.
- **NUL in tracking codes (from the T-059 analysis):** a tracking code containing a NUL byte probably
  returns 500 on PostgreSQL instead of 404. This was found by reading the code and never run against
  PostgreSQL. It predates this campaign. Such a code can't match a real one and is bounded by the calls
  caps.
- `tools/coverage_tracking.sh` pipes vitest through `tail -12`, which hides which frontend test failed
  when the script exits 1.
- The T-041 translations in 16 locales were written by the worker and should get a native-speaker check.
  The in-gesture copy is untested on a real Safari or iPad.

## State preserved

PLAN.md, TRIAGE.md, BASELINE.md, VERDICTS.log, BASELINE-CHANGELOG.md, every `findings-audit-*-r*.json`
and both briefs are copied to `plans/refactor-campaign-tracking-t1/` in the main checkout. That directory
is gitignored.
