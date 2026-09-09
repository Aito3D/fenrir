# PLAN (schema v2)

## T-001
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: trackingOf() fallback for a payload without the tracking block is never exercised
files: frontend/src/components/stats/PipelineWidget.tsx
evidence: frontend/src/components/stats/PipelineWidget.tsx:148 · Source: `function trackingOf(d: AitoStats): AitoStats['tracking'] { return d.tracking ?? { views: 0, cards_viewed: 0, cards_with_link: 0 }; }` — the comment above it says this exists specifically so 'a deployed server behind this bundle' (old backend, no `tracking` field) degrades instead of throwing. `frontend/src/__tests__/components/stats/PipelineWidget.test.tsx`'s only fixtures (`stats`, `empty`) both always set `tracking: {...}`; grepping the test file for a payload omitting `tracking` finds nothing. `vitest run src/__tests__/components/stats/PipelineWidget.test.tsx --coverage --coverage.include='src/components/stats/PipelineWidget.tsx'` reports 100% lines but only 82.75% branch, flagging line 148 as partially covered (the `??` right-hand branch never taken). This is also the exact behavior added by commit b1f67ca0c ('fix(stats): pipeline widget tolerates a payload without the tracking block') — the regression it fixed has no test guarding it, so a refactor could silently reintroduce the crash-on-old-backend bug. · fix: in frontend/src/__tests__/components/stats/PipelineWidget.test.tsx, add a case that serves a stats payload with the `tracking` key omitted entirely (cast or `delete` it) and assert the widget renders normally (e.g. the tracking section shows zeros or the page doesn't throw) instead of erroring.
fingerprint: edde918c3120e7aa
source: audit-tests

## T-002
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: Copy-link and Regenerate-link onError toasts are untested
files: frontend/src/components/aito/TrackingLinkControl.tsx
evidence: frontend/src/components/aito/TrackingLinkControl.tsx:47 · Source: both mutations have an `onError: () => showToast(t('common.errorLoading'), 'error')` handler (lines 47 and 56). `frontend/src/__tests__/components/AitoTrackingLinkControl.test.tsx` has exactly 3 tests — 'copies the link', 'is disabled...', 'regenerates on a completed hold and toasts' — all happy-path; grepping that file for `500`, `error`, `HttpResponse.error` finds nothing. `vitest run ... --coverage --coverage.include='src/components/aito/TrackingLinkControl.tsx'` reports 85.18% lines / 72.72% branch with 'Uncovered Line #s 47,56'. Regenerate exists specifically to 'kill a leaked link' (component docstring); if that POST fails, the operator gets no test-verified feedback that the old (possibly leaked) link is still live — a silent failure on a security-relevant control. · fix: in frontend/src/__tests__/components/AitoTrackingLinkControl.test.tsx, add two cases: mock the tracking-link GET to fail (msw 500) and assert the error toast (t('common.errorLoading')) appears on Copy click; mock the tracking-token POST to fail and assert the same toast appears after completing the hold, and that no success toast/regenerated state is shown.
fingerprint: 8d660bd41beef68d
source: audit-tests

## T-003
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: get_tracking() writes an unthrottled DB row per unauthenticated request
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1009 · backend/app/api/routes/aito.py:1009 `await tracking_service.log_view(db, project_id, now)` -> backend/app/services/aito_tracking.py:143 `db.add(AitoTrackingView(project_id=project_id, viewed_at=now))` followed by `await db.commit()`. The route has no rate limit, no per-viewer cooldown and no dedup window; the only bound is `purge_tracking_views(older_than=timedelta(days=400))`. Every successful open of a link that is deliberately distributed by SMS and by the Zoho quote notes (`NOTES_PREFIX = "Suivez votre commande : "`) therefore costs one INSERT + COMMIT against the single-writer SQLite file, with no authentication in front of it. · fix: throttle the view log: keep at most one AitoTrackingView per (project_id, coarse time bucket) — check for a recent row before inserting — and add a per-token/per-IP sliding-window limit on the route itself, reusing the `_check_ai_rate_limit` primitive already in this module · user-visible change: the Stats pipeline widget's "Suivi client" views count will report fewer views for the same client behaviour (repeat opens and link-scanner fetches stop counting), and a client refreshing the page rapidly can start receiving 429s instead of the page.
fingerprint: 7622a16dca2d8592
source: audit-security
reason: user-approved behavior change — NARROWED 2026-09-06: dedup window on log_view only (skip a repeat insert for the same project within a short window); NO per-IP rate limit, NO 429 path

## T-004
priority: P3
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: get_tracking_link() is a state-changing GET that returns a bearer credential with no Cache-Control
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:2872 · @router.get("/{project_id}/tracking-link", ...) whose own docstring says "An UPDATE, not a read: the first call mints the token", and whose body is `url = await build_tracking_url(db, project)` then `await db.commit()`. The 200 response body carries the tracking URL — the token in it is the sole credential for the public page — and unlike get_tracking() this handler sets no `Cache-Control: no-store`, so the response is heuristically cacheable by the browser disk cache and any intermediary. · fix: make the minting endpoint a POST (leave a read-only GET that returns the existing token without minting, if the panel still needs one) and set `Cache-Control: no-store` on whichever handler returns the URL; update `getAitoTrackingLink` in frontend/src/api/client.ts to match · user-visible change: any caller or bookmark that currently issues GET /api/v1/aito/{id}/tracking-link stops working and must switch to POST; a card that has never had a link generated will no longer get a token minted as a side effect of a read.
fingerprint: 43204df4d91d3526
source: audit-security
reason: user-approved behavior change — NARROWED 2026-09-06: add Cache-Control: no-store to the tracking-link response ONLY; the endpoint stays a GET with its mint-on-first-read side effect

## T-006
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: PipelineWidget render path still dereferences data.tracking unguarded
files: frontend/src/components/stats/PipelineWidget.tsx
evidence: frontend/src/components/stats/PipelineWidget.tsx:125 · The render block reads the block directly — `<CountTile label={t('stats.pipelineTrackingViews')} value={data.tracking.views} />` (and `.cards_viewed`, `.cards_with_link` on the two lines below) — while the sibling guard added in b1f67ca0c only covers `isEmpty`: `trackingOf(d).views + trackingOf(d).cards_viewed + ...`, whose own docstring says "the widget must degrade to an empty block, never throw on an older payload". `tracking` is declared non-optional in `AitoStats` (api/client.ts:4051) so tsc cannot see the mismatch. Against a backend that predates the tracking block (a rolled-back container, or a Vite dev/worktree session proxying to another checkout's :8000 — the exact case b1f67ca0c's message names), `isEmpty` now correctly returns false as soon as the board has one card, the widget renders, and line 125 throws `TypeError: Cannot read properties of undefined (reading 'views')`. The only ErrorBoundary is at the app root (App.tsx:297), so the user loses the entire SPA, not just this widget. · fix: route lines 125-127 through the existing `trackingOf(data)` helper (hoist it to one `const tracking = trackingOf(data)` above the return), and mark `tracking` optional in the `AitoStats` interface so the compiler enforces it
fingerprint: 51776239af95db83
source: audit-robustness

## T-007
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: ensure_tracking_token check-then-act lets a concurrent mint silently replace an already-handed-out link
files: backend/app/services/aito_tracking.py
evidence: backend/app/services/aito_tracking.py:50 · `if not project.tracking_token: project.tracking_token = mint_token(); await db.flush()` — the test reads the attribute off an ORM instance loaded earlier in the request, and the write is an unconditional UPDATE with no guard on the stored value. Two mint paths exist: `GET /{id}/tracking-link` (routes/aito.py:2881) and `POST /{id}/pickup-message` (routes/aito.py:2945), and the latter loads the project at line 2931 but only mints after the OpenRouter round trip (up to openrouter.TIMEOUT_S = 8 s), so its view of `tracking_token` is seconds stale. Interleaving: operator A opens the SMS modal for a card with no token; while the LLM call is in flight operator B (or a second tab) hits Copy, minting tokenA and committing it; A's request then still sees `tracking_token is None`, mints tokenB and commits over it. The link B already pasted into a WhatsApp message now resolves to `compute_tracking` returning None and the client sees "Ce lien de suivi n'est plus valide", with nothing in the UI or timeline saying the link was replaced. · fix: make the mint conditional and atomic — `UPDATE aito_projects SET tracking_token = :new WHERE id = :id AND tracking_token IS NULL`, then re-read the row's token and return that (the loser of the race returns the winner's token)
fingerprint: 3bc8b539d588dafd
source: audit-robustness

## T-008
priority: P2
status: WONTFIX-AUTO
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: get_tracking performs an unthrottled DB write on a fully public endpoint
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1009 · `await tracking_service.log_view(db, project_id, now)` — which is `db.add(AitoTrackingView(...)); await db.commit()` (aito_tracking.py:143-144) — runs on every 200 of a route the middleware exempts from auth (`"/api/v1/aito/track/"` in main.py's PUBLIC_API_PREFIXES) and which carries no throttle at all, unlike the AI routes in this same file (`_check_ai_rate_limit`, line 1253). The link is designed to be sent to clients by SMS, and AitoTrackPage's query uses `staleTime: 30_000` against a QueryClient that leaves `refetchOnWindowFocus` at its v5 default of true, so a client who leaves the page open on a phone writes a fresh row every time they switch back after 30 s. Each row is a separate commit that takes SQLite's single writer lock, contending with the aito_quote_sync worker — the same "database is locked" contention this file guards against by hand in send_invoice_email (line 1765) and send_pickup_sms (line 3006) — and the rows only leave after `purge_tracking_views`' 400-day cutoff. · fix: suppress a repeat insert for the same project within a short window (e.g. skip when a row for that project_id already exists inside the last N minutes) and/or add a per-IP sliding window in front of the handler, modelled on `_check_ai_rate_limit` · user-visible change: the Stats pipeline widget's "vues" count will read lower than today for any client who reopens the same link repeatedly, and a rapid refresher may start receiving 429s instead of the page.
fingerprint: d581e3c072a1ffcf
source: audit-robustness
reason: duplicate of T-003 (same finding from audit-robustness); folded, decision recorded on T-003

## T-009
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: compute_aito_stats scans the entire event log regardless of the requested date range
files: backend/app/services/aito_stats.py
evidence: backend/app/services/aito_stats.py:125 · `_stage_days` runs `.where(AitoEvent.kind == "stage.changed", AitoEvent.project_id.in_(ids))` with no bound on `occurred_at` and materialises everything with `(await db.execute(stmt)).all()`; `start`/`end` are only consulted afterwards in Python via `_in_range` (line 141). `_first_moments` (line 87) does the same and is called four times per request. So narrowing the Stats page range from a year to a week does not shrink a single query: every GET /aito/stats pulls the whole `stage.changed` + project.created/quote.sent/accepted/declined history for every active card and `json.loads` each `changes`/`detail` blob on the event loop. `aito_events` is append-only (models/aito_event.py: "append-only", no purge exists) and done cards stay `status == 'active'`, so this grows with the board's lifetime history, not its workload — on a shop with the thousand-card import the repo already tests for, one widget load blocks the loop for every other request behind it. · fix: push the upper bound into SQL (`AitoEvent.occurred_at <= end` when `end` is set — rows after it can never pass `_in_range`, and the `opened_at` chain in `_stage_days` only feeds later rows that are also out of range) and iterate with `.yield_per()` instead of `.all()` so the log is streamed rather than materialised; the lower bound must stay in Python because both functions need history before `start` to compute `began`/the true first moment
fingerprint: 836c3ff20139af9b
source: audit-robustness

## T-010
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: _tracking counts views of trashed cards, breaking the module's own trashed-excluded rule
files: backend/app/services/aito_stats.py
evidence: backend/app/services/aito_stats.py:154 · `stmt = select(func.count(AitoTrackingView.id), func.count(func.distinct(AitoTrackingView.project_id)))` filters only on `viewed_at` — there is no join or `IN (ids)` against the `projects` dict the function already receives, even though the module docstring states "Trashed projects and their events are excluded everywhere" and the third figure on the same tile row, `cards_with_link`, IS computed from `projects.values()`. Trash a card a client had already opened (routine — the trash is a normal board action) and the widget reports e.g. "12 vues / 5 cartes vues / 3 cartes avec lien": more cards viewed than cards that have a link, which reads as a broken counter and cannot be reconciled from the UI. · fix: add `AitoTrackingView.project_id.in_(projects)` to the statement so both view figures range over the same active set as `cards_with_link` · user-visible change: the pipeline widget's "vues" and "cartes vues" numbers will drop for any instance that has trashed a card a client had opened.
fingerprint: 7083c34eca4ea041
source: audit-robustness
reason: user-approved behavior change

## T-013
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 3
last_touched_iteration: 4
title: clearSpriteCache() is defined but never called
files: frontend/src/components/aito/celebration/render.ts
evidence: frontend/src/components/aito/celebration/render.ts:61 · rg -n '\bclearSpriteCache\b' across frontend/src -> only its own definition at render.ts:61; the barrel `celebration/index.ts` re-exports only `CelebrationProvider`, `useCelebration`, and `VARIANTS`, not `clearSpriteCache`; `CelebrationLayer.tsx` (the only consumer of `./render`) imports just `{ draw }`. The function's own doc claims it should run 'when the theme accent changes', but no theme-change hook, effect, or listener in the celebration/ directory or ThemeContext calls it. It is also moot: `glowSprite()` (the cache it clears) is already keyed by the CSS colour string itself, and `readPalette()` (celebration/palette.ts) is re-read fresh from `getComputedStyle` on every burst (CelebrationLayer.tsx:127), so a theme change simply produces new cache keys — nothing ever needs an explicit clear. Orchestrator check: the name does not appear in SURFACE.md, so removing it moves no golden. · fix: delete clearSpriteCache and the stale doc comment above it describing the (never-wired) theme-change trigger
fingerprint: 81d65168efc03d45
source: audit-cleanliness

## T-014
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 3
last_touched_iteration: 4
title: CALCULATOR_READ routes are reachable by every default-scoped API key via can_read_status
files: backend/app/api/routes/calculator.py
evidence: backend/app/api/routes/calculator.py:472 · backend/app/api/routes/calculator.py:472 `_: User | None = RequirePermissionIfAuthEnabled(Permission.CALCULATOR_READ),` (same gate at :67 filaments, :299 printers, :386 defaults) + backend/app/core/auth.py:124 `Permission.CALCULATOR_READ: "can_read_status",` + backend/app/models/api_key.py:32 `can_read_status: Mapped[bool] = mapped_column(Boolean, default=True)`. can_read_status is on by default for every key created via POST /api-keys, and both default groups that can own a key hold calculator:read (backend/app/core/permissions.py:526 Operators, :562 Viewers), so authorize_api_key()'s owner-narrowing check passes. A printer-status/kiosk key therefore reads GET /calculator/filaments/ (cost_per_kg, margin_pct, sale_price_per_kg), GET /calculator/defaults (labor_rate_per_hour, margin curve, every markup) and GET /calculator/insights (measured failure rates, energy tariff, real spool purchase costs) — the shop's confidential cost base. This contradicts the deliberate carve-out three lines apart in the same table: auth.py:334-339 denies Permission.AITO_READ to API keys with the comment "no kiosk or automation depends on reading it via API key, so it stays user-token only rather than riding along on the can_read_status default-on scope" — the identical argument applies here and was not applied. · fix: move Permission.CALCULATOR_READ out of _APIKEY_SCOPE_BY_PERMISSION and into the unmapped/denied set in backend/app/core/auth.py, alongside the existing AITO_READ entry, so calculator reads are user-token only; if some automation genuinely needs them, give the calculator its own scope flag on APIKey rather than leaving it on the default-on can_read_status · user-visible change: any existing integration that reads /api/v1/calculator/* with an X-API-Key or bb_ bearer key will start getting 403 "API keys cannot be used for administrative operations" and must switch to a user JWT.
fingerprint: 3420fa35ec5d0b6a
source: audit-security
reason: user-approved behavior change (2026-09-06): calculator reads become user-token only; API keys get 403 on /api/v1/calculator/*

## T-015
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 3
last_touched_iteration: 4
title: _to_response() embeds the card's tracking token in every board response, below the tier that gates the tracking-link route
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:452 · backend/app/api/routes/aito.py:452 `tracking_url=tracking_url_for(external_url, p.tracking_token),` inside _to_response(), which builds the payload of GET /aito/ (`_: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_READ)`, line 908) and GET /aito/trash (line 934). tracking_url is the client-facing bearer credential — services/aito_tracking.py:45 `return f"{base}/track/{token}"` over a secrets.token_urlsafe(32) that the public route treats as the whole authentication (`get_tracking()` docstring: "the token IS the credential"). The dedicated endpoint that hands the same string out is gated one tier higher, at AITO_UPDATE (line 2877), and now carries Cache-Control: no-store; the board list has neither. Nothing consumes the field: `grep -rn '\.tracking_url' frontend/src` outside tests returns only components/aito/TrackingLinkControl.tsx:18 — a comment saying "Copy goes through the link endpoint rather than reading `project.tracking_url`" — while the UI reads only the sibling boolean `tracking_configured` (line 453). · fix: drop tracking_url from AitoProjectResponse (schemas/aito.py:606) and stop populating it in _to_response(), keeping tracking_configured, so the token is only ever served by the AITO_UPDATE-gated /tracking-link and /tracking-token routes; if the field must stay, populate it only for callers holding AITO_UPDATE and add Cache-Control: no-store to the board-list responses · user-visible change: tracking_url disappears from GET /api/v1/aito/, /aito/trash and every PATCH/move/restore board response, so any external API consumer reading that field gets nothing and must call GET /aito/{id}/tracking-link instead (the in-app UI is unaffected — it already does).
fingerprint: 202667e578e120f3
source: audit-security
reason: user-approved behavior change (2026-09-06): drop tracking_url from AitoProjectResponse; keep tracking_configured; re-record app-openapi-index golden under a changelog entry

## T-016
priority: P2
status: OPEN
attempts: 0
round: 2
first_seen_iteration: 3
last_touched_iteration: 3
title: print()'s wait on document.fonts.ready has no timeout after the load timer is cleared
files: frontend/src/components/aito/usePrintBlob.ts
evidence: frontend/src/components/aito/usePrintBlob.ts:188 · `window.clearTimeout(timer); timeoutRef.current = null; const fontsReady: Promise<unknown> = element.contentDocument?.fonts?.ready ?? Promise.resolve(); fontsReady.then(` — the IFRAME_LOAD_TIMEOUT_MS timer is the only backstop that escalates to `openInTab`, and it is cleared before an unbounded wait begins. The shipping-label document pulls Inter from the app's own /fonts over the network (see buildShippingLabelHtml); if that request stalls rather than fails (a proxy black-hole, a dropped connection behind the shop's link), `fonts.ready` never settles, so neither `cleanup(element, objectUrl)` nor `setBusy(false)` is ever reached: the Print cell in the Shipping card header stays disabled with its spinner forever, no toast, no window.open fallback, and the blob URL and offscreen iframe stay pinned until the operator closes the detail panel. · fix: race `fontsReady` against a timer that falls through to the same `openInTab(objectUrl, element)` path, or leave the load timer armed until the fonts promise settles instead of clearing it on `load`
fingerprint: 50b884c561c3059b
source: audit-robustness

## T-017
priority: P2
status: WONTFIX-AUTO
attempts: 0
round: 2
first_seen_iteration: 3
last_touched_iteration: 3
title: move_project renumbers a whole column from a stale read with no version or membership guard
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:2498 · `destination = await _active_in_column(db, payload.column, exclude_id=project.id)` … `insert_at = min(payload.position, len(destination)); destination.insert(insert_at, project); project.board_column = payload.column; for i, row in enumerate(destination): row.position = i` — `AitoProjectMove` (schemas/aito.py:431) carries no `expected_version`, unlike `update_project`, which closes exactly this window with `_claim_expected_version`, and unlike `PATCH /{id}/tasks/reorder`, which 409s when the id set has moved. Two overlapping writes to the same column each compute a full 0..n-1 renumbering from their own pre-write snapshot: two operators dragging (the board is explicitly multi-user — see the aito_presence fan-out), or one operator whose step-tick PATCH is still in flight while they drag, since `_apply_rules` (line 666) renumbers the source column the same unguarded way. The later commit overwrites the earlier one's positions wholesale, so the first operator's drag silently reverts on the next board refetch with no conflict toast; when the racing move crossed columns, the stale `destination` list still holds the card the other request just relocated and writes a source-column position onto it. · fix: have AitoProjectMove carry `expected_version` (or the full ordered id list, as AitoTaskReorder does) and reject with 409 when the column's membership/order moved since the client read it; apply the same guard to `_apply_rules`' relocation · user-visible change: a drag issued against a column another write has since reordered would start returning 409 and asking the operator to retry, where today it silently wins or loses
fingerprint: d7b2de6312841ce1
source: audit-robustness
reason: behavior change declined for this campaign (2026-09-06): real bug, fix spans schema+route+_apply_rules+frontend 409 handling — for a feature branch, evidence retained

## T-018
priority: P2
status: OPEN
attempts: 0
round: 2
first_seen_iteration: 3
last_touched_iteration: 3
title: useCalculatorState's errors memo assumes every persisted field is a string
files: frontend/src/hooks/useCalculatorState.ts
evidence: frontend/src/hooks/useCalculatorState.ts:249 · `const raw = state[key] as string; if (raw.trim() !== '' && (!Number.isFinite(Number(raw)) || Number(raw) < 0))` — `loadState` builds state as `const state: CalcState = { ...DEFAULT_STATE, ...legacy };` where `legacy` is whatever `JSON.parse(localStorage.getItem('calculator-state'))` returned, with no per-field type check, so `as string` is an assertion rather than a guarantee. A stored `"weight": null` (or a number) makes `raw.trim` undefined and this memo throws a TypeError on every render, so /calculator is a blank screen; the state is re-read from localStorage on every mount, so the Reset button never renders and reloading does not recover — only clearing site data does. `num()` (line 88) documents this exact input, "a partially-shaped state (stale HMR module mix, hand-edited localStorage)", as a case it deliberately degrades on, and `foldSessionOverrides`' `state.tariffOverride !== ''` comparisons have the same hole. · fix: coerce in loadState — rebuild the returned CalcState field by field, keeping a persisted value only when its type matches the default's — rather than spreading the parsed object straight over DEFAULT_STATE
fingerprint: 8123a4d13b85c48b
source: audit-robustness

## T-020
priority: P2
status: OPEN
attempts: 0
round: 2
first_seen_iteration: 3
last_touched_iteration: 3
title: ensure_tracking_token()'s winning-mint UPDATE bumping updated_at is never asserted
files: backend/app/services/aito_tracking.py
evidence: backend/app/services/aito_tracking.py:62 · backend/app/services/aito_tracking.py:62-67 mints via `update(AitoProject).where(...).values(tracking_token=new_token)` and never lists `updated_at`; the column is declared `mapped_column(DateTime, server_default=func.now(), onupdate=func.now())` (backend/app/models/aito_project.py:232), so SQLAlchemy's compiler fires the onupdate default on every winning mint even though it isn't in `.values()`. `test_ensure_mints_once_and_is_stable` (backend/tests/unit/test_aito_tracking.py:52-61) and `test_ensure_token_race_loser_returns_winners_token` (:65-82) exercise both the winning and losing paths but assert only on `tracking_token`, never on `updated_at` — `last_activity()` (aito_tracking.py:147-160) falls back to exactly this column for the public tracking page's 'Mis à jour' field when the project has no events, so a refactor that moved the mint to an ORM-attribute write, added `updated_at` to `.values()` explicitly, or switched to a raw exec that skips column defaults would silently change what timestamp a customer sees, with nothing failing. · fix: in backend/tests/unit/test_aito_tracking.py, extend test_ensure_mints_once_and_is_stable (or add a new case) to capture project.updated_at before calling ensure_tracking_token on the winning (non-race) path, then re-read the row and assert updated_at advanced.
fingerprint: 3a80450e9e03dfa5
source: audit-tests

## T-021
priority: P2
status: OPEN
attempts: 0
round: 2
first_seen_iteration: 3
last_touched_iteration: 3
title: test_wake_drains_a_pending_project_without_waiting_for_the_interval's live_sessions poll uses a 1s hard budget while every other wait in the same test uses a 30s/5s asyncio.wait_for
files: backend/tests/unit/test_aito_quote_sync.py
evidence: backend/tests/unit/test_aito_quote_sync.py:2760 · backend/tests/unit/test_aito_quote_sync.py:2760-2764 and :2792-2796 both do `for _ in range(100): if not live_sessions: break; await asyncio.sleep(0.01)` then `assert not live_sessions` -- a fixed 1.0s ceiling for a worker session's close() to complete -- whereas the same test's other synchronization points are generous, explicitly-timed `asyncio.wait_for(..., timeout=5)` and `asyncio.wait_for(drain_completed.wait(), timeout=30)` (lines 2757, 2785), with the surrounding comments explicitly reasoning that a wall-clock poll 'could turn a genuine drain into a false failure' under CPU contention. Under the documented parallel-suite load, a session close taking >1s makes this specific assertion fail while the rest of the test's logic is sound -- a concrete, fixable root cause rather than pure environment noise. · fix: in backend/tests/unit/test_aito_quote_sync.py, replace both `for _ in range(100): ... await asyncio.sleep(0.01)` polling blocks with `await asyncio.wait_for(_all_sessions_closed(), timeout=30)` (or an equivalent asyncio.Event set when live_sessions empties) so this wait has the same generous, load-tolerant budget as the test's other two waits.
fingerprint: efbd2c880e2f5e75
source: audit-tests

## T-023
priority: P2
status: OPEN
attempts: 0
round: 2
first_seen_iteration: 3
last_touched_iteration: 3
title: loadState()'s catch-block fallback for corrupted/unparseable localStorage is untested
files: frontend/src/hooks/useCalculatorState.ts
evidence: frontend/src/hooks/useCalculatorState.ts:144 · frontend/src/hooks/useCalculatorState.ts:126-146 wraps the entire localStorage read + JSON.parse + legacy migration in try/catch, returning `DEFAULT_STATE` on any thrown error (line 145). Every `localStorage.getItem` mock across frontend/src/__tests__/pages/CalculatorPage.test.tsx and CalculatorQuotePage.test.tsx returns either `null` or a valid JSON string (grepped: every `mockImplementation((key) => ...)` call returns parseable JSON or null; none throw or return malformed text) -- the catch path (JSON.parse throwing on garbage, or getItem itself throwing, e.g. Safari private mode) has no characterization test, silently discarding the user's persisted calculator inputs/settings with no visible error. · fix: in frontend/src/__tests__/pages/CalculatorPage.test.tsx, add a case where `localStorage.getItem` for 'calculator-state' returns an invalid-JSON string (e.g. '{not json'), then render the page and assert it falls back to DEFAULT_STATE (e.g. easyMode/weight defaults shown) instead of throwing or leaving the page blank.
fingerprint: b2449a455bb70ac8
source: audit-tests

## T-024
priority: P2
status: OPEN
attempts: 0
round: 2
first_seen_iteration: 3
last_touched_iteration: 3
title: onTablistKeyDown() — arrow-key tab navigation — has no test at all
files: frontend/src/pages/CalculatorPage.tsx
evidence: frontend/src/pages/CalculatorPage.tsx:306 · frontend/src/pages/CalculatorPage.tsx:306-314 defines `onTablistKeyDown`, which handles ArrowRight/ArrowLeft to cycle `tab` through PAGE_TABS and move focus. v8 coverage (verified directly: `vitest run src/__tests__/pages/CalculatorPage.test.tsx --coverage --coverage.include=src/pages/CalculatorPage.tsx --coverage.reporter=json`) shows the whole function as `uncovered fn (anonymous_38) lines 306-314` with statements 307-313 all at 0 executions -- it is wired to a tablist's onKeyDown and is the only keyboard-accessible way to switch calculator tabs, yet no test in CalculatorPage.test.tsx simulates a keydown on the tablist. · fix: in frontend/src/__tests__/pages/CalculatorPage.test.tsx, add a test that fires ArrowRight/ArrowLeft keydown events on the tab list and asserts the active tab (and focus) cycles through PAGE_TABS in both directions, including wraparound at the ends.
fingerprint: 8f685772fb90cbb4
source: audit-tests

