# Refactor-loop campaign 22 — final report

**Scope:** camera wall (grid-stream slice of `backend/app/api/routes/camera.py`, `services/camera_fanout.py`, the CameraGrid components, the stream hooks, the decoder worker, the camera-wall slice of `PrintersPage.tsx`) plus the Aito card hover dwell (`components/aito/CardView.tsx`, `hoverWarmth.ts`).
**Branch:** `auto-refactor-loop` in `../bambuddy-refactor`, cut from `main` at `a601a46357da1333ef46aa468b2cc6d239321513` (UPSTREAM, 2026-09-29). BASE = tag `refactor-base` (`4256972f4`, the setup commit).
**Parameters:** TRIAGE P3 · MAX_ITER 12 · MAX_ROUNDS 3 · BATCH 3 · auto · grouped commits · merge at exit.
**Ran:** 2026-09-29 → 2026-10-01.

## Why the loop ended

MAX_ROUNDS reached: round 3 was the last survey allowed, and its plan was worked to exhaustion. The iteration budget (12) was spent at the same moment. The campaign did not converge: every round still produced workable findings.

## Numbers

| | |
|---|---|
| Iterations run | 12 (every one verified PASS by a blind verifier; `loop-1` … `loop-12` tags) |
| Survey rounds | 3 (round 1 at setup, rounds 2 and 3 after the plan ran dry) |
| Commits on the branch | 12 squashed iteration commits + the setup commit (`refactor-base`) + this report; `git log refactor-base..HEAD` |
| Files changed since BASE | 23 files, +5670 / −508 lines (before this report) |
| Tasks filed into the plan | 37 — 35 DONE, 2 declined by the user (WONTFIX-AUTO), 0 open, 0 blocked |
| Findings diverted to TRIAGE.md | 22 (P3) |

### Coverage (scoped statements, the ratchet; both only ever went up)

| Stack | BASE | Final |
|---|---|---|
| Backend (`routes/camera.py` + `services/camera_fanout.py`) | 78.28 % (1474/1883) | 83.25 % (1655/1988) |
| Frontend (18 scoped files) | 84.62 % (1392/1645) | 93.13 % (1559/1674) |

Notable per-file moves: `useStreamReconnect.ts` 71.9 → 90 %, `useWebRTCStream.ts` 67.4 → 92 % lines, `useMjpegStream.ts` 85 → 96.9 %, `CameraGridCard.tsx` 78.9 → 97.4 %, `CameraGrid.tsx` 81.3 → 92.5 %, `routes/camera.py` 73.0 → 79.3 % (whole file).

### Tests

| | BASE | Final |
|---|---|---|
| Backend tests | 16 393 passed | 16 467 passed (+74), 1 skipped |
| Frontend tests | 7 450 | 7 532 (+82) |
| Golden probes | 13/13 | 13/13 at every one of the 12 gates |
| SURFACE.md | 428 lines | regenerated identical at every gate; the only diffs vs BASE are the sanctioned T-001/T-003/T-004 route-signature and permission lines |

Lint (ruff check/format, eslint, tsc, i18n parity for all 15 locales) and `npm run build` (Safari 16 baseline) were clean at every gate.

### Known-broken tests: before → after

- Backend: none → none. `test_camera_grid_hub.py::test_restart_identity_check_prevents_stale_removal` was a `-n 10` load flake at setup; T-037 rewrote it as a deterministic event-gated race (passes 3× alone in ~2 s).
- Frontend: `AppRouterAitoGuard.test.tsx` "with aito:read: mounts the Aito board at /aito" fails at BASE and still fails (its "auth disabled" sibling is intermittent). Out of scope for this campaign (Aito router, not camera wall) — see leads.
- Load-sensitive flakes that pass alone (unchanged by the campaign, recorded for the next runner): ArchivesPage ZIP toast, ModelViewerModal #2725, FileUploadModal hashing, PrintModal, FileManagerPage paging, SettingsPage, LocationSensorOptionsModal; backend `test_aito_routes.py::test_import_accepts_a_thousand_projects` (240 s timeout under load) and `test_scheduler_concurrent_dispatch.py::test_check_queue_returns_without_awaiting_the_uploads`. Several verifier runs happened while other sessions pushed the load average past 150.

## User-approved behavior changes (16, all in BASELINE-CHANGELOG.md)

| Task | Change |
|---|---|
| T-001 | `create_stream_token` refuses printer-restricted API keys (403) instead of minting a printer-unbound token |
| T-002 | the stream token is appended only to same-origin `/api/v1/` media srcs |
| T-003 | grid-stream `?force=true` requires `settings:update` |
| T-004 | hub-status diagnostics scoped to the API key's printer allowlist |
| T-011 | grid-stream answers 503 + `Retry-After: 5` (not 404) when the load gate refuses every producer |
| T-012 | SharedStreamHub waits for a dying producer's teardown for every caller |
| T-013 | grid-stream producer restarts run as background tasks (tiles no longer freeze during a restart) |
| T-016 | grid-stream request times out after 45 s when response headers never arrive, then reconnects |
| T-017 | WebRTC `connect()` ignores a superseded attempt's rejection |
| T-018 | `attemptReconnect` cancels a pending reconnect timer before re-arming |
| T-019 | camera wall recovers from a render error (20 s auto-remount + Retry) instead of staying on the error text |
| T-026 | `webrtc_offer` scoped to the API key's printer allowlist |
| T-027 | a params-change replacement waits for the displaced producer's teardown |
| T-053 | hub-status hides fleet-wide `ffmpeg_processes` and `producer_count` from printer-restricted keys |
| T-054 | the single-camera fast lookup treats a producer frozen for >45 s as missing and replaces it |
| T-055 | the camera-wall auto-remount backs off 20 → 40 → 80 → 160 → 300 s and resets after 60 s of stability |

Declined by the user: T-048 (delete the dead `camera_fanout.py` — kept so upstream merges stay clean), T-052 (revoke camera stream tokens on logout — lives in core `auth.py`, outside scope).

## Findings by auditor (filed into the plan)

| Auditor | Filed | DONE | WONTFIX-AUTO | Triaged (never filed) |
|---|---|---|---|---|
| audit-security | 8 | 7 | 1 (T-052) | 0 |
| audit-robustness | 11 | 11 | 0 | 5 |
| audit-cleanliness | 4 | 3 | 1 (T-048) | 12 |
| audit-tests | 14 | 14 | 0 | 5 |
| survey (hand-added) | 0 | — | — | — |

Triaged per round: round 1 → 5, round 2 → 13, round 3 → 4 (22 in all; `plan.py stats` reports the same 22 because nothing was promoted). Every one sits in TRIAGE.md with full evidence; promote one with `python tools/plan.py promote <id> --iteration N` (the flag is required). A copy of TRIAGE.md is in the main checkout under `plans/refactor-campaign22/`.

## What each resurvey round found

- **Round 1 (setup):** 25 findings — 20 filed, 5 triaged. All 6 behavior-change findings approved at setup.
- **Round 2:** 22 findings — security 1 (T-026 WebRTC allowlist, approved), robustness 2 (T-027 approved, T-028 triaged), cleanliness 8 (all low → triaged; a 9th, "unused `useMediaToken` export", was dropped before ingest because SURFACE.md freezes it), tests 11 (7 filed, 4 triaged). Lesson: two auditors returned thin first passes (14 s and 34 s) and had to be resumed with an explicit "read these files in full" list.
- **Round 3:** 12 findings — security 2 (T-053 approved, T-052 declined), robustness 2 (T-054, T-055 approved), cleanliness 4 (T-048 declined, 3 triaged), tests 4 (3 filed, T-056 triaged).

## Leads for humans (not worked, deliberately)

1. **Sibling `/{printer_id}/camera/*` routes** (stop, test, diagnose, status, plate-detection) still use the unscoped `CAMERA_VIEW` check and ignore an API key's printer allowlist — the same gap T-026 closed on `webrtc_offer`. Use the T-026 pattern (`_require_webrtc_printer_access`: auth-gated key lookup + `check_printer_access`), not `RequirePrinterPermissionIfAuthEnabled`, which validates keys even when auth is off.
2. **T-052:** `verify_camera_stream_token` never re-checks the minting user, so a camera token keeps working for up to 60 min after logout/deactivation/permission loss. Needs a core `auth.py` change plus revocation hooks.
3. **T-048:** `services/camera_fanout.py` is dead in production (only `shutdown_all_broadcasters` is called, over an always-empty registry); its docstrings still claim `/camera/stop` uses it. Kept to avoid upstream merge conflicts.
4. **Builtin `TimeoutError` vs `asyncio.TimeoutError` on Python 3.10** at `_terminate_ffmpeg`, `_rtsp_mjpeg_frames` and `cleanup_orphaned_streams` (the same bug T-010 fixed inside the scoped slice).
5. **npm audit:** the `brace-expansion` advisory remains after T-005 (no verified non-breaking fix version at the time).
6. **AppRouterAitoGuard tests** fail at BASE and after (not camera-wall code).
7. **T-019 wording:** the error fallback's countdown reuses `printers.cameraGrid.reconnecting` ("Reconnecting in Ns (attempt N)") because a new locale key would have broken the frozen i18n-parity golden; a dedicated string is a small follow-up.
8. **T-053:** `ffmpeg_processes` is hidden entirely from restricted keys because OS pids carry no printer id; mapping pids to printers would need new bookkeeping.

## Preserved state

Per the user's choice, PLAN.md, TRIAGE.md, BASELINE.md, VERDICTS.log, BASELINE-CHANGELOG.md, SURFACE.md and the 12 `findings-audit-*-r{1,2,3}.json` files were copied to `plans/refactor-campaign22/` in the main checkout (gitignored) before this report was written.
