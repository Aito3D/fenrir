# FINAL_REPORT — refactor-loop campaign 8: the Calculator feature (FE + BE)

- **Campaign**: 8 · worktree `bambuddy-refactor`, branch `auto-refactor-loop`, UPSTREAM `f44cd76b0` (the campaign-7 merge), BASE tag `refactor-base` = `65c8196f8`
- **Iterations run**: 15 (tags `loop-1` … `loop-15`) · **Survey rounds**: 3 of 3
- **Commits**: 16 on the branch (setup/BASE + 15 squashed iteration commits + this report)
- **Why the loop ended**: MAX_ROUNDS — round 3 completed and its findings were fully worked; the plan is exhausted with no further survey round available.

## Findings by auditor (plan.py stats, campaign-wide)
| auditor | filed into PLAN.md | DONE | WONTFIX | triaged to TRIAGE.md |
|---|---|---|---|---|
| audit-security | 7 | 6 | 1 (T-043, user-declined) | 3 |
| audit-robustness | 13 | 13 | 0 | 2 |
| audit-cleanliness | 4 | 4 | 0 | 1 |
| audit-tests | 19 | 19 | 0 | 3 |
| **total** | **43** | **42** | **1** | **9** |

Round 1 filed 16 workable + 1 blocked + 4 triaged; round 2 filed 15 (6 behavior-gated) + 4 triaged; round 3 filed 12 (8 behavior-gated) + 1 triaged. No round was dry — the loop ended on the round cap, not convergence.

## User-approved behavior changes (all in BASELINE-CHANGELOG.md, each in a commit marked "user-approved behavior change")
T-006 K-drag domain anchor · T-001+T-002 SURFACE re-baseline (2 new exports) · T-007 in-flight settings edits survive save · T-008 spoolCost button gated on postable values · T-009 signed negative waterfall margin · T-003 MIN_SAMPLE residual suppression (failure/time folds) · T-022 non-compounding keyboard K step · T-023 rapid double-dismiss keeps both · T-024 sync `unpriced` outcome (no repricing from inferred 1 kg) · T-025 atomic margin min/max guard (+fix-up: no-op PATCH keeps updated_at; inverted rows still 422) · T-027 cross-window suppression (+fix-up: frontend null propagation) · T-028 by_material residual guard · T-029 customer quote reduced to price lines · T-042/T-045 every-narrower-window probing · T-046/T-044 suppression extended to power/usage folds · T-047 decade-exact keyboard inverses · T-048 quote lines sum exactly at display precision · T-049 quantity-chart domain contains KQ.
**Declined**: T-043 (partition cross-reconstruction blanking — residual risk accepted by the user).

## Quality gates
- **Coverage** (tools/coverage_calc.sh, flags unchanged all campaign): frontend statements **92.85% → 96.99%** (1326/1428 → 1419/1463); backend scoped statements **99.51% → 99.78%** (808/812 → 903/905), branches 95.45% → ~98.5%.
- **known-broken tests**: 0 → 0. Final full runs: backend 12550 passed/1 skipped/0 failed; frontend 5287/5287 passed (zero flakes tripped on the final run).
- **Golden probes**: 10/10 matching. Three sanctioned re-records across the campaign (calc-pydantic-schemas ×2 cumulative, calc-insights-pure ×1), each named in its changelog entry.
- **SURFACE.md**: +2 lines vs BASE (`export const TOOLTIP`, `export function useZohoFilamentSync`) — the sanctioned T-001+T-002 mechanical re-baseline; regenerates byte-identically.
- Campaign-wide test diff: ~+1,900 test lines added, 9 assertion lines removed — every removal tied to a named sanction. No test file deleted, no skip/ignore added, coverage gate byte-identical to BASE.

## Verifier record
15 iterations verified blind; 3 initial FAILs, all remediated and re-verified PASS:
1. Iteration 1 — missing sanction trail for T-006 + surface re-baseline (protocol, not code).
2. Iteration 8 — T-025's first implementation bumped `updated_at` on no-op PATCHes and let pre-inverted rows through; fixed same iteration.
3. Iteration 11 — T-027's backend nulls unpropagated to the frontend (crash / fabricated-0 paths); fixed same iteration.

## Triaged for human review (9 entries, full evidence in TRIAGE.md — read with `plan.py --file TRIAGE.md render --iteration 15`; promote with `plan.py promote <id> --iteration N`, the flag is required)
By source — audit-security 3: unsanitised names in route logs; loadState type-coercion (filed twice, once per auditor); stale-catalogue signal dropped by calculator sync. audit-robustness 2: roundK float noise in margin_k; loadState crash variant. audit-tests 3: margin-curve example seeding untested; _spool_costs blank-material guard; _score mid-material ranking. audit-cleanliness 1: duplicated hours formula (useCalculatorState/quoteSummary).
(Caveat: `plan.py stats`'s `triaged: 9` is the current TRIAGE.md population; here it equals the campaign-wide sum since nothing was promoted and no prior campaign left entries.)

## Leftovers
OPEN: none · BLOCKED: none · WONTFIX-AUTO: 1 (T-043, declined by the user with evidence retained in PLAN.md/archive).

## Preservation
All state files (PLAN.md, TRIAGE.md, BASELINE.md, VERDICTS.log, 12 findings-audit-*.json) copied to `refactor-campaign8-archive/` in the main checkout, per the user's choice, matching the c6/c7 convention.
