# BASELINE.md — refactor-loop campaign 13 (TRACKING PAGE + LOGIN PAGE)

THE durable memory of this run. NEVER `git add` this file.

## Identity
upstream: e160b2da5bc72345553248c381e6891ae9357e9d   # main @ "build: rebuild the static bundle" (campaign 12 merged+pushed 2026-09-09)
base: refactor-base            # resolve with `git rev-parse refactor-base` (= feabef49f, the setup commit, tagged 2026-09-09)
campaign: 13                   # campaigns 1-12 are all merged to main; their loop tags were deleted before this
                               # worktree was cut (verified 2026-09-09: no `loop-*` / `refactor-base` tag existed), so
                               # `git describe --match 'loop-*'` exits nonzero and the SQUASH+TAG campaign-1 BASE
                               # fallback is valid. Iteration tags are plain `loop-N`.
workdir: /Users/paultheis/Documents/Code/bambuddy-refactor
branch: auto-refactor-loop
agents: plugin-namespaced refactor-loop:refactor-worker / refactor-loop:refactor-verifier and the four
        refactor-loop:audit-* auditors (plugin 1.2.0). The MAIN checkout's gitignored .claude/agents/
        refactor-worker.md + refactor-verifier.md are stale older copies, NOT present in this worktree —
        deliberately not used (same decision as campaigns 10, 11, 12).
dedup_seed: refactor-campaign12-archive/PLAN.md copied to PLAN.campaign12.md (plan.py archive glob) and its
        TRIAGE.md copied as this campaign's TRIAGE.md, so ingest suppresses everything campaign 12 filed or
        triaged (9 of its 19 tasks were tracking-page findings). Its findings JSON kept as c12-findings-audit-*.json
        for the auditors' ALREADY_FILED lists. All untracked, never committed.

## parameters
scope: |
  THE CLIENT TRACKING PAGES AND THE LOGIN PAGE (user request 2026-09-09: "look about the tracking page and
  login page"). Both front and back end of each page.
  TRACKING PAGE — FRONTEND (frontend/src): pages/AitoTrackPage.tsx, pages/AitoTrackEntryPage.tsx;
    components/aito/TrackCollapse.tsx, TrackingCodeInput.tsx, TrackingInvoice.tsx, TrackingLanguageSelect.tsx,
    TrackingLinkControl.tsx, TrackingRail.tsx, trackingShell.tsx; hooks/useTrackingLanguage.ts;
    utils/aitoTracking.ts, utils/trackingCode.ts, utils/trackingShell.ts; the /t, /track, /t/:token,
    /track/:token routes in App.tsx; the track* methods of api/client.ts; the tracking i18n keys.
  TRACKING PAGE — BACKEND (backend/app): in api/routes/aito.py the /track/{token} route, its rate limiter
    (_reset_track_rate_limits, _track_rate_limited, _track_rate_hit), the /{project_id}/tracking-link and
    /tracking-token routes and their helpers; services/aito_tracking.py; models/aito_tracking_view.py; the
    tracking_token / tracking-view slices of models/aito_project.py, schemas/aito.py and core/database.py
    migrations; in main.py the "/api/v1/aito/track/" public-prefix entry, _TRACKING_HTML_HEADERS and
    _is_tracking_page + the SPA serve path that uses them.
  LOGIN PAGE — FRONTEND (frontend/src): pages/LoginPage.tsx, contexts/AuthContext.tsx; the login/auth
    methods of api/client.ts that LoginPage/AuthContext call (login, logout, getAuthStatus, getCurrentUser,
    exchangeOIDCToken, forgotPassword, forgotPasswordConfirm, getAdvancedAuthStatus, getOIDCAuthorizeUrl,
    getOIDCProviders, oidcProviderIconUrl, sendEmailOTP, verify2FA); the /login route in App.tsx; the
    login/auth i18n keys.
  LOGIN PAGE — BACKEND (backend/app): in api/routes/auth.py the endpoints the page reaches — POST /login,
    GET /status, GET /me, POST /logout, GET /advanced-auth/status, POST /forgot-password,
    POST /forgot-password/confirm, POST /reset-password — and their private helpers; in api/routes/mfa.py the
    login-flow endpoints — POST /2fa/verify, POST /2fa/email/send, GET /oidc/providers,
    GET /oidc/providers/{id}/icon, GET /oidc/authorize/{id}, GET /oidc/callback, POST /oidc/exchange — and
    their private helpers; api/routes/_oidc_helpers.py; api/routes/_url_safety.py (as used by those);
    schemas/auth.py; the login/OIDC entries of main.py's PUBLIC_API_PATHS / PUBLIC_API_PREFIXES.
  SHARED FILES: only the slice named above is in scope (api/client.ts, App.tsx, main.py, aito.py, mfa.py,
    auth.py, database.py, i18n locales). A task may touch a shared file only for that slice.
    core/auth.py (JWT/permission machinery shared by every route) and core/permissions.py are OUT of scope
    as targets; auditors may cite them as context for a finding in an in-scope file.
  TESTS: every backend/tests and frontend/src/__tests__ file covering the above is in scope and writable
    (test_aito_tracking*.py, test_auth_api.py, test_advanced_auth_api.py, test_local_login_gate.py,
    test_oidc_relogin.py, test_mfa_api.py, test_endpoint_auth.py, test_auth_fail_closed.py,
    test_no_fail_open_in_auth.py, the tracking slices of test_aito_routes.py / test_aito_permissions.py;
    __tests__/pages/AitoTrackPage|AitoTrackEntryPage|LoginPage.test.tsx, __tests__/contexts/AuthContext.test.tsx,
    __tests__/components/AitoTrackingLinkControl.test.tsx, __tests__/utils/aitoTracking.test.ts, ...).
  UPSTREAM CAUTION: LoginPage.tsx, AuthContext.tsx, routes/auth.py, routes/mfa.py and schemas/auth.py are
    mostly UPSTREAM Bambuddy code that this fork merges regularly. Changes there must be surgical (small
    hunks, no reflowing, no wholesale extraction) to keep future upstream merges composable. Auditors should
    weight findings in those files toward real defects over cosmetic cleanliness.
  OUT OF SCOPE: everything else (Aito board, calculator, printers, archives, library, camera, spoolman, stats,
    users/RBAC admin, MFA enrolment/OIDC provider admin, LDAP, SMTP, API tokens, ...), and the loop's own
    machinery: tools/, PROBES.json, snapshots/, SURFACE.md.
triage: P3                     # work P0/P1/P2; divert only P3 to TRIAGE.md (same as campaigns 10/11/12)
max_iter: 18                   # raised 8 -> 12 (round-2 sweep) -> 18 (round-3 sweep) by the user 2026-09-09; plan.py render header still prints 8 — BASELINE.md is authoritative
max_rounds: 3
batch: 3
mode: auto
commit_style: grouped
merge_cadence: at-exit

## counters
iteration: 17
round: 3
dry_rounds: 0
dry_decided_round: 0
phase: exit   # EXITED 2026-09-09 on MAX_ROUNDS after iteration 17; FINAL_REPORT.md committed as HEAD (EXIT-THEN-RESUME applies)

## commands
build_frontend: cd frontend && npm run build   # VERIFIER ONLY; rewrites tracked static/ — restore with `git checkout -- static && git clean -fdXq -- static`
lint_backend: ruff check backend/ && ruff format --check backend/
lint_frontend: cd frontend && npm run lint
typecheck_frontend: cd frontend && npx tsc -b
test_backend: ./test_backend.sh            # ruff + pytest -n 30; skips tests/unit/services/test_bambu_ftp.py (pass --full to include)
test_frontend: ./test_frontend.sh          # tsc + eslint + vitest + i18n check
coverage: bash tools/coverage_all.sh [frontend|backend|both]   # WHOLE TREE gate, --cov-config=../pyproject.toml is load-bearing
coverage_as_run: the two commands inside tools/coverage_all.sh run directly, detached, with FULL logs and
  `--timeout=600 -rfE` on the backend (no coverage setting differs):
  (cd backend && ../venv/bin/python3 -m pytest tests/ -q -n 30 --timeout=600 -rfE --ignore=tests/unit/services/test_bambu_ftp.py --cov=app --cov-config=../pyproject.toml --cov-report=term)
  (cd frontend && npx vitest run --coverage)
snapshots: ./venv/bin/python3 tools/snapshot.py verify
surface: bash tools/gen_surface_all.sh > SURFACE.md && git diff --exit-code SURFACE.md
python: ./venv/bin/python3 (worktree venv — see runtime below). NEVER system python.

## worktree runtime (NOT in git — rebuilt per worktree)
Built 2026-09-09 by APFS clonefile, not pip/npm (network-independent, instant):
  cp -c -R ../bambuddy/venv venv && sed -i '' 's#/Code/bambuddy/venv#/Code/bambuddy-refactor/venv#g' venv/bin/*
  cp -c -R ../bambuddy/frontend/node_modules frontend/node_modules
venv sys.prefix resolves inside the worktree; pytest 9.0.3 + xdist + cov + timeout. vitest 4.1.8 and tsc 5.9.3
resolve from frontend/node_modules/.bin (node 25.6.1). Workers must NOT pip/npm install.

## security tooling (checked 2026-09-09)
available: semgrep (~/.local/bin), gitleaks (homebrew), pip-audit (~/.local/bin), bandit (venv/bin), npm audit (npm 11.9.0)
missing:   trivy, codeql (the `test_security.sh --full` extras; not installed, not blocking)
Note: test_security.sh needs bash 4 (macOS stock bash 3.2 lacks `declare -A`) — run the scans directly.

## golden probes (10, carried tracked from campaign 12 on main)
app-openapi-index, app-ddl, app-permissions, app-settings, app-middleware-stack,
app-migrations-index, app-route-perms, fe-router, fe-i18n-parity, fe-money-pure
PROBES.json and tools/ carried unchanged. Replay at setup (2026-09-09): 4/10 matched; six goldens
(app-openapi-index, app-ddl, app-migrations-index, fe-router, fe-i18n-parity, fe-money-pure) and SURFACE.md
(81 diff lines) were RE-RECORDED pre-BASE because main moved past campaign 12's base (4e8c9e4a4) with feature
work. Every diff attributed: rush-surcharge removal 76e0d8002 (impression_rush / rush_pct columns, `rush`
schema fields, margin_rush in fe-money-pure, migration index shifted by one, aito_tasks 32->31,
calculator_defaults 23->22); LTA shipping 9a4951cd7 (shipping_lta, aito_projects 50->51); 6-char tracking
codes + /t code-entry page aa65815a7/34827e631 (fe-router /t, /track, /t/:token; mint_unique_token,
normalize_token, notes_with_tracking, tracking_notes, with_tracking_notes, CODE_LENGTH, CodeState,
normalizeCode, AitoTrackEntryPage.tsx); tracking motion + 13-language selector 533eeab43/c3cf74e19
(TRACK_MOTION, ENTRY_MOTION, TRACKING_FALLBACK_LANGUAGE, trackNodeDelay, trackStageIndex, trackStateDelay,
useTrackingLanguage, trackingDefaultLanguage, longDate/updatedAt replacing FR/frLongDate/frUpdated, BRAND,
CARD, FOCUS, PRESS, delayAt); date picker a3f444137 (addWorkingDays, dueDateDays, dueRelativeLabel,
weekStartFor); new-project draft / duplicate card (isBlankPersistedDraft, readNewProjectDraft,
writeNewProjectDraft, seedFromProject, ProjectSeedInput); tracking limiter fix f0e2857bd (is_expired gained
last_active); i18n 7199 -> 7276 keys in all 13 locales. After re-record: 10/10 match, SURFACE.md regenerates
byte-identical. PYTHONHASHSEED=0 pinned on every Python probe. SURFACE.md's header still says "campaign-9"
because tools/gen_surface_all.sh emits it literally.

## coverage baseline (whole tree, campaign-13 gate) — recorded 2026-09-09 at UPSTREAM (worktree @ refactor-base; setup commit touches no source)
backend_statements: 72%           # RATCHET METRIC for the backend. 72537 statements, 18302 missed; 23388 branches, 3140 partial; branch+greenlet ON via --cov-config=../pyproject.toml
backend_tests: 13127 passed, 0 failed, 1 skipped, 537s (coverage run, -n 30, load avg ~50-70 from the frontend run + peer sessions)
frontend_statements: 60.62%
frontend_branches: 56.07%
frontend_functions: 52.11%
frontend_lines: 61.49%            # RATCHET METRIC for the frontend
frontend_tests: 6037 passed, 4 failed (all four load flakes — each passed alone: FileUploadModal 44/44, PrintModal 79/79, ArchivesPage 43/43, AppRouterAitoGuard 5/5 twice + 5/5 in the main checkout), 413 files
Gate logs: scratchpad gate_backend.log / gate_frontend.log / gate_probes.log (session scratchpad, not in WORKDIR).

## known_broken — EMPTY at setup (2026-09-09)
(none — backend 0 failed; the four frontend failures in the baseline run all pass in isolation, listed under known_flaky)

## known_flaky (NOT known_broken — pass in isolation; re-run alone on an IDLE machine before judging)
Carried from campaigns 9-12. A failure in one of these is not a regression until it reproduces in
isolation on an idle machine.
- frontend: src/__tests__/pages/ArchivesPage.test.tsx
- frontend: src/__tests__/components/FileUploadModal.test.tsx
- frontend: src/__tests__/components/PrintModal.test.tsx        (the worst offender historically)
- frontend: src/__tests__/components/ModelViewerModal.test.tsx
- frontend: src/__tests__/pages/StatsPageUserFilter1894.test.tsx
- frontend: src/__tests__/components/ConfigureAmsSlotModal.test.tsx
- frontend: src/__tests__/pages/LoginPage.test.tsx (seen under load in campaign 4 — IN SCOPE this campaign, so judge carefully)
- frontend: src/__tests__/AppRouterAitoGuard.test.tsx > "with aito:read: mounts the Aito board at /aito" (failed in the baseline run AND once alone at load 57; 5/5 on the next two isolated runs — NEW this campaign)
- frontend: src/__tests__/pages/QueuePage.test.tsx (10 s timeout under load in gate 13; 41/41 alone — NEW this campaign)
- backend:  tests/integration/test_library_slice_api.py::TestCrossClassSliceAllLoop::test_cross_class_arrange_survives_user_leaving_the_box_unticked
- backend:  tests/unit/services/test_external_camera.py::TestGetFfmpegPath::test_get_ffmpeg_path_from_shutil_which
- backend:  tests/unit/test_aito_quote_sync.py::test_wake_drains_a_pending_project_without_waiting_for_the_interval
- backend:  tests/integration/test_mfa_api.py::TestTOTPReplay::test_totp_replay_rejected_on_verify (lead: mfa.py flush-without-commit — the 2fa/verify route IS in scope this campaign)
- backend:  tests/unit/test_slicer_stall_timeout.py::TestSliceIsNotCutOffWhileProgressing::test_a_slow_slice_that_reports_progress_completes
- backend:  tests/unit/test_scheduler_concurrent_dispatch.py::test_freed_slot_is_refilled_on_the_next_tick
- backend:  tests/unit/services/test_plug_energy_history.py::test_nothing_derivable_before_the_first_midnight (fails deterministically 22:00-22:30 UTC; pins TZ=Europe/Berlin; OUT OF SCOPE)
- backend:  tests/unit/test_aito_routes.py (thousand-project import; slow under load)
INVERSE-FLAKY — fail when run ALONE, pass in the full suite (do NOT "confirm" a failure by running alone):
- backend:  tests/unit/test_settings_dedupe_migration.py — its _register_all_models() omits the print_log model.
- frontend: src/__tests__/components/ModelViewerModal.test.tsx > slicer split button (#2725) > "opens the selected local slicer from the Bambuddy dropdown".

## lint baseline
ruff check + ruff format --check: clean (947 files, worktree @ UPSTREAM, 2026-09-09)
eslint: clean · tsc -b: clean (2026-09-09)

## verifier briefing (campaign 10/11/12 lessons — repeat every time)
- Tell the verifier explicitly NOT to read PLAN.md, PLAN.campaign12.md, TRIAGE.md, VERDICTS.log, BASELINE.md or
  findings-audit-*.json / c12-findings-*.json.
- The verifier's `npm run build` rewrites the TRACKED static/ bundle: it must run `git checkout -- static && git clean -fdXq -- static` right after the build gate; workers never run `npm run build`.
- Long commands must be `2>&1 | tee log` with NO trailing tail (600 s no-output watchdog). The ORCHESTRATOR runs the coverage gate detached with full logs and hands the verifier the log paths. Check `uptime` for peer load before dispatching; resume a stalled agent via SendMessage rather than re-launching.
- From iteration 2 on, the verifier is briefed with the previous `loop-N` tag as its DIFF base (whole-tree gates unchanged); refactor-base remains the campaign BASE for squash fallback and the final report.
- Backend gate always carries `--timeout=600 -rfE` so a hung test fails by name.
- Coverage runs from the repo root dirty the tracked `.coverage` — restore with `git checkout -- .coverage`.

## worker briefing (standing, repeat every time)
- Re-verify the auditor's claim before building on it; prove every new test by mutation (break the code, see it fail, restore).
- Ask (report BLOCKED) before anything that adds an `export` under frontend/src/utils|hooks (SURFACE.md), wraps a route element (fe-router golden), deletes i18n keys (fe-i18n-parity golden records key counts in all 13 locales), adds a letter-initial top-level def in services/*.py (SURFACE.md), or changes a route/permission (goldens).
- Never `npm run build`; never pip/npm install; stage files by name.
- Upstream-owned files (LoginPage.tsx, AuthContext.tsx, routes/auth.py, routes/mfa.py, schemas/auth.py): surgical hunks only.

## mid-campaign approvals log (decisions that are not derivable from PLAN.md alone)
- 2026-09-09 setup: user asked for "the tracking page and login page"; parameters carried from campaigns 10-12 (TRIAGE P3, 8/3/3, auto, grouped, at-exit).
- 2026-09-09 ROUND-1 panel (N=0): cleanliness 4 new + 3 triaged; security 2 new (both blocked); tests 8 new; robustness 6 new (2 blocked, both duplicates of security's -> T-042/T-046 WONTFIX-AUTO folded into T-032/T-033). Orchestrator additionally set T-047 (AitoTrackEntryPage skeleton — auditor said behavior_change:false but the fix is a visible UI change) to BLOCKED "needs user approval" before the sweep. Total 20 filed: 15 workable + 3 blocked + 2 folded; 3 triaged (TRIAGE.md now 8 incl. campaign 12's 5).
- 2026-09-09 ROUND-1 approval sweep (N=0): user APPROVED T-032 as proposed (logout sends its token; JWT revoked server-side); APPROVED T-033 NARROWED to a per-IP sliding-window rate limit like the tracking route's — NO discovery-document caching; APPROVED T-047 NARROWED to rendering the Logo + skeleton card shell while !ready (as AitoTrackPage does) — NO English fallback timeout. 3 approved, 0 denied. Each of these three carries the golden/SURFACE re-record + BASELINE-CHANGELOG.md obligation in the same commit, message tagged "(user-approved behavior change)".
- Orchestrator note: this session has no TodoWrite tool; the dashboard (`plan.py render`) is the progress mirror.
- 2026-09-09 iteration-2 worker observation (T-037) for the ROUND-2 robustness brief: LoginPage.tsx never clears its 700 ms `exitToDashboard` setTimeout on unmount (a leftover timer can fire into the next test / after navigation), and the #1889 "already authenticated" effect also calls navigate('/') shortly after login.
- 2026-09-09 iteration-2 verifier caveat for the ROUND-2 briefs: T-038's `expect(mockNavigate).not.toHaveBeenCalled()` (LoginPage.test.tsx ~:211) is fragile under load because LoginPage's 700 ms exitToDashboard timer is never cleared on unmount; T-037's block shows the defensive pattern. Root cause -> audit-robustness; test hardening -> audit-tests.
- 2026-09-09 iteration-6 worker observation (T-045) for the ROUND-2 audit-tests brief: routes/auth.py's `async_session` name binding is NOT patched by the async_client fixture (only core.database, core.auth, main, services.obico_detection are), so `_send_reset_email_or_delete_token`'s except-branch DB delete hits "no such table" in tests — the delete-token-on-send-failure path is effectively unverifiable end-to-end today (pre-existing, unrelated to the campaign's change).
- 2026-09-09 ROUND-2 panel (N=6): cleanliness 2 new (1 blocked: T-049 drop TRACKING_FALLBACK_LANGUAGE export); security 3 new (all blocked: T-050 SSRF guard on discovery endpoints, T-051 forgot-password 429 oracle, T-052 kiosk ?token= adoption) + 1 triaged (T-053 %r logging); tests 3 new (T-054 auth.py async_session fixture patch + real delete assertion, T-055 T-038 timer race, T-056 oidc_callback failure branches); robustness 6 new (4 blocked: T-057 LDAP bind unbounded on the default executor, T-058 OTP resend never refreshes the 2fa_challenge cookie, T-059 non-dict discovery body -> 500, T-060 limiter keyed on the proxy IP by default; workable T-061 clear the 700 ms timer; T-062 #1889 effect race — orchestrator set BLOCKED "needs user approval" because the fix changes where a deep-linked user lands). Total 14 new (5 workable + 9 blocked), 1 triaged (TRIAGE.md now 9). Round 2 is PRODUCTIVE regardless of the sweep (5 workable).
- 2026-09-09 ROUND-2 approval sweep (N=6): user APPROVED T-057 (LDAP bind bounded by asyncio.wait_for ~15 s -> existing failure path), T-050 (public-HTTPS guard on discovery endpoints), T-059 (non-dict discovery body -> existing failure branch), T-058 (OTP resend refreshes the 2fa_challenge cookie), T-051 (reset rate event for every identifier), T-062 (#1889 effect gated after a successful login); APPROVED NARROWED T-052 (adopt ?token= only when no token is stored — NO kiosk marker) and T-060 (cap 30 -> 120/min like the tracking route — NO re-keying, NO warning); DENIED T-049 (export drop) -> WONTFIX-AUTO. 8 approved, 1 denied. MAX_ITER raised 8 -> 12. Round 2 PRODUCTIVE (5 workable + 8 approved = 13 OPEN): dry_rounds stays 0, N -> 7, phase: loop.
- 2026-09-09 ROUND-3 panel (N=11): cleanliness 1 new (T-063) + 2 triaged (T-064, T-065); security 2 new (both blocked: T-066 exchange returns user pre-2FA, T-067 public providers list exposes linking policy) + 1 triaged (T-068 scalar_one_or_none on OTP rows); robustness 5 new (all blocked: T-069 oidc_error redirect to a protected route, T-070 write lock across the SMTP send, T-071 discovery fetch no overall deadline, T-072 /t check no timeout, T-073 login ignores /me failure); tests 8 new (T-074..T-081) + 1 triaged (T-082). Total 16 new (9 workable + 7 blocked), 4 triaged (TRIAGE.md now 13). Round 3 PRODUCTIVE.
- 2026-09-09 ROUND-3 approval sweep (N=11): user APPROVED all seven as proposed — T-069, T-070, T-066, T-067, T-071, T-072, T-073. 7 approved, 0 denied. MAX_ITER raised 12 -> 18. dry_rounds stays 0, N -> 12, phase: loop. Round 3 was the last survey round (MAX_ROUNDS 3): after the plan is exhausted the campaign EXITS on MAX_ROUNDS.
- 2026-09-09 iteration-12 verifier residues for the FINAL REPORT (no survey round remains to file them): T-070's except branch also wraps record_email_otp_send — a DB error there would hit the new mark-used UPDATE/commit before the intended 500; and after a successful send, the raced/expired pre-auth-token 401 leaves the new OTP row committed. Both non-user-observable; human follow-up: narrow the try to the send, or make the except's cleanup best-effort.
