# BASELINE.md — refactor-loop campaign 19 (the client tracking page)

Durable memory of this run. Never committed. Re-read after any compaction.

## Counters

```
iteration: 10
round: 2
dry_rounds: 0
dry_decided_round: 0
phase: exit   # user asked to finish after loop-10 (2026-09-22); round 3 not run
```

## Parameters (effective, as confirmed with the user 2026-09-22)

```
scope: THE CLIENT TRACKING PAGE, front and back end (user request: "focus on the tracking page"; the login page is NOT in scope this time).
  FRONTEND (frontend/src): pages/AitoTrackPage.tsx, pages/AitoTrackEntryPage.tsx; components/aito/TrackCollapse.tsx,
    TrackingCodeInput.tsx, TrackingInvoice.tsx, TrackingLanguageSelect.tsx, TrackingLinkControl.tsx, TrackingPanel.tsx,
    TrackingPayment.tsx, TrackingPaymentMethods.tsx, TrackingRail.tsx, TrackingShopPanel.tsx, trackingShell.tsx;
    hooks/useTrackingLanguage.ts, hooks/useTrackingPanel.ts; utils/aitoTracking.ts, utils/trackingCode.ts,
    utils/trackingShell.ts; the /t, /track, /t/:token, /track/:token routes and the two lazy imports in App.tsx;
    the AitoTracking* types and getAitoTracking / getAitoTrackingLink / regenerateAitoTrackingToken in api/client.ts;
    the "tracking code entry" / "tracking page" motion blocks and --color-aito-* tokens in index.css; the aito.track.*
    and aito.tracking* i18n keys (all 14 locales).
  BACKEND (backend/app): services/aito_tracking.py; models/aito_tracking_view.py; in api/routes/aito.py the
    GET /track/{token} route, its rate limiter (_TRACK_RATE_*, _track_rate_*, _reset_track_rate_limits,
    _track_rate_net_key, _peer_is_private, _track_rate_limited, _release_miss, _track_rate_hit), the
    GET /{project_id}/tracking-link and POST /{project_id}/tracking-token routes, the _shipping_names /
    _island_labels / _external_url helpers, and the with_tracking_sms call in the pickup-message route;
    notes_with_tracking in services/aito_quote_sync.py and the purge_tracking_views call there; the
    AitoTracking* schemas in schemas/aito.py; the tracking_token / aito_tracking_views migrations in
    core/database.py; in main.py the "/api/v1/aito/track/" PUBLIC_API_PREFIXES entry, _TRACKING_HTML_HEADERS,
    _is_tracking_page and the serve_spa branch that uses them.
  SHARED FILES: only the slice named above is in scope (aito.py, aito_quote_sync.py, schemas/aito.py, database.py,
    main.py, App.tsx, client.ts, index.css, the locales). A task may touch a shared file only for that slice.
    OUT of scope as targets: the Aito board/panel beyond TrackingLinkControl, payment-link creation/sync
    (services/aito_payment_links.py, Heimdall), the Stats "Suivi client" block (services/aito_stats.py), the
    quote sync beyond notes_with_tracking, core/auth.py, routes/auth.py (_get_client_ip / _TRUSTED_PROXY_IPS are
    context, not targets), the calculator, printers, and everything else.
  TESTS: every backend/tests and frontend/src/__tests__ file covering the above is in scope and writable:
    backend/tests/unit/test_aito_tracking.py, test_aito_tracking_delivery.py, test_aito_tracking_payment.py,
    test_external_url_setting.py, the tracking slices of test_aito_routes.py / test_aito_permissions.py /
    test_aito_quote_sync.py / test_route_auth_coverage.py / integration/test_static_html_cache_headers.py;
    frontend/src/__tests__/pages/AitoTrackPage.test.tsx, AitoTrackEntryPage.test.tsx,
    components/AitoTrackingLinkControl.test.tsx, AitoTrackingPaymentMethods.test.tsx, utils/aitoTracking.test.ts.
  LOOP MACHINERY (frozen, out of scope): tools/, PROBES.json, snapshots/, SURFACE.md.
triage: P3
max_iter: 12                   # raised 8 -> 12 by the user at the round-2 sweep (2026-09-22)
max_rounds: 3
batch: 3
mode: auto
commit_style: grouped
merge_cadence: at-exit
```

## Ancestry

```
UPSTREAM: e1628a72a484d76975a60e270f08654a2f0c7afc   (main at setup — "build: refresh the static bundle for the sheet blur and exit")
BASE:     refactor-base                              (tag; resolve with `git rev-parse refactor-base`)
```

Setup debris found and removed with the user's consent (2026-09-22): a stale
campaign-18 worktree at ../bambuddy-refactor with no PLAN.md, its branch
auto-refactor-loop (one unmerged docs commit 5c9408a23 whose FINAL_REPORT.md was
saved to the session scratchpad), and the tags refactor-base + loop-1..loop-8.

## Agents

Plugin agents (refactor-loop:audit-*, refactor-loop:refactor-worker,
refactor-loop:refactor-verifier). The main checkout's UNTRACKED `.claude/agents/
refactor-worker.md` and `refactor-verifier.md` are stale copies of an older
plugin release (no BASELINE-CHANGELOG sanction logic, no tools/ freeze, no
stage-by-name rule) — NOT used; always dispatch with the `refactor-loop:` prefix.

## Commands

```
build:     cd frontend && npm run build      # VERIFIER ONLY; rewrites tracked static/ — restore with `git checkout -- static && git clean -fdXq -- static`
lint:      ruff check backend/ && ruff format --check backend/
           cd frontend && npm run lint       (ESLint)
typecheck: cd frontend && npx tsc -b --noEmit
i18n gate: cd frontend && npm run check:i18n
test:      ./venv/bin/python3 -m pytest backend/tests/ -q -n 8 --ignore=backend/tests/unit/services/test_bambu_ftp.py
           cd frontend && npm run test:run
coverage:  bash tools/coverage_tracking.sh [frontend|backend|both]
surface:   bash tools/gen_surface_tracking.sh > SURFACE.md && git diff --exit-code SURFACE.md
probes:    ./venv/bin/python3 tools/snapshot.py verify
```

Run a SINGLE vitest file with `frontend/node_modules/.bin/vitest run <file>` —
`npm run test:run -- <file>` runs ALL files and hands the path to the i18n checker.

## Coverage baseline (scope-only; ratchet on statements)

Frontend (the 18 scope files, `coverage/coverage-summary.json` total), 2026-09-22:

```
Statements : 93.27%  (527/565)   <- RATCHET METRIC
Branches   : 91.54%  (498/544)
Functions  : 97.77%  (132/135)
Lines      : 94.81%  (457/482)
```
frontend tests: 6891 passed, 0 failed, 464 files, 69 s.
(The vitest text table hides fully-covered files — 7 of the 18 were absent from it; the JSON summary lists all 18.)

Backend (`services/aito_tracking.py` + `models/aito_tracking_view.py`), 2026-09-22:

```
SCOPED statements: 160/161 = 99.38%   <- RATCHET METRIC
SCOPED branches:   40/44  = 90.91%
aito_tracking.py 97.44% · aito_tracking_view.py 100%
INFO ONLY — routes/aito.py whole file: 1107/1148 statements = 96.43%, branches 326/344 = 94.77%
```
backend tests: 15143 passed, 0 failed, 1 skipped, 542 s (-n 8, coverage on).

Coverage may only go up. Adding a coverage exclusion or narrowing the include
list in `tools/coverage_tracking.sh` is a protocol violation, not a fix.
`.coverage` at the repo root is a TRACKED file (campaign-1 leak) that pytest-cov
rewrites; the script restores it — never stage it.

## known_broken

(none — backend 0 failed, frontend 0 failed at UPSTREAM, both suites run with coverage on)

known_flaky (NOT known_broken — carried from campaigns 9-18; a failure in one of these is not a
regression until it reproduces ALONE on an idle machine): frontend PrintModal, ArchivesPage,
FileUploadModal, ModelViewerModal, StatsPageUserFilter1894, ConfigureAmsSlotModal, AppRouterAitoGuard,
QueuePage, SettingsPage, SlicerSettingsPanel; backend test_library_slice_api (cross-class arrange),
test_external_camera (ffmpeg path), test_aito_quote_sync wake-drain, test_slicer_stall_timeout,
test_scheduler_concurrent_dispatch, test_plug_energy_history (22:00-22:30 UTC), test_aito_routes
(thousand-project import, slow under load).

## Static gates at UPSTREAM (2026-09-22)

ruff check: clean · ruff format: 1062 files formatted · eslint: clean · tsc -b: clean · i18n parity: 13 locales in parity with en.

## Security tooling (checked 2026-09-22)

```
semgrep     : available (~/.local/bin/semgrep)
gitleaks    : available (/opt/homebrew/bin/gitleaks)
pip-audit   : available (~/.local/bin/pip-audit 2.10.1)
bandit      : available (venv, 1.9.4)
npm audit   : available
trivy/codeql: NOT installed (the test_security.sh --full extras; not blocking)
```
test_security.sh needs bash 4 (macOS stock bash 3.2 lacks `declare -A`) — run the scans directly.

## Golden probes (15)

Recorded at BASE and frozen. `snapshot.py verify` must be 15/15 every iteration
(replayed twice at setup: deterministic).

Campaign-scoped (new this campaign):
- `tracking-backend` — compute_tracking over 15 seeded cards at a frozen clock
  (2026-03-15T12:00): every column, the trashed / declined / expired-quote /
  done-expired / dormant 404 shapes, shipping with and without a waybill and
  with cold labels, all four payment-link states (+ deposit setting), the
  legacy 43-char token and folded-event activity, view-log dedup, the mint's
  shape; plus the pure tables: normalize_token, is_expired grid, invoice_state,
  notes/SMS merging, task_quantity, every module constant, the route limiter's
  caps and net keying, main.py's _is_tracking_page and headers.
- `tracking-contract` — the three operations' parameters / responses / security
  and all AitoTracking* models (names, types, required sets).
- `tracking-http` — through the real app: 404 + no-store, 200 payload for a
  hyphenated lower-case code, 405 on HEAD, the miss cap → 429 + Retry-After
  (after 30 misses; hits refused past the cap), SPA serve headers for
  /t, /T, /t/<code>, /track/… vs neighbours, tracking-link null→url,
  regenerate (old token dies, event recorded), 404 on missing card.
- `tracking-frontend-pure` — trackingDefaultLanguage, stage order, stage labels,
  longDate / updatedAt (fr, en, de, ja; TZ=UTC), statusCopy per column and
  shipping/waybill/date shape, etaCopy grid (8 columns × 4 due dates), the
  TRACK_MOTION / ENTRY_MOTION clocks, normalizeCode table, shell tokens.
- `tracking-i18n` — the 114 `aito.track.*` + `aito.tracking*` keys in all 14
  locales, as key paths + placeholder sets (translations not recorded).

Inherited app-wide guards: `app-openapi-index`, `app-ddl`, `app-permissions`,
`app-settings`, `app-middleware-stack`, `app-migrations-index`,
`app-route-perms`, `fe-router`, `fe-i18n-parity`, `fe-money-pure`.

Replay at setup, BEFORE re-recording: 7/14 matched. Every diff attributed to
main's feature work since campaign 18's base (c85714e94): the Main d'oeuvre
service (app-ddl: maindoeuvre_cost/_description/_done on aito_tasks;
app-migrations-index renumbered by the new "Main d'œuvre service (2026-09-20)"
entry; stats-backend-aggregate/stats-frontend-pure: a fifth service and its
palette colour), the client edit feature (app-openapi-index: PUT
/aito/{id}/client + GET /zoho/contacts/{id}; app-route-perms: AITO_UPDATE
19→21), and the i18n key count 7651→7664 (fe-i18n-parity). All six
re-recorded pre-BASE; campaign-18's four `stats-*` probes and their goldens
were DROPPED (out of scope, slow). After re-record: 15/15, SURFACE.md
regenerates byte-identical.

## Environment notes for this machine

- Use `./venv/bin/python3`; system python lacks deps. Ruff is system-wide.
- The worktree's `venv` and `frontend/node_modules` are SYMLINKS into the main
  checkout. Do not run `npm install` or `pip install` here.
- Run long commands under `caffeinate -i` — Mac sleep kills subagents.
- Backend coverage needs `concurrency = ["greenlet", "thread"]` (already in
  pyproject.toml). Without it async route bodies read as untested.
- A parallel session may be working in the main checkout. Never `git stash`
  anywhere (the stash stack is shared); never `git add -A` anywhere.
- Both suites flake under load; re-run a failing file ALONE on an idle machine
  before believing it. HEAD on the public tracking route is 405, not a GET.

## Sanctioned surface rule (user decision 2026-09-22, iteration 1)

Extraction tasks MAY ADD (never rename or remove) an `export` in
frontend/src/utils/trackingShell.ts, utils/aitoTracking.ts or
components/aito/Track*.tsx / trackingShell.tsx. The worker regenerates
SURFACE.md in the SAME commit (`bash tools/gen_surface_tracking.sh > SURFACE.md`)
and appends a BASELINE-CHANGELOG.md entry ("re-baseline: additive internal
export <name> for T-xxx, user-sanctioned 2026-09-22"). The verifier treats a
SURFACE.md diff that is additions-only in the "Frontend exports" section, with a
matching changelog entry, as SANCTIONED. Anything else in SURFACE.md is still a
FAIL. Golden probes are unaffected (they do not enumerate exports).

## Campaign re-baseline (user-sanctioned 2026-09-22, iteration 4)

tools/gen_surface_tracking.sh pinned grep LINE NUMBERS in six sections (R3, R4,
R5, R8, R10, R12), so T-012's 4-line insertion in routes/aito.py made the
regenerated SURFACE.md differ by numbers alone (stripped diff empty). With the
user's consent a chore commit `chore(refactor-loop): re-baseline SURFACE
generator without line numbers (user-sanctioned)` drops the numeric prefixes
(names, routes and file order still pinned), regenerates SURFACE.md and logs it
in BASELINE-CHANGELOG.md. The verifier treats that commit's tools/ + SURFACE.md
diff as SANCTIONED; every later iteration is judged against the new SURFACE.md.
Lesson for future campaigns: never `grep -n` in a surface generator.

## Round-2 approvals (2026-09-22)

All six BLOCKED findings approved: T-024 (commit the minted token before the
Books call on both push paths), T-026 (clipboard-failure hint on the payment
rows; a new aito.track.* key must land in all 14 locales), T-027 (tracking-route
error boundary rendering the existing error card), T-028 (new
`_TRACK_RATE_MAX_CALLS_PER_NET = 1200` per-net calls ceiling — its
`_TRACK_RATE_MAX_CALLS_PER_NET =` line in SURFACE.md's limiter section is PART
OF THE APPROVED CHANGE and sanctioned via the changelog entry), T-029 (collapse
gated on explicit TRUSTED_PROXY_IPS / setting, not the peer's address family),
T-030 (`__no_ip__` treated as collapsed). MAX_ITER raised 8 -> 12. Work the
limiter trio (T-028, T-030, T-029) in ONE worker, in that order, one commit each.
