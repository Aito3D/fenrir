# BASELINE.md — refactor-loop campaign 17 (Heimdall payment links)

NEVER `git add` this file. It is rewritten every iteration; committing it
would put loop state into the blind verifier's diff.

## Counters

```
iteration: 3
round: 1
dry_rounds: 0
dry_decided_round: 0
phase: loop
```

## Parameters (effective, as confirmed with the user)

```
scope: the Heimdall payment-link feature (file list below)
triage: P3
max_iter: 12
max_rounds: 3
batch: 3
mode: auto
commit_style: grouped
merge_cadence: at-exit
```

Campaign number 17 for reporting. The branch `auto-refactor-loop` is BRAND
NEW (no earlier campaign's commits on it), so iteration tags are plain
`loop-N` and the squash base falls back to `refactor-base` when no `loop-*`
tag exists yet — the campaign-1 rule, which is the correct one here because
`refactor-base` is THIS campaign's own setup commit. Earlier campaigns'
branches and tags were all deleted on 2026-09-15.

## Commits

```
UPSTREAM: dce9cafa66f31cd026acddb68cdd38981280a07f   (main, where the worktree was cut)
BASE:     refactor-base  ->  2db3c0dc22356f3ea57fd2741a55c8e7f1623726
WORKDIR:  /Users/paultheis/Documents/Code/bambuddy-refactor
```

## SCOPE

Production files an auditor may file against and a worker may edit:

```
backend/app/services/heimdall.py
backend/app/services/aito_payment_links.py
backend/app/api/routes/heimdall.py
backend/app/schemas/heimdall.py
backend/app/models/aito_payment_link.py
backend/app/api/routes/aito.py               (payment-link paths only)
backend/app/schemas/aito.py                  (payment-link paths only)
backend/app/services/aito_quote_sync.py      (payment-link paths only)
backend/app/services/aito_tracking.py        (payment-link paths only)
backend/app/api/routes/settings.py           (heimdall_* keys only)
backend/app/schemas/settings.py              (heimdall_* keys only)
backend/app/core/database.py                 (aito_payment_links migration only)
frontend/src/components/HeimdallSettings.tsx
frontend/src/components/aito/PaymentLinkRow.tsx
frontend/src/api/client.ts                   (payment-link/heimdall calls only)
frontend/src/pages/SettingsPage.tsx          (Heimdall card only)
```

Test files covering the above are always writable regardless of SCOPE:

```
backend/tests/unit/test_heimdall_client.py
backend/tests/unit/test_heimdall_route.py
backend/tests/unit/test_heimdall_settings.py
backend/tests/unit/test_aito_payment_links.py
backend/tests/unit/test_aito_payment_link_api.py
backend/tests/unit/test_aito_payment_link_model.py
backend/tests/unit/test_aito_tracking_payment.py
backend/tests/unit/test_outbound_url_ssrf_guards.py
frontend/src/__tests__/components/HeimdallSettings.test.tsx
frontend/src/__tests__/components/AitoPaymentLinkRow.test.tsx
```

OUT of scope (the loop's own machinery, frozen): `tools/`, `PROBES.json`,
`snapshots/`, `SURFACE.md`.

## Commands

```
build (frontend):  cd frontend && npm run build          # tsc -b + Vite + Safari-16 baseline check
lint (backend):    ruff check backend/ && ruff format --check backend/
lint (frontend):   npm --prefix frontend run lint         # eslint
test (backend):    ./venv/bin/python3 -m pytest backend/tests/ -q -n 12 -p no:randomly \
                     --ignore=backend/tests/unit/services/test_bambu_ftp.py
test (frontend):   cd frontend && npx vitest run
coverage (scope):  bash tools/coverage_c17.sh [backend|frontend|both]
goldens:           ./venv/bin/python3 tools/snapshot.py verify
surface:           bash tools/gen_surface_c17.sh > /tmp/s.md && diff /tmp/s.md SURFACE.md
```

Use `./venv/bin/python3` for every Python command; the system python lacks the
project's dependencies. Ruff is on PATH. Run everything from WORKDIR's root.

## Coverage baseline — ratchet on SCOPED statements

Measured at BASE with `bash tools/coverage_c17.sh`. coverage.py measures the
whole `backend/app` package and `tools/cov_filter.py` reports the scope, so
the number cannot be inflated by narrowing what is measured.

```
BACKEND  scoped statements: 2670/2758 = 96.81%     <- THE RATCHET
BACKEND  scoped branches:    651/704  = 92.47%
FRONTEND scoped statements:    74/83  = 89.15%
FRONTEND scoped branches:      74/96  = 77.08%
FRONTEND scoped functions:     15/20  = 75.00%
FRONTEND scoped lines:         71/77  = 92.20%

per-file (backend, statements):
  95.91%  backend/app/api/routes/aito.py
 100.00%  backend/app/api/routes/heimdall.py
 100.00%  backend/app/models/aito_payment_link.py
  99.23%  backend/app/schemas/aito.py
  91.30%  backend/app/schemas/heimdall.py
  89.59%  backend/app/services/aito_payment_links.py
  97.21%  backend/app/services/aito_quote_sync.py
  97.44%  backend/app/services/aito_tracking.py
  95.00%  backend/app/services/heimdall.py
```

Coverage may only go up. Adding a coverage exclusion, or narrowing
`tools/coverage_c17.sh`'s include list, is a protocol violation — treated
exactly like deleting a test.

Note: `[tool.coverage.run]` in `pyproject.toml` sets
`concurrency = ["greenlet", "thread"]`. Without it every async route body
reads as unexecuted (routes/aito.py measured 61.77% instead of ~97%). That
setting is frozen; the rest of `pyproject.toml` is ordinary code.

## Test suite at BASE

```
backend:   14659 passed, 1 failed, 1 skipped   (364s, -n 12)
frontend:  6633 passed in 446 files, 0 failed  (60s)
build:     green — 202 bundles parse-compatible with the Safari 16.0 baseline
lint:      ruff check clean, ruff format clean (1038 files), eslint clean
goldens:   16/16 probes match
```

### known_broken

Exactly one test fails at BASE. It fails ALONE, deterministically, in 2s — a
genuine pre-existing failure, not a load flake:

```
backend/tests/integration/test_library_api.py::TestLibraryFoldersAPI::test_delete_folder_removes_managed_files_from_disk
```

The verifier fails only on NEW failures beyond this list. SETUP step 7 files
one P1 task for it.

## Golden probes (16)

`tools/snapshot.py verify` replays all of them; ANY diff is a behavior change.

Inherited whole-app guards (re-recorded at this BASE — the versions committed
on `main` were campaign-16 artifacts and 6 of 11 no longer matched):
`app-openapi-index`, `app-ddl`, `app-permissions`, `app-settings`,
`app-middleware-stack`, `app-migrations-index`, `app-route-perms`,
`fe-router`, `fe-i18n-parity`, `fe-money-pure`, `fe-camera-grid-layout`.

New for this campaign (all five verified deterministic across two runs):

| probe | what it pins |
|---|---|
| `heimdall-signing` | `sign()` against the byte-checkable worked example in `../heimdall/docs/API.md` (`sha256=a1bb7a33…`), the six-line canonical string, the present-but-empty sixth line, body-hash-as-bytes, and every credential shape `parse_credential` must reject |
| `payment-link-math` | 442 rows: `required_amount` (deposit rounding UP, full total plain-rounded), `outstanding_amount` (retainer netting), `wanted_link` (all 25 reasons a link is or is not owed × 3 percentages), `expires_in_days` clamping, the whole `needs_action` §5.4 matrix (13 rows × 5 wanted variants), `_in_backoff` |
| `heimdall-wire` | the exact bytes of all five calls (method, URL, signing headers, Content-Type, Idempotency-Key, body) and the exception each of 35 upstream answers maps to, including transport failures and the configuration gate |
| `payment-link-api` | the HTTP surface: every branch of `POST /heimdall/test`, the SSRF guard's 422s, `POST /aito/{id}/payment-link/refresh` (mint, no-op, upstream 500/unreachable/429, 404s, the 10-then-429 Retry budget), and the `payment_link` block on the board and trash payloads |
| `payment-link-reconcile` | the reconciler as a state machine: 33 scenarios over a stateful fake POS — first mint, steady state, reservation completion, amount/expiry/reference drift, deposit and retainer amounts, a poll finding `paid` (event + Books push + notification), dead links, a 404 replaced or cancelled, the six cancel reasons, backoff and `force`, the 429 stand-down, `changes_only`, `only_project_id`, the 40-poll budget |

## Notes for every worker and verifier run

- `.coverage` is TRACKED in this repo (a leak from campaign 1) and every
  coverage run modifies it. Never `git add` it; leave it dirty.
- `npm run build` writes into `static/`, which is tracked. At BASE the
  rebuild is byte-identical, so the tree stays clean — but never `git add -A`.
- `coverage-c17-backend.json`, `PLAN.md`, `TRIAGE.md`, `VERDICTS.log`,
  `BASELINE.md` and `findings-audit-*.json` are loop state: never committed.
- The authoritative Heimdall API contract is READABLE at
  `/Users/paultheis/Documents/Code/heimdall/docs/API.md` (a sibling repo,
  outside WORKDIR — READ ONLY, never edit anything there).
- macOS has no `timeout(1)`. Long commands run under `caffeinate -i` so a
  sleeping Mac does not kill them.

## Security tooling available

```
semgrep    1.172.0        (on PATH)
gitleaks   8.30.1         (on PATH)
bandit     1.9.4          (./venv/bin/python3 -m bandit)
pip-audit  2.10.1         (on PATH)
npm audit  npm 11.9.0
trivy      NOT INSTALLED  (the repo's own test_security.sh treats it as --full-only)
```

Nothing needed installing, so the setup commit contains no dependency or
config change — only probes, goldens, SURFACE.md and the two campaign
scripts.

## LESSON FROM ITERATION 1 — put this in EVERY worker brief from now on

Iteration 1 took THREE verification cycles for three tasks. Both FAILs were the
same shape, and neither was found by any worker's own gates:

  * FAIL 1: T-010 changed what `link_view` returns. The worker checked the two
    consumers it knew about (`PaymentLinkRow.tsx`, `aito_tracking.py`) and was
    right about both — but a THIRD consumer existed,
    `frontend/src/utils/aitoFollowups.ts`'s `linkExpiring` rule, whose only
    exclusion of the old `null` was the nullness itself.
  * FAIL 2: the fix for FAIL 1 was NARROWER than BASE for a neighbouring shape
    (a row WITH a heimdall_id but a null url), which was reachable at BASE.

So: WHENEVER a task changes what a shared value contains, what a function
RETURNS, or the shape of an API payload, the worker must GREP FOR EVERY
CONSUMER of that value across `backend/` and `frontend/src/` and state in its
report what each one does with it. Enumerating from memory or from the task's
evidence is not enough — the verifier does this grep independently and will
FAIL the iteration on a consumer the worker missed. And when restoring BASE
behavior for one shape, check the NEIGHBOURING shapes too: a guard that is
correct for the new case can be wrong for an old one.

Second lesson, mechanical: `frontend/tsconfig.app.json` excludes
`src/__tests__`, so adding a required field to a shared TS interface produces
NO compiler error in test fixtures. Sweep them by grep; the build cannot see
them. (Iteration 1: 27 files matched, 3 fixtures needed the field, including
one in `AitoCardView.test.tsx` that nobody predicted.)

## Round-2 auditor briefing notes (leads found mid-iteration, NOT yet filed)

The orchestrator must never file a survey finding itself (a hand-added task
carries no fingerprint, so the next round files the auditor's own version as a
duplicate). These are leads to BRIEF the round-2 panel with, so they file them
properly. Delete an entry once its round-2 finding exists.

1. **A truthy non-object `link` raises a bare `AttributeError` out of
   `_to_view`** (`backend/app/services/heimdall.py`, ~line 120). `link =
   data.get("link") or {}` then `link.get("url")`, so `{"link": "str"}` gives
   `AttributeError: 'str' object has no attribute 'get'`. The guard below is
   `except (KeyError, TypeError, ValueError)` — AttributeError is NOT in it, so
   this is NOT converted to `HeimdallUpstreamError`. It therefore matches none
   of `reconcile_project`'s handlers either (`HeimdallRateLimited` /
   `HeimdallNotFound` / `(HeimdallUpstreamError, SQLAlchemyError)`) nor
   `_run_pass`'s `except SQLAlchemyError`, so one malformed upstream payload
   aborts the ENTIRE pass with nothing recorded on any row — the same silent
   class as T-006 (HeimdallNotConfigured). PINNED as current behavior in
   `snapshots/heimdall-wire.golden`, case `200-link-not-an-object` ->
   `AttributeError`. Found by the T-004 worker, 2026-09-16; distinct from
   T-023, which is only about the missing/wrong-typed id/status/amount TEST
   gap. Route to audit-robustness (and audit-security for the pass-abort
   consequence).

2. **`_cancel_reason`'s token vocabulary has no translations.** T-009 added
   `"repriced"` / `"renumbered"` reasons on the reservation path; the timeline
   renders these tokens raw, exactly as `nothing_to_pay` already does. Not a
   regression — pre-existing for the whole vocabulary — but the set grew.
   Route to audit-cleanliness (i18n completeness).

3. **The reconcile probe never covered a stale reservation against a DEAD
   quote**, which is why T-009's fix moved no golden. `PROBES.json` is frozen
   mid-campaign so this was not added; if a campaign re-baseline ever happens,
   add that scenario to `tools/probe_payment_link_reconcile.py`. Not an
   auditor lead — a note for the next campaign's setup.

## T-026 (known-broken test) — diagnosed 2026-09-16, brief the worker with this

`test_delete_folder_removes_managed_files_from_disk` is NOT broken production
code. It is an INVOCATION-DEPENDENT test:

```python
# Precondition: the bug can only be reproduced if CWD != base_dir.
assert os.getcwd() != str(app_settings.base_dir), (
    "test relies on CWD differing from base_dir to catch relative-path bugs")
```

Its docstring says base_dir "is NOT the same as the process CWD the test suite
runs from (backend/)" — so it was written assuming pytest is invoked from
`backend/`. But `base_dir = _data_dir`, which with DATA_DIR unset is the REPO
ROOT, and this project's documented workflow runs every suite FROM the repo
root (CLAUDE.md, and `./test_backend.sh` itself). So cwd == base_dir, the
precondition fails, and the test cannot run — in this worktree AND in the main
checkout, under the project's own documented command. It is a real
pre-existing failure, not a worktree artifact.

The production fix it guards (#T-142, resolving a base_dir-relative
file_path to absolute before unlinking) is already IN the code — this test
just can no longer reach it.

So the fix is in the TEST, and it must preserve the test's intent rather than
deleting the precondition: make the divergence the test needs instead of
hoping the invocation provides it — e.g. monkeypatch `settings.base_dir` to a
`tmp_path` (so base_dir is genuinely elsewhere than cwd, and the created files
land in a temp dir instead of polluting the repo's own `archive/`), or chdir
for the duration. Deleting the assert would leave a test that silently proves
nothing whenever cwd happens to equal base_dir, which is the default.

Out of the campaign's payment-link SCOPE, but in scope per SETUP step 7.

## EXIT NOTE — the static/ bundle must be rebuilt before merge

This repo TRACKS the built frontend bundle in `static/` (main's tip commit is
literally `build: rebuild the static bundle ...`). This campaign changes
frontend source — `frontend/src/api/client.ts`, `utils/aitoFollowups.ts`,
`components/aito/history/eventKinds.ts` and all 14 i18n locales so far — so
the committed bundle is now STALE relative to source.

The campaign deliberately does NOT rebuild it: `npm run build` rewrites ~67
hashed asset files, which would swamp every `git diff BASE..HEAD` the blind
verifier reads and make a behavioral regression impossible to spot. Workers
are told never to `git add static/`, and the verifier is told its own build
dirtying `static/` is expected and not a finding.

So AFTER merging this branch, run `cd frontend && npm run build` and commit
`static/` as its own `build:` commit, matching the repo's existing practice.
Until that happens the served UI will not show this campaign's frontend
changes (the new `payment_link.updated` timeline label, the reservation row in
the panel, the `minted`-aware follow-ups rule).

Note for whoever rebuilds: `git add -f static/` may be needed, and a stale
`static/` is why `git status` shows deletions after a build — the hashed
filenames change. Restore with `git checkout -- static/ && git clean -fd static/`.
