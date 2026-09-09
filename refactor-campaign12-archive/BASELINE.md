# BASELINE.md — refactor-loop campaign 12 (AITO + CALCULATOR + TRACKING PAGE)

THE durable memory of this run. NEVER `git add` this file.

## Identity
upstream: 4e8c9e4a454357122dac0daa302278f57925f9b5   # main @ "Merge branch 'auto-refactor-loop'" (campaign 11 merged 2026-09-06)
base: refactor-base            # resolve with `git rev-parse refactor-base` (= c034081e0, the setup commit)
campaign: 12                   # campaigns 1-11 are all merged to main; their loop tags were deleted before
                               # this worktree was cut (verified 2026-09-06: no `loop-*` / `refactor-base`
                               # tag existed), so `git describe --match 'loop-*'` exits nonzero and the
                               # SQUASH+TAG campaign-1 BASE fallback is valid. Iteration tags are plain `loop-N`.
workdir: /Users/paultheis/Documents/Code/bambuddy-refactor
branch: auto-refactor-loop
agents: plugin-namespaced refactor-loop:refactor-worker / refactor-loop:refactor-verifier and the four
        refactor-loop:audit-* auditors (plugin 1.2.0). The MAIN checkout's gitignored .claude/agents/
        refactor-worker.md + refactor-verifier.md are stale older copies, NOT present in this worktree —
        deliberately not used (same decision as campaigns 10 and 11).
campaign_11_leftovers: 6 triaged P3 findings live in refactor-campaign11-archive/TRIAGE.md on main (a
        tracked copy, NOT a plan.py archive — ingest does not dedup against it, so the auditors are
        expected to re-find whatever is still valid and it gets filed fresh here).

## parameters
scope: |
  THE AITO AND CALCULATOR FEATURES INCLUDING THE TRACKING PAGE (user-selected 2026-09-06; campaign 11's
  scope plus the Aito code merged since its base).
  BACKEND (backend/app): api/routes/aito.py (incl. the /track, /tracking-link, /tracking-token, /stats,
    /clients/{id}/history routes), api/routes/calculator.py, api/routes/zoho.py;
    models/aito_event.py, models/aito_project.py, models/aito_task.py, models/aito_tracking_view.py,
    models/calculator.py; schemas/aito.py, schemas/calculator.py; services/aito_*.py (board_rules,
    client_history, events, invoice_sweep, quote_export, quote_import, quote_status, quote_sync,
    shipping, stats, tracking, zoho_comments), services/calculator_insights.py, services/zoho.py,
    services/zoho_filaments.py, services/openrouter.py, services/pushcut.py,
    services/filament_profile_pricing.py.
  FRONTEND (frontend/src): pages/AitoPage.tsx, pages/AitoTrackPage.tsx, pages/AitoFxDemoPage.tsx,
    pages/CalculatorPage.tsx, pages/CalculatorQuotePage.tsx; components/aito/** (82 files, incl.
    ClientHistory, PrintBacklogBadge, TrackingInvoice, TrackingLinkControl, TrackingRail),
    components/calculator/** (22 files), components/CalculatorSettingsPanels.tsx,
    components/ZohoSettings.tsx, components/stats/PipelineWidget.tsx (the Aito pipeline widget only);
    hooks/useAitoPageMutations.ts, hooks/useAitoPresence.ts, hooks/useCalculatorState.ts,
    hooks/useDueDateMutation.ts, hooks/useSettledValue.ts, hooks/useQuotePendingPoll.ts,
    hooks/useQuoteStatusMutation.ts, hooks/useSendQuoteMutation.ts; utils/aito*.ts (aging, backlog,
    board, boardRules, followups, optimistic, search, summary, tracking), utils/archivePricing.ts,
    utils/calculatorInsights.ts, utils/pricing.ts, utils/quoteSummary.ts, utils/shippingDraft.ts,
    utils/shippingLabel.ts.
  SHARED FILES: only their Aito/Calculator slice is in scope (the aito*/calculator*/zoho*/track* methods
    of frontend/src/api/client.ts, the aito/calculator/track i18n keys, core/database.py migrations for
    these tables, core/permissions.py entries for them, the /track/:token + /aito routes in App.tsx, the
    public-route allowlists that admit /api/v1/aito/track/{token}). A task may touch a shared file only
    for that slice.
  TESTS: every backend/tests and frontend/src/__tests__ file covering the above is in scope and writable
    (test_aito_*, test_calculator_*, test_zoho_*, test_openrouter_*, test_pushcut_*, test_filament_profile*,
    test_ws_aito_*; __tests__/{components,pages,hooks,utils}/*Aito*|*aito*|*Calculator*|*calculator*|
    *Zoho*|*Quote*|*Followup*|*Shipping*|*DueDate*|*Track*, __tests__/components/calculator/**).
  OUT OF SCOPE: everything else (printers, archives, library, camera, spoolman, the rest of stats, ...),
    and the loop's own machinery: tools/, PROBES.json, snapshots/, SURFACE.md.
triage: P3                     # work P0/P1/P2; divert only P3 to TRIAGE.md (user-confirmed 2026-09-06, same as campaigns 10/11)
max_iter: 8                    # user-confirmed 2026-09-06; may be raised at a sweep if a round is productive (campaign-11 precedent)
max_rounds: 3
batch: 3
mode: auto
commit_style: grouped
merge_cadence: at-exit

## counters
iteration: 4
round: 2
dry_rounds: 0
dry_decided_round: 0
phase: loop

## commands
build_frontend: cd frontend && npm run build   # VERIFIER ONLY; rewrites tracked static/ — restore with `git checkout -- static && git clean -fdXq -- static`
lint_backend: ruff check backend/ && ruff format --check backend/
lint_frontend: cd frontend && npm run lint
test_backend: ./test_backend.sh            # ruff + pytest -n 30; skips tests/unit/services/test_bambu_ftp.py (pass --full to include)
test_frontend: ./test_frontend.sh          # tsc + eslint + vitest + i18n check
coverage: bash tools/coverage_all.sh [frontend|backend|both]   # WHOLE TREE gate, --cov-config=../pyproject.toml is load-bearing
coverage_as_run: the two commands inside tools/coverage_all.sh run directly, detached, with FULL logs and
  `--timeout=600 -rfE` on the backend (campaign-11 iteration-4 recipe; no coverage setting differs):
  (cd backend && ../venv/bin/python3 -m pytest tests/ -q -n 30 --timeout=600 -rfE --ignore=tests/unit/services/test_bambu_ftp.py --cov=app --cov-config=../pyproject.toml --cov-report=term)
  (cd frontend && npx vitest run --coverage)
snapshots: ./venv/bin/python3 tools/snapshot.py verify
surface: bash tools/gen_surface_all.sh > SURFACE.md && git diff --exit-code SURFACE.md
python: ./venv/bin/python3 (worktree venv — see runtime below). NEVER system python.

## worktree runtime (NOT in git — rebuilt per worktree)
Built 2026-09-06 by APFS clonefile, not pip/npm (network-independent, instant):
  cp -c -R ../bambuddy/venv venv && sed -i '' 's#/Code/bambuddy/venv#/Code/bambuddy-refactor/venv#g' venv/bin/*
  cp -c -R ../bambuddy/frontend/node_modules frontend/node_modules
venv is Python 3.13.12, sys.prefix resolves inside the worktree, pytest 9.0.3 + xdist + cov + timeout.
vitest and tsc resolve from frontend/node_modules/.bin. Workers must NOT pip/npm install.

## security tooling (checked 2026-09-06)
available: semgrep (~/.local/bin), gitleaks (homebrew), pip-audit 2.10.1 (~/.local/bin), bandit (venv/bin), npm audit
missing:   trivy, codeql (the `test_security.sh --full` extras; not installed, not blocking)
Note: test_security.sh needs bash 4 (macOS stock bash 3.2 lacks `declare -A`) — run the scans directly.

## golden probes (10, re-recorded at setup 2026-09-06, 10/10 on replay)
app-openapi-index, app-ddl, app-permissions, app-settings, app-middleware-stack,
app-migrations-index, app-route-perms, fe-router, fe-i18n-parity, fe-money-pure
PROBES.json and tools/ carried unchanged from campaign 11. Six goldens (app-openapi-index, app-ddl,
app-migrations-index, app-route-perms, fe-router, fe-i18n-parity) and SURFACE.md (+40 lines, all
additive) were RE-RECORDED because main moved 55 feature commits + the campaign-11 merge past
campaign 11's base; every diff traced to those features: aito_tracking_views table + tracking_token
column (aito_projects 49->50 cols), migrations 231-232 (tracking) shifting the nl index, GET
/aito/stats + /aito/clients/{id}/history + /aito/track/{token} + tracking-link/-token routes
(AITO_READ 11->12, AITO_UPDATE 16->17), the /track/:token route in App.tsx shifting the router nl
index, +35 i18n keys (7164->7199 in all 13 locales). PYTHONHASHSEED=0 pinned on every Python probe.
Deliberately NOT probed: computeHistoryRate / computeDeltaRate / computeSkuForecasts (read Date.now()).
SURFACE.md's header still says "campaign-9" because tools/gen_surface_all.sh emits it literally.

## coverage baseline (whole tree, campaign-12 gate) — recorded 2026-09-06 at UPSTREAM (worktree @ refactor-base; setup commit touches no source)
backend_statements: 72%           # RATCHET METRIC for the backend. 72379 statements, 18345 missed; 23326 branches, 3136 partial; branch+greenlet ON via --cov-config=../pyproject.toml
backend_tests: 12997 passed, 1 failed (see known_broken), 1 skipped, 456s (coverage run, -n 30, load avg ~55 from the frontend run + peers)
frontend_statements: 60.2%
frontend_branches: 55.6%
frontend_functions: 51.71%
frontend_lines: 61.09%            # RATCHET METRIC for the frontend
frontend_tests: 5636 passed, 1 failed (ArchivesPage toast timeout — known_flaky, see below), 405 files
Context for the ratchet: campaign 11 ended at frontend_lines 60.5% -> and backend 72% ->; the merged main
tree (= UPSTREAM) is what this run measured, since the setup commit touches only loop machinery.

## known_broken — EMPTY at setup (2026-09-06)
(none — the two failures in the baseline run are both wall-clock flakes, listed under known_flaky:)
- backend/tests/unit/services/test_plug_energy_history.py::test_nothing_derivable_before_the_first_midnight
  fails ONLY when the run falls between 22:00 and 22:30 UTC (the test suite pins TZ=Europe/Berlin; the
  test snapshots the counter `now - 30 min`, which lands before Berlin midnight = 22:00 UTC in CEST, so
  the derivation finds a baseline). Reproduced alone at 22:26 UTC (1 failed / 7 passed). OUT OF SCOPE
  (smart plugs) — not filed as a task; a human fix is to freeze `now` in that test. The verifier must
  treat a failure of this one test as pre-existing when the gate ran in that window.

## known_flaky (NOT known_broken — pass in isolation; re-run alone on an IDLE machine before judging)
Carried from campaigns 9/10/11. A failure in one of these is not a regression until it reproduces in
isolation on an idle machine.
- frontend: src/__tests__/pages/ArchivesPage.test.tsx
- frontend: src/__tests__/components/FileUploadModal.test.tsx
- frontend: src/__tests__/components/PrintModal.test.tsx        (the worst offender historically)
- frontend: src/__tests__/components/ModelViewerModal.test.tsx
- frontend: src/__tests__/pages/StatsPageUserFilter1894.test.tsx
- frontend: src/__tests__/components/ConfigureAmsSlotModal.test.tsx
- backend:  tests/integration/test_library_slice_api.py::TestCrossClassSliceAllLoop::test_cross_class_arrange_survives_user_leaving_the_box_unticked
- backend:  tests/unit/services/test_external_camera.py::TestGetFfmpegPath::test_get_ffmpeg_path_from_shutil_which
- backend:  tests/unit/test_aito_quote_sync.py::test_wake_drains_a_pending_project_without_waiting_for_the_interval (narrowed in campaign 11, NOT proven closed)
- backend:  tests/integration/test_mfa_api.py::TestTOTPReplay::test_totp_replay_rejected_on_verify (lead: mfa.py flush-without-commit — OUT OF SCOPE)
- backend:  tests/unit/test_slicer_stall_timeout.py::TestSliceIsNotCutOffWhileProgressing::test_a_slow_slice_that_reports_progress_completes
- backend:  tests/unit/test_scheduler_concurrent_dispatch.py::test_freed_slot_is_refilled_on_the_next_tick
- backend:  tests/unit/services/test_plug_energy_history.py::test_nothing_derivable_before_the_first_midnight (22:00-22:30 UTC window, see known_broken)
- backend:  tests/unit/test_aito_routes.py (thousand-project import; got its own CI timeout in 5580a351e — slow under load)
INVERSE-FLAKY — fail when run ALONE, pass in the full suite (do NOT "confirm" a failure by running alone):
- backend:  tests/unit/test_settings_dedupe_migration.py — its _register_all_models() omits the print_log model.
- frontend: src/__tests__/components/ModelViewerModal.test.tsx > slicer split button (#2725) > "opens the selected local slicer from the Bambuddy dropdown".

## lint baseline
ruff check + ruff format --check: clean (942 files, worktree @ refactor-base, 2026-09-06)
eslint: clean · tsc -b: clean (run on the merged main tree = UPSTREAM, 2026-09-06)

## verifier briefing (campaign 10/11 lessons — repeat every time)
- Tell the verifier explicitly NOT to read PLAN.md, TRIAGE.md, VERDICTS.log, BASELINE.md or findings-audit-*.json.
- The verifier's `npm run build` rewrites the TRACKED static/ bundle: it must run `git checkout -- static && git clean -fdXq -- static` right after the build gate; workers never run `npm run build`.
- Long commands must be `2>&1 | tee log` with NO trailing tail (600 s no-output watchdog). The ORCHESTRATOR runs the coverage gate detached with full logs and hands the verifier the log paths. Check `uptime` for peer load before dispatching; resume a stalled agent via SendMessage rather than re-launching.
- From iteration 2 on, the verifier is briefed with the previous `loop-N` tag as its DIFF base (whole-tree gates unchanged); refactor-base remains the campaign BASE for squash fallback and the final report.
- Backend gate always carries `--timeout=600 -rfE` so a hung test fails by name.

## mid-campaign approvals log (decisions that are not derivable from PLAN.md alone)
- 2026-09-06 setup: user chose merge-campaign-11-then-fresh-campaign-12, scope Aito+Calculator (incl. tracking page), campaign-11 parameters.
- 2026-09-06 ROUND-1 approval sweep (N=0): user APPROVED T-003 NARROWED to a dedup window only (no per-IP rate limit, no 429 — the auditors' full proposal was declined), T-004 NARROWED to Cache-Control: no-store only (endpoint stays GET, mint-on-read side effect kept — the POST conversion was declined), T-010 as proposed. T-008 (robustness duplicate of T-003) set WONTFIX-AUTO as folded. Round 1: 9 filed (4 blocked -> 3 approved + 1 folded), 3 triaged (T-005 PDF no-store, T-011 rate-limit dict eviction, T-012 usePrintBlob unmount guard).
- Orchestrator note: this session has no TodoWrite tool; the dashboard (`plan.py render`) is the progress mirror.
- 2026-09-06 iteration 3 PASS -> loop-3; round 1's plan exhausted (8/8 workable DONE, T-008 folded). Entering RESURVEY round 2 (N stays 3).
- 2026-09-06 ROUND-2 panel (N=3): cleanliness 1 new; security 2 new (both blocked); robustness 3 new (1 blocked) + 1 triaged; tests 4 new + 1 triaged. Total 10 new (7 workable + 3 blocked), 2 triaged. Approval sweep: user APPROVED T-014 (calculator reads user-token only) and T-015 (drop tracking_url from board responses; openapi golden re-record), DENIED T-017 (drag 409 guard — too large for this loop; feature-branch lead) -> WONTFIX-AUTO. Round 2 PRODUCTIVE: dry_rounds stays 0; N -> 4. 9 workable tasks = iterations 4-6 at BATCH 3, inside MAX_ITER 8.
- 2026-09-06 audit-tests round-2 observation for humans: the whole-tree frontend coverage text table (c12-gate3-frontend-full.log) omits ~18 of 55 src/hooks files that DO have passing dedicated tests (useOptimisticBoardMutation, useDueDateMutation, useQuoteStatusMutation, useSendQuoteMutation, useAitoPresence, useSettledValue, useQuotePendingPoll ...); standalone --coverage.include runs give sane numbers. Looks like a v8 merge/report artifact; the "All files" ratchet row is consistent run-to-run (61.09 -> 61.1) so the gate still holds, but do not read a file's ABSENCE from that table as 0%.
