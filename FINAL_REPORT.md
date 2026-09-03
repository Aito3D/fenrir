# Refactor loop — campaign 9 final report

**Scope:** the whole repository (all of `backend/app` and `frontend/src`) — the first campaign not
narrowed to one feature. **Date:** 2026-08-31. **Branch:** `auto-refactor-loop`, cut from
`2e3fd8f53` (main, the campaign-8 merge).

## Headline

| | |
|---|---|
| Iterations run | 8 of 8 (MAX_ITER) |
| Survey rounds | 1 of 3 — **no resurvey happened**, see "Why the loop ended" |
| Tasks filed / done / left open | 36 / **25** / 11 (+3 triaged) |
| Commits | 9 squashed iteration commits on top of the setup commit |
| Tags | `refactor-base`, `loop-1` … `loop-8` |
| User-approved behavior changes | 10 |
| Backend coverage | 74% → **74%** (held; 12551 → 12633 tests) |
| Frontend coverage | 58.02% → **59.30%** statements · 58.86% → **60.23%** lines · 53.63% → 54.83% branches · 49.27% → 50.62% functions |
| Golden probes | 10/10 matching at every iteration |
| SURFACE.md | +7 additive lines, every one mapped to a changelog entry |
| Known-broken tests | 1 → **0** (and the original one was a misdiagnosis — see below) |

## Why the loop ended: MAX_ITER

The iteration budget ran out while 11 tasks were still open. **The plan was never exhausted, so the
resurvey never ran** — rounds 2 and 3 of the auditor panel did not happen, and the campaign cannot be
called converged. A second campaign on this codebase would still have plenty to find, and would start
by resurveying rather than from a clean slate.

## Findings by auditor

| Auditor | Filed | Done | Still open |
|---|---|---|---|
| audit-tests | 11 | **11** | 0 |
| audit-robustness | 13 | 7 | 6 |
| audit-security | 9 | 4 | 5 |
| audit-cleanliness | 5 (2 filed + 3 triaged) | 2 | 0 |
| survey (known-broken test) | 1 | 1 | 0 |

**The scanners found nothing.** `npm audit` reported 0 vulnerabilities, `pip-audit` was clean, and all
24 gitleaks / 185 bandit / 46 semgrep hits triaged out as gitignored keys, test fixtures, or constant
strings. Every real finding in this campaign came from manual review.

**Triaged: 3** (all from audit-cleanliness, all P3) — debug `console.log` leftovers in
`KProfilesView.tsx` and `ArchivesPage.tsx`, and an ad-hoc logger in `users.py`. They sit in
`TRIAGE.md` with full evidence; promote one with
`python tools/plan.py promote <id> --iteration N` (that flag is required).
Caveat: `plan.py stats`'s `triaged` count is what is *currently* in TRIAGE.md, not a campaign-wide
total — `promote` decrements it and `archive` does not archive TRIAGE.md.

## The 10 user-approved behavior changes

Each has a dated `BASELINE-CHANGELOG.md` entry and a commit marked `(user-approved behavior change)`.

1. **T-017 (P0, data loss)** — `restore_backup()` deleted the live data directories *before* copying,
   and returned `success: true` when the copy failed. On a full disk your entire print archive was
   erased while the UI reported success. Now stages into a sibling directory and swaps in only after
   the copy completes; a failure returns HTTP 500 with live data intact.
   *Cost:* staging doubles peak disk usage, so a near-full disk that previously squeaked through now fails.
2. **T-020** — `broadcast()` fans out concurrently off the lock with a 5s per-send timeout. One wedged
   viewer no longer stalls live updates for the whole farm.
3. **T-021** — every updater subprocess is bounded, kills its whole process group, and clears the
   in-progress guard on all failure paths.
4. **T-023** — one unparseable MQTT frame no longer kills paho's network thread and takes a printer
   permanently offline.
5. **T-027** — a per-file hash failure is now shown instead of silently skipping duplicate detection.
6. **T-031** — 54 printer-control routes now enforce an API key's `printer_ids` allowlist.
7. **T-032** — AMS history purge moves to an admin-only permission.
8. **T-033** — printer sensor history purge, likewise.
9. **T-034** — archive external links refuse `javascript:`/`data:`; URL normalisation is write-path only.
10. **T-002** — additive `useMediaQuery` export (recorded for completeness, no behavior change).

## What was actually fixed

**Security (4).** The API-key `printer_ids` allowlist was enforced on only 10 file routes; 54 control
routes — pause, resume, stop, home, jog, heat, fan, AMS load/unload, delete printer — ignored it
entirely. Reverting the gate made 9 tests fail with `assert 200 == 403`, which is the vulnerability
demonstrated rather than asserted. Two DELETE endpoints that purge history sat behind *read*
permissions the read-only "Viewers" role holds. All four archive external-link sinks now refuse
`javascript:` and `data:` URLs.

**Robustness (7).** Gigabyte-scale backup `copytree` and ZIP compression moved off the event loop
(they froze the entire process for minutes, dropping MQTT callbacks and triggering WebSocket
reconnect storms); the restore upload streams to disk instead of being held in memory three times
over; duplicate-check hashing is capped at 3 concurrent files.

**Tests (11).** Five zero-coverage surfaces, all security-adjacent — `TwoFactorSettings`, `UsersPage`,
`SetupPage`, `CreateUserAdvancedAuthModal`, `FinancePage` — went from 0% to covered, two of them to
100%. Six flaky tests were fixed *at the root* rather than by raising timeouts.

## What the loop got wrong about itself

Three corrections worth more than any single fix:

**1. The "known-broken" test was never broken.** At setup, an ArchivesPage test failed 4/4 full runs
*and* an isolated run, so it was recorded as genuinely broken. That isolated run was made while
`npm ci`, pip installs and two full suites were competing for CPU — "alone" still meant starved. It
later passed 39/39 three times on an idle machine. **Lesson, now written into BASELINE.md: one
isolation run on a busy machine does not establish "broken".**

**2. A behavior change slipped the approval gate — and a blind reviewer caught it.** T-027's finding
was tagged `behavior_change: false`, so `ingest` never routed it for approval, yet its own fix text
said "surface the per-file failure", which is user-visible by definition. The loop asked for the
change without asking the user. The blind verifier caught it from the diff alone.

**3. A behavior change that no automated check could see.** T-034 attached a Pydantic
`BeforeValidator` to `ArchiveResponse` — the *read* path — so the API silently rewrote stored data on
the way out. A `BeforeValidator` does not alter the JSON schema, so **all 10 golden probes and
SURFACE.md were blind to it.** The only thing that surfaced it was the rule that every SURFACE/golden
movement must map to a changelog entry, plus a reviewer reading the diff. That rule earned its keep.

## THE BIGGEST FINDING — your test suite talks to a real server

`frontend/src/__tests__/setup.ts:17` sets `onUnhandledRequest: 'bypass'`. Any endpoint a test forgets
to mock does not fail — it escapes MSW and goes out to whatever is listening on port 3000. A Vite dev
server **is** live there, proxying to a real backend on :8000.

The final verifier instrumented the whole suite and measured it:

> **5850 unhandled requests across 81 of 380 test files, spanning ~40 distinct endpoints.**
> Worst: `ProjectDetailPanel` 1025, `FileManagerPage` 536, `StatsPage` 460, `PrintersPage` 413,
> `PrintModal` 382, `ArchivesPage` 316. Most-hit: `aito/{id}/events` 680, `calculator/printers/` 450,
> `calculator/filaments/` 450, `aito/shipping/services` 428.

This is the confirmed root cause of **two** tracked flakes (`ModelViewerModal`, `StatsPageUserFilter1894`)
— measured round trips of 328–1984ms against a 1000ms default timeout. It is almost certainly the
cause of a third: all four `PrintModal` failures in the final gate run correlate with unmocked calls
(`POST /queue/batches`, `/cloud/builtin-filaments`, `/cloud/filament-id-map`), failing at
8340/8312/8366/8742ms — straight through the 8s ceiling raised for it.

**Recommendation, and the highest-value follow-up available:** set `onUnhandledRequest: 'error'` and
add the missing handlers. It will fail loudly at first. It would retire the campaign's worst flake for
real, and stop your test suite mutating whatever your dev backend is pointed at.

**Timeouts are not the fix.** Three ceilings were raised this campaign and all three were blown:
5s failed at 5162ms, 8s at 8442ms, 15s under `-n 30`. Bigger numbers buy odds, not determinism.

## For the human reviewer — look at these by hand

1. **The RBAC change is deployment-visible.** Operators *and* Viewers lose both history-purge
   endpoints (broader than the "Viewers" wording you approved — flagged and confirmed at the time),
   and printer-scoped API keys start getting 403 outside their allowlist. Worth conscious sign-off,
   not merge-on-green.
2. **`ConnectionManager.broadcast` is now concurrent** — the only true concurrency-semantics change.
   Two frames can now be in flight to one socket, and a client exceeding 5s is dropped and must reconnect.
3. **`FileUploadModal` introduces a hardcoded English string** (`Duplicate check failed: …`) not routed
   through i18n. `check:i18n` passes because it checks locale-file *parity*, not literals — so nothing
   catches this. All 13 locales remain in parity at 7152 keys.
4. **T-018/T-019 have no changelog entry**, judged behavior-preserving (same status codes, bodies and
   messages). Confirm you agree.
5. **T-021's residual risk:** a `git reset --hard` killed mid-checkout can leave a mixed working tree.
   Reported, not fixed — no rollback mechanism was built.
6. **T-027 is half-done by design:** `crypto.subtle.digest` is one-shot, so a single very large file is
   still read whole into memory. True streaming needs an incremental-SHA256 dependency you have not
   been asked for.

## Left open for humans — 11 tasks, full evidence in PLAN.md

**Security (5):** `T-035` plate-detection calibration mutations gated on `CAMERA_VIEW`;
`T-036` `stop_logging` flips server debug logging under `SETTINGS_READ`; `T-037` `submit_bug_report`
ships a support bundle off-box under `SETTINGS_READ`; `T-038` the camera stream token is an unscoped
capability accepted by 20 non-camera endpoints; `T-039` uploaded 3MF XML parsed with stdlib
ElementTree instead of defusedxml (every other 3MF parse site uses defusedxml).

**Robustness (6):** `T-022` `apply_update()` check-then-await-then-set race; `T-024` `_stream_mjpeg()`
unbounded frame buffer (OOM); `T-025` `process_timelapse()` predictable temp paths clobber concurrent
requests; `T-026` `auto_off_pending` stuck when a smart-plug turn-off fails — the dashboard claims a
shutdown is queued while a printer stays energised; `T-028` no `AbortSignal` on any API call;
`T-029` `_safe_execute()` swallows "no such column" for every statement (P3).

**Also reported by workers but never filed as tasks** (auditors are the only source of survey findings,
and the resurvey that would have filed them never ran):
- The same API-key allowlist gap remains in `print_queue.py`, `spoolman.py`, `maintenance.py`,
  `inventory.py`, `calculator.py`, and ~30 other `{printer_id}` routes across `camera.py`,
  `firmware.py`, `smart_plugs.py`, `printer_sensor_history.py`.
- `UsersPage.handleUpdate` has an unreachable branch (the Save button's `disabled` already blocks it).
- The create/edit user modals carry a `role` field through the API types with no UI selector.
- `FinancePage`: a `??` that should be `||` renders a raw `[failed:]` tag instead of `-`; no positivity
  validation on budgets or edited amounts; clearing a field omits it from the PATCH ("no change", not "clear").
- `SetupPage` sends `admin_username: ""` rather than omitting it when auth is enabled with blank fields.
- `PrintLogTable.tsx` has no test file at all.
- `test_settings_dedupe_migration.py` is inverse-flaky (fails alone, passes in the suite).

## Verification at exit

10/10 golden probes · SURFACE.md regenerates byte-identical · `PROBES.json` and `tools/` byte-identical
to BASE · coverage config untouched (no exclusion added, no glob narrowed) · no test deleted, renamed,
skipped or weakened anywhere in the range · backend 12633 passed / 0 failed · frontend 5387 passed,
4 failed (all `PrintModal`, known-flaky, 79/79 alone) · i18n parity across 13 locales.

Note: the final runs were made on a **heavily shared machine** (6 users, load averages 21/52/89 on 16
cores). One `-n 30` coverage run was SIGKILLed OOM-adjacent through no fault of the code; the numbers
above come from a clean `-n 8` re-run.

## Records

`refactor-campaign9-archive/` at the repo root holds `PLAN.md` (all 36 tasks with full evidence),
`TRIAGE.md`, `BASELINE.md` (baselines, the flake inventory, the known-broken correction),
`VERDICTS.log` (all 10 verdicts in full, including the unhandled-request analysis), and the 4 raw
auditor findings files — matching the campaign 6/7/8 archives you already keep.
