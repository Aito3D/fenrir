# BASELINE.md — refactor-loop campaign 10 (WHOLE REPO)

THE durable memory of this run. NEVER `git add` this file.

## Identity
upstream: fa365ca83e060715a399ca68ef5b524adb992efb   # main @ "chore: rebuild static bundle for merged main; archive campaign 9 records" (campaign-9 merge, on origin)
base: refactor-base            # resolve with `git rev-parse refactor-base` -> b026f3f4a
campaign: 10                   # campaigns 1-9 are all merged to main; their loop tags were deleted.
                               # Verified at setup (2026-09-03): no `loop-*` or `refactor-base` tag
                               # existed before this campaign, so `git describe --match 'loop-*'`
                               # exits nonzero and the SQUASH+TAG campaign-1 BASE fallback is valid.
                               # Iteration tags are plain `loop-N`.
workdir: /Users/paultheis/Documents/Code/bambuddy-refactor
branch: auto-refactor-loop
agents: plugin-namespaced refactor-loop:refactor-worker / refactor-loop:refactor-verifier and the
        four refactor-loop:audit-* auditors (plugin 1.2.0). The repo's .claude/agents/refactor-worker.md
        and refactor-verifier.md are STALE OLDER copies (no BASELINE-CHANGELOG / SANCTIONED handling,
        verifier still does a security+quality survey) — deliberately NOT used. Campaign 9's VERDICTS.log
        shows SANCTIONED_CHANGES lines, i.e. it used the plugin verifier too.

## parameters
scope: |
  THE AITO AND CALCULATOR FEATURES (user re-invoked the loop with "Focus on Aito and Calculator
  feature" during setup, 2026-09-03, superseding the whole-repo scope confirmed minutes earlier).
  BACKEND (backend/app): api/routes/aito.py, api/routes/calculator.py, api/routes/zoho.py;
    models/aito_event.py, models/aito_project.py, models/aito_task.py, models/calculator.py;
    schemas/aito.py, schemas/calculator.py; services/aito_*.py (board_rules, events, quote_export,
    quote_import, quote_status, quote_sync, shipping, zoho_comments), services/calculator_insights.py,
    services/zoho.py, services/zoho_filaments.py, services/openrouter.py, services/pushcut.py,
    services/filament_profile_pricing.py.
  FRONTEND (frontend/src): pages/AitoPage.tsx, pages/AitoFxDemoPage.tsx, pages/CalculatorPage.tsx,
    pages/CalculatorQuotePage.tsx; components/aito/**, components/calculator/**,
    components/CalculatorSettingsPanels.tsx, components/ZohoSettings.tsx; hooks/useAitoPageMutations.ts,
    hooks/useAitoPresence.ts, hooks/useCalculatorState.ts, hooks/useSettledValue.ts,
    hooks/useQuotePendingPoll.ts, hooks/useQuoteStatusMutation.ts, hooks/useSendQuoteMutation.ts;
    utils/aito*.ts, utils/calculatorInsights.ts, utils/pricing.ts, utils/quoteSummary.ts.
  SHARED FILES: only their Aito/Calculator slice is in scope (the aito*/calculator*/zoho* methods of
    frontend/src/api/client.ts, the aito/calculator i18n keys, core/database.py migrations for these
    tables, core/permissions.py entries for them). A task may touch a shared file only for that slice.
  TESTS: every backend/tests and frontend/src/__tests__ file covering the above is in scope and
    always writable.
  OUT of scope: everything else in the app, and always the loop's own machinery -- tools/,
  PROBES.json, snapshots/, SURFACE.md -- plus static/ (vendored build bundle) and
  refactor-campaign9-archive/ (historical record). Campaign 9's 11 open leftovers are ALL outside
  this scope and are deliberately not carried into this campaign.
  GATE NOTE: the verifier's gates (goldens, SURFACE.md, coverage ratchet) stay WHOLE-APP -- a strict
  superset of the scope, kept from the whole-repo setup; nothing was re-baselined for the narrowing.
triage: P3                     # work P0/P1/P2; divert only P3 to TRIAGE.md. (user-confirmed 2026-09-03)
max_iter: 8
max_rounds: 3
batch: 3
mode: auto
commit_style: grouped
merge_cadence: at-exit

## counters
iteration: 8
round: 2
dry_rounds: 0
dry_decided_round: 0
phase: exited

## commands
build_frontend: cd frontend && npm run build
lint_backend: ruff check backend/ && ruff format --check backend/
lint_frontend: cd frontend && npm run lint
test_backend: ./test_backend.sh            # ruff + pytest -n 30; skips tests/unit/services/test_bambu_ftp.py (pass --full to include)
test_frontend: ./test_frontend.sh          # tsc + eslint + vitest
coverage: bash tools/coverage_all.sh [frontend|backend|both]
snapshots: ./venv/bin/python3 tools/snapshot.py verify
surface: bash tools/gen_surface_all.sh > SURFACE.md && git diff --exit-code SURFACE.md
NOTE: `.coverage` (backend coverage data file) is TRACKED in git. Every backend coverage run rewrites it.
Never stage it; `git checkout -- .coverage` after a coverage run so the tree stays clean.

## worktree runtime (NOT in git — rebuilt per worktree)
A fresh worktree has NO venv and NO node_modules. Setup created both:
  python3 -m venv venv && ./venv/bin/python3 -m pip install -r requirements.txt
  ./venv/bin/python3 -m pip install pytest-xdist pytest-cov pytest-timeout pytest-split coverage bandit pip-audit
  cd frontend && npm ci
requirements.txt does NOT contain pytest-xdist; test_backend.sh runs `pytest -n 30`, so without the
extras the backend suite dies with "unrecognized arguments: -n" -- a missing dep, not a broken suite.

## coverage baseline (whole tree, campaign-10 gate) — recorded 2026-09-03 at UPSTREAM
frontend_statements: 59.37%
frontend_branches: 54.92%
frontend_functions: 50.73%
frontend_lines: 60.29%         # RATCHET METRIC for the frontend
frontend_tests: 5430 (382 files); 1 load-flake in the baseline run (FileUploadModal, passed 2/2 alone)
backend_statements: 72%          # 71738 statements, 18376 missed; 23196 branches, 3130 partial; branch+greenlet ON. RATCHET METRIC for the backend. 12685 passed, 1 skipped, 333s. (First run WITHOUT the config read 64% -- see the correction section.)
JITTER WARNING (carried from campaign 9): the frontend number moves ~+-0.1pp run to run because
flaky tests that fail do not execute their code. A drop inside that band is NOT evidence of a
regression -- re-run on an idle machine first. A drop beyond it is real.
Two settings are load-bearing and frozen (weakening either = protocol violation):
  * pyproject.toml [tool.coverage.run] concurrency = ["greenlet", "thread"]  (without it async
    route bodies read as unexecuted; routes/aito.py once reported 61.77% instead of ~97%)
  * frontend/vitest.config.ts coverage.include = ['src/**/*.{ts,tsx}'] (whole tree), plus its
    exclude of 'src/**/*.d.ts' and reportOnFailure: true — both pre-existing since campaign 9.

## security tooling (checked 2026-09-03)
available: semgrep (~/.local/bin), gitleaks (homebrew), pip-audit 2.10.1 (~/.local/bin and venv), bandit 1.9.4 (venv), npm audit (npm 11.9.0)
missing:   trivy (not installed; CodeQL/Trivy are the `test_security.sh --full` extras)
NETWORK CAVEAT: on setup day pypi.org and github.com SSH timed out intermittently (pip could not
resolve fastapi; the worktree venv was cloned OFFLINE from ../bambuddy/venv, see below). pip-audit
and npm audit both need the network; if they fail to reach their advisory DBs, record "not run
(network)" rather than "clean". ./test_security.sh needs bash 4 (`declare -A`); macOS stock bash is
3.2, so run the scanners directly.

## worktree venv — HOW IT WAS ACTUALLY BUILT (offline clone, not pip)
pypi was unreachable, so: /opt/homebrew/opt/python@3.13/bin/python3.13 -m venv venv, then
rsync of ../bambuddy/venv/lib/python3.13/site-packages/ into venv/lib/python3.13/site-packages/,
plus the main venv's bin/ scripts with shebangs rewritten. The main venv is a Python 3.13 venv
(bin/python3 -> python3.13; its lib/python3.14 layer is a partial leftover — ignore it).
Consequence: the worktree venv is isolated (a worker's `pip install` cannot touch the dev venv),
but workers must NOT rely on installing new packages while the network is flaky.

## golden probes (10, all verified stable across 3 consecutive replays at setup)
app-openapi-index, app-ddl, app-permissions, app-settings, app-middleware-stack,
app-migrations-index, app-route-perms, fe-router, fe-i18n-parity, fe-money-pure
Carried over from campaign 9 (same whole-repo scope). Four goldens (app-openapi-index,
app-settings, app-route-perms, fe-i18n-parity) and SURFACE.md were RE-RECORDED at setup because
main moved past campaign 9's base: every diff traced to feature commits merged after it (Aito
pickup-SMS route/service/i18n keys, price provenance, camera wall). SURFACE.md's header still
says "campaign-9" because tools/gen_surface_all.sh emits it literally; the content is campaign 10's.
PYTHONHASHSEED=0 is pinned on every Python probe (FastAPI operationId derives from an unordered
method set). Deliberately NOT probed: computeHistoryRate / computeDeltaRate / computeSkuForecasts
(read Date.now(); would drift daily).

## known_broken — EMPTY at setup (2026-09-03)
- frontend: NONE. Baseline run: 5429 passed, 1 failed (FileUploadModal "surfaces a per-file hashing
  failure instead of silently dropping it", a 5s timeout) -> passed 2/2 alone. Load-flaky, not broken.
- backend:  NONE. Baseline run: 12685 passed, 1 skipped, 0 failed (324s, -n 30).

## known_flaky (NOT known_broken — pass in isolation; re-run alone on an IDLE machine before judging)
Carried from campaign 9 plus this setup's observation. A failure in one of these is not a regression
until it reproduces in isolation on an idle machine.
- frontend: src/__tests__/components/FileUploadModal.test.tsx  (NEW this campaign; failed once in the
  baseline coverage run while pip/npm installs were running; 44/44 twice alone)
- frontend: src/__tests__/components/PrintModal.test.tsx        (the worst offender historically)
- frontend: src/__tests__/components/ModelViewerModal.test.tsx
- frontend: src/__tests__/pages/StatsPageUserFilter1894.test.tsx
- frontend: src/__tests__/pages/ArchivesPage.test.tsx
- backend:  tests/integration/test_library_slice_api.py::TestCrossClassSliceAllLoop::test_cross_class_arrange_survives_user_leaving_the_box_unticked
- backend:  tests/unit/services/test_external_camera.py::TestGetFfmpegPath::test_get_ffmpeg_path_from_shutil_which
- backend:  tests/unit/test_aito_quote_sync.py::test_wake_drains_a_pending_project_without_waiting_for_the_interval
INVERSE-FLAKY — fail when run ALONE, pass in the full suite (do NOT "confirm" a failure by running alone):
- backend:  tests/unit/test_settings_dedupe_migration.py — "no such table: print_log_entries" (3 failed,
  1 passed alone at this setup, 0 failed in the full run). Its _register_all_models() omits the
  print_log model, so it only works once another test has imported that model into Base.metadata.
- frontend: src/__tests__/components/ModelViewerModal.test.tsx > slicer split button (#2725) >
  "opens the selected local slicer from the Bambuddy dropdown" — deterministic failure alone.

## coverage gate — CORRECTION found at setup (the reason tools/coverage_all.sh was patched pre-BASE)
The first backend run reported TOTAL 64% with NO Branch columns. Cause: pytest-cov's default
`--cov-config=.coveragerc` is resolved from the CWD (backend/), so the root pyproject.toml
[tool.coverage.run] block (branch=true, concurrency=[greenlet,thread]) was silently ignored —
exactly the greenlet blind spot the block exists to fix. `coverage debug config` from backend/
shows `config_file: None`; with `--cov-config=../pyproject.toml` it reads the root file and the
Branch/BrPart columns appear. tools/coverage_all.sh now passes that flag (in the setup commit).
Anyone running pytest-cov by hand from backend/ MUST pass `--cov-config=../pyproject.toml` or the
number is not comparable to the baseline.
Cosmetic: the cloned venv's copied .pyc files carry co_filename paths pointing at ../bambuddy/venv,
so warnings/tracebacks from site-packages print the MAIN venv's path. sys.path is worktree-only
(verified); app code is never in the venv, so coverage is unaffected.

## mid-campaign approvals log (decisions that are not derivable from PLAN.md alone)
- 2026-09-03 iteration 6: T-026 first attempt returned BLOCKED (no existing column can mark "Books confirmed the decision").
  USER APPROVED adding `quote_status_confirmed` (Boolean NOT NULL DEFAULT 0) to aito_projects + an ALTER TABLE migration in
  core/database.py, with a sanctioned re-record of ONLY app-ddl and app-migrations-index goldens (+ SURFACE.md DB-tables
  column count). Column stays internal (not in any response schema; app-openapi-index must NOT change). Re-dispatch T-026
  with that mandate after T-030 commits.

## EXIT — 2026-09-04
reason: MAX_ITER (iteration 9 would exceed 8). Round 3 never ran. 9 OPEN tasks left; 0 BLOCKED; 0 WONTFIX-AUTO; 7 triaged.
final tags: refactor-base, loop-1..loop-8. Final report + refactor-campaign10-archive/ committed as the last commit.
