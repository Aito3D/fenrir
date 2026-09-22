# BASELINE.md — refactor-loop campaign 18 (Aito statistics feature)

Durable memory of this run. Never committed. Re-read after any compaction.

## Counters

```
iteration: 8
round: 2
dry_rounds: 0
dry_decided_round: 0
phase: loop
```

## Parameters (effective, as confirmed with the user)

```
scope: backend/app/services/aito_stats.py; the GET /aito/stats route in backend/app/api/routes/aito.py; the AitoStats* schemas in backend/app/schemas/aito.py; frontend/src/components/aito/stats/**; frontend/src/components/aito/StatsView.tsx
triage: P3
max_iter: 8
max_rounds: 3
batch: 3
mode: auto
commit_style: grouped
merge_cadence: at-exit
```

SCOPE NOTE — `frontend/src/components/stats/TimeframeSelector.tsx` and
`timeframe.ts` are **out of scope** (the user chose "stats feature only"; they
are shared with the Fenrir stats page). They ARE pinned by the
`stats-frontend-pure` probe and by SURFACE.md, so a change to them fails the
iteration rather than passing silently.

## Ancestry

```
UPSTREAM: c85714e94969810ca1cdc2a31737a32f8783e8d0   (main at setup — "fix(merge): carry the fork's tests onto upstream's new contracts")
BASE:     refactor-base                              (tag; resolve with `git rev-parse refactor-base`)
```

A previous `refactor-base` tag (2db3c0dc22, campaign 16's setup commit from
2026-09-16) was found orphaned on main — its branch and worktree had been
removed without it. Deleted with the user's consent before this campaign
tagged its own BASE.

## Commands

```
build:    cd frontend && npm run build
lint:     cd frontend && npm run lint          (ESLint)
          ruff check backend/ && ruff format --check backend/
typecheck: cd frontend && npx tsc -b --noEmit
i18n gate: cd frontend && npm run check:i18n
test:     ./venv/bin/python3 -m pytest backend/tests/ -q -n 8 --ignore=backend/tests/unit/services/test_bambu_ftp.py
          cd frontend && npm run test:run
coverage: bash tools/coverage_stats.sh [frontend|backend|both]
surface:  bash tools/gen_surface_stats.sh > SURFACE.md
probes:   ./venv/bin/python3 tools/snapshot.py verify
```

Run a SINGLE vitest file with `frontend/node_modules/.bin/vitest run <file>` —
`npm run test:run -- <file>` runs all 461 files.

## Coverage baseline (scope-only; ratchet on statements)

Frontend (`components/aito/stats/**` + `StatsView.tsx`), 2026-09-20:

```
Statements : 94.27%  (395/419)   <- RATCHET METRIC
Branches   : 83.29%  (409/491)
Functions  : 93.98%  (125/133)
Lines      : 94.79%  (328/346)
```

Backend (`services/aito_stats.py`), 2026-09-20:

```
SCOPED statements: 314/323 = 97.21%   <- RATCHET METRIC
SCOPED branches:   133/142 = 93.66%
file total:                   96.13%
```

Coverage may only go up. Adding a coverage exclusion or narrowing the include
glob in `tools/coverage_stats.sh` is a protocol violation, not a fix.

## known_broken

```
backend/tests/integration/test_library_api.py::TestLibraryFoldersAPI::test_delete_folder_removes_managed_files_from_disk
```

One test, and it is NOT the loop's to fix silently: it asserts a precondition
about the process CWD (`os.getcwd() != settings.base_dir`) that does not hold
when pytest is invoked from the repo root, which is how every command in this
file runs it. Verified failing identically on pre-campaign `main`. Filed as a
P1 task at setup per the skill.

Everything else is green at BASE: 15049 backend passed, 6833 frontend passed,
14/14 golden probes matching, i18n parity 7651 keys x 14 locales.

## Security tooling

```
bandit      : available (./test_security.sh bandit)
pip-audit   : available
npm audit   : available
semgrep     : NOT installed (no network install attempted; audit-security uses
              bandit + manual review instead)
gitleaks    : NOT installed (same)
CodeQL/Trivy: available only via ./test_security.sh --full (slow; not run per iteration)
```

## Golden probes (14)

Recorded at BASE and frozen. `snapshot.py verify` must be 14/14 every
iteration.

Campaign-scoped (new this campaign):
- `stats-backend-aggregate` — `compute_aito_stats` over a seeded 9-card board
  with 23 events, 13 stage moves and 5 task rows, across 6 window/timezone
  cases plus the empty board; every block populated (rework 1 move, overdue 2
  buckets, 6 new / 2 returning clients, stage days over 5 columns, quote age
  over 3 buckets, size bands, previous-period). Clock frozen at
  2026-03-15T12:00Z; `created_at` seeded explicitly (its column default is
  `func.now()`).
- `stats-contract` — the endpoint's parameters and all 19 `AitoStats*` models
  (property names, types, required sets), descriptions excluded.
- `stats-frontend-pure` — `computeDateRange` over all 9 presets at a frozen
  clock (TZ=UTC), the screen registry's order and its `aria-controls` ids, and
  the full palette.
- `stats-i18n` — the 118 `aito.stats.*` keys in all 14 locales, as key paths +
  placeholder sets (translations themselves not recorded).

Inherited app-wide guards: `app-openapi-index`, `app-ddl`, `app-permissions`,
`app-settings`, `app-middleware-stack`, `app-migrations-index`,
`app-route-perms`, `fe-router`, `fe-i18n-parity`, `fe-money-pure`.

Campaign-17's Heimdall/payment-link probes were dropped from PROBES.json (out
of scope, 5 slow probes); their `.golden` files were removed in the setup
commit.

## Environment notes for this machine

- Use `./venv/bin/python3`; system python lacks deps. Ruff is system-wide.
- The worktree's `venv` and `frontend/node_modules` are SYMLINKS into the main
  checkout. Do not run `npm install` here.
- Run long commands under `caffeinate -i` — Mac sleep kills subagents.
- Backend coverage needs `concurrency = ["greenlet", "thread"]` (already in
  pyproject.toml). Without it `aito_stats.py` reads ~30 points low.
- A parallel session may be working in the main checkout. Never `git stash`
  there; never `git add -A` anywhere.
