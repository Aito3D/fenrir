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

## T-053 — camera hub-status hides fleet-wide ffmpeg processes and producer count from printer-restricted API keys (user-approved 2026-10-01)

Sanctions commit <this commit> "refactor(loop-12): T-053 hide fleet-wide ffmpeg
processes and producer count from printer-restricted API keys (user-approved
behavior change)". Completes the T-004 filter on `GET /camera/hub-status`
(`camera_hub_status` in `backend/app/api/routes/camera.py`). For an API key
restricted to a `printer_ids` allowlist (including an empty list):
`ffmpeg_processes` is now `[]` — `_state.spawned_ffmpeg_pids` is keyed by OS
pid and carries no printer or stream id, and only part of it could be mapped
back through `active_streams`, so no new bookkeeping was added and the whole
list is hidden; and `grid.producer_count` is recomputed as
`len(grid.producers)` after the T-004 filter, so it counts only the key's
visible producers instead of every producer in the hub. Other fields checked:
`system_load` (host load average and CPU count) and
`cooldown_active`/`cooldown_remaining_s` (the fleet CPU circuit breaker) are
host-wide, not derived from per-printer data, and stay as is;
`watchdog_thresholds` is constants; the per-printer fields were already
filtered by T-004.
Unchanged: the response shape (same keys and types); the CAMERA_VIEW
permission gate; and byte-identical output for JWT users, auth-disabled
callers and global keys (`printer_ids=None`), whose `producer_count` still comes
straight from `_hub.status()` and whose `ffmpeg_processes` still lists every
tracked pid.

- Golden probes re-recorded: none (13/13 match).
- SURFACE.md sections regenerated: none (`bash tools/gen_surface_c22.sh | diff - SURFACE.md` is empty; no signature change).

## T-055 — camera wall backs off its automatic remount after repeated render errors (user-approved 2026-10-01)

Sanctions commit <this commit> "refactor(loop-12): T-055 back off the camera
wall's automatic remount after repeated render errors (user-approved behavior
change)". Refines T-019. `CamWallErrorBoundary` in
`frontend/src/pages/PrintersPage.tsx` used to remount an errored camera wall
after a constant 20 s whatever had happened before, so a wall whose child
threw on every mount reconnected the whole wall (a new `/camera/grid-stream`
request and decoder worker) every 20 s for as long as the bad data lasted —
about 4,300 times a day on an unattended kiosk. The automatic delay now grows
with consecutive failed remounts: `min(20_000 * 2 ** failures, 300_000)`, so
20 s, 40 s, 80 s, 160 s, then 300 s (5 min) from then on. Once a remounted
wall has stayed up for 60 s (a timer started when the boundary leaves the
error state, cleared if it errors again first or the boundary unmounts) the
failure count resets and the next crash starts again at 20 s. The countdown
line shows the actual delay in seconds. All new names (`CAM_WALL_AUTO_RETRY_MAX_MS`,
`CAM_WALL_SETTLE_MS`, `camWallRetryDelayMs`) are module-private.
Unchanged: the error text, the countdown string and its attempt number (still
the monotonic count of remounts plus one), the Retry button (still remounts
immediately and cancels the pending auto-retry), `role="alert"`, the remount
`key` (a separate monotonic counter, never reset), no locale changes, the
shared `components/ErrorBoundary.tsx`, and everything the wall renders while
healthy.

- Golden probes re-recorded: none (13/13 match).
- SURFACE.md sections regenerated: none (`bash tools/gen_surface_c22.sh | diff - SURFACE.md` is empty; no new export).
- 2026-10-09 T-024: re-baseline — additive internal export aito_project_links.record_and_broadcast (helper shared by routes/project_files._record_linked, project_filing.record_revision_added, aito_project_links._fan_out_revision); no behavior change.
- 2026-10-09 T-026: re-baseline — additive internal export components/projects/files/useFileDropZone (drag/drop handlers shared by CardDropTarget, useTaskFileDrop, SectionBlock, ItemRow); no behavior change.

## 2026-10-01 — campaign 23, T-104: additive internal export AitoDialogShell (sanctioned re-baseline, not a behavior change)

Sanctions commit <this commit> "refactor(loop-3): T-104 extract AitoDialogShell
from the five copy-pasted Aito dialogs". The frame the panel's stacked dialogs
copied line for line — the z-[110] backdrop with its overlay in/out animation
and click-to-close, the Escape trap (stopPropagation, then close unless already
closing or a mutation is in flight), the role=dialog Card with its modal in/out
animation, max width and optional 88vh cap, and the 36px icon tile + h2 +
subtitle + close-X header — now lives in the new
`frontend/src/components/aito/AitoDialogShell.tsx`. MergeProjectModal,
TransferClientModal, TaskTransferModal and WatchModal use the standard header;
ClientHistoryModal keeps its own h3 masthead (different inset, glyph size and
close button) and passes it to the shell as a custom header. Bodies, footers,
the `useDismissableDialog` call and MODAL_OUT_MS (170) stay in each dialog,
since the footers differ. The rendered DOM of all five dialogs is unchanged:
old and new versions were rendered side by side (open, settled, and after
Escape) and their HTML compared byte for byte; every class string, role, aria
attribute, data-testid and i18n key is the same. No locale changes.

- SURFACE.md sections regenerated: "Frontend exported symbols" (+1 line, additions only).
- Golden probes re-recorded: none (35/35 match).

## 2026-10-01 — campaign 23, T-112: additive internal exports PanelMenuModals, useDescriptionEditor (sanctioned re-baseline, not a behavior change)

Sanctions commit <this commit> "refactor(loop-5): T-112 move the detail panel's
menu-modal state, description editor and watch query into hooks". The
description card's editor state (draft, edit session and its captured version,
clamp measurement, save indicator, regenerate mutation, and their layout
effect and two effects) moved verbatim into the new hook
`frontend/src/components/aito/useDescriptionEditor.ts`, called at the exact
position the block occupied, so hook and effect order are unchanged. The four
⋯-menu dialogs (merge, client transfer, watch, split/move) now render through
the new pure component `frontend/src/components/aito/PanelMenuModals.tsx`; the
five open flags stay in ProjectDetailPanel through a file-local
`usePanelMenuModals` hook, and the watch query through a file-local
`useProjectWatch`, both at their original positions — so every piece of state
still lives and resets exactly as long as the panel does. The client edit /
close animation state and the tabs were not touched. The panel's rendered DOM
is unchanged: old and new versions were rendered side by side (settled, menu
open, each dialog opened from the menu, trash confirm, watch with auth on and
the "." shortcut, description edit start / Escape / blur-save) and their HTML
compared byte for byte after normalising the global useId / dnd-kit id
counters. No query keys, i18n keys or locale changes.

- SURFACE.md sections regenerated: "Frontend exported symbols" (+2 lines, additions only).
- Golden probes re-recorded: none (35/35 match).

## 2026-10-02 — campaign 23, T-128: additive internal export CandidatePicker (sanctioned re-baseline, not a behavior change)

Sanctions commit <this commit> "refactor(loop-8): T-128 share the candidate
search picker between the merge and transfer dialogs". The search box and the
radiogroup scroll wrapper around CandidateList, copied verbatim in
MergeProjectModal and TaskTransferModal's pick-target step, moved into the new
component `frontend/src/components/aito/CandidatePicker.tsx` (a fragment of the
same two divs). It is controlled: `query` and the selection stay in each
dialog, so the transfer dialog still keeps the typed query and the picked card
across Back / Next exactly as before (the step unmounts the picker). The
radiogroup's aria-label is passed in (the merge title / the transfer title).
Old and new versions of both dialogs were rendered side by side (merge: open,
loaded, type, pick, no-match; transfer split; transfer move: tick, Next, type,
pick, Back, Next again, type) and their HTML plus the focused element compared
equal after normalising useId counters; every class string, role, aria
attribute, placeholder, autoFocus, data-testid and i18n key is the same. No
locale changes.

- SURFACE.md sections regenerated: "Frontend exported symbols" (+1 line, additions only).
- Golden probes re-recorded: none (35/35 match).

## 2026-10-02 — campaign 23, T-138: additive internal class _OptionalClientContactChecks (sanctioned re-baseline, not a behavior change)

Sanctions commit <this commit> "refactor(loop-10): T-138 share the optional
client email/phone validators across the client-bearing schemas". The
`client_email` / `client_phone` field validators (None passes, otherwise
`_check_email` / `_check_phone`), pasted verbatim into AitoProjectCreate,
AitoClientTransfer and AitoProjectUpdate, moved into the new validators-only
mixin `_OptionalClientContactChecks` in `backend/app/schemas/aito.py`, which
the three models now inherit. The mixin is a plain class, not a BaseModel, and
declares no fields: every model keeps its own client field declarations, so
field names, caps, defaults, model_fields order and JSON-schema order are
unchanged (pinned per model by the new
`backend/tests/unit/test_aito_schema_client_contact.py`: accept/reject
outcomes, exact error type/loc/msg, field order and a sha256 of each ordered
JSON schema, all captured from the unchanged code). AitoClientEdit's
non-optional email/phone validators were left as they are. Being a plain
class, it does not appear in the "Pydantic schema fields" section.

- SURFACE.md sections regenerated: "Pydantic schemas + ORM model class names" (+1 line, additions only).
- Golden probes re-recorded: none (35/35 match).

## T-096 — transferring a card to another client rotates its public tracking token (user-approved 2026-10-03)

Sanctions commit <this commit> "refactor(loop-11): T-096 rotate the tracking
token when a card changes client (user-approved behavior change)". A card's
public `/t/` link was handed to its client (sent to them, printed in the Zoho
estimate's notes), and it survived a change of client: after a card was
transferred to another contact the previous client's link kept serving the new
client's job (tasks, due date, island, air waybill number and, while unpaid,
the payment link). Now `transfer_client` in `backend/app/api/routes/aito.py`
(PUT `/aito/{id}/transfer-client`, when the contact id actually changes) and
`_follow_customer` in `backend/app/services/aito_quote_sync.py` (the sweep
adopting a customer reassigned in Books) replace an existing
`tracking_token` with a fresh one from `mint_unique_token`. User-visible: the
link sent earlier now answers "Lien introuvable" (404) and the operator sends
the new client the new link. Unchanged: a card that never had a token still
has none (one is minted lazily as before), the same-contact no-op keeps the
token, no event is added, and the transfer's queued push rewrites the
estimate's notes through `notes_with_tracking` as it already did. Pinned by
three new tests each in `backend/tests/unit/test_aito_transfer_client.py` and
`backend/tests/unit/test_aito_sync_customer.py`.

- Golden probes re-recorded: none (35/35 match).
- SURFACE.md sections regenerated: none (`bash tools/gen_surface_aito23.sh` output identical to SURFACE.md).

## T-100 — create_invoice refuses a card that went back to pending while it waited for the invoice lock (user-approved 2026-10-03)

Sanctions commit <this commit> "refactor(loop-11): T-100 re-check the sync
state under the invoice lock (user-approved behavior change)". `create_invoice`
in `backend/app/api/routes/aito.py` runs its push guard (`ensure_pushed(strict=True)`
in `_project_ready_to_invoice`) before taking `_invoice_lock`, and that lock is
held across 10 s+ of Books calls by any other invoice in progress. A task edit
committed during that wait put the card back to `quote_sync_state = 'pending'`
with Books still holding the old lines, and the re-read under the lock only
re-checked `quote_invoiced`, so the invoice billed the pre-edit lines. Now,
right after that re-read, a pending card is refused with 503 and
`SYNC_PENDING_DETAIL` (`code: sync_pending`, the "Zoho has not confirmed the
latest changes yet" message the frontend already maps to
`aito.syncNotConfirmed`), before the duplicate read and the create; no Books
call is made. It does not push or wait for the push under the lock, so the lock
is never held across a flush wait. User-visible: an invoice click that races a
concurrent edit of the same card gets that 503 instead of producing an invoice
from the pre-edit lines. Unchanged: every guard before the lock, the 409 for an
already-invoiced card (still checked first), and everything after the check.
An edit committed after the re-read (during the plan reads) is not covered by
this change. Pinned by
`test_an_edit_landing_while_the_create_waits_for_the_lock_is_refused` in
`backend/tests/unit/test_aito_invoice_create.py`.

- Golden probes re-recorded: none (35/35 match).
- SURFACE.md sections regenerated: none (`bash tools/gen_surface_aito23.sh | diff - SURFACE.md` is empty).

## T-101 — inbox read-all is bounded by the newest row shown, and both mark-read writes refetch when they settle (user-approved 2026-10-03)

Sanctions commit <this commit> "refactor(loop-11): T-101 bound inbox read-all
and refetch after mark-read (user-approved behavior change)". Two halves:

- Backend: `POST /api/v1/inbox/read-all` (`read_all` in
  `backend/app/api/routes/inbox.py`) gains an OPTIONAL query parameter
  `up_to: int | None = Query(None, ge=1)`. When given, the UPDATE is bounded
  with `Notification.id <= up_to`, so a row that arrived after the panel was
  drawn stays unread. Without it the route marks every unread row read,
  exactly as before, so an older client behaves as it always did. `up_to=0`
  or a negative value is a 422.
- Frontend: `api.markInboxAllRead(upTo?: number)` in `frontend/src/api/client.ts`
  appends `?up_to=` only when given (additive, optional). In
  `frontend/src/components/NotificationBell.tsx`, `markAllRead` sends the
  newest id of the cached page (`items[0].id`), and both `markRead` and
  `markAllRead` refetch the inbox (`invalidateQueries(INBOX_KEY)`) once the
  write settles. The optimistic `cancelQueries` before each write could throw
  away an arrival's in-flight refetch, and nothing refetched after it.
  `writeFailed` now only shows the toast, because the refetch on settle
  replaces the one it used to start.

User-visible: a notification that arrives while the user clicks "Mark all
read" (or marks one row read) stays unread, shows up and rings the bell (and
chimes per sound_kinds) right after the write, instead of being marked read
silently or staying hidden until the next focus or event. Unchanged: the
optimistic patches, the failure toast, the arrival/ring logic, and the read-all
behavior without `up_to`.

Tests: `test_read_all_up_to_leaves_newer_rows_unread` and
`test_read_all_rejects_a_non_positive_up_to` in
`backend/tests/unit/test_inbox_routes.py`. Three new cases in
`frontend/src/__tests__/components/NotificationBell.test.tsx` (up_to sent, an
arrival during a held read-all stays unread and rings, mark-one refetches and
shows an arrival). The default MSW read handlers there now update the mocked
server inbox the way the real server does, because every write now ends in a
refetch. The existing "Mark all read clears every unread row" assertions are
unchanged.

- Golden probes re-recorded: app-openapi-index (read_all's params gain `query:up_to`; the other 34 match unchanged).
- SURFACE.md sections regenerated: none (`bash tools/gen_surface_aito23.sh` output identical to SURFACE.md; the client.ts method signature is not captured).

## T-102 — the hourly invoice sweep serves due pushes between projects and stops at the Books call ceiling (user-approved 2026-10-03)

Sanctions commit <this commit> "refactor(loop-12): T-102 serve pushes and
respect the call ceiling in the invoice sweep (user-approved behavior change)".
`sweep_invoices` in `backend/app/services/aito_invoice_sweep.py` gains two
OPTIONAL keyword arguments, `serve_due_pushes` and `call_ceiling` (both default
`None`, which keeps the old pass). `run_sync_loop` in
`backend/app/services/aito_quote_sync.py` passes its own `_serve_due_pushes`
(handed in, not imported, to avoid the import cycle) and
`BACKGROUND_CALL_CEILING`. Before each project the sweep serves due pushes
(the served drain contains its own failures, as in `_drain_reconcile_queue`),
then, once `zoho_service.calls_in_last_minute()` has reached the ceiling, the
pass stops without stamping `_last_run`. The existing least-recently-checked
ordering makes the next tick resume with the unreached tail. User-visible: on
large boards the hourly invoice refresh may finish over several ticks instead
of one, and the document/invoice buttons (Print quote/invoice PDF, Send quote,
Create invoice) no longer return the 503 "Zoho has not confirmed" while it
runs. Unchanged: the 429 path, the per-project commit and skip rules, the
hourly gate after a pass that reaches the end. Pinned by five new tests at the
end of `backend/tests/unit/test_aito_invoice_sweep.py`. The six loop-level
`sweep_invoices` fakes in the test suite now accept the new keyword arguments.

- Golden probes re-recorded: none (35/35 match).
- SURFACE.md sections regenerated: the `sweep_invoices` line now reads `async def sweep_invoices(` (the signature is wrapped over several lines and the generator keeps only the first one).

## T-123 — the abandoned-reservation sweep no longer writes off a reservation that is being replayed (user-approved 2026-10-03)

Sanctions commit <this commit> "refactor(loop-12): T-123 the age-out sweep
leaves a replayed reservation alone (user-approved behavior change)".
`_age_out_abandoned_reservations` in
`backend/app/services/aito_terminal_payments.py` used to set
`status='failed'` and `settled_at` with an unconditional ORM write and never
checked `_in_flight`. A replay of an old unminted reservation keeps the row's
original `created_at`, so a tick landing during the replay's POST
(`confirm: true`) wrote the row off and recorded a false `abandoned` event.
The replay's `_adopt` then set `status`/`heimdall_id` but not `settled_at`, so
Heimdall's later `paid` never produced the paid event, the quote acceptance or
the notification for a real card charge. Now the sweep skips ids in
`_in_flight`, and the write-off is a conditional
`UPDATE ... WHERE id = :id AND status = 'pending' AND heimdall_id IS NULL AND settled_at IS NULL`.
When it matches no row, nothing is written, no event is recorded and the row
is not counted. The write-off and its `payment.terminal.failed` event still
share one commit (T-122). User-visible: a reservation being replayed (its
`start_terminal_payment` POST in flight) is no longer marked abandoned/failed
by the sweep mid-request, and a row the replay already adopted is left alone.
Unchanged: the cutoff, the selection, the per-row isolation, and the other
branches. Pinned by three new tests in
`backend/tests/unit/test_aito_terminal_payments.py` (in-flight skip, a claim
that loses to an adoption between listing and write, and a sweep running
during a replay POST end to end).

- Golden probes re-recorded: none (35/35 match).
- SURFACE.md sections regenerated: none (`bash tools/gen_surface_aito23.sh` output identical to SURFACE.md).

## T-121 — only Books' own status history (comment_type "system") becomes a quote viewed/accepted/declined/expired/sent event (user-approved 2026-10-03)

Sanctions commit <this commit> "refactor(loop-12): T-121 classify only Books'
system history comments (user-approved behavior change)". `map_comment` in
`backend/app/services/aito_zoho_comments.py` matched its keyword table against
every Books comment, so a note typed by a person (a staff note such as "Devis
non accepté", or a customer-portal comment) that merely contained "accepté",
"refusé", "consulté" and so on was recorded as a client `quote.accepted` /
`quote.declined` / `quote.viewed` event. That event rang every watcher's inbox
bell and counted in the acceptance stats. Now the table is tried only when
`comment.get("comment_type") == "system"`. Every other comment (other type,
or none) falls through to the existing `zoho.comment` fallback with
`actor_class` "system" and the text verbatim. User-visible: human-written Books
comments that mention 'accepted', 'refusé', 'consulté' and so on appear on the
timeline as plain Zoho comments instead of quote accepted/declined/viewed
events, and no longer ring the inbox bell or count in the acceptance stats.
Evidence the gate keeps real history: a user-authorised READ-ONLY probe of
three real estimates (GET /estimates/{id}/comments, 2026-10-03, 37 comments)
found every history comment carrying `comment_type == "system"`. That includes
"Devis accepté à l’aide du lien public", "Le client a consulté le devis dans
l’e-mail." and "Devis marqué comme accepté/refusé/envoyé". Unchanged: the
pattern table, the echo suppression, the timestamps and the fallback. Pinned
by new tests in `backend/tests/unit/test_aito_zoho_comments.py`: a system
public-link acceptance still maps to `quote.accepted`; system viewed/declined
history is still classified; the same texts with comment_type absent,
"internal", "customer", "SYSTEM" or "" map to `zoho.comment`; an internal
note mentioning acceptance is mirrored as a plain comment. The existing
fixtures already carried `comment_type: "system"` and were not changed.

- Golden probes re-recorded: aito-status-comments. Its `map_comment` samples
  in the frozen `tools/probe_aito_status.py` carry no `comment_type`, so the
  four that were classified (viewed, accepted, declined, expired) now read
  `zoho.comment` / `system`. Real Books status history always carries
  "system" (probe above), so on real data only non-system comments change.
  The other 34 probes match unchanged.
- SURFACE.md sections regenerated: none (`bash tools/gen_surface_aito23.sh` output identical to SURFACE.md).

## T-125 — a DB error on one card no longer strands the rest of its drain (user-approved 2026-10-03)

Sanctions commit <this commit> "refactor(loop-13): T-125 one card's error no
longer strands the rest of the drain (user-approved behavior change)".
`run_sync_once` in `backend/app/services/aito_quote_sync.py` spends every due
push window up front, and the per-card `_reconcile_one` call had no guard. An
exception there (a `db.get` that raised, a `record()` failing inside
sync_project's catch-all) left the loop. The cards it had not reached stayed
pending with no window, so `any_due()` was false and nothing woke the loop
before the next full tick. Their `flush_and_wait` waiters were never
resolved either, so a Print or Send-quote route waiting in `ensure_pushed`
answered 503 after the flush timeout. Now each `_reconcile_one` call is
wrapped: on an `Exception` it logs "Aito quote sync failed for project %s",
rolls the session back, resolves that card's waiter and moves on to the next
card. If the loop is still left by an exception the guard does not catch
(a cancellation), a `finally` calls `note_immediate()` for every due id the
loop never reached, so the next lap takes them. User-visible: after a DB
error on one card, the remaining cards of that drain are pushed in the same
drain instead of at the next full tick, and a waiting route gets its answer
instead of a 503. Unchanged: the success path, push order, the 429 break
(the cards after it still get no window, so the loop is not re-woken into
the limit), `attempted` counting (a card that raised is not counted), and
the existing error logging. Pinned by three new tests in
`backend/tests/unit/test_aito_quote_sync_wake_latency.py`: a failing first
card does not stop the second, and both waiters resolve; a cancellation
re-arms the unreached due card; a 429 break leaves no window behind.

- Golden probes re-recorded: none (35/35 match).
- SURFACE.md sections regenerated: none (`bash tools/gen_surface_aito23.sh` output identical to SURFACE.md).

## T-126 — the second of two concurrent or duplicated merges of the same cards gets a 409 (user-approved 2026-10-03)

Sanctions commit <this commit> "refactor(loop-13): T-126 merge claims both
cards before writing (user-approved behavior change)". `merge_project` in
`backend/app/api/routes/aito.py` checked that both cards were active with a
SELECT, then trashed the source with an unconditional ORM write many awaits
later. Two merges interleaving on the event loop both passed the check. A<-B
sent twice copied B's tasks onto A twice, so A's quote was pushed with every
line doubled. A<-B racing B<-A trashed both cards. Now, after the existing
refusals and before the first write, the new `_claim_active_projects` runs a
no-op `UPDATE aito_projects SET version = version, updated_at = updated_at
WHERE id = :id AND status = 'active'` on both cards, in id order (so crossed
merges cannot deadlock). If either matches no row, the request answers 409
"One of these cards was just merged or deleted — refresh". No task is copied
and no event is recorded. User-visible: the second of two concurrent or
duplicated merge requests gets a 409 instead of succeeding. Unchanged: the
single-request success path (copies, the ORM trash write, events, sync
wake, broadcasts, response), and the earlier 404/409 refusals, which keep
their order. The claim sets `version` and `updated_at` to their own values
(like `_claim_expected_version`), so it changes nothing on the row. Pinned
by two new tests in `backend/tests/unit/test_aito_merge.py`: a duplicated
A<-B (one 200, one 409, tasks copied once, one merged/trashed event each),
and crossed A<-B / B<-A (one 409, the winner's target stays on the board).

- Golden probes re-recorded: none (35/35 match).
- SURFACE.md sections regenerated: none (`bash tools/gen_surface_aito23.sh` output identical to SURFACE.md).

## T-124 — an error escaping the tick's attention pass no longer skips the tick's later passes (user-approved 2026-10-03)

Sanctions commit <this commit> "refactor(loop-14): T-124 attention pass gets
its own guard (user-approved behavior change)". `run_sync_loop` in
`backend/app/services/aito_quote_sync.py` called
`run_sync_once(db, attention_only=True)` outside any try of its own, while
every pass after it has one. An exception escaping it (its selection query
hitting a locked database, a `record()` failing inside sync_project's
catch-all) fell through to the outer "Aito quote sync tick failed" handler,
so the tick skipped the change pass, invoice sweep/poll, contact poll,
tracking purge, inbox sweep, payment-link reconcile and terminal poll for
the whole poll interval. Now that one call is wrapped like the change pass
below it: on an `Exception` it logs "Aito attention pass failed" and rolls
the session back (rollback errors suppressed), and the tick goes on to
`_serve_due_pushes` and the later passes. Cancellation is not an
`Exception` and still propagates. Unchanged: every other pass's guard, the
outer tick handler, the between-tick laps. Pinned by
`test_a_failing_attention_pass_does_not_cost_the_tick_its_other_passes` in
`backend/tests/unit/test_aito_push_windows.py` (fails on the old code: the
terminal poll is never reached). `test_run_sync_loop_survives_a_failing_periodic_tick`
in `backend/tests/unit/test_aito_quote_sync.py` pinned the old routing of an
attention-pass error to the outer handler; it now raises from the tick's
`sync_enabled` read instead, so it still drives the outer handler and the
cancellation check.

- Golden probes re-recorded: none (35/35 match).
- SURFACE.md sections regenerated: none (`bash tools/gen_surface_aito23.sh` output identical to SURFACE.md).

## T-155 — the quote email refuses a card whose edits have not reached Books (user-approved 2026-10-03)

Sanctions commit <this commit> "refactor(loop-15): T-155 quote email refuses
unpushed edits (user-approved behavior change)". `get_quote_email` and
`send_quote_email` in `backend/app/api/routes/aito.py` called
`ensure_pushed(db, project, strict=True)`, which returns at once when no sync
worker is serving (quote sync disabled while Books stays configured, or the
tick's settings read failing). The card stayed `quote_sync_state="pending"`
and the routes went on to preview, or have Books email, the estimate as it
was BEFORE the edit. Both now re-check after `ensure_pushed`, mirroring
`_project_ready_to_invoice`: a card with a quote that is still pending gets
409 "This quote has changes still syncing to Zoho", and nothing is read from
or sent through Books, the card does not move and no `quote.emailed` event
is recorded. Unchanged: a card with no quote yet still gets the 404 "This
project has no Zoho quote" (the re-check is gated on `quote_id`, matching
the invoice path, where the no-quote answer comes first); the 503 when a
serving worker's push does not land; every other check. Pinned by
`test_the_quote_email_refuses_a_card_still_pending_when_no_worker_pushes_it`
(GET and POST; fails on the old code) and
`test_a_pending_card_with_no_quote_yet_still_gets_the_no_quote_404` in
`backend/tests/unit/test_aito_flush_routes.py`.

- Golden probes re-recorded: none (35/35 match).
- SURFACE.md sections regenerated: none (`bash tools/gen_surface_aito23.sh` output identical to SURFACE.md).

## T-156 — a failed change pass in the wake lap no longer drops the push windows that fell due during it (user-approved 2026-10-03)

Sanctions commit <this commit> "refactor(loop-15): T-156 wake-lap change pass
gets its own guard (user-approved behavior change)". In `run_sync_loop`
(`backend/app/services/aito_quote_sync.py`) the between-tick wake lap called
`run_change_pass(db)` inside the lap's single try, whose handler logs "Aito
quote sync wake drain failed" and calls
`aito_push_schedule.drop_due_except(time.monotonic(), set())`. A change-pass
failure (a locked database while a watermark commits, a `db.get` raising in
the reconcile-queue drain) therefore deleted every window that closed while
the pass was reading Books: those cards stayed pending with no window, so
nothing woke the loop for them before the next full tick (300 s), and a
route waiting in `flush_and_wait` answered 503 after its timeout. Now the
lap's `run_change_pass` has its own try, the same shape as the tick's: on an
`Exception` it logs "Aito change pass failed" and rolls the session back
(rollback errors suppressed), leaving the windows standing for the next lap.
Cancellation still propagates. Unchanged: the outer handler and its
`drop_due_except`, which now catches only a failure of the serving check or
of `_drain_pending`; the tick body; every other pass. Pinned by
`test_a_failing_wake_lap_change_pass_keeps_the_windows_that_fell_due_during_it`
in `backend/tests/unit/test_aito_push_windows.py` (fails on the old code:
the window is dropped and no drain follows).

- Golden probes re-recorded: none (35/35 match).
- SURFACE.md sections regenerated: none (`bash tools/gen_surface_aito23.sh` output identical to SURFACE.md).

## T-157 — pushes are served between the rows of the payment-link and terminal passes (user-approved 2026-10-03)

Sanctions commit <this commit> "refactor(loop-15): T-157 serve due pushes
inside the Heimdall passes (user-approved behavior change)". `run_sync_loop`
served due pushes only before and after `reconcile_payment_links`, and not at
all around `poll_open_terminal_payments`. Each runs up to MAX_POLLS_PER_TICK
(40) sequential Heimdall calls, so a slow Heimdall held a route waiting in
`flush_and_wait` past FLUSH_TIMEOUT_SECONDS and Print / Create invoice / Send
quote answered 503. Both passes now take an optional `serve_due_pushes`
callback (default `None`: nothing served, as before), the T-102 pattern of
`sweep_invoices`. `run_sync_loop` hands them `_serve_due_pushes` while
serving and `None` otherwise. `_run_pass` calls it before each project of
the reconcile half and each link of the poll half, and the terminal poll
before each row. A served push ends in `reconcile_payment_links(changes_only=True)`
on the task already holding `_pass_lock` (not re-entrant), so the module
records the pass's owning task (`_pass_owner`), and a call from that task
runs its pass nested between two rows instead of deadlocking. If that nested
pass hits a 429 and arms the throttle, the outer pass stops (the reconcile
half returns, the poll half breaks) rather than calling Heimdall again inside
the window. `_serve_due_pushes` logs and rolls back its own failures, and
both passes re-fetch every row by id after it, so a failed served push costs
nothing more. Books calls now interleave with Heimdall calls in a different
order. Unchanged: every caller that passes no callback (the routes, the
drain's own changes-only pass, the tests' direct calls), the per-row failure
handling, the stand-down on `HeimdallUnreachable`. Loop-level test fakes of
the two passes were widened to accept the new keyword. Pinned by
`test_the_pass_serves_due_pushes_before_every_project_and_every_poll`,
`test_a_push_served_mid_pass_reconciles_its_link_nested_instead_of_deadlocking`,
`test_a_failing_served_push_leaves_the_pass_on_a_sound_session` and the two
`test_a_429_hit_by_a_*` tests in `backend/tests/unit/test_aito_payment_links.py`,
plus `test_poll_open_serves_due_pushes_before_every_row` and
`test_poll_open_serves_nothing_by_default` in
`backend/tests/unit/test_aito_terminal_payments.py`, and
`test_the_tick_hands_its_serve_to_the_heimdall_passes_only_while_serving` in
`backend/tests/unit/test_aito_push_windows.py`. All fail on the old code. The
nested test times out with the re-entry branch disabled.

- Golden probes re-recorded: none (35/35 match).
- SURFACE.md sections regenerated: `backend/app/services/aito_terminal_payments.py` signatures. The `poll_open_terminal_payments` line now reads `async def poll_open_terminal_payments(`: the signature gained `serve_due_pushes` and wraps, and the generator keeps the first line only. `reconcile_payment_links` was already wrapped, so its line is unchanged.

## 2026-10-04 — campaign 23, T-173: additive internal export AitoDialogFooter (sanctioned re-baseline, not a behavior change)

Sanctions commit <this commit> "refactor(loop-17): T-173 share the stacked
Aito dialogs' footer". The error line plus secondary/confirm-with-spinner
footer copied into MergeProjectModal, TransferClientModal, TaskTransferModal
and WatchModal moved into the new component
`frontend/src/components/aito/AitoDialogFooter.tsx`. Per-dialog differences are
explicit props: the confirm's label, disabled rule and handler; `onCancel` for
the Cancel button; `secondary` for the slot's replacement (TaskTransfer's Back
step, Watch's Stop watching, which has no Cancel); `errorTitle` for Watch's
`title` on the error line; `status` for TaskTransfer's own left side (the error
plus the saving hint); `confirmSpinner={false}` for the move dialog's Next.
Back and Cancel still share one slot, so the step change keeps the same
<button> and its focus. Pinned before the extraction by
`frontend/src/__tests__/components/AitoDialogFooterPin.test.tsx` (footer
outerHTML in disabled, idle, pending and error states for all four dialogs,
both transfer modes and both steps, saves in flight, watched/unwatched, and the
Back-to-Cancel focus hand-off), byte-identical after. No locale changes.

- SURFACE.md sections regenerated: "Frontend exported symbols" (+1 line, additions only).
- Golden probes re-recorded: none (35/35 match).

## T-098 — a Heimdall answer with a null, oversized or oddly-formed payment id is unreadable (user-approved 2026-10-03)

Sanctions commit <this commit> "refactor(loop-17): T-098 refuse a malformed
Heimdall payment id (user-approved behavior change)". `_to_view` stored
`str(data["id"])` from the unauthenticated response body: a JSON null became
the id "None", an id over 36 characters overflowed the String(36)
`heimdall_id` columns (a commit failure on PostgreSQL after Heimdall had
already acted), and ids with `/`, `..`, spaces or `?#` were stored and reused
in later PATCH/cancel/GET paths. The id must now match `[A-Za-z0-9_-]{1,36}`
(Heimdall's UUIDs and every id the test doubles use). A JSON integer is still
read as its decimal string, which keeps the `heimdall-wire` golden's
`200-id-numeric` case unchanged. Anything else (null, empty, oversized, a
character outside the class, a bool/float/list/object) raises a ValueError
inside `_to_view`'s existing parse guard. That guard already turns a body
missing its `id` into `HeimdallAmbiguous("Heimdall returned an unexpected
payment shape: ...")`, so callers take the path they already take for an
unreadable 2xx answer. A terminal charge or invoice link stays a pending,
unminted reservation with a `sync_error` and is replayed under the same
idempotency key. The link route answers 502 `upstream`. Pinned by
`test_to_view_treats_a_malformed_payment_id_as_an_unreadable_answer` and
`test_create_link_raises_heimdall_ambiguous_on_a_malformed_payment_id`
(`backend/tests/unit/test_heimdall_client.py`), three new
`test_start_leaves_the_reservation_pending_on_an_ambiguous_answer` params
(`202-null-id`, `202-oversized-id`, `202-path-id`,
`backend/tests/unit/test_aito_terminal_payments.py`) and
`test_a_malformed_heimdall_id_leaves_the_link_a_pending_reservation_with_a_sync_error`
(`backend/tests/unit/test_aito_invoice_link_api.py`). All fail on the old
code. Well-formed ids are pinned to flow through verbatim by
`test_to_view_keeps_a_well_formed_payment_id_verbatim` and
`test_to_view_still_reads_an_integer_payment_id_as_its_decimal_string`.

- Golden probes re-recorded: none (35/35 match).
- SURFACE.md lines: none (`_PAYMENT_ID_RE` and `_validate_payment_id` are private).

## T-154 — a PATCH /aito/{id} carrying client_id/client_name is refused with 422 (user-approved 2026-10-03)

Sanctions commit <this commit> "refactor(loop-17): T-154 PATCH no longer
re-points a card at another contact (user-approved behavior change)".
`update_project` wrote `client_id`/`client_name` from the body. That skipped
transfer-client's invoiced-card 409, its client push flag and its
social/contact clearing, so a direct API caller could re-point any card,
invoiced or not. The current UI never sends either key on the PATCH: only
description, shipping, the LTA and the sync retry use it. Ownership travels
through PUT /{id}/transfer-client, and creates through POST /aito/. Both
fields are removed from `AitoProjectUpdate`. The schema inherits
`extra="ignore"`, so a removed field would have been dropped silently and
answered 200. A `mode="before"` model validator therefore refuses a body that
carries either key, null included, with FastAPI's standard 422 ("... cannot
be changed here; use PUT /aito/{id}/transfer-client"). This happens before
the handler runs, so nothing is written and an `expected_version` claim is
not spent. Any other unknown key is still ignored. The route stops writing
the two keys. Its client_id-needs-a-name check now reads the stored row,
which is all it could ever see once the body lost those keys, so a legacy
card stored with an id and no name still refuses every PATCH, as before.
Pinned by `backend/tests/unit/test_aito_update_client_fields.py`: 9 of its
12 tests fail on the old code, and the other 3 pin the unchanged parts
(other client fields still written, other unknown keys still ignored, the
stored-row check). Tests that pinned the old acceptance were changed to
expect the 422, in `test_aito_routes.py`:
`test_update_refuses_to_replace_the_whole_client_snapshot`,
`test_update_refuses_clearing_the_whole_client_snapshot`,
`test_update_refuses_renaming_the_client_without_resending_the_id`,
`test_update_project_refuses_a_client_id_at_the_column_cap` and
`test_project_update_refuses_even_a_client_id_at_the_column_cap`.
`test_update_with_description_omitted_still_writes_the_other_fields` now
writes `client_email` instead of `client_name`. The `AitoProjectUpdate` field
order and schema hash pins in `test_aito_schema_client_contact.py` drop the
two fields, and the new schema equals the old one minus exactly those two
properties.

- Golden probes re-recorded: `aito-pydantic-schemas` (the `client_id` and `client_name` properties of AitoProjectUpdate removed, 26 lines) and `app-openapi-index` (the same two properties of the PATCH body, 2 lines). The other 33 match unchanged.
- SURFACE.md lines: the `AitoProjectUpdate` field list loses `"client_id": "str | None"` and `"client_name": "str | None"` (2 deletions).

## T-158 — a reconcile card edited mid-tick is pushed when its quiet window closes, not at once (user-approved 2026-10-03)

Sanctions commit <this commit> "refactor(loop-18): T-158 mid-tick edit keeps
its quiet window (user-approved behavior change)". In `run_sync_once`
(`backend/app/services/aito_quote_sync.py`) a card selected as a reconcile
(an attention row: 'error', or an unconfirmed status) got neither
`must_be_pending` nor `skip_if_pending` from `_reconcile_one`. An operator
editing it while the tick walked earlier cards (the usual way to fix an
'error' card) made it pending and opened its 10-second window through
`note_edit`, but the tick re-read it as pending and pushed it at once,
ignoring the window and leaving it unspent; every further edit in that
session cost another Books PUT. Now ids not selected as pending get
`skip_if_pending=True`, as `_drain_reconcile_queue` already passes: such a
card is skipped (not counted in `attempted`), stays pending, and its window
wakes the drain that pushes it once the quiet period ends. Unchanged: cards
selected as pending (`must_be_pending`), the T-125 per-card guard and
`finally` re-arm, the T-124 attention-pass guard, and the skip path's waiter
release. Pinned by
`test_a_reconcile_card_edited_mid_tick_is_left_to_its_quiet_window` and
`test_a_reconcile_card_left_to_its_window_is_pushed_once_the_window_closes`
in `backend/tests/unit/test_aito_quote_sync_wake_latency.py` (both fail on
the old code: the edited card is pushed mid-tick). The first also pins that
the skipped card keeps an open window that closes within the quiet period,
so it is not stranded.

- Golden probes re-recorded: none (35/35 match).
- SURFACE.md sections regenerated: none (`bash tools/gen_surface_aito23.sh` output identical to SURFACE.md).
- 2026-10-09 T-193: re-baseline — additive internal export project_suggestions.similar_projects (one similar-project-name scan shared by suggest_projects and suggest_projects_for_filename); no behavior change.
- 2026-10-09 T-198: re-baseline — additive internal exports project_reslice.load_pipeline and project_reslice.prepare_reslice (reslice validation moved out of the route; run_reslice and the route share the pipeline lookup); no behavior change.
- 2026-10-09 T-203: re-baseline — additive internal exports revisionLabel and outdatedParams (components/projects/files/revisionLabel.ts; one helper for the 'ItemName Rn' label and the outdated {source, newer} params); no behavior change.
- 2026-10-09 T-027: re-baseline — snapshots/pdm-i18n.golden re-recorded after deleting three never-referenced projectsPdm keys (createTag, files.title, files.dropHint) from all 15 locales; no rendered string changes.
- 2026-10-09 T-035: surface addition — project_files.upload_basename made public (was _upload_name); aito_project_links._base_name (identical body) deleted and its two callers use project_files.upload_basename; no behavior change.
- 2026-10-09 T-034: surface addition — project_files.clean_item_name/name_key/fresh_item/utcnow made public (were _clean_item_name/_name_key/_fresh_item/_now); callers in project_filing.py and aito_project_links.py and two test references (test_project_filing_move monkeypatch target, test_aito_project_links_api helper call) updated; no behavior change.
- 2026-10-10 T-037: surface addition — project_files.find_item/find_revision (tree lookups used by the routes' _item_out/_revision_out, which keep their 404s); no behavior change.
- 2026-10-10 T-036: surface addition — new module services/http_status_error.py with HttpStatusError(status_code, detail); ProjectFilesError, LinkError and PrintTraceError now subclass it (SURFACE.md base-list lines change; no name removed; PrintTraceError keeps ValueError; str/args/status_code/detail identical, pinned in test_http_status_error.py); no behavior change.
- 2026-10-10 T-044: surface addition — new module frontend/src/components/projects/projectQueries.ts with projectKeys (tree/orders key factories, arrays identical to the inline ['project-tree', id] / ['project-orders', id]) and useProjectTree/useProjectOrders (key + fetcher, caller options spread after); the 7 read sites and the in-scope invalidations use them with their per-site options unchanged; no behavior change.
- 2026-10-10 T-042: surface addition — new modules frontend/src/components/projects/dialogStyles.ts (OVERLAY_CLS, DIALOG_CARD_CLS, RADIO_ROW_CLS: byte-identical to the inline strings; stopDrag: the three identical local copies) and DialogShell.tsx (portal + backdrop-click close + form card, adopted by OrderPickerDialog and ResliceDialog only, Escape stays with the caller; markup pinned in DialogShell.test.tsx); no behavior change.
- 2026-10-10 T-045: surface addition — useInvalidateProjects() in frontend/src/components/projects/projectQueries.ts (plus additive projectKeys.project/projects/projectsSearch/projectTags factories); fires the same fire-and-forget invalidations in the same order as NewProjectModal (['projects'], ['projects-search'], ['project-tags']) and ProjectHeader (['project', id] first, then the three); order pinned in projectQueries.test.tsx; no behavior change.
- 2026-10-10 T-197: surface addition — aito_project_links.revision_added_payload(*, item_name, revision_number, section, item_id, revision_id) -> (label, detail), returning "<item> R<n>" and {section, item_id, revision_id} in that key order; used to build the payload at the upload and import routes (still _record_linked), project_filing.record_revision_added (still inside describe) and the drop fan-out (still _fan_out_revision); the entry dicts fed to record_revision_added (Re-trancher, auto-filing, legacy migration) are inputs, left as they are; no behavior change.
- 2026-10-10 T-201: surface addition — project_tags.unique_clean_names(raw_names, seen=None) -> list[(name, key)]: clean_tag_name, tag_name_key, skip empty names, first spelling per key wins, order kept, optional `seen` mutated with kept keys; split_tag_string, get_or_create_tags (its `seen` still feeds the name_key IN query) and rank_tag_suggestions use it; pinned in test_project_tags_service.py; no behavior change.
- 2026-10-10 T-204: surface addition — new module frontend/src/components/projects/DropShield.tsx with DropShield({ children }): createPortal(<div onDragOver={stopDrag} onDrop={stopDrag}>{children}</div>, document.body), the exact portalled wrapper PrintRevisionFlow, TaskProjectRow (print dialogs) and RevisionBlock (ResliceDialog) built inline; DOM identical, pinned in DropShield.test.tsx; no behavior change.
- 2026-10-10 T-205: surface addition — new module frontend/src/components/projects/files/CollapsibleHeader.tsx with CollapsibleHeader({ open, onToggle, label, count }): the chevron toggle button (aria-expanded, ChevronDown/ChevronRight h-4 w-4, label span, ' ' text node, count span) that SectionBlock and ProjectFilesPanel's OlderFiles built inline; each caller keeps its own h3 (classes differ); DOM identical, pinned in CollapsibleHeader.test.tsx; no behavior change.
- 2026-10-10 T-227: surface addition — project_files.revision_label(item_name, number) -> "<item> R<n>"; used by aito_project_links (_revision_label, revision_added_payload), project_print_trace (lazy import, project_files imports it), routes/project_files status-change label and routes/projects archive labels; zip filename format left alone; pinned in test_project_files_service.py; no behavior change.
- 2026-10-10 T-228: surface modification — project_files.utcnow() removed (introduced by T-034); project_files and project_filing now call utils.local_time.utcnow_naive(), the identical naive-UTC datetime.now(timezone.utc).replace(tzinfo=None); no alias left; naive-UTC stamp pinned in test_project_files_service.py; no behavior change.
- 2026-10-10 T-231: surface addition — project_files._ref made public as revision_ref(revision, item) -> RevisionRef; aito_project_links.orders_for_project now calls it instead of building the identical six-field RevisionRef by hand; pinned in test_aito_project_links_service.py; no behavior change.
- 2026-10-11 T-236: surface addition — project_files._revision_file_path made public as revision_file_path(file_path) -> Path | None; routes/project_files and project_reslice call it instead of reaching into a private name; no alias left; no behavior change.
- 2026-10-11 T-241: surface modification — project_filing.find_item(db, project_id, section, key) renamed find_item_by_key to stop colliding with project_files.find_item(tree, item_id); no alias left; no behavior change.
- 2026-10-11 T-283: user-approved behavior change (carried from c25 T-222, user-approved 2026-10-11) — POST /queue/ with cleanup_library_after_dispatch=true on a project revision file (e.g. a printer-card upload-and-print of P-0042_x.gcode.3mf that auto-filing just moved into its project) now queues (200) with the flag stored false, instead of 400 "Project files are never deleted after printing"; the file stays in the project and is never consumed; auto-filing unchanged; the cross-model variants guard is unchanged; goldens re-recorded: none; SURFACE: unchanged.
- 2026-10-11 T-257: user-approved behavior change (user-approved 2026-10-11) — the Aito task row "New project" now creates and links the project in ONE request (POST /aito/tasks/{id}/project via api.createTaskProject, same name/description/tag_ids/new_tag_names payload) instead of POST /projects/ then PUT /aito/tasks/{id}/project; a failure (e.g. the order deleted meanwhile) leaves no project behind, shows the save-failed toast and keeps the modal open for a retry instead of closing it with the link-failed toast after the project was already committed; NewProjectModal gains an optional create override (the project list page still creates through POST /projects/ and navigates, unchanged); goldens re-recorded: none; SURFACE: unchanged.
- 2026-10-11 T-255: user-approved behavior change (approved 2026-10-11 after verification flagged it) — Move-to-project and the legacy migration copy an external File Manager file only if its resolved path sits under a registered external folder (any registered mount) and open it with O_NOFOLLOW: an external file resolving outside every registered mount, or an external row with no registered folder at all, is now skipped as source_missing (it was copied before); a leaf swapped for a symlink after the check now fails the group as copy_failed; _already_copied leaves out escaping files. Normal scan-admitted external files behave the same. Goldens re-recorded: none. SURFACE: unchanged.
- 2026-10-11 T-263: surface addition — project_revisions.find_revision_bundle (the revision + item + project join, None when missing; shared by project_files.get_revision_bundle and project_print_trace.resolve_print_context) and project_revisions as the new home of revision_label (moved from project_files, which re-exports it, so the def line count is unchanged); no behavior change.
- 2026-10-11 T-270: surface addition — components/projects/projectQueries.useProjectSearch (a picker's debounced project search: q/setQ, debounced, results minus the suggested ids, isFetching; query key projectKeys.projectsSearch(scope, debounced), same options as before) and components/projects/ProjectCodeChip.ProjectOptionLabel (code chip + truncated name), shared by ProjectLinkPicker and MoveToProjectModal; rendered DOM pinned byte-identical; no behavior change.
- 2026-10-11 T-174→T-284: user-approved behavior change (user-approved 2026-10-11) — library upload auto-filing (`_auto_file_upload` in routes/library.py) now checks projects:update against the route's existing RequestActor (a JWT user, or an ApiKeyActor over the key's effective scopes) instead of current_user, which is None for API keys; the check is skipped only when auth is off (actor None). Approved user-visible change: "an API-key upload named P-0042_… from a key without project-management scope will stay in the File Manager instead of being moved into project P-0042, and its response's filed_to_project will be null". Keys with can_manage_projects, JWT users and auth-off uploads file exactly as before (pinned in test_project_auto_filing.py); the revision's user_id still comes from current_user (None for keys, unchanged); route signature and dependencies unchanged. Goldens re-recorded: none. SURFACE: unchanged.
- 2026-10-11 T-176→T-285: user-approved behavior change (user-approved 2026-10-11) — project_filing.move_library_files_to_project no longer aborts mid-loop on an unexpected exception: `_store_group` catches any Exception; a non-409 ProjectFilesError still propagates exactly as before (e.g. 404 target item gone, 413 → the import route's status), an OSError is still `copy_failed`, a 409 still `conflict`, and anything else (e.g. sqlalchemy OperationalError "database is locked") is now a per-group skip with code `error` and the fixed reason "unexpected error while moving the file" (no exception text in the response), logged with logger.exception, the session rolled back, and the loop goes on. Approved user-visible change: "An import that partly fails would return 200 with the failed files listed under `skipped` instead of a bare 500, and linked orders would get the revision events for the groups that went through." Consequences: `error` joins `_RETRYABLE_SKIPS`, so the legacy migration of a project hitting such an error still leaves `legacy_migrated_at` unset (as before), but now moves the later groups, records their revision events, and its status `failures[].error` reads "N file(s) could not be moved (error: unexpected error while moving the file); run it again" instead of the raw exception text; auto-filing of an upload still returns no filed_to_project (the error is now a logged skip instead of the outer warning). The frontend MoveToProjectModal shows the backend reason for an unknown code, so no i18n key was added. Goldens re-recorded: pdm-rules only (RETRYABLE_SKIPS gains "error"); pdm-openapi unchanged (SkippedFileOut.code is a plain str). SURFACE: unchanged.
- 2026-10-11 T-177→T-286: user-approved behavior change (user-approved 2026-10-11) — `POST /api/v1/aito/tasks/{task_id}/files` (drop_task_files) no longer answers a bare error once a group is stored: `drop_files_on_task` still stops at the first failing group, but when at least one group was already stored it returns the normal `DropFilesResponse` (201, as for any drop) with the stored `results` plus a new `errors: list[DropFilesError]` entry (`filenames` = the failed group's files and those of the groups after it, which were never tried; `status_code`/`detail` = the failure's, for a ProjectFilesError, LinkError or HTTPException such as the 413 oversize upload; any other exception, e.g. an OSError disk full, is logged with logger.exception and reported as 500 "unexpected error while storing the files", no exception text). The route broadcasts aito_changed to the dropping order in a `finally` whenever groups were stored, whatever the exception type (a cancellation past a stored group carries `stored_count` and still broadcasts). If NO group was stored the error still propagates exactly as before (same status/detail, no broadcast). `errors` is left out of the JSON when empty (pydantic `exclude_if`), so a fully successful drop's answer is byte-identical (pdm-http unchanged). Frontend: `DropFilesResponse.errors?` in api/client.ts; useUploadToTask shows a warning toast `projectsPdm.aito.droppedPartial_one/_other` ("1 file added to P-0007; not added: b.3mf (detail)") instead of the success toast when `errors` lists files; translated in all 15 locales. Approved user-visible change: "A partly failed drop would return the stored files plus the failed group's error instead of only an error status, and the frontend toast would change accordingly." Consequences: (1) the partial answer keeps the route's 201 status (the drop route's success status), not 200; (2) besides ProjectFilesError, a LinkError after a stored group (the project deleted mid-drop, "Task is not linked to a project" 409, previously a 409) and an HTTPException (413 oversize second file, previously a 413) and any other exception (previously a 500) also become the partial 201; (3) if the project vanishes right after the LAST group was stored (previously a 409 with everything stored), the answer is now 201 with an `errors` entry whose `filenames` is empty, and the frontend shows the plain success toast for it; (4) an unexpected exception after a stored group is now logged by the service ("File drop on order N failed after storing some files") instead of by the server's 500 handler. Goldens re-recorded: pdm-openapi (DropFilesError schema, DropFilesResponse.errors), pdm-pydantic-schemas (same two), pdm-i18n (droppedPartial_one/_other in every locale). SURFACE: regenerated, additive only (class DropFilesError, DropFilesResponse.errors, projectsPdm.aito.droppedPartial).
- 2026-10-11 T-181→T-288: user-approved behavior change (user-approved 2026-10-11) — project_reslice._drop_intermediate now tries the hard delete up to 3 times, pausing `_DROP_RETRY_DELAYS` = (0.2 s, 0.5 s) between attempts (asyncio.sleep; tests patch it); each failed attempt rolls the session back, a non-final failure logs a warning "… failed (attempt N of 3), retrying", the last one still logs the old logger.exception message and never raises. New `project_reslice.sweep_orphan_intermediates(db) -> int`, run once from the FastAPI lifespan right after the batch-status backfill (after init_db; wrapped in try/except, a failure only logs "[RESLICE] Startup intermediate sweep failed"), hard-deletes (library_trash_service.hard_delete_many: row, bytes, thumbnail) every live loose library row (revision_id NULL, deleted_at NULL) whose `file_metadata.sliced_from_library_file_id` resolves to a LibraryFile with a revision_id, and that nothing uses (project_files.used_file_ids: queue items, archives, batches, queue variants, pipeline runs); each deleted row is logged at WARNING with its id and filename. Approved user-visible change: "Leftover sliced intermediates that today stay visible in the File Manager after a failed cleanup would disappear (immediately on retry, or at the next startup)." Consequences: (1) a re-slice job whose intermediate delete keeps failing now finishes up to ~0.7 s later (the pauses), result unchanged; (2) the sweep cannot tell a Re-trancher leftover from a loose slice of a project revision file made by hand through `POST /api/v1/library/files/{id}/slice` with a revision file's id (both carry only `sliced_from_library_file_id`); such a slice, if nothing uses it, is hard-deleted at the next startup too. The UI cannot make one (revision files are hidden from the File Manager, the only place that opens SliceModal on a library file), but an API caller can; (3) for precision the sweep skips trashed rows and any row in use, which keeps pipeline-run outputs of revision files (PipelineRun.sliced_library_file_id) and queued/printed slices. backend/app/main.py (shared file, outside the scope globs) gained the 9-line lifespan hook. Goldens re-recorded: none (11/11 match). SURFACE: regenerated, additive only (`async def sweep_orphan_intermediates(db: AsyncSession)`).
- 2026-10-11 T-184→T-289: user-approved behavior change (user-approved 2026-10-11) — the shared `content_length_capped_route` class in routes/project_files.py (it guards `POST /api/v1/projects/items/{item_id}/revisions`, `POST /api/v1/projects/revisions/{revision_id}/files` via upload_router, and `POST /api/v1/aito/tasks/{task_id}/files` via aito_project_links.drop_router; confirmed by grep, no other user) now, when Content-Length is missing or not all digits, hands the route a `Request(scope, receive)` whose receive counts the `http.request` body bytes and raises HTTPException(413, "Upload exceeds the maximum size of {cap} bytes") — the same status and detail as the declared-length path, now built by the shared `_upload_too_large(cap)` — as soon as the running total passes `library_max_upload_bytes + _UPLOAD_OVERHEAD_BYTES`; a body of exactly cap + overhead still passes. FastAPI re-raises an HTTPException from `request.form()` unchanged (fastapi/routing.py `except HTTPException: raise`), so the client gets the 413 JSON answer, not the parser's 400 (tested through httpx ASGITransport with an async-generator body, which sends no Content-Length). A body with a numeric Content-Length takes the old path unchanged. Approved user-visible change: "A client that uploads with chunked transfer encoding (no Content-Length) and sends a multipart body larger than library_max_upload_bytes in total, for example several files that are each under the cap, will get a 413 instead of succeeding, matching what a request with Content-Length already gets." Consequences: (1) a chunked over-limit body sent to a route that would have refused it after parsing (unknown item/revision/task 404, unlinked task 409, missing form field 422) now gets the 413 instead, because the body is read before the endpoint runs — the same order a declared Content-Length already gets; (2) a chunked body with one file over the cap, which already got the per-file 413 after the whole body was spooled, now gets the identical 413 while reading; (3) the parts spooled before the refusal are not closed by Starlette explicitly (it closes them only on a MultiPartException) and go with their SpooledTemporaryFile objects when the request's frames are released, at most cap + overhead + one chunk of data. Goldens re-recorded: none (11/11 match). SURFACE: unchanged (private helpers only).
- 2026-10-11 T-185→T-290: user-approved behavior change (user-approved 2026-10-11) — `project_files._commit_through_cancel` no longer waits without limit for its commit task once a CancelledError arrives: it waits with `asyncio.wait({task}, timeout=remaining)` up to the new module constant `_COMMIT_CANCEL_WAIT_S` = 30.0 s counted from the first cancellation (later cancellations inside the bound are still swallowed, as before); a commit that finishes inside the bound is handled exactly as before (landed → may_have_landed, failed → undo, commit task cancelled at shutdown → may_have_landed). A commit still pending at the bound is left running, `outcome.may_have_landed` is set (so `_CommitGuard` skips its rollback and filesystem undo: written/copied files stay, trashed files stay trashed, a renamed folder keeps its new name), `logger.error("Commit of <op> still pending 30.0 s after its request was cancelled; giving up on it and leaving its files in place")` is logged and the original CancelledError re-raised, which releases `_item_lock(item.id)`. `<op>` is a new label carried by `_CommitOutcome(label)` and passed as `label=` through `_CommitGuard`/`_TrashGuard`: "new revision of item N", "files added to revision N", "removal of file N", "deletion of revision N", "deletion of item N", "rename of item N", "fork of revision N". Approved user-visible change: "a cancelled upload, rename, delete or fork whose commit stalls past the bound now returns (and frees the item) instead of hanging, leaving its files in place as 'may have landed'". Consequences: (1) the bound covers every `_CommitGuard` user, i.e. also adding files to a revision and removing one file from a revision (the same upload/delete family); (2) the given-up commit task keeps running on the request's session, so get_db's teardown (`shield(session.rollback())`, `shield(session.close())`, both errors suppressed) then runs while that commit may still be in flight: on a truly stalled connection the request task itself can still wait there, but after the item lock was released; (3) if the given-up commit later fails, its files stay on disk with no rows (the 'may have landed' safe side), and asyncio may log "Task exception was never retrieved" for it when the task is collected; (4) a commit on a slow but alive connection that would have landed after 30 s still lands, but the request is gone by then. Goldens re-recorded: none (11/11 match; pdm-rules does not read the new constant). SURFACE: unchanged (private names only).
- 2026-10-11 T-186→T-291: user-approved behavior change (user-approved 2026-10-11) — new `project_revisions.revision_lock_statement(ids, *, share=False)` (`SELECT project_revisions.id … WHERE id IN (…) ORDER BY id FOR UPDATE`, `FOR SHARE` with `share`; id order so two lockers never deadlock) and `project_revisions.lock_revision_rows(db, ids, *, share=False) -> set[int] | None`, which on a PostgreSQL bind (`db.get_bind().dialect.name == "postgresql"`, the same gate as `queue_position.lock_queue_positions`) runs that statement and returns the ids still there, and on SQLite runs nothing and returns None. Gated rather than unconditional: the SQLite dialect does drop the clause (pinned by a compiled-SQL test), but an unconditional call would still add a plain SELECT (with its autoflush) to every SQLite delete/delivery/queue transaction; gated, SQLite's statements are exactly as before. Call sites: `project_files._delete_revision_locked` locks its revision FOR UPDATE and `_delete_item_locked` all the item's revisions FOR UPDATE, both before the usage pre-check; `aito_project_links.set_deliveries` locks the added revisions FOR SHARE after its flush, right before the existing "Revisions deleted meanwhile" re-check; `project_print_trace.resolve_print_context` (POST /api/v1/queue/, single file and cross-model variants) locks the library file's revision FOR SHARE before reading it, and on PostgreSQL, when the revision is gone after the wait, raises PrintTraceError(409, "This file's project revision was deleted meanwhile") (new constant `REVISION_DELETED`). Approved user-visible change: "on PostgreSQL deployments, queueing a print or recording a delivery at the same moment as deleting that revision now ends in a 409 on one side instead of silently dropping the queue item or leaving an orphan delivery". The PostgreSQL race itself is NOT tested (no PostgreSQL in the test environment): its semantics are pinned by compiled-SQL tests only, plus spies asserting where each lock is taken (before the delete pre-checks, after the delivery flush, in the queue path for revision files only) and the new 409 branch. Consequences: (1) new 409 detail on POST /api/v1/queue/ (PostgreSQL only): "This file's project revision was deleted meanwhile", when the delete commits first — without it that ordering ended in a foreign-key IntegrityError on the queue insert; (2) on PostgreSQL a revision/item delete now waits for any in-flight transaction that queued a print from, or recorded a delivery of, one of its revisions (and vice versa), and the derived_from/forked_from clearing UPDATE may also wait on share locks held on other revisions; (3) a reprint from an archive (`archive_id`) and `POST /api/v1/library/files/add-to-queue` (API only, no UI caller) take no lock: the reprint queues the archive, not a revision file, and the library route is upstream code left out of this change (see LEADS). SQLite: no statement added, existing suites unchanged. Goldens re-recorded: none (11/11 match). SURFACE: regenerated, additive only (`async def lock_revision_rows(`, `def revision_lock_statement(…)`).
- 2026-10-11 T-213→T-292: user-approved behavior change (user-approved 2026-10-11) — `project_files._remove_file_locked` (DELETE of one file from a revision) now re-checks the revision after its row delete is flushed (the SQLite write lock is held then): new private `_require_files_still_editable(db, revision_id, file_ids)` re-reads `project_revisions.status` with a column select and matches the usage columns and the revision's deliveries by the remembered ids of ALL the revision's files (the removed one and the others, the same scope as the pre-check `_require_editable_files`), reusing `_deleted_revision_is_used`; a hit raises ProjectFilesError(409) inside the `_TrashGuard`, so the row delete is rolled back and nothing is moved to `_trash`. The two 409 texts are unchanged and now shared through private constants `_NOT_EDITABLE` ("Only an in-progress revision can change its files") and `_USED_NOT_EDITABLE` ("This revision was printed or delivered; make a new revision instead"). The removal also takes the PostgreSQL FOR UPDATE revision lock (`project_revisions.lock_revision_rows(db, [revision.id])`) first, before the pre-check, as `_delete_revision_locked` / `_delete_item_locked` do (SQLite: no statement). Approved user-visible change: "removing a file that was queued, delivered or validated by someone else during the request now returns 409 instead of succeeding". Consequences: (1) the re-check has the pre-check's scope, so a print/queue/delivery of ANOTHER file of the same revision, or a status change to 'obsolete' (any non-'wip' status), landing during the request also refuses the removal with the same 409 texts; (2) on PostgreSQL a file removal now waits for an in-flight queue/delivery transaction holding its FOR SHARE lock on the revision (and those wait for the removal); a PATCH of the revision's status also waits on the row lock. No new user-facing string. Goldens re-recorded: none (11/11 match). SURFACE: unchanged (private names only).
- 2026-10-11 T-214→T-293: user-approved behavior change (user-approved 2026-10-11) — `aito_project_links.set_deliveries` and `aito_project_links.link_task` now re-check the task after their flush (the SQLite write lock is held then): new private `_require_live_task(db, task_id)` re-selects the task joined to its order with `AitoProject.status != "deleted"` (the predicate the route's `_task()` read and the board use for a trashed or merged-away card) and raises LinkError(404, "Task not found") — the text the routes already answer for a missing task — so `_link_errors` rolls the session back. In `link_task` the check runs after the existing "Project not found" re-check; in `set_deliveries` right after the flush, before the "Revisions deleted meanwhile" re-check. When the task ROW was deleted, `link_task`'s flush (the UPDATE of `aito_tasks.linked_project_id`) matches 0 rows and SQLAlchemy raises StaleDataError before any re-check can run, so that one flush now converts StaleDataError into the same LinkError(404, "Task not found"). Approved user-visible change: "a link or delivery edit that races a task delete or a card merge/trash now returns 404 and stores nothing, instead of storing an orphaned or lost row". Consequences: (1) PUT /api/v1/aito/tasks/{id}/project racing a task DELETE used to answer 500 (the StaleDataError, nothing stored), not an orphan; it now answers 404 "Task not found"; (2) POST /api/v1/aito/tasks/{id}/project (create a project and link it) goes through `link_task`, so when it races a task delete or card trash it now answers 404 and the project it was creating is rolled back with the link (before: 500 for a deleted task, 201 with the link on the trashed card for a trashed one); (3) a deliveries edit that only REMOVES revisions is refused the same way (before: 404 after commit for a deleted task, 200 for a trashed card); (4) a task moved to another live order meanwhile is still accepted (only gone/trashed is refused). No new user-facing string. Goldens re-recorded: none (11/11 match). SURFACE: unchanged (private names only).
- 2026-10-11 T-215→T-294: user-approved behavior change (user-approved 2026-10-11) — POST /api/v1/aito/{project_id}/merge (`routes/aito.merge_project`) now, in the same transaction and right after copying the deliveries, calls the new `project_print_trace.move_task_print_trace(db, copy_by_source)`, which re-points `PrintQueueItem.aito_task_id` and `PrintArchive.aito_task_id` from each source task to its copy (one `UPDATE … SET aito_task_id = CASE …` per table, a no-op for an empty mapping). Chosen variant: re-pointing (not a merge mapping in `task_print_counts`), and re-pointing ALL the source task's queue items — pending/printing and finished (completed/failed/cancelled/skipped) alike — and ALL its archives, soft-deleted ones included: a finished queue item and the archive it produced keep naming the same task, the queue history and the archive list agree, and nothing has to know which statuses `task_print_counts` counts. Approved user-visible change: "after a merge the target card's tasks show the source tasks' printed and queued counts, and queued prints finish against the merged card instead of the trashed one" (the scheduler stamps `archive.aito_task_id = item.aito_task_id`, which now names the copy). Consequences: (1) the trashed source card's tasks now show printed=0 / rejected=0 / queued=0, and restoring the source from the trash no longer brings its print counts back (its tasks, link and delivery rows are still kept: the route docstring's "Copies, never moves: the source keeps its rows" stays true for those rows but no longer for its prints; the docstring is unchanged because it is part of the pdm-openapi golden); (2) the re-pointed archives' `aito_task_id` / `order_id` in GET /api/v1/projects/{id}/archives (and `aito_task_id` in the queue API responses) now name the copy task and the target card; (3) a reprint of such an archive is now accepted with the copy's task id and refused (400, the existing "This Aito task can't be used for this file") with the source task's id — the reverse of before; (4) the `print.queued_from_revision` events already recorded stay on the source card's timeline (events are history, not re-pointed). Not changed: what merge_project returns, its events, the deliveries copy. Goldens re-recorded: none (11/11 match; no golden scenario merges a card with prints). SURFACE: regenerated, additive only (`async def move_task_print_trace(db: AsyncSession, copy_by_source: Mapping[int, int])`).
- 2026-10-12 T-216→T-295: user-approved behavior change (user-approved 2026-10-11) — a project with no `storage_dir` (created before phase 1) gets its folder name fixed once instead of from whichever title the first committed upload saw. (1) `run_migrations` (backend/app/core/database.py) now calls the new private `_migrate_project_storage_dirs(conn)` right after `_migrate_project_codes`: every `projects` row with `storage_dir IS NULL OR storage_dir = ''` gets `storage_dir_name(code or "P-{id}", name)`; rows with a name keep it, so a rerun changes nothing (no `# Migration:` comment, pdm-migrations-index unchanged). (2) `project_files` gained the private `_claim_storage_dir(db, project)`, awaited right before each place that builds a project path (`_add_revision_locked`, `add_files_to_revision`, `_remove_file_locked`, `_delete_revision_locked`, `_rename_item_locked`, `_delete_item_locked`, `_fork_revision_locked`): when `project.storage_dir` is empty it runs `UPDATE projects SET storage_dir = :name WHERE id = :id AND (storage_dir IS NULL OR storage_dir = '')` via the session (autoflush off), re-reads the stored value and adopts it (`set_committed_value`), so a second upload that saw another title writes into the first one's folder. A project that has a name runs no statement (non-NULL path byte-identical); a row deleted meanwhile reads back nothing and falls through to `ensure_project_dir` as before. Approved user-visible change: "a pre-phase-1 project's folder name is fixed once (at migration or first claim) rather than from the title at the moment of the first committed upload". Consequences: (1) an empty-string `storage_dir` is treated like NULL by the migration and the claim, matching the `not project.storage_dir` test `ensure_project_dir` already used; (2) on the claim path only (a row that escaped the migration, e.g. a database restored while running), the conditional UPDATE opens the SQLite write transaction before the files are streamed, so the write lock is held through the streaming up to the commit instead of only for the final flush; (3) rename, delete, fork and file removal on such a project claim the name too (they already persisted it through `ensure_project_dir` and their commit, unguarded); (4) when the operation fails and rolls back, the claim rolls back with it, as the unguarded assignment did. No new user-facing string. Goldens re-recorded: none (11/11 match). SURFACE: unchanged (private names only).
- 2026-10-12 T-219→T-303: user-approved behavior change (user-approved 2026-10-11) — library by-id reads of project revision files now go through the projects-tree symlink guard that `/projects/revisions/{id}/download` uses (c25 T-207). New private `library._guarded_read_path(file)`: a row with `revision_id` set resolves through `project_files.revision_file_path` (already public; imported lazily, project_files imports library at module level) and raises HTTPException(404, "File not found") — the detail `download_revision` answers — when the guard refuses it; any other row resolves with `to_absolute_path` as before. `download_file` (GET /library/files/{id}/download), `download_library_file_for_slicer` (GET /library/files/{id}/dl/{token}/{filename}) and `get_gcode` (GET /library/files/{id}/gcode) call it in place of `to_absolute_path`; the "File not found on disk" check after it is unchanged. The scheduler's single read site for a queue item's library file (`PrintScheduler._start_print`, library-file branch, before `ArchiveService.archive_print`) applies the same guard: a refused revision file raises FileNotFoundError inside the existing try, so the item fails exactly as a missing file does today (archive_print's copy raises → status "failed", error_message "Failed to create archive from library file", completed_at, rollback, power-off check; nothing uploaded). Approved user-visible change: "A project revision file that has been replaced by a symlink in the projects tree will return 404 from /library/files/{id}/download, the slicer /dl/ link and /gcode instead of serving the symlink target." Consequences: (1) the guard also refuses a revision file whose resolved path leaves the projects root or that is reached through a symlinked folder below the root (the guard's existing rules; the projects root itself may still be a symlink), not only a leaf symlink; (2) the refused case answers detail "File not found", while a revision file that is simply missing keeps "File not found on disk"; (3) on the queue a symlinked revision file now fails the job with "Failed to create archive from library file" instead of archiving and printing the symlink target; (4) for a revision row, the guard calls `projects_root()`, which creates `{data}/projects` if missing (it exists whenever revision files do). Not changed: non-revision library files (a File Manager file that is a symlink is still served), headers and Range behavior of a normal revision file, the scheduler's filament-requirements read (`PrintScheduler._get_filament_requirements`, metadata only, not sent to the printer). Test fixture follow-up: `test_print_trace_columns.py`'s scheduler cases stored their revision file under `{base}/library`, outside any projects tree; their `_dispatch` now points `project_storage.projects_root` at that folder (no assertion changed), since the guard refuses a revision file outside the tree (consequence 1). Goldens re-recorded: none (11/11 match). SURFACE: unchanged (private names only).
- 2026-10-12 T-256: user-approved behavior change (user-approved 2026-10-11) — `POST /api/v1/projects/items/{item_id}/revisions` (routes/project_files.upload_revision) now declares `note: str | None = Form(default=None, max_length=REVISION_NOTE_MAX_LENGTH)`; the new module constant `schemas/project_files.REVISION_NOTE_MAX_LENGTH = 5000` is also what `ProjectRevisionUpdate.note` (PATCH /projects/revisions/{id}) now uses, so both paths share one limit. Approved user-visible change: "An upload whose note is longer than 5000 characters gets a 422 instead of being stored. Today Starlette's 1 MB per-part form limit is the only bound." The 422 is FastAPI's standard validation body (`loc` ["body", "note"], type string_too_long) and is raised before the route body runs, so no revision row, no file on disk, no event. Consequences: like PATCH, the limit applies to the raw note before the service strips whitespace (a note of 5000 visible characters plus padding is refused); none otherwise. Other note paths checked: POST /projects/revisions/{id}/files, the Aito drop (note=None) and the File Manager import take no note. Goldens re-recorded: pdm-openapi only (`"maxLength": 5000` on the `note` property of `Body_upload_revision_api_v1_projects_items__item_id__revisions_post`). SURFACE: unchanged (module constants are not listed). Pinned in test_project_files_api.py::test_upload_note_capped_at_the_patch_limit.
- 2026-10-12 T-259: user-approved behavior change (user-approved 2026-10-11) — `POST /api/v1/aito/tasks/{task_id}/files` (aito_project_links.drop_files_on_task) now checks, right after grouping the uploads and before the store loop (after require_printable_uploads, which still refuses first), whether any group's item-name key is empty (a file name like `???.3mf` or `...3mf` that sanitises to nothing) and raises `LinkError(400, "Item name must not be blank; refused: " + the offending file names, comma-separated, in upload order)` — the old create_item detail plus the `; refused: <names>` tail require_printable_uploads uses. Approved user-visible change: "A drop that mixes valid files with a file whose name sanitises to nothing is refused whole with a 400, instead of storing the valid groups that came first and then failing." Consequences: (1) since T-286 the previous outcome of such a mixed drop (blank file after a valid group) was a partial 201 with the valid groups stored, one `errors` entry `{filenames: [the blank file and every file after it], status_code: 400, detail: "Item name must not be blank"}`, a project.files_dropped event and aito_changed broadcasts; it is now a whole 400 with no item, revision, file, event or broadcast; (2) a drop whose blank-named file is the first or only group was already a 400 with nothing stored, but its detail changes from "Item name must not be blank" to "Item name must not be blank; refused: ???.3mf"; (3) a blank-named file placed BEFORE any valid group was a 400 too (same detail change). The frontend (components/projects/aito/dropFiles.ts useUploadToTask) toasts the error message of a failed request, i.e. the backend detail, as an error toast; no frontend change. Goldens re-recorded: none (11/11 match). SURFACE: unchanged. Pinned in test_aito_project_links_api.py::test_drop_with_a_blank_sanitised_name_is_refused_whole and test_aito_project_links_service.py::test_drop_with_a_blank_sanitised_name_raises_before_storing.
- 2026-10-12 T-261: additive surface name `def revision_folder_name(number: int)` in services/project_storage.py (the non-creating `R{number}` folder name that `revision_dir` and `project_files._delete_revision_locked` now share), no behavior change. Goldens re-recorded: none (11/11 match).
- 2026-10-12 T-264: additive surface name `def split_gcode_3mf(name: str)` in services/project_storage.py (the case-insensitive `.gcode.3mf` suffix split that `_split_extension`, `project_filing.item_name_for_filename` and `project_reslice.output_filename` now share), no behavior change; outputs of the three callers pinned for 25 inputs in test_printable_suffix_split.py before and after. Goldens re-recorded: none (11/11 match).
- 2026-10-12 T-265: additive surface name `revisionNumberLabel(number: number): string` in frontend/src/components/projects/files/revisionLabel.ts (the bare `R{n}` label that revisionLabel, outdatedParams, DeliveriesPicker, ItemRow and RevisionBlock now share), no behavior change; DOM text byte-identical (existing component tests unchanged). Goldens re-recorded: none (11/11 match).
- 2026-10-12 T-266: additive surface name `sectionRevisionLabel(t: TFunction, section: ProjectSection, itemName: string, number: number): string` in frontend/src/components/projects/files/revisionLabel.ts (the `{section} › {item} R{n}` derived-from label that ItemRow and ProjectFilesPanel now share; same U+203A separator and spaces), no behavior change; existing ItemRow/ProjectFilesPanel tests unchanged. Goldens re-recorded: none (11/11 match).
