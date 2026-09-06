# PLAN (schema v2)

## T-001
priority: P3
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 6
title: ZohoSettings form fields still have no label/input association (htmlFor/id), unlike every sibling Aito/Calculator form
files: frontend/src/components/ZohoSettings.tsx
evidence: frontend/src/components/ZohoSettings.tsx:134 · Still true at HEAD (re-checked, not fixed since campaign 10's T-023/T-033): all 8 text/password inputs in ZohoSettings.tsx (lines 134-224: clientId, clientSecret, refreshToken, organizationId, defaultContactId, defaultContactName, baseUrl, accountsUrl) render `<label className=...>{t('zoho.clientId')}</label>` as a plain sibling of `<input>` with no `htmlFor`/`id` pair. frontend/src/__tests__/components/ZohoSettings.test.tsx still defines a custom `inputForLabel()` DOM-walk helper ('The labels are plain siblings of their <input> ... testing-library's label-association queries can't find them') because getByLabelText does not work. By contrast, frontend/src/components/aito/NewContactForm.tsx (lines 105,121,136,157,176), frontend/src/components/aito/ClientSection.tsx (116,167), and frontend/src/components/calculator/CalculatorInputsCard.tsx (31,111,232,253) all use htmlFor/id in the same feature scope. · fix: add a matching id to each ZohoSettings input and htmlFor to its label (or wrap each input in its label), matching NewContactForm/ClientSection/CalculatorInputsCard's convention; then ZohoSettings.test.tsx's inputForLabel DOM-walk helper can be replaced with screen.getByLabelText. · user-visible change: purely additive markup (id + htmlFor) with no visual change for a sighted mouse user, but it changes what a screen reader announces when focusing these fields and what testing-library's getByLabelText can find.
fingerprint: fc2108c175f8f5bd
source: audit-cleanliness
reason: user-approved behavior change

## T-002
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: _fold() accent/case-normalization helper duplicated between aito_shipping.py and aito_quote_import.py
files: backend/app/services/aito_shipping.py
evidence: backend/app/services/aito_shipping.py:94 · backend/app/services/aito_shipping.py:94-99 defines `_fold(value)` doing `unicodedata.normalize("NFKD", (value or "").strip().lower())` then stripping combining marks; backend/app/services/aito_quote_import.py:73-76 defines its own `_fold(value)` doing `unicodedata.normalize("NFD", value)` then stripping combining marks and lower-casing at the end. Both exist for the identical purpose (case/accent-insensitive matching of a label read back off a Books quote line) and aito_shipping.py's own docstring at line 96 admits it: 'Same idea as the importer's own `_fold`: a label read back out of a quote may have been retyped by a human in Books.' `rg -n "unicodedata.normalize" backend/app/services/*.py` -> only these two definitions in the whole tree. · fix: move one _fold(value) implementation (pick NFKD+strip+lower, the more defensive of the two — it survives a None input, which aito_quote_import.py's version does not) into a small shared module (e.g. backend/app/utils/text.py) and import it from both aito_shipping.py and aito_quote_import.py instead of keeping two hand-synced copies.
fingerprint: 44937810592d4523
source: audit-cleanliness

## T-003
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: useDueDateMutation re-implements settleProject() by hand instead of calling the shared helper
files: frontend/src/hooks/useDueDateMutation.ts
evidence: frontend/src/hooks/useDueDateMutation.ts:19 · frontend/src/hooks/useDueDateMutation.ts:19-23 (`onSuccess`) writes `queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) => prev?.map((p) => (p.id === row.id ? row : p)) ?? prev); queryClient.invalidateQueries({ queryKey: ['aito-events', project.id] });` — exactly the two-statement body of frontend/src/components/aito/settleProject.ts's `settleProject(queryClient, projectId, row)`, which six sibling hooks (useContactedMutation, useFlagMutation, useColumnMoveMutation, useQuoteStatusMutation, useSendQuoteMutation, components/aito/useProjectPatchMutation.ts) already call instead of writing this out. `rg -n "settleProject" frontend/src -l` shows useDueDateMutation.ts is not among the callers even though its shape matches exactly. useDueDateMutation.ts was added with the 2026-09-04 due-date feature, after settleProject was extracted by campaign 10. · fix: replace the two lines in useDueDateMutation.ts's onSuccess with `settleProject(queryClient, project.id, row)`, matching the other single-project mutation hooks.
fingerprint: 3dd40034dcab91cc
source: audit-cleanliness

## T-006
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: sweep_invoices() swallows a Books 429 and keeps calling for every remaining project
files: backend/app/services/aito_invoice_sweep.py
evidence: backend/app/services/aito_invoice_sweep.py:66 · `except (ZohoUpstreamError, ValueError, TypeError, KeyError) as exc: logger.warning("Invoice sweep skipped project %s: %s", project.id, exc); continue` — `ZohoRateLimited` is a subclass of `ZohoUpstreamError` (services/zoho.py:109), so a 429 on the first project is logged as a skip and the loop issues `list_project_invoices` for every remaining open receivable, one 429 at a time. The sweep also neither reads nor sets `aito_quote_sync._throttled_until`: `run_sync_loop` calls `await sweep_invoices(db)` (aito_quote_sync.py:2130) unconditionally right after `run_sync_once`, which itself returns 0 without touching Books while throttled (aito_quote_sync.py:1881). So on a throttled org the tick that spends zero sync calls still spends N invoice calls, deepening the throttle — the exact failure `sync_project`'s `return True` / `break` pair was added to prevent — and a 429 seen only by the sweep never arms the throttle for the sync path either. · fix: catch `ZohoRateLimited` ahead of the generic handler and break out of the project loop (committing what is already refreshed), arm `_throttled_until` the same way `sync_project`'s handler does, and have `run_sync_loop` skip `sweep_invoices` while the throttle window is open. · user-visible change: during a Zoho rate-limit window the invoice cards refresh later than they do today (the sweep stops after the first 429 instead of trying every project), and a 429 observed by the sweep would additionally pause the quote sync for the backoff window.
fingerprint: 282b5345ac091e30
source: audit-robustness
reason: user-approved behavior change

## T-007
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: sweep_invoices() never clears the cached invoice fields when Books reports no invoice
files: backend/app/services/aito_invoice_sweep.py
evidence: backend/app/services/aito_invoice_sweep.py:56 · `invoices = await zoho_service.list_project_invoices(...)` then `if invoices:` guards all three writes, with no `else` — but the row is still stamped `project.invoice_checked_at = _now()` and counted as `updated += 1`. When an invoice is deleted (or its estimate/customer link removed) in Books, Books answers `[]` and the project keeps its last-seen `invoice_status`/`invoice_balance`/`invoice_due_date` forever. Because the selection is `or_(invoice_balance.is_(None), invoice_balance > 0)` (line 49), that row also never drops out of the sweep: it costs one Books call every hour for the life of the card, and the board's `unpaid` follow-up chip keeps chasing a client for an invoice that no longer exists — while `invoice_checked_at` tells the operator it was just verified. · fix: add the `else` branch that resets `invoice_status`/`invoice_balance`/`invoice_due_date` to None when `invoices` is empty, and only count/stamp a project the call actually refreshed. · user-visible change: a card whose Books invoice has been deleted would lose its cached invoice status/balance/due date and disappear from the unpaid follow-up chip, instead of showing the last figures it ever saw.
fingerprint: 44d15e1437802c55
source: audit-robustness
reason: user-approved behavior change

## T-008
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: the unpaid follow-up rule compares invoice_due_date as a string without checking it is ISO
files: frontend/src/utils/aitoFollowups.ts
evidence: frontend/src/utils/aitoFollowups.ts:63 · `if (!(p.invoice_due_date < today)) return null;` followed by `Math.round((parseLocalDateKey(today).getTime() - parseLocalDateKey(p.invoice_due_date).getTime()) / DAY_MS)`. `invoice_due_date` is whatever Books echoed — `_map_invoice` stores `invoice.get("due_date", "")` verbatim (services/zoho.py:237) and the sweep writes it unvalidated — and this repo has already been bitten by a non-ISO Books date: `_backfill_aito_quote_sent_at` in core/database.py guards `quote_date` with a GLOB because "a non-ISO value like '10/02/2026'" was real. A `'10/02/2026'` due date sorts lexically below any `'2026-…'` today, so the invoice is flagged overdue on every board no matter its real date; `parseLocalDateKey('10/02/2026')` then yields an Invalid Date, so `days` is NaN, the chip's "longest wait" label silently disappears (`NaN > 0` is false) and the bucket's sort comparator returns NaN, making the chase order arbitrary. The sibling consumer `dueDateLevel` (utils/aitoAging.ts) already guards with `ISO_DATE.test(dueDate)`; this rule does not. · fix: apply the same `/^\d{4}-\d{2}-\d{2}$/` test to `p.invoice_due_date` before the comparison and return null when it fails, matching `dueDateLevel`. · user-visible change: an invoice whose Books due date is not in YYYY-MM-DD form would stop appearing in the unpaid follow-up chip instead of always appearing there as overdue.
fingerprint: 8c87b3eca3e8f7a9
source: audit-robustness
reason: user-approved behavior change

## T-009
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: the follow-up buckets never re-age: `Date.now()` and today's key are captured inside a useMemo keyed only on board data
files: frontend/src/pages/AitoPage.tsx
evidence: frontend/src/pages/AitoPage.tsx:100 · `const buckets = useMemo(() => followups(aitoQuery.data ?? [], thresholds, Date.now(), localDateKey(new Date())), [aitoQuery.data, thresholds.quoteDays, thresholds.pickupDays]);` — the clock and the calendar day are read inside the memo but are not deps. React Query's default structural sharing keeps `aitoQuery.data` referentially identical across a refetch that returns unchanged rows, so on a board left open with no writes (overnight, a weekend, a wall display) the memo never re-runs: a quote crossing `quoteDays`, a finished job crossing `pickupDays`, and an invoice falling due at midnight never appear, and the counts and `maxDays` shown are those of the last time the board data actually changed. The operator's morning chase list is yesterday's until something else edits the board. · fix: drive the memo from a ticking value — e.g. a state holding `Date.now()`/`localDateKey(new Date())` refreshed on an interval (and on visibilitychange) — and list it in the dependency array. · user-visible change: follow-up chips would appear, change count and update their "longest wait" figure on their own while the board sits untouched, where today they only move when the board data changes.
fingerprint: d9d47d6246c6cd55
source: audit-robustness
reason: user-approved behavior change

## T-010
priority: P3
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 6
title: sweep_invoices() burns the hourly slot before doing the work and commits the whole pass at once
files: backend/app/services/aito_invoice_sweep.py
evidence: backend/app/services/aito_invoice_sweep.py:43 · `_last_run = time.monotonic()` is assigned at line 43, before a single project is read, and the pass ends with a single `if updated: await db.commit()` (lines 71-72). A SQLite "database is locked" at that commit — a failure this codebase treats as real enough to guard for explicitly elsewhere (see the `except SQLAlchemyError` blocks in routes/aito.py's send_invoice_email and send_pickup_sms) — propagates to `run_sync_loop`'s `except Exception: logger.exception("Aito quote sync tick failed")`, discarding every project's refreshed status/balance/due date; because the hourly slot was already spent, nothing retries for another hour and the log entry reads as a whole-tick failure even though the quote sync half succeeded. `run_sync_once` deliberately commits per project to avoid exactly this coupling. · fix: commit per project (or set `_last_run` only once the pass has committed) so a locked database costs one project rather than the whole hour. · user-visible change: after a failed sweep the invoice cache would be retried on the next 300s tick instead of an hour later, and a mid-pass failure would leave the projects already processed persisted rather than discarding all of them.
fingerprint: 0cef67ff5a98f67d
source: audit-robustness
reason: user-approved behavior change

## T-011
priority: P3
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 6
title: aito_presence message handler is not gated on the connection's aito_read stamp
files: backend/app/api/routes/websocket.py
evidence: backend/app/api/routes/websocket.py:197 · elif data.get("type") == "aito_presence": ... await ws_manager.set_aito_presence(websocket, pid if isinstance(pid, int) and not isinstance(pid, bool) else None) — no `websocket.state.aito_read` check, unlike the outbound paths (routes/websocket.py:166 `if websocket.state.aito_read:` and core/websocket.py:138 `if not getattr(connection.state, "aito_read", True):`) · fix: ignore the aito_presence message when websocket.state.aito_read is False, so only principals holding AITO_READ can enter the viewers map · user-visible change: a websocket principal without aito:read (an API-key connection, or a user whose role lacks the permission) currently has its 'viewing project N' ping accepted and its username fanned out to every authorized operator's board; after the fix that ping becomes a silent no-op and the name disappears from their presence indicators.
fingerprint: 6a4a96f893b5d21e
source: audit-security
reason: user-approved behavior change

## T-012
priority: P3
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 7
title: /aito route is registered without a PermissionRoute guard
files: frontend/src/App.tsx
evidence: frontend/src/App.tsx:272 · <Route path="aito" element={<AitoPage />} /> — compare the sibling on line 269: <Route path="calculator" element={<PermissionRoute permission="calculator:read"><CalculatorPage /></PermissionRoute>} />. Layout.tsx:330 maps the nav item to 'aito:read', so only the sidebar entry is hidden; direct navigation still mounts the board. · fix: wrap AitoPage in <PermissionRoute permission="aito:read"> to match the calculator route (backend already enforces AITO_READ on every endpoint, so this is defence in depth only) · user-visible change: a signed-in user without aito:read who navigates directly to /aito currently sees an empty board whose requests 403 in the background; afterwards they get the no-permission page instead.
fingerprint: 897a93000c7d69d7
source: audit-security
reason: user-approved behavior change

## T-013
priority: P3
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 7
title: get_invoice_pdf builds Content-Disposition without the control-character strip get_quote_pdf applies
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1361 · filename = f"{invoice['number'] or invoice['id']}.pdf" followed directly by headers={"Content-Disposition": build_content_disposition(filename, disposition="inline")} — get_quote_pdf (aito.py:1656-1657) does the same interpolation but adds `filename = _CONTROL_CHARS_RE.sub("", filename)` first, and that regex's own comment states control characters 'survive build_content_disposition's own stripping (it only drops non-ASCII, quotes, and backslashes)'. · fix: apply _CONTROL_CHARS_RE.sub("", filename) to the invoice filename as well, so both PDF proxies sanitize upstream Books text identically · user-visible change: for an invoice whose Books number contains an ASCII control character, the ascii-fallback filename in the response header would change (and, for CR/LF, an aborted response would become a normal one) — no observable change for any ordinary invoice number.
fingerprint: cd214f59016e693c
source: audit-security
reason: user-approved behavior change

## T-015
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: test_wake_drains_a_pending_project_without_waiting_for_the_interval still refreshes before the worker session drains, racing the shared StaticPool connection
files: backend/tests/unit/test_aito_quote_sync.py
evidence: backend/tests/unit/test_aito_quote_sync.py:2759 · backend/tests/unit/test_aito_quote_sync.py:2758-2767: `await asyncio.wait_for(drain_completed.wait(), timeout=30)` (2758) is immediately followed by `await db_session.refresh(project)` (2759), and only AFTER that does the test wait for the worker's session to close: `for _ in range(100): if not live_sessions: break; await asyncio.sleep(0.01)` (2763-2766). The in-memory engine is a StaticPool (`./venv/bin/python3 -c "from sqlalchemy.ext.asyncio import create_async_engine; e=create_async_engine('sqlite+aiosqlite:///:memory:'); print(type(e.pool))"` -> StaticPool), so db_session and the worker's TrackedSession share one physical aiosqlite connection. drain_completed fires the instant run_sync_once() RETURNS inside the worker's `async with async_session() as db:` block, before that block's __aexit__ (db.close(), which can issue a ROLLBACK/reset on the shared connection) has necessarily finished — so db_session.refresh() at 2759 can land on a connection mid-reset and raise `InvalidRequestError: Could not refresh instance`, matching campaign 10's still-open T-032 and the task brief's own KNOWN_FLAKY note for this exact test. · fix: in backend/tests/unit/test_aito_quote_sync.py's test_wake_drains_a_pending_project_without_waiting_for_the_interval, move the `for _ in range(100): if not live_sessions: break; await asyncio.sleep(0.01)` / `assert not live_sessions` block to run immediately after `await asyncio.wait_for(drain_completed.wait(), timeout=30)` and before `await db_session.refresh(project)`, so the refresh cannot interleave with the worker session's own close/reset traffic on the shared connection. The same three asserts still run, only reordered.
fingerprint: 8a20a7f8afc5b638
source: audit-tests

## T-016
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: ZohoSettings' handleSave is exercised for only 2 of 8 tracked fields, and saveMutation's own onError toast is untested
files: frontend/src/components/ZohoSettings.tsx
evidence: frontend/src/components/ZohoSettings.tsx:69 · frontend/src/__tests__/components/ZohoSettings.test.tsx types only into 'Client ID' (line 60) and 'Client Secret' (line 74); grep for 'Refresh Token' / 'organizationId' / 'defaultContactId' / 'defaultContactName' / 'baseUrl' / 'accountsUrl' in that file returns nothing. ZohoSettings.tsx's handleSave (lines 76-89) has one independent diff-check per field, including `if (refreshToken) payload.zoho_refresh_token = refreshToken;` (line 87) which is the exact sibling of the tested `zoho_client_secret` branch (line 86) but has no test of its own. The file's only failure-toast test (lines 97-120) exercises the Test-connection probe's catch block, not `saveMutation`'s own `onError: (error) => showToast(error.message, 'error')` (line 69) — no test makes PUT /api/v1/settings/ fail. · fix: in frontend/src/__tests__/components/ZohoSettings.test.tsx, add a case typing into Refresh Token and asserting putBodies includes zoho_refresh_token (mirroring the existing Client Secret case), a case touching organizationId/defaultContactId/defaultContactName/baseUrl/accountsUrl to prove each diff branch fires, and a case where the PUT /api/v1/settings/ handler returns a 500 and asserts the resulting error toast from saveMutation's onError (distinct from the existing probe-failure test).
fingerprint: 145598da65f2bd50
source: audit-tests

## T-017
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: useContactedMutation's transform/onSuccess/onError are never invoked by any test — the mutation is fired but never allowed to resolve
files: frontend/src/hooks/useContactedMutation.ts
evidence: frontend/src/hooks/useContactedMutation.ts:22 · frontend/src/__tests__/components/AitoBoardCardActions.test.tsx:438 does `vi.spyOn(api, 'setAitoProjectContacted').mockImplementation(() => new Promise(() => {}))` — a promise that never settles — and the only assertion in that test (line 458, 'fires the contact mutation only once the 500ms hold completes') is `expect(spy).toHaveBeenCalledWith(12, true)`. `grep -rln 'useContactedMutation|setAitoProjectContacted|contactedFailed' frontend/src/__tests__` returns only that one file, so useContactedMutation.ts's `transform` (line 27-31), `onSuccess` (line 32, settleProject) and `onError` (line 33, `showToast(t('aito.contactedFailed'), 'error')`) are dead in every test run. · fix: add frontend/src/__tests__/hooks/useContactedMutation.test.tsx (new file, mirroring frontend/src/__tests__/hooks/useQuoteStatusMutation.test.tsx's pattern of rendering a component through the real hook rather than only spying on the API call) with a success case (mockResolvedValue, asserting the optimistic client_contacted_at prediction then the server row replacing it) and a failure case (mockRejectedValue, asserting the aito.contactedFailed toast and the optimistic write rolling back).
fingerprint: a091807112f220a4
source: audit-tests

## T-018
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 4
title: useFlagMutation's optimistic transform and onError are never invoked — every FlagControl test resolves the mutation successfully
files: frontend/src/hooks/useFlagMutation.ts
evidence: frontend/src/hooks/useFlagMutation.ts:21 · frontend/src/__tests__/components/FlagControl.test.tsx spies on `api.setAitoProjectFlag` with `mockResolvedValue({} as AitoProject)` in every one of its ~14 mutation-firing tests (e.g. lines 100, 118, 132, 147, 163, 178, 193, 209, 233); none rejects it. `grep -rn 'flagFailed' frontend/src/__tests__` returns zero matches. useFlagMutation.ts's `transform: (previous, flag) => previous?.map(...)` (line 22-23) and `onError: () => showToast(t('aito.flagFailed'), 'error')` (line 30) are consequently never exercised, and no test asserts the optimistic `flag` value is visible on the board cache before the mocked promise resolves. · fix: in frontend/src/__tests__/components/FlagControl.test.tsx (or a new frontend/src/__tests__/hooks/useFlagMutation.test.tsx), add a case where setAitoProjectFlag rejects and assert the aito.flagFailed toast plus the optimistic flag reverting, and a case asserting the optimistic flag is applied to the board cache before the mocked promise resolves.
fingerprint: 041b5448aeaa92b1
source: audit-tests

## T-019
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 4
title: useColumnMoveMutation's own optimistic transform (applyColumnMove) and onError are never invoked — only useBoardDrag's separate onError for the same toast key is covered
files: frontend/src/hooks/useColumnMoveMutation.ts
evidence: frontend/src/hooks/useColumnMoveMutation.ts:47 · `grep -rn 'moveFailed' frontend/src/__tests__` finds only frontend/src/__tests__/pages/AitoBoardDragFailure.test.tsx, whose own header comment states it covers `useBoardDrag`'s onError for a drag-reorder, not useColumnMoveMutation's Finish<->Done move. Every test that fires this hook's mutation (AitoDoneCelebration.test.tsx:73 `mockResolvedValue(project({ column: 'done' }))`; AitoDoneGrid.test.tsx:154 and ProjectDetailPanel.test.tsx:2081 and AitoBoardCardActions.test.tsx:345, all `mockImplementation(() => new Promise(() => {}))`) either resolves it or leaves it pending forever — none rejects `api.moveAitoProject`. useColumnMoveMutation.ts's `transform: (previous) => applyColumnMove(previous, project.id, column)` (line 47) and `onError: () => showToast(t('aito.moveFailed'), 'error')` (line 68) are therefore dead code in every test run. · fix: extend frontend/src/__tests__/components/AitoDoneCelebration.test.tsx (or add a sibling test) with a case where api.moveAitoProject rejects, asserting the aito.moveFailed toast and that the optimistic column move rolls back with the revert flash; add a case asserting the card is optimistically shown in its destination column (via applyColumnMove) before the PATCH resolves.
fingerprint: 1834dd3543fe4bf1
source: audit-tests

## T-020
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 4
title: useDueDateMutation's onSuccess board-cache write and onError toast are never invoked by DueDateControl.test.tsx
files: frontend/src/hooks/useDueDateMutation.ts
evidence: frontend/src/hooks/useDueDateMutation.ts:18 · `npx vitest run src/__tests__/components/DueDateControl.test.tsx --coverage --coverage.include='src/hooks/useDueDateMutation.ts'` reports 69.23% statements / 33.33% branches with 'Uncovered Line #s: 18,25'. Line 18 is `queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) => ...)` inside onSuccess, and line 25 is `onError: () => showToast(t('aito.dueDateFailed'), 'error')`. Every test in DueDateControl.test.tsx calls `vi.spyOn(api, 'setAitoProjectDueDate').mockResolvedValue(...)` and asserts only that the spy was called with the right args (e.g. line 76 `expect(spy).toHaveBeenCalledWith(12, '2026-09-12')`) — none asserts the returned row lands in the board cache, and none rejects the call to exercise the failure toast. `grep -rn 'dueDateFailed' frontend/src/__tests__` returns zero matches. · fix: in frontend/src/__tests__/components/DueDateControl.test.tsx, add a case where setAitoProjectDueDate rejects and assert the aito.dueDateFailed toast fires and the optimistic due_date rolls back, and a case asserting the query cache for ['aito-projects'] reflects the server's returned row after a successful save.
fingerprint: 3191b89e9dfca020
source: audit-tests

## T-021
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 5
title: run_sync_loop's per-tick exception swallow (both the periodic pass and the wake-drain) is still never exercised
files: backend/app/services/aito_quote_sync.py
evidence: backend/app/services/aito_quote_sync.py:2102 · coverage: `pytest tests/unit/test_aito_quote_sync.py --cov=backend.app.services.aito_quote_sync --cov-config=../pyproject.toml --cov-report=term-missing` -> `app/services/aito_quote_sync.py ... Missing ... 2102-2103 ... 2162-2165`. Lines 2102-2103 are the periodic tick's `except Exception: logger.exception("Aito quote sync tick failed")` inside run_sync_loop, and lines 2162-2165 (`except asyncio.CancelledError: raise` / `except Exception: logger.exception("Aito quote sync wake drain failed")`) are the identical guard around the wake-drain's `run_sync_once(db, pending_only=True)` call. run_sync_loop's own docstring states 'one bad tick must not kill the loop, or a single transient failure would silently end syncing until the next restart' — this is the exact resilience promise, and it is untested in both places (matches campaign 10's still-open T-038). · fix: in backend/tests/unit/test_aito_quote_sync.py, add a test driving the real run_sync_loop (reusing test_wake_drains_a_pending_project_without_waiting_for_the_interval's TrackedSession harness) that monkeypatches run_sync_once to raise on its first call and succeed on its second, asserting the loop survives and drains a pending project on the following tick/wake — once for the periodic-tick except block, once for the wake-drain except block.
fingerprint: f69199bd46df39d1
source: audit-tests

## T-022
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 5
title: sync_project's ShippingCatalogueUnavailable warm-up fallback (a second, non-Zoho exception during the retry) is still never exercised
files: backend/app/services/aito_quote_sync.py
evidence: backend/app/services/aito_quote_sync.py:1560 · coverage: `app/services/aito_quote_sync.py` term-missing report shows '1563-1577 missing'. That range is `try: await zoho_service.get_shipping_catalogue(db, refresh=True) except Exception: logger.warning("Aito shipping catalogue warm-up failed for project %s", project_id, exc_info=True)` (lines 1559-1577) inside the `except ShippingCatalogueUnavailable` handler. Its own comment explains the stakes: without this except, a DB error or a bug in merge_shipping_catalogue 'would abort the whole tick for every project still left in the batch.' `grep -n 'ShippingCatalogueUnavailable|warm-up' backend/tests/unit/test_aito_quote_sync.py` shows only a direct `pytest.raises(ShippingCatalogueUnavailable)` test (line 5195) — no test makes the warm-up's own get_shipping_catalogue call raise a second, unrelated exception while a project is deferring. Matches campaign 10's still-open T-039. · fix: in backend/tests/unit/test_aito_quote_sync.py, add a test that defers a project via ShippingCatalogueUnavailable and monkeypatches zoho_service.get_shipping_catalogue to raise a bare RuntimeError on the warm-up retry, asserting sync_project still returns normally (does not propagate), the project stays deferred, and run_sync_once still processes the rest of that tick's batch.
fingerprint: 825daf2466f63fa0
source: audit-tests

## T-023
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 5
title: create_project's quote_sent_at backdate for an imported already-sent/accepted/declined quote is executed by tests but never asserted
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:991 · backend/app/api/routes/aito.py:990-991: `if payload.quote_status in AWAY_STATUSES or payload.quote_status in ("accepted", "declined"): project.quote_sent_at = created_at or datetime.now(timezone.utc).replace(tzinfo=None)`. This stamps the clock the 'quotes out' follow-up bucket (utils/aitoFollowups.ts) reads. `backend/tests/unit/test_aito_routes.py` calls `_create(async_client, quote_status="sent")` at lines 2097, 2144, 2486 and 2703 — each one runs this exact branch — but none of those tests, nor any other in the file (`grep -n 'quote_sent_at' tests/unit/test_aito_routes.py` shows only one unrelated null-field assertion at line 1026), ever reads back `quote_sent_at` on the created project. A regression that drops the OR clause, mis-orders `created_at or datetime.now(...)`, or breaks `_imported_created_at`'s quote_date parsing would pass every current test while silently making imported already-sent quotes invisible to the follow-up bucket forever (no clock, no re-derivation path). · fix: in backend/tests/unit/test_aito_routes.py, add a test that POSTs to /api/v1/aito/ with quote_status='sent' (and quote_id/quote_date set, to exercise the created_at-backdate branch) and asserts the response's quote_sent_at equals the backdated created_at; add a sibling asserting a bare draft (quote_status omitted/'draft') leaves quote_sent_at null.
fingerprint: bdd3107828c69cd5
source: audit-tests

## T-024
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 7
last_touched_iteration: 8
title: ISO_DATE regex duplicated verbatim between aitoFollowups.ts and aitoAging.ts
files: frontend/src/utils/aitoFollowups.ts
evidence: frontend/src/utils/aitoFollowups.ts:36 · frontend/src/utils/aitoFollowups.ts:36: `const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;` (added in loop-2's T-007 ISO guard) vs frontend/src/utils/aitoAging.ts:97: `const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;` — byte-identical regex, same name, same purpose (reject a non-ISO due-date string from Books before comparing it to `today`). aitoFollowups.ts's own comment at line 35 admits it: 'Same shape as aitoAging.ts's ISO_DATE.' `rg -n "ISO_DATE" frontend/src` shows only these two definitions, no shared import. · fix: extract a single `isIsoDateString` (or exported `ISO_DATE`) into a shared date util (e.g. a new tiny export from an existing frontend/src/utils date module) and have both files import it instead of each declaring its own copy.
fingerprint: 3e4b5f664f3634c8
source: audit-cleanliness

## T-025
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 7
last_touched_iteration: 8
title: Four new mutation-hook test files (useContactedMutation, useFlagMutation, useColumnMoveMutation, useDueDateMutation) re-paste identical mock/harness boilerplate instead of sharing a fixture
files: frontend/src/__tests__/hooks/useContactedMutation.test.tsx
evidence: frontend/src/__tests__/hooks/useContactedMutation.test.tsx:1 · All four files (added in loop-3/loop-4, ~116-141 lines each) repeat, nearly verbatim: the `vi.mock('react-i18next', ...)` block returning the raw key, the `showToastMock` + `vi.mock('../../contexts/ToastContext', ...)` block, the `vi.mock('../../hooks/useRevertFlash', ...)` block with its identical justifying comment ('The wrapper imports flashRevert as a direct binding...'), and a `renderXHook(project)` helper that builds a `QueryClient`, seeds `['aito-projects']`, and wraps in `QueryClientProvider`. Each file's own header comment names the one(s) it copied from ('Mirrors useContactedMutation.test.tsx's mocks...'), confirming the copy-paste lineage. The same shape also appears (with small variations) in the pre-existing useQuoteStatusMutation.test.tsx, useSendQuoteMutation.test.tsx and useSendInvoiceMutation.test.tsx, so this round's four additions bring the count of near-identical harnesses to seven. · fix: extract a shared test helper (e.g. frontend/src/__tests__/hooks/mutationTestHarness.ts) exporting `mockI18nAndToast()` / `renderBoardMutationHook(hookFn, project)` and `flashRevert` mock setup, and have the four new files (plus the three pre-existing ones, opportunistically) import it instead of repeating the block.
fingerprint: 7fccdbca1a55c600
source: audit-cleanliness

## T-026
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 7
last_touched_iteration: 9
title: sweep_invoices() restarts from the head of an unordered selection after an aborted pass, so the tail never refreshes
files: backend/app/services/aito_invoice_sweep.py
evidence: backend/app/services/aito_invoice_sweep.py:76 · `stmt = select(AitoProject).where(...)` has no `order_by` and no filter on `invoice_checked_at`, and (T-010) `_last_run = time.monotonic()` now runs only after the loop completes. So an abort part-way through (the `raise` in `except ZohoRateLimited`, or an escaping `db.commit()` error) leaves the hourly gate unspent and the NEXT 300 s tick re-selects the identical rows in the identical order and re-calls Books for the head projects it already refreshed. The project's own test pins this: after the commit failure it asserts `updated == 2`, i.e. EST-GOOD is fetched from Books a second time. With ~40 open receivables and Books cutting the org off at request N, the sweep burns N calls every tick (12x/hour at the default poll, more if `aito_quote_poll_seconds` is lowered to its floor of 10) and projects past N are never refreshed at all for as long as the limit holds — their cards keep showing a paid invoice as unpaid and the follow-ups strip keeps nagging about it. · fix: add `.order_by(AitoProject.invoice_checked_at.asc().nulls_first(), AitoProject.id)` so each pass resumes with the least-recently-checked rows, and/or stamp `_last_run` when the pass made partial progress · user-visible change: after an interrupted sweep the projects that refresh first change (least-recently-checked instead of lowest id), and a partially-completed pass may no longer retry on the very next tick.
fingerprint: 41b9fcfe4ff62484
source: audit-robustness
reason: user-approved behavior change

## T-027
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 7
last_touched_iteration: 9
title: the per-project commit in sweep_invoices() is unguarded, so one locked write aborts every project after it
files: backend/app/services/aito_invoice_sweep.py
evidence: backend/app/services/aito_invoice_sweep.py:125 · `await db.commit()` sits bare at the end of the loop body under the comment "A failure on this specific commit (SQLite \"database is locked\", for example) then costs only this one project instead of discarding every project already refreshed earlier in the same pass." Only the *already-committed* half is true: the exception is caught by nothing in this function, so it unwinds the whole loop. On a board of 30 open receivables, a lock contended with the sync worker on project 2 leaves projects 3-30 unrefreshed for that pass and surfaces upstream only as run_sync_loop's generic `logger.exception("Aito quote sync tick failed")`, which names neither the sweep nor the project. · fix: wrap the per-project commit in `try/except SQLAlchemyError`, `await db.rollback()`, log the project id, and `continue` — matching the treatment the upstream/malformed-payload branch already gets · user-visible change: a commit failure on one project no longer stops the sweep: the remaining projects are refreshed in the same pass and the hourly slot is then spent, so the next tick does not re-run the whole sweep.
fingerprint: f25c62844db6fcfc
source: audit-robustness
reason: user-approved behavior change

## T-028
priority: P1
status: DONE
attempts: 1
round: 2
first_seen_iteration: 7
last_touched_iteration: 8
title: broadcast_aito() sends to every client serially while holding the manager lock, with no per-send timeout
files: backend/app/core/websocket.py
evidence: backend/app/core/websocket.py:135 · ``` async with self._lock: for connection in self.active_connections: if not getattr(connection.state, "aito_read", True): continue try: await connection.send_text(data) ``` This is the exact shape `broadcast()` was hardened away from ten lines above, whose own docstring says why: "uvicorn applies TCP backpressure, so send_text() to a client whose socket window is full (sleeping laptop, dead cell link) never returns on its own" and holding the lock across it "stalls delivery to every other client *and* blocks connect()/disconnect()". `broadcast_aito` takes neither mitigation — no `asyncio.wait_for(..., self._BROADCAST_SEND_TIMEOUT)` and no snapshot-then-release. One operator whose laptop slept with the board open therefore wedges the whole ConnectionManager lock: printer-status broadcasts, new WS connects and disconnects all block behind it. Worse, this path is awaited inline inside request handlers (`await _broadcast_changed(...)` in routes/aito.py, e.g. line 1626 and after every board mutation), so the HTTP PATCH/POST never returns — the writing operator's card sits in its optimistic state forever, `boardSync.pendingWrites` never decrements, and the board's settle-invalidate and quote poll stay frozen with no error shown. `except Exception` does not help: a backpressured send hangs, it does not raise. · fix: give broadcast_aito the same shape as broadcast(): snapshot the permitted connections under the lock, release it, then `asyncio.gather` the sends each wrapped in `asyncio.wait_for(..., self._BROADCAST_SEND_TIMEOUT)`, and re-take the lock only to drop the failures · user-visible change: a client that cannot accept an Aito message within 5 s is disconnected instead of stalling everyone, so a very slow connection may be dropped where it previously survived.
fingerprint: a8256f4e6037344f
source: audit-robustness
reason: user-approved behavior change

## T-030
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 7
last_touched_iteration: 9
title: websocket_endpoint admits the socket to broadcast_aito before stamping aito_read, and the gate defaults open
files: backend/app/api/routes/websocket.py
evidence: backend/app/api/routes/websocket.py:141 · routes/websocket.py:110 `await ws_manager.connect(websocket)` runs before routes/websocket.py:141 `websocket.state.aito_read = aito_read`, with `async with async_session() as db:` + `await db.execute(select(User).where(User.username == principal))` awaited in between (lines 134-139). core/websocket.py:139 filters with `if not getattr(connection.state, "aito_read", True):` — an unstamped connection is treated as permitted, so a principal WITHOUT Permission.AITO_READ that holds WEBSOCKET_CONNECT receives any `aito_changed` / `aito_presence_state` fan-out (project ids, action, actor usernames, the full viewer map from `aito_presence_state()`) emitted during that DB-bound window. Round 1's fix closed the inbound half (`elif data.get("type") == "aito_presence" and websocket.state.aito_read:`) but not this outbound race. · fix: resolve the principal and set `websocket.state.aito_read` before `ws_manager.connect(websocket)` admits the socket into active_connections (keep the fail-closed `not auth_required` default and the existing except-path behaviour), so no connection is ever reachable by broadcast_aito while unstamped; the `getattr(..., True)` default in core/websocket.py:139 then has no window to cover and can be tightened to False
fingerprint: 58b945eb104aebe4
source: audit-security

## T-031
priority: P2
status: DONE
attempts: 0
round: 2
first_seen_iteration: 7
last_touched_iteration: 9
title: sweep_invoices leaves the hourly gate unstamped when the per-project commit raises, re-walking every open receivable every 300s
files: backend/app/services/aito_invoice_sweep.py
evidence: backend/app/services/aito_invoice_sweep.py:132 · loop-6 moved the gate stamp from before the loop to after it: `_last_run = time.monotonic()` now sits at line 132, past the `for project in projects:` body, while line 125's `await db.commit()` inside that body is unguarded (only `ZohoRateLimited` and `(ZohoUpstreamError, ValueError, TypeError, KeyError)` are caught, at lines 108/115). A SQLAlchemyError from that commit — the SQLite "database is locked" case the T-010 comment at line 122 explicitly anticipates ("A failure on this specific commit (SQLite \"database is locked\", for example)") — escapes to run_sync_loop's `except Exception: logger.exception("Aito quote sync tick failed")` (aito_quote_sync.py:2168-2169) with `_last_run` never updated, so the next 300s tick re-runs the whole pass. Unlike the 429 path, nothing arms `_throttled_until` here (aito_quote_sync.py:2160 only skips the sweep while a 429 window is open), so this is one Zoho Books GET per open receivable every 300s instead of every 3600s — a 12x amplification against the 1,000-10,000 requests/day org quota this module's own header says it is cost-shaped for, which once exhausted takes the whole quote sync down with it. · fix: stamp `_last_run` on every exit except ZohoRateLimited (e.g. wrap the loop in try/except ZohoRateLimited: raise / else: stamp, or stamp in a finally with an explicit 429 opt-out), so a pass that dies on a database error still consumes its hourly slot the way it did before loop-6 while the 429 path keeps relying on the shared throttle window · user-visible change: after a sweep that fails on a database error, the invoice status/balance/due-date shown on Aito cards would refresh no sooner than the next hourly slot instead of on the next 300s tick, so a stale invoice figure can persist up to an hour longer after such a failure
fingerprint: bfbe1336ba4836d6
source: audit-security
reason: folded into T-027's commit d7e06ea2b (one changelog entry T-027 + T-031)

## T-032
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 7
last_touched_iteration: 10
title: useFlagMutation's transform never runs the previous===undefined (board cache-miss) branch
files: frontend/src/hooks/useFlagMutation.ts
evidence: frontend/src/hooks/useFlagMutation.ts:22 · coverage: src/hooks/useFlagMutation.ts 22 branch 50% (1/2) — `npx vitest run src/__tests__/hooks/useFlagMutation.test.tsx --coverage --coverage.include=src/hooks/useFlagMutation.ts` -> 'Branches: 50% (1/2)'. `transform: (previous, flag) => previous?.map(...)`; useFlagMutation.test.tsx's renderFlagHook always does `client.setQueryData(['aito-projects'], [project])` before rendering the hook, in all 4 of its tests, so `previous` is never undefined. · fix: in frontend/src/__tests__/hooks/useFlagMutation.test.tsx, add a case that renders useFlagMutation with an empty QueryClient (no setQueryData for ['aito-projects']) and asserts the mutation still fires without throwing and the cache stays absent/undefined after the optimistic write
fingerprint: af8844635e8cea67
source: audit-tests

## T-033
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 7
last_touched_iteration: 10
title: useDueDateMutation's transform never runs the previous===undefined (board cache-miss) branch
files: frontend/src/hooks/useDueDateMutation.ts
evidence: frontend/src/hooks/useDueDateMutation.ts:18 · coverage: src/hooks/useDueDateMutation.ts 18 branch 50% (1/2) — `npx vitest run src/__tests__/hooks/useDueDateMutation.test.tsx --coverage --coverage.include=src/hooks/useDueDateMutation.ts` -> 'Branches: 50% (1/2)'. Same `previous?.map(...)` shape as useFlagMutation; all 3 tests in useDueDateMutation.test.tsx seed ['aito-projects'] before mutating. · fix: in frontend/src/__tests__/hooks/useDueDateMutation.test.tsx, add a case with no ['aito-projects'] cache entry seeded before calling mutate(), asserting the mutation does not throw when the board query has not loaded
fingerprint: 5491e4f6aa0bd0be
source: audit-tests

## T-034
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 7
last_touched_iteration: 10
title: useContactedMutation's transform never runs the previous===undefined (board cache-miss) branch
files: frontend/src/hooks/useContactedMutation.ts
evidence: frontend/src/hooks/useContactedMutation.ts:31 · coverage: src/hooks/useContactedMutation.ts 31 branch 83.33% (5/6) — `npx vitest run src/__tests__/hooks/useContactedMutation.test.tsx --coverage --coverage.include=src/hooks/useContactedMutation.ts` -> 'Branches: 83.33% (5/6)'. `transform: (previous, contacted) => previous?.map(...)`; every test seeds ['aito-projects'] first, same pattern as the two sibling hooks above. · fix: in frontend/src/__tests__/hooks/useContactedMutation.test.tsx, add a case with no ['aito-projects'] cache entry seeded before mutate(), asserting the mutation does not throw on a cache miss
fingerprint: 10e6eda26ba7994c
source: audit-tests

## T-035
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 7
last_touched_iteration: 11
title: the /aito route's PermissionRoute permission string ('aito:read') is asserted by no test and unpinned by the golden
files: frontend/src/App.tsx
evidence: frontend/src/App.tsx:272 · snapshots/fe-router.golden lines 79-81 record only `<Route / path="aito" / element=PermissionRoute` — the permission prop's VALUE is not captured. frontend/src/__tests__/pages/AitoPageAitoPermissions.test.tsx's own 'T-012' describe block (lines 447-528) does not render App.tsx's router at all: it defines a local `RoutePermissionGate` component (line 458) and hardcodes `permission="aito:read"` when building its own test-only router (lines 495, 515), per the file's own comment 'App.tsx does not export its router or its local PermissionRoute helper... this rebuilds the same two building blocks'. If App.tsx's actual `<Route path="aito" element={<PermissionRoute permission=...}>` (App.tsx:272) were changed to a different or wrong permission string (e.g. 'calculator:read', or removed entirely), neither the golden (element-type only) nor this test (which never imports App.tsx) would fail. · fix: add a test that imports the real router from frontend/src/App.tsx (or extracts/exports it for testing) and renders it to prove the '/aito' route element actually is <PermissionRoute permission="aito:read">, e.g. a new case in frontend/src/__tests__/ViewTransitionWiring.test.tsx or a new frontend/src/__tests__/AppRouterAitoGuard.test.tsx that pushes /aito with a user lacking aito:read and confirms a redirect, exercising App.tsx's own module rather than a hand-built mirror
fingerprint: 80c250461071b9f0
source: audit-tests

## T-036
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 7
last_touched_iteration: 11
title: _discount_pct's malformed-percent-string branch (ValueError, e.g. a comma decimal separator) is never exercised
files: backend/app/services/aito_quote_import.py
evidence: backend/app/services/aito_quote_import.py:266 · backend/app/services/aito_quote_import.py:262-269: `raw = line.get("discount"); if not isinstance(raw, str) or not raw.strip().endswith("%"): return None; try: pct = float(raw.strip().rstrip("%")) except ValueError: return None`. `rg -n '_discount_pct|discount' backend/tests/unit/test_aito_quote_import.py` only covers `discount: "10.00%"` (adopted) and `discount: 150` (non-string, not adopted) — no case sends a string ending in '%' that fails float() (e.g. a French-locale "10,00%" with a comma, or garbage like "abc%"), so the except ValueError branch never runs. · fix: in backend/tests/unit/test_aito_quote_import.py, add a case alongside test_flat_amount_discount_is_not_adopted with `"discount": "10,00%"` (or "abc%") and assert `impression_discount_pct is None`, pinning that a malformed percent string degrades safely instead of raising
fingerprint: d1206ab51c9caf5a
source: audit-tests

## T-037
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 7
last_touched_iteration: 11
title: parse_lines' 'ours but unparseable shipping line' branch is untested at the parse_lines level (only unit-tested on parse_shipping_line in isolation)
files: backend/app/services/aito_quote_import.py
evidence: backend/app/services/aito_quote_import.py:399 · backend/app/services/aito_quote_import.py:399-403: `if line.get("item_id") in shipping_id_values: # Ours, but unparseable (an island we do not know). Not a task and not something to report as unimportable... continue`. test_parse_shipping_line_gives_up_on_an_unknown_island (test_aito_quote_import.py:811) only calls parse_shipping_line() directly, never parse_lines()/build_preview() with such a line, and test_a_shipping_line_is_not_reported_as_a_skipped_line (line 824) only covers the SUCCESSFULLY-parsed shipping case. No test drives a full estimate through parse_lines with a shipping item_id whose description fails to parse, so nobody pins that such a line is silently dropped rather than showing up in `skipped` (the exact malformed-Books-payload edge case the function's own docstring calls out). · fix: in backend/tests/unit/test_aito_quote_import.py, add a test that calls parse_lines() (or build_preview()) with a line item whose item_id is in shipping_ids but whose description does not resolve to a known island (e.g. "Île: Atlantis"), asserting both `skipped == []` and the returned shipping is None
fingerprint: 6f4ea9ce20ef126c
source: audit-tests

## T-038
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 7
last_touched_iteration: 12
title: _chat's transport-failure, malformed-payload, truncation and empty-answer branches are never exercised
files: backend/app/services/openrouter.py
evidence: backend/app/services/openrouter.py:167 · backend/app/services/openrouter.py:160-184: `except httpx.HTTPError as e: raise OpenRouterUpstreamError(...)` (167-168), `except (KeyError, IndexError, TypeError, ValueError, AttributeError) as e: raise OpenRouterUpstreamError("OpenRouter returned an unexpected payload")` (174-175), `if raise_on_truncation and choice.get("finish_reason") == "length": raise OpenRouterUpstreamError(...)` (182), `if not content: raise OpenRouterUpstreamError(...)` (184). `../venv/bin/python3 -m pytest tests/unit/test_openrouter_service.py tests/unit/test_openrouter_settings.py tests/unit/test_aito_pickup_sms.py tests/unit/test_aito_proofread_route.py --cov=backend.app.services.openrouter --cov-config=../pyproject.toml --cov-report=term-missing` -> 'openrouter.py 104 10 42 3 91% Missing 167-168, 174-175, 182, 184, ...'. test_summarize_upstream_error only drives a 200-vs-500 status-code fake response (never a raised httpx.HTTPError, never a payload missing `choices`/`message`); no test sets `raise_on_truncation=True` (proofread_text's own use of it) with a truncated response; no test returns an empty/whitespace `content`. · fix: in backend/tests/unit/test_openrouter_service.py, add cases whose fake AsyncClient.post raises httpx.ConnectTimeout/httpx.ReadError (asserting OpenRouterUpstreamError is raised, not the transport error itself), a 200 response whose JSON is missing `choices`/`message`/`content` (asserting the 'unexpected payload' message), a 200 response with `finish_reason: 'length'` driven through proofread_text (raise_on_truncation=True) asserting it raises rather than returning the cut-off text, and a 200 response with empty/whitespace content asserting the 'empty answer' error
fingerprint: 018b90c90ae912d0
source: audit-tests

## T-039
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 7
last_touched_iteration: 12
title: proofread_text's real implementation (and _unquote) is never invoked by any test — the route test suite mocks proofread_text away entirely
files: backend/app/services/openrouter.py
evidence: backend/app/services/openrouter.py:286 · backend/app/services/openrouter.py:273-311 defines proofread_text (calls _chat with raise_on_truncation=True, then _unquote). `../venv/bin/python3 -m pytest tests/unit/test_openrouter_service.py tests/unit/test_openrouter_settings.py tests/unit/test_aito_pickup_sms.py tests/unit/test_aito_proofread_route.py --cov=backend.app.services.openrouter --cov-config=../pyproject.toml --cov-report=term-missing` shows lines 254-311 (_unquote and proofread_text's bodies) uncovered before pickup_sms tests widen the sample, and `grep -n 'proofread_text' backend/tests/unit/test_aito_proofread_route.py` shows all 3 uses are `monkeypatch.setattr(aito_routes, "proofread_text", fake)` — the only file that imports the real symbol under test never calls it. `grep -rln 'proofread_text' backend/tests/` finds no other test file. The French-correction and quote-stripping logic that lands verbatim in a field on a real customer quote is therefore entirely uncharacterized: a regression in _unquote's bracket-matching or in the max_tokens sizing math would pass every existing test. · fix: add a new backend/tests/unit/test_openrouter_proofread.py (mirroring test_openrouter_service.py's summarize_tasks tests) that calls the real openrouter.proofread_text with a fake httpx client, covering: a plain correction, a reply wrapped in matching quotes/guillemets being unwrapped, a reply wrapped in quotes the ORIGINAL also had being left alone, and a reply that is truncated (finish_reason=length) raising OpenRouterUpstreamError
fingerprint: 445b07735fb9436f
source: audit-tests

## T-040
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 7
last_touched_iteration: 12
title: the ordinary success toast (and its per-caller toastKeys override) fires in tests but its text is never asserted
files: frontend/src/hooks/useQuoteStatusMutation.ts
evidence: frontend/src/hooks/useQuoteStatusMutation.ts:56 · useQuoteStatusMutation.ts:51-59: `onSuccess: (result, status) => { ...; if (result.no_op) return; showToast(t(toastKeys[status] ?? TOAST_KEYS[status]), 'success'); if (project.quote_id && !result.zoho_synced) showToast(t('aito.zohoNotUpdated'), 'error'); }`. frontend/src/__tests__/hooks/useQuoteStatusMutation.test.tsx only exercises the conflict-error, generic-error and no_op-success paths — never an ordinary successful transition, so line 56 (the actual `t(toastKeys[status] ?? TOAST_KEYS[status])` call) is not covered from that file (`npx vitest run src/__tests__/hooks/useQuoteStatusMutation.test.tsx --coverage --coverage.include=src/hooks/useQuoteStatusMutation.ts` -> 'Uncovered Line #s 56'). src/__tests__/components/AitoQuoteStatusActions.test.tsx does drive the branch (line executes, combined coverage reaches 100%) but `grep -n 'quoteSent\|quoteAccepted\|quoteDeclined\|quoteUnaccepted' src/__tests__` returns zero matches anywhere in the suite — no test asserts WHICH toast key/text is shown on an ordinary success. UnacceptHoldPill.tsx:241 calls `useQuoteStatusMutation(project, { sent: 'aito.quoteUnaccepted' })` specifically so a revoked acceptance does not say 'Quote marked as sent' (per the hook's own doc comment), but AitoUnacceptHoldPill.test.tsx asserts no toast content at all (`grep -n 'toast' src/__tests__/components/AitoUnacceptHoldPill.test.tsx` -> no matches) — so the entire reason the toastKeys parameter exists is unverified, and a regression that dropped the override (always showing 'Quote marked as sent') would pass every test. · fix: in frontend/src/__tests__/components/AitoQuoteStatusActions.test.tsx, extend an existing success case (e.g. 'sends the sent transition when its hold completes') to also assert the success toast fired with the default key (mock ToastContext's showToast and assert toHaveBeenCalledWith('aito.quoteSent', 'success') or similar); in frontend/src/__tests__/components/AitoUnacceptHoldPill.test.tsx, add an assertion that a successful hold shows the 'aito.quoteUnaccepted' toast, not 'aito.quoteSent'
fingerprint: 50293e07f8f0bd00
source: audit-tests

## T-041
priority: P1
status: DONE
attempts: 1
round: 3
first_seen_iteration: 12
last_touched_iteration: 13
title: _fan_out() evicts a timed-out connection without closing it, so the client never learns it was dropped
files: backend/app/core/websocket.py
evidence: backend/app/core/websocket.py:90 · `disconnected = [conn for conn, result in zip(connections, results, strict=True) if isinstance(result, Exception)]` followed by `self.active_connections.remove(conn)` — the socket is removed but never closed, and `websocket_endpoint` stays parked in `await websocket.receive_json()`. The class's own comment names the trigger: "send_text() to a client whose socket window is full (sleeping laptop, dead cell link) never returns on its own". A laptop that sleeps for a few seconds with the board open blows the 5s `_BROADCAST_SEND_TIMEOUT`, is evicted, then wakes with a perfectly healthy TCP connection: `useWebSocket`'s 30s ping still gets a pong and `ws.onclose` never fires, so its 3s reconnect never runs. The operator sees a connected-looking Aito board that stops receiving `aito_changed`/`aito_presence_state` (and every printer_status) forever — cards silently stale, their own presence invisible to colleagues — until they manually reload the tab. · fix: After removing the connection under the lock, fire a best-effort bounded close (e.g. a task running `asyncio.wait_for(conn.close(code=1011), timeout=...)`, outside the manager lock) so the endpoint's receive loop unblocks and the client's onclose reconnect path runs. · user-visible change: A client dropped for a slow send now sees its socket close and reconnects a few seconds later (brief 'disconnected' state, one fresh ws-token) instead of sitting silently frozen.
fingerprint: 32f6541fee226b75
source: audit-robustness
reason: user-approved behavior change

## T-042
priority: P1
status: DONE
attempts: 1
round: 3
first_seen_iteration: 12
last_touched_iteration: 13
title: broadcast_to_user() awaits send_text while holding the manager lock, so one wedged client blocks every broadcast_aito()
files: backend/app/core/websocket.py
evidence: backend/app/core/websocket.py:183 · `async with self._lock:` … `await connection.send_text(data)` with no `wait_for` — the one send path T-020/T-028 left untouched. During an FTP dispatch, `send_queue_item_upload_progress(user_id=A, …)` hits operator A's wedged socket (the same sleeping-laptop case `_BROADCAST_SEND_TIMEOUT` exists for, which here has no timeout at all and per the class comment "never returns on its own"). The lock is held for the whole stall, so every Aito route handler's closing `_broadcast_changed()` → `broadcast_aito()` → `async with self._lock` blocks behind it: the board writes commit but their HTTP responses never return, so every operator's card edit, drag, flag and quote-status click hangs indefinitely, and `connect()`/`disconnect()` stop admitting sockets too. · fix: Route this through `_fan_out`: filter the matching connections into a snapshot under the lock, release it, then fan out with the same per-send timeout and removal path the other two broadcasts use. · user-visible change: A queue-dispatch toast to a wedged client is abandoned after the 5s send timeout and that connection is evicted, where previously the send waited indefinitely.
fingerprint: 39a1ea198417c1ec
source: audit-robustness
reason: user-approved behavior change

## T-043
priority: P3
status: DONE
attempts: 1
round: 3
first_seen_iteration: 12
last_touched_iteration: 16
title: the paid OpenRouter routes (proofread_field, summarize_project, generate_pickup_message) carry no rate limit
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1108 · @router.post("/proofread", response_model=AitoProofreadResponse) async def proofread_field( payload: AitoProofreadRequest, db: AsyncSession = Depends(get_db), _: User | None = Depends( require_any_permission_if_auth_enabled(Permission.AITO_CREATE, Permission.AITO_UPDATE) ), ): ... corrected, model = await proofread_text(db, payload.text) — each call is one billed https://openrouter.ai/api/v1/chat/completions completion (services/openrouter.py:15,162); no throttle exists on any of the three routes, while the codebase already has a rate-limit primitive (check_rate_limit / AuthRateLimitEvent, used at backend/app/api/routes/auth.py:473-475) · fix: throttle the three OpenRouter-backed routes per principal (and per client IP for the auth-disabled case) with the existing check_rate_limit/AuthRateLimitEvent primitive, or a small in-process token bucket; per-request payload caps are already correct, only the call rate is unbounded · user-visible change: a user who blurs many fields in quick succession (or any caller on an auth-disabled install) would start getting 429s from /aito/proofread, /aito/summarize and /aito/{id}/pickup-message instead of an answer, so the drawer's spell-check would visibly stop correcting until the window clears
fingerprint: d9bed09419177fb2
source: audit-security
reason: user-approved behavior change

## T-044
priority: P2
status: DONE
attempts: 1
round: 3
first_seen_iteration: 12
last_touched_iteration: 13
title: Ten aito.* i18n keys and three calculator.quote.* keys are unreferenced
files: frontend/src/i18n/locales/en.ts
evidence: frontend/src/i18n/locales/en.ts:59 · rg -n for each of aito.trashTitle(59), aito.clearClient(113), aito.newClientTitle(135), aito.stepPending(194), aito.markDone(195), aito.markNotDone(196), aito.quoteImportAgain(214), aito.syncIdle(278), aito.showMore(289), aito.showLess(290), calculator.quote.volumePricing/discount/unitPrice(8412-8414) across frontend/src (*.ts,*.tsx) outside src/i18n/locales -> zero hits for each. Confirmed each has a live sibling actually used instead: components/aito/ProjectDetailPanel.tsx's SYNC_LABEL_KEY map explicitly lists only pending/error/locked ('the sync row only renders for three of its five values') so syncIdle is dead by design; components/aito/BoardColumn.tsx uses t('aito.markProjectDone') not markDone/markNotDone; pages/AitoPage.tsx uses t('aito.showDone') not showMore/showLess; components/aito/ClientCombobox.tsx uses t('aito.resetToDefaultClient') not clearClient, and renders NewContactForm with no title at all (newClientTitle unused); components/aito/TrashGrid.tsx never reads trashTitle; components/aito/ImportQuoteDrawer.tsx uses t('aito.quoteImport') not quoteImportAgain; pages/CalculatorQuotePage.tsx renders no volume-pricing/discount/unit-price table at all. All 13 keys are also present (equally dead) in all 12 other locale files (grep -l count 13/13 for each). Ruled out dynamic construction: grep for 'aito.${' / "aito." + / template-literal aito keys found none (unlike calculator.realityCheck.${base}, which IS built dynamically in CalculatorRealityCheckCard.tsx and is correctly NOT flagged here). · fix: Delete these 13 keys from en.ts and the 12 translated locale files once a maintainer confirms no feature using them is mid-flight. · user-visible change: fe-i18n-parity tracks key counts per locale file, so removing these keys changes that count across all 13 locale files and must be done as a coordinated edit, not silently.
fingerprint: 12afb82f8232ab94
source: audit-cleanliness
reason: user-approved behavior change

## T-045
priority: P2
status: DONE
attempts: 1
round: 3
first_seen_iteration: 12
last_touched_iteration: 14
title: Three pre-existing mutation-hook test files still hand-paste the mocks boardMutationHarness.tsx now centralizes
files: frontend/src/__tests__/hooks/useQuoteStatusMutation.test.tsx
evidence: frontend/src/__tests__/hooks/useQuoteStatusMutation.test.tsx:22 · useQuoteStatusMutation.test.tsx:22-33, useSendQuoteMutation.test.tsx:20-27, and useSendInvoiceMutation.test.tsx:25-35 each independently define `vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key) => key }) }))` and `const showToastMock = vi.fn(); vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ showToast: showToastMock }) }))` -- byte-for-byte the same object literals boardMutationHarness.tsx's i18nKeyTranslationFactory()/toastContextMockFactory() now export specifically to end this duplication (its own comment: 'Each test file therefore keeps its own three one-line vi.mock(...) calls, but the calls delegate to the factories exported here instead of repeating the object literals'). These three files were not migrated when the harness was introduced this round. · fix: Point these three files' vi.mock('react-i18next', ...) and vi.mock('../../contexts/ToastContext', ...) calls at i18nKeyTranslationFactory / toastContextMockFactory from boardMutationHarness.tsx, importing showToastMock from there too.
fingerprint: b93ded18679ed78e
source: audit-cleanliness

## T-046
priority: P2
status: DONE
attempts: 1
round: 3
first_seen_iteration: 12
last_touched_iteration: 14
title: _FakeClient/_FakeResponse OpenRouter HTTP mock duplicated between test_openrouter_proofread.py and test_openrouter_service.py
files: backend/tests/unit/test_openrouter_proofread.py
evidence: backend/tests/unit/test_openrouter_proofread.py:18 · test_openrouter_proofread.py:18-46 defines class _FakeResponse (status_code=200, .json() wrapping {content, finish_reason}) and class _FakeClient (__init__/__aenter__/__aexit__ no-ops, .post() records last_json and returns _FakeResponse), monkeypatched onto openrouter.httpx.AsyncClient. test_openrouter_service.py:129-148 defines the same two classes with the identical __init__/__aenter__/__aexit__/post shape (only the canned response body and lack of a configurable finish_reason differ), also monkeypatched onto the same openrouter.httpx.AsyncClient. · fix: Extract a shared FakeOpenRouterClient/FakeOpenRouterResponse pair (parameterized by reply/finish_reason) into a conftest.py or shared test helper module both files import.
fingerprint: 3315ee372037f5e7
source: audit-cleanliness

## T-049
priority: P3
status: WONTFIX-AUTO
attempts: 0
round: 3
first_seen_iteration: 12
last_touched_iteration: 12
title: broadcast_to_user() still hand-rolls the send-then-clean-up-disconnects loop that _fan_out() now centralizes for broadcast()/broadcast_aito()
files: backend/app/core/websocket.py
evidence: backend/app/core/websocket.py:155 · _fan_out() (lines 62-97) is documented as 'Shared send path for broadcast() and broadcast_aito()' and both of those are now thin wrappers around it (lines 99-111, 148-153) -- confirming the T-020/T-028 refactor succeeded for the two callers it names. broadcast_to_user() (lines 155-189) was not folded in: it loops `for connection in self.active_connections: ... await connection.send_text(data) except Exception: disconnected.append(connection)` sequentially, under the lock, with no per-send timeout -- the same shape _fan_out() replaced specifically to avoid one wedged client stalling every other send and blocking connect()/disconnect() (see _fan_out's own docstring on why the timeout/concurrency matters). · fix: Give _fan_out() an optional connection-list filter (or a predicate parameter) so broadcast_to_user() can reuse it instead of its own sequential loop. · user-visible change: unifying onto _fan_out would make per-user queue-toast sends concurrent and timeout-bounded (currently sequential and unbounded), a user-visible latency/ordering change for queue_item_* toasts under a wedged connection.
fingerprint: c1852ff1e7e7e45d
source: audit-cleanliness
reason: duplicate of T-042 (folded into its worker run)

## T-050
priority: P2
status: DONE
attempts: 1
round: 3
first_seen_iteration: 12
last_touched_iteration: 14
title: create_project() does permission-gating, contact validation, shipping validation, position-shifting, event recording (3 kinds) and task creation all in one 182-line function
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:909 · ruff --select C901: `create_project` is too complex (13 > 10) at aito.py:909. The function body (lines 909-1087) sequentially: checks an AITO_UPDATE permission escalation (914-936), validates the client has a contact channel (938-949), validates shipping fields (950-954), shifts every other 'devis'-column card's position (956-957), builds the AitoProject row (959-985), stamps quote_sent_at for imports (990-991), inserts the row and up to three separate timeline `record()` calls for creation/due-date/decision (1021-1064), builds and inserts AitoTask rows (1065-1069), applies board rules (1073), commits with IntegrityError handling for the concurrent-duplicate-quote race (1074-1079), then wakes the sync worker and broadcasts (1080-1087). · fix: Extract the permission/contact/shipping validation into one _validate_create_payload() helper and the three record() calls into one _record_creation_events() helper, leaving create_project() as the orchestration; keep the flush/commit/IntegrityError envelope exactly as-is given its documented race-condition sensitivity.
fingerprint: c35b96e0158bb3cc
source: audit-cleanliness

## T-051
priority: P2
status: DONE
attempts: 1
round: 3
first_seen_iteration: 12
last_touched_iteration: 15
title: test_wake_drains_a_pending_project_without_waiting_for_the_interval still races the startup full pass on the shared StaticPool connection
files: backend/tests/unit/test_aito_quote_sync.py
evidence: backend/tests/unit/test_aito_quote_sync.py:2737 · latest failure in /tmp/c11-cov-backend-full.log: 'sqlalchemy.exc.InvalidRequestError: Could not refresh instance ...AitoProject...' raised from `await db_session.refresh(project)` at test_aito_quote_sync.py:2771, a NEW failure mode distinct from the live_sessions race already fixed. The test body (test_aito_quote_sync.py:2735-2750) does `loop_task = asyncio.create_task(run_sync_loop())` then only `await asyncio.sleep(0.05)` before using db_session to add/flush/commit the project -- it never waits for the loop's own startup-pass session (also a TrackedSession, added to the same `live_sessions` set the test already tracks) to close first. db_session and every worker session share ONE physical aiosqlite connection (StaticPool, per the test's own comment at lines 2684-2687: 'on the in-memory StaticPool engine that is THE connection'). If the startup pass's session is still mid-transaction (its own SELECTs autobegin one) when db_session's insert lands on that same connection and commits, the startup session's later rollback-on-close of its now-stale transaction can silently discard the just-committed insert -- db_session's Python-side unit of work never notices, so the subsequent commit() is a no-op and refresh() finds no row. · fix: in backend/tests/unit/test_aito_quote_sync.py, before creating/committing the project (around line 2739), add the same wait-for-live_sessions-empty loop that already exists after the drain (lines 2766-2770) so the test blocks until the startup full-pass session has actually closed before any other session writes to the shared connection -- replacing the fixed `await asyncio.sleep(0.05)` at line 2738, which is a sleep-based race, not a synchronization point.
fingerprint: 4baff8024e7fab79
source: audit-tests

## T-052
priority: P2
status: DONE
attempts: 1
round: 3
first_seen_iteration: 12
last_touched_iteration: 15
title: PermissionRoute's loading / auth-disabled / unauthenticated branches are never exercised through the real /aito route
files: frontend/src/App.tsx
evidence: frontend/src/App.tsx:170 · frontend/src/App.tsx PermissionRoute (lines 161-188) has 4 branches -- `if (loading) return <RouteLoading/>` (170-172), `if (!authEnabled) return children` (175-176), `if (!user) return <Navigate to="/login"/>` (179-180), and the permission allow/deny pair (183-185). frontend/src/__tests__/AppRouterAitoGuard.test.tsx -- the file whose own docstring says it exists specifically to pin the REAL /aito guard, as opposed to the hand-rebuilt one in AitoPageAitoPermissions.test.tsx -- only ever sets mockUseAuth.loading = false and a truthy user (lines 34-49), and its two `it` blocks vary only hasPermission. Re-running that file alone with `npx vitest run src/__tests__/AppRouterAitoGuard.test.tsx --coverage --coverage.include=src/App.tsx` reports 44.51% stmts / 50% branch with Uncovered Line #s including '...155,171,176,180,191-204' -- 171, 176 and 180 are exactly the loading/auth-disabled/unauthenticated return statements of PermissionRoute. · fix: in frontend/src/__tests__/AppRouterAitoGuard.test.tsx, add cases that set mockUseAuth.loading = true (expect RouteLoading, i.e. no navigation and no board content while pathname stays /aito), mockUseAuth.authEnabled = false (expect the board to mount at /aito regardless of hasPermission), and mockUseAuth.user = null with authEnabled true (expect a redirect to /login) -- mirroring the existing allow/deny cases in that file.
fingerprint: 4acd4e62bc7cb5ce
source: audit-tests

## T-053
priority: P2
status: DONE
attempts: 1
round: 3
first_seen_iteration: 12
last_touched_iteration: 15
title: useSettledValue has no test at all -- its actual settle transition (the setTimeout callback) is never invoked by any test
files: frontend/src/hooks/useSettledValue.ts
evidence: frontend/src/hooks/useSettledValue.ts:6 · frontend/src/hooks/useSettledValue.ts backs three production behaviors: the Money remount-tick key in components/calculator/shared.tsx:82, the fill-retrigger key in components/calculator/CostWaterfall.tsx:28, and CalculatorTotalsCard.tsx:52 -- yet there is no useSettledValue.test.ts/.tsx anywhere (find frontend/src/__tests__ -iname '*SettledValue*' -> no matches) and no reference to it, settledTotal, or animate-value-tick in any test file (grep -rn across frontend/src/__tests__ -> no matches). Running the one test that does mount a consumer (npx vitest run src/__tests__/components/calculator/CostWaterfall.test.tsx --coverage --coverage.include=src/hooks/useSettledValue.ts) reports 100% lines but only 75% funcs (3/4) with 100% branches -- the uncounted function is the `() => setSettled(value)` callback passed to setTimeout (useSettledValue.ts line 6), i.e. the hook is only ever seen at its initial render; the delayed state update that is the entire point of the hook -- and the trigger for the tick/fill-retrigger animations on Money and CostWaterfall -- never fires in any test. No calculator test file uses vi.useFakeTimers()/advanceTimersByTime (grep across frontend/src/__tests__/components/calculator and CalculatorPage* -> no matches). · fix: add frontend/src/__tests__/hooks/useSettledValue.test.ts using vi.useFakeTimers(): render the hook with an initial value, rerender with a new value, assert the returned value is still the OLD one before `delay` ms, then vi.advanceTimersByTime(delay) and assert it flips to the NEW value; also cover a value changing again before the delay elapses (the setTimeout gets cleared/restarted, never settling on the intermediate value).
fingerprint: d79984e75cb06c2f
source: audit-tests

