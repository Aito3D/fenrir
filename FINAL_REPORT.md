# Refactor-loop — Campaign 6 · the Calculator × Zoho feature

**Branch** `auto-refactor-loop` · **BASE** `refactor-base` (5893adca1, off `main` 46ad16bab)
**Ran** 2026-08-21 → 2026-08-24 · **Ended on** MAX_ROUNDS (4 of 4 survey rounds used)

Nineteen iterations, four survey rounds, 19 squashed commits, 19 tags (`loop-1`…`loop-19`).
Every iteration was gated by an independent blind verifier before being tagged.

> **This campaign was extended twice.** It first reached EXIT on 2026-08-23 after 12
> iterations and 3 rounds, un-converged. On 2026-08-24 the user raised MAX_ITER 12→16 and
> MAX_ROUNDS 3→4, then MAX_ITER 16→20 mid-round-4. The original ending's report is preserved
> as `FINAL_REPORT.campaign6-part1.md`. This report covers the whole campaign.

---

## Outcome

| | before (BASE) | after |
|---|---|---|
| frontend statements | 87.32% (937/1073) | **92.69%** (1028/1109) |
| frontend branches | 82.46% (823/998) | **88.59%** (901/1017) |
| backend statements (scoped) | 97.76% (612/626) | **99.44%** (712/716) |
| backend branches (scoped) | 90.18% (101/112) | **94.03%** (126/134) |
| backend tests | 11,636 | **11,813** (+177) |
| frontend tests | 4,828 / 346 files | **~4,896** / 348 files (+68) |
| known-broken tests | 0 | 0 |
| golden probes | 10/10 | **10/10** |
| SURFACE.md | baseline | 4 sanctioned moves, each matched to a changelog entry |

Per-file backend coverage at exit: `routes/calculator.py`, `models/calculator.py` and
`schemas/calculator.py` all **100.00%**; `zoho_filaments.py` 98.44%; `calculator_insights.py`
95.93% (the low file in scope, and the one this campaign churned hardest).

### Campaign-wide integrity, verified at the final gate

- **Zero deleted or renamed files of any kind** across all 19 iterations —
  `git diff --diff-filter=DR --name-status refactor-base..HEAD` is empty. Not just tests: nothing.
- **`tools/` and `PROBES.json` have zero diff from BASE**, confirmed by object hash
  (`tools/` = `5cea3c86`, `PROBES.json` = `409d1ae7`, identical at `refactor-base`, `loop-18` and `HEAD`).
  The measuring apparatus was never touched by the work it measured.
- **No coverage suppression added anywhere**: no `pragma: no cover`, `istanbul ignore`,
  `v8 ignore`, `xfail`, `.skip(` or `@pytest.mark.skip` introduced in the entire campaign.
  Coverage config (include globs, `--retry=3`, `--coverage.reportOnFailure`) byte-identical to BASE.

---

## Why it ended

**MAX_ROUNDS.** Round 4 was the last survey the cap allowed. One iteration of budget
remained unused (19 of 20), so the plan was worked to exhaustion — 0 OPEN, 0 BLOCKED at exit.

| round | findings | of which behavior-changing | triaged (P3) |
|---|---|---|---|
| 1 | 22 | 5 | 5 |
| 2 | 17 | 8 | 4 |
| 3 | 11 | 1 | 2 |
| 4 | **14** | **8** | **0** |
| **total** | **64** | **22** | **11** |

**Zero suppressions across all four rounds** — no auditor ever restated a prior finding.

Round 4 did not look like a campaign winding down. It filed 14 findings including two P1s,
and 8 of the 14 needed user approval — the highest proportion of any round. The campaign
ended because it ran out of survey rounds, not because the codebase ran out of defects.

**The recurring pattern held to the end: a meaningful share of each round's findings were
defects in the previous round's fixes.** Round 2 found the lock T-072 added could wedge the
feature; round 3 found T-089's suppression floor was defeated by arithmetic; round 4 found a
stale-closure bug in T-108's own extraction and a predicate divergence in T-106's own helper.
Then the iteration-16 gate found two undisclosed behavior changes in the fix for *those*, and
the iteration-18 gate found a credential the T-129 redaction rule missed. Each was caught, but
the lesson is that this shape of campaign converges slowly and the last round's output
deserves the same scrutiny as the first's.

---

## Findings by auditor

| auditor | filed | DONE | retired | triaged |
|---|---|---|---|---|
| audit-robustness | 16 | 16 | 0 | 1 |
| audit-tests | 20 | 18 | 2 | 1 |
| audit-cleanliness | 7 | 7 | 0 | 7 |
| audit-security | 10 | 7 | 3 | 2 |
| **total** | **53** | **48** | **5** | **11** |

**48 of 53 tasks DONE (90.6%).** Nothing was left OPEN or BLOCKED.

Four of the five retired were duplicates — the same issue found independently by two
auditors. The fifth, T-123, became genuinely moot when iteration 16 deleted the helper it
wanted to test *and* landed both tests it asked for; it was verified moot and retired with
evidence rather than worked twice.

### Triaged (11) — held for you, not lost

7 cleanliness, 2 security, 1 robustness, 1 tests — all P3, all filed in rounds 1–3, all with
full evidence in `TRIAGE.md`. Promote with `plan.py promote <id> --iteration N` (that flag is
required; the command fails without it). Round 4 triaged nothing.

*Caveat on the number: `plan.py stats`'s `triaged: 11` is what currently sits in TRIAGE.md,
not a campaign-wide sum — `promote` decrements it and `archive` does not archive TRIAGE.md.
Here the two happen to agree, because nothing was promoted.*

---

## The twenty behavior changes you approved

Each was quoted to you verbatim before any work began, and each carries a
`BASELINE-CHANGELOG.md` entry committed alongside its code (71 entries total).

**Iterations 1–12** (detailed in `FINAL_REPORT.campaign6-part1.md`): T-071 non-finite money
rejection · T-068 Zoho catalogue authz · T-073 truncated-catalogue raise · T-074 500-vs-502
mapping failures · T-075 sync guard survives remount · T-094 refresh-lock timeout · T-089
spool-cost MIN_SAMPLE floor · T-090 derived sale price validated · T-095 superseded walk fails
· T-093/T-096 valid 422 JSON and honest timeout reporting.

**Iterations 13–19:**

11. **T-106** — a material spool-cost row is suppressed when its published brand subgroups leave a residual below MIN_SAMPLE, closing an arithmetic disclosure that recovered an individual spool's purchase price (`6×50.0 − 5×20.0 = 200.0`) with only `calculator:read`
12. **T-109** — a *contract disclosure*, not a behavior change: 9 previously-hidden exports made visible to SURFACE.md, after the in-code react-refresh rationale for hiding them was shown to be empirically false
13. **T-118** — the filament READ path tolerates a legacy out-of-range margin; one bad row no longer 500s the entire filament list at boot
14. **T-128** — `GET /calculator/insights?days=` restricted to a fixed allowlist (30/90/365), closing a window-sweep that reconstructed individual prints
15. **T-117 / T-120** — the spool-cost residual folded into one read with one predicate, fixing both a publish-predicate divergence and a two-query race
16. **T-119** — a save's success is bound to the form that issued it, so a slow save no longer closes a form you opened afterwards and discards what you typed
17. **T-121** — the daily-hours "Update printer" action is withheld when it would post a value the API rejects
18. **T-122** — the defaults form validates each field against its real server bound and marks the offending field, instead of discarding every edit in the pass
19. **T-129** — password-like values are redacted from 422 bodies **app-wide** (widest blast radius in the campaign)
20. **T-130** — `_time_accuracy.by_printer` gates on MIN_SAMPLE instead of a bare `3`

Three needed a second pass after a verifier objected: **T-075** was failed for shipping
session-persistent state you had not approved; **T-094** had its clock stamp corrected; and
**T-117/T-120** was failed for two undisclosed changes and fixed (see below).

---

## What the gates caught

**Twenty-one verification runs, nineteen PASS, two FAIL.** Both failures were real.

**Iteration 3** — T-075 shipped a completed sync summary that persisted for the whole page
session with no dismissal path, where BASE cleared it on unmount. Narrowed, not reverted.

**Iteration 16** — the more instructive one. Merging two database reads into one (a correct
fix for a real race) *also* changed the result **order** and shifted `avg_cost_per_kg` by a
cent through float re-association. Neither was covered by a changelog entry. The order mattered
because `utils/calculatorInsights.ts` takes the first fuzzy match and `'pla-cf'.includes('pla')`
is true — so a plain "PLA" profile silently resolved to the PLA-CF row, 21.00 → 60.00. A
400-trial differential found the order flipped in 30% of cases. Fixed by issuing the original
query text as one `UNION ALL` branch, so order and float accumulation are inherited *by
construction* rather than re-implemented; re-verified with 2,500 randomized trials, zero
unsanctioned differences.

Verifiers repeatedly went beyond the brief:

- **Independently re-derived the empty-string-brand question by running the code** across six
  adversarial populations, and *disproved* the hypothesis two other agents had reached — the
  divergence over-suppresses only and leaks nothing. Two other cross-agent contradictions this
  campaign were resolved the same way: by running the code, not by preferring a report.
- **Re-measured the app-global handler's recursion-depth crash threshold three separate times**
  (988 caller-relative, unchanged) and byte-compared 22 adversarial non-finite payload shapes
  across refs — sets, frozensets, `Decimal("NaN")`, a duck-typed `__float__`, 200-deep nesting.
- **Swept 5,602 identifiers** across all 333 `backend/app` files to prove a widened redaction
  rule introduced zero non-credential false positives.
- **Verified a claimed fix by construction rather than by reading the diff** — constructing the
  pydantic models directly to confirm a relaxed read path had not also loosened the write path,
  and establishing that nothing in `backend/app/` even composes the base model.
- **Ran control experiments on coverage and flakes** rather than accepting "probably flake" —
  including stash-based controls measuring the *unmodified* tree under identical load.

---

## The flake that shaped the campaign, and its fix

`CalculatorPage.test.tsx` degraded over the campaign to the point of failing *in isolation*
under load, and every verification run paid for it in isolation reruns. The round-4 auditor
root-caused it: `frontend/vitest.config.ts` sets `testTimeout: 10000`, but nothing in the repo
ever calls `@testing-library/dom`'s `configure({ asyncUtilTimeout })`, so **every `findBy*` was
bound by RTL's 1000 ms default regardless of the file's apparent 10 s budget.**

T-127 fixed it for the in-scope file and *measured* the result — load generated deliberately,
`uptime` recorded per run:

| | load | result |
|---|---|---|
| before | 4–53 | 39/39 pass (8 runs) |
| before | 63–79 | **7 failed** (4 runs), identical set each time |
| after | 76–119 | **39/39 pass** (6 runs) |

It now passes at loads exceeding every level at which it previously failed. A side effect
settled a discrepancy two gates had flagged: the frontend coverage reading is now stable at
**92.69%**, and the ~21-statement gap earlier dismissed as an "optimistic" worker figure was
exactly these flake-suppressed lines.

**Recommended follow-up (not done — out of scope):** the root cause is repo-wide. The same
signature still reproduces today in `ModelViewerModal`, `StatsPageUserFilter1894` and
`PrintModal` *even with `--retry=3` active*. Raising `asyncUtilTimeout` globally in
`frontend/src/__tests__/setup.ts` — which already uses the same symmetric `beforeAll`/`afterAll`
shape for MSW — would very likely settle all of them. Measured suite-time impact: negligible
(~340–350 s across three full runs regardless of flake count), since a longer budget only costs
time when a call is already slow. Before flipping it, sweep for any test that *relies* on
hitting the 1 s timeout (e.g. `waitForElementToBeRemoved` negative assertions).

---

## Discoveries worth keeping beyond this branch

1. **`conftest.py`'s session-scoped `event_loop` fixture is silently ignored by pytest-asyncio 1.3.0.** Every async test runs on its own loop, and a module-level `asyncio.Lock` binds to a loop only on first *contention* — so a lock contended in one test leaks into another. Repo-wide latent problem.
2. **A differential test cannot see a fault in a helper both sides share.** T-076's equivalence proof called the same `_resolve_duration` on both sides; two real faults in it survived the entire file.
3. **`<input type="number">` sanitises non-finite input before React's `onChange` fires** — HTML5 value-sanitisation, in jsdom as in browsers. A test that claims to type `Infinity` into one is testing nothing.
4. **Pydantic v2 does not coerce a query *string* to an int `Literal` in non-JSON parsing mode.** `Literal[30, 90, 365]` 422'd *every* request including the intended ones; `IntEnum` coerces like a plain int while still restricting the domain. The obvious implementation was wrong and only running it revealed that.
5. **React Query v5 refreshes an in-flight mutation's options on every render** (`MutationObserver#setOptions` forwards to the pending mutation), so a base `onSuccess` closure reads the *latest* state, not the state the mutation was issued with. Per-call `mutate(vars, opts)` options are captured once and are immune — that asymmetry is the fix, and it is not obvious from the docs.
6. **Guarding against a stale closure with a second closure reproduces the bug.** T-119's id comparison had to read a ref; a closure captured at the same moment as the callback it guards is equally stale.
7. **SQLite's `GROUP BY upper(x)` ordering is an unindexed-plan artifact, not a contract** — and this codebase *consumes* it, via a first-fuzzy-match lookup where `'pla-cf'.includes('pla')`. Reproducing prior output by re-issuing the identical query text is safer than imitating its observed order.
8. **Mirrored client/server validation needs a test that catches the *looser* direction.** A client bound stricter than the server merely annoys; looser silently re-creates the bug the mirror was meant to prevent.

---

## Left for a human

### Nothing open

0 OPEN, 0 BLOCKED. The plan was worked to exhaustion.

### Retired without a fix (5) — each needs a human decision, not more loop time

- **T-067** — calculator money schemas accept non-finite floats *(superseded: T-071 fixed the reachable path)*
- **T-091** — the T-072 single-flight lock had no acquisition timeout or negative caching *(superseded by T-094)*
- **T-104** — `reset_cache()`'s `_refresh_lock` rebuild is untested *(moot: T-095 deleted the code)*
- **T-123** — `_published_brand_counts_by_material` gaps *(moot: iteration 16 deleted the helper and landed both requested tests)*
- **T-092** — the 422 handler emits RFC-8259-invalid JSON app-wide *(superseded by T-093)*

### Triaged with full evidence (11)

All P3, all in `TRIAGE.md` — see above.

### Concerns raised by the final gates, for a reviewer

1. **T-130 lands on live data.** Any printer with only 3–4 slicer-estimate comparisons silently loses its reality-check row on upgrade; on a small installation that could empty the per-printer list. `overall_pct` is unaffected. Exactly what was approved — but it is a data-dependent visible change, not a refactor.
2. **The redaction rule is now open-ended.** "Only `apikey` newly matches" is true today (verified twice), but it is a general transform: any future field ending in a run-together credential suffix auto-redacts. Conversely, plural/numbered spellings stay unredacted by design — a future `api_keys` or `password2` would **not** be. Deliberate, but easy to trip over.
3. **`tfa_key` (`schemas/cloud.py`) is a real short-lived TOTP secret that no rule matches**, because covering it would require matching bare `key` — which the trap list explicitly forbids. Speculative today (no validator constrains it), but a genuine tension in the rule's design.
4. **`_spool_costs` and `_spool_costs_by_brand` are still two separate round trips** in `compute()`. T-120 fixed the race *inside* `_spool_costs`; the two published aggregates can still be briefly inconsistent *with each other*.
5. **`calculatorInsights.ts`'s `containsEitherWay` first-match is fragile** regardless of backend ordering — `"PLA"` matching `"PLA-CF"` is what made the iteration-16 ordering bug observable at all. Pre-existing; untouched.
6. **`CalculatorFilamentCreate/Update.cost_per_kg` and `CalculatorPrinterCreate/Update.purchase_price`/`power_watts` are `gt=0`.** T-122 ruled out a zero-mismatch for the *defaults* panel; the filament and printer panels were never checked for the same hazard.
7. **The `days` allowlist membership (30/90/365) is no longer pinned by any golden probe** — `calc-openapi` captures only `spec["paths"]`, and the constraint is now a `$ref`. It is pinned by parametrised tests instead; the alarm moved from the goldens into the suite.
8. **A stale doc comment** above `_SECRET_FIELD_NAME_SUFFIXES` in `main.py` still describes only the `_`-joined rule. Cosmetic, but contradicts the comment block below it.
9. **`.coverage` is tracked** and is dirtied by every coverage run. Worth untracking; a merge hazard as-is.

---

## Before you merge

**`main` has moved 4 commits since this branch was cut** (the AMS drying guard and the Aito
client-contacted gate). One touches `backend/app/main.py`, which this campaign also edits —
main's at ~136 and ~7181, ours at ~11, ~8637 and ~8660-8733. The regions do not overlap, so a
textual merge should be clean.

**That is not sufficient.** This repository's own history includes a semantic conflict git
could not see: a helper renamed on one side while the other added a call site, merging cleanly
and failing at runtime. **Run the full suite on the merged tree before pushing.**

Not run by this campaign: `test_security.sh`, `test_docker.sh`.

**Preserved outside the worktree** at your request: `PLAN.md`, `TRIAGE.md`, `BASELINE.md`,
`VERDICTS.log`, all 16 `findings-audit-*.json` and `FINAL_REPORT.campaign6-part1.md` were
copied to `refactor-campaign6-archive/` in the main checkout (400 KB, untracked) before the
worktree is removed.
