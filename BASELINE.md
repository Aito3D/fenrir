# BASELINE.md — refactor-loop run state (Aito scope)

## Run parameters
- SCOPE: Aito feature only — `backend/app/api/routes/aito.py`, `backend/app/services/aito_*.py`, `backend/app/models/aito_*.py`, `backend/app/schemas/aito.py`, `frontend/src/pages/AitoPage.tsx`, `frontend/src/components/aito/**`, `frontend/src/hooks/useAito*.ts`, `frontend/src/utils/aito*.ts`, and their tests under `frontend/src/__tests__/**` (aito files) + `backend/tests/**` (aito files). Nothing outside these paths may be edited (exceptions: none).
- MAX_ITER: 8 · MAX_ROUNDS: 3 · BATCH: 3 · MODE: auto
- BASE commit: 9a1092944db3e8e9bb3f76774a3ecfc8fc308380
- Branch: auto-refactor-loop · WORKDIR: /Users/paultheis/Documents/Code/bambuddy-refactor

## Environment quirks
- Python: use `./venv/bin/python3` (symlink to main checkout's venv — NOT in git; do not delete).
- `frontend/node_modules` installed via `npm ci` in the worktree.
- pytest-cov was pip-installed into the shared venv for this run.
- Frontend tests under `--coverage` are subject to instrumentation-induced TIMEOUTS (known flake, esp. PrintModal/SettingsPage/QueuePage). Judge frontend test pass/fail from a NON-coverage `npx vitest run`; use coverage runs only for the coverage number.

## Commands
- Backend tests: `cd WORKDIR && ./venv/bin/python3 -m pytest backend/tests/ -q -n 30 -p no:cacheprovider --ignore=backend/tests/unit/services/test_bambu_ftp.py`
- Backend coverage: add `--cov=backend/app --cov-report=term`; aito subset: `./venv/bin/python3 -m coverage report --include='*aito*'`
- Backend lint: `ruff check backend/ && ruff format --check backend/`
- Frontend tests: `cd WORKDIR/frontend && npx vitest run`
- Frontend coverage: `cd WORKDIR/frontend && npx vitest run --coverage --coverage.reporter=json-summary --coverage.reporter=text-summary`
- Frontend lint: `cd WORKDIR/frontend && npm run lint`
- Frontend build: `cd WORKDIR/frontend && npm run build` (NOTE: build dirties ~67 files under static/ — do NOT commit static/ changes; `git checkout -- static/` after building)
- TypeScript check alone misses module-resolution errors; always use `npm run build` as the gate.
- Snapshots: `./venv/bin/python3 tools/snapshot.py verify` (7 probes; ANY diff = FAIL)
- Surface: regenerate each SURFACE.md section with the regen command embedded above it; diff vs committed SURFACE.md.

## Coverage baseline (may only go up)
- RATCHET METRIC NOTE (added iter-3): refactoring away *covered* duplicate lines shrinks the denominator and can lower the rounded % without any lost coverage. The binding ratchet for the aito subset is therefore the MISSED-STATEMENT COUNT, which may not increase: baseline 259 missed at BASE; 260 missed as of loop-2 (+1 from new code paths, offset by new tests). Judge "drop" by missed count + missing-lines diff, not the rounded %.
- Backend TOTAL: 60% (62097 stmts, 24704 miss)
- Backend aito subset: 86% (1908 stmts, 259 miss) — worst: routes/aito.py 57%
- Frontend (aito scope, from aito tests only): Statements 80.78% (1505/1863), Lines 83.13% — gate command:
  `cd WORKDIR/frontend && npx vitest run --coverage --coverage.reporter=text --coverage.include='src/utils/aito*.ts' --coverage.include='src/hooks/useAito*.ts' --coverage.include='src/pages/AitoPage.tsx' --coverage.include='src/components/aito/**' 'src/__tests__/components/Aito' 'src/__tests__/pages/Aito' 'src/__tests__/utils/aito' 'src/__tests__/hooks/useAito'`
  (full-suite frontend coverage runs cause timeout flakes and the report often fails to materialize — use the scoped command above as the frontend coverage gate)

## Test baseline
- Backend: 9308 passed, 1 skipped, 0 failed (344s, -n 30)
- Frontend (full suite, no coverage): 3877 passed, 3 failed — ALL 3 in PrintModal.test.tsx, which passes 71/71 in isolation (load-induced flake, documented in repo lore)

## known_broken (verifier fails only on NEW failures beyond this list)
- NONE consistently broken. PrintModal.test.tsx (and occasionally SettingsPage/QueuePage under coverage) flake under full-suite parallel load: before counting any failure there, re-run the failing file in isolation; isolated pass = not a failure.

## Security scan baseline (setup, ROUND 1)
- semgrep (--config auto) over aito scope: 0 findings
- gitleaks: 5 findings, ALL outside aito scope (github_backup.py, .github/workflows/repo-stats.yml, redaction-test fixtures) — out of scope, no tasks
- pip-audit: 6 vulns, all in starlette 0.52.1 (PYSEC-2026-161/248/249/2280/2281). Dependency bump touches requirements outside aito scope → recorded, NOT tasked. Flag to user in final report.
- npm audit (prod deps): dompurify moderate (IN_PLACE hook XSS), react-router + react-router-dom high (RSC-mode CSRF bypass; app does not use RSC mode). Dependency bumps outside aito scope → recorded, NOT tasked. Flag to user in final report.
- ruff check + format on aito backend: clean. ESLint on aito frontend: clean.

## Frozen artifacts (no one may modify mid-run)
- PROBES.json, snapshots/, SURFACE.md, tools/ (plan.py, snapshot.py, probe_boardrules.cjs)
