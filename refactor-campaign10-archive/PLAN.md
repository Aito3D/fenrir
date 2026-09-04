# PLAN (schema v2)

## T-002
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: "replace one project in the ['aito-projects'] cache list" pattern copy-pasted across ~9 mutation sites
files: frontend/src/hooks/useSendQuoteMutation.ts
evidence: frontend/src/hooks/useSendQuoteMutation.ts:23 · Identical `queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) => prev?.map((p) => (p.id === X.id ? X : p)) ?? prev)` block appears verbatim (only the replacement variable name differs) at: frontend/src/hooks/useSendQuoteMutation.ts:23-25, frontend/src/hooks/useQuoteStatusMutation.ts:51-53, frontend/src/hooks/useContactedMutation.ts:36-38, frontend/src/hooks/useFlagMutation.ts:26-28, frontend/src/hooks/useColumnMoveMutation.ts:65-67, frontend/src/hooks/useAitoPageMutations.ts:104-106 and 161-163, frontend/src/components/aito/useProjectPatchMutation.ts:147-149, frontend/src/components/aito/TrashGrid.tsx:47-49. frontend/src/utils/aitoOptimistic.ts already exists specifically to hold this kind of pure `AitoProject[] -> AitoProject[]` transform (see its module docstring), but this particular transform was never moved there. · fix: Add a small helper (e.g. `replaceProject(prev: AitoProject[] | undefined, updated: AitoProject)`) to utils/aitoOptimistic.ts and have all ~9 call sites use `queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) => replaceProject(prev, updated))` instead of repeating the map/coalesce inline.
fingerprint: 70db6019ce8ddc3f
source: audit-cleanliness
reason: user-approved surface change (new export replaceProject; approved after verifier flagged it; SURFACE.md + changelog in a follow-up commit)

## T-004
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: Four aito.lock* i18n strings (lockQuote/lockWaiting/lockDeclined/lockSteps) are translated in all 13 locales but never rendered
files: frontend/src/i18n/locales/en.ts
evidence: frontend/src/i18n/locales/en.ts:164 · en.ts:164-167 define `lockQuote`, `lockWaiting`, `lockDeclined`, `lockSteps` (each also present, fully translated, in de/es/fr/it/ja/ko/pt-BR/ru/tr/uk/zh-CN/zh-TW). `rg -n "aito\\.lockQuote\\b|aito\\.lockWaiting\\b|aito\\.lockDeclined\\b|aito\\.lockSteps\\b" frontend/src -g '*.ts' -g '*.tsx'` returns zero matches anywhere outside the locale files themselves. The frontend only ever checks `project.move_lock === null` (BoardColumn.tsx, DoneGrid.tsx, ProjectDoneAction.tsx, useColumnMoveMutation.ts) — it never branches on the specific lock reason ('quote'|'waiting'|'declined'|'steps') to show text, even though schemas/aito.py's AitoProjectResponse.move_lock docstring says "The frontend renders its lock badge... from this and nothing else", implying a badge that does not exist in the current code. · fix: Either remove these 4 keys from all 13 locale files (they cost nothing to keep but nothing renders them), or — if a per-reason lock badge/tooltip was intended — wire CardView.tsx/StageRail.tsx to actually render `t(\`aito.lock${capitalize(move_lock)}\`)` when `move_lock !== null`.
fingerprint: a82bbc6b93eb0880
source: audit-cleanliness

## T-005
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: Leftover calculator settings-panel i18n keys from the pre-hyperbolic-margin tabbed UI
files: frontend/src/i18n/locales/en.ts
evidence: frontend/src/i18n/locales/en.ts:8435 · en.ts defines, under the `calculator` namespace: `printingTimeMin` (8288), `defaultsHint` (8308), `bulkTitle` (8435), `tabDefaults` (8448), `tabMarginCurve` (8496), `saveMarginCurve`/`marginCurveSaved` (8530-8531), `globalMarkup` (8545), `defaultsSaved`/`saveDefaults` (8552-8553), `tabPricing` (8554), `pricingHint` (8555), `marginTitle` (8560), `savePricing`/`pricingSaved` (8565-8566) — all translated across all 13 locales. `rg -n "calculator\\.<key>\\b" frontend/src -g '*.ts' -g '*.tsx'` returns zero hits for every one of these outside the locale files. The current CalculatorSettingsPanel.tsx (single-panel, no tabs) instead uses `ratesTitle`, `provisionsTitle`, `filamentSettings`, `marginCurvesTitle`, `saveSettings`, `discardChanges` (confirmed used at lines 331-399), and `globalMarkup` matches the `global_markup_pct` concept the user's own memory notes say was replaced by the hyperbolic margin-curve model on 2026-08-27 — these keys are the remains of the old Defaults/Pricing/MarginCurve tabbed settings UI that migration replaced. · fix: Delete these ~15 orphaned keys from all 13 locale files as part of a follow-up to the hyperbolic-margin-curve migration; `unsavedChanges` in the same block IS still used (CalculatorSettingsPanel.tsx:390) and must stay.
fingerprint: 10e6e740dae83eba
source: audit-cleanliness

## T-007
priority: P0
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: _write_back_rounded_costs re-reads tasks through the session identity map and clobbers a concurrent cost edit
files: backend/app/services/aito_quote_sync.py
evidence: backend/app/services/aito_quote_sync.py:579 · `rows = (await db.execute(select(AitoTask).where(AitoTask.project_id == project_id))).scalars().all()` ... `setattr(row, f"{service}_cost", round(getattr(row, f"{service}_cost") / quantity) * quantity)` — `load_export_tasks` already loaded these AitoTask rows into the SAME session a moment earlier, so this SELECT is an identity-map hit and returns the STALE in-memory objects (SQLAlchemy does not repopulate a live instance without populate_existing). If an operator PATCHes a task cost during the `update_estimate_lines`/`create_estimate` round trip (up to 10s; the 10s edit debounce fires mid-typing, so this window overlaps ordinary editing), the write-back computes the rounded value from the stale cost and setattr marks the row dirty — run_sync_once's commit then writes it, silently reverting the operator's price. Reproduced against SQLAlchemy+aiosqlite: task cost 2401/qty 2, operator commits 5000 in another session mid-round-trip, worker's re-select still reads 2401 (same object identity) and the row ends at 2400 — the 5000 is gone, and the next tick pushes 2400 to the customer's Books quote. The _requeue_marker only keeps the project 'pending'; it cannot restore the lost figure. · fix: Make the write-back read the database rather than the identity map — `select(AitoTask)...execution_options(populate_existing=True)` — or better, express it as a conditional Core UPDATE that only rewrites a row whose cost still equals the value that was actually pushed, so a row edited mid-round-trip is skipped.
fingerprint: 190e80640ea574b6
source: audit-robustness
reason: user-approved behavior change (approved after verifier flagged it; changelog entry added in a follow-up commit)

## T-008
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: run_sync_once never re-selects an errored project that has no quote_id yet, so a failed quote CREATE is retried only if a human edits the card
files: backend/app/services/aito_quote_sync.py
evidence: backend/app/services/aito_quote_sync.py:1514 · The sweep's non-pending predicate is `AitoProject.status == "active", AitoProject.quote_id.is_not(None), AitoProject.quote_sync_state.not_in(("pending", "unmanaged", "locked"))` (mirrored in `_still_selected`). A project whose `_create_quote` failed still has `quote_id` NULL, so once `sync_project` escalates it to 'error' (5 consecutive ZohoUpstreamErrors = 25 min of Books being unreachable at the 300s tick, or one trip through the `except Exception` catch-all, e.g. the IntegrityError raised when `_apply_estimate`'s quote_id collides with `uq_aito_project_active_quote`) it matches NEITHER branch and is never selected again. This directly contradicts SYNC_FAILURE_LIMIT's own comment ('the sweep deliberately keeps selecting error projects ... that read is exactly what lets sync_project's recovery branch bring it back to idle once Books answers again'), which only holds for projects that already have a quote_id. What the user sees: a card created during a Books outage sits forever showing 'Zoho Books unreachable', no estimate is ever created in Books even after Books recovers, and on the IntegrityError path an orphan estimate is left in Books that the `find_estimate_by_reference` idempotency guard never gets a chance to adopt. · fix: Widen the sweep (and `_still_selected`) to also select active projects in state 'error' with a NULL quote_id, or have the ZohoUpstreamError escalation leave such projects 'pending' instead of 'error' while still surfacing the message on the card. · user-visible change: cards currently stuck showing a sync error would start syncing again on their own, so a quote can appear in Zoho Books without anyone touching the card.
fingerprint: 774b5142fa4ba980
source: audit-robustness
reason: user-approved behavior change

## T-009
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: _raise_for_status maps HTTP 429 to a generic ZohoUpstreamError, so rate limiting spends the sync retry budget with no backoff
files: backend/app/services/zoho.py
evidence: backend/app/services/zoho.py:294 · `if response.status_code >= 400:\n raise ZohoUpstreamError(f"Zoho Books error (HTTP {response.status_code})")` — 429 is indistinguishable from a 500, and `Retry-After` is never read. In `sync_project` that lands in the `except ZohoUpstreamError` branch which does `failures = sync_failures_before + 1`, so every throttled tick spends one of the five retries SYNC_FAILURE_LIMIT reserves for outages. Because `run_sync_once` loops over every selected project with no circuit breaker (`for project_id in project_ids: ... await sync_project(db, project)`), the first 429 of a tick is followed by one more throttled request per remaining project, deepening the throttle; after five ticks every card on the board simultaneously reads 'Zoho Books error (HTTP 429)' and stops pushing line items until a successful GET happens to land. · fix: Give 429 its own exception (or a retry_after attribute parsed from the Retry-After header), have sync_project treat it as a deferral like ShippingCatalogueUnavailable rather than a failure, and break out of run_sync_once's loop for the rest of the tick once one is seen. · user-visible change: a rate-limited board would stop showing 'Zoho Books error (HTTP 429)' on its cards and would stop escalating to the 'error' state, staying 'pending' until the throttle clears.
fingerprint: 47b7d88270e01d9a
source: audit-robustness
reason: user-approved behavior change

## T-010
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 4
title: run_sync_once's reconcile sweep keeps polling every active quoted project forever, so per-tick Zoho calls grow with board history
files: backend/app/services/aito_quote_sync.py
evidence: backend/app/services/aito_quote_sync.py:1512 · `and_(AitoProject.status == "active", AitoProject.quote_id.is_not(None), AitoProject.quote_sync_state.not_in(("pending", "unmanaged", "locked")))` — archiving a card only sets `board_column = 'done'` (see move_project), and declined/expired quotes are never locked either, so every card ever quoted stays in the swept set for the life of the install and costs one `GET /estimates/{id}` (plus a comments pull) per 300s tick forever. The module's own comment admits it ('a finished, accepted card is polled and re-recorded forever') and states Zoho's budget as 1,000-10,000 requests/day per org; at 288 ticks/day the sweep alone exceeds 10,000 calls/day past ~35 retained quoted projects. Once the org is throttled, every Zoho surface degrades at once — client search, quote PDF, quote/invoice email — and each 429 also burns the sync retry budget (see the _raise_for_status finding). · fix: Exclude terminal cards from the sweep — e.g. skip projects in board_column 'done', or whose quote_status is 'declined'/'expired' and whose quote_synced_at is older than some cutoff — or cap the number of reconcile targets per tick and round-robin them. · user-visible change: a status change made in Zoho Books on an archived or declined quote would no longer be reflected back onto the card automatically.
fingerprint: 89ed98098b8a9b9c
source: audit-robustness
reason: user-approved behavior change

## T-011
priority: P3
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 5
title: get_shipping_catalogue records no failure cooldown, so every deferring project re-attempts the /items fetch on every tick
files: backend/app/services/zoho.py
evidence: backend/app/services/zoho.py:646 · `items = await self.list_items(db, "Livraison Avion")` / `except (ZohoNotConfiguredError, ZohoUpstreamError) as e: logger.warning(...)` — the `zoho_shipping_catalogue_at` stamp is only written in the `else` branch, so a failed refresh leaves `fresh` False and the next caller repeats the whole fetch. `sync_project`'s ShippingCatalogueUnavailable handler calls this with `refresh=True` once per deferring project, so while Books is down N shipping-carrying projects cost N extra `/items` requests every tick, on top of the per-project estimate reads — the opposite of the `_FAIL_COOLDOWN` the sibling `zoho_filaments.fetch_catalogue` added for exactly this shape. · fix: Stamp a short failure cooldown (a `zoho_shipping_catalogue_failed_at` setting, or a process-local timestamp) on the except branch and short-circuit the refresh while it is fresh, mirroring zoho_filaments._FAIL_COOLDOWN. · user-visible change: after a Books outage a newly-available shipping rate can take up to the cooldown window longer to appear in the create drawer.
fingerprint: e00e406450a11b52
source: audit-robustness
reason: user-approved behavior change

## T-013
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 4
title: send_sms_notification's httpx.HTTPError transport-failure branch has no test
files: backend/app/services/pushcut.py
evidence: backend/app/services/pushcut.py:55 · coverage: backend/app/services/pushcut.py 19 stmts, 2 missing, 91% -- missing lines 55-56 (`except httpx.HTTPError as e: raise PushcutUpstreamError(...)`). backend/tests/unit/test_aito_pickup_sms.py has test_pushcut_unconfigured_raises and test_pushcut_non_2xx_raises (a fake client returning status_code=404) but no test whose fake AsyncClient.post raises httpx.HTTPError/httpx.ConnectError -- the sibling service backend/app/services/openrouter.py has this exact case covered (backend/tests/unit/services/test_openrouter_proofread.py:112 `client, _ = build_client(raises=httpx.ConnectError("no route"))`), so the pattern to mirror already exists in-repo. · fix: in backend/tests/unit/test_aito_pickup_sms.py, add a test mirroring test_pushcut_non_2xx_raises but with a FakeClient.post that raises httpx.ConnectError (or httpx.HTTPError) instead of returning a response, and assert pytest.raises(pushcut_service.PushcutUpstreamError) with the exception chained via `from e`
fingerprint: 1fe4e8b264e61b7f
source: audit-tests

## T-014
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 4
title: run_sync_once's best-effort ws_manager.broadcast_aito failure during quote-sync is never exercised
files: backend/app/services/aito_quote_sync.py
evidence: backend/app/services/aito_quote_sync.py:1627 · coverage: backend/app/services/aito_quote_sync.py 381 stmts, 17 missing, 95% -- missing lines include 1627-1628: `except Exception: logger.warning("aito_changed broadcast failed for quote-sync", exc_info=True)`. backend/tests/unit/test_aito_quote_sync.py:176 test_quote_sync_aito_changed_goes_out_through_the_filtered_fan_out only exercises the success path (AsyncMock() with no side_effect). The identical failure shape IS tested for the routes/aito.py emitter in backend/tests/unit/test_aito_broadcasts.py:72 (`AsyncMock(side_effect=RuntimeError("ws down"))`), so this sweep-loop emitter is the one broadcast site in the module left unguarded by a test. · fix: in backend/tests/unit/test_aito_quote_sync.py, add a test that monkeypatches aito_quote_sync.ws_manager.broadcast_aito to an AsyncMock(side_effect=RuntimeError("ws down")), runs run_sync_once against a pending project, and asserts it still returns normally (project reaches quote_sync_state == 'idle' / quote_id set) -- i.e. a broadcast failure must not abort the tick or leave the project's own state unwritten
fingerprint: 5de6dc1eb6e19a22
source: audit-tests

## T-015
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: get_invoice_pdf's real implementation (and its route's three error branches) is never executed by any test
files: backend/app/services/zoho.py
evidence: backend/app/services/zoho.py:763 · coverage: backend/app/services/zoho.py missing lines include 771-780, the entire body of `async def get_invoice_pdf` (status>=400 mapping, non-JSON payload fallback, and the `%PDF-` sniff that raises ZohoUpstreamError). Every single caller across backend/tests/unit/test_aito_invoice.py (test_invoice_pdf_is_served_inline, test_invoice_pdf_prints_the_invoice_the_card_asked_for, test_invoice_pdf_refuses_an_id_that_is_not_this_projects, test_invoice_pdf_without_an_id_still_prints_the_newest, test_invoice_pdf_is_404_when_there_is_no_invoice, test_invoice_pdf_filename_survives_a_non_latin1_number) does `monkeypatch.setattr(zoho_service, "get_invoice_pdf", pdf)` with a hand-written fake, so the real method's status-code handling and PDF-signature check never run. Its structural twin `get_estimate_pdf` (docstring: "Same shape and same reasoning as get_estimate_pdf above") HAS 3 dedicated service-level tests in backend/tests/unit/services/test_zoho_service.py (test_get_estimate_pdf_returns_bytes, test_get_estimate_pdf_maps_not_found, test_get_estimate_pdf_rejects_a_200_that_is_not_a_pdf). Additionally coverage shows aito.py 1291, 1293, 1298-1299 missing -- the /invoice.pdf route's own project-404, no-quote-404 and 502-on-ZohoUpstreamError branches are untested (their /invoice counterparts ARE tested: test_missing_project_is_404, test_a_project_without_a_quote_never_calls_zoho, test_zoho_failure_is_502, all only hitting GET /invoice, never /invoice.pdf). · fix: in backend/tests/unit/services/test_zoho_service.py, add get_invoice_pdf tests mirroring the three existing get_estimate_pdf ones (bytes-return over a mocked transport, 404 mapping via _raise_for_status, and rejection of a 200 whose body does not start with %PDF-). Separately, in backend/tests/unit/test_aito_invoice.py add GET /invoice.pdf variants of test_missing_project_is_404, test_a_project_without_a_quote_never_calls_zoho, and test_zoho_failure_is_502 (currently only covering /invoice)
fingerprint: 016025fd87276f6b
source: audit-tests

## T-016
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: useSendQuoteMutation has no test at all, including its silent marked_sent===false warning branch
files: frontend/src/hooks/useSendQuoteMutation.ts
evidence: frontend/src/hooks/useSendQuoteMutation.ts:15 · grep -rl useSendQuoteMutation frontend/src/__tests__ -> no matches (file is live production code, imported by frontend/src/components/aito/SendQuoteModal.tsx). The hook's onSuccess has a narrow, easy-to-invert branch: `if (result.marked_sent === false) { showToast(t('aito.quoteEmailedCardMoveFailed', ...), 'warning') } else { showToast(t('aito.quoteEmailed', ...), 'success') }` -- per its own comment this distinguishes 'the email sent but the card failed to move' from both an ordinary success and a null ("no move needed") result, and a refactor that collapsed the `=== false` check to a truthiness check would silently swallow the failure-warning case with nothing catching it. · fix: add frontend/src/__tests__/hooks/useSendQuoteMutation.test.tsx covering: (1) success with marked_sent undefined/null shows the plain success toast and calls onDone, (2) marked_sent: false shows the warning toast (aito.quoteEmailedCardMoveFailed) and still calls onDone, (3) a rejected mutationFn shows the error toast and does NOT call onDone, and (4) onSuccess writes the returned project into the ['aito-projects'] query cache
fingerprint: 43e9b62b355c5dfe
source: audit-tests

## T-017
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 5
title: useQuotePendingPoll's deadline/matching-id state machine has no test
files: frontend/src/hooks/useQuotePendingPoll.ts
evidence: frontend/src/hooks/useQuotePendingPoll.ts:37 · grep -rl useQuotePendingPoll frontend/src/__tests__ -> no matches (file is live production code, wired into frontend/src/pages/AitoPage.tsx's board query). The returned refetchInterval callback is a pure, framework-free state machine over two refs (pollDeadlineRef, pollMatchingIdsRef) with several distinct branches never exercised by any test: the 5-minute QUOTE_POLL_MAX_MS budget expiring and returning false, a NEW matching id resetting an already-running deadline (hasNewMatch), the boardSync.isIdle() guard short-circuiting without touching either ref, and the zero-matches reset path. · fix: add frontend/src/__tests__/hooks/useQuotePendingPoll.test.ts calling useQuotePendingPoll(fakeBoardSync) directly (no rendering needed) with a controllable Date.now (vi.useFakeTimers) and asserting: returns false when boardSync.isIdle() is false regardless of data; returns QUOTE_POLL_INTERVAL_MS while a pending/no-quote-number card exists; returns false once QUOTE_POLL_MAX_MS has elapsed with no new match; and a newly-appearing matching id resets the deadline so polling continues past where it would otherwise have expired
fingerprint: 915e061a489d1fff
source: audit-tests

## T-018
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: handleSave's secret-omission logic is never exercised -- the only test file never types into a field or clicks Save
files: frontend/src/components/ZohoSettings.tsx
evidence: frontend/src/components/ZohoSettings.tsx:73 · coverage: frontend ZohoSettings.tsx 51.89% stmts / 47.56% branch / 29.41% funcs, missing lines 93 (`saveMutation.mutate(payload)`), 107 (test-connection error toast) and 138-221 (every input's onChange handler). The only test file, frontend/src/__tests__/components/ZohoSettingsProbe.test.tsx, renders the component and clicks only the Test button to check a query-cache-key split -- it never fills in an input or clicks Save. handleSave's own comment states the invariant nothing currently checks: "Only send fields that changed / are non-empty -- omitting empty secret fields keeps already-saved secrets from being wiped on save" (lines 74-75); `if (clientSecret) payload.zoho_client_secret = clientSecret;` / `if (refreshToken) payload.zoho_refresh_token = refreshToken;` are the two lines a regression would most plausibly touch, and neither is covered. · fix: add a new test (or extend ZohoSettingsProbe.test.tsx) that: (1) types into the Client ID field and clicks Save, asserting the PUT /api/v1/settings body includes zoho_client_id but omits zoho_client_secret/zoho_refresh_token when those fields were left blank; (2) types a value into the Client Secret field, clicks Save, and asserts the PUT body includes zoho_client_secret; (3) leaves every field unchanged, clicks Save, and asserts no PUT request is sent at all (the `Object.keys(payload).length === 0` short-circuit); (4) makes the Test-connection request reject and asserts the error toast fires
fingerprint: 321510e36da9cd5a
source: audit-tests

## T-019
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 5
title: test_wake_drains_a_pending_project_without_waiting_for_the_interval polls on wall-clock time and starves under parallel load
files: backend/tests/unit/test_aito_quote_sync.py
evidence: backend/tests/unit/test_aito_quote_sync.py:2115 · backend/tests/unit/test_aito_quote_sync.py:2113-2119: `for _ in range(100): # up to ~2s -- far below the 300s tick\n await asyncio.sleep(0.02)\n await db_session.refresh(project)\n if project.quote_id:\n break\nassert project.quote_id == \"E1\"`. The 2-second wall-clock budget assumes the event loop gets scheduled promptly; under `pytest -n 30` (30 concurrent xdist worker processes contending for CPU, per the briefing's own known-flaky list for this exact test) the background run_sync_loop task, its MockTransport round trip and the test's own asyncio.sleep(0.02) polling can all be delayed past 2s of real time with no code defect involved -- a fixed-wall-clock poll racing OS scheduling under load, the flaky pattern this lens targets. · fix: replace the fixed 100x0.02s poll with a deterministic completion signal instead of loosening the 2s budget: e.g. monkeypatch aito_quote_sync._apply_estimate (or wrap run_sync_once) to set an asyncio.Event once this project's push completes, then `await asyncio.wait_for(completed.wait(), timeout=30)` before asserting -- this removes the test's dependence on the poll interval keeping up with real wall-clock time while still failing loudly (via the timeout) if the drain genuinely never happens
fingerprint: fe71f58a9ba32dda
source: audit-tests

## T-020
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 7
title: placeholder-id-to-server-row cache swap copy-pasted between createMutation and importMutation
files: frontend/src/hooks/useAitoPageMutations.ts
evidence: frontend/src/hooks/useAitoPageMutations.ts:104 · frontend/src/hooks/useAitoPageMutations.ts:104-106 (createMutation.onSuccess) and :161-163 (importMutation.onSuccess) both write the identical `queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) => prev?.map((p) => (p.id === placeholder.id ? created : p)) ?? prev)`. rg -n "prev\?\.map\(\(p\) => \(p\.id === placeholder\.id" frontend/src -> only these two sites. This is a different shape from utils/aitoOptimistic.ts's `replaceProject` (added in T-002 this round) because the match key (placeholder's negative id) differs from the replacement row's own id, so replaceProject cannot be reused directly here. · fix: extract a small sibling helper next to replaceProject, e.g. `replaceProjectById(projects, oldId, updated)`, and call it from both onSuccess handlers instead of repeating the inline map/fallback.
fingerprint: 3316429646362db9
source: audit-cleanliness

## T-021
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 7
title: settle-pattern (write replaceProject + invalidate aito-events) copy-pasted across six mutation hooks
files: frontend/src/hooks/useContactedMutation.ts
evidence: frontend/src/hooks/useContactedMutation.ts:37 · The identical two-statement pair `queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) => replaceProject(prev, <row>)); queryClient.invalidateQueries({ queryKey: ['aito-events', <id>] });` appears verbatim in hooks/useContactedMutation.ts:37-38, hooks/useFlagMutation.ts:27-28, hooks/useColumnMoveMutation.ts:65-66, hooks/useQuoteStatusMutation.ts:51-52, hooks/useSendQuoteMutation.ts:24-25, and components/aito/useProjectPatchMutation.ts:148-149 (rg -n "setQueryData<AitoProject\[\]>\(\['aito-projects'\], \(prev\) => replaceProject" frontend/src -> these 6 hits). Each hook already extracted its OWN mutation config into useOptimisticBoardMutation/useProjectPatchMutation, but this specific settle pair is still written out fresh in every one of the six onSuccess callbacks. · fix: add an optional default onSuccess (or a small `settleProject(queryClient, projectId, row)` helper) to useOptimisticBoardMutation/useProjectPatchMutation that every simple single-project mutation can opt into, instead of each hook re-typing the same two lines.
fingerprint: a12e3948979e25b3
source: audit-cleanliness

## T-022
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 7
title: _still_selected() re-implements run_sync_once()'s SQL WHERE predicate in Python, with no parity test between the two
files: backend/app/services/aito_quote_sync.py
evidence: backend/app/services/aito_quote_sync.py:1590 · aito_quote_sync.py:1590-1620 (_still_selected) docstring states it 'Mirrors run_sync_once's SELECT predicate in Python'; the SQL predicate lives at aito_quote_sync.py:1649-1690 (run_sync_once's `selected = or_(...)` construction). Both independently encode the same three conditions (pending-state early return, quote_id-present terminal/unmanaged/locked exclusion, quote_id-absent error-only re-select) — one as a SQLAlchemy expression, one as nested Python `if`s. grep of backend/tests/unit/test_aito_quote_sync.py shows individual example-based tests exercising both paths (e.g. test_a_terminal_declined_project_is_not_selected_by_the_sweep) but no generic property test asserting the two predicates agree for the full state space, so a future edit to one (as already happened for T-010's terminal-card exclusion, added to both by hand) can silently drift from the other. · fix: either add a property/parametrized test that constructs every relevant (status, quote_id, quote_sync_state, board_column, quote_status) combination and asserts run_sync_once's SQL selection agrees with _still_selected for each, or refactor so one of the two is derived from the other (e.g. express the SQL clause's boolean sub-conditions as named constants shared with the Python function's comments) rather than being verified only by hand and by scattered example tests.
fingerprint: c6b9c5285e77f618
source: audit-cleanliness

## T-023
priority: P3
status: OPEN
attempts: 0
round: 2
first_seen_iteration: 5
last_touched_iteration: 5
title: ZohoSettings form fields have no label/input association (htmlFor/id), unlike every sibling Aito/Calculator form
files: frontend/src/components/ZohoSettings.tsx
evidence: frontend/src/components/ZohoSettings.tsx:134 · All 8 text/password inputs in ZohoSettings.tsx (lines 134-224: clientId, clientSecret, refreshToken, organizationId, defaultContactId, defaultContactName, baseUrl, accountsUrl) render `<label className=...>{...}</label>` as a plain sibling of `<input>` with no `htmlFor`/`id` pair and no `aria-labelledby`. frontend/src/__tests__/components/ZohoSettings.test.tsx:19-28 documents this explicitly and defines a custom `inputForLabel()` helper ('The labels are plain siblings of their <input> ... testing-library's label-association queries cant find them') because `getByLabelText` does not work. By contrast, sibling forms in the same feature scope correctly pair every label: frontend/src/components/aito/NewContactForm.tsx:105,121,136,157,176, frontend/src/components/aito/ClientSection.tsx:116,167, and frontend/src/components/calculator/CalculatorInputsCard.tsx:31,111,232,253 all use `htmlFor`/`id`. · fix: add a matching id to each ZohoSettings input and htmlFor to its label (or wrap each input in its label), matching the convention already used by NewContactForm/ClientSection/CalculatorInputsCard in the same codebase area. · user-visible change: purely additive markup (id + htmlFor) with no visual change for a sighted mouse user, but it does change what a screen reader announces when focusing these fields (currently unassociated, would become properly labelled) and what testing-library's getByLabelText can find, which is the observable difference worth calling out even though nothing renders differently on screen.
fingerprint: 784652421ba801d2
source: audit-cleanliness
reason: user-approved behavior change

## T-024
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 8
title: Permission.AITO_READ is mapped to the can_read_status API-key scope, which defaults on for every key
files: backend/app/core/auth.py
evidence: backend/app/core/auth.py:125 · backend/app/core/auth.py:125 ` Permission.AITO_READ: "can_read_status",` + backend/app/models/api_key.py:32 ` can_read_status: Mapped[bool] = mapped_column(Boolean, default=True) # Query status`. GET /api/v1/aito/ is gated on RequirePermissionIfAuthEnabled(Permission.AITO_READ) (backend/app/api/routes/aito.py:825-847) and returns list[AitoProjectResponse], whose fields include client_name, client_phone, client_email and quote_total (backend/app/schemas/aito.py:520-540). Neighbouring entries in the same map carry an explicit rationale comment for why they are API-key-usable (USERS_READ_SLIM at :112-118, SETTINGS_READ at :120-122); AITO_READ has none. AITO_CREATE/UPDATE/DELETE are correctly denied to API keys (auth.py:332-334), so the write side was classified deliberately and the read side appears to have been swept in with the rest of the read-only bucket. · fix: either drop Permission.AITO_READ from _APIKEY_SCOPE_BY_PERMISSION so it becomes admin-only like AITO_CREATE/UPDATE/DELATE already are, or give it its own dedicated scope flag that defaults to False on new keys (mirroring can_control_printer's default=False), so an operator has to opt a key into the CRM board explicitly. Whichever is chosen, add the rationale comment the neighbouring entries carry. · user-visible change: any existing API key that today can GET /api/v1/aito/ (and /aito/{id}/tasks, /events, /trash, /invoice, the quote/invoice email previews and both PDF endpoints) would start receiving 403, so an integration or dashboard reading the Aito board by API key stops working until its key is re-scoped or switched to a user token.
fingerprint: 28f15cfb71f94613
source: audit-security
reason: user-approved behavior change

## T-026
priority: P1
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 6
title: the terminal-card sweep exclusion also drops reconcile_quote_status' PUSH half, stranding a decline Books never received
files: backend/app/services/aito_quote_sync.py
evidence: backend/app/services/aito_quote_sync.py:1672 · run_sync_once's reconcile clause now ends with `AitoProject.board_column != "done",` and `or_(AitoProject.quote_status.is_(None), AitoProject.quote_status.not_in(("declined", "expired"))),` — but reconcile_quote_status is bidirectional: its `if ours_decided:` branch is the ONLY code that retries `advance_estimate_status(db, project.quote_id, local, ...)` for a decision Books has not got. routes/aito.py's set_quote_status writes 'declined' locally first and pushes to Books best-effort (`except Exception: ... zoho_synced = False`), and evaluate() sends a declined card to board_column 'done' — so the instant an operator declines a quote while Books is unreachable the row matches BOTH exclusions and is never selected again. Books keeps the estimate at 'sent' (still live and acceptable by the client online) while the board says declined, forever; the operator's only visible signal is the one-off 'Saved locally — Zoho was not updated' toast, and clicking Decline again hits set_quote_status' `if payload.status == project.quote_status:` early return, which reports no_op/zoho_synced=True and makes no Zoho call at all. Nothing else pushes status: _update_quote only rewrites line items, and _apply_estimate's _DECIDED guard refuses to adopt Books' stale 'sent'. test_a_declined_quote_is_not_selected_by_the_sweep asserts the exclusion but its docstring assumes Books itself settled the quote, which the predicate cannot distinguish from 'we settled it and Books never heard'. · fix: keep a decided-locally card in the sweep until Books has been observed to agree — e.g. exclude on quote_status 'declined'/'expired' only when quote_status_remote/last reconcile confirms the same value, or have set_quote_status record an unconfirmed-push marker the SELECT honours; alternatively drop the no_op short-circuit's zoho_synced=True so re-declining actually re-pushes. · user-visible change: a Zoho estimate that stayed 'sent' after a failed decline would later flip to 'declined' on its own, and such cards would resume costing one Books call per tick until the decline is confirmed.
fingerprint: ae3fcd81ac1823de
source: audit-robustness
reason: user-approved behavior change incl. column+migration+golden re-record (approved 2026-09-03 after attempt 1 BLOCKED)

## T-027
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 8
title: send_pickup_sms 500s after Pushcut already accepted the notification, inviting a duplicate send
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:2649 · `await send_sms_notification(...)` is followed unguarded by `await record(db, project.id, "project.sms.sent", ...)` and `await db.commit()`. The notification is already on the operator's phone at that point, so an SQLAlchemy failure on that flush/commit — 'database is locked' from the aito_quote_sync worker writing the same SQLite file, the exact case send_quote_email and send_invoice_email each guard against with their own try/except SQLAlchemyError — becomes a 500: the operator sees a failure toast for an SMS that WAS pushed, taps Send again, and a second notification lands on the phone while the timeline records neither. · fix: mirror send_invoice_email: wrap the record()+commit() in `except SQLAlchemyError`, log loudly, roll back inside its own try, and still return AitoPickupSmsResponse. · user-visible change: a pickup-SMS request whose local event write fails would return success (with no project.sms.sent entry on the timeline) instead of the current 500 error toast.
fingerprint: ecbc35a9bf9eed8b
source: audit-robustness
reason: user-approved behavior change

## T-028
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 8
title: the 429 deferral is per-tick only: ZohoRateLimited.retry_after is discarded and the wake drain re-hits the throttled org
files: backend/app/services/aito_quote_sync.py
evidence: backend/app/services/aito_quote_sync.py:1499 · `except ZohoRateLimited as e:` logs, remembers the message in _deferred_reasons and `return True`, which only makes run_sync_once `break` out of THIS tick's loop; `e.retry_after` (parsed from Retry-After by zoho._parse_retry_after and documented as 'not currently acted on') is never read, and no process-level cooldown is written. request_debounced_sync fires on every committed edit, so an operator still working the board while Books throttles the org drives run_sync_once(pending_only=True) every EDIT_DEBOUNCE_SECONDS (10s), each drain spending one more request on an org that just said back off — prolonging the throttle instead of clearing it. Both sibling modules already memoize this: zoho_filaments._FAIL_COOLDOWN and zoho._SHIPPING_FAIL_COOLDOWN. · fix: record a module-local 'throttled until' instant from retry_after (falling back to a fixed window) and have run_sync_once/the wake drain short-circuit while it holds, the same shape as _SHIPPING_FAIL_COOLDOWN.
fingerprint: 3e63bbd196c0dbfb
source: audit-robustness
reason: user-approved behavior change (approved after verifier flagged the throttle window; changelog entry in a follow-up commit)

## T-030
priority: P1
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 6
title: RequirePermissionIfAuthEnabled gates on 19 of 21 Aito write routes are never tested to actually reject an unauthorized caller
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:869 · grep -n 'RequirePermissionIfAuthEnabled' backend/app/api/routes/aito.py shows 21 write routes gated on Permission.AITO_CREATE/AITO_UPDATE/AITO_DELETE (create_project:869, add_note:1033, send_invoice_email:1166, send_quote_email:1399, add_task:1704, update_task:1905, delete_task:1973, reorder_tasks:2066, import_legacy_projects:2097, move_project:2149, update_project:2200, set_project_flag/contacted, pickup-message/sms, sync_project_now, set_quote_status, restore_project, delete_project:2509 among them). `grep -n '403' backend/tests/unit/test_aito_routes.py` returns exactly two tests, `test_create_with_a_decided_status_and_only_aito_create_is_403` and `test_add_task_with_a_ticked_step_and_only_aito_create_is_403` -- both narrow cross-permission scenarios (aito:create alone vs. a decided-status/ticked-step payload that also needs aito:update), not a check that a caller with NO aito permission, or only aito:read, is rejected outright. `grep -rln 'status_code == 403' backend/tests/unit/test_aito*.py` returns only test_aito_routes.py -- no hit in test_aito_shipping_routes.py, test_aito_quote_status.py, test_aito_quote_email.py, test_aito_invoice.py, or test_aito_task_reorder.py. The `_create_as` helper's own docstring in test_aito_routes.py states plainly: "async_client's default (auth disabled) makes current_user None and would skip the permission check entirely" -- confirming every other test in the ~2900-line file that uses the plain async_client fixture runs with the permission gate bypassed, not exercised. · fix: in backend/tests/unit/test_aito_routes.py, extend the existing _create_as-style dependency-override pattern into a parametrized sweep (e.g. test_write_route_rejects_a_caller_with_no_aito_permission) that hits each of the 21 write routes with a user holding permissions=[] (or only aito:read where a sibling permission exists) and asserts 403 -- at minimum cover update_project, delete_project, move_project, set_quote_status, add_task/update_task/delete_task, reorder_tasks and send_quote_email/send_invoice_email, since those touch board state or send real emails.
fingerprint: b1c4de050b0dacc0
source: audit-tests

## T-031
priority: P1
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 6
title: CALCULATOR_UPDATE gate on the calculator's actual write routes (filament/printer CRUD, defaults PATCH) is never tested to reject an unauthorized caller
files: backend/app/api/routes/calculator.py
evidence: backend/app/api/routes/calculator.py:78 · grep -n 'RequirePermissionIfAuthEnabled' backend/app/api/routes/calculator.py shows 8 routes gated on Permission.CALCULATOR_UPDATE: create_filament:78, update_filament:98, delete_filament:139, filament zoho-sync:159, create_printer:310, update_printer:326, delete_printer:346, update_defaults:396. `grep -rn '403\|permission' backend/tests/unit/test_calculator*.py` shows the only negative-permission test in the whole calculator test surface is TestZohoFilamentSearchRequiresCalculatorUpdate::test_calculator_read_only_caller_gets_403 in test_calculator_zoho_routes.py, which covers `GET /calculator/zoho-filaments` (a READ endpoint deliberately gated on UPDATE for confidentiality, per its own T-068 docstring) -- not one of the 8 actual mutating routes above. No test constructs a calculator:read-only (or permission-less) caller and asserts create_filament/update_filament/delete_filament/create_printer/update_printer/delete_printer/update_defaults reject it. · fix: in backend/tests/unit/test_calculator_zoho_routes.py (or a new backend/tests/unit/test_calculator_permissions.py), reuse the existing calculator_read_only_setup/calculator_update_setup fixtures to add a 403 test per mutating route -- POST/PATCH/DELETE /calculator/filaments, POST/PATCH/DELETE /calculator/printers, and PATCH /calculator/defaults -- confirming a calculator:read-only caller is rejected and a calculator:update caller succeeds.
fingerprint: 449ef2c653157931
source: audit-tests

## T-032
priority: P2
status: OPEN
attempts: 0
round: 2
first_seen_iteration: 5
last_touched_iteration: 5
title: test_wake_drains_a_pending_project_without_waiting_for_the_interval still races db_session against the worker's session on the shared StaticPool connection, ~1-in-10 under load ("Could not refresh instance")
files: backend/tests/unit/test_aito_quote_sync.py
evidence: backend/tests/unit/test_aito_quote_sync.py:2576 · backend/tests/conftest.py's test_engine fixture creates the engine from TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:" with no explicit poolclass; `./venv/bin/python3 -c "from sqlalchemy.ext.asyncio import create_async_engine; e=create_async_engine('sqlite+aiosqlite:///:memory:'); print(type(e.pool))"` prints `<class 'sqlalchemy.pool.impl.StaticPool'>` -- confirming the whole engine (and therefore both the test's own db_session and the aito_quote_sync worker's TrackedSession, both created from async_sessionmaker(test_engine, ...)) share exactly one physical aiosqlite connection with no serialization between checkouts. The test currently does `await asyncio.wait_for(drain_completed.wait(), timeout=30)` then immediately `await db_session.refresh(project)` (lines 2575-2576) BEFORE the live_sessions drain-wait loop that follows it (`for _ in range(100): if not live_sessions: break ...`, lines ~2580-2586). drain_completed fires the instant run_sync_once() RETURNS inside the worker's `async with async_session() as db:` block (run_sync_loop.py:1958-1960) -- that block's __aexit__ (db.close(), which issues a ROLLBACK/reset on the shared connection if the worker session auto-began a further transaction after its last commit, e.g. re-checking `_still_selected` for other rows) has NOT necessarily finished when drain_completed.set() runs. db_session.refresh() therefore races the worker session's own close/reset traffic on the SAME physical connection, occasionally landing its SELECT in a window where the shared connection has just been rolled back or reset, producing zero rows and SQLAlchemy's `InvalidRequestError: Could not refresh instance`. This is a distinct race from the one the TrackedSession/live_sessions pattern already fixed (that one guarded loop_task.cancel() against a mid-close cancellation; this one is the test's OWN refresh racing the worker's close, which the existing live_sessions wait only guards AFTER the refresh already ran). · fix: in backend/tests/unit/test_aito_quote_sync.py's test_wake_drains_a_pending_project_without_waiting_for_the_interval, reorder so the live_sessions drain-wait (`for _ in range(100): if not live_sessions: break; await asyncio.sleep(0.01)`) runs immediately after `await asyncio.wait_for(drain_completed.wait(), timeout=30)` and BEFORE `await db_session.refresh(project)` -- i.e. wait for the worker's TrackedSession to fully close (guaranteeing its close/reset traffic on the shared StaticPool connection has completed) before db_session touches that same connection. This does not weaken any assertion: the same three asserts (quote_id, quote_sync_state, not live_sessions) still run, only their order changes so the refresh can no longer interleave with the worker's own session teardown.
fingerprint: 5941bd2c76466aef
source: audit-tests

## T-033
priority: P2
status: OPEN
attempts: 0
round: 2
first_seen_iteration: 5
last_touched_iteration: 5
title: ZohoSettings' <label> elements have no for/id association, forcing ZohoSettings.test.tsx to select inputs by DOM structure instead of by label
files: frontend/src/components/ZohoSettings.tsx
evidence: frontend/src/components/ZohoSettings.tsx:134 · Every <label> in ZohoSettings.tsx (lines 134, 144, 160, 176, 186, 196, 206, 217) is a plain sibling of its <input> with no htmlFor/id or aria-labelledby, and no wrapping <label>...</label>. frontend/src/__tests__/components/ZohoSettings.test.tsx's own header comment confirms this was discovered while writing the tests: "The labels are plain siblings of their <input> (no for/id or wrapping), so testing-library's label-association queries can't find them. Walk from the label text node to the input in its own wrapper div instead" -- and its `inputForLabel` helper does exactly that: `screen.getByText(labelText).parentElement?.querySelector('input')`. This couples the test to ZohoSettings' current DOM nesting (a <div> wrapping one <label> and one <input>) rather than to its behavior; a markup refactor that keeps the same visible label/input pairing but changes the wrapper structure would silently break every test in the file even though nothing user-visible changed, and the tests can never be ported to getByLabelText or a real screen-reader label association. · fix: add htmlFor/id pairs to each label/input in frontend/src/components/ZohoSettings.tsx (e.g. htmlFor="zoho-client-id" / id="zoho-client-id"), then simplify frontend/src/__tests__/components/ZohoSettings.test.tsx to use screen.getByLabelText(...) in place of the inputForLabel DOM-walk helper. This is a production fix outside this auditor's authority to decide; filed per instructions for the user to approve (adding for/id changes only the accessibility tree, not visible rendering or any status code/permission/default, so no behavior_change flag applies under this lens's contract).
fingerprint: 0aef406ffa80744d
source: audit-tests

## T-034
priority: P2
status: OPEN
attempts: 0
round: 2
first_seen_iteration: 5
last_touched_iteration: 5
title: ZohoSettings' handleSave is only exercised for 2 of its 8 tracked fields, and the save mutation's own onError toast is untested
files: frontend/src/components/ZohoSettings.tsx
evidence: frontend/src/components/ZohoSettings.tsx:69 · frontend/src/__tests__/components/ZohoSettings.test.tsx types into Client ID and Client Secret only. `node -e "require('./coverage/coverage-final.json')..."` on ZohoSettings.tsx shows statement lines never executed: 69 (onError: (error) => showToast(error.message, 'error') on saveMutation itself), 79-82 (the organizationId/baseUrl/accountsUrl/defaultContactId diff checks in handleSave), 84 (the defaultContactName diff), 86 (the refreshToken -> payload.zoho_refresh_token branch), and 169/180/190/200/210/221 (the onChange handler bodies for refreshToken, organizationId, defaultContactId, defaultContactName, baseUrl and accountsUrl -- never invoked because no test types into those fields). refreshToken is Zoho's OTHER secret, parallel to zoho_client_secret which IS tested ("includes zoho_client_secret when the secret field is filled in") -- an identical omission bug specific to refreshToken's own branch would go undetected. The save mutation's onError is also distinct from, and untested unlike, the already-tested Test-connection probe's failure toast ("shows an error toast when the test-connection probe fails"). · fix: in frontend/src/__tests__/components/ZohoSettings.test.tsx, add a case typing into Refresh Token and asserting putBodies includes zoho_refresh_token (mirroring the existing Client Secret test), a case touching organizationId/defaultContactId/defaultContactName/baseUrl/accountsUrl to prove each diff branch fires, and a case where the PUT /api/v1/settings/ handler returns a 500/network error and asserts the resulting error toast from saveMutation's onError (distinct from the existing probe-failure test).
fingerprint: fd8f1ede07cf914a
source: audit-tests

## T-035
priority: P2
status: OPEN
attempts: 0
round: 2
first_seen_iteration: 5
last_touched_iteration: 5
title: useContactedMutation's transform/onSuccess/onError are never invoked by any test -- the mutation itself is never actually fired
files: frontend/src/hooks/useContactedMutation.ts
evidence: frontend/src/hooks/useContactedMutation.ts:29 · coverage-final.json for frontend/src/hooks/useContactedMutation.ts shows statement lines 31, 35, 37, 38, 40 never executed -- the `transform` optimistic-map callback (30-34), `flashId` (35), `onSuccess`'s setQueryData/invalidateQueries (37-38) and `onError`'s showToast (40) are all dead in the coverage run, meaning no test ever calls .mutate() on this hook and lets it resolve or fail. `grep -rn 'contactedFailed' frontend/src/__tests__` returns zero matches, confirming the failure-toast path specifically has no test. · fix: add or extend a test (e.g. frontend/src/__tests__/hooks/useContactedMutation.test.tsx, new file, mirroring the pattern in frontend/src/__tests__/hooks/useQuoteStatusMutation.test.tsx) that renders a component using useContactedMutation, fires the mutation for both a success (asserting the optimistic client_contacted_at prediction, then the server row replacing it via replaceProject) and a failure (asserting the aito.contactedFailed toast and that the optimistic write rolls back).
fingerprint: efa76f1047fac8d1
source: audit-tests

## T-036
priority: P2
status: OPEN
attempts: 0
round: 2
first_seen_iteration: 5
last_touched_iteration: 5
title: useFlagMutation's transform/flashId/onError are never invoked by any test
files: frontend/src/hooks/useFlagMutation.ts
evidence: frontend/src/hooks/useFlagMutation.ts:21 · coverage-final.json for frontend/src/hooks/useFlagMutation.ts shows statement lines 22 (transform), 23 (flashId) and 30 (onError's showToast) never executed, while onSuccess (24-28) is covered -- meaning some test exercises a successful flag mutation's server-row replacement but never a failing one, and never checks that the optimistic `{ ...p, flag }` prediction itself is applied. `grep -rn 'flagFailed' frontend/src/__tests__` returns zero matches. · fix: add a failure-path test for useFlagMutation (e.g. in frontend/src/__tests__/hooks/useFlagMutation.test.tsx, new file, or alongside the existing FlagControl component test) that sets api.setAitoProjectFlag to reject and asserts the aito.flagFailed toast and the optimistic flag value reverting; add an assertion on the optimistic transform itself (flag visible before the mutation resolves).
fingerprint: 9010a94383296579
source: audit-tests

## T-037
priority: P2
status: OPEN
attempts: 0
round: 2
first_seen_iteration: 5
last_touched_iteration: 5
title: useColumnMoveMutation's own optimistic transform (applyColumnMove) and onError are never invoked -- only its celebration onMutate/onSuccess are tested
files: frontend/src/hooks/useColumnMoveMutation.ts
evidence: frontend/src/hooks/useColumnMoveMutation.ts:46 · coverage-final.json for frontend/src/hooks/useColumnMoveMutation.ts shows statement lines 47 (`transform: (previous) => applyColumnMove(...)`) and 68 (`onError: () => showToast(t('aito.moveFailed'), 'error')`) never executed. `grep -n 'moveFailed' frontend/src/hooks/useBoardDrag.ts frontend/src/hooks/useColumnMoveMutation.ts` shows the SAME i18n key `aito.moveFailed` is used by two different hooks/mutations -- useBoardDrag's own moveMutation.onError (drag-reorder) IS covered, per frontend/src/__tests__/pages/AitoBoardDragFailure.test.tsx's own header ("grep moveFailed src/__tests__ was empty before this file") -- but that file only covers useBoardDrag's onError, not useColumnMoveMutation's (Finish<->Done manual move). A regression specific to useColumnMoveMutation's own onError or its optimistic applyColumnMove transform would pass every existing test. · fix: extend frontend/src/__tests__/components/AitoDoneCelebration.test.tsx (or add a sibling test) with a case where api.moveAitoProject rejects, asserting the aito.moveFailed toast and that the optimistic column move (applyColumnMove) rolls back with the revert flash; add a case asserting the card is optimistically shown in its destination column before the PATCH resolves.
fingerprint: f65a2b58cd1bf7d8
source: audit-tests

## T-038
priority: P2
status: OPEN
attempts: 0
round: 2
first_seen_iteration: 5
last_touched_iteration: 5
title: run_sync_loop's own per-tick exception swallow (both the periodic full pass and the wake-drain) is never exercised -- its docstring's core resilience promise is unverified
files: backend/app/services/aito_quote_sync.py
evidence: backend/app/services/aito_quote_sync.py:1930 · coverage: backend/app/services/aito_quote_sync.py 1928->1938, 1930-1933, 1939->1923, 1943, 1959->1939, 1961-1964, 1968 missing (from `pytest tests/ --cov=app --cov-config=../pyproject.toml --cov-report=term-missing`). Lines 1930-1933 are the periodic tick's `except Exception: logger.exception("Aito quote sync tick failed")`, and 1961-1964 are the identical guard around the wake-drain's `run_sync_once(db, pending_only=True)`. run_sync_loop's own docstring states: "Every iteration takes its own session and swallows its own errors: one bad tick must not kill the loop, or a single transient failure would silently end syncing until the next restart" -- but no test ever makes run_sync_once (or sync_interval_seconds/sync_enabled/zoho_service.is_configured) raise from inside run_sync_loop and then asserts the loop survives and ticks again. · fix: in backend/tests/unit/test_aito_quote_sync.py, add a test driving the real run_sync_loop (mirroring test_wake_drains_a_pending_project_without_waiting_for_the_interval's TrackedSession harness) that monkeypatches run_sync_once to raise on its first call and succeed on its second, and asserts the loop is still alive and drains a pending project on the following tick/wake -- covering both the periodic-tick except block and the wake-drain except block separately.
fingerprint: d1bdabee7959f6f5
source: audit-tests

## T-039
priority: P2
status: OPEN
attempts: 0
round: 2
first_seen_iteration: 5
last_touched_iteration: 5
title: sync_project's ShippingCatalogueUnavailable handler swallows an unexpected exception from its shipping-catalogue warm-up, but that fallback is never exercised
files: backend/app/services/aito_quote_sync.py
evidence: backend/app/services/aito_quote_sync.py:1457 · coverage: backend/app/services/aito_quote_sync.py 1457-1471 missing. That range is the `try: await zoho_service.get_shipping_catalogue(db, refresh=True) except Exception: logger.warning("Aito shipping catalogue warm-up failed for project %s", project_id, exc_info=True)` block inside the `except ShippingCatalogueUnavailable` handler, whose own comment explains the stakes: "a DB error from its get_setting/set_setting calls, or a bug in merge_shipping_catalogue on a pathological /items payload, would otherwise escape uncaught ... breaking its own 'never raises' promise ... abort[ing] the whole tick for every project still left in the batch." No test makes get_shipping_catalogue raise something other than the already-swallowed ZohoNotConfiguredError/ZohoUpstreamError while a project is deferring on ShippingCatalogueUnavailable. · fix: in backend/tests/unit/test_aito_quote_sync.py, add a test that defers a project via ShippingCatalogueUnavailable and monkeypatches zoho_service.get_shipping_catalogue to raise a non-Zoho exception (e.g. a bare RuntimeError, simulating a DB error), asserting sync_project still returns normally (does not propagate), the project stays in its deferred state, and run_sync_once still processes the rest of that tick's batch.
fingerprint: 1d1ca41381fec076
source: audit-tests

