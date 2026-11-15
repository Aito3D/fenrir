# Refactor loop — campaign F1: the filament profile tree — final report

2026-11-14 / 2026-11-15. Branch `auto-refactor-loop` in `/Users/paultheis/Documents/Code/bambuddy-refactor`,
cut from `main` at `d037b490e` (UPSTREAM). BASE is the tag `refactor-base` (`5dce0d855`, the setup commit).

## Outcome

- **Why it ended:** MAX_ROUNDS (3 survey rounds done). The iteration budget (raised from 8 to 10 by the user at the round-3
  sweep) is also spent. Not converged: round 3 still filed findings.
- **Iterations:** 10, every one PASSED its blind verification on the first attempt. Tags `loop-1` … `loop-10`.
- **Commits:** 10 squashed iteration commits on top of the setup commit, plus this report.
- **Tasks:** 30 filed into the plan, 29 DONE, 1 declined by the user (T-071). 0 OPEN, 0 BLOCKED.
- **Triage list:** 57 findings were triaged over the campaign (P2/P3), 7 were promoted and worked, 50 remain in `TRIAGE.md`.

## Coverage, tests, goldens

| | Baseline (BASE) | Final (loop-10) |
|---|---|---|
| Backend scoped statements | 96.86% (1140/1177) | 98.14% (1267/1291) |
| Frontend scoped statements | 88.94% (716/805) | 89.48% (732/818) |
| Backend suite | 27508 passed, 1 failed (known_broken) | 27560 passed, 0 failed |
| Frontend suite | 11269 passed | 11284 passed (1 load flake, passes alone) |

- Golden probes: 7/7 matching at every iteration. Goldens moved only for user-approved changes.
- `SURFACE.md`: changed only for user-approved changes (listed below); regenerated output is identical to the committed file.
- known_broken: `test_printer_hours_migrations.py::test_migration_backfills_calibrated_at_from_offset` (out of scope) —
  unchanged; it fails only while the local day (UTC-10) differs from the UTC day, and passed in the late-night runs.
- CI gates checked on the final tree: ruff, `tsc -b`, eslint (0 errors), i18n parity, knip (exit 0), basedpyright lock mode
  (no line mentions `filament_tree`). Not run: `npm run build`, Docker suite, security suite as a whole.
- Size: production code 10 files, +367 / −166; tests 11 files, +955 / −14.

## User-approved behavior changes (all in BASELINE-CHANGELOG.md)

Round 1 (approved 2026-11-14):
- T-001 Export for Orca requires `filaments:update`; export buttons hidden without it.
- T-002 / T-010 unknown leaf / missing preset: 404 with a domain message instead of SQLAlchemy's text.
- T-006 a malformed Orca Cloud entry is counted as ignored instead of failing the sync with a 500.
- T-007 export no longer marks leaves exported; it returns `X-Export-Token`, and `POST /filament-trees/export/confirm`
  clears only the leaves whose content is unchanged. Tokens live in memory (newest 32): a restart between export and
  confirm leaves the leaves pending.
- T-008 duplicate machines/nozzles in the targets → 400. T-009 duplicate colour names (case-insensitive) → 400.
- T-011 targets are validated and stripped before the calibration-source check. T-012 explicit null source on PATCH → 400.
- T-014 the sync `missing` list is sorted. T-026 migration skips the 11 Orca metadata keys of `SKIP_KEYS`.
- T-036 five unused `filamentTrees` translation keys removed from all 16 locales.

Round 2 (approved 2026-11-15):
- T-054 changing targets or skip-0.2 needs `filaments:delete` when it would remove an existing leaf preset.
- T-059 the per-tree Export button refreshes the tree list. T-063 label and export requests raise `ApiError`.
- T-060 (SURFACE regeneration only) `store.tree_write_lock` / `store.validate_targets` are public.

Round 3 (approved 2026-11-15):
- T-067 a brand/material rename runs the leaf-removal (403 without `filaments:delete`) and source-stays-a-target (400)
  checks; a skip-0.2-only PATCH now gets that 400 too.
- T-070 two concurrent migrations of one group: the loser gets 400 "group already migrated".
- T-075 one missing-preset message (`store.get_leaf_preset`). T-076 no export token → the page skips the confirm call.

Declined: T-071 (keep leaves pending until the user confirms the file was saved).

## Changes without a changelog entry (judged non-observable by the verifier)

- T-003 / T-053 / T-055: every tree write route serialises on a per-tree lock (`store.tree_write_lock`, refcounted, released
  when idle). Overlapping saves no longer lose an edit or fail with a 500. A sync holds every tree's lock while it applies.
- T-056: a delayed colour save sends the colour's current name (a rename right after a recolour is no longer undone).
- T-058: the export blob URL is revoked 60 s after the click instead of immediately.
- T-040, T-041, T-065: tests only.

## Survey rounds

| Round | security | robustness | cleanliness | tests | Filed | Triaged |
|---|---|---|---|---|---|---|
| 1 | 2 | 12 | 25 | 13 | 15 | 37 |
| 2 | 2 | 5 | 5 | 2 | 3 | 11 |
| 3 | 1 | 5 | 5 | 3 | 5 | 9 |

Findings by auditor (plan tasks): audit-security 5 filed / 5 DONE; audit-robustness 16 filed / 15 DONE, 1 declined;
audit-cleanliness 6 filed / 6 DONE; audit-tests 3 filed / 3 DONE.
Triaged by auditor over the campaign: security 1, robustness 10, cleanliness 30, tests 16 (57; 7 promoted: T-053, T-055,
T-056, T-057, T-058, T-060, T-065).

## Left for humans

`TRIAGE.md` holds 50 findings with full evidence (`python tools/plan.py --file TRIAGE.md render --iteration 10`;
promote one with `python tools/plan.py promote <id> --iteration N`). The ones most worth a look:

- T-068 `put_targets` and `sync` read the list of tree ids before taking the lock: a tree created in that gap is not
  regenerated under the new targets; a tree deleted while `put_targets` waits makes the whole PUT fail with a 404.
- T-069 `MaterialCards`: each brand row runs its own node query, so one edit triggers one `GET /node` per tree, each reading
  the Bambu base presets from disk on the event loop.
- T-072 the delayed colour save sends the name of a rename still in flight; if the server refuses the rename, the recolour
  is refused too and the picker shows an unsaved colour.
- T-078 `TreeSettingsPanel` permission gating has no test (the test grants every permission).
- T-004 / T-005 / T-013 (round 1 robustness): `apply_pull` savepoints commit on release under SQLite, so a sync is not one
  transaction; refusals in `apply_pull` / `_write_node` are swallowed without a log line; tree-name uniqueness is
  check-then-insert with no unique constraint.
- Round-1 cleanliness: the tree + colour insert sequence exists three times; `NodePanel` is one ~460-line component; the
  mutate / invalidate / toast wrapper is hand-written in nine call sites.

Noted by auditors or workers but out of scope or not filed:
- `price_import` in `routes/filament_profiles.py` calls `set_node_values` without the tree lock.
- A read-only user without Zoho permission sees an empty "Sync & export" menu.
- `X-Export-Token` would need CORS `expose_headers` if the frontend were ever served from another origin.

## Landing notes

- `main` moved on only if the user committed there meanwhile; the campaign touched files the user is actively developing
  (`filament_trees.py`, `filament_tree_store.py`, `TreeSettingsPanel.tsx`, `FilamentProfilesPage.tsx`, `client.ts`, all 16
  locale files) — expect conflicts if `main` has uncommitted or newer work there.
- `static/` was not rebuilt on this branch (`npm run build` is forbidden in the loop): rebuild and commit it after merging.
- The dev backend on :8000 needs a restart after landing (new confirm route, lock, permission checks).
- Loop state (PLAN.md, TRIAGE.md, BASELINE.md, VERDICTS.log, findings JSON, briefs) is untracked in the worktree and was
  copied to `plans/refactor-campaign-ftree-f1/` in the main checkout.
