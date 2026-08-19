# Refactor Loop — Final Report

**Campaign:** aito-2026-08-18 · **Scope:** Aito page (frontend + backend)
**Ended:** early, at the user's request after iteration 1 verified PASS — not converged, not capped.

## Counters
- Iterations run: 1 of 8 · Survey rounds: 1 of 3 · Dry rounds: 0
- Commits on branch: 2 (`chore(refactor-loop): setup`, `refactor(loop-1): ...`) + this report
- Tags: `refactor-base` (BASE), `loop-1`
- UPSTREAM: c501ae8663d03517c4bd519317fef55b8b38269b

## Verdicts
- Iteration 1: **FAIL**, then **PASS** after remediation. Both recorded in VERDICTS.log.
- The FAIL was substantive, not procedural: the blind verifier caught that T-003 was an observable
  behavior change the auditor had mis-classified as `behavior_change: false`, so it had reached a
  worker without passing the approval gate. The user then approved it explicitly and it was recorded
  in BASELINE-CHANGELOG.md. The verifier also caught that T-001's new 403 shadowed a pre-existing 422;
  that was narrowed to exactly the approved change and pinned with a test.

## User-approved behavior changes (3, all in BASELINE-CHANGELOG.md, dated 2026-08-18)
- **T-003** — `run_sync_once` reloads the project before `_apply_rules` after a terminal rollback.
  Before: `MissingGreenlet` swallowed, terminal state discarded, no broadcast, project pending forever
  and retried every tick (spending Zoho Books calls each time). After: error state and recomputed
  board_column persist, the card shows the sync error, `aito_changed` broadcast fires.
- **T-001** — `add_task` now returns 403 when a `*_done` step flag is set by a caller lacking
  `aito:update`. Structurally unreachable unless `quote_status == "accepted"`; 422 preserved for the
  non-accepted case. Closes a gap where an `aito:create`-only principal could stamp ticked, priced
  steps onto an accepted project and have the sync worker push them to the live Zoho estimate.
- **T-006** — presence `viewers` map is cleared and subscribers notified when the socket drops, so
  cards and the panel banner stop showing operators whose connections are already gone.

## Round 1 survey — findings by auditor
| auditor | filed | DONE | OPEN | WONTFIX | triaged |
|---|---|---|---|---|---|
| audit-security   | 1 | 1 | 0 | 0 | 1 |
| audit-robustness | 4 | 2 | 1 | 1 | 1 |
| audit-cleanliness| 0 | 0 | 0 | 0 | 8 |
| audit-tests      | 1 | 1 | 0 | 0 | 9 |

25 findings total: 6 filed to PLAN.md, **19 diverted to TRIAGE.md** by the TRIAGE=P2,P3 policy.
TRIAGE.md holds every one with full evidence, for review or `plan.py promote <id> --iteration N`.

audit-security's negative results are worth recording: semgrep 0, bandit 0, gitleaks 0 in scope. It
confirmed DOMPurify + `sandbox=""` + CSP on the quote preview, `rel="noopener noreferrer"` on all
external links, server-side re-derivation of the email recipient allowlist, Zoho path-segment
escaping, and that the sync handler deliberately stores exception CLASS NAMES to keep PII out of
`quote_sync_error`.

## The setup finding (T-016) — retired pre-BASE
audit-tests found the campaign's own coverage measurement was wrong: coverage.py had no
`concurrency` setting, and SQLAlchemy's async ORM routes every sync DBAPI call through
`greenlet_spawn`/`await_only`, so fully-tested async route bodies read as unexecuted.
Independently reproduced before acting. Effect: `routes/aito.py` 61.77% -> 97.13%; scoped backend
statements 88.81% -> 98.09%; branches 76.41% -> 95.07%; 11437 passing either way.
Fixed in `pyproject.toml [tool.coverage.run]` and folded into BASE (setup commit amended), because a
ratchet anchored at a fabricated 88.81% would have let a worker delete ~9 points of real backend
coverage and still pass the gate.

## Gates at exit
- Coverage backend: 98.09% -> **98.10%** statements, 95.07% -> **95.09%** branches
- Coverage frontend: 96.25% -> **96.25%** statements, 92.66% -> **92.68%** branches
- Golden probes: **12/12 matching** · SURFACE.md: **unchanged**
- Tests: backend 11437 -> **11443 passed** (1 pre-existing env skip); frontend 4667 -> **4670**
- Known-broken tests: **0 before, 0 after**
- Test integrity: zero deleted test lines across the whole campaign (+8 tests net)
- Frozen machinery (tools/, PROBES.json, snapshots/): zero diff since BASE

## Golden-probe re-baseline at setup
4 of the 12 probes (aito-openapi, aito-pydantic-schemas, aito-route-perms, aito-event-depths) were
recorded at campaign 2's HEAD (2026-08-11) and had drifted. Verified structurally as PURELY ADDITIVE
and entirely attributable to the task-reorder feature shipped 2026-08-18 (+1 endpoint, +1 model,
+1 AITO_UPDATE route, +`task.reordered`): zero endpoints, models, or event kinds removed or altered.
Re-recorded as a sanctioned campaign re-baseline.

## Frontend flake protocol (established at setup, used twice)
The frontend suite has cold-cache load-flakes OUTSIDE the Aito scope: at BASE, run 1 showed 15
failures across PrintModal / CalculatorPage / ModelViewerModal / StatsPageUserFilter1894; runs 2 and
3 showed zero; those files pass 137/137 in isolation. `known_broken` is therefore empty, with the
rule that no frontend failure counts until it reproduces with that file re-run alone on an idle
machine. Both a worker and the verifier hit these flakes and correctly cleared them. The verifier
also discovered that running an isolation check CONCURRENTLY with the backend `-n 30` suite itself
produces false failures — worth remembering.

## Left for humans
- **OPEN — T-007** (P3, user-approved, never worked): `list_events` accepts a timezone-aware
  `before_at` whose offset SQLite's bind processor silently drops, so a third-party caller paging
  with an offset gets a cursor hours off. Approved fix: normalize to naive UTC (NOT a 422).
- **WONTFIX-AUTO — T-005** (P2, user-declined): `list_projects` / `list_trash` return the entire
  never-pruned done archive with no limit, refetched on mount, every `aito_changed` broadcast, window
  focus, and every 10s while a quote is pending. Declined as a feature change needing frontend work.
  This is a real scaling issue and deserves its own design conversation.
- **19 triaged findings** in TRIAGE.md — notably 8 cleanliness (a duplicated `_fold` helper that has
  already drifted NFKD vs NFD between aito_shipping and aito_quote_import; duplicated combobox
  keyboard nav; 4 unused exports) and 9 test-quality gaps (invoice.pdf error branches untested,
  quote.pdf 404 branch untested, `ZohoNotFound` branch of a docstring-declared "load-bearing"
  isinstance order untested, Zoho-comment timestamp fallbacks untested, `ServiceBadges` with no test
  reference anywhere in the suite).

## Preserved artifacts
PLAN.md, TRIAGE.md, BASELINE.md, VERDICTS.log and all four raw `findings-audit-*.json` were copied to
`/Users/paultheis/Documents/Code/bambuddy-refactor-archive-2026-08-18/` before the worktree was
removed. They are NOT in git.
