# BASELINE.md — refactor-loop campaign 21 (the whole Aito feature, seeded by campaign 20's leftovers)

Durable memory of this run. Never committed. Re-read after any compaction.

## Counters

```
iteration: 15
round: 3
dry_rounds: 0
dry_decided_round: 0
phase: exit (stopped on user request 2026-09-27 after loop-15; round 3 partial)
```

## Parameters (effective, as confirmed with the user 2026-09-26)

```
scope: THE WHOLE AITO FEATURE, front and back end — identical to campaign 20's scope (text below), plus the
  campaign-20 leftovers as seeds: its 8 TRIAGE.md P3s (promoted into PLAN.md; T-016 retired as a duplicate of
  T-015) and three unfiled leads (T-044 SMS guard un-arm, T-045 create_contact_person docstring, T-046 retainer
  read ordering). Campaign 20's PLAN.md sits beside PLAN.md as PLAN.campaign20.md so ingest dedups against
  everything c20 already filed/fixed and ids continue from T-044.
  BACKEND (backend/app): api/routes/aito.py, api/routes/aito_payments.py, api/routes/heimdall.py, api/routes/zoho.py;
    schemas/aito.py, schemas/heimdall.py; models/aito_*.py; services/aito_*.py; services/openrouter.py,
    services/heimdall.py, services/pushcut.py, services/zoho.py (NOT zoho_filaments.py). Aito slices of shared files
    (core/database.py migrations, core/permissions.py, main.py tracking branches, ws presence slice).
  FRONTEND (frontend/src): pages/Aito*.tsx; components/aito/**; hooks/useAito*.ts, useTracking*.ts; utils/aito*.ts,
    utils/tracking*.ts, utils/projectSeed.ts; the Aito slices of api/client.ts, App.tsx, index.css, i18n locales.
  OUT of scope as targets: calculator, printers, filament, library, spoolman, camera, auth core, upstream code.
  TESTS: backend test_aito_* / test_ws_aito_* / test_zoho* / test_heimdall* / test_pushcut* / test_openrouter* and
    aito fixtures; frontend __tests__ files named *Aito* / *aito* — always writable.
  RECENTLY AUDITED: campaign 20 (2026-09-23..25) audited THIS SAME SCOPE for 3 rounds — auditors are told to go
    deeper than c20, and that PLAN.campaign20.md dedup suppresses repeats.
  LOOP MACHINERY (frozen, out of scope): tools/, PROBES.json, snapshots/, SURFACE.md, refactor-campaign*-archive/.
triage: P3
max_iter: 18                   # raised 12 -> 18 by the user 2026-09-27 so rounds 2 and 3 get worked
max_rounds: 3
batch: 3
mode: auto
commit_style: grouped
merge_cadence: at-exit
```

## Ancestry

```
UPSTREAM: 636305d9c6e5f45fe1d114c35d31d02a3660a2cd   (local main at setup — c20 merge + archive + static rebuild; unpushed, 19 ahead of origin)
BASE:     refactor-base                              (tag; resolve with `git rev-parse refactor-base`)
```

No debris at setup: campaign 20's worktree/branch/tags deleted after its merge (2026-09-26).
The main checkout carries a peer session's UNCOMMITTED create/regenerate-description edits (routes/aito.py,
schemas/aito.py, client.ts, NewProjectDrawer, useAitoPageMutations, AitoPage + tests) — they are NOT in this
worktree; expect overlap in routes/aito.py at merge time.

## Agents

Plugin agents (refactor-loop:audit-*, refactor-loop:refactor-worker, refactor-loop:refactor-verifier).
Always dispatch with the `refactor-loop:` prefix (main's untracked .claude/agents copies are stale).

## Commands

```
build:     cd frontend && npm run build      # VERIFIER ONLY; rewrites tracked static/ — restore with `git checkout -- static && git clean -fdXq -- static`
lint:      ruff check backend/ && ruff format --check backend/
           cd frontend && npm run lint       (ESLint)
typecheck: cd frontend && npx tsc -b --noEmit
i18n gate: cd frontend && npm run check:i18n
test:      ./venv/bin/python3 -m pytest backend/tests/ -q -n 10 --ignore=backend/tests/unit/services/test_bambu_ftp.py
           cd frontend && npm run test:run
coverage:  bash tools/coverage_aito21.sh [frontend|backend|both]
surface:   bash tools/gen_surface_aito21.sh > SURFACE.md && git diff --exit-code SURFACE.md
probes:    ./venv/bin/python3 tools/snapshot.py verify      (34 probes)
```

Run a SINGLE vitest file with `cd frontend && node_modules/.bin/vitest run <file>` —
`npm run test:run -- <file>` runs ALL files. Long runs: background to a log file and poll (600 s watchdog).
Never `git stash`; compare against `git show HEAD:path`. Never `git add -A`; stage files by name.

## Coverage baseline (scope-only; ratchet on statements) — 2026-09-26 at UPSTREAM

Backend (cov_filter.py globs), full suite -n 10, coverage on:

```
SCOPED statements: 6480/6621 = 97.87%   <- RATCHET METRIC (backend)
SCOPED branches:   1620/1708 = 94.85%
```
backend tests: 15609 passed, 0 failed, 1 skipped, 590 s.

Frontend (scope globs in tools/coverage_aito21.sh, coverage/coverage-summary.json total):

```
SCOPED statements: 4866/5240 = 92.86%   <- RATCHET METRIC (frontend)
SCOPED branches:   4880/5408 = 90.23%
SCOPED functions:  1415/1506 = 93.95%
SCOPED lines:      4251/4512 = 94.21%
```
frontend tests: vitest exit 0 (0 failed).

Coverage may only go up. Adding a coverage exclusion or narrowing the include list in tools/coverage_aito21.sh
is a protocol violation. `.coverage` at the repo root is TRACKED — the script restores it; never stage it.
`coverage-aito21-backend.json` and `frontend/coverage/` are output — never stage them.

## known_broken

(none — backend 0 failed, frontend 0 failed at UPSTREAM)

known_flaky (NOT known_broken — carried from campaigns 9-19; a failure in one of these is not a
regression until it reproduces ALONE on an idle machine): frontend PrintModal, ArchivesPage,
FileUploadModal, ModelViewerModal, StatsPageUserFilter1894, ConfigureAmsSlotModal, AppRouterAitoGuard,
QueuePage, SettingsPage, SlicerSettingsPanel, ImportQuoteDrawer; backend test_library_slice_api,
test_external_camera (ffmpeg path), test_aito_quote_sync wake-drain, test_slicer_stall_timeout,
test_scheduler_concurrent_dispatch, test_plug_energy_history (22:00-22:30 UTC), test_aito_routes
(thousand-project import, slow under load), test_library_api CWD precondition (fails from repo root).

## Static gates at UPSTREAM (2026-09-26)

ruff check: clean · ruff format: 1104 files formatted · eslint: clean · tsc -b: clean · i18n parity: 13 locales in parity.

## Security tooling (checked 2026-09-26)

semgrep (~/.local/bin), gitleaks (/opt/homebrew/bin), pip-audit (~/.local/bin), bandit (venv), npm audit: available.
trivy/codeql: not installed (not blocking). test_security.sh needs bash 4 — run the scans directly.

## Golden probes (34) + SURFACE

The 34 campaign-20 probes (PROBES.json + snapshots/, tracked in main) replayed 34/34 MATCH at UPSTREAM — none re-recorded.
SURFACE.md regenerated with tools/gen_surface_aito21.sh (copy of c20's generator; R13 i18n section widened to also
capture quoted single-segment aito.* keys — the c20 machinery lead; +383 key lines; also +1 poll_contacts line from
main's contact-poll commit). Setup commit: `chore(refactor-loop): setup` (tag refactor-base).

## Sanctioned surface rule (carried from campaign 20; RE-CONFIRMED by the user for campaign 21 on 2026-09-26)

Tasks MAY ADD (never rename or remove) an `export` in scope frontend files and backend scope modules. The worker
regenerates SURFACE.md in the SAME commit (`bash tools/gen_surface_aito21.sh > SURFACE.md`) and appends a
BASELINE-CHANGELOG.md entry ("re-baseline: additive internal export <name> for T-xxx"). The verifier treats an
additions-only exports diff with a matching changelog entry as SANCTIONED. Removals need a user-approved behavior change.

## Round-1 approvals (2026-09-26)

Round 1 filed 21 (tests 4, robustness 10, security 5, cleanliness 2) + 1 triaged (T-066). Held for approval: the 15
panel behavior changes + T-068 (i18n key deletion moves fe-i18n-parity en_key_count 7793->7789) + seeds T-032, T-044,
T-045, T-046. APPROVED 19: T-032, T-044, T-045, T-046, T-051..T-061, T-063, T-064, T-065, T-068. DENIED 1: T-062
(patch_contact fresh-own-card scope — too intrusive for a staff tool). Each approved task carries the obligation:
same commit = change + confined golden/SURFACE re-record + BASELINE-CHANGELOG.md entry ("user-approved 2026-09-26"),
commit message contains "(user-approved behavior change)".

## Round-2 approvals (2026-09-27)

Round 2 filed 10 (security 1, robustness 6, cleanliness 3, tests 0) + 3 triaged (T-072 zoho _seg dots, T-076 stand-down
idiom, T-081 version listener bump). ALL 7 behavior changes APPROVED: T-071 websocket is_active, T-077 terminal 2xx
unparseable body -> ambiguous, T-078 manual payment Books 5xx/non-JSON -> outcome-unknown, T-079 retainer-creation
timeout keeps the guard, T-080 contact poll poison cap, T-082 terminal re-drive cap + sync_error, T-083 payment-link poll
per-row catch (regression from T-060). Earlier user decisions this campaign: T-062/T-063 DECLINED; T-069/T-070 filed at
the user's request; T-026 approved 2026-09-27; non-JSON 4xx ambiguity kept; >2000-rows-per-second poll stall documented;
T-059 re-drive behind is_configured documented; MAX_ITER 12 -> 18. Round 2 was PRODUCTIVE -> dry_rounds 0.
