# BASELINE.md — refactor-loop campaign 9 (WHOLE REPO)

THE durable memory of this run. NEVER `git add` this file.

## Identity
upstream: 2e3fd8f53219216a7ce09fc76931dc97474abdcb   # main @ "Merge branch 'auto-refactor-loop'" (the campaign-8 merge, pushed to origin)
base: refactor-base            # resolve with `git rev-parse refactor-base` -> 3f108dac1
campaign: 9                    # campaigns 1-8 are all merged to main; their loop tags were deleted.
                               # Verified at setup: no `loop-*` or `refactor-base` tag existed before
                               # this campaign tagged BASE, so `git describe --match 'loop-*'` exits
                               # nonzero and the SQUASH+TAG campaign-1 BASE fallback is valid here.
                               # Iteration tags are plain `loop-N`.
workdir: /Users/paultheis/Documents/Code/bambuddy-refactor
branch: auto-refactor-loop

## parameters
scope: |
  THE WHOLE REPOSITORY. Campaigns 4/6/8 each narrowed to one feature; campaign 9
  deliberately does not. Every auditor surveys all of backend/app and all of
  frontend/src, and a task may name any production file in either tree (plus any
  test file covering them, which is always writable per the skill's SCOPE rule).
  OUT of scope, as always: the loop's own machinery -- tools/, PROBES.json,
  snapshots/, SURFACE.md. No auditor may file a finding against those.
  Note this repo also vendors a built frontend bundle in static/; it is build
  output, not source, and no task should edit it by hand.
triage: P3                     # work P0/P1/P2; divert only P3 to TRIAGE.md.
max_iter: 8
max_rounds: 3
batch: 3
mode: auto
commit_style: grouped
merge_cadence: at-exit

## counters
iteration: 8
round: 1
dry_rounds: 0
dry_decided_round: 0
phase: loop

## commands
build_frontend: cd frontend && npm run build
lint_backend: ruff check backend/ && ruff format --check backend/
lint_frontend: cd frontend && npm run lint
test_backend: ./test_backend.sh            # ruff + pytest -n 30; skips tests/unit/services/test_bambu_ftp.py (pass --full to include)
test_frontend: ./test_frontend.sh          # tsc + eslint + vitest
coverage: bash tools/coverage_all.sh [frontend|backend|both]
snapshots: ./venv/bin/python3 tools/snapshot.py verify
surface: bash tools/gen_surface_all.sh > SURFACE.md && git diff --exit-code SURFACE.md

## worktree runtime (NOT in git — rebuilt per worktree)
A fresh worktree has NO venv and NO node_modules. Setup created both:
  python3 -m venv venv && ./venv/bin/python3 -m pip install -r requirements.txt
  ./venv/bin/python3 -m pip install pytest-xdist pytest-cov pytest-timeout pytest-split coverage bandit pip-audit
  cd frontend && npm ci
The pip extras matter: requirements.txt does NOT contain pytest-xdist, and
test_backend.sh runs `pytest -n 30`, so without them the backend suite dies with
"unrecognized arguments: -n" -- which reads like a broken suite, not a missing dep.

## coverage baseline (whole tree, campaign-9 gate)
backend_statements: 74%        # 70146 statements, 18347 missed, branch coverage on
frontend_statements: 58.02%
frontend_branches: 53.63%
frontend_functions: 49.27%
frontend_lines: 58.86%         # RATCHET METRIC for the frontend
RATCHET: backend 74% (statement) and frontend 58.86% (line) may never decrease.
JITTER WARNING: the frontend number moves ~+-0.1pp run to run because flaky tests
that fail do not execute their code (observed 58.86 / 58.88 on identical trees).
A drop inside that band is NOT evidence of a coverage regression -- re-run the
gate on an idle machine before calling it one. A drop beyond it is real.
Two settings are load-bearing and frozen (weakening either = protocol violation):
  * pyproject.toml [tool.coverage.run] concurrency = ["greenlet", "thread"].
    Without it SQLAlchemy async route bodies read as unexecuted (routes/aito.py
    once reported 61.77% instead of ~97%).
  * frontend/vitest.config.ts coverage.include = ['src/**/*.{ts,tsx}'] measures
    the whole tree, not just files a test imports.
Two coverage-config edits WERE made at setup, pre-BASE, and are part of the
baseline (both make the gate work at all; neither hides executable code):
  * exclude 'src/**/*.d.ts' — the whole-tree pass hard-crashed with PARSE_ERROR
    on src/lib/vendor/toolpathRenderer.d.ts (`export const X: number[]` has no
    initializer). Declaration files contain no runtime code.
  * reportOnFailure: true — vitest defaults it to FALSE, so one flaky test made
    the gate emit no number at all, indistinguishable from a coverage collapse.

## known_broken — NOW EMPTY. CORRECTED AT ITERATION 3 (2026-08-31).
- frontend: NONE.
- backend:  NONE. 12551 passed, 0 failed.

CORRECTION, recorded so nobody re-derives the wrong conclusion: at SETUP this file
was classified known_broken --
  src/__tests__/pages/ArchivesPage.test.tsx > timelapse management >
  "shows a toast when printer video ZIP preparation fails"
-- because it failed 4/4 full runs AND once when run alone. The isolation run was
the flawed evidence: the machine was NOT idle at the time (npm ci, pip installs and
two full suites were running), so "alone" still meant CPU-starved. At iteration 3 the
verifier found it passing, and it then passed 39/39 three consecutive times on an idle
machine, with a diff containing ZERO frontend source files. It is LOAD-SENSITIVE, not
broken. Moved to known_flaky below.
LESSON: one isolation run on a busy machine does not establish "genuinely broken".
Require an idle machine and repeat runs before ever writing known_broken.

## known_flaky (NOT known_broken — these pass in isolation; re-run before judging)
Both suites flake under parallel/coverage load. Every one of these was observed
failing in a full run and PASSING when re-run alone on an idle machine. A failure
in one of these is not a regression until it reproduces in isolation.
- frontend: src/__tests__/components/PrintModal.test.tsx        (by far the worst — 29 failures across 4 runs)
- frontend: src/__tests__/components/ModelViewerModal.test.tsx
- frontend: src/__tests__/pages/StatsPageUserFilter1894.test.tsx
- frontend: src/__tests__/pages/ArchivesPage.test.tsx           (ALL of its tests, including the
  "shows a toast when printer video ZIP preparation fails" one reclassified from known_broken at iteration 3)
- backend:  tests/integration/test_library_slice_api.py::TestCrossClassSliceAllLoop::test_cross_class_arrange_survives_user_leaving_the_box_unticked
- backend:  tests/unit/services/test_external_camera.py::TestGetFfmpegPath::test_get_ffmpeg_path_from_shutil_which
- backend:  tests/unit/test_aito_quote_sync.py::test_wake_drains_a_pending_project_without_waiting_for_the_interval
  (added iteration 1: flaked under load in the verifier's run, passed alone — 104 passed)
INVERSE-FLAKY — fail when run ALONE, pass in the full suite. Do NOT "fix" one by
re-running it alone and believing the failure; that is backwards for these two:
- backend:  tests/unit/test_settings_dedupe_migration.py — "no such table: print_log_entries";
  its _register_all_models() helper omits the print_log model, so it only works once
  another test has imported that model into Base.metadata. (Found iteration 1.)
- frontend: src/__tests__/components/ModelViewerModal.test.tsx > slicer split button (#2725) >
  "opens the selected local slicer from the Bambuddy dropdown" — fails deterministically alone
  (3/3), passes in some full-suite runs. Verified pre-existing at iteration 1: the component and
  its test are byte-identical to BASE and the iteration-1 diff touched zero frontend production
  files. (So the entry above listing ModelViewerModal as ordinary load-flaky is incomplete —
  this specific test is the inverse case.)

## security tooling
available: semgrep, gitleaks, pip-audit (2.10.1), npm audit (npm 11.9.0), bandit (venv)
missing:   trivy (not installed; CodeQL/Trivy are the `test_security.sh --full` extras)
The repo also ships ./test_security.sh — note it needs bash 4 for `declare -A`
and macOS stock bash is 3.2, so run the scanners directly rather than via that script.

## golden probes (10, all verified stable across 3 consecutive replays)
app-openapi-index, app-ddl, app-permissions, app-settings, app-middleware-stack,
app-migrations-index, app-route-perms, fe-router, fe-i18n-parity, fe-money-pure
PYTHONHASHSEED=0 is pinned on every Python probe: FastAPI derives operationId
from an UNORDERED method set, so multi-method routes (GET+HEAD on /sw.js,
/manifest.json) rename themselves per process without it.
Deliberately NOT probed: computeHistoryRate / computeDeltaRate /
computeSkuForecasts — they read Date.now() and would drift daily. A golden probe
that changes on its own is a disabled alarm, not a gate.
