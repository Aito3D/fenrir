# Refactor Loop — Final Report (filament-profiles Zoho price sync campaign)

**Exit reason: MAX_ROUNDS** (3 survey rounds completed). This report supersedes the interim report committed at the first exit — the campaign was then continued at the user's request to work the entire triaged backlog, and now ends with **nothing left: 48/48 tasks DONE, TRIAGE.md empty, zero OPEN/BLOCKED/WONTFIX.**

## Campaign shape
- Scope: the filament-profiles Zoho PRICE SYNC, frontend and backend (canonical list in `tools/coverage_fp.sh`), plus one user-approved single-file scope extension (T-021 → `backend/app/api/routes/calculator.py`).
- Base: tag `refactor-base` = `1fc2889` (cut from UPSTREAM `e8e94d55f` on main; **main has moved since** — merge accordingly).
- **17 iterations** (tags `loop-1`…`loop-17`), 3 audit rounds, then a user-directed continuation that promoted and completed all 7 triaged findings. Parameters: TRIAGE P3, BATCH 3, MODE auto, COMMIT_STYLE grouped; MAX_ITER raised by the user 8→12→15→18 as approved work accumulated.
- One iteration (11) initially FAILED verification — the export-dedup exceeded its approval — and was corrected, separately approved, and re-verified before tagging.

## Results
- Tasks: **48 filed, 48 DONE** (security 15 · robustness 17 · cleanliness 8 · tests 8 — includes the 7 promoted from triage; nothing triaged remains).
- Coverage (scoped statements): backend **99.77% → 99.82%** (443/444 → 563/564; branches 99.23%) · frontend **60.83% → 77.10%** (146/240 → 229/297). No exclusion added, no glob narrowed; `tools/` and `PROBES.json` byte-identical to BASE all campaign.
- Golden snapshots: **11/11 matching** at exit; every re-record maps to a dated BASELINE-CHANGELOG.md entry, verified against code by the blind verifier. The behavior-critical goldens (match decisions, sync endpoint) survived the O(n·m)→O(n+m) match-index refactor **without** re-recording.
- SURFACE.md: regenerates byte-identical; all movement since BASE is changelog-sanctioned.
- Known-broken tests: 0 → 0.

## What the rounds and continuation delivered
- **Round 1** (17 tasks): sync honesty (unwritable/blanket-502/success-toast lies), price safety (non-finite costs, deep-nesting aborts), filename validation, permission gates, editor staleness.
- **Round 2** (15 tasks, 13 user-approved): colour-aware matching, the empty-list bambu-sync wipe guard, catalogue permission alignment, content caps, the loop's own save-close regression fixed, stale-catalogue disclosure, outage cooldown, export-ZIP sanitizer, duplicate-path validation, attention cap.
- **Round 3** (9 tasks, 5 user-approved): failure-path cache refetch (silent revert of committed syncs), empty-catalogue refusal, output-side size re-check, PATCH optimistic locking (`expected_updated_at` → 409), `.json`-suffix rule, validator dedup, three test gaps in the campaign's own machinery.
- **Continuation** (7 promoted P3s, all behavior-preserving): exhaustive reason→i18n Record, `useToastOnce`, O(catalogue+profiles) match index, money-ceiling equality test, `ZohoFilamentRefreshBusyError` replacing string classification, per-raise exception cloning (`_clone_exc`), and the generation guard on the failure memo.

## User-approved behavior changes
24 approved changes across rounds 1–3, each with a BASELINE-CHANGELOG.md entry and a marked commit: T-005…T-016 era (honest reporting, validation, gates), T-021, T-025–T-035, T-038, T-044–T-048. The continuation added none — its three changelog entries (T-003, T-011, T-036, T-043) are explicitly "mechanical / not a behavior change" disclosures. Note: BASELINE-CHANGELOG.md is cumulative across campaigns; unfamiliar ids/dates belong to earlier calculator campaigns.

## Leftovers & notes for humans
- Deliberately declined as out of scope (both recorded): a one-time `run_migrations()` normalisation of legacy path-shaped/non-`.json` stored filenames (input boundaries are closed; legacy rows normalise on next save/duplicate), and a route-level `PermissionRoute` for `filament-profiles` in App.tsx (page-level gates exist).
- Disclosed edge notes from verification, none actionable in scope: `.JSON` accepted case-insensitively while `read_disk_state` globs lowercase; `filamentProfiles.syncZohoFailed` now unreferenced but still defined in 13 locales; `_clone_exc` would TypeError on strict-`__new__` exception classes (none producible in the walk) and drops a `UnicodeDecodeError`'s message (log-only); the SURFACE generator's permission grep cannot express two-permission gates (the `fp-route-perms` golden carries the real state); T-032's page test has a thin 5s waiter under heavy parallel load.
- The pre-existing "Berlin-midnight" time-of-day failure in `test_plug_energy_history` (untouched since before BASE) remains in the codebase.
