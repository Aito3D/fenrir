# BASELINE.md — refactor-loop campaign 11 (AITO + CALCULATOR)

THE durable memory of this run. NEVER `git add` this file.

## Identity
upstream: 466d0be7e6a7403b1f45b668adaf81a3ac50b631   # main @ "chore(build): rebuild static bundle after the campaign-10 merge; archive campaign 10 verdicts"
base: refactor-base            # resolve with `git rev-parse refactor-base` (set at SETUP 6b)
campaign: 11                   # campaigns 1-10 are all merged to main; their loop tags were deleted.
                               # Verified at setup (2026-09-05): no `loop-*` or `refactor-base` tag
                               # existed before this campaign (campaign 10's were deleted right after
                               # its merge, commit 666f416dd), so `git describe --match 'loop-*'`
                               # exits nonzero and the SQUASH+TAG campaign-1 BASE fallback is valid.
                               # Iteration tags are plain `loop-N`.
workdir: /Users/paultheis/Documents/Code/bambuddy-refactor
branch: auto-refactor-loop
agents: plugin-namespaced refactor-loop:refactor-worker / refactor-loop:refactor-verifier and the
        four refactor-loop:audit-* auditors (plugin 1.2.0). The MAIN checkout's gitignored
        .claude/agents/refactor-worker.md + refactor-verifier.md are stale older copies and are
        NOT present in this worktree — deliberately not used (same decision as campaign 10).
campaign_10_leftovers: 9 OPEN tasks (T-023, T-032..T-039 — 8 audit-tests P2s on untested mutation
        hooks / sync-loop swallows + the ZohoSettings htmlFor P3) and 7 triaged findings live in
        refactor-campaign10-archive/{PLAN,TRIAGE}.md on main. That archive is NOT a plan.py archive,
        so ingest does not dedup against it: the auditors are expected to re-find whatever is still
        valid and it gets filed fresh here.

## parameters
scope: |
  THE AITO AND CALCULATOR FEATURES (user-selected 2026-09-05, same scope as campaign 10).
  BACKEND (backend/app): api/routes/aito.py, api/routes/calculator.py, api/routes/zoho.py;
    models/aito_event.py, models/aito_project.py, models/aito_task.py, models/calculator.py;
    schemas/aito.py, schemas/calculator.py; services/aito_*.py (board_rules, events, invoice_sweep,
    quote_export, quote_import, quote_status, quote_sync, shipping, zoho_comments),
    services/calculator_insights.py, services/zoho.py, services/zoho_filaments.py,
    services/openrouter.py, services/pushcut.py, services/filament_profile_pricing.py.
  FRONTEND (frontend/src): pages/AitoPage.tsx, pages/AitoFxDemoPage.tsx, pages/CalculatorPage.tsx,
    pages/CalculatorQuotePage.tsx; components/aito/** (77 files), components/calculator/** (22 files),
    components/CalculatorSettingsPanels.tsx, components/ZohoSettings.tsx; hooks/useAitoPageMutations.ts,
    hooks/useAitoPresence.ts, hooks/useCalculatorState.ts, hooks/useDueDateMutation.ts,
    hooks/useSettledValue.ts, hooks/useQuotePendingPoll.ts, hooks/useQuoteStatusMutation.ts,
    hooks/useSendQuoteMutation.ts; utils/aito*.ts (aging, board, boardRules, followups, optimistic,
    search, summary), utils/archivePricing.ts, utils/calculatorInsights.ts, utils/pricing.ts,
    utils/quoteSummary.ts, utils/shippingDraft.ts, utils/shippingLabel.ts.
  SHARED FILES: only their Aito/Calculator slice is in scope (the aito*/calculator*/zoho* methods of
    frontend/src/api/client.ts, the aito/calculator i18n keys, core/database.py migrations for these
    tables, core/permissions.py entries for them). A task may touch a shared file only for that slice.
  TESTS: every backend/tests and frontend/src/__tests__ file covering the above is in scope and
    writable (test_aito_*, test_calculator_*, test_zoho_*, test_openrouter_*, test_pushcut_*,
    test_filament_profile*, test_ws_aito_*; __tests__/{components,pages,hooks,utils}/*Aito*|*aito*|
    *Calculator*|*calculator*|*Zoho*|*Quote*|*Followup*|*Shipping*|*DueDate*, __tests__/components/calculator/**).
  OUT OF SCOPE: everything else (printers, archives, library, camera, spoolman, stats, ...), and the
    loop's own machinery: tools/, PROBES.json, snapshots/, SURFACE.md.
triage: P3                     # work P0/P1/P2; divert only P3 to TRIAGE.md. Same as campaign 10 (user-confirmed there 2026-09-03; carried forward unchanged for the same scope).
max_iter: 16                    # raised 8->12 at the round-2 sweep and 12->16 at the round-3 sweep (2026-09-06); MAX_ROUNDS (3) is now the terminating cap
max_rounds: 3
batch: 3
mode: auto
commit_style: grouped
merge_cadence: at-exit

## counters
iteration: 16
round: 3
dry_rounds: 0
dry_decided_round: 0
phase: exited

## commands
build_frontend: cd frontend && npm run build
lint_backend: ruff check backend/ && ruff format --check backend/
lint_frontend: cd frontend && npm run lint
test_backend: ./test_backend.sh            # ruff + pytest -n 30; skips tests/unit/services/test_bambu_ftp.py (pass --full to include)
test_frontend: ./test_frontend.sh          # tsc + eslint + vitest + i18n check
coverage: bash tools/coverage_all.sh [frontend|backend|both]   # WHOLE TREE gate, --cov-config=../pyproject.toml is load-bearing (see campaign 10)
snapshots: ./venv/bin/python3 tools/snapshot.py verify
surface: bash tools/gen_surface_all.sh > SURFACE.md && git diff --exit-code SURFACE.md
python: ./venv/bin/python3 (worktree venv — see runtime below). NEVER system python.

## worktree runtime (NOT in git — rebuilt per worktree)
Built 2026-09-05 by APFS clonefile, not pip/npm (network-independent, instant):
  cp -c -R ../bambuddy/venv venv && sed -i '' 's#/Code/bambuddy/venv#/Code/bambuddy-refactor/venv#g' venv/bin/*
  cp -c -R ../bambuddy/frontend/node_modules frontend/node_modules
venv is Python 3.13.12 (bin/python3 -> python3.13; pyvenv.cfg's 3.14 `home` is the main venv's
leftover, harmless), sys.prefix resolves inside the worktree, pytest 9.0.3 + xdist + cov import.
vitest 4.1.8, tsc 5.9.3 resolve from frontend/node_modules/.bin. Workers must NOT pip/npm install.

## security tooling (checked 2026-09-05)
available: semgrep (~/.local/bin), gitleaks (homebrew), pip-audit (~/.local/bin), bandit (venv/bin), npm audit (npm 11.9.0)
missing:   trivy, codeql (the `test_security.sh --full` extras; not installed, not blocking)
Note: test_security.sh needs bash 4 (macOS stock bash 3.2 lacks `declare -A`) — run the scans directly.

## golden probes (10, re-recorded at setup 2026-09-05, 10/10 on replay #1; replay #2 below)
app-openapi-index, app-ddl, app-permissions, app-settings, app-middleware-stack,
app-migrations-index, app-route-perms, fe-router, fe-i18n-parity, fe-money-pure
Carried from campaign 10 (PROBES.json unchanged). Six goldens (app-openapi-index, app-ddl,
app-migrations-index, app-route-perms, fe-i18n-parity, fe-money-pure) and SURFACE.md were
RE-RECORDED at setup because main moved 56 commits past campaign 10's base; every diff traced to
feature commits merged after it: PATCH /aito/{id}/due-date (+AitoDueDateUpdate), the rush
surcharge column/migration (+rush_pct/margin_rush in the money probe, +1 calculator_defaults col),
aito_projects 43->49 cols, aito_tasks 31->32, +25 i18n keys (7152->7177), sweep_invoices,
follow-ups/shipping-label/due-date exports in utils+hooks, setAitoProjectDueDate client method.
SURFACE.md's header still says "campaign-9" because tools/gen_surface_all.sh emits it literally.
PYTHONHASHSEED=0 is pinned on every Python probe. Deliberately NOT probed: computeHistoryRate /
computeDeltaRate / computeSkuForecasts (read Date.now(); would drift daily).
replay_2: 10/10 on the idle machine after the coverage baseline (2026-09-05). BASE = refactor-base -> 754ad41d8.

## coverage baseline (whole tree, campaign-11 gate) — recorded 2026-09-05 at UPSTREAM
frontend_statements: 59.59%
frontend_branches: 55.17%
frontend_functions: 50.96%
frontend_lines: 60.5%             # RATCHET METRIC for the frontend
frontend_tests: 5529 passed (391 files), 0 failed in the baseline coverage run
backend_statements: 72%           # RATCHET METRIC for the backend. 71956 statements, 18367 missed; 23258 branches, 3131 partial; branch+greenlet ON via --cov-config=../pyproject.toml
backend_tests: 12858 passed, 1 skipped, 538s (coverage run, -n 30)
Context for the ratchet: campaign 10 ended at frontend_lines 60.29%-> and backend 72%->; the full
suites on the merged main tree (identical to UPSTREAM) passed 2026-09-05: backend 12858 passed,
1 skipped; frontend 5528/5529 with the single failure (ArchivesPage toast timeout) passing 43/43 alone.

## known_broken — EMPTY at setup (2026-09-05)
(none — both suites green on UPSTREAM; see coverage context above)

## known_flaky (NOT known_broken — pass in isolation; re-run alone on an IDLE machine before judging)
Carried from campaigns 9/10 plus this setup's observation. A failure in one of these is not a
regression until it reproduces in isolation on an idle machine.
- frontend: src/__tests__/pages/ArchivesPage.test.tsx          (failed once this setup under parallel load; 43/43 alone)
- frontend: src/__tests__/components/FileUploadModal.test.tsx
- frontend: src/__tests__/components/PrintModal.test.tsx        (the worst offender historically)
- frontend: src/__tests__/components/ModelViewerModal.test.tsx
- frontend: src/__tests__/pages/StatsPageUserFilter1894.test.tsx
- backend:  tests/integration/test_library_slice_api.py::TestCrossClassSliceAllLoop::test_cross_class_arrange_survives_user_leaving_the_box_unticked
- backend:  tests/unit/services/test_external_camera.py::TestGetFfmpegPath::test_get_ffmpeg_path_from_shutil_which
- backend:  tests/unit/test_aito_quote_sync.py::test_wake_drains_a_pending_project_without_waiting_for_the_interval (campaign-10 T-032; campaign-11 T-015 reordered the refresh after the session drain 2026-09-05 — narrowed, NOT proven closed: flaked once more under peer load ~24 in the iteration-3 gate)
- backend:  tests/integration/test_mfa_api.py::TestTOTPReplay::test_totp_replay_rejected_on_verify (NEW 2026-09-06 iteration-10 gate under load; 154/154 alone; verifier lead: mfa.py:1176 flush-without-commit — OUT OF SCOPE, for humans)
- frontend: src/__tests__/components/ConfigureAmsSlotModal.test.tsx (NEW 2026-09-06 iteration-15 gate; expected -1 to be 15; 37/37 alone)
- backend:  tests/unit/test_slicer_stall_timeout.py::TestSliceIsNotCutOffWhileProgressing::test_a_slow_slice_that_reports_progress_completes (NEW 2026-09-05 iteration-3 gate under peer load ~24; wall-clock progress timing; 18/18 alone)
- backend:  tests/unit/test_scheduler_concurrent_dispatch.py::test_freed_slot_is_refilled_on_the_next_tick (NEW 2026-09-05 iteration-1 verify under peer load ~20; real asyncio.sleep overlap assertions; 4/4 alone)
INVERSE-FLAKY — fail when run ALONE, pass in the full suite (do NOT "confirm" a failure by running alone):
- backend:  tests/unit/test_settings_dedupe_migration.py — its _register_all_models() omits the
  print_log model, so it only works once another test has imported that model into Base.metadata.
- frontend: src/__tests__/components/ModelViewerModal.test.tsx > slicer split button (#2725) >
  "opens the selected local slicer from the Bambuddy dropdown" — deterministic failure alone.

## lint baseline
ruff check + ruff format --check: clean (test_backend.sh on UPSTREAM, 2026-09-05)
eslint + tsc -b: clean (test_frontend.sh + npm run build on UPSTREAM, 2026-09-05)

## verifier briefing addendum (campaign-10 lesson)
Tell the verifier explicitly NOT to read PLAN.md, TRIAGE.md, VERDICTS.log, BASELINE.md or
findings-audit-*.json: blindness is only enforced via `git diff`, and campaign 10's verifier once
cited a PLAN.md line.

## verifier gotcha found in iteration 1 (2026-09-05)
The verifier's mandated `cd frontend && npm run build` rewrites the TRACKED static/ bundle in the
worktree (61 tracked deletions + new ignored hashed assets). Orchestrator restores it after every
verify with `git checkout -- static && git clean -fdXq -- static`; brief the verifier to run that
restore itself right after the build gate, and brief workers never to run `npm run build`.

## verifier watchdog lesson (iteration 1 re-verify, 2026-09-05 ~19:15)
The verifier stalled at the 600s no-output watchdog: a PEER session (loki-refactor, its own
refactor loop) was running vitest --coverage on the same Mac (load avg ~46), and the briefing's
`2>&1 | tee log | tail -25` pipe buffers everything until the end, so the agent streamed nothing.
Fix applied from here on: (1) the ORCHESTRATOR runs tools/coverage_all.sh detached
(nohup ... > /tmp/c11-cov-*.log; touch /tmp/c11-cov-DONE) with a Monitor on the marker, and
hands the verifier the log paths; (2) any long command an agent runs must be `2>&1 | tee log`
with NO trailing tail; (3) check `uptime` / `ps` for peer-session load before dispatching.
Resume a stalled agent via SendMessage rather than re-launching — read-only agents lose nothing.

## coverage gate as actually run from iteration 4 on (full logs, detached)
tools/coverage_all.sh pipes pytest through `tail -15` and vitest through a summary grep, so
tracebacks and failing test names were lost in iterations 1-3. From iteration 4 the orchestrator
runs the same two commands directly, detached via nohup, writing FULL output to
/tmp/c11-cov-backend-full.log and /tmp/c11-cov-frontend-full.log (summaries grep'd into
/tmp/c11-cov-backend.log / -frontend.log, marker /tmp/c11-cov-DONE, then `git checkout -- static
&& git clean -fdXq -- static`), and briefs the verifier with those paths. Same coverage settings,
same --cov-config, same --ignore; only the logging differs.

## iteration-5 gate hang (2026-09-05 ~22:26-23:12)
The first iteration-5 backend gate hung at 99%: one xdist worker spun at ~99% CPU for >45 min
while the other 29 idled; a Time Machine backup (backupd-helper) + Spotlight (mds,
spotlightknowledged) + peer sessions pushed the load average to ~130. Killed (it was ours) and
relaunched with `--timeout=600 -rfE` (pytest-timeout is in the venv) so a hung test fails by
name instead of stalling the gate. From here on the backend gate command always carries
`--timeout=600 -rfE`; it changes no coverage setting. The hung test's identity was lost (no
py-spy installed; `-q` output is dots only).

## verifier base note
From iteration 2 on, the verifier is briefed with the previous `loop-N` tag as its DIFF base (whole-tree gates unchanged); refactor-base remains the campaign BASE for squash fallback and the final report.

## mid-campaign approvals log (decisions that are not derivable from PLAN.md alone)
- 2026-09-06 EXIT preservation decision (asked early, during iteration 15): user chose "Archive everything on the branch" — PLAN.md, TRIAGE.md, BASELINE.md, VERDICTS.log and the 12 findings-audit-*.json go into a tracked refactor-campaign11-archive/ in the final-report commit (VERDICTS.log needs `git add -f`: *.log is gitignored).
- 2026-09-06 ROUND-3 approval sweep (N=12): user APPROVED T-041 (P1 close evicted sockets), T-042 (P1 broadcast_to_user via _fan_out), T-043 (P3 rate-limit OpenRouter routes), T-044 (P2 delete 13 dead i18n keys + fe-i18n-parity re-record). T-049 (cleanliness duplicate of T-042) set WONTFIX-AUTO as folded. Round 3 = PRODUCTIVE (11 new incl. 5 blocked; 2 triaged); dry_rounds stays 0. User raised MAX_ITER 12 -> 16; round 3 is the last round (MAX_ROUNDS 3), so the campaign ends on the round cap after these tasks.
- 2026-09-06 T-030 (security, filed behavior_change:false): orchestrator flagged that stamping aito_read before admit + tightening the missing-stamp default to False closes a connect-window in which a principal without aito:read could receive Aito broadcasts; user APPROVED it as a behavior change (changelog entry required) rather than risk a verifier FAIL.
- 2026-09-06 iteration 9: T-031 (security, stamp the slot on a commit failure) is FOLDED INTO T-027's worker run (one commit, one changelog entry "T-027 + T-031") because T-027's guarded commit subsumes its failure mode; T-031 was never selected by plan.py and is marked DONE by hand right after T-027 lands.
- 2026-09-06 T-024 (shared ISO_DATE, filed behavior_change:false by audit-cleanliness): orchestrator flagged that the clean fix adds one `export` to utils/aitoAging.ts = SURFACE.md change; user APPROVED the surface-only change (re-record SURFACE.md in the same commit + changelog entry; no runtime behavior change).
- 2026-09-06 ROUND-2 approval sweep (N=7): user APPROVED all 4 round-2 behavior changes — T-028 (P1 broadcast_aito snapshot+timeout), T-027 (guard per-project sweep commit), T-026 (sweep order_by least-recently-checked), T-031 (stamp hourly gate on commit failure; subsumed by T-027 — the worker folds it). 0 denied. Round 2 = PRODUCTIVE (16 new incl. 4 approved; 1 triaged); dry_rounds stays 0. User raised MAX_ITER 8 -> 12 at the same sweep.
- 2026-09-05 SETUP approval sweep (N=0): user APPROVED all 9 round-1 behavior changes — T-001 (ZohoSettings htmlFor/id), T-006/T-007/T-010 (invoice sweep: 429 break+throttle, clear cache on no invoice, per-project commit), T-008/T-009 (follow-ups ISO check, re-age timer), T-011/T-012/T-013 (presence aito_read gate, /aito PermissionRoute, invoice-PDF filename strip). 0 denied. Each must ship with its BASELINE-CHANGELOG.md entry + any golden/SURFACE re-record in the same commit, subject containing "(user-approved behavior change)".

## EXIT — 2026-09-06
reason: MAX_ROUNDS (round 3 = MAX_ROUNDS 3 reached at the RESURVEY cap check after iteration 16; the plan was exhausted: 46/47 DONE, 0 OPEN, 0 BLOCKED, 1 WONTFIX-AUTO (T-049, folded into T-042), 6 triaged). Iterations run: 16 (loop-1..loop-16). 18 changelog entries covering 23 approved task ids. Final coverage: backend 72% (72015/18322/23254/3135) vs 72% baseline; frontend lines 60.84 vs 60.5 baseline.
