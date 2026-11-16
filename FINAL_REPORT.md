# Refactor-loop campaign F2 — the filament profile page — final report

Date: 2026-11-15. Branch `auto-refactor-loop` in `../bambuddy-refactor`, based on local main `5de604eed`
(BASE = tag `refactor-base`, setup commit `431ba6ef5`). Follow-on to campaign F1 (same feature, landed the same day).

## Summary

| | |
|---|---|
| Iterations run | 7 of 8 (all 7 passed blind verification on the first attempt) |
| Survey rounds | 3 of 3 |
| Commits | 1 setup + 7 iteration commits (grouped) + this report |
| Tags | `refactor-base`, `loop-1` … `loop-7` |
| Tasks | 18 filed, 18 DONE, 0 open / blocked / declined |
| Why it ended | MAX_ROUNDS (3). Round 3 was dry: all four auditors filed nothing |

Scope: `backend/app/api/routes/filament_trees.py`, `models|schemas/filament_tree.py`, `services/filament_tree*.py`
(incl. the new `filament_tree_push.py`); `frontend/src/pages/FilamentProfilesPage.tsx`, `components/filament-trees/*`,
`components/filament-profiles/*`, the FilamentTree slice of `api/client.ts`; and their tests.

## Gates

| Gate | Baseline | Final |
|---|---|---|
| Backend scoped statement coverage | 97.91% (1403/1433) | 98.09% (1436/1464) |
| Frontend scoped statement coverage | 85.64% (841/982) | 88.20% (875/992) |
| Known-broken tests | 1 | 1 (unchanged: `test_printer_hours_migrations.py::test_migration_backfills_calibrated_at_from_offset`, out of scope, time-of-day dependent) |
| Golden snapshot probes | 7/7 | 7/7 (re-recorded only for approved changes) |
| SURFACE.md | — | changed only by approved changes (see below) |
| Diff vs BASE | — | 41 files, +880 / −123 (production code: 10 files, +167 / −67; the rest is tests, 16 locale files, goldens) |

Load flakes seen during verification, all in files the campaign never touched and all passing when rerun alone:
`PrintModal.test.tsx`, `ArchivesPage.test.tsx`, `StreamOverlayPage.test.tsx`, `FileManagerPage.test.tsx`;
backend `test_mfa_api.py::TestOIDCAutoCreateUsername`, `test_timelapse_clock_match.py` (baseline run only).

## User-approved behavior changes (all in BASELINE-CHANGELOG.md, dated 2026-11-15)

- **T-084** SYNC no longer pushes a leaf whose Orca edit the pull refused (the OrcaSlicer edit is no longer overwritten).
- **T-081 / T-087** `POST /filament-trees/orca-cleanup` takes the previewed `names` instead of a count; 400 "Orca Cloud changed" when the stray set differs.
- **T-082** Pre-cleanup snapshots are `cleanup-<ts>.json` and are never pruned by the push-snapshot rotation.
- **T-088** A failed delete batch during cleanup returns 200 with `failed > 0` and the snapshot name instead of a 502.
- **T-089** SYNC has a 10-minute deadline; a lost response shows "outcome unknown"; the button re-enables.
- **T-090** `GET /sync` returns a `fingerprint`; `POST /sync?fingerprint=` answers 409 when the plan changed since the preview and the page shows a fresh preview. Omitting the parameter keeps the old behavior.
- **T-091** Sync base on a server without a Bambu Studio bundle offers a "Choose files" button instead of opening the picker by itself.
- **T-083** The Clean Orca Cloud confirmation lists the preset names it will delete.
- **T-092** Filament-tree dialogs ignore clicks and keys during their close animation.
- **T-118** The SYNC response gains `push.held` (leaves held back by a refused Orca edit) and the result modal lists them (new key `filamentTrees.pushHeld`, 16 locales). The preview still lists those keys as pulled: a refusal is only known by attempting the write.
- **T-119** A cleanup whose final check fails after deleting returns 200 with the snapshot name and unknown counts (new key `filamentTrees.cleanOrcaUnknown`, 16 locales). An auth error at that point is still a 401 without the snapshot name.
- **T-121** An upload that finds no presets shows the normal 0-result stats; Choose files is disabled while an upload runs.
- **T-120** (golden re-record only, no observable change) the SYNC fingerprint no longer depends on the order Orca lists profiles.

Not behavior changes: **T-085** POST /sync and POST /orca-cleanup run one at a time (per process) so concurrent runs cannot
create duplicate Orca profiles; **T-105, T-112, T-116** tests only.

## What each survey round found

| Round | security | robustness | cleanliness | tests | Outcome |
|---|---|---|---|---|---|
| 1 | 3 filed | 8 filed, 3 triaged | 10 triaged | 3 filed, 10 triaged | 14 tasks → iterations 1–5 |
| 2 | clean | 3 filed, 1 triaged (T-120, later promoted by the user) | 1 triaged | 3 triaged | 4 tasks → iterations 6–7 |
| 3 | clean | clean | clean | clean | dry |

Scanners (bandit, gitleaks, semgrep rule packs, pip-audit, npm audit): nothing in scope in any round.

## Findings by auditor (filed into the plan)

| Auditor | Filed | DONE | BLOCKED | WONTFIX-AUTO |
|---|---|---|---|---|
| audit-security | 3 | 3 | 0 | 0 |
| audit-robustness | 12 (incl. promoted T-120) | 12 | 0 | 0 |
| audit-cleanliness | 0 | 0 | 0 | 0 |
| audit-tests | 3 | 3 | 0 | 0 |

## Triaged this campaign (recorded, not worked)

28 findings were diverted to TRIAGE.md (P2/P3, no behavior change): robustness 4, cleanliness 11, tests 13. One (T-120) was
promoted and done, so 27 remain from this campaign. TRIAGE.md also still carries campaign F1's 50 entries, 77 in total
(robustness 9, cleanliness 40, tests 28), each with full evidence. Promote one with
`python3 tools/plan.py promote <id> --iteration N` (the flag is required).

Worth a look first:
- T-086 `push_leaves` writes leaf rows it read before the network calls, without the tree lock (a save during a push can lose its export-pending flag; a leaf deleted during a push gives a 500).
- T-093 `push_leaves` crashes on an Orca filament entry without an id.
- T-094 `_snapshot` writes non-atomically and blocks the event loop.
- T-122 POST /sync with a fingerprint plans the pull twice (cost only).
- ~160 unreferenced `filamentProfiles` i18n keys from the removed preset grid (cleanliness, round 1).
- Remaining test gaps: push failure-streak reset, snapshot batch sizes, `pickedFiles` zip branch, `usePresetSyncs` failure paths, `ZohoSyncResult` branches.

## Left for humans

- No task is OPEN, BLOCKED or WONTFIX-AUTO.
- Known limits of what shipped: the run lock (T-085) is per process; `inert` keyboard blocking (T-092) is asserted by attribute only, not checked in a real browser; nothing was run against live Orca Cloud (all Orca calls are stubbed in tests and probes).
- After merging: rebuild `static/` (frontend changed), restart the :8000 dev server.

Detailed state (PLAN.md, TRIAGE.md, BASELINE.md, VERDICTS.log, auditor findings JSON, briefs) is copied to
`plans/refactor-campaign-ftree-f2/` in the main checkout.
