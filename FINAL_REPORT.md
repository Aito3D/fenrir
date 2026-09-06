# Refactor-loop campaign 11 — final report

Scope: the Aito and Calculator features (backend routes/services/models/schemas, frontend pages/components/hooks/utils, and their tests; only the Aito/Calculator slice of shared files).
Branch `auto-refactor-loop` in worktree `../bambuddy-refactor`, cut from main `466d0be7e` (UPSTREAM) on 2026-09-05. BASE = tag `refactor-base` (`754ad41d8`, the setup commit).
Parameters: TRIAGE P3 · BATCH 3 · MAX_ROUNDS 3 · MAX_ITER 8, raised to 12 at the round-2 sweep and to 16 at the round-3 sweep · mode auto · grouped commits · merge at exit.

## Outcome at a glance

| | |
|---|---|
| Iterations run | 16 (tags `loop-1` … `loop-16`), every one PASSed by the blind verifier (iteration 1 needed one fix cycle) |
| Survey rounds | 3 of 3 |
| Commits on the branch | 1 setup + 16 squashed iteration commits + this report |
| Tasks filed | 47 (T-001 … T-053 minus 6 triaged) — 46 DONE, 0 OPEN, 0 BLOCKED, 1 WONTFIX-AUTO (folded) |
| Findings triaged | 6, all P3, all in TRIAGE.md |
| User-approved changes | 18 changelog entries covering 23 task ids (see below) |
| Why the loop ended | MAX_ROUNDS — round 3 was productive, its tasks were all worked, and the round cap was reached at the next resurvey check |
| Diff vs BASE | 63 files, +5097 / −497 |

## User-approved behavior changes (all in BASELINE-CHANGELOG.md under "Campaign 11 · …")

Round 1 (approved 2026-09-05): T-001 ZohoSettings labels get htmlFor/id · T-006 invoice sweep stops at a Books 429 and shares the sync throttle · T-007 sweep clears cached invoice fields when Books reports no invoice · T-008 unpaid follow-up rule ignores a non-ISO due date · T-009 follow-up buckets re-age on a 60 s clock + visibilitychange · T-010 sweep commits per project and spends its hourly slot only on a completed pass · T-011 presence pings ignored without aito:read · T-012 /aito behind PermissionRoute (fe-router golden re-recorded) · T-013 invoice-PDF filename strips control characters.

Round 2 (approved 2026-09-06): T-024 one `isIsoDateKey` export (surface-only; SURFACE.md +1) · T-026 sweep walks least-recently-checked projects first · T-027 + T-031 sweep skips a project whose commit fails and stamps its slot on every exit except a 429 · T-028 broadcast_aito fans out outside the manager lock with the 5 s per-send timeout (`_fan_out` shared with broadcast()) · T-030 a websocket's aito_read is stamped before admission and the filter fails closed.

Round 3 (approved 2026-09-06): T-041 evicted sockets get a bounded close(1011) · T-042 broadcast_to_user fans out through `_fan_out` (folds T-049) · T-043 the three OpenRouter routes are rate-limited 30/60 s per principal · T-044 thirteen dead i18n keys removed from all 13 locales (fe-i18n-parity golden 7177 → 7164).

Wording nit recorded by the verifier: T-012's approved note said "no-permission page"; PermissionRoute redirects to the dashboard, as every other guarded route does.

## What each round found

| Round | security | robustness | cleanliness | tests | filed | triaged |
|---|---|---|---|---|---|---|
| 1 (setup) | 4 (3 bc) | 5 (5 bc) | 5 (1 bc) | 9 | 20 | 3 |
| 2 | 2 (1 bc) | 4 (3 bc) | 2 | 9 | 16 | 1 |
| 3 | 1 (1 bc) | 2 (2 bc) | 7 (2 bc) | 3 | 11 | 2 |

(bc = filed as a behavior change and held for approval; every one was approved.) No round was dry.

Round 1 concentrated on the invoice sweep, the follow-ups strip and websocket presence, plus the untested optimistic-mutation hooks campaign 10 had left. Round 2 found what round 1's own fixes exposed (the per-project commit's failure modes, the sweep's ordering, the connect-time aito_read window) and the P1 lock-held broadcast. Round 3 closed the websocket fan-out (evict-without-close, the per-user path), added the OpenRouter rate limit, deleted dead i18n keys, and pinned the residual wake-drain race.

## Findings by auditor (from `plan.py stats`, campaign-wide)

| Auditor | findings | DONE | WONTFIX-AUTO | triaged |
|---|---|---|---|---|
| audit-security | 7 | 6 | 0 | 1 (T-014) |
| audit-robustness | 11 | 10 | 0 | 1 (T-029) |
| audit-cleanliness | 14 | 9 | 1 (T-049, duplicate of T-042, folded) | 4 (T-004, T-005, T-047, T-048) |
| audit-tests | 21 | 21 | 0 | 0 |
| survey (hand-added) | 0 | | | |

Triaged findings (6, all P3) sit in TRIAGE.md with full evidence; promote one with `plan.py promote <id> --iteration N` (the flag is required). The `plan.py stats` `triaged` total (6) is the current TRIAGE.md count; nothing was promoted this campaign and no prior campaign's triage carried over.
- T-004 guarded-rollback swallow block repeated four times in routes/aito.py
- T-005 `_write_back_rounded_costs()` has an unused `project_id` parameter
- T-014 calculator CRUD routes log user-controlled names unsanitized (log-injection)
- T-029 `useCalculatorState.loadState()` spreads unvalidated JSON into CalcState
- T-047 an inline comment in the sweep credits the per-project commit to T-027 instead of T-010
- T-048 `dueDateLevel()` tests `ISO_DATE` inline instead of calling `isIsoDateKey()`

## Gates: baseline → final

| Gate | baseline (setup) | final (iteration 16) |
|---|---|---|
| Backend statements (branch + greenlet) | 72% (71738 stmts / 18376 missed) | 72% (72015 / 18322) |
| Frontend lines | 60.50% | 60.84% (stmts 59.59 → 59.95, branches 55.17 → 55.36, funcs 50.96 → 51.35) |
| Backend tests | 12858 passed, 1 skipped | 12939 passed, 1 skipped |
| Frontend tests | 5529 (391 files) | 5573 (397 files) |
| Known-broken tests | 0 | 0 |
| Golden probes | 10/10 | 10/10 (fe-router re-recorded under T-012, fe-i18n-parity under T-044, both sanctioned) |
| SURFACE.md | frozen | one sanctioned line added (`export function isIsoDateKey`, T-024) |
| ruff / eslint | clean | clean |

Coverage never decreased; no coverage setting was touched (verified against BASE at every iteration).

## Verifier and process notes worth keeping

- Iteration 1 FAILED once: a ruff F841 in a new test, and the shared `fold_text` helper had silently changed the importer from NFD to NFKD (an NBSP boilerplate row was dropped). Fixed with a `form=` parameter and an NBSP characterization test; the re-verify differentially fuzzed 20,027 inputs with zero mismatches.
- The verifier reconstructed T-050's `create_project` by inlining the two extracted helpers and got a line-for-line match against the previous tag.
- Informational leads outside this campaign's scope, not filed: `routes/mfa.py:1176` persists `last_totp_counter` with a flush but no commit (plausible cause of the intermittent TOTP-replay failure under load); T-043's per-key timestamp dict never evicts keys and consumes budget before the outcome is known; behind a reverse proxy on an auth-disabled install all callers share one IP bucket.
- Known load-flakes observed this campaign (all pass alone): PrintModal, FileUploadModal, ArchivesPage, ConfigureAmsSlotModal; backend scheduler dispatch, slicer stall, MFA TOTP replay, and the Aito wake-drain test, whose two residual races were closed by T-015 and T-051.
- PermissionRoute's own `loading` and `!user` lines are structurally unreachable at /aito (ProtectedRoute short-circuits one level up); T-052's cases exercise the outer guard.

## Tasks left for humans

OPEN: none. BLOCKED: none. WONTFIX-AUTO: T-049 (cleanliness duplicate of T-042; the change shipped under T-042). Triaged: the 6 P3 findings above.

## Archive

`refactor-campaign11-archive/` (tracked, committed with this report) holds the complete loop state: PLAN.md, TRIAGE.md, BASELINE.md (parameters, counters, the flaky list, every mid-campaign decision), VERDICTS.log (all 17 verifier verdicts in full), and the 12 retained `findings-audit-<auditor>-r<round>.json` files.

## Merge

Review branch `auto-refactor-loop` in `../bambuddy-refactor` (based on UPSTREAM `466d0be7e`). Main has moved 53 commits since, including Aito work (client tracking page), so expect conflicts in `routes/aito.py`, the Aito tests and `static/`; resolve `static/` by rebuilding, never by hand. Merge with `git merge auto-refactor-loop`; clean up with `git worktree remove --force ../bambuddy-refactor`, then delete the branch and the `loop-*`/`refactor-base` tags.
