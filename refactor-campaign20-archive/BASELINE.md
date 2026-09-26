# BASELINE.md — refactor-loop campaign 20 (the whole Aito feature — "check for bug or issue on the Aito feature")

Durable memory of this run. Never committed. Re-read after any compaction.

## Counters

```
iteration: 13
round: 3
dry_rounds: 0
dry_decided_round: 0
phase: exit (campaign finished 2026-09-25 on MAX_ROUNDS after loop-13; FINAL_REPORT.md committed)
```

## Parameters (effective, as confirmed with the user 2026-09-23)

```
scope: THE WHOLE AITO FEATURE, front and back end. User brief: "check for bug or issue on the Aito feature" —
  the auditors are told bugs/issues are the priority lens (robustness + security first), cleanliness second.
  BACKEND (backend/app): api/routes/aito.py, api/routes/aito_payments.py, api/routes/heimdall.py, api/routes/zoho.py;
    schemas/aito.py, schemas/heimdall.py; models/aito_*.py (client_rating, event, payment_link, project, task,
    terminal_payment, tracking_view); services/aito_*.py (20 modules: board_rules, client_history, client_rating,
    customer_credit, events, invoice_create, invoice_poll, invoice_sweep, manual_payments, payment_documents,
    payment_links, quote_export, quote_import, quote_status, quote_sync, shipping, stats, terminal_payments,
    tracking, zoho_comments); the integration services only Aito uses: services/openrouter.py, services/heimdall.py,
    services/pushcut.py, services/zoho.py (NOT services/zoho_filaments.py — calculator). Aito slices of shared files:
    the aito/zoho/heimdall migrations in core/database.py, the Aito permissions in core/permissions.py, the
    "/api/v1/aito/track/" + tracking-page branches in main.py, the aito presence/read-filter slices of the ws route.
  FRONTEND (frontend/src): pages/AitoPage.tsx, pages/AitoTrackPage.tsx, pages/AitoTrackEntryPage.tsx,
    pages/AitoFxDemoPage.tsx (DEV-only demo); components/aito/** (all files incl. payment/, stats/, history/,
    celebration/, archives/); hooks/useAitoPageMutations.ts, useAitoPresence.ts, useTrackingLanguage.ts,
    useTrackingPanel.ts; utils/aito*.ts, utils/tracking*.ts, utils/projectSeed.ts; the Aito / Zoho / Heimdall /
    tracking types and methods in api/client.ts; the Aito routes in App.tsx; the aito.* i18n keys (14 locales);
    the --color-aito-* tokens and aito/track motion blocks in index.css.
  SHARED FILES (client.ts, App.tsx, index.css, database.py, permissions.py, main.py, ws.py, locales): only the
    Aito slice is in scope; a task may touch them only for that slice.
  OUT of scope as targets: calculator, printers, filament, library, spoolman, camera, auth core, upstream code.
  TESTS: every backend/tests file named test_aito_* / test_ws_aito_* / test_zoho* / test_heimdall* / test_pushcut* /
    test_openrouter* and the aito fixtures; every frontend/src/__tests__ file named *Aito* / *aito* — always writable.
  RECENTLY AUDITED (campaigns 17-19, Sep 2026 — auditors told, not excluded): Heimdall payment links
    (services/aito_payment_links.py, heimdall.py), the client tracking page (aito_tracking.py + Track* components),
    the stats view (aito_stats.py + components/aito/stats/).
  LOOP MACHINERY (frozen, out of scope): tools/, PROBES.json, snapshots/, SURFACE.md.
triage: P3
max_iter: 13                   # raised 12 -> 13 by the user 2026-09-24 so all seven round-3 tasks get worked
max_rounds: 3
batch: 3
mode: auto
commit_style: grouped
merge_cadence: at-exit
```

## Round-1 approvals (2026-09-23)

All five BLOCKED findings approved by the user: T-010 (counter deposits must count toward
retainer_paid_total — reference-linked retainers; payment-link-math golden + SURFACE re-record sanctioned
for that field), T-011 (Heimdall transport timeout leaves the terminal reservation pending for replay),
T-012 (null description -> 422), T-013 (poll watermark bounded on a poison invoice), T-017 (rate limit on
cancel_invoice_payment_link). Each carries the changelog + golden re-record obligation.

## Round-2 approvals (2026-09-24)

Round 2 filed 12 (security 2, robustness 5, cleanliness 1, tests 4) + 3 triaged. ALL EIGHT behavior changes
approved: T-027 atomic terminal settle claim, T-028 best-effort credit read after invoice create, T-029 link
idempotency key under a lock / from the row id, T-030 PushcutUnreachable + SMS duplicate guard, T-031 claim the
version before the Books contact push, T-019 contacted labels in the Activity Rail (2 EVENT_LABEL_KEY entries +
keys in 14 locales: fe-i18n-parity golden + SURFACE i18n section re-record sanctioned), T-024 rating route:
reject unknown client ids + rate limit + negative cache (security auditor gave no note; orchestrator held it),
T-025 pickup-SMS rate limit (same). Each carries the changelog + confined golden re-record obligation.

## Campaign re-baseline (user-sanctioned 2026-09-24, iteration 9)

The payment-link-reconcile probe (tools/probe_payment_link_reconcile.py) froze NOW/TODAY to 2026-09-16 but its
link_kw() seed never set created_at, so the row took the DB's real now() and `expires_in_days(expires_on,
created_at.date())` drifted with the UTC date (7 when recorded, 6 from 2026-09-25 UTC; identical at BASE). Found by the
iteration-8 verifier. With the user's consent a chore commit `chore(refactor-loop): re-baseline payment-link-reconcile
probe with a frozen created_at (user-sanctioned)` sets created_at=NOW in link_kw, re-records ONLY that golden and logs
it in BASELINE-CHANGELOG.md. The verifier treats that commit's tools/ + snapshots/ diff as SANCTIONED; every later
iteration is judged against the new golden. Lesson: every probe fixture must set every timestamp column explicitly.

## Round-3 approvals (2026-09-24)

Round 3 (final) filed 10 (security 1, robustness 4, cleanliness 2, tests 3) + 1 triaged. ALL SIX behavior changes
approved: T-041 invoice double-billing guard (409 on quote_invoiced + module lock), T-042 Heimdall 404 must not flip a
paid terminal row to failed (+ failed event), T-040 claim as its own committed transaction before the Zoho contact write
(version bumped before Books answers), T-043 arm the SMS guard before the Pushcut call, T-039 Zoho contact PATCH gate /
scope + event (worker decides between AITO_UPDATE gate and card-scoping; the create flow calls it with aito:create),
T-033 delete api.importAitoProjects (SURFACE export removal sanctioned). Iterations 10-12 remain; MAX_ROUNDS reached —
no round 4; leftovers go to FINAL_REPORT.md.

## Sanctioned surface rule (user decision 2026-09-25, iteration 11)

Tasks MAY ADD (never rename or remove) an `export` in scope frontend files (components/aito/**, hooks/useAito*,
utils/aito*) and backend scope modules. The worker regenerates SURFACE.md in the SAME commit
(`bash tools/gen_surface_aito20.sh > SURFACE.md`) and appends a BASELINE-CHANGELOG.md entry ("re-baseline: additive
internal export <name> for T-xxx, user-sanctioned 2026-09-25"). The verifier treats a SURFACE.md diff that is
additions-only in the exports sections, with a matching changelog entry, as SANCTIONED. Removals still need a
user-approved behavior change (T-033 is one). Golden probes are unaffected (they do not enumerate exports).

## Ancestry

```
UPSTREAM: f9114764246c5d8b75238ef55d04daef84e02196   (main at setup — "Merge branch 'aito-counter-payments' into main"; main == origin/main)
BASE:     refactor-base                              (tag; resolve with `git rev-parse refactor-base`)
```

No debris at setup: no prior worktree, branch, or refactor-base / loop-* tags (campaign 19's were deleted after its merge).

## Agents

Plugin agents (refactor-loop:audit-*, refactor-loop:refactor-worker,
refactor-loop:refactor-verifier). The main checkout's UNTRACKED `.claude/agents/
refactor-worker.md` and `refactor-verifier.md` are stale copies of an older
plugin release — NOT used; always dispatch with the `refactor-loop:` prefix.

## Commands

```
build:     cd frontend && npm run build      # VERIFIER ONLY; rewrites tracked static/ — restore with `git checkout -- static && git clean -fdXq -- static`
lint:      ruff check backend/ && ruff format --check backend/
           cd frontend && npm run lint       (ESLint)
typecheck: cd frontend && npx tsc -b --noEmit
i18n gate: cd frontend && npm run check:i18n
test:      ./venv/bin/python3 -m pytest backend/tests/ -q -n 10 --ignore=backend/tests/unit/services/test_bambu_ftp.py
           cd frontend && npm run test:run
coverage:  bash tools/coverage_aito20.sh [frontend|backend|both]
surface:   bash tools/gen_surface_aito20.sh > SURFACE.md && git diff --exit-code SURFACE.md
probes:    ./venv/bin/python3 tools/snapshot.py verify      (34 probes)
```

Run a SINGLE vitest file with `cd frontend && node_modules/.bin/vitest run <file>` —
`npm run test:run -- <file>` runs ALL files and hands the path to the i18n checker.
Backend `-n 10`: a parallel Claude session often runs its own suite in the main checkout.

## Coverage baseline (scope-only; ratchet on statements)

Backend (37 scope files via cov_filter.py globs), 2026-09-23, full suite -n 10, coverage on:

```
SCOPED statements: 6161/6340 = 97.18%   <- RATCHET METRIC (backend)
SCOPED branches:   1522/1610 = 94.53%
lowest files: aito_terminal_payments.py 90.80 · aito_payment_links.py 90.88 · schemas/heimdall.py 91.30 · aito_client_rating.py 93.98
```
backend tests: 15462 passed, 0 failed, 1 skipped, 431 s.

Frontend (scope globs in tools/coverage_aito20.sh, `coverage/coverage-summary.json` total), 2026-09-23:

```
SCOPED statements: 4853/5240 = 92.61%   <- RATCHET METRIC (frontend)
SCOPED branches:   4853/5399 = 89.88%
SCOPED functions:  1405/1504 = 93.41%
SCOPED lines:      4240/4509 = 94.03%
164 scope files; lowest: AitoFxDemoPage.tsx 0% (DEV-only demo, 49 stmts) · celebration/render.ts 2.43% (canvas) ·
PdfDownloadButton.tsx 39.28% · InvoiceDownloadButton.tsx 66.66% · CelebrationLayer.tsx 74.15% · PanelTabs.tsx 76.19%
(The vitest text table hides fully-covered files; coverage/coverage-summary.json lists all 164.)
frontend tests: vitest exit 0 with reportOnFailure on = 0 failed (pass count not captured by the script's tail).
```

Coverage may only go up. Adding a coverage exclusion or narrowing the include
list in `tools/coverage_aito20.sh` is a protocol violation, not a fix.
`.coverage` at the repo root is a TRACKED file (campaign-1 leak) that pytest-cov
rewrites; the script restores it — never stage it. `coverage-aito20-backend.json`
and `frontend/coverage/` are untracked/ignored output — never stage them.

## known_broken

(none — backend 0 failed, frontend 0 failed at UPSTREAM, both suites run with coverage on)

known_flaky (NOT known_broken — carried from campaigns 9-19; a failure in one of these is not a
regression until it reproduces ALONE on an idle machine): frontend PrintModal, ArchivesPage,
FileUploadModal, ModelViewerModal, StatsPageUserFilter1894, ConfigureAmsSlotModal, AppRouterAitoGuard,
QueuePage, SettingsPage, SlicerSettingsPanel, ImportQuoteDrawer; backend test_library_slice_api,
test_external_camera (ffmpeg path), test_aito_quote_sync wake-drain, test_slicer_stall_timeout,
test_scheduler_concurrent_dispatch, test_plug_energy_history (22:00-22:30 UTC), test_aito_routes
(thousand-project import, slow under load), test_library_api CWD precondition (fails from repo root).

## Static gates at UPSTREAM (2026-09-23)

ruff check: clean · ruff format: 1100 files formatted · eslint: clean · tsc -b: clean · i18n parity: 13 locales in parity with en (7789 keys).

## Security tooling (checked 2026-09-23)

```
semgrep     : available (~/.local/bin/semgrep)
gitleaks    : available (/opt/homebrew/bin/gitleaks)
pip-audit   : available (venv module, 2.10.1)
bandit      : available (venv, 1.9.4)
npm audit   : available
trivy/codeql: NOT installed (the test_security.sh --full extras; not blocking)
```
test_security.sh needs bash 4 (macOS stock bash 3.2 lacks `declare -A`) — run the scans directly.

## Golden probes (34)

Recorded at BASE and frozen. `snapshot.py verify` must be 34/34 every iteration
(replayed at setup after recording: 34/34, deterministic).

Inherited app-wide guards (10): app-openapi-index, app-ddl, app-permissions, app-settings,
app-middleware-stack, app-migrations-index, app-route-perms, fe-router, fe-i18n-parity, fe-money-pure.
Inherited tracking (5, campaign 19): tracking-backend, tracking-contract, tracking-http,
tracking-frontend-pure, tracking-i18n.
Re-added Aito probes from campaigns 5 / 17 / 18 (19): aito-openapi (full spec of /aito, /heimdall, /zoho paths),
aito-pydantic-schemas (JSON schema of schemas/aito + schemas/heimdall), aito-board-rules-py, aito-board-rules-ts,
aito-route-perms (aito, aito_payments, heimdall, zoho), aito-event-depths, aito-quote-money, aito-frontend-pure,
aito-ai-prompts, aito-status-comments, heimdall-signing, heimdall-wire, payment-link-math, payment-link-api,
payment-link-reconcile, stats-backend-aggregate, stats-contract, stats-frontend-pure, stats-i18n.

Replay at setup, BEFORE re-recording: 5/15 inherited probes matched. Every diff attributed
to main's feature work since campaign 19's base (c72a6b4c69, 138 commits): client rating
(aito_client_ratings table, GET /aito/clients/{id}/rating), counter payments (aito_terminal_payments
table, terminal/manual/invoice-link routes, document_kind on payment links), contact persons
(client_contact_person_id/_name), the pay-before-acceptance rollback (`accepted` flag on the tracking
payload), the upstream merge (MakerWorld permissions gone from app-route-perms), five new migrations,
and the i18n key count (fe-i18n-parity, tracking-i18n: validate*/accepted* keys). All re-recorded
pre-BASE; after re-record 34/34, SURFACE.md regenerates byte-identical.

## Environment notes for this machine

- Use `./venv/bin/python3`; system python lacks deps. Ruff is system-wide.
- The worktree's `venv` is a SYMLINK into the main checkout; `frontend/node_modules` is an APFS clone.
  Do not run `npm install` or `pip install` here.
- Run long commands under `caffeinate -i` — Mac sleep kills subagents.
- Backend coverage needs `concurrency = ["greenlet", "thread"]` (already in pyproject.toml).
- A parallel session may be working in the main checkout. Never `git stash` anywhere (the stash
  stack is shared); never `git add -A` anywhere; compare against `git show HEAD:path` instead.
- Both suites flake under load; re-run a failing file ALONE on an idle machine before believing it.
- Auditors under-flag behavior_change when a change alters a value the goldens pin: before selecting,
  grep snapshots/ for the function/field a task changes; if pinned, hold for approval.
- Two workers in the same worktree collide on BASELINE-CHANGELOG.md — keep workers sequential.
