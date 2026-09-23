# FINAL_REPORT.md — refactor-loop campaign 19 (the client tracking page)

Campaign 19 · worktree `../bambuddy-refactor` · branch `auto-refactor-loop` · BASE `refactor-base` (c72a6b4c6, cut from main e1628a72a on 2026-09-22)
Scope: the client tracking page, front and back end — pages/AitoTrackPage + AitoTrackEntryPage, the 11 Track* components and trackingShell, the two tracking hooks and three utils, the tracking routes in App.tsx and client.ts, services/aito_tracking.py, models/aito_tracking_view.py, the /track route + rate limiter + tracking-link/token routes in routes/aito.py, notes_with_tracking in aito_quote_sync.py, the AitoTracking* schemas, main.py's tracking serve path, the aito.track.* keys. The login page was NOT in scope this time (see BASELINE.md for the exact boundary).
Parameters: TRIAGE P3 · MAX_ITER 8 → 12 (raised by the user at the round-2 sweep) · MAX_ROUNDS 3 · BATCH 3 · MODE auto · COMMIT_STYLE grouped · MERGE_CADENCE at-exit.

## Run summary

- Iterations run: 10 (every one verified PASS by the blind verifier at first pass; no reverts)
- Survey rounds completed: 2 of 3 — the user asked to finish after iteration 10, so round 3 was not run
- Commits on the branch: 10 squashed iteration commits + the setup commit (+ this report); tags loop-1 … loop-10
- Why the loop ended: **user request** ("finish the refactor" after loop-10) with the plan exhausted — 29 of 30 tasks DONE, 1 declined, 0 OPEN. Neither MAX_ITER (12) nor MAX_ROUNDS (3) was reached, and the campaign did not formally converge (no dry round was surveyed).

## User-approved behavior changes this campaign (BASELINE-CHANGELOG.md, all dated 2026-09-22)

Security / rate limiter (routes/aito.py):
- T-011 IPv6 sources keyed per /48 instead of /64 (golden `tracking-backend` re-recorded, two net_key rows)
- T-012 no-peer / unparseable hosts collapse onto one shared `__no_ip__` bucket (fail closed)
- T-017 the per-IP CALLS cap is suspended on a collapsed bucket, like the miss cap
- T-028 new per-net calls ceiling `_TRACK_RATE_MAX_CALLS_PER_NET = 1200/min`, recorded for every admitted call
- T-030 the `__no_ip__` bucket counts as collapsed (bounded per net, not per IP)
- T-029 a collapsed bucket now requires the explicit opt-in `AITO_TRACK_COLLAPSED_PROXY=1` (or `TRUSTED_PROXY_IPS`); the spoofable `_peer_is_private` heuristic and its tests were removed. **Deployment note for the operator:** a containerised or proxied install should set `TRUSTED_PROXY_IPS`; no project doc mentions either variable today — worth adding to the deployment docs.
- T-010 the shop-panel map iframe sends `referrerPolicy="no-referrer"` (the tracking code no longer reaches google.com). **Please confirm in a real browser that the keyless embed still renders.**
- T-014 `payment_state` returns `url=None` once a link is paid (golden re-recorded for the two paid-link rows)

Robustness / UX:
- T-018 both tracking pages get a 10 s i18n settle deadline (`I18N_SETTLE_TIMEOUT_MS`) — a stalled locale chunk shows the page in the fallback language instead of an endless skeleton
- T-024 the quote sync commits a freshly minted tracking token BEFORE the Books call (both push paths) so SQLite's write lock is not held across the HTTP round trip. The verifier noted the boundary is slightly wider than the entry says: for a token-less legacy card restored from trash whose Books update then fails, the restore-branch writes of `_reconcile_status` now persist too.
- T-026 the payment rows show a translated "copy failed" hint (new key `aito.track.paymentMethods.copyFailed` in 14 locales; goldens `tracking-i18n` + `fe-i18n-parity` re-recorded)
- T-027 the four /t and /track routes are wrapped in `TrackingErrorBoundary`, which renders the tracking card's own error state with a retry instead of the app-wide "UI Crash" stack trace (golden `fe-router` re-recorded for the four element lines). Side effect: App.tsx now imports components/aito/trackingShell eagerly, moving that small module into the main chunk.

Sanctioned re-baselines (not behavior changes):
- T-002 `TrackingPaidRow`, T-019 `PAGE`, T-020 `I18N_SETTLE_TIMEOUT_MS`, T-021 `TERMS_BUTTON` — additive internal exports under the user's "additions only in Frontend exports" rule
- iteration 4: `tools/gen_surface_tracking.sh` no longer pins grep line numbers (T-012's insertion had shifted every later number with nothing named changed); SURFACE.md regenerated

Declined: T-015 (expiry clock for cards parked in production/finish columns) — the user chose to keep those links live indefinitely.

## What landed, by iteration (all verified behavior-neutral or user-approved)

- loop-1 70ffd7c82: T-001 PAGE constant per page · T-002 TrackingPaidRow extraction (byte-identical markup) · T-004 useSheetDrag characterisation (TrackingPanel.tsx 66.66% → 95.55% stmts)
- loop-2 c906bb245: T-005 entry-page stale-check guard + same-code onChange guard · T-006 payment-methods height tween driven with stubbed layout · T-007 clipboard-failure early return
- loop-3 4e3cc14fb: T-008 deposit vs full wording (branches 80% → 100%) · T-010 map Referer · T-011 IPv6 /48
- loop-4 5cda19ed2: T-012 `__no_ip__` bucket · T-016 run_sync_loop rolls back after a failed purge_tracking_views · T-017 collapsed calls cap · SURFACE generator re-baseline
- loop-5 14a8bc7b2: T-018 settle deadline · T-014 url=None on paid
- loop-6 643c2c5ca: T-024 token committed before Books · T-019/T-020 hoists
- loop-7 9125914b2: T-021 TERMS_BUTTON · T-022 `track_rate_clock` fixture + `_exhaust_ip_misses` helper (test_aito_tracking.py 1258 → 1221 lines, 54 tests unchanged) · T-025 the pay panel closes when a refetch removes it
- loop-8 c1b19e54d: T-026 copy-failed hint · T-027 tracking error boundary · T-028 per-net calls ceiling
- loop-9 313a3ee28: T-030 `__no_ip__` collapsed · T-029 explicit proxy opt-in · T-031 sheet-drag 6-sample window tests
- loop-10 d017d633c: T-032 mint_unique_token retry/give-up · T-034 `_release_miss` guards · T-033 entry-page settle deadline test

Net diff vs BASE: 41 files, +2082 / −360. Production code (backend/app + frontend/src minus tests): 26 files, +389 / −103. Tests: 8 files, +1507 / −155 (the deletions are the replaced limiter boilerplate, the removed `_peer_is_private` tests and re-pinned expectations, all sanctioned).

## What each survey round found

- Round 1 (setup, 2026-09-22): 17 findings — security 6, robustness 3, cleanliness 3, tests 6 → 15 filed (10 workable + 5 held for approval), 3 triaged. Approvals: 6 approved (T-010, T-011, T-012, T-014, T-017, T-018), 1 denied (T-015).
- Round 2 (after iteration 5): 16 findings — security 3, robustness 4, cleanliness 5, tests 4 → 15 filed (9 workable + 6 held), 1 triaged. All 6 held findings approved (T-024, T-026, T-027, T-028, T-029, T-030); MAX_ITER raised 8 → 12.
- Round 3: not run (user request).

## Findings by auditor (plan.py stats, campaign 19 only)

| auditor | filed | DONE | BLOCKED | WONTFIX-AUTO | OPEN |
|---|---|---|---|---|---|
| audit-security | 8 | 7 | 0 | 1 (T-015 declined) | 0 |
| audit-robustness | 7 | 7 | 0 | 0 | 0 |
| audit-cleanliness | 6 | 6 | 0 | 0 | 0 |
| audit-tests | 9 | 9 | 0 | 0 | 0 |

## Triaged

4 findings were diverted to TRIAGE.md this campaign (all P3): cleanliness 2 (T-003 panel-id literals not derived from TrackingPanelId; T-023 the readyOverride mock scaffold copied between the two page test files), tests 1 (T-009 the language pill's fallback for an unsupported current language is untested), security 1 (T-013 the limiter's bucket sweep only drops fully-aged keys and costs O(n) per request — partly superseded by T-028's ceiling). TRIAGE.md carries each with full evidence; it is archived in `refactor-campaign19-archive/TRIAGE.md`. To work one in a future campaign: `python tools/plan.py promote <id> --iteration N` (the flag is required).

## Quality gates

- Coverage (scope-only, statements): frontend 93.27% (527/565) → 98.35% (597/607); backend (aito_tracking.py + aito_tracking_view.py) 99.38% (160/161) → 99.38% (161/162). Coverage config and the scope include lists untouched since BASE.
- Tests: backend 15143 → 15149 passed (0 failed, 1 skipped); frontend 6891 → 6917 passed (0 failed). known-broken: 0 → 0. Per-verifier flakes fired only from the documented known_flaky list and passed alone.
- Golden probes: 15/15 matching at every verification (5 tracking probes added at setup: service-level compute_tracking over 15 seeded cards, wire contract, HTTP end-to-end, frontend pure logic, i18n structure; 10 app-wide guards inherited). Four sanctioned re-records: tracking-backend (T-011, T-014), fe-router (T-027), tracking-i18n + fe-i18n-parity (T-026).
- SURFACE.md: additions only (4 exports, 2 limiter names, 1 translation key, 1 testid, the App.tsx route lines, the T-027 export) and one removal (`_peer_is_private`, T-029), each covered by a changelog entry; regenerated byte-identical at every verification.
- Static gates: ruff, eslint, tsc -b, i18n parity clean at every verification (7651 → 7665 keys per locale after the client-edit feature and T-026).

## Left for humans

- OPEN: none. BLOCKED: none.
- WONTFIX-AUTO: T-015 (production-column tracking TTL) — declined by the user.
- Follow-ups outside the loop's remit: verify the map embed renders under `no-referrer` (T-010); document `TRUSTED_PROXY_IPS` / `AITO_TRACK_COLLAPSED_PROXY` for containerised installs (T-029); consider whether T-024's wider commit boundary on the trash-restore corner case matters; the 4 TRIAGE leads above.

## Preserved state

`refactor-campaign19-archive/` (committed with this report) holds PLAN.md, TRIAGE.md, BASELINE.md, VERDICTS.log, the eight `findings-audit-*-r{1,2}.json` files and the per-auditor `already-filed-audit-*.txt` lists — the whole of the loop's untracked memory, so removing the worktree loses nothing.
