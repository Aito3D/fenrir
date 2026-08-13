# FINAL_REPORT.md — refactor-loop campaign 2 (Aito scope)

**Branch:** `auto-refactor-loop` · **BASE:** tag `refactor-base` (`033e88d74`) · **HEAD:** `967cc02e2`
**Upstream:** cut from `8cea9c9ac` on `main` · **Dates:** 2026-08-11 → 2026-08-13

## Outcome

| | |
|---|---|
| Iterations run | **13** (`loop-1` … `loop-13`), every one verified by a blind verifier |
| Survey rounds | **3 of 3** (the configured maximum) |
| Commits on the branch | 13 — one squashed commit per iteration |
| Tasks | 52 total · **43 DONE** · 2 OPEN · 6 BLOCKED awaiting your approval · 1 WONTFIX-AUTO |
| Triaged for you | **21** findings, all reproduced in full below |
| Why it ended | **MAX_ITER** — the cap was raised twice (8 → 12 → 13); round 3 then found work that did not fit |

**Verdicts:** 11 PASS, **2 FAIL** (iterations 4 and 9), both fixed and re-verified within their iteration.

## Gates at exit

| Gate | BASE | Final |
|---|---|---|
| Backend tests | 10057 passed, 1 skipped, 0 failed | **10155 passed, 1 skipped, 0 failed** (+98) |
| Backend Aito coverage (sysmon) | 1982 stmts / 38 missed | 2014 stmts / **38 missed** — ratchet held |
| Frontend Aito statements missed | 142 | **131** |
| Frontend Aito branches missed | 217 | **214** |
| Frontend Aito functions missed | 46 | **44** |
| Frontend Aito lines missed | 87 | **75** |
| Golden probes | 9/9 | **9/9** |
| SURFACE.md | frozen | +1 line (`__resetOwnAckedVersion`), sanctioned by T-021 |
| known-broken tests | none | none |
| `tools/`, `PROBES.json` | — | byte-identical to BASE |

Campaign-wide test integrity, verified by the final verifier: **0 test files deleted or renamed**, **2 removed assertion lines in the entire standing diff** (both updated, not weakened — the approved `marked_sent` tri-state), no coverage exclusion added, no include glob narrowed, no `pragma: no cover` / `xfail` / `skipif` anywhere.

## Findings by auditor

| Auditor | Filed | DONE | Blocked (need approval) | WONTFIX-AUTO |
|---|---|---|---|---|
| audit-security | 9 | 5 | 4 | 0 |
| audit-robustness | 12 | 7 | 3 | 0 |
| audit-cleanliness | 1 | 1 | 0 | 0 |
| audit-tests | 3 | 1 | 0 | 1 |
| survey (hand-added) | 4 | 4 | 0 | 0 |
| **verifier** | **23** | **21** | 0 | 0 |

The single most telling number: **21 of 43 completed tasks came from the blind verifier**, not the auditor panel — more than half this campaign's work was fixing what the campaign itself introduced or exposed.

## What each survey round found

**Round 1 (iteration 0)** — 15 findings filed, 8 triaged. The obvious surface: an authorization gap on `create_project`, unbounded description fields, a lost-update race, a duplicate-email risk in `send_quote_email`.

**Round 2 (iteration 7)** — 8 findings filed, 8 triaged, **7 requiring your approval**. This was the productive round, and it found the campaign's two most serious issues *after* seven iterations of refactoring had already landed: a caller holding only `aito:create` could pair a real Books estimate id with `quote_status: accepted` and have the sync worker POST `/status/accepted` onto a **live customer estimate**; and `_apply_estimate` cleared `quote_sync_state` to `idle` unconditionally, silently losing any edit that committed during the Books round trip.

**Round 3 (iteration 12)** — 10 findings filed, 5 triaged, **6 requiring approval**, 3 worked immediately. Not a quiet round. It found two more P1 sync-worker races that corrupt live Zoho data, and — independently, from all three of security, robustness and tests — that **T-038's own approved fix was incomplete**: the sync worker emits a second `aito_changed` that still bypassed the permission filter.

## User-approved behavior changes

13 changes were approved across two sweeps plus three out-of-band asks. Each is recorded in `BASELINE-CHANGELOG.md` with its observable consequence, and each commit carries `(user-approved behavior change)`.

**Round 1 (5):** T-012 cross-operator 409 · T-009 `quote_status` 422 without a `quote_id` · T-013 commit `quote.emailed` before local bookkeeping · T-011 10k cap on task descriptions · T-007 shipping rate formatted with `i18n.language`.

**Round 2 (7):** T-036 require `aito:update` for a decided status on create · T-037+T-049 collection bounds · T-038 filter the WebSocket fan-out by `aito:read` · T-046 atomic version guard · T-047 narrow the ack comparison · T-048 tri-state `marked_sent` with a warning toast.

**Out-of-band (3):** T-021 a test-only export on the frozen SURFACE.md · T-044 a race-window display difference · T-053 raising the task cap from 50 to 300 after the verifier found the Zoho import path posts one task per header group.

**Two scope exceptions** were granted and are recorded in `BASELINE.md`: T-038 (shared WebSocket infrastructure — the fix was structurally unreachable from the Aito fence) and T-048 (an Aito-exclusive hook, one type line in the shared API client, and one new key in each of 13 locale files, which the repo's i18n parity gate requires).

## What the blind gate caught

Both FAILs were self-inflicted by the campaign's own fixes, and both were found by *running* code rather than reading it:

**Iteration 4** — T-011 placed a validation bound on `AitoTaskBase`, which `AitoTaskResponse` inherits. Any pre-existing over-cap row would have made `GET /aito/{id}/tasks` return **500**. The verifier proved it by construction, failed the iteration, and the fix added a pin test that fails if anyone re-inherits it.

**Iteration 9** — two regressions in one iteration. T-047's first form could send a version *lower* than the session captured, producing a spurious 409 on a brand-new editor; T-046's claim `UPDATE` triggered `updated_at`'s `onupdate`, so a no-op save reordered the Done/Trash grids. The verifier established both were new by running the same probe against three revisions.

The final verifier measured SQLAlchemy's `refresh` semantics directly, confirmed a pending unflushed write **is** silently discarded, then instrumented `AsyncSession.refresh` across all 779 Aito tests to prove no site ran with dirty state — and found the one path that survives only because an unrelated `SELECT` autoflushes first. That is recorded as T-073.

## Left for you — 6 findings awaiting your approval

Each changes observable behaviour, so none was worked. Full evidence is in `PLAN.md` (archived, see below); `plan.py show <id>` prints any of them.

| id | pri | finding |
|---|---|---|
| **T-070** | P1 | `broadcast_aito` awaits `send_text` for every connection **while holding the manager lock, with no timeout**. One dead-but-unclosed peer blocks every other lock user forever — new WebSocket handshakes, disconnects, and opening an Aito card all hang. The same shape exists in the pre-existing `broadcast()`; T-038 reproduced it verbatim, so this is a pre-existing app-wide fragility the campaign copied rather than introduced. |
| T-063 | P2 | The inbound `aito_presence` handler has **no `aito_read` gate** — the read half was gated by T-038, the write half was not. A Viewers-group principal can insert its username into any project's viewer list, unthrottled, each message costing an O(connections) fan-out. |
| T-065 | P2 | Aito read routes map onto the broad `can_read_status` API-key scope, so a kiosk/dashboard key can enumerate and **download the shop's customer invoices and quote PDFs**. Pre-existing; touches `core/auth.py`, outside the fence. |
| T-066 | P2 | `add_task` gates on `AITO_CREATE` while its sibling `update_task` requires `AITO_UPDATE` — so an `aito:create`-only principal can push an arbitrarily priced line onto an existing customer's live estimate. The same trust boundary T-036 closed, left open on the adjacent endpoint. |
| T-071 | P2 | A swallowed principal-resolve failure at WebSocket connect **permanently mutes Aito realtime for that socket** — a transient DB hiccup leaves the operator's board silently not updating, with only a server-side warning. Introduced by T-038. |
| T-072 | P3 | `client_id` has no `max_length` on either create or update, while the column is `String(50)` and the value is handed to Books as a query parameter. The campaign's own three cap passes walked past it. |

## Left for you — 2 open tasks

- **T-056** [P3] — a residual settle window: the marker check happens in `sync_project` but the worker commits later in `run_sync_once`, so an edit committing in *that* window can still be clobbered. Pre-existing in T-044's design and narrowed by T-051. Its own evidence says to **measure reachability before redesigning the settle path**, which is why it was not rushed into the final iteration.
- **T-073** [P3] — the refresh-site comment that is false on the restore path, plus a dangling cross-reference in the T-038 follow-up note.

## Left for you — 1 auto-retired task

- **T-018** [P1] — WONTFIX-AUTO. The coverage gate's `Aito*`-prefix test globs missed 14 real, passing test files. **This was corrected at setup, before any task ran** — the gate now discovers tests by grep, which tightened the ratchet from 306 to 142 missed statements. The task was retired because the underlying problem was already fixed; the auditor's suggested remedy (renaming 14 files to satisfy a glob) was rejected as churn.

## Known flakes (8, none in the Aito production path)

`PrintModal.test.tsx` · `ModelViewerModal.test.tsx` · `SettingsPage.test.tsx` (external_url) · `LoginPage.test.tsx` (unauthenticated redirect) · backend `test_aito_quote_sync.py` wake-drain · `test_print_archive*` plate-zero · `test_library_slice_api.py` (several) · `test_extract_video_last_frame.py` (environmental — wants `/usr/bin/ffmpeg`, which is at `/opt/homebrew/bin` here).

Four of these are SQLAlchemy/concurrency-shaped and surface only under `-n 30`. Worth a dedicated look outside this campaign.

## Two process notes worth carrying forward

**Coverage runs containing failures give wrong numbers.** A worker reported 36 missed statements from a run that hit two flakes; four independent clean measurements all give 38. Cost about an iteration to resolve. Always re-run a coverage pass that had failures.

**Line-number citations decay.** Several comments and test docstrings now cite lines that have moved, and one such citation went stale *within* the iteration that created it. Three are recorded as T-058/T-059/T-060. Prefer citing a function name plus a distinctive fragment.

## Archived state

Everything below was copied out of the worktree before handover, to:

```
/Users/paultheis/Documents/Code/bambuddy-refactor-archive/
```

`PLAN.md` (703 lines, all 52 tasks with full evidence) · `TRIAGE.md` (275 lines) · `VERDICTS.log` (1,207 lines — every verifier's full reasoning across 13 iterations) · `BASELINE.md` (348 lines — ratchets, flakes, scope exceptions, the coverage-tracer investigation) · `BASELINE-CHANGELOG.md` · all 12 `findings-audit-*.json` files.

---

# Triaged findings (21) — full evidence

These were filed to `TRIAGE.md` rather than worked, per the campaign's `TRIAGE: P2,P3` setting. None is a regression from this campaign unless its text says so. Reproduced in full here so this report is self-contained.

#### T-005 [P2] — get_invoice/get_invoice_pdf/get_quote_pdf/get_quote_email repeat a not-deleted project lookup instead of reusing _get_active_project_or_404
*Source: audit-cleanliness · Files: `backend/app/api/routes/aito.py`*

backend/app/api/routes/aito.py:1004 · Four newer routes each do: `project = await db.get(AitoProject, project_id)` then `if project is None or project.status == "deleted": raise HTTPException(status_code=404, detail="Project not found")` — get_invoice:1003-1005, get_invoice_pdf:1047-1049, get_quote_pdf:1099-1101, get_quote_email:1199-1201. `AitoProject.status` is a strict binary column (models/aito_project.py:25, comment `# active|deleted`; restore_project's own query at aito.py:1902 matches `status == "deleted"` specifically), so `status != "deleted"` and `status == "active"` are exactly equivalent for every row. That makes this pattern identical in effect to the already-extracted `_get_active_project_or_404` (aito.py:1336-1342, used at 6 other sites) — these 4 sites just re-derive it with `db.get` + a manual check instead of calling it, reintroducing the duplication campaign 1 removed everywhere else. Confirmed with `rg -n 'project.status == "deleted"' backend/app/api/routes/aito.py` -> only these 4 sites plus restore_project's own distinct 'deleted' lookup (out of scope for this change) and list_trash. SUGGESTED FIX (from audit-cleanliness): Replace `project = await db.get(AitoProject, project_id); if project is None or project.status == "deleted": raise HTTPException(...)` in these 4 handlers with `project = await _get_active_project_or_404(db, project_id)`, matching every other read/write route in the file.

#### T-014 [P2] — addNote rollback writes to the depth cache current at failure time, not the one the optimistic row went into
*Source: audit-robustness · Files: `frontend/src/components/aito/history/ActivityRail.tsx`*

frontend/src/components/aito/history/ActivityRail.tsx:84 · onMutate prepends the placeholder into `['aito-events', projectId, depth]` and onError removes it from `['aito-events', projectId, depth]` — both read `depth` from component scope, and react-query v5's MutationObserver.setOptions forwards the newest render's options to the in-flight mutation, so onError sees the depth at FAILURE time. Sequence: user types a note at depth 'detail' and submits; while the POST is in flight they click the 'Story' depth button; the POST fails. onError filters the placeholder id out of the ['aito-events', id, 'story'] pages (which never contained it) and leaves it in the ['aito-events', id, 'detail'] pages. Unlike onSuccess, onError does not invalidate, and the default staleTime is 60s (App.tsx:109), so switching back to Detail shows a note that was never persisted — an audit timeline asserting an event that does not exist — for up to a minute, while the toast said the save failed and the text was restored to the input for a retry. SUGGESTED FIX (from audit-robustness): Capture the depth in the mutation variables at mutate time and have onMutate/onError both key off that captured value; or have onError invalidate `['aito-events', projectId]` instead of hand-patching one page.

#### T-017 [P2] — Zoho comment timestamp/UTC-offset parse-failure fallbacks are untested
*Source: audit-tests · Files: `backend/tests/unit/test_aito_zoho_comments.py`*

backend/tests/unit/test_aito_zoho_comments.py:144 · backend/app/services/aito_zoho_comments.py:144-157 (_comment_utc_offset_hours) falls back to DEFAULT_COMMENT_UTC_OFFSET_HOURS and logs a warning when the 'zoho_comment_utc_offset_hours' setting is not a valid float (the `except ValueError` at 155-157). Lines 160-176 (_comment_timestamp) fall back to `datetime.utcnow()` — NOT the org-local conversion — and log a warning when a comment's date+time string matches none of the three known formats (the `if local is None` branch at 174-176). grep across backend/tests/unit/test_aito_zoho_comments.py shows only test_comment_timestamps_convert_from_org_local_time_to_utc_by_default and test_comment_utc_offset_is_read_from_settings_not_hardcoded — both exercise the happy path with a valid numeric offset and a well-formed date/time; neither an unparseable offset setting nor an unparseable comment date/time string is ever fed in. A comment whose Zoho payload has an odd date format would silently mis-timestamp the mirrored event (using the instant of mirroring, not the comment's actual time), which feeds directly into `_is_our_echo`'s time-window comparison and could cause echo-detection false positives/negatives on the timeline. SUGGESTED FIX (from audit-tests): add (1) a case that sets 'zoho_comment_utc_offset_hours' to a non-numeric string (e.g. 'not-a-number') and asserts mirror_comments/_comment_utc_offset_hours falls back to DEFAULT_COMMENT_UTC_OFFSET_HOURS rather than raising; (2) a case with a comment dict whose 'date'/'time' fields match none of the three parsed formats (e.g. date='not-a-date') and assert the mirrored event is still written (no crash) with an occurred_at close to 'now' rather than a wrong historical time.

#### T-019 [P2] — EventItem's sync.conflict/sync.status_rejected detail line and ElapsedGutter day/hour bucketing are never rendered in any test
*Source: audit-tests · Files: `frontend/src/__tests__/components/AitoActivityRail.test.tsx`*

frontend/src/__tests__/components/AitoActivityRail.test.tsx:42 · frontend/src/components/aito/history/EventItem.tsx:42-45 renders the 'ours -> theirs' conflict line for kind 'sync.conflict' or 'sync.status_rejected' (via detailText), and lines 63-72 (ElapsedGutter) compute a human-readable gap using day/hour/minute Intl.RelativeTimeFormat buckets, shown only when showElapsed is true. `grep -rln "sync.conflict\|sync.status_rejected\|showElapsed\|ElapsedGutter" frontend/src/__tests__/` returns zero matches anywhere in the whole frontend test suite — not just the gate-visible subset. AitoActivityRail.test.tsx (the only test that renders EventItem) covers only the 'zoho.comment' detail branch (line 154: "renders the verbatim Books text for an unrecognised zoho.comment"). This is the exact UI surface a user sees when a local decision and Zoho's state disagree during concurrent edits — the multi-user sync work that landed after campaign 1 and is the least-tested code in the feature. A bug that always shows an empty conflict line, or crashes on an unexpected detail shape, would not be caught by any test today. ORCHESTRATOR NOTE: under the corrected coverage gate, history/EventItem.tsx is now the WEAKEST in-scope frontend file (66.66% stmts), which independently corroborates this finding. SUGGESTED FIX (from audit-tests): Add cases to AitoActivityRail.test.tsx (or a new AitoEventItem.test.tsx if EventItem is exported standalone): (1) render an event with kind 'sync.conflict' and detail={ours: 'accepted', theirs: 'declined'} and assert the rendered text contains 'accepted' and 'declined' in order; (2) same for 'sync.status_rejected'; (3) render two consecutive events with showElapsed=true whose occurred_at values differ by >1 day, >1 hour (but <1 day), and <1 minute, and assert the day/hour bucket text appears for the first two and no gutter row renders for the third (seconds < 60 returns null).

#### T-039 [P2] — createMutation never sends shipping fields - the manual create-with-shipping payload path is completely untested
*Source: audit-tests · Files: `frontend/src/hooks/useAitoPageMutations.ts`*

frontend/src/hooks/useAitoPageMutations.ts:98 · coverage/coverage-final.json branch id 10 on useAitoPageMutations.ts line 98: counts=[0,11] - the truthy arm of `...(shipping ? shippingPayload(shipping) : {})` (line 98) is NEVER taken across the whole 799-test aito suite; every call to createMutation.mutationFn in the tests passes shipping=undefined. `grep -n 'createMutation|deleteMutation' frontend/src/__tests__/hooks/useAitoPageMutations.test.tsx` -> no matches (that file only tests importMutation's importableShipping gate). `grep -n 'onCreate\b' frontend/src/__tests__/components/NewProjectDrawer.test.tsx` shows onCreate is always a bare `vi.fn()` mock, so the drawer's own 'hands the shipment to onCreate' test (line 608) never reaches the real createProject/createMutation code. AitoPage.test.tsx's own createProject() helper (lines 162-177) never fills in a shipping block. So a regression that drops shipping from the manual-create POST body (e.g. swapping `shipping` for `!shipping`, or breaking shippingPayload) would pass every existing test while silently shipping a project with no delivery address attached. FIX: in frontend/src/__tests__/hooks/useAitoPageMutations.test.tsx add a describe('createMutation') block calling createMutation.mutate with a filled ShippingDraft and asserting api.createAitoProject's body includes shipping_island/shipping_first_name/shipping_last_name/shipping_phone/shipping_price (mirroring the existing importMutation shipping assertions in the same file); alternatively extend AitoPage.test.tsx's createProject() helper with a shipping-filled variant and assert the POST body via a captured spy.

#### T-040 [P2] — Board load-failure Retry button's onClick (aitoQuery.refetch) is rendered but never actually clicked
*Source: audit-tests · Files: `frontend/src/pages/AitoPage.tsx`*

frontend/src/pages/AitoPage.tsx:300 · coverage/coverage-final.json statement id 68 on AitoPage.tsx: {start:{line:300,column:53},end:{line:300,column:74}} count=0 - the arrow body `() => aitoQuery.refetch()` inside `<Button variant="secondary" onClick={() => aitoQuery.refetch()}>` (line 300) is never invoked. frontend/src/__tests__/pages/AitoPage.test.tsx lines 196-203 only assert the button and its role exist (`screen.getByRole('button', { name: 'Retry' })`) after a 500 response; it never clicks it or asserts a second fetch happens. A regression that wires the button to the wrong query, a no-op, or breaks refetch would leave a user permanently stuck on the error screen with no test catching it. FIX: extend the existing 'shows the load-failed error state' test (around line 196) to swap the mocked handler back to a 200 response after clicking Retry, and assert the board content (e.g. a known project's description) appears once refetch resolves.

#### T-041 [P2] — TrashGrid's onRetry wiring to trashQuery.refetch() is never exercised through AitoPage
*Source: audit-tests · Files: `frontend/src/pages/AitoPage.tsx`*

frontend/src/pages/AitoPage.tsx:341 · coverage/coverage-final.json statement id 69 on AitoPage.tsx: {start:{line:341,column:25}} count=0 - the arrow body `() => trashQuery.refetch()` passed as onRetry to `<TrashGrid .../>` (line 341) is never invoked. `grep -n 'onRetry|Retry' frontend/src/__tests__/components/AitoTrashGrid.test.tsx` shows TrashGrid's own test only asserts a mocked `vi.fn()` onRetry is called (lines 108-112) - it never renders through AitoPage, so the REAL wiring at line 341 is untested. A regression pointing onRetry at the wrong query key (e.g. 'aito-projects' instead of 'aito-trash') would silently break the trash view's error recovery with nothing catching it. FIX: add a test to AitoPage.test.tsx that switches to the trash view, mocks the trash endpoint to 500 then 200, clicks the Retry button TrashGrid renders, and asserts the trashed project appears once the retry succeeds.

#### T-042 [P2] — NewProjectDrawer's onClose (Cancel/dismiss) callback from AitoPage is never invoked in any test
*Source: audit-tests · Files: `frontend/src/pages/AitoPage.tsx`*

frontend/src/pages/AitoPage.tsx:389 · coverage/coverage-final.json statement id 71 on AitoPage.tsx: {start:{line:389,column:53},end:{line:389,column:74}} count=0 - the arrow body `() => setShowModal(false)` inside `{showModal && <NewProjectDrawer onClose={() => setShowModal(false)} onCreate={createProject} />}` (line 389) is never run. Every AitoPage test that opens the drawer (AitoPage.test.tsx's createProject() helper, AitoPageClientSync.test.tsx's openDrawer()) always proceeds to submit or leaves the drawer open; none clicks Cancel, presses Escape, or otherwise triggers a dismissal to confirm the modal actually closes and showModal really flips back to false. A regression breaking this wiring (e.g. passing the wrong handler, or NewProjectDrawer's internal useDismissableDialog losing its onClose) would leave the create drawer permanently stuck open for anyone who tries to cancel, undetected. FIX: add a test that opens the drawer via the 'Project' button, dismisses it (Escape key or the drawer's own close control), and asserts the drawer unmounts (e.g. the 'Client account' text disappears) and the board is interactable again, without calling api.createAitoProject.

#### T-043 [P2] — mirror_comments silently drops any Zoho comment missing comment_id, contradicting the module's own LOSSLESS guarantee, with no test and no logging
*Source: audit-tests · Files: `backend/app/services/aito_zoho_comments.py`*

backend/app/services/aito_zoho_comments.py:214 · backend/app/services/aito_zoho_comments.py:212-215: `for comment in comments:` / `comment_id = comment.get("comment_id")` / `if not comment_id:` / `continue` - a comment payload from Books with no comment_id key (or an empty one) is skipped with ZERO logging and no event recorded. The module docstring (lines 1-6) explicitly promises 'CLASSIFICATION IS BEST-EFFORT AND LOSSLESS', but this path is neither logged nor tested: `grep -n 'comment_id' backend/tests/unit/test_aito_zoho_comments.py` shows every fixture supplies a comment_id (c-1, c-dup, c-2, c-3, c-tz-default, c-tz-configured) - none omits it. If Books ever returns a comment without an id (a future API version, or a malformed webhook payload), it vanishes from the timeline with no trace, which is exactly the 'lossless' promise this path breaks silently. FIX: add a test asserting mirror_comments(db, project, [{'description': 'no id', 'date': '2026-01-01', 'time': '10:00'}]) writes zero events and returns 0 - pinning the current drop-silently behavior EXPLICITLY rather than leaving it implicit. Whether a logger.warning should also fire on this path (to match the 'lossless' claim) is a PRODUCTION change and must be decided separately, not folded into the test task.

#### T-045 [P2] — run_sync_once reads project.id after sync_project may have rolled the session back, losing the failure state it just wrote
*Source: audit-robustness · Files: `backend/app/services/aito_quote_sync.py`*

backend/app/services/aito_quote_sync.py:1422 · `await _apply_rules(db, project, await _summary_for(db, project.id))` touches project.id (and _apply_rules then reads project.board_column / quote_status) immediately after `await sync_project(db, project)`. sync_project's comment-mirror handler and _terminal_error both call _rollback_after_terminal_failure, and Session.rollback() EXPIRES every attribute - confirmed empirically by the auditor: a bare `p.id` read after `await session.rollback()` raises MissingGreenlet: greenlet_spawn has not been called. sync_project only un-expires the row as a side effect of a record() flush, which it SKIPS in exactly two cases: the comment-mirror block (rolls back on a real zoho_comment_id IntegrityError, then just sets quote_sync_failures = 0 and returns) and _terminal_error when the sync.failed record is deduped (`if not already_in_error or previous_sync_error != ...`). In those cases this line raises MissingGreenlet, the surrounding `except Exception` rolls back and logs 'Aito quote sync failed to commit project %s' - so the 'error' state and message this tick computed are NEVER PERSISTED (the card shows no failure, the worker retries and re-spends Books calls next tick) and the operator is pointed at a commit problem that never happened. FIX: use the loop's own `project_id` int instead of `project.id`, and re-fetch the row with `await db.get(AitoProject, project_id)` after sync_project returns, before _apply_rules, so no possibly-expired instance is touched.

#### T-061 [P2] — broadcast / broadcast_aito / broadcast_to_user repeat the same connection-loop-and-cleanup body three times
*Source: audit-cleanliness · Files: `backend/app/core/websocket.py`*

backend/app/core/websocket.py:52 · broadcast() (lines 52-69), broadcast_aito() (lines 71-118) and broadcast_to_user() (lines 120-154) each INDEPENDENTLY re-implement the identical shape: `if not self.active_connections: return`, `data = json.dumps(message)`, `async with self._lock:` guarding a `disconnected = []` accumulator, a `for connection in self.active_connections: try: await connection.send_text(data) except Exception: disconnected.append(connection)` loop (with an extra continue-based filter predicate inserted in the latter two), then the same `for conn in disconnected: if conn in self.active_connections: self.active_connections.remove(conn)` cleanup. The ONLY real variance across the three is which predicate (none / aito_read / bambuddy_principal_user_id == user_id) gates a connection before send_text. broadcast_aito was added by THIS campaign (T-038) as a deliberate near-copy rather than a generic primitive, on the reasoning that a predicate API would leak ConnectionManager's internal state contract across the module boundary - that reasoning was sound for a single added method, but with three near-copies now standing the balance has shifted. FIX: extract the shared send-and-cleanup loop into ONE PRIVATE helper, e.g. `async def _broadcast_filtered(self, message, predicate=lambda conn: True)`, and have all three call it with their own predicate - private, so the internal-contract objection does not apply. Mechanical and behavior-preserving IF each call site's predicate reproduces exactly the current filter (none / aito_read defaulting TRUE for an unstamped connection / user_id match). IMPORTANT: this file is SHARED, cross-feature infrastructure used by printer status, print start/complete, archive events, queue toasts and spool warnings. It is outside the campaign's Aito fence and outside both coverage globs, so no ratchet measures it - any work here needs deliberate tests and a scope decision from the user first.

#### T-064 [P2] — connection is admitted to the broadcast list before aito_read is stamped, and broadcast_aito defaults unstamped sockets to permitted
*Source: audit-security · Files: `backend/app/api/routes/websocket.py`*

backend/app/api/routes/websocket.py:110 · THIRD INCOMPLETENESS IN T-038, and the one the iteration-9 verifier explicitly cleared as harmless - this auditor disagrees, with an argument worth weighing. The socket joins ws_manager.active_connections at line 110 (`await ws_manager.connect(websocket)`) but websocket.state.aito_read is not written until line 141, and for any real user principal there is an AWAITED DB ROUND TRIP in between (`async with async_session() as db: principal_user_id, aito_read = await _resolve_principal_and_aito_read(principal, db)`). During that await, broadcast_aito treats the socket as PERMITTED because it fails OPEN: `if not getattr(connection.state, "aito_read", True): continue` (core/websocket.py:109). So a principal denied AITO_READ - the default Viewers group - receives any aito_changed (project_id + action + the acting operator's username) or aito_presence_state (full username->project-id viewer map) that fires inside its own connect window, and CAN FARM THE WINDOW BY RECONNECTING IN A LOOP. The docstring at core/websocket.py:88-97 argues the True default 'is the safe direction', but the only thing it protects is one about-to-be-permitted connection missing one message, while what it costs is delivery to a connection that is about to be refused. FIX: set websocket.state.aito_read = False (Starlette's state is writable before accept()) BEFORE the ws_manager.connect(websocket) call, and change the getattr default in broadcast_aito to False so an unstamped socket is never fanned out to. NOTE the trade-off the iteration-9 verifier established and that this fix inverts: the True default is also what guarantees no OTHER feature's broadcast is ever silently muted by an unstamped connection - verify that property still holds after flipping the default, since broadcast_aito is the only caller of the getattr but a future filtered fan-out might not be.

#### T-006 [P3] — aito_shipping._fold duplicates aito_quote_import._fold with a different Unicode normalization form
*Source: audit-cleanliness · Files: `backend/app/services/aito_shipping.py`*

backend/app/services/aito_shipping.py:94 · aito_shipping.py:94-97: `def _fold(value): stripped = unicodedata.normalize("NFKD", (value or "").strip().lower()); return "".join(c for c in stripped if not unicodedata.combining(c))`. aito_quote_import.py:73-76: `def _fold(value): decomposed = unicodedata.normalize("NFD", value); return "".join(c for c in decomposed if not unicodedata.combining(c)).lower()`. Both exist solely to do case+accent-insensitive French-label matching, and the shipping module's own docstring at line 96 says 'Same idea as the importer's own `_fold`' — the duplication is acknowledged in comments but never extracted. They differ in normalization form (NFKD vs NFD) and operation order (strip+lower before vs after decomposition), which is harmless for plain accented Latin text but is a real, silent behavioral difference that a future edit to one could accidentally diverge further on. Confirmed with `rg -n 'def _fold' backend/app/services/aito_shipping.py backend/app/services/aito_quote_import.py` -> two separate definitions. SUGGESTED FIX (from audit-cleanliness): Extract one shared `fold_label()` helper (e.g. in a small aito_text_utils module or on whichever of the two files is imported by the other) and have both call sites use it, picking one normalization form deliberately. ORCHESTRATOR NOTE: NFKD vs NFD is NOT a no-op in general (NFKD also applies compatibility folding, e.g. ligatures and full-width forms). Whichever form is chosen, the worker must show the chosen form produces identical results for every label either function is actually called with, or this becomes a behavior change.

#### T-008 [P3] — TaskStepList duplicates the step-row gutter-spacer markup between the impression-meta line and the description line
*Source: audit-cleanliness · Files: `frontend/src/components/aito/TaskStepList.tsx`*

frontend/src/components/aito/TaskStepList.tsx:167 · Lines 167-168: `{canTick && <span aria-hidden="true" className="w-4 flex-shrink-0" />}` then `<span aria-hidden="true" className="w-0.5 flex-shrink-0" />` inside the impression-meta block (162-182). Lines 195-196 repeat the identical two spacer elements inside the description block (183-199). The impression-meta block's own comment at 159-161 even says 'Shares the description's gutter exactly (see its comment below)', and the description block's comment at 188-194 explains the same trick in more detail — both comments point at each other instead of the code being factored into one place, so the two literal copies must be kept in sync by hand whenever the gutter widths (w-4/w-0.5/gap-3) change. SUGGESTED FIX (from audit-cleanliness): Extract a small local `<StepGutter canTick={canTick} />` (or a plain constant JSX fragment) used by both the impression-meta `<p>` and the description `<p>`, so the gutter geometry lives in one place.

#### T-010 [P3] — quote_number reaches the Content-Disposition filename unfiltered in get_quote_pdf
*Source: audit-security · Files: `backend/app/api/routes/aito.py`*

backend/app/api/routes/aito.py:1111 · routes/aito.py:1111-1122 `filename = f"{project.quote_number or project.quote_id}.pdf"` then `headers={"Content-Disposition": build_content_disposition(filename, disposition="inline")}`. quote_number is client-supplied on POST /aito/ with only `max_length=50` and no charset check (schemas/aito.py:223) — unlike quote_id right above it, which is pinned to `^[A-Za-z0-9_-]+$` precisely because it reaches a URL path. build_content_disposition (backend/app/utils/http.py) strips non-ASCII and removes the double-quote and backslash characters, but ASCII control characters survive in the legacy `filename="..."` parameter. Verified in this worktree: build_content_disposition with a value containing a CR LF escape returns `inline; filename="DEV<CR><LF>X-Injected: 1.pdf"; filename*=UTF-8''DEV%0D%0A...` and h11 refuses it with `LocalProtocolError: Illegal header value`, so on this stack the result is an aborted/500 response rather than response splitting — i.e. exactly the unhandled-500 failure mode the helper's docstring says it exists to prevent, plus a latent injection if the ASGI layer's validation ever changes. Same sink at line 1070/1078 for the invoice number (upstream-controlled). SUGGESTED FIX (from audit-security), behaviour-preserving: strip control characters when building the filename at both call sites, e.g. `filename = re.sub(r"[\u0000-\u001f\u007f]", "", f"{project.quote_number or project.quote_id}") + ".pdf"`; optionally also add a charset pattern to quote_number in AitoProjectCreate.

#### T-015 [P3] — the PDF blob object URL is never revoked when the component unmounts before the iframe settles
*Source: audit-robustness · Files: `frontend/src/components/aito/PdfPrintButton.tsx`*

frontend/src/components/aito/PdfPrintButton.tsx:77 · The unmount cleanup is `if (frameRef.current) { frameRef.current.remove(); frameRef.current = null; }` plus a clearTimeout — it holds no reference to the object URL, and `URL.revokeObjectURL` is only ever reached from `cleanup()` (line 87, scheduled by the onload/openInTab paths) or the catch block (line 146). Sequence: click Print, the fetch resolves and `url = URL.createObjectURL(blob)` runs (line 105), then the operator closes the detail panel before the hidden iframe fires onload and before the IFRAME_LOAD_TIMEOUT fallback — the effect cleanup clears the timer and removes the frame, both onload and the fallback are then short-circuited by `!mountedRef.current`, so nothing ever schedules `cleanup()`. The multi-megabyte PDF blob stays pinned for the lifetime of the tab; repeating this on a long shift (print, close, print, close) accumulates one leaked blob per attempt. SUGGESTED FIX (from audit-robustness): Track the live object URL in a ref alongside frameRef and revoke it in the unmount cleanup (and in the `!mountedRef.current` early return after the fetch). ORCHESTRATOR NOTE: this is a SIBLING of hand-filed T-002 (QuotePrintButton's 60s revoke timer), not a duplicate — different file, different mechanism. Whoever works both should keep the two fixes consistent.

#### T-034 [P3] — max_length=10_000 description cap is a repeated magic number (and repeated comment) instead of a named constant
*Source: audit-cleanliness · Files: `backend/app/schemas/aito.py`*

backend/app/schemas/aito.py:196 · The literal `10_000` is hardcoded as a bare `max_length=10_000` in ten separate `Field(...)` declarations in this file: AitoTaskCreate's four description fields (lines 201-204) - `scan_description: str | None = Field(default=None, max_length=10_000)` / `modelisation_description` / `impression_description` / `usinage_description`; AitoTaskUpdate's identical four (lines 214-217, same four field names and same `Field(default=None, max_length=10_000)`); AitoProjectCreate.description at line 231 - `description: str = Field(min_length=1, max_length=10_000)`; and AitoProjectUpdate.description at line 350 - `description: str | None = Field(default=None, min_length=1, max_length=10_000)`. The explanatory comment is also copy-pasted verbatim twice: lines 196-197 above AitoTaskCreate ('10_000 is generous headroom over anything a human types - it exists to keep a pathological payload from ballooning the row or the AI summarizer's prompt.') and again at lines 229-230 above AitoProjectCreate.description, word for word. Confirmed exhaustive with `rg -n '10_000' backend/app/schemas/aito.py` -> exactly these 10 lines. IMPORTANT - the per-model redeclaration itself is DELIBERATE and must NOT be touched: AitoTaskCreate and AitoTaskUpdate each define their own bounded Field precisely so that AitoTaskBase (and AitoTaskResponse, which inherits from it) stays unbounded on the read path - an earlier attempt in this same campaign (T-011) put the bound on AitoTaskBase and it made GET /aito/{id}/tasks 500 on a legacy over-cap row; that was caught by the blind verifier, fixed, and pinned. Re-consolidating the four fields onto a shared base Field would reintroduce that exact regression. The only thing to consolidate is the bare literal `10_000` and its duplicated comment, not the field declarations. FIX: add one module-level constant near the top of the file, e.g. `MAX_DESCRIPTION_LENGTH = 10_000` with the rationale comment, then replace each of the 10 `max_length=10_000` occurrences with `max_length=MAX_DESCRIPTION_LENGTH`, and delete the now-redundant duplicate comment at lines 229-230. KEEP the field-level 'why redeclared here and not on AitoTaskBase' comments at lines 196-200 and 212-213 exactly as they are - those explain the deliberate redeclaration and must stay. Every field keeps its current class, bound and inheritance; only the literal and the generic 'why 10k' rationale move to one place. NOTE: this file feeds the aito-pydantic-schemas golden - a named constant must produce a byte-identical declared JSON schema, so verify with tools/snapshot.py verify (9/9, no re-record).

#### T-035 [P3] — summarize_project's docstring says it exists 'for the create drawer' but a second caller was added since
*Source: audit-cleanliness · Files: `backend/app/api/routes/aito.py`*

backend/app/api/routes/aito.py:882 · Current docstring, routes/aito.py:882-884, on `async def summarize_project(...)`: '"""French project summary for the create drawer. Registered before the /{project_id} routes on purpose - a literal segment after a parametric route would 422 instead of matching."""'. This names only the create drawer as the reason the endpoint exists. But frontend/src/components/aito/ProjectDetailPanel.tsx:858-865 also calls this same endpoint, from `regenerateMutation`, and its own comment already says so: '// Regenerates the description from the live tasks through the same stateless /aito/summarize endpoint the creation drawer uses, then saves immediately through the manual-edit path...' followed by `mutationFn: () => api.summarizeAitoProject(tasks.map(taskDraftToTaskCreate)),`. `git log -p --follow -- backend/app/api/routes/aito.py | grep -n 'create drawer'` shows this backend docstring line was written once and never revised. A sibling comment was deliberately corrected for exactly this reason during this same campaign: BASELINE-CHANGELOG.md's T-011 entry was fixed by T-027/T-031 specifically to name both /aito/summarize call sites - but that fix only touched the changelog prose, not this route's own docstring, which still reads as if the create drawer is the only caller. FIX: reword the docstring to name both callers, following the same wording convention the campaign already used, e.g. 'French project summary, used by the create drawer and by ProjectDetailPanel's description-regenerate action. Registered before the /{project_id} routes on purpose - a literal segment after a parametric route would 422 instead of matching.' Comment-only change; no code touched. WARNING: this docstring is a ROUTED handler's docstring, which FastAPI publishes as the endpoint's OpenAPI description, so it WILL move the aito-openapi golden. That golden has no changelog entry authorising a move for this - report the move rather than re-recording it.

#### T-058 [P3] — Docstring line citations 'aito.py:744' and 'aito.py:1726-1730' no longer point at the commit/IntegrityError code they describe
*Source: audit-cleanliness · Files: `backend/tests/unit/test_aito_active_quote_index_migration.py`*

backend/tests/unit/test_aito_active_quote_index_migration.py:219 · Line 219: 'race each other into `uq_aito_project_active_quote` at commit (aito.py:744)' - but aito.py:744 is now inside list_projects' query-building comment about flag ordering ('Ranked WITHIN each column, and display-only...'), NOT the create-path commit/except IntegrityError block, which is now at aito.py:923-928. Line 245 in the same file: 'T-001, the restore side (aito.py:1726-1730 in the evidence trail)' - aito.py:1726-1730 is no longer restore_project's except IntegrityError block, which is now at aito.py:2160-2164 (restore_project itself starts at line 2111). Confirmed by reading both cited line ranges in the current file and comparing to what the docstrings describe. These two were flagged as known pre-existing decay in T-057's brief ('do not fix these... recorded in the final report as a known decay problem') and were deliberately left unfixed through loop 12, so they are still live in the tracked file at HEAD. FIX: update the citations to the current line numbers - 'aito.py:744' -> the except IntegrityError block in create_project (currently aito.py:923-928), and 'aito.py:1726-1730' -> restore_project's except IntegrityError block (currently aito.py:2160-2164). Comment-only change, no behavior impact. NOTE FOR WHOEVER WORKS THIS: line numbers in this repo have decayed repeatedly across the campaign; consider citing a FUNCTION NAME plus a distinctive code fragment instead of a line number, so the citation cannot go stale the next time a docstring above it changes length.

#### T-059 [P3] — Comment cites 'core/database.py:220' for get_db's rollback-on-exception, but get_db is now at line 224
*Source: audit-cleanliness · Files: `backend/app/api/routes/aito.py`*

backend/app/api/routes/aito.py:1567 · Line 1567: 'Marking pending ahead of a possible 422 is safe - get_db rolls back on ANY exception (core/database.py:220), so a rejected PATCH persists nothing, including this mark.' backend/app/core/database.py:224 is `async def get_db() -> AsyncSession:` - the citation is 4 lines short of its target. This is the third citation T-057's brief explicitly logged as pre-existing decay and left unfixed. FIX: update the citation to core/database.py:224, or better, cite `get_db` by name rather than by line so it cannot decay again.

#### T-060 [P3] — update_project's top-of-function version check has no pointer to the atomic re-check that follows it
*Source: audit-cleanliness · Files: `backend/app/api/routes/aito.py`*

backend/app/api/routes/aito.py:1838 · Line 1838: `if payload.expected_version is not None and payload.expected_version != (project.version or 0): raise HTTPException(...)` carries NO comment at all. The atomic re-check 35 lines later (line 1873, `_claim_expected_version`) DOES explain the relationship in its own comment: 'Re-assert the guard here, ATOMICALLY... the top-of-function compare above is a plain SELECT and only fast-fails the common case' (lines 1867-1872). So the two-guards-for-one-invariant design is documented ONLY at the second site - a reader who stops at the first raise (a plausible reading order, since it looks like a complete, self-contained guard) has no signal that it is merely an optimistic fast-path and that a real atomic guard follows. The risk is future-facing: someone tidying up 'duplicate' validation could delete either guard without realising the pair is deliberate. FIX: add a one-line comment above line 1838 noting it is a fast-path only and pointing forward to `_claim_expected_version` for the atomic re-check that actually closes the race, mirroring the pointer already present at the second site.


---

## Addendum — the final full-suite run, and a time-of-day test bug

The last full backend run at exit reported **3 failed, 10152 passed, 1 skipped**. All three were investigated; none is a regression from this campaign.

- `test_extract_video_last_frame.py` (2 tests) — the known environmental flake. Wants `/usr/bin/ffmpeg`; on this machine ffmpeg is at `/opt/homebrew/bin`. **Passes 7/7 in isolation.**
- `test_plug_energy_history.py::test_nothing_derivable_before_the_first_midnight` — **fails in isolation too, so it is not a flake.** It is a genuine pre-existing test bug, and it is time-of-day dependent:

  The test computes `now = datetime.now(timezone.utc)`, writes a snapshot 30 minutes in the past, and asserts nothing is derivable because there is "no baseline for the day". But `derive_today_yesterday` measures from **local** midnight, not UTC midnight — the module's own docstring says so explicitly (`plug_energy_history.py:15`, *"Local midnight, not UTC midnight. With TZ=Europe/Berlin a UTC day…"*). The exit run happened at 22:19 UTC, which is 00:19 Europe/Berlin — 19 minutes past local midnight. A snapshot 30 minutes earlier therefore lands *before* local midnight, where it is a perfectly valid baseline, so `today` is derivable and the assertion fails.

  **It fails in a roughly 30-minute window after local midnight, every night, and passes the rest of the day.** `git log refactor-base..HEAD` shows **zero** commits touching either the test or `plug_energy_history.py`, so this campaign neither caused nor could have caused it.

  Suggested fix, for whoever picks it up: inject a fixed `now_utc` (the function already accepts one — `plug_energy_history.py:70` is `now = now_utc or datetime.now(timezone.utc)`) instead of letting the test read the wall clock. That removes the time dependency from all seven tests in the file, not just this one.

This is the same class of defect as the line-number decay noted above: a test that is true most of the time and quietly false in a narrow window. Worth fixing before it wastes someone's night.
