# PLAN (schema v2)

## T-002
priority: P3
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 8
title: _response() and _response_from_rating() duplicate the same 10-field AitoClientRatingResponse mapping
files: backend/app/services/aito_client_rating.py
evidence: backend/app/services/aito_client_rating.py:242 · lines 242-255: `def _response(row: AitoClientRating, *, stale: bool) -> AitoClientRatingResponse: return AitoClientRatingResponse(tier=row.tier, reason=row.reason, settled_count=row.settled_count, on_time_count=row.on_time_count, overdue_count=row.overdue_count, past_due_count=row.past_due_count, worst_overdue_days=row.worst_overdue_days, worst_overdue_number=row.worst_overdue_number, is_company=row.is_company, computed_at=row.computed_at, stale=stale)` vs lines 258-271: `def _response_from_rating(rating: ClientRating, computed_at: datetime) -> AitoClientRatingResponse: return AitoClientRatingResponse(tier=rating.tier, reason=rating.reason, settled_count=rating.settled_count, on_time_count=rating.on_time_count, overdue_count=rating.overdue_count, past_due_count=rating.past_due_count, worst_overdue_days=rating.worst_overdue_days, worst_overdue_number=rating.worst_overdue_number, is_company=rating.is_company, computed_at=computed_at, stale=False)` — same 8 fields copied field-by-field from two differently-typed sources (the AitoClientRating ORM row and the ClientRating dataclass) that happen to share attribute names · fix: since AitoClientRating and ClientRating expose the same attribute names, write one private helper that takes any object with those attributes (a typing.Protocol or just duck-typed) plus stale/computed_at, and have both call sites use it — so a future new field only has to be added in one place instead of two that can silently drift apart
fingerprint: 5f857a0f9128d2e8
source: audit-cleanliness

## T-014
priority: P3
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 9
title: record_manual_payment()'s _recent duplicate-guard dict is never evicted
files: backend/app/services/aito_manual_payments.py
evidence: backend/app/services/aito_manual_payments.py:31 · `# (project_id, kind, document_id, amount, reference) -> time.monotonic() of the last success.` / `_recent: dict[tuple, float] = {}` — entries are written by `_recent[key] = time.monotonic()` on every attempt and removed only by `_recent.pop(key, None)` on the failure path; a SUCCESSFUL payment's key stays for the life of the process even though `DUPLICATE_WINDOW_SECONDS` is 60. Every distinct (project, document, amount, reference) tuple ever paid accumulates in a long-lived process, and nothing sweeps expired entries, so the dict only grows between restarts. · fix: Prune entries older than `DUPLICATE_WINDOW_SECONDS` on each call (the same `calls[:] = [t for t in calls if ...]` shape `_check_rate_limit` uses), or key the guard in a bounded structure such as an OrderedDict trimmed to a max size.
fingerprint: d9c5ef6710b9cc7e
source: audit-robustness

## T-015
priority: P3
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 9
title: _check_rate_limit()'s _ai_rate_limit_calls never drops stale principal keys
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1633 · `_ai_rate_limit_calls: dict[str, list[float]] = {}` and, in `_check_rate_limit`, `calls = _ai_rate_limit_calls.setdefault(key, [])` / `calls[:] = [t for t in calls if now - t < _AI_RATE_LIMIT_WINDOW_S]` — the per-key list is pruned only when that key is hit again, and the key itself is never deleted. On an auth-disabled install the key is `f"ip:{host}"` (`_ai_rate_limit_key`), so every distinct client IP that ever touches `/summarize`, `/proofread`, a counter-payment route or the link Retry leaves a permanent dict entry. The sibling tracking limiter in this same module already sweeps (`_TRACK_RATE_SWEEP_ABOVE`); this one does not. · fix: Drop keys whose pruned list is empty, and periodically sweep buckets older than the window — mirroring the `_TRACK_RATE_SWEEP_ABOVE` housekeeping already in this module.
fingerprint: 9dcf5608a1996445
source: audit-robustness

## T-016
priority: P3
status: WONTFIX-AUTO
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: _check_rate_limit's _ai_rate_limit_calls map never evicts stale principal keys
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1633 · _ai_rate_limit_calls: dict[str, list[float]] = {} ... calls = _ai_rate_limit_calls.setdefault(key, []); calls[:] = [t for t in calls if now - t < _AI_RATE_LIMIT_WINDOW_S] — the per-key list is trimmed but the key itself is never deleted, unlike the tracking limiter in the same file: 'for bucket in (_track_rate_ip_calls, ...): if len(bucket) > _TRACK_RATE_SWEEP_ABOVE:' (line 1309) · fix: sweep empty/expired entries out of _ai_rate_limit_calls the way _track_rate_limited already sweeps its four buckets (delete keys whose live() list is empty once the dict exceeds a threshold)
fingerprint: b4fd2a161c104ca5
source: audit-security
reason: duplicate of T-015 (same map, two auditors, c20)

## T-018
priority: P3
status: DONE
attempts: 1
round: 2
first_seen_iteration: 0
last_touched_iteration: 9
title: 409 version_conflict HTTPException body is copy-pasted 4x across update_project/edit_project_client
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:3295 · Identical 3-line block `raise HTTPException(status_code=409, detail={"code": "version_conflict", "message": "Project was updated by someone else"})` appears verbatim at lines 3293-3296 and 3334-3337 inside `update_project`, and again at 3455-3458 and 3534-3537 inside `edit_project_client` (grep -n 'version_conflict' backend/app/api/routes/aito.py -> exactly these 4 hits, all with the same literal dict). Each function repeats it once for the cheap pre-check and once for the atomic `_claim_expected_version` re-check. · fix: Factor a small `_version_conflict() -> HTTPException` helper (or reuse a shared `_refuse`-style builder like aito_payments.py's) and call it from all 4 sites so the code/message pair can't drift between the two guarded routes.
fingerprint: c39b9acc7b04c632
source: audit-cleanliness

## T-026
priority: P3
status: DONE
attempts: 2
round: 2
first_seen_iteration: 10
last_touched_iteration: 11
title: HeimdallService.patch_link / cancel_link / get_payment interpolate heimdall_id into the request path without escaping the segment
files: backend/app/services/heimdall.py
evidence: backend/app/services/heimdall.py:338 · `return _to_view(await self._request(db, "PATCH", f"/api/v1/payments/{heimdall_id}", json_body=payload))` (line 338), `f"/api/v1/payments/{heimdall_id}/cancel"` (341), `f"/api/v1/payments/{heimdall_id}"` (344). `heimdall_id` is stored verbatim from an unauthenticated upstream body — `_to_view` does `link_id = str(data["id"])` with no character validation — and httpx normalises dot segments when it builds the request, the exact hazard services/zoho.py:26 `_seg()` was added to close ("an id of ``../../../crm/v2/Leads`` escapes the ``/books/v3`` prefix entirely"). Not currently exploitable because `sign()` hashes the un-normalised path so a traversal would fail Heimdall's signature check, but that is an accident of the signing recipe, not a control. · fix: wrap the id in `urllib.parse.quote(value, safe="")` (or reuse the same one-line helper zoho.py's `_seg` provides) at all three call sites, and validate `data["id"]` in `_to_view` against an id character class the way `_validate_link_url` already validates the url field
fingerprint: 62cec00ac12729a4
source: audit-security
reason: user-approved behavior change

## T-032
priority: P3
status: DONE
attempts: 1
round: 2
first_seen_iteration: 0
last_touched_iteration: 10
title: _ai_rate_limit_key() falls back to request.client.host, collapsing every caller onto one bucket behind a reverse proxy
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1642 · `host = request.client.host if request.client else "unknown"` — the raw TCP peer, not the proxy-aware `_get_client_ip` that `_track_rate_limited` in this same module deliberately uses ("behind nginx the latter is the proxy for every visitor, and the per-IP cap would silently become a per-shop cap"). This branch is taken whenever `current_user is None`, i.e. on an auth-disabled install and for every API-key caller, so behind nginx all of them share one key: one 30-calls/minute AI budget and one 10-calls/minute counter-payment budget (`_COUNTER_PAYMENT_MAX_CALLS`) for the whole shop, and the eleventh Create-link/cancel click of the minute 429s a different operator than the one who spent the budget. · fix: use the same proxy-aware `_get_client_ip` helper the tracking limiter uses for the anonymous fallback.
fingerprint: 777bd1f3d09da8d6
source: audit-robustness
reason: user-approved behavior change

## T-035
priority: P3
status: DONE
attempts: 1
round: 3
first_seen_iteration: 0
last_touched_iteration: 10
title: isTerminalOpen() duplicates backend OPEN_STATUSES + booking_status predicate with no shared constant
files: frontend/src/components/aito/payment/useTerminalPayment.ts
evidence: frontend/src/components/aito/payment/useTerminalPayment.ts:12 · Frontend: `if (p.status === 'pending' || p.status === 'processing') return true; return p.status === 'paid' && p.booking_status === 'pending';` (useTerminalPayment.ts:12-16). Backend: `OPEN_STATUSES = frozenset({"pending", "processing"})` (aito_terminal_payments.py:32) reused at `row.status in OPEN_STATUSES or (row.status == "paid" and row.booking_status == "pending")` (aito_terminal_payments.py:407) and again as a SQL predicate at line 503-504. The backend itself already unified its two internal call sites behind OPEN_STATUSES; the frontend re-derives the same boolean from hardcoded string literals with no reference back to it. · fix: Add a one-line comment on isTerminalOpen pointing at OPEN_STATUSES/refresh_terminal_payment's predicate (the way aitoBoardRules.ts and aitoPayment.ts already do for their backend mirrors) so a new terminal-payment status added to one side is caught by a reviewer checking the other.
fingerprint: 2dceaf335396fda9
source: audit-cleanliness

## T-044
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: send_pickup_sms leaves the duplicate-SMS guard armed after an unexpected (non-Pushcut) exception
files: backend/app/api/routes/aito.py,backend/tests/unit/test_aito_pickup_sms.py
evidence: c20 verifier-13 lead: routes/aito.py send_pickup_sms arms _recent_sms[key] before send_sms_notification; only PushcutNotConfiguredError and clean upstream refusals pop it. Any other exception (a bug, DB error building the title, etc.) propagates as a 500 with the key still armed, so the operator's honest retry within 60 s gets a false 409 'Already sent'. Fix: un-arm in a generic except/finally for every exception that is not PushcutUnreachable, then re-raise. user-visible change: after an unexpected 500 on Send SMS, an immediate retry is attempted instead of being refused as 'Already sent' for 60 s.
fingerprint: 
source: survey
reason: user-approved behavior change

## T-045
priority: P3
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 11
title: create_contact_person docstring misstates patch_contact's permission gate
files: backend/app/api/routes/zoho.py,snapshots/aito-openapi.golden
evidence: c20 lead: zoho.py create_contact_person docstring says 'not patch_contact (aito:update)' — after c20 T-039 patch_contact is scoped to an active card; verify the actual gate of patch_contact and correct the sentence. The docstring is the published OpenAPI route description, so the aito-openapi golden line changes: sanctioned single-golden re-record + BASELINE-CHANGELOG entry. user-visible change: the OpenAPI description text of POST contact-persons changes (docs only, no runtime behavior).
fingerprint: 
source: survey
reason: user-approved behavior change

## T-046
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: A 429 on the retainer read blanks both deposit figures for the tick (retainer read runs before read_customer_credit)
files: backend/app/services/aito_quote_sync.py,backend/tests/unit/test_aito_quote_sync.py
evidence: c20 T-010 verifier note: in run_sync_once the per-tick _referenced_retainer_total / list_customer_retainers read runs BEFORE read_customer_credit, so a Books 429 on /retainerinvoices aborts the block and leaves BOTH retainer_paid_total and customer_credit_total unassigned that tick (pinned by a c20 test). Fix: isolate the retainer read so its failure keeps the previous retainer_paid_total while customer_credit_total is still refreshed. user-visible change: during a Books rate-limit on retainers, the card's customer-credit figure still refreshes that tick instead of both figures staying stale.
fingerprint: 
source: survey
reason: user-approved behavior change

## T-047
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: reconcile_project's own-discovered-404 double-failure path (replace_lost failing again) has no test
files: backend/app/services/aito_payment_links.py
evidence: backend/app/services/aito_payment_links.py:758 · coverage-aito21-backend.json: aito_payment_links.py missing lines include 755, 766, 769-774, 782 (confirmed via `pytest backend/tests/unit/test_aito_payment_links.py --cov=... --cov-report=term-missing` -> same lines, 91% with all 96 tests green). This is the `except HeimdallNotFound` block inside reconcile_project (create/patch hits a 404) that calls `_replace_lost` and then has its own try/except for HeimdallRateLimited/HeimdallUpstreamError/SQLAlchemyError. `grep -n 'HeimdallNotFound' backend/tests/unit/test_aito_payment_links.py` shows the exception is only ever raised from the fake's `get_payment` (the poll-discovery path, tested by test_the_lost_links_own_replacement_failing_is_recorded_not_silently_dropped and test_a_rate_limit_during_the_lost_links_replacement_stands_the_whole_pass_down), never from create_link/patch_link, so this second, structurally identical code path for the same failure mode is completely unexercised. · fix: in backend/tests/unit/test_aito_payment_links.py, add cases where the *reconcile* half's own create/patch call raises HeimdallNotFound (monkeypatch heimdall_service.create_link or patch_link to raise it directly instead of only faking get_payment), then have the replacement's own create_link fail once with HeimdallUpstreamError (assert _record_failure ran and the reservation/failure is visible, not silently dropped) and once with HeimdallRateLimited (assert it propagates instead of being swallowed) — mirroring the two poll-path tests already present.
fingerprint: f49cbe39aa8ce4c4
source: audit-tests

## T-048
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: poll_open_terminal_payments per-row failure isolation is untested
files: backend/app/services/aito_terminal_payments.py
evidence: backend/app/services/aito_terminal_payments.py:557 · coverage-aito21-backend.json: aito_terminal_payments.py missing lines include 557-559, the `except Exception as exc: # noqa: BLE001 — one row's failure must not end the pass` / logger.warning / db.rollback() block inside poll_open_terminal_payments's per-row loop. `grep -n 'def test_' backend/tests/unit/test_aito_terminal_payments.py` shows no test named or shaped like the sibling module's `test_one_failure_does_not_stop_the_pass` (aito_payment_links has this exact test; aito_terminal_payments does not), so nothing verifies that a raising refresh_terminal_payment on one row still lets the poll visit/settle subsequent rows. · fix: in backend/tests/unit/test_aito_terminal_payments.py, add a test with two+ open rows where refresh_terminal_payment raises for the first (e.g. monkeypatch heimdall_service.get_payment to raise for one heimdall_id) and assert the second row is still visited/updated and `visited` reflects both, plus that db.rollback() leaves the session usable for the next iteration.
fingerprint: 22bd38a8dde6f1e4
source: audit-tests

## T-049
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: poll_contacts has no poison-row cap (or test) unlike its sibling aito_invoice_poll.py's MAX_ADOPT_FAILURES
files: backend/app/services/aito_contact_poll.py
evidence: backend/app/services/aito_contact_poll.py:150 · aito_contact_poll.py's own docstring says 'This is the invoice poll's shape applied to contacts.' aito_invoice_poll.py explicitly caps consecutive per-row failures at MAX_ADOPT_FAILURES=3 (see its docstring lines 94-113 and test_a_poison_invoice_stops_holding_the_watermark_after_three_passes) specifically because an uncapped retry-holds-the-watermark scheme means a permanently-failing row grows the rescan window every tick forever. aito_contact_poll.py's poll_contacts (lines 141-158) has the identical 'hold the watermark at oldest_failure' retry mechanism but no analogous counter/cap, and `grep -n 'def test_' backend/tests/unit/test_aito_contact_poll.py` shows only test_a_row_that_fails_holds_the_watermark_so_it_is_retried (single failure, single pass) — no test exercises many consecutive passes against the same poison contact, so whether this module actually has (or needs) the same safeguard as its sibling is completely uncharacterized. · fix: in backend/tests/unit/test_aito_contact_poll.py, add a test modeled on aito_invoice_poll's test_a_poison_invoice_stops_holding_the_watermark_after_three_passes: fail the same contact_id across many consecutive poll_contacts() passes and assert on what actually happens to POLL_SINCE_SETTING and log volume, so the missing (or present) cap becomes a checked behavior instead of an assumption.
fingerprint: e32ff6b319a84181
source: audit-tests

## T-050
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: PdfDownloadButton's download() success/failure behavior is never exercised — only its disabled state is
files: frontend/src/components/aito/PdfDownloadButton.tsx
evidence: frontend/src/components/aito/PdfDownloadButton.tsx:68 · coverage-summary.json: PdfDownloadButton.tsx statements 39.28% (11/28), branches 61.53% (8/13). No dedicated test file exists (`find frontend/src/__tests__ -iname '*PdfDownloadButton*'` -> no matches). The only tests that render its callers assert disabled/enabled state alone: frontend/src/__tests__/components/AitoQuotePrintButton.test.tsx lines 315-327 (`describe('QuoteDownloadButton', ...)`) only checks `toBeDisabled()`/`toBeEnabled()`, and frontend/src/__tests__/components/AitoInvoiceCard.test.tsx lines 109-132 do the same for InvoiceDownloadButton — neither ever clicks the button, so `download()`'s fetchPdf-success path (blob -> createObjectURL -> anchor.click with safeFilename()) and its catch block (`showToast(failureMessage, 'error')`) are both unverified on the quote and invoice PDF export paths. · fix: add frontend/src/__tests__/components/PdfDownloadButton.test.tsx with two cases: (1) fetchPdf resolves a Blob -> assert URL.createObjectURL was called, an anchor with the expected `.pdf` filename (via safeFilename's sanitisation) was clicked, and busy toggles off after; (2) fetchPdf rejects -> assert showToast was called with the exact failureMessage and 'error', and busy still resets to false.
fingerprint: a2fa2c0e8a0af56d
source: audit-tests

## T-051
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: record_manual_payment() treats a Books transport timeout on record_customer_payment as a clean failure
files: backend/app/services/aito_manual_payments.py
evidence: backend/app/services/aito_manual_payments.py:218 · zoho.py _send maps every transport error to the plain base class: `except httpx.HTTPError as e: raise ZohoUpstreamError(f"Zoho Books unreachable: {e.__class__.__name__}") from e`. On the invoice path that lands in `except Exception: _recent.pop(key, None); raise`, so the duplicate guard is released and the route answers 502 upstream. But a ReadTimeout on `POST /customerpayments` can come after Books has already recorded the payment. The operator taps Record again and a second customer payment is written against the invoice. For a partial payment the balance cap does not stop this, because the re-resolved balance is still above the amount. On the quote path a timeout on the retainer payment becomes `except (ZohoNotConfiguredError, ZohoUpstreamError) as exc: ... raise ManualPaymentPartial(retainer_number, exc)`. The route then tells the operator 'its payment could not be recorded ... Record the payment on it in Books', so they book by hand a payment that may already exist there. · fix: Add a ZohoUnreachable subclass of ZohoUpstreamError, raised by _send for httpx transport errors. In record_manual_payment, keep the _recent key on ZohoUnreachable from record_customer_payment and raise a distinct outcome-unknown error. Map it in the route to a 502 that says to check Books before retrying. · user-visible change: After a Books timeout the operator sees 'the payment may already be in Books — check before retrying' instead of a plain upstream error, and an identical retry within 60 s is refused with 409.
fingerprint: 1f3f657dc59fe4ae
source: audit-robustness
reason: user-approved behavior change

## T-052
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: run_sync_loop() lets a non-429 invoice sweep/poll failure abort the Heimdall payment-link and terminal passes
files: backend/app/services/aito_quote_sync.py
evidence: backend/app/services/aito_quote_sync.py:2575 · `try: await sweep_invoices(db) ... await poll_invoices(db) except ZohoRateLimited as e:` catches only the 429. poll_invoices calls `rows = await zoho_service.list_invoices_modified_since(db, since)` with no handler, so a Books 5xx or unreachable error propagates to the tick's outer `except Exception: logger.exception("Aito quote sync tick failed")`. That skips poll_contacts, purge_tracking_views, reconcile_payment_links and poll_open_terminal_payments. The comment right below says 'Payment links: gated on Heimdall, not Books — a link can be polled with Books down', but for as long as Books is down, online payments are never detected, paid links never auto-accept the quote, and abandoned invoice reservations are never aged out. · fix: Give the sweep/poll block an `except Exception` branch that logs and rolls back, like the contact-poll block below it, so the Heimdall passes always run. · user-visible change: During a Zoho Books outage, paid payment links and terminal payments keep being picked up on the board instead of freezing until Books recovers.
fingerprint: 8d70f3e40182b6c9
source: audit-robustness
reason: user-approved behavior change

## T-053
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: edit_project_client() pins the version back to the claimed number and can move it backwards
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:3809 · `await db.flush()` then `if project.version != claimed_version: project.version = claimed_version`. The claim commits `version = expected + 1` before the Books round trip (up to three 10 s calls). An unguarded concurrent write in that window, such as update_project without expected_version, set_project_flag, or the contact poll renaming client_name, bumps the row to expected + 2. After `db.refresh(project)` and the listener's bump, this code writes expected + 1 back over it, so the version goes backwards. A draft read at expected + 1 before that concurrent write now passes `_claim_expected_version`'s `WHERE version = :expected` and silently overwrites the other edit. The writer who holds expected + 2 gets a false 409. · fix: Pin only when the refreshed version is still exactly claimed_version before the flush (nobody else wrote). Otherwise leave the listener's bump in place so the version stays monotonic. · user-visible change: When a client edit overlaps another write to the same card, the version ends above expected + 1 instead of exactly there, so the editing panel's next save may get a version conflict instead of silently overwriting the other edit.
fingerprint: 6d6f04b2aca378fe
source: audit-robustness
reason: user-approved behavior change

## T-054
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 4
title: poll_invoices() advances the watermark past invoices the capped newest-first listing never returned
files: backend/app/services/aito_invoice_poll.py
evidence: backend/app/services/aito_invoice_poll.py:378 · list_invoices_modified_since reads `"sort_column": "last_modified_time", "sort_order": "D"` for at most `_MAX_INVOICE_PAGES = 10` pages (~2000 rows) and stops without saying it truncated. poll_invoices then sets `watermark = min(x for x in (newest, oldest_failure) ...)` from the NEWEST row it saw. When the window holds more than 2000 changes, the older tail is never read and the watermark jumps past it. That happens after the poll was off for months (sync disabled or Zoho unconfigured while the stored watermark persists), or after a Books bulk update. Those invoices are never attributed, orphans are never re-linked, and cards are never locked. The zoho.py comment calls this cap the guard for 'a watermark that has somehow gone stale', which is exactly when it drops data. · fix: Page in ascending last_modified_time order and set the watermark from the newest row actually processed, so a truncated pass resumes where it stopped. Or detect `has_more_page` at the cap and log it without advancing past the oldest row read. · user-visible change: After a long pause, invoices the poll used to skip silently are adopted onto their cards over the following ticks, locking and flagging those cards as invoiced.
fingerprint: 0c49ad1ea2344fc6
source: audit-robustness
reason: user-approved behavior change

## T-055
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 4
title: poll_contacts() advances the watermark past contacts the capped newest-first listing never returned
files: backend/app/services/aito_contact_poll.py
evidence: backend/app/services/aito_contact_poll.py:159 · list_contacts_modified_since pages `"sort_order": "D"` for at most `_MAX_CONTACT_PAGES = 10` pages (~2000 contacts) with no truncation signal, and poll_contacts sets the watermark from `newest`: `watermark = min(x for x in (newest, oldest_failure) if x is not None)`. A Books bulk contact edit or import (over 2000 touched), or a long gap with the poll disabled, leaves the older renames unread forever. Those cards keep the old client_name, and the modal's live client search cannot find them by the name on the card. · fix: Page in ascending last_modified_time order and set the watermark from the last row processed, or stop advancing when the page cap is hit with has_more_page still true. · user-visible change: Cards whose contact was renamed in Books during a large batch now pick up the new name instead of keeping the stale one.
fingerprint: e3280965fb6b3eaf
source: audit-robustness
reason: user-approved behavior change

## T-056
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 4
title: reconcile_project() does not catch HeimdallNotConfigured, so a malformed token aborts every pass and 500s the Retry button
files: backend/app/services/aito_payment_links.py
evidence: backend/app/services/aito_payment_links.py:775 · `except (HeimdallUpstreamError, SQLAlchemyError) as exc:` does not include HeimdallNotConfigured, which is not a subclass. is_configured only checks that the base URL and token are non-empty, but every call runs `parse_credential(token)`, which raises `HeimdallNotConfigured("Heimdall token is not an hmd_live.<id>.<secret> credential")`. The settings schema does not validate the token's shape, so a token in the retired format passes is_configured. `_create` then commits a reservation, `_complete` raises, and the exception passes `_run_pass` (which only catches SQLAlchemyError and HeimdallRateLimited). The pass dies at the first project on every tick with a logged traceback. No row gets a sync_error, the poll half never runs, and refresh_payment_link (the panel's Retry) returns a 500. · fix: Add HeimdallNotConfigured to the handled tuple in reconcile_project and in _run_pass's replacement handlers, so it is stored with _record_failure like any other Heimdall failure. Or have is_configured also call parse_credential. · user-visible change: With a badly formatted Heimdall token, the panel shows the credential error on the payment link row and Retry answers 200 instead of 500.
fingerprint: dca82a435abe4885
source: audit-robustness
reason: user-approved behavior change

## T-057
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 5
title: _run_pass() keeps calling Heimdall after HeimdallUnreachable, holding _pass_lock and the sync loop for up to 40 x 10 s
files: backend/app/services/aito_payment_links.py
evidence: backend/app/services/aito_payment_links.py:850 · In poll_link, `except HeimdallUpstreamError as exc: _fail(row, exc, now); await db.commit(); return`, and the loop moves on to the next of up to MAX_POLLS_PER_TICK = 40 rows. Each call runs at `_TIMEOUT_SECONDS = 10.0`. A 429 stands the pass down with _arm_throttle, but a hung Heimdall (accepts the connection, never answers) costs 10 s per row: about 400 s in one pass, all under `async with _pass_lock`. The panel's Retry (refresh_payment_link) waits on that lock with no bound. Because run_sync_loop is one sequential coroutine, poll_open_terminal_payments (another up to 40 x 10 s) and the next Books quote push or wake drain are delayed by the same amount. · fix: After the first HeimdallUnreachable in a pass, stop issuing further Heimdall calls for that pass (arm a short stand-down like _arm_throttle), and do the same in poll_open_terminal_payments. · user-visible change: While Heimdall is unresponsive, the remaining links in a tick are left for the next tick instead of each being tried and stamped with its own sync error.
fingerprint: 0d7e80671efa5bf4
source: audit-robustness
reason: user-approved behavior change

## T-058
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 5
title: start_terminal_payment() treats a Heimdall/gateway 5xx as a clean refusal and frees the project for a second charge
files: backend/app/services/aito_terminal_payments.py
evidence: backend/app/services/aito_terminal_payments.py:260 · `except (HeimdallUpstreamError, HeimdallNotConfigured) as exc: row.status = "failed" ... row.settled_at = now`. HeimdallService._request raises the plain `HeimdallUpstreamError(message)` for any status >= 500, and also for a non-JSON error body such as a reverse proxy's HTML 502/504 page. On a POST that carries `confirm: true`, a 504 Gateway Timeout or a 500 after Heimdall already dialled the terminal says no more about what happened than a read timeout, which T-011 keeps open and replayable. Here the row is settled `failed` and never polled, so the operator's next start reserves a fresh idempotency key and the client's card can be charged twice. · fix: Treat 5xx and non-JSON answers on the terminal create like HeimdallUnreachable: leave the reservation pending and unminted with sync_error set, so the next start replays the same idempotency key. · user-visible change: After a Heimdall 5xx on a terminal charge the card shows the charge still pending (replayable) instead of failed, and a new charge for a different amount abandons it first.
fingerprint: 62b6ad058e7b463a
source: audit-robustness
reason: user-approved behavior change

## T-059
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 6
title: apply_terminal_state() commits the settle claim before its effects, so a failure afterwards loses the event and quote acceptance permanently
files: backend/app/services/aito_terminal_payments.py
evidence: backend/app/services/aito_terminal_payments.py:347 · The claim `update(...).values(settled_at=now)` is followed by `await db.commit()`, and only then `await record(... kind ...)`, `await db.commit()`, `accept_quote(...)` and `refresh_after_payment(...)`. If anything after the claim commit raises, for example SQLite 'database is locked' on the event commit or a failure in apply_quote_decision's commit or _apply_rules, the exception reaches the poll's `except Exception ... await db.rollback()` or 500s the operator's GET. On every later refresh `was_settled = row.settled_at is not None` is True and the function returns early, so the payment.terminal.paid event, the automatic quote acceptance and the payment notification are never produced for a real card payment. Only the quote sweep's paid-retainer rule, if Books booked a covering retainer, can still accept the quote. · fix: Record the event in the same transaction as the claim (claim and event commit together), and make the post-settle accept and refresh re-drivable, for example with a separate effects-done marker that a later poll retries while it is unset. · user-visible change: A card payment whose follow-up steps failed once gets its timeline entry, quote acceptance and notification on a later poll instead of never.
fingerprint: 8591d5595d3a3da8
source: audit-robustness
reason: user-approved behavior change

## T-060
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 6
title: _became_paid() commits the paid state before accept_quote, so a failure afterwards leaves a paid link that never accepts the quote
files: backend/app/services/aito_payment_links.py
evidence: backend/app/services/aito_payment_links.py:357 · `row.paid_at = now; await record(... "payment_link.paid" ...); await db.commit()` runs before `await accept_quote(db, project, source="payment_link", ...)`. If accept_quote raises, for example on apply_quote_decision's commit ('database is locked') or in _apply_rules, reconcile_project's `except (HeimdallUpstreamError, SQLAlchemyError)` stamps sync_error on the now-paid row via _record_failure. The poll selects only `AitoPaymentLink.status == "pending"`, so the paid row is never visited again and the online payment never accepts the quote or sends the payment notification. That is left to the quote sweep's paid-retainer rule, if it ever matches. · fix: Run the acceptance before committing paid_at, or keep a re-drivable marker (for example accept pending until accept_quote succeeds) that the pass retries for paid quote links. · user-visible change: A paid quote link whose automatic acceptance failed once is accepted on a later tick instead of staying paid while the card waits on the client.
fingerprint: bf10bed81a6df73b
source: audit-robustness
reason: user-approved behavior change

## T-061
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 6
title: create_project trusts the client-supplied quote snapshot (quote_number/quote_total/quote_status/quote_url), and the import wake mints a Heimdall payment link from it before Books is ever read
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1556 · quote_number=payload.quote_number, / quote_total=payload.quote_total, (create_project, aito.py:1556-1558) followed by `request_immediate_sync()` (aito.py:1636), whose drain runs `reconcile_payment_links(db, changes_only=True)` (aito_quote_sync.py:2676) after a `run_sync_once(db, pending_only=True)` that skips imports because they are not pending; aito_payment_links.py:134/141 then builds the link straight from the row: `required = required_amount(project.quote_total, pct)` ... `return Wanted(reference=project.quote_number, amount=amount, expires_on=expires_on)`. quote_number is never checked against quote_id, and wanted_link ignores quote_sync_state, so a bogus quote_id (sweep 404s into 'error', total never refreshed) keeps the forged amount/reference indefinitely; with a real quote_id the forged total stands until the next full tick's sweep (aito_quote_sync.py:1640). A paid quote link runs `accept_quote(db, project, source="payment_link", ...)` (_became_paid), so an aito:create-only principal can get a quote accepted by paying a self-chosen amount — the acceptance _validate_create_payload explicitly reserves for aito:update. quote_url (any https host) is stored the same way and rendered as the panel's Books link. · fix: When payload.quote_id is set, re-read the estimate in create_project (zoho_service.get_estimate, as preview_estimate already does) and take quote_number, quote_total, quote_status, quote_date, customer and quote_url from Books (books_app_url) instead of the body — or reject the create with 409/422 when they disagree; additionally make wanted_link return None unless the card's quote snapshot has been confirmed by a successful sync/sweep (e.g. quote_sync_state not 'error' and a confirmed-total flag). · user-visible change: Importing a quote will make one Zoho Books call at create time and either overwrite the quote number/total/status/URL the browser sent with Books' values or refuse the import when they disagree or Books is unreachable, and an imported card gets no payment link until its figures have been confirmed from Books.
fingerprint: 8c994e4be5d6083b
source: audit-security
reason: user-approved behavior change

## T-062
priority: P2
status: WONTFIX-AUTO
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: patch_contact's active-card scope (T-039) is satisfied by any card the caller can create with an arbitrary client_id
files: backend/app/api/routes/zoho.py
evidence: backend/app/api/routes/zoho.py:320 · select(AitoProject.id).where(AitoProject.client_id == contact_id, AitoProject.status == "active").limit(1) — the only gate besides aito:create; create_project (same aito:create permission) stores `client_id=payload.client_id` (aito.py:1546, AitoProjectCreate.client_id is any 1-50 char string, never checked against Books). POST /aito/ with client_id=<victim contact> followed by PATCH /zoho/contacts/<victim> rewrites that customer's primary email/phone in Books, redirecting every future quote/invoice email for that customer. · fix: Bind the scope to the caller's own fresh card: require an active card for contact_id whose created_by is the current principal and whose created_at is within a short window (the drawer calls this in the create mutation's onSuccess), require the patched email/phone to equal that card's client_email/client_phone snapshot, and record an event on the card naming the Books write. · user-visible change: PATCH /zoho/contacts/{id} will return 404/403 unless the caller created an active card for that contact moments ago carrying exactly the email/phone being written, so it can no longer be driven against an arbitrary contact by first creating a throwaway card.
fingerprint: 9e91eba3fc16515e
source: audit-security
reason: behavior change declined

## T-063
priority: P2
status: WONTFIX-AUTO
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 7
title: create_contact_person adds a person (email/mobile) to any Books contact under aito:create with no board scope
files: backend/app/api/routes/zoho.py
evidence: backend/app/api/routes/zoho.py:380 · return await zoho_service.create_contact_person(db, contact_id, first_name=payload.first_name, last_name=payload.last_name, email=payload.email, phone=payload.phone) — the only check is the walk-in default id, unlike its sibling patch_contact which now requires an active card for contact_id. services/zoho.py:946 sets `"is_primary_contact": not existing`, so on a contact with no persons the caller-chosen person becomes the primary (the contact-level email Books mirrors), and any added person with an email becomes one of the estimate/invoice `to_contacts` that send_quote_email/send_invoice_email accept as a valid recipient. · fix: Apply the same board scope as patch_contact (an active card for contact_id, ideally one the caller just created) before calling Books, and record an event on that card naming the person added. · user-visible change: POST /zoho/contacts/{id}/persons will return 404 for a Books contact that no active Aito card is working for, so the drawer's Add contact must be used from a card for that contact.
fingerprint: f1f9927899e20646
source: audit-security
reason: behavior change declined (would break the new-project drawer's Add contact before the card exists)

## T-064
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 7
title: send_quote_email and send_invoice_email have no rate limit or duplicate-send guard despite mailing the client from the company's Zoho account on every call
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:2784 · await zoho_service.email_estimate(db, project.quote_id, to_mail_ids=[recipient]) (send_quote_email) and `await zoho_service.email_invoice(db, invoice["id"], to_mail_ids=[recipient])` (aito.py:2482, send_invoice_email) — neither handler takes `request: Request` or calls `_check_rate_limit`, and neither has the `_recent_sms`-style duplicate window send_pickup_sms has (T-025/T-043). A loop or repeated taps by an aito:update principal sends unbounded real emails to the client and burns the org's Books daily API/email quota the sync worker also depends on. · fix: Add `request: Request` and a `_check_rate_limit(request, current_user, bucket="zoho_email", max_calls=..., detail=...)` call before the Books send in both routes, plus a short (project_id, document_id, recipient) duplicate window armed before the send, mirroring send_pickup_sms. · user-visible change: Sending the same quote or invoice email again within the duplicate window, or past the per-minute cap, will return 409/429 instead of emailing the client again.
fingerprint: 45d5ddabb154e0d5
source: audit-security
reason: user-approved behavior change

## T-065
priority: P3
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 11
title: websocket_endpoint stamps aito_read once at connect and aito_presence messages trigger an unthrottled full-map broadcast
files: backend/app/api/routes/websocket.py
evidence: backend/app/api/routes/websocket.py:148 · websocket.state.aito_read = aito_read — computed once from the user row at connect and never re-checked, so a user whose AITO_READ is revoked (or who is deleted/disabled) keeps receiving aito_changed actions/actors and aito_presence_state (operator usernames per project id) for the life of the socket; and each inbound `aito_presence` message runs `await ws_manager.set_aito_presence(...)` (line 219), which does `await self.broadcast_aito(self.aito_presence_state())` (core/websocket.py:65) to every Aito connection with no per-connection throttle or no-change short-circuit. · fix: Skip the broadcast when the connection's project id is unchanged and throttle presence updates per connection; periodically (or on user/permission change) re-resolve aito_read and close sockets whose principal no longer holds AITO_READ. · user-visible change: A user whose Aito access is removed stops receiving live board and presence updates on an already-open tab (instead of until reconnect), and repeated identical presence messages no longer re-broadcast the viewer map.
fingerprint: dc02332df1c58ba4
source: audit-security
reason: user-approved behavior change

## T-067
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 8
title: _now() = datetime.now(timezone.utc).replace(tzinfo=None) is copy-pasted in 4 modules
files: backend/app/services/aito_terminal_payments.py
evidence: backend/app/services/aito_terminal_payments.py:116 · Identical 2-line definitions: backend/app/services/aito_terminal_payments.py:116-117, backend/app/services/aito_invoice_sweep.py:72-73, backend/app/services/aito_payment_links.py:115-116, backend/app/api/routes/aito_payments.py:90-91 — all `def _now() -> datetime: return datetime.now(timezone.utc).replace(tzinfo=None)` verbatim. rg -n '^def _now' across backend/app -> exactly these 4 definitions, no shared import. · fix: Move this to a single shared helper (e.g. backend/app/services/aito_events.py or a small aito_time.py) and have all 4 modules import it, so the naive-UTC convention only has to be stated once.
fingerprint: 94d7752501772faa
source: audit-cleanliness

## T-068
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 8
title: Four Aito i18n keys (descriptionPlaceholder, deleteTitle, quoteNumberLabel, invoiceNumberLabel) are unreferenced
files: frontend/src/i18n/locales/en.ts
evidence: frontend/src/i18n/locales/en.ts:8 · rg -n "aito\.descriptionPlaceholder|aito\.deleteTitle|aito\.quoteNumberLabel|aito\.invoiceNumberLabel" frontend/src (excluding i18n/locales/*) -> no matches, static or templated. Cross-checked against every other dynamic-key pattern used elsewhere in the same aito namespace (t(`aito.rating.${tier}`), t(`aito.stats.${id}`), t(`aito.stats.brief.${kind}Heading`), t(`aito.payment.${booking}`), t(`aito.payment.mode${...}`)) to rule out template-string construction — none of those patterns produce these 4 names. The sibling key aito.productDescription (line 7) IS used as the field label in ImportQuoteDrawer.tsx:319 and ProjectDetailPanel.tsx:1337, but neither passes a placeholder prop, and aito.holdToDelete (line 15) is used by TaskRow.tsx/ProjectDetailPanel.tsx where aito.deleteTitle is not. quoteNumberLabel/invoiceNumberLabel (en.ts:510,562) have zero hits of any kind, static or dynamic. All 4 keys are duplicated verbatim across all 14 locale files (~56 dead lines total). check-i18n-parity.mjs only checks cross-locale parity, not usage, so it will not catch this. · fix: Delete descriptionPlaceholder, deleteTitle, quoteNumberLabel and invoiceNumberLabel from the aito block in every locale file under frontend/src/i18n/locales/.
fingerprint: 6d8fbb4a04250ae2
source: audit-cleanliness
reason: user-approved behavior change

## T-069
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 5
last_touched_iteration: 5
title: Restore poll_invoices' pre-T-054 within-pass processing order (newest first) while keeping the ascending Books read
files: backend/app/services/aito_invoice_poll.py,backend/tests/unit/test_aito_invoice_poll.py
evidence: User request 2026-09-26 after verifier-4's unlisted T-054 consequence: ascending sort_order flipped the per-pass processing order in poll_invoices/_adopt. When >=2 invoices match one not-yet-quote_invoiced card in the same pass, the FIRST processed gets _repair_link (Books write linking the orphan invoice to the estimate) + the invoice.detected event/number, and the LAST processed wins the cached invoice_status/invoice_balance/invoice_due_date. Pre-T-054 (descending read) the first processed was the NEWEST and the last the OLDEST. Fix: keep reading Books ascending (T-054's truncation fix), but process each pass's fetched rows newest-first as before (e.g. iterate the fetched page(s) in reverse / sorted descending by last_modified_time), so the multi-match outcome is byte-for-byte the pre-T-054 one; the watermark computation (min(newest, oldest_failure), truncated 1 s rewind, clamp at since) must be unaffected. Add a test with two invoices matching one card in one pass pinning which one is linked/announced and which figures are cached (pre-T-054 semantics). Changelog: addendum to T-054 stating the order is restored.
fingerprint: 
source: survey

## T-070
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 7
last_touched_iteration: 7
title: create_project: run the duplicate-card check before T-061's Books re-read so a duplicate import still gets 409 during a Books outage
files: backend/app/api/routes/aito.py,backend/tests/unit/test_aito_import_books_snapshot.py
evidence: User request 2026-09-27 after verifier-6's unlisted T-061 consequence: _with_books_quote_snapshot runs BEFORE _validate_create_payload, so a duplicate import (quote already has an active card) while Books is unreachable / Zoho unconfigured gets 502/503 instead of the pre-T-061 409 'already has a card'. Fix: perform the duplicate / already-has-a-card check (whatever part of _validate_create_payload does not depend on the Books-owned fields) before the Books read, keeping every Books-dependent check (status-based aito:update requirement etc.) after it. Pin with a test: duplicate import + Books unreachable -> 409, zero Books calls. Also in the SAME commit append to BASELINE-CHANGELOG.md: (a) T-070 entry, and (b) 'Addendum to T-059 (user decision 2026-09-27, documented not fixed): _redrive_settle_effects runs inside poll_open_terminal_payments after its heimdall_service.is_configured early return, so owed settle effects wait while the Heimdall token is empty (no terminal charge can exist without a token).'
fingerprint: 
source: survey

## T-071
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 11
last_touched_iteration: 12
title: _resolve_principal_and_aito_read ignores users.is_active, so a disabled user keeps Aito broadcasts at connect and through the 60 s re-check
files: backend/app/api/routes/websocket.py
evidence: backend/app/api/routes/websocket.py:64 · aito_read = principal_user is not None and principal_user.has_permission(Permission.AITO_READ) — _resolve_principal_and_aito_read looks the user up by username and never checks is_active; both the connect path and the T-065 60 s re-check call it. verify_websocket_token (core/auth.py) does not check the user either and the ws token is reusable for 60 minutes, so a disabled user can also reconnect with Aito read. Every other auth path in core/auth.py rejects `not user.is_active`. · fix: require principal_user.is_active in _resolve_principal_and_aito_read (aito_read = principal_user is not None and principal_user.is_active and principal_user.has_permission(Permission.AITO_READ)) so both the connect-time stamp and _recheck_aito_read fail closed for a deactivated account · user-visible change: a user whose account is deactivated stops receiving aito_changed/aito_presence_state and drops out of the viewer presence map within about 60 s on an open socket, and a reconnect with their still-unexpired ws token no longer gets Aito updates
fingerprint: 5dd35bf893302528
source: audit-security
reason: user-approved behavior change

## T-073
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 11
last_touched_iteration: 13
title: Three separate in-memory duplicate-send guards (_recent_sms, _recent_emails, _recent) reimplement the same arm/keep/un-arm/prune idiom
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:4330 · backend/app/api/routes/aito.py:4330-4364 defines `_recent_sms: dict[tuple[int,str], float]` + `_sms_guard_key_or_409()` (prune-stale loop, key lookup, 409 raise); backend/app/api/routes/aito.py:2527-2550 defines a second dict `_recent_emails` + `_email_guard_key_or_409()` with the identical shape (prune loop, key lookup, 409 raise); backend/app/services/aito_manual_payments.py:34 and :100-152 defines a third, `_recent: dict[tuple, float]` + `_guard_key()`, with the same prune-loop/arm-before-call/un-arm-on-clean-failure/keep-on-ambiguous-failure lifecycle. The code itself documents the duplication rather than resolving it: aito_manual_payments.py:134 says '# Same shape as _recent_sms's sweep in routes/aito.py' and aito.py:4352 says the guard 'Reads the clock through the module's own `time` name for the same reason _check_rate_limit does' referencing the sibling. `rg -n '_recent_sms\[|_recent_emails\[|^_recent\['` confirms each dict/key-builder pair is only ever touched by its own call site. · fix: Extract a small reusable `DuplicateSendGuard` (dict[tuple, float] + window seconds) with `key_or_409(*key_parts)`/`arm(key)`/`release(key)` methods and have all three call sites (pickup SMS, quote/invoice email, manual payment) construct one instance instead of hand-rolling the prune loop three times. Keep the existing test hooks (`_reset_recent_sms`, `_reset_recent_emails`) as thin wrappers so test imports keep working.
fingerprint: e50a238ea97d4c8d
source: audit-cleanliness

## T-074
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 11
last_touched_iteration: 13
title: aito_invoice_poll.py and aito_contact_poll.py duplicate the watermark/rewind computation and the Books-timestamp helpers verbatim
files: backend/app/services/aito_invoice_poll.py
evidence: backend/app/services/aito_invoice_poll.py:397 · Both modules define byte-for-byte identical `_format_books_time`/`_parse_books_time` helpers (aito_invoice_poll.py:140-148 vs aito_contact_poll.py:66-73), an identical `_since()` shape (aito_invoice_poll.py:157-166 vs aito_contact_poll.py:77-83), identical constants `BACKFILL_DAYS=90`, `OVERLAP_SECONDS=300`, `TRUNCATED_OVERLAP_SECONDS=1`, and the same watermark-resolution block: `watermark = min(x for x in (newest, oldest_failure) if x is not None)...`; `rewind = TRUNCATED_OVERLAP_SECONDS if getattr(rows, "truncated", False) else OVERLAP_SECONDS`; `resume = watermark - timedelta(seconds=rewind)`; clamp against `_parse_books_time(since)`; persist via `set_setting(db, POLL_SINCE_SETTING, _format_books_time(resume))` (aito_invoice_poll.py:397-412 vs aito_contact_poll.py:167-180). The same shape is duplicated in zoho.py `list_contacts_modified_since` / `list_invoices_modified_since` (ModifiedSinceRows, sort_order A, identical for...else truncated). · fix: Factor the Books-timestamp format/parse pair and the watermark-resolution block (newest/oldest_failure -> rewind -> clamp -> persist) into one shared helper (e.g. a small `aito_poll_watermark.py`) that both `aito_invoice_poll.py` and `aito_contact_poll.py` call with their own setting name/constants; the `ModifiedSinceRows` pagination loop in zoho.py is already itself duplicated between the two list methods and could take the same treatment.
fingerprint: 018722bc56964e34
source: audit-cleanliness

## T-075
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 11
last_touched_iteration: 13
title: utc_now_naive() helper (added this campaign) is adopted by only 4 of ~10 Aito call sites — the rest still inline datetime.now(timezone.utc).replace(tzinfo=None)
files: backend/app/services/aito_quote_status.py
evidence: backend/app/services/aito_quote_status.py:60 · loop-8 added `utc_now_naive()` to aito_events.py and rewired aito_invoice_sweep.py, aito_payment_links.py, aito_terminal_payments.py and routes/aito_payments.py. `rg -n 'datetime.now(timezone.utc).replace(tzinfo=None)' backend/app/services backend/app/api/routes/aito.py` still finds the identical expression inline at: aito_client_rating.py:362, aito_quote_status.py:60 and :67, aito_invoice_poll.py:264, aito_quote_sync.py:1116, aito_stats.py:646, aito_tracking.py:352, and routes/aito.py:1407, :1638, :4143. · fix: Replace the remaining inline `datetime.now(timezone.utc).replace(tzinfo=None)` occurrences in the listed Aito files with `utc_now_naive()` (keeping any module-level name tests freeze). Pure substitution — same value, same behavior.
fingerprint: 5aff2c8c8eabaea9
source: audit-cleanliness

## T-077
priority: P1
status: DONE
attempts: 1
round: 2
first_seen_iteration: 11
last_touched_iteration: 12
title: start_terminal_payment() marks a 2xx answer with an unexpected body as failed although Heimdall accepted the charge
files: backend/app/services/aito_terminal_payments.py
evidence: backend/app/services/aito_terminal_payments.py:264 · heimdall.py _to_view: `except (KeyError, TypeError, ValueError) as e: raise HeimdallUpstreamError(f"Heimdall returned an unexpected payment shape: {e}") from e`; _request: `payload = response.json() if response.content else {}` and `raise HeimdallUpstreamError("Heimdall returned a non-object JSON body")`; then in start_terminal_payment: `except (HeimdallUpstreamError, HeimdallNotConfigured) as exc: row.status = "failed" ... row.settled_at = now`. A 202 with an empty body (proxy stripping it), a list body, or a payload missing `id`/`amount` after a Heimdall schema change all reach this branch AFTER Heimdall has accepted `confirm: true` and dialled the terminal. The row is stamped failed and settled with no heimdall_id, so no poll ever adopts the payment; the project is unblocked and the operator sees an upstream error, charges again, and the first card payment never gets its event or quote acceptance. · fix: Raise HeimdallAmbiguous (not plain HeimdallUpstreamError) from _to_view's parse failure and from the non-object-body check on a 2xx, so start_terminal_payment's existing (HeimdallUnreachable, HeimdallAmbiguous) branch keeps the reservation pending and replayable. · user-visible change: A charge whose 2xx answer cannot be parsed stays a pending, replayable reservation carrying a sync_error instead of showing as failed and freeing the counter for a new charge.
fingerprint: 0a71396e14187442
source: audit-robustness
reason: user-approved behavior change

## T-078
priority: P1
status: DONE
attempts: 1
round: 2
first_seen_iteration: 11
last_touched_iteration: 12
title: record_manual_payment() treats a Books 5xx or non-JSON answer on record_customer_payment as a clean failure
files: backend/app/services/aito_manual_payments.py
evidence: backend/app/services/aito_manual_payments.py:172 · `except ZohoUnreachable as exc:` is the only outcome-unknown branch around both record_customer_payment calls, but zoho.py maps gateway failures to plain ZohoUpstreamError: `raise ZohoUpstreamError(f"Zoho returned a non-JSON response (HTTP {response.status_code})")` and `if response.status_code >= 400: raise ZohoUpstreamError(f"Zoho Books error (HTTP {response.status_code})")`. A Books edge 502/504 (HTML page) returned after the backend committed the payment: on the invoice path it falls to `except Exception: _recent.pop(key, None)`, the route answers 502 `upstream`, and the operator's immediate retry is not refused, so the payment is booked twice in Books. On the quote path it becomes ManualPaymentPartial, whose message tells the operator to 'Record the payment on it in Books', a payment Books may already hold. · fix: Add a ZohoAmbiguous(ZohoUpstreamError) raised by _request/_raise_for_status for status >= 500 and for non-JSON bodies, and catch it together with ZohoUnreachable at both record_customer_payment call sites (ManualPaymentOutcomeUnknown). · user-visible change: A Books 5xx or HTML error on a manual payment answers 502 `manual_outcome_unknown` ('check before retrying'), and an identical retry within 60 s gets 409 instead of being sent to Books again.
fingerprint: 66d2cb850105317d
source: audit-robustness
reason: user-approved behavior change

## T-079
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 11
last_touched_iteration: 14
title: record_manual_payment() releases the duplicate guard when create_retainer_invoice times out
files: backend/app/services/aito_manual_payments.py
evidence: backend/app/services/aito_manual_payments.py:176 · `retainer = await zoho_service.create_retainer_invoice(...)` has no ZohoUnreachable handling, so a read timeout that lands after Books created the retainer falls to `except Exception: _recent.pop(key, None); raise`. The route answers 502 `upstream`, the guard is gone, and the operator's retry raises a second retainer invoice for the same quote deposit, leaving an orphaned unpaid retainer in Books that nothing in Aito ever mentions. · fix: Catch ZohoUnreachable (and the ambiguous 5xx class) around create_retainer_invoice, keep the guard key, and raise ManualPaymentOutcomeUnknown(None, exc) with a message saying a retainer may already exist. · user-visible change: A timed-out retainer creation answers `manual_outcome_unknown` and refuses an identical retry for 60 s instead of letting it create a second retainer.
fingerprint: 0709865cdebec555
source: audit-robustness
reason: user-approved behavior change

## T-080
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 11
last_touched_iteration: 14
title: poll_contacts() has no poison-row cap, so one permanently failing contact pins the watermark forever
files: backend/app/services/aito_contact_poll.py
evidence: backend/app/services/aito_contact_poll.py:156 · `except (SQLAlchemyError, ValueError, TypeError, KeyError) as exc: logger.warning("Contact poll skipped contact %s: %s", contact_id, exc) ... if moment and (oldest_failure is None or moment < oldest_failure): oldest_failure = moment` followed by `watermark = min(x for x in (newest, oldest_failure) ...)`. Unlike aito_invoice_poll (MAX_ADOPT_FAILURES = 3, logs ERROR once), a contact whose rename always fails holds the watermark at its timestamp on every pass. Each tick re-reads everything modified since then (a growing Books listing plus a WARNING every pass). Once that window passes _MAX_CONTACT_PAGES the pass re-reads the same capped page forever and every rename made in Books after it never reaches any card. · fix: Track per-contact failure counts (same shape as the invoice poll's failure store) and stop holding the watermark after MAX_ADOPT_FAILURES passes, logging ERROR once when it gives up. · user-visible change: A contact whose card rename fails on 3 passes is skipped (cards keep the old name, one ERROR logged) instead of freezing contact-rename detection for every client.
fingerprint: ceb63d6dae704ad8
source: audit-robustness
reason: user-approved behavior change

## T-082
priority: P3
status: DONE
attempts: 1
round: 2
first_seen_iteration: 11
last_touched_iteration: 14
title: _redrive_settle_effects() retries a permanently failing settle every tick with no cap and no visible error
files: backend/app/services/aito_terminal_payments.py
evidence: backend/app/services/aito_terminal_payments.py:426 · `except Exception as exc: ... logger.warning("terminal payment sweep: re-driving the settle effects of row %s failed: %s", rid, exc); await db.rollback()`. The rollback restores the original effects_pending_at, and rows are taken ordered by effects_pending_at, id with a limit. A settle whose event or acceptance fails deterministically is re-driven every tick forever, never sets sync_error, so the operator never learns the quote was not accepted, and 40 such rows would permanently crowd out newer re-drives. · fix: Count re-drive attempts on the row (or store the error in sync_error) and stop re-driving after a small cap, logging ERROR once. · user-visible change: A terminal payment whose settle effects keep failing shows a sync_error on the panel and stops being retried after the cap.
fingerprint: 7bd1cd81d6a33ab9
source: audit-robustness
reason: user-approved behavior change

## T-083
priority: P3
status: DONE
attempts: 1
round: 2
first_seen_iteration: 11
last_touched_iteration: 15
title: _run_pass() lets a non-SQLAlchemy failure in _became_paid abort the poll half on every tick
files: backend/app/services/aito_payment_links.py
evidence: backend/app/services/aito_payment_links.py:1055 · The poll loop catches only `except HeimdallNotFound` and `except SQLAlchemyError as exc:`, while _became_paid now does `except Exception: await db.rollback(); raise` (T-060). Any other exception from accept_quote before its commit rolls the link back to pending with its old checked_at, so it stays first in the checked_at nulls_first ordering. It is re-polled first on every tick and raises out of reconcile_payment_links each time, so no other pending link is polled again and paid links elsewhere are never credited. Before T-060 the paid state committed first, so this could happen only once. · fix: Catch Exception per row in the poll loop (as poll_open_terminal_payments does), roll back, and store the failure on the row via _fail so it backs off and surfaces a sync_error. · user-visible change: A paid link whose acceptance keeps failing shows a sync_error and backs off instead of silently blocking the polling of every other pending link.
fingerprint: e76dddf139b3a80d
source: audit-robustness
reason: user-approved behavior change

## T-084
priority: P2
status: BLOCKED
attempts: 0
round: 3
first_seen_iteration: 15
last_touched_iteration: 15
title: _recheck_aito_read only runs on inbound messages, so a silent socket keeps Aito broadcasts after revocation
files: backend/app/api/routes/websocket.py
evidence: backend/app/api/routes/websocket.py:234 · `data = await websocket.receive_json()` then `await _recheck_aito_read(websocket)` (websocket.py:233-234) — the T-065 re-check is driven only by inbound traffic; no timer, no receive timeout. The fix assumes the app frontend pings every 30 s, but a client script can connect and never send anything: aito_read is never re-resolved on that socket, so a user whose Aito permission is removed, or who is deactivated or deleted, keeps receiving aito_changed and presence broadcasts until they disconnect. · fix: Drive the re-check independently of inbound traffic: either run a per-connection task (or one ConnectionManager sweep) that re-resolves aito_read every _AITO_READ_RECHECK_SECONDS, or wrap receive_json in asyncio.wait_for with a timeout of about 2x the ping period and re-check (or close) when it expires, so a connection that never sends is still re-evaluated. · user-visible change: A websocket client that never sends messages would, after a revoked Aito permission or a deactivated account, stop receiving aito_changed/aito_presence_state within about a minute (or be disconnected on an idle timeout) instead of receiving them until it disconnects.
fingerprint: 3d1aaf45f79e6fb9
source: audit-security
reason: needs user approval

