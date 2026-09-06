# Refactor loop — campaign 10 final report

**Scope:** the Aito and Calculator features (backend `routes/services/models/schemas` for aito, calculator, zoho, openrouter, pushcut, filament_profile_pricing; frontend Aito/Calculator pages, components, hooks, utils; their tests; their slice of shared files). Narrowed from "whole repo" by the user during setup. **Dates:** 2026-09-03 → 2026-09-04. **Branch:** `auto-refactor-loop`, cut from `fa365ca83` (main, the campaign-9 merge). **BASE:** tag `refactor-base` = `b026f3f4a`.

## Headline

| | |
|---|---|
| Iterations run | 8 of 8 (**MAX_ITER**) |
| Survey rounds | 2 of 3 (round 3 never ran: the iteration budget was spent first) |
| Tasks filed / done / left open | 33 / **24** / 9 (+7 triaged) |
| Commits | 8 squashed iteration commits on top of the setup commit (+ this report) |
| Tags | `refactor-base`, `loop-1` … `loop-8` |
| User-approved behavior changes | **12** (T-007, T-008, T-002, T-009, T-004, T-005, T-010, T-011, T-026, T-024, T-027, T-028) |
| Backend coverage | 72% → **72%** (71.78% → 71.82% precise; 12685 → 12803 tests, +118) |
| Frontend coverage | 60.29% lines → **60.35%** (59.37% → 59.44% statements; 5430 → 5455 tests, +25) |
| Golden probes | 10/10 at every verdict; two sanctioned re-records (fe-i18n-parity for T-004/T-005; app-ddl + app-migrations-index for T-026) |
| SURFACE.md | +5 lines, every one mapped to a changelog entry (T-002 export, T-009 class + return type, T-026 column count) |
| Known-broken tests | 0 → **0** |

## Why the loop ended: MAX_ITER

Round 2 filed 18 new tasks against 9 remaining iteration slots; 9 P2 tasks (8 of them test-coverage tasks, plus the approved ZohoSettings label fix) were still OPEN when iteration 8 closed. Round 3 of the panel never ran, so the campaign is not converged. A campaign 11 should start by resurveying — it will find the 9 open tasks again (they are not pre-filed in a fresh worktree) plus whatever the round-2 auditors missed.

## The 12 user-approved behavior changes

Every one has a dated `BASELINE-CHANGELOG.md` entry and lives in a commit marked `(user-approved behavior change)`. Two (T-007, T-002) and later T-028 were filed by their auditors as non-behavior changes, flagged by the blind verifier, and approved after the fact — the verifier's strictness is what caught them.

1. **T-007 (P0, data loss)** — `_write_back_rounded_costs` rounded a cost re-read through SQLAlchemy's identity map, so a task cost the operator saved while a Zoho round-trip was in flight was silently reverted and pushed to the customer's quote. Now rounds a pre-round-trip snapshot and rewrites a row only where its stored cost still equals the pushed value. The robustness auditor reproduced the loss before filing.
2. **T-008** — a project whose quote CREATE failed (Books outage, IntegrityError) has no quote_id and was never re-selected once it hit `error`; the sweep now re-selects such projects and routes them through the create path, adopting an orphan estimate if Books already has one.
3. **T-002** — `replaceProject` helper replaces seven byte-identical cache-replace callbacks (surface-only change: one new export).
4. **T-009** — HTTP 429 is its own `ZohoRateLimited` subclass with Retry-After parsing; the sync loop defers it without spending the five-retry outage budget and stops the tick after the first one.
5. **T-004 / T-005** — 4 + 15 never-rendered i18n keys deleted from all 13 locales (golden key counts 7171 → 7152; no rendered string changes).
6. **T-010** — done-column and declined/expired quotes leave the reconcile sweep instead of costing one Books call per card per tick forever.
7. **T-011** — a 30 s process-local cooldown after a failed shipping-catalogue refresh, mirroring `zoho_filaments`.
8. **T-026** — a gap opened by T-010: a decline recorded locally while Books was unreachable was stranded forever. New internal column `quote_status_confirmed` (+ migration) gates the exclusion until Books is observed to agree. First attempt correctly stopped and asked before adding the column.
9. **T-024** — Aito reads left the default-on `can_read_status` API-key scope; the board (client PII, quote totals) is now user-token only, like Aito writes already were.
10. **T-027** — `send_pickup_sms` no longer 500s after Pushcut accepted the SMS when the local event write fails (which invited a duplicate send); it logs and returns success without the timeline entry.
11. **T-028** — after a 429 the whole sync loop backs off for min(Retry-After, 15 min) or 60 s, so wake drains during editing stop hammering a throttled org.

## What each survey round found

| Round | audit-security | audit-robustness | audit-cleanliness | audit-tests | Total new / approval-held / triaged |
|---|---|---|---|---|---|
| 1 (setup) | 0 new, 1 triaged | 5 new (4 held), 1 triaged | 3 new, 2 triaged | 7 new | 15 / 4 / 4 |
| 2 | 1 new (1 held), 1 triaged | 3 new (2 held), 1 triaged | 4 new (1 held) | 10 new, 1 triaged | 18 / 4 / 3 |

All 8 approval-held findings were approved by the user. Round 1's scanners (semgrep, pip-audit, npm audit) could not reach the network; round 2 reached it: pip-audit clean, npm audit's 4 findings all outside the Aito/Calculator scope, semgrep hits in scope all false positives. Every real finding came from manual review.

## Findings by auditor (final status, from `plan.py stats`)

| Auditor | Filed | Done | Open | Blocked | WONTFIX-AUTO | Triaged (campaign total) |
|---|---|---|---|---|---|---|
| audit-security | 1 | 1 | 0 | 0 | 0 | 2 |
| audit-robustness | 8 | 8 | 0 | 0 | 0 | 2 |
| audit-cleanliness | 7 | 6 | 1 | 0 | 0 | 2 |
| audit-tests | 17 | 9 | 8 | 0 | 0 | 1 |
| survey | 0 | — | — | — | — | — |

**Triaged: 7** (all P3), broken down above from the per-round ingest counts. `TRIAGE.md` (archived below) holds every one with full evidence; promote with `python tools/plan.py promote <id> --iteration N` (the flag is required). Note T-029 duplicates T-001 (same invoice-PDF header finding, filed by two auditors under slightly different titles — the dedup fingerprint is title-sensitive), so there are 6 distinct items. `plan.py stats`'s `triaged` figure (7) happens to equal the campaign total here because nothing was promoted and no prior triage list was carried over.

## Before / after

| Metric | BASE | Final |
|---|---|---|
| Backend tests | 12685 passed / 1 skipped | 12803 passed / 1 skipped |
| Frontend tests | 5430 (382 files) | 5455 (386 files) |
| Backend statements | 71.78% | 71.82% |
| Frontend lines / statements | 60.29% / 59.37% | 60.35% / 59.44% |
| Lint (ruff, eslint) | clean | clean |
| Production diff (backend/app + frontend/src) | — | 34 files, +1135 / −369 lines |
| Test diff | — | +2730 / −88 lines (only sanctioned assertion changes removed) |
| Aito/Calculator write routes with a negative-permission test | 0 of 29 | 29 of 29 |
| Golden probes | 10/10 | 10/10 |

## Process notes worth keeping

- **Coverage gate correction (pre-BASE):** pytest-cov resolves its default `--cov-config` from `backend/`, so the root `pyproject.toml` (branch + greenlet) was silently ignored and read 64%. `tools/coverage_all.sh` now passes `--cov-config=../pyproject.toml`; hand-run coverage from `backend/` MUST too.
- **The blind verifier is not fully blind:** it can `cat` the untracked PLAN.md and did once (it cited a PLAN.md line). Blindness is enforced only through `git diff`; the final re-verify briefing forbade reading the loop's state files explicitly, and future briefings should too.
- **Worktree venv was cloned offline** (pypi unreachable): `python3.13 -m venv` + rsync of the main venv's `lib/python3.13/site-packages`. Copied `.pyc` files carry the main venv's paths in tracebacks; harmless.
- **Auditors re-find each other's work under different titles** (T-001/T-029).

## Hints for a campaign 11 (worker observations, not filed findings)

- **T-018, iteration 2:** frontend/src/components/ZohoSettings.tsx: every text <input> has its <label> as a plain sibling with no for/id/aria-labelledby and no wrapping, so fields are not reachable via getByLabelText or a screen reader's label association. Tests had to use DOM traversal. Candidate cleanliness/robustness finding for round 2.
- **T-019, iteration 5:** backend/tests/unit/test_aito_quote_sync.py::test_wake_drains_a_pending_project_without_waiting_for_the_interval still fails standalone ~1-in-10 with `sqlalchemy.exc.InvalidRequestError: Could not refresh instance` — a separate race between the test's db_session and the worker sessions sharing the same in-memory StaticPool connection; pre-existing, unrelated to the wall-clock poll now fixed. Candidate audit-tests finding for round 2 (root-cause fix, not a retry).
- **T-030, iteration 6:** backend/tests/unit/test_aito_routes.py: the `_create_as` / `_add_task_as` helpers override the whole `current_user` dependency callable with a lambda, which bypasses RequirePermissionIfAuthEnabled's own has_all_permissions/403 logic — so the two existing "403" tests there exercise a secondary in-handler check, NOT the route-level gate. Scratch repro: every route returned 404/422 (not 403) under that technique with permissions=[]. The new test_aito_permissions.py drives the real gate with a Settings auth row + real JWTs. Candidate audit-tests finding: any other test file using the dependency-override lambda pattern to "test permissions" tests the wrong thing.
- **T-028, iteration 8:** monkeypatching `aito_quote_sync.time.monotonic` mutates the process-wide time module (zoho.py's OAuth expiry cache reads it too) and in an async test can hang pytest-asyncio's fixture teardown (Runner.run on an async-gen finalizer idle in kevent). Rebind the module's own `time` name instead (`monkeypatch.setattr(aito_quote_sync, "time", fake)`), like test_zoho_service.py does for zoho.datetime. test_a_burst_of_edits_shares_one_debounce_window still mutates the shared module (sync-only, so safe today) — a latent hazard.

## Tasks left for humans

Nine OPEN, zero BLOCKED, zero WONTFIX-AUTO. Eight are test-coverage tasks from round 2; T-023 (label/input association in ZohoSettings) is an approved-but-unworked P3. All retain their auditor evidence verbatim:

### Open tasks (9) — full evidence

#### T-032 [P2] test_wake_drains_a_pending_project_without_waiting_for_the_interval still races db_session against the worker's session on the shared StaticPool connection, ~1-in-10 under load ("Could not refresh instance")

- **Source:** audit-tests · **Files:** `backend/tests/unit/test_aito_quote_sync.py` · **Status:** OPEN

backend/tests/unit/test_aito_quote_sync.py:2576 · backend/tests/conftest.py's test_engine fixture creates the engine from TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:" with no explicit poolclass; `./venv/bin/python3 -c "from sqlalchemy.ext.asyncio import create_async_engine; e=create_async_engine('sqlite+aiosqlite:///:memory:'); print(type(e.pool))"` prints `<class 'sqlalchemy.pool.impl.StaticPool'>` -- confirming the whole engine (and therefore both the test's own db_session and the aito_quote_sync worker's TrackedSession, both created from async_sessionmaker(test_engine, ...)) share exactly one physical aiosqlite connection with no serialization between checkouts. The test currently does `await asyncio.wait_for(drain_completed.wait(), timeout=30)` then immediately `await db_session.refresh(project)` (lines 2575-2576) BEFORE the live_sessions drain-wait loop that follows it (`for _ in range(100): if not live_sessions: break ...`, lines ~2580-2586). drain_completed fires the instant run_sync_once() RETURNS inside the worker's `async with async_session() as db:` block (run_sync_loop.py:1958-1960) -- that block's __aexit__ (db.close(), which issues a ROLLBACK/reset on the shared connection if the worker session auto-began a further transaction after its last commit, e.g. re-checking `_still_selected` for other rows) has NOT necessarily finished when drain_completed.set() runs. db_session.refresh() therefore races the worker session's own close/reset traffic on the SAME physical connection, occasionally landing its SELECT in a window where the shared connection has just been rolled back or reset, producing zero rows and SQLAlchemy's `InvalidRequestError: Could not refresh instance`. This is a distinct race from the one the TrackedSession/live_sessions pattern already fixed (that one guarded loop_task.cancel() against a mid-close cancellation; this one is the test's OWN refresh racing the worker's close, which the existing live_sessions wait only guards AFTER the refresh already ran). · fix: in backend/tests/unit/test_aito_quote_sync.py's test_wake_drains_a_pending_project_without_waiting_for_the_interval, reorder so the live_sessions drain-wait (`for _ in range(100): if not live_sessions: break; await asyncio.sleep(0.01)`) runs immediately after `await asyncio.wait_for(drain_completed.wait(), timeout=30)` and BEFORE `await db_session.refresh(project)` -- i.e. wait for the worker's TrackedSession to fully close (guaranteeing its close/reset traffic on the shared StaticPool connection has completed) before db_session touches that same connection. This does not weaken any assertion: the same three asserts (quote_id, quote_sync_state, not live_sessions) still run, only their order changes so the refresh can no longer interleave with the worker's own session teardown.

#### T-033 [P2] ZohoSettings' <label> elements have no for/id association, forcing ZohoSettings.test.tsx to select inputs by DOM structure instead of by label

- **Source:** audit-tests · **Files:** `frontend/src/components/ZohoSettings.tsx` · **Status:** OPEN

frontend/src/components/ZohoSettings.tsx:134 · Every <label> in ZohoSettings.tsx (lines 134, 144, 160, 176, 186, 196, 206, 217) is a plain sibling of its <input> with no htmlFor/id or aria-labelledby, and no wrapping <label>...</label>. frontend/src/__tests__/components/ZohoSettings.test.tsx's own header comment confirms this was discovered while writing the tests: "The labels are plain siblings of their <input> (no for/id or wrapping), so testing-library's label-association queries can't find them. Walk from the label text node to the input in its own wrapper div instead" -- and its `inputForLabel` helper does exactly that: `screen.getByText(labelText).parentElement?.querySelector('input')`. This couples the test to ZohoSettings' current DOM nesting (a <div> wrapping one <label> and one <input>) rather than to its behavior; a markup refactor that keeps the same visible label/input pairing but changes the wrapper structure would silently break every test in the file even though nothing user-visible changed, and the tests can never be ported to getByLabelText or a real screen-reader label association. · fix: add htmlFor/id pairs to each label/input in frontend/src/components/ZohoSettings.tsx (e.g. htmlFor="zoho-client-id" / id="zoho-client-id"), then simplify frontend/src/__tests__/components/ZohoSettings.test.tsx to use screen.getByLabelText(...) in place of the inputForLabel DOM-walk helper. This is a production fix outside this auditor's authority to decide; filed per instructions for the user to approve (adding for/id changes only the accessibility tree, not visible rendering or any status code/permission/default, so no behavior_change flag applies under this lens's contract).

#### T-034 [P2] ZohoSettings' handleSave is only exercised for 2 of its 8 tracked fields, and the save mutation's own onError toast is untested

- **Source:** audit-tests · **Files:** `frontend/src/components/ZohoSettings.tsx` · **Status:** OPEN

frontend/src/components/ZohoSettings.tsx:69 · frontend/src/__tests__/components/ZohoSettings.test.tsx types into Client ID and Client Secret only. `node -e "require('./coverage/coverage-final.json')..."` on ZohoSettings.tsx shows statement lines never executed: 69 (onError: (error) => showToast(error.message, 'error') on saveMutation itself), 79-82 (the organizationId/baseUrl/accountsUrl/defaultContactId diff checks in handleSave), 84 (the defaultContactName diff), 86 (the refreshToken -> payload.zoho_refresh_token branch), and 169/180/190/200/210/221 (the onChange handler bodies for refreshToken, organizationId, defaultContactId, defaultContactName, baseUrl and accountsUrl -- never invoked because no test types into those fields). refreshToken is Zoho's OTHER secret, parallel to zoho_client_secret which IS tested ("includes zoho_client_secret when the secret field is filled in") -- an identical omission bug specific to refreshToken's own branch would go undetected. The save mutation's onError is also distinct from, and untested unlike, the already-tested Test-connection probe's failure toast ("shows an error toast when the test-connection probe fails"). · fix: in frontend/src/__tests__/components/ZohoSettings.test.tsx, add a case typing into Refresh Token and asserting putBodies includes zoho_refresh_token (mirroring the existing Client Secret test), a case touching organizationId/defaultContactId/defaultContactName/baseUrl/accountsUrl to prove each diff branch fires, and a case where the PUT /api/v1/settings/ handler returns a 500/network error and asserts the resulting error toast from saveMutation's onError (distinct from the existing probe-failure test).

#### T-035 [P2] useContactedMutation's transform/onSuccess/onError are never invoked by any test -- the mutation itself is never actually fired

- **Source:** audit-tests · **Files:** `frontend/src/hooks/useContactedMutation.ts` · **Status:** OPEN

frontend/src/hooks/useContactedMutation.ts:29 · coverage-final.json for frontend/src/hooks/useContactedMutation.ts shows statement lines 31, 35, 37, 38, 40 never executed -- the `transform` optimistic-map callback (30-34), `flashId` (35), `onSuccess`'s setQueryData/invalidateQueries (37-38) and `onError`'s showToast (40) are all dead in the coverage run, meaning no test ever calls .mutate() on this hook and lets it resolve or fail. `grep -rn 'contactedFailed' frontend/src/__tests__` returns zero matches, confirming the failure-toast path specifically has no test. · fix: add or extend a test (e.g. frontend/src/__tests__/hooks/useContactedMutation.test.tsx, new file, mirroring the pattern in frontend/src/__tests__/hooks/useQuoteStatusMutation.test.tsx) that renders a component using useContactedMutation, fires the mutation for both a success (asserting the optimistic client_contacted_at prediction, then the server row replacing it via replaceProject) and a failure (asserting the aito.contactedFailed toast and that the optimistic write rolls back).

#### T-036 [P2] useFlagMutation's transform/flashId/onError are never invoked by any test

- **Source:** audit-tests · **Files:** `frontend/src/hooks/useFlagMutation.ts` · **Status:** OPEN

frontend/src/hooks/useFlagMutation.ts:21 · coverage-final.json for frontend/src/hooks/useFlagMutation.ts shows statement lines 22 (transform), 23 (flashId) and 30 (onError's showToast) never executed, while onSuccess (24-28) is covered -- meaning some test exercises a successful flag mutation's server-row replacement but never a failing one, and never checks that the optimistic `{ ...p, flag }` prediction itself is applied. `grep -rn 'flagFailed' frontend/src/__tests__` returns zero matches. · fix: add a failure-path test for useFlagMutation (e.g. in frontend/src/__tests__/hooks/useFlagMutation.test.tsx, new file, or alongside the existing FlagControl component test) that sets api.setAitoProjectFlag to reject and asserts the aito.flagFailed toast and the optimistic flag value reverting; add an assertion on the optimistic transform itself (flag visible before the mutation resolves).

#### T-037 [P2] useColumnMoveMutation's own optimistic transform (applyColumnMove) and onError are never invoked -- only its celebration onMutate/onSuccess are tested

- **Source:** audit-tests · **Files:** `frontend/src/hooks/useColumnMoveMutation.ts` · **Status:** OPEN

frontend/src/hooks/useColumnMoveMutation.ts:46 · coverage-final.json for frontend/src/hooks/useColumnMoveMutation.ts shows statement lines 47 (`transform: (previous) => applyColumnMove(...)`) and 68 (`onError: () => showToast(t('aito.moveFailed'), 'error')`) never executed. `grep -n 'moveFailed' frontend/src/hooks/useBoardDrag.ts frontend/src/hooks/useColumnMoveMutation.ts` shows the SAME i18n key `aito.moveFailed` is used by two different hooks/mutations -- useBoardDrag's own moveMutation.onError (drag-reorder) IS covered, per frontend/src/__tests__/pages/AitoBoardDragFailure.test.tsx's own header ("grep moveFailed src/__tests__ was empty before this file") -- but that file only covers useBoardDrag's onError, not useColumnMoveMutation's (Finish<->Done manual move). A regression specific to useColumnMoveMutation's own onError or its optimistic applyColumnMove transform would pass every existing test. · fix: extend frontend/src/__tests__/components/AitoDoneCelebration.test.tsx (or add a sibling test) with a case where api.moveAitoProject rejects, asserting the aito.moveFailed toast and that the optimistic column move (applyColumnMove) rolls back with the revert flash; add a case asserting the card is optimistically shown in its destination column before the PATCH resolves.

#### T-038 [P2] run_sync_loop's own per-tick exception swallow (both the periodic full pass and the wake-drain) is never exercised -- its docstring's core resilience promise is unverified

- **Source:** audit-tests · **Files:** `backend/app/services/aito_quote_sync.py` · **Status:** OPEN

backend/app/services/aito_quote_sync.py:1930 · coverage: backend/app/services/aito_quote_sync.py 1928->1938, 1930-1933, 1939->1923, 1943, 1959->1939, 1961-1964, 1968 missing (from `pytest tests/ --cov=app --cov-config=../pyproject.toml --cov-report=term-missing`). Lines 1930-1933 are the periodic tick's `except Exception: logger.exception("Aito quote sync tick failed")`, and 1961-1964 are the identical guard around the wake-drain's `run_sync_once(db, pending_only=True)`. run_sync_loop's own docstring states: "Every iteration takes its own session and swallows its own errors: one bad tick must not kill the loop, or a single transient failure would silently end syncing until the next restart" -- but no test ever makes run_sync_once (or sync_interval_seconds/sync_enabled/zoho_service.is_configured) raise from inside run_sync_loop and then asserts the loop survives and ticks again. · fix: in backend/tests/unit/test_aito_quote_sync.py, add a test driving the real run_sync_loop (mirroring test_wake_drains_a_pending_project_without_waiting_for_the_interval's TrackedSession harness) that monkeypatches run_sync_once to raise on its first call and succeed on its second, and asserts the loop is still alive and drains a pending project on the following tick/wake -- covering both the periodic-tick except block and the wake-drain except block separately.

#### T-039 [P2] sync_project's ShippingCatalogueUnavailable handler swallows an unexpected exception from its shipping-catalogue warm-up, but that fallback is never exercised

- **Source:** audit-tests · **Files:** `backend/app/services/aito_quote_sync.py` · **Status:** OPEN

backend/app/services/aito_quote_sync.py:1457 · coverage: backend/app/services/aito_quote_sync.py 1457-1471 missing. That range is the `try: await zoho_service.get_shipping_catalogue(db, refresh=True) except Exception: logger.warning("Aito shipping catalogue warm-up failed for project %s", project_id, exc_info=True)` block inside the `except ShippingCatalogueUnavailable` handler, whose own comment explains the stakes: "a DB error from its get_setting/set_setting calls, or a bug in merge_shipping_catalogue on a pathological /items payload, would otherwise escape uncaught ... breaking its own 'never raises' promise ... abort[ing] the whole tick for every project still left in the batch." No test makes get_shipping_catalogue raise something other than the already-swallowed ZohoNotConfiguredError/ZohoUpstreamError while a project is deferring on ShippingCatalogueUnavailable. · fix: in backend/tests/unit/test_aito_quote_sync.py, add a test that defers a project via ShippingCatalogueUnavailable and monkeypatches zoho_service.get_shipping_catalogue to raise a non-Zoho exception (e.g. a bare RuntimeError, simulating a DB error), asserting sync_project still returns normally (does not propagate), the project stays in its deferred state, and run_sync_once still processes the rest of that tick's batch.

#### T-023 [P3] ZohoSettings form fields have no label/input association (htmlFor/id), unlike every sibling Aito/Calculator form

- **Source:** audit-cleanliness · **Files:** `frontend/src/components/ZohoSettings.tsx` · **Status:** OPEN · **Reason:** user-approved behavior change

frontend/src/components/ZohoSettings.tsx:134 · All 8 text/password inputs in ZohoSettings.tsx (lines 134-224: clientId, clientSecret, refreshToken, organizationId, defaultContactId, defaultContactName, baseUrl, accountsUrl) render `<label className=...>{...}</label>` as a plain sibling of `<input>` with no `htmlFor`/`id` pair and no `aria-labelledby`. frontend/src/__tests__/components/ZohoSettings.test.tsx:19-28 documents this explicitly and defines a custom `inputForLabel()` helper ('The labels are plain siblings of their <input> ... testing-library's label-association queries cant find them') because `getByLabelText` does not work. By contrast, sibling forms in the same feature scope correctly pair every label: frontend/src/components/aito/NewContactForm.tsx:105,121,136,157,176, frontend/src/components/aito/ClientSection.tsx:116,167, and frontend/src/components/calculator/CalculatorInputsCard.tsx:31,111,232,253 all use `htmlFor`/`id`. · fix: add a matching id to each ZohoSettings input and htmlFor to its label (or wrap each input in its label), matching the convention already used by NewContactForm/ClientSection/CalculatorInputsCard in the same codebase area. · user-visible change: purely additive markup (id + htmlFor) with no visual change for a sighted mouse user, but it does change what a screen reader announces when focusing these fields (currently unassociated, would become properly labelled) and what testing-library's getByLabelText can find, which is the observable difference worth calling out even though nothing renders differently on screen.


### Triaged items (7, all P3) — full evidence

#### T-001 [P3] get_invoice_pdf() builds Content-Disposition from an unsanitised Zoho invoice number

- **Source:** audit-security · **Files:** `backend/app/api/routes/aito.py`

backend/app/api/routes/aito.py:1300 · backend/app/api/routes/aito.py:1300 ` filename = f"{invoice['number'] or invoice['id']}.pdf"` is passed straight to `build_content_disposition(filename, disposition="inline")` on line 1308, with no control-character strip. The sibling route does strip: backend/app/api/routes/aito.py:1596-1597 ` filename = f"{project.quote_number or project.quote_id}.pdf"` / ` filename = _CONTROL_CHARS_RE.sub("", filename)`. backend/app/utils/http.py:52-53 shows the helper only removes non-ASCII, `"` and `\` from the legacy parameter — `ascii_fallback = filename.encode("ascii", "ignore").decode("ascii").strip(" ._-") or "download"` — so ASCII C0 controls (CR, LF, TAB, ESC, DEL) in Books' `invoice_number` survive into the raw `filename="..."` header value. The module comment at aito.py:101-110 states the consequence for exactly this class of value: "A handful of them (CR, LF, and a few other C0 controls) make h11 refuse to send the response at all". · fix: In get_invoice_pdf, apply the same strip the quote route already uses before building the header: `filename = _CONTROL_CHARS_RE.sub("", filename)` immediately after line 1300 (or route the name through backend/app/utils/http.safe_download_filename, which does the same replacement). No new regex is needed — _CONTROL_CHARS_RE is already defined at aito.py:111 in the same module.

#### T-003 [P3] Guarded-rollback swallow block repeated three times inside send_invoice_email

- **Source:** audit-cleanliness · **Files:** `backend/app/api/routes/aito.py`

backend/app/api/routes/aito.py:1504 · The identical three-line pattern `try:\n await db.rollback()\nexcept Exception: # noqa: BLE001 — see the comment above\n pass` (or "see the comment on the rollback above") occurs verbatim at lines 1504-1507, 1545-1548 and 1558-1561, all inside the single `send_invoice_email` handler (1394-1564). `rg -n "except Exception: # noqa: BLE001" backend/app/api/routes/aito.py` -> only these three lines, all in this one function. · fix: Extract a tiny local helper, e.g. `async def _rollback_quietly(db): try: await db.rollback() except Exception: pass # noqa: BLE001`, defined once near the other `_`-prefixed helpers in this module, and call it from the three sites; keep the surrounding explanatory comments attached to the call sites since they explain *why* each swallow is needed, not what the swallow does.

#### T-006 [P3] Several one-off aito i18n keys (clearClient, deleteTitle, descriptionPlaceholder, done, markDone, markNotDone, newClientTitle, quoteImportAgain, showLess, showMore, stepPending, syncIdle, trashTitle) have no call site

- **Source:** audit-cleanliness · **Files:** `frontend/src/i18n/locales/en.ts`

frontend/src/i18n/locales/en.ts:108 · For each of `clearClient` (108), `deleteTitle` (14), `descriptionPlaceholder` (7), `done` (192), `markDone` (194), `markNotDone` (195), `newClientTitle` (130), `quoteImportAgain` (213), `showLess`/`showMore` (~ same block), `stepPending` (193), `syncIdle` (275), `trashTitle` (59) in en.ts, `rg -n "aito\\.<key>\\b" frontend/src -g '*.ts' -g '*.tsx'` returns zero matches anywhere outside the locale files, and no dynamic `t(\`aito.${...}\`)` template-literal lookup exists in the aito components that could reach them (checked via `rg "t\\(\\\`aito\\.\\$\\{\" frontend/src`). For example `deleteTitle` ('Delete Project') predates the current hold-to-delete UX (DeleteHoldButton.tsx uses `aito.holdToDelete` instead), and `trashTitle` ('Deleted projects') is unused while the trash button itself uses the separate `aito.trash` key. · fix: Remove these orphaned keys from all 13 locale files, or wire them up if the missing UI (e.g. a trash-drawer heading, a delete confirmation title) was meant to use them.

#### T-012 [P3] useCalculatorState's errors memo assumes every persisted field is a string and throws on a non-string value

- **Source:** audit-robustness · **Files:** `frontend/src/hooks/useCalculatorState.ts`

frontend/src/hooks/useCalculatorState.ts:232 · `const raw = state[key] as string;\n if (raw.trim() !== '' && ...)` — `loadState` merges `{ ...DEFAULT_STATE, ...legacy }` straight from `JSON.parse(localStorage)` with no per-field shape check, so a stored `{"weight": null}` (a hand-edited key, a value written by an older build, or partially-corrupt storage) survives into `state.weight` and `raw.trim()` raises TypeError during render — white-screening the whole Calculator page, and repeating on every reload because the bad value is persisted. `state.quantity.trim()` two lines below has the same exposure. The sibling `num()` helper in this very file explicitly documents tolerating this case ('a partially-shaped state ... degrades to the fallback instead of crashing'); this memo is the gap. · fix: Coerce in loadState (keep the DEFAULT_STATE value for any key whose parsed type does not match) or read through a `typeof raw === 'string' ? raw : ''` guard here and at the quantity check.

#### T-025 [P3] _parse_retry_after() accepts inf/nan/negative seconds from the Retry-After header

- **Source:** audit-security · **Files:** `backend/app/services/zoho.py`

backend/app/services/zoho.py:143 · backend/app/services/zoho.py:141-144 ` try:\n return float(value)\n except ValueError:\n pass` — the numeric branch does no finiteness or sign check, so an upstream `Retry-After: inf`, `Retry-After: nan` or `Retry-After: -1` is carried verbatim onto ZohoRateLimited.retry_after (set at :356-359 in _raise_for_status). RFC 9110 permits only a non-negative whole number of seconds; the HTTP-date branch immediately below is already floored at 0 (`max((when - datetime.now(timezone.utc)).total_seconds(), 0.0)`), so the two branches disagree on the invariant. The class docstring (:118-127) states the value is 'not currently acted on', so there is no exploit path today — but the attribute is public and the first caller to do `await asyncio.sleep(e.retry_after)` would hang the sync worker forever on `inf` and raise on `nan`. · fix: in the numeric branch, reject non-finite and negative values the same way the date branch already floors at 0 — e.g. parse to a float, then `return max(parsed, 0.0) if math.isfinite(parsed) else None`, so the header can only ever yield a finite non-negative number of seconds or None.

#### T-029 [P3] get_invoice_pdf builds Content-Disposition from an unsanitised Zoho invoice number

- **Source:** audit-robustness · **Files:** `backend/app/api/routes/aito.py`

backend/app/api/routes/aito.py:1300 · `filename = f"{invoice['number'] or invoice['id']}.pdf"` goes straight into `build_content_disposition(filename, disposition="inline")`, which only strips non-ASCII and quotes (`ascii_fallback.replace('"', "").replace("\\", "")` in utils/http.py) — ASCII control characters survive into the header value. get_quote_pdf, 300 lines below, does `filename = _CONTROL_CHARS_RE.sub("", filename)` for exactly this reason and explains that the helper's non-ASCII stripping never touches them. Books invoice numbers carry an operator-configured prefix, so a stray CR/LF or control byte there makes the response header invalid (h11 rejects it) and the operator gets a failed print with nothing in the app's own logs to explain it. · fix: apply the same `_CONTROL_CHARS_RE.sub("", filename)` used by get_quote_pdf before building the header.

#### T-040 [P3] _parse_retry_after's malformed-value and naive-HTTP-date branches are untested

- **Source:** audit-tests · **Files:** `backend/app/services/zoho.py`

backend/app/services/zoho.py:133 · coverage: backend/app/services/zoho.py 148-149, 151, 153 missing. Those lines are `except (TypeError, ValueError): return None` (a Retry-After header that is neither a number nor a parseable HTTP-date), `if when is None: return None`, and `when = when.replace(tzinfo=timezone.utc)` (a naive/no-timezone HTTP-date, which the function's own docstring documents as a deliberate design choice: "naive dates treated as UTC"). The three existing tests in backend/tests/unit/services/test_zoho_service.py (test_request_429_raises_rate_limited_with_seconds_retry_after, test_request_429_parses_an_http_date_retry_after, test_request_429_without_retry_after_header_leaves_it_none) cover a numeric header, a well-formed tz-aware GMT date, and a missing header -- none covers garbage text or a naive/tz-less date string. · fix: in backend/tests/unit/services/test_zoho_service.py, add test_request_429_with_an_unparseable_retry_after_header_leaves_it_none (Retry-After: "soon" or similar garbage) and test_request_429_parses_a_naive_http_date_retry_after (an HTTP-date string with no timezone/offset, asserting it is treated as UTC per the docstring) alongside the three existing _parse_retry_after tests.


## Verifier verdicts (VERDICTS.log, verbatim)

```
=== 2026-09-03 · iteration 1 · verifier run 1 ===
VERDICT: FAIL
BUILD: npx tsc -b --noEmit clean
LINT: ruff check/format clean · npm run lint clean
TESTS: backend 12695 passed / 1 skipped / 0 failed (BASE 12685; +10 new) · frontend 5430 passed / 0 failed. No flaky-list test failed.
SNAPSHOTS: 10/10 · SURFACE: unchanged · SANCTIONED_CHANGES: T-008 (2dda958f9, marked, matches BASELINE-CHANGELOG entry incl. the one modified assertion in test_create_with_no_priced_service_becomes_a_terminal_error 0->1)
COVERAGE: backend 72% (= baseline) · frontend 60.29% lines (= baseline). No test deleted, no exclusion added; freeze diff (pyproject.toml, vitest.config.ts, tools/, PROBES.json, snapshots/, SURFACE.md) empty.
REGRESSIONS:
- Undisclosed behavior change in 5f2f5cd46 (T-007) backend/app/services/aito_quote_sync.py: _write_back_rounded_costs rewritten from ORM re-select + unconditional setattr to a pre-round-trip snapshot (_snapshot_pushed_costs) + Core UPDATE guarded on cost_column == pushed_cost. When a cost edit commits on another session mid-round-trip the persisted <service>_cost now differs from BASE (operator's value survives instead of being overwritten by the rounded pushed figure); the two new tests assert exactly that (5000/5001 vs BASE 2400). Served back via GET /api/v1/aito/ task payloads -> user-observable. No BASELINE-CHANGELOG entry, commit not marked. Precedent in the changelog treats this class (T-032 2026-08-27, T-007 2026-08-29 "no longer reverts edits typed while its PATCH is in flight") as approval-requiring.
- Secondary (same commit): write-back statement now issued eagerly (autoflush) rather than at the later commit's ORM flush; same transaction, no constructible outcome change.
Everything else clean: e7c632510 (T-015) pure test addition; 2dda958f9 (T-008) matches its entry.
KNOWN_BROKEN_STATUS: n/a (empty at BASE; both suites green).
=== 2026-09-03 · iteration 1 · verifier run 2 (after T-007 changelog commit 6a8b0573d) ===
VERDICT: PASS
BUILD: npx tsc -b --noEmit clean · LINT: ruff check/format clean, eslint clean
TESTS: backend 12695 passed / 1 skipped / 0 failed (+10 vs BASE) · frontend 5430 passed / 0 failed. No flaky-list test fired.
SNAPSHOTS: 10/10 · SURFACE: unchanged · SANCTIONED_CHANGES: T-008 (2dda958f9) and T-007 (5f2f5cd46, sanctioned by later marked commit 6a8b0573d) — both in BASELINE-CHANGELOG.md. Disclosed assertion change in test_create_with_no_priced_service_becomes_a_terminal_error (0->1) retained its `seen == []` invariant.
COVERAGE: backend 71.80% (71748/18370 missed; baseline 71.78% = 72% rounded) — up · frontend 60.29% lines (= baseline). Freeze diff empty; no test deleted; no exclusion added.
REGRESSIONS: none · KNOWN_BROKEN_STATUS: none at BASE, still zero.
=== 2026-09-03 · iteration 2 · verifier run 1 ===
VERDICT: FAIL
BUILD: tsc clean · LINT: ruff/eslint clean
TESTS: backend 12695 passed / 1 skipped / 0 failed (345s) · frontend 384 files, 5442 passed / 0 failed. No flaky test fired.
COVERAGE: backend 72% (= baseline) · frontend 60.36% lines (baseline 60.29%) — up. Freeze diff empty. No test files deleted; loop-1..HEAD removes zero test lines, adds 254.
SNAPSHOTS: 10/10 · SURFACE: CHANGED — regen adds one line in "Frontend exported symbols — utils + hooks": `export function replaceProject` (frontend/src/utils/aitoOptimistic.ts, commit 0445d4759 T-002). No BASELINE-CHANGELOG entry covers the loop-2 range.
SANCTIONED_CHANGES: T-007, T-008 (bb00776f6) cover the whole aito_quote_sync.py delta.
REGRESSIONS: undeclared public-contract change (the added export) — FAIL per the frozen-SURFACE rule, not runtime. Runtime behavior: none — replaceProject is byte-for-byte the semantics of the seven inlined callbacks it replaced (undefined stays undefined, no append on unknown id), both pinned by new tests. b2cc84388 and 8c56c7897 are test-only.
KNOWN_BROKEN_STATUS: n/a (empty; still zero failures).
=== 2026-09-03 · iteration 2 · verifier run 2 (after T-002 SURFACE/changelog commit 0649058cd) ===
VERDICT: PASS
BUILD: tsc clean · LINT: ruff/eslint clean
TESTS: backend 12695 passed / 1 skipped / 0 failed · frontend 384 files, 5442 passed / 0 failed. No flaky entries tripped.
SNAPSHOTS: 10/10 · SURFACE: regen == committed (the +export function replaceProject line is sanctioned) · SANCTIONED_CHANGES: T-008, T-007 (bb00776f6), T-002 (0649058cd).
COVERAGE: backend 71.80% (= 72% baseline) · frontend 60.36% lines (baseline 60.29%, +0.07pp). Freeze diff (pyproject, vitest.config, tools/, PROBES.json, snapshots/) empty. No test file deleted/renamed; only 4 removed test lines in the whole range, all disclosed.
REGRESSIONS: none · KNOWN_BROKEN_STATUS: n/a.
=== 2026-09-03 · iteration 3 · verifier run 1 ===
VERDICT: PASS
BUILD: tsc clean · LINT: ruff/eslint clean
TESTS: backend 12701 passed / 1 skipped / 0 failed (313s) · frontend run 1: 3 failed / 5439 passed (2 files), full rerun on idle machine: 384 files / 5442 passed — non-reproducing load flakes. Zero test files deleted (--diff-filter=D empty).
SNAPSHOTS: 10/10 · SURFACE: regen == committed; committed BASE..HEAD delta 3 lines, all sanctioned (T-009: sync_project -> bool | None, class ZohoRateLimited; loop-2: export function replaceProject).
SANCTIONED_CHANGES: T-009 (331ae5279), T-004 (57689d1d9), T-005 (439cc623a) — entries present, commits marked. fe-i18n-parity golden 7171 -> 7152 on every count (= 4 + 15), parity lists all still []; the 13 locale files are deletion-only; 19 deleted keys independently re-grepped: zero hits. T-009 code matches its entry (429 branch before generic >=400, message byte-identical, subclass keeps every except site; break after per-project commit/broadcast). Two rewritten tests named in the entry, neither weakened.
COVERAGE: backend 71.80% (= 72% baseline; zoho.py 96.41%, aito_quote_sync.py 94.90%) · frontend 60.35% lines (baseline 60.29%). Freeze diff (pyproject, vitest.config, tools/, PROBES.json) empty.
REGRESSIONS: none · KNOWN_BROKEN_STATUS: n/a.
=== 2026-09-03 · iteration 4 · verifier run 1 ===
VERDICT: PASS
BUILD: tsc clean · LINT: ruff/eslint clean
TESTS: backend 12708 passed / 1 skipped / 0 failed (313s; +23 vs BASE) · frontend 384 files, 5442 passed / 0 failed. No flaky entry fired.
SNAPSHOTS: 10/10 · SURFACE: regen == committed (3-line committed delta all from earlier verified iterations) · SANCTIONED_CHANGES: T-010 (c14734f77, entry in same commit) — the only behavior change this iteration; verified: reconcile-branch only, pending and NULL-quote_id/error terms byte-identical, is_(None) guard on nullable quote_status present, board_column non-nullable so bare != is safe; four new tests pin exclusion + untouched pending path. T-014 (9917a0449) and T-013 (83b80944c) test-only.
COVERAGE: backend 71.81% (baseline 71.78%) up · frontend 60.36% lines (baseline 60.29%) up. Freeze diff empty; no test file deleted/renamed; zero removed test lines in loop-3..HEAD.
REGRESSIONS: none · KNOWN_BROKEN_STATUS: n/a.
=== 2026-09-03 · iteration 5 · verifier run 1 ===
VERDICT: PASS
BUILD: tsc clean · LINT: ruff/eslint clean
TESTS: backend 12712 passed / 1 skipped / 0 failed (324s) · frontend 385 files, 5448 passed / 0 failed. No flaky test failed.
SNAPSHOTS: 10/10 · SURFACE: regen == committed; this iteration adds nothing to SURFACE.md or snapshots/ · SANCTIONED_CHANGES: T-011 (4bc33acc2) — code matches entry (cooldown gate inside `if refresh and not fresh`, stamp on except arm, clear on success, no settings/DDL change). Older sanctioned artifacts re-matched: T-009 SURFACE lines, T-002 export, T-004/T-005 golden 7171->7152.
COVERAGE: backend 71.81% (= 72% baseline) · frontend 60.36% lines (baseline 60.29%). Freeze diff empty; no test deleted/renamed; no skip/only added. One rewritten assertion (test_get_shipping_catalogue_survives_zoho_being_down n==2 -> n==1) pinned the sanctioned-removed behavior and is replaced by four dedicated tests — net assertions up.
REGRESSIONS: none · KNOWN_BROKEN_STATUS: n/a.
=== 2026-09-03 · iteration 6 · verifier run 1 ===
VERDICT: PASS
BUILD: tsc clean · LINT: ruff/eslint clean
TESTS: backend 12792 passed / 1 skipped / 0 failed (311s; +107 vs BASE) · frontend run 1: 5447 passed / 1 failed (name not captured by the grep), clean full rerun: 5448 passed / 0 failed — load flake. No test file deleted; only additive assertion edits + two fixtures setting quote_status_confirmed=True (described in the entry).
SNAPSHOTS: 10/10 · SURFACE: regen == committed · SANCTIONED_CHANGES: T-026 (276b5c541) verified site-by-site (reset in set_quote_status; five set-True sites; or_() predicate; reordered _still_selected); DDL migration additive via _safe_execute; goldens app-ddl (+1 line) and app-migrations-index (+1 line) exactly as the entry quotes; SURFACE.md aito_projects 42->43; app-openapi-index unchanged (column not serialised). T-030 (ea41ab996), T-031 (06d3c44b9) test-only.
COVERAGE: backend 71.82% (= 72% baseline; 74.41% line-only) · frontend 60.36%/60.35% lines (baseline 60.29%). Freeze diff empty; concurrency/branch settings intact.
REGRESSIONS: none · KNOWN_BROKEN_STATUS: n/a.
=== 2026-09-03 · iteration 7 · verifier run 1 ===
VERDICT: PASS
BUILD: tsc clean · LINT: ruff/eslint clean
TESTS: backend 12793 passed / 1 skipped / 0 failed · frontend 386 files, 5455 passed / 0 failed. No flaky test failed.
SNAPSHOTS: 10/10 · SURFACE: regen == committed · SANCTIONED_CHANGES: none new (BASELINE-CHANGELOG.md untouched in loop-6..HEAD; no golden/SURFACE/PROBES/tools/config diff this iteration). Earlier diffs re-mapped to T-008/T-009/T-004/T-005/T-002/T-026.
COVERAGE: backend 72% (= baseline) · frontend 60.34% lines (baseline 60.29%). Freeze diff empty; no test deleted; no ignore/skip pragmas added; assertions net +178.
REGRESSIONS: none. Diff review: replaceProject matchId default reproduces the old match; settleProject preserves write-then-invalidate at all six sites with trailing steps inline; _sweep_predicate returns the same or_() SQL; pending_only path unchanged.
KNOWN_BROKEN_STATUS: none.
=== 2026-09-04 · iteration 8 · verifier run 1 ===
VERDICT: FAIL
BUILD: tsc clean · LINT: ruff/eslint clean
TESTS: backend 12803 passed / 1 skipped / 0 failed (+118 vs BASE) · frontend 386 files, 5455 passed / 0 failed. No flaky test tripped; no test deleted; no assertion weakened.
SNAPSHOTS: 10/10 · SURFACE: regen == committed; no golden/SURFACE/PROBES/tools/config diff this iteration · SANCTIONED_CHANGES: T-024 (eb017dee6), T-027 (cb6b7b26a) — entries + markers, code matches line for line. Earlier deltas re-mapped to T-026/T-004/T-005/T-009/T-002.
COVERAGE: backend 71.82% (= 72% baseline) · frontend 60.35% lines (baseline 60.29%).
REGRESSIONS: unsanctioned behavior change in ed8031a54 (T-028): process-global _throttled_until makes run_sync_once return 0 for min(Retry-After, 900s) or a 60s fallback after any 429 — every card sits pending un-attempted for that window where each tick previously retried; sync-timing only (no HTTP response changes) but observable on the board. No BASELINE-CHANGELOG entry, no commit marker. Evidence: test_429s_defer_indefinitely_without_escalating_or_spending_the_failure_budget needed a fake advancing clock to keep asserting ==1 per tick. Precedent: T-011 shipped the identical cooldown shape as a marked, changelogged change. Fix confined to T-028: changelog entry + marker, or revert ed8031a54.
NOTE (orchestrator): the verifier cited "PLAN.md line 308" — it read the untracked PLAN.md from the worktree. Blindness is only enforced via git diff; a future briefing should forbid reading PLAN.md/TRIAGE.md/VERDICTS.log/findings-*.json explicitly. Verdict unaffected.
KNOWN_BROKEN_STATUS: n/a.
=== 2026-09-04 · iteration 8 · verifier run 2 (after T-028 changelog commit 53e132d81; verifier told not to read loop state files) ===
VERDICT: PASS
BUILD: tsc clean · LINT: ruff/eslint clean
TESTS: backend 12803 passed / 1 skipped / 0 failed (319s) · frontend 386 files, 5455 passed / 0 failed. No test file deleted; no flaky test failed.
SNAPSHOTS: 10/10 · SURFACE: regen == committed · SANCTIONED_CHANGES: T-024, T-027, T-028 (entries + marked commits in range). Earlier frozen-file diffs all trace to marked commits.
COVERAGE: backend 72% (= baseline) · frontend 60.35% lines (baseline 60.29%). Freeze diff empty.
REGRESSIONS: none. Notes: T-024 is a real contract change the goldens cannot see (enum and decorators unchanged) — the changelog is its only record and it matches; T-027's project_pk capture before rollback is correct; T-028's rewired e2e test still asserts ==1 per tick with an advancing clock (only removed test line: the signature gaining monkeypatch), and the autouse reset fixture guards the module global under xdist.
KNOWN_BROKEN_STATUS: none.
```

## Archive

The untracked loop state of this campaign — PLAN.md, TRIAGE.md, BASELINE.md, VERDICTS.log and the eight raw auditor findings files — is committed alongside this report under `refactor-campaign10-archive/`.
