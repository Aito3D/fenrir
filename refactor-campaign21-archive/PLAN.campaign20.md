# PLAN (schema v2)

## T-001
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: TIERS and REASONS tuples are unreferenced
files: backend/app/services/aito_client_rating.py
evidence: backend/app/services/aito_client_rating.py:115 · backend/app/services/aito_client_rating.py:115-116: `TIERS = ("good", "medium", "bad", "new")` / `REASONS = ("overdue", "chronic", "new", "punctual", "mixed")` | rg -n '\bTIERS\b|\bREASONS\b' across the whole repo (backend + frontend, all extensions) -> only these two definition lines; not read by any test, route, schema or the frontend tier map (ClientRatingPill.tsx hardcodes its own TIER_COLOR keys instead of importing these), and not listed in SURFACE.md under aito_client_rating.py's exports · fix: delete both tuples (or, if they were meant to be the validation source for the tier/reason literal types, wire AitoClientRatingResponse's Pydantic literals and the frontend TIER_COLOR map to read from them instead of duplicating the literals by hand)
fingerprint: 55bce39869c9092e
source: audit-cleanliness

## T-003
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: _map_invoice_history docstring claims a last_modified_time fallback that rate_invoices() never implements
files: backend/app/services/zoho.py
evidence: backend/app/services/zoho.py:298 · backend/app/services/zoho.py:298-301 docstring: 'the rating needs the two dates that say WHEN an invoice was paid (`last_payment_date`, with `last_modified_time` as the fallback the probe of 2026-09-22 settled on)' — but backend/app/services/aito_client_rating.py's own comment at line 106-110 says the opposite: '`last_modified_time` is still mapped through by `_map_invoice_history` but otherwise unused here — kept as the documented alternative should Books ever stop listing `last_payment_date`.' rg -n 'last_modified_time' backend/app/services/aito_client_rating.py -> only that comment; rate_invoices()'s only read of a paid date is `paid_on = _parse_date(row.get(PAID_ON_FIELD))` where PAID_ON_FIELD is fixed to "last_payment_date" — no fallback branch exists, so a settled invoice with an empty last_payment_date silently gets `lateness = 0` (counted on-time) instead of falling back to last_modified_time; no test in backend/tests/unit/test_aito_client_rating.py covers a paid row with an empty last_payment_date · fix: either implement the documented fallback in rate_invoices() (use last_modified_time when last_payment_date is empty, per zoho.py's docstring) and add a test for it, or fix zoho.py's docstring to say the field is currently unused/reserved, matching aito_client_rating.py's own comment, so the two files stop disagreeing about whether missing-payment-date invoices are handled
fingerprint: ff7ce627492ecd38
source: audit-cleanliness

## T-004
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: refresh_terminal_payment() has no test for the HeimdallNotFound (404 lost-payment) path
files: backend/app/services/aito_terminal_payments.py
evidence: backend/app/services/aito_terminal_payments.py:369 · coverage-aito20-backend.json: aito_terminal_payments.py missing_lines includes 369-375, missing_branches includes [360,361] and [363,364]. Code: `except HeimdallNotFound as exc:\n row.status = "failed"\n row.sync_error = str(exc)[:500]\n row.checked_at = now\n row.settled_at = row.settled_at or now\n await db.commit()\n return row` (lines 369-375). `grep -n HeimdallNotFound backend/tests/unit/test_aito_terminal_payments.py` -> no matches at all. · fix: in backend/tests/unit/test_aito_terminal_payments.py, add a case where heimdall_service.get_payment raises HeimdallNotFound for an open row and assert the row is marked status='failed', sync_error set, settled_at stamped, and the call does not raise (mirrors the existing test_start_marks_the_row_failed_when_heimdall_is_not_configured pattern but for the poll/refresh 404 case, which is the only way an operator learns Heimdall lost track of a reservation).
fingerprint: 781e543df5f1b11b
source: audit-tests

## T-005
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: TerminalPaymentModal paid state never exercises booking_status 'failed' (Zoho booking failure after a real card charge)
files: frontend/src/components/aito/payment/TerminalPaymentModal.tsx
evidence: frontend/src/components/aito/payment/TerminalPaymentModal.tsx:136 · coverage-summary.json: TerminalPaymentModal.tsx branches 67.74%. Code (paid branch): `const booking = payment.booking_status === 'booked' ? 'terminalBookingDone' : payment.booking_status === 'failed' ? 'terminalBookingFailed' : 'terminalBookingPending'` with `<p className={payment.booking_status === 'failed' ? 'text-status-warning' : 'text-bambu-gray'}>`. `grep -n "booking_status" frontend/src/__tests__/components/AitoTerminalPaymentModal.test.tsx` -> only 'pending' (fixture default) and 'booked' (line 25) appear; no test ever sets booking_status: 'failed'. · fix: in frontend/src/__tests__/components/AitoTerminalPaymentModal.test.tsx, add a case where getAitoTerminalPayment resolves status 'paid' with booking_status: 'failed' and assert the terminalBookingFailed copy renders with the warning styling — this is the only UI signal that a card was charged but Zoho never recorded it, so a silent money-attribution gap must be visibly flagged.
fingerprint: 239ed8e23e9d84e5
source: audit-tests

## T-006
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: create_invoice route's SQLAlchemyError-after-a-real-Books-invoice path is untested
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:2078 · coverage-aito20-backend.json: aito.py missing_lines includes 2078,2082,2089,2090,2091,2092. Code: `try:\n project.quote_invoiced = True\n ...\n await record(db, project_pk, "invoice.created", ...)\n await db.commit()\nexcept SQLAlchemyError as e:\n logger.error("Aito invoice %s for project %s WAS RAISED in Books but recording the local invoice.created event failed: %s", ...)\n try:\n await db.rollback()\n except Exception: # noqa: BLE001 — a failed rollback must not 500 a real invoice\n pass`. `grep -n 'SQLAlchemyError\|WAS RAISED' backend/tests/unit/test_aito_invoice_create.py` -> no matches; none of the 24 tests in that file break `record()`/`commit()` after the Zoho invoice is created. · fix: in backend/tests/unit/test_aito_invoice_create.py, add a test that makes the local record()/commit() fail after zoho_service.create_invoice succeeds (mirror the genuine-flush-failure technique already used in test_aito_manual_payments.py's test_a_db_failure_after_the_books_write_keeps_the_guard_and_names_the_payment, e.g. a NOT-NULL-violating AitoEvent) and assert the route still returns 2xx with the real invoice data rather than 500, and that db_session stays usable afterward — this is the invoice-create analogue of a pattern already known to be a real money-attribution risk elsewhere in Aito.
fingerprint: b17434c37a385635
source: audit-tests

## T-007
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: HeimdallNotConfigured -> 502 not_configured mapping is untested on every counter-payment route
files: backend/app/api/routes/aito_payments.py
evidence: backend/app/api/routes/aito_payments.py:150 · coverage-aito20-backend.json: aito_payments.py missing_lines includes 151, 266, 295. Code repeats the same guard three times: start_terminal_payment_route `except HeimdallNotConfigured as e: raise _refuse(502, "not_configured", str(e)) from e` (150-151), create_invoice_payment_link (265-266), cancel_invoice_payment_link (294-295). `grep -rn not_configured backend/tests/unit/test_aito_terminal_payment_api.py backend/tests/unit/test_aito_invoice_link_api.py backend/tests/unit/test_aito_manual_payment_api.py` -> no matches. This is the exact bug class already documented as FINDING 2 in aito_terminal_payments.py ('HeimdallNotConfigured does not subclass HeimdallUpstreamError — a narrow except would leave the reservation pending forever') and covered at the service layer (test_start_marks_the_row_failed_when_heimdall_is_not_configured) but never at the route/HTTP-mapping layer. · fix: in backend/tests/unit/test_aito_terminal_payment_api.py add a case (alongside test_error_mapping) that empties heimdall_api_token and asserts POST /terminal-payment returns 502 with code 'not_configured'; add the equivalent for POST /payment-link and POST /payment-link/{id}/cancel in backend/tests/unit/test_aito_invoice_link_api.py.
fingerprint: 9a28be6ae022aaf0
source: audit-tests

## T-008
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: create_invoice_payment_link's InvoiceLinkExists backstop (concurrent-create race) is untested
files: backend/app/api/routes/aito_payments.py
evidence: backend/app/api/routes/aito_payments.py:263 · coverage-aito20-backend.json: aito_payments.py missing_lines includes 264. Code: `except InvoiceLinkExists as e:\n raise _refuse(409, "link_exists", str(e)) from e` at line 263-264, reached only when create_invoice_link's own guard fires (the route's own pre-check at line 247-249 is the one exercised by test_create_then_cancel's 409). `grep -n link_exists backend/tests/unit/test_aito_invoice_link_api.py` -> only the pre-check case (an already-open link read from the DB before calling the service) is tested; nothing drives the service-level InvoiceLinkExists raise itself (e.g. two concurrent creates racing past the route's own check). · fix: in backend/tests/unit/test_aito_invoice_link_api.py, add a test that bypasses the route's pre-check (e.g. seed a pending unminted reservation with heimdall_id=None so `existing.heimdall_id is not None` is False) and drive create_invoice_link into its own InvoiceLinkExists raise, asserting the route still answers 409 link_exists.
fingerprint: a8ca722d0625cf86
source: audit-tests

## T-009
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 4
title: read_client_rating() never exercises a SQLAlchemyError from get_default_contact (settings read failure)
files: backend/app/services/aito_client_rating.py
evidence: backend/app/services/aito_client_rating.py:308 · coverage-aito20-backend.json: aito_client_rating.py missing_lines includes 308,309,310. Code: `try:\n default_id, _name = await zoho_service.get_default_contact(db)\nexcept SQLAlchemyError as e:\n logger.warning(...)\n return _unavailable()`. test_cached_row_read_failure_returns_unavailable_without_raising (test_aito_client_rating.py:538) monkeypatches db_session.get to fail, which only reaches the LATER `await db.get(AitoClientRating, customer_id)` read at line 317 — get_default_contact reads via `get_setting` (db.execute, not db.get), so this monkeypatch never exercises the earlier except block; `grep -n 'get_default_contact' backend/tests/unit/test_aito_client_rating.py` shows it is only ever monkeypatched to SUCCEED (line 512), never to raise. · fix: in backend/tests/unit/test_aito_client_rating.py, add a test that makes zoho_service.get_default_contact (or the underlying get_setting call) raise a SQLAlchemyError and assert read_client_rating returns the 'unavailable' tier without raising, distinct from the existing cached-row-read-failure test.
fingerprint: 11961469a50a43c8
source: audit-tests

## T-010
priority: P0
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: _paid_retainer_total() is blind to counter deposits, so a quote's online payment link stays live after it is paid at the counter
files: backend/app/services/aito_quote_sync.py
evidence: backend/app/services/aito_quote_sync.py:2310 · `def _paid_retainer_total(estimate: dict) -> float:` / `for entry in estimate.get("retainerinvoices") or []:` — it counts ONLY retainers Books attached to the estimate, and it is the sole writer of `project.retainer_paid_total` (line 1642 `project.retainer_paid_total = paid`). But a counter deposit on a quote raises an UNATTACHED retainer: `aito_manual_payments.record_manual_payment` calls `zoho_service.create_retainer_invoice(db, customer_id=..., reference_number=document.number, ...)` and `create_retainer_invoice`'s payload (services/zoho.py:1185) carries no `estimate_id` at all, and aito_invoice_sweep.linked_credits already documents that Heimdall's own bookings behave the same way ("live DEV26-2684 / RET26-00295 ... empty retainerinvoices, reference 'DEV26-2684'"). Concretely: a client pays the 50 000 XPF deposit on DEV26-xxxx in cash at the counter; `retainer_paid_total` never moves, so (a) `aito_payment_links.wanted_link` still computes `outstanding_amount(required, retainer_paid_total)` = 50 000 and `needs_action` leaves the existing `pending` link alone, and `aito_tracking._payment` keeps serving that link's checkout URL to the public tracking page (`if row.status == "pending" and project.quote_status not in PAYABLE_QUOTE_STATUSES: return None` — `accepted` IS payable), so the client can pay the same deposit a second time online; (b) the panel's own `quoteDocument()` computes `due` from the same stale `retainer_paid_total`, so `cellsEnabled` keeps the Link/Terminal/Manual cells live under a line that already says "paid", inviting a third charge; (c) on the cash/cheque path nothing ever calls `accept_quote` (only `aito_terminal_payments.apply_terminal_state` does), and sync_project's Trigger B auto-accept is gated on the same blind `paid >= needed`, so a fully-paid deposit leaves the card sitting unaccepted in Devis. · fix: Make the deposit figure see reference-linked retainers: in sync_project's Trigger B, fold in the customer's retainers whose `reference_number` matches `project.quote_number` — the exact rule `aito_invoice_sweep._same_reference`/`linked_credits` already implements — instead of reading `estimate["retainerinvoices"]` alone; or have `zoho_service.create_retainer_invoice` pass the estimate id so at least the hand-taken deposits attach. · user-visible change: A quote whose deposit was taken at the counter will have its online payment link cancelled, show 0 due in the Encaissement block, drop the pay button from the public tracking page, and auto-accept — where today it keeps offering payment; `retainer_paid_total` is pinned in snapshots/payment-link-math.golden and SURFACE.md.
fingerprint: 751ff6e335756bfb
source: audit-robustness
reason: user-approved behavior change

## T-011
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: start_terminal_payment() marks the reservation failed on a transport timeout, discarding a charge that may have reached the terminal
files: backend/app/services/aito_terminal_payments.py
evidence: backend/app/services/aito_terminal_payments.py:237 · `except (HeimdallUpstreamError, HeimdallNotConfigured) as exc:` / `row.status = "failed"` / `row.settled_at = now`. `heimdall._request` funnels every transport fault into that same class — `except httpx.HTTPError as e: raise HeimdallUpstreamError(f"Heimdall unreachable: {e}")` — and the client is built with `_TIMEOUT_SECONDS = 10.0` while this POST carries `confirm: True`, i.e. Heimdall is dialling the card terminal. A read timeout on that POST is precisely the case where the charge DID start: the row is stamped `failed`/`settled_at` with `heimdall_id` still NULL, and from there it is unreachable to every reconciler — `refresh_terminal_payment` returns immediately on `if row.heimdall_id is None`, and `_age_out_abandoned_reservations` only selects `status == "pending"`. The operator sees the red 'Failed' screen and `TerminalPaymentModal`'s Retry button (`retry()` -> `setPaymentId(null)`) while the client's card was in fact debited; nothing ever records `payment.terminal.paid`, accepts the quote, or reconciles the Books booking. A retry also allocates a fresh `_next_key` (`f"aito-tpe:{project_id}:{count + 1}"`), so the second attempt is a brand-new charge at Heimdall rather than a replay of the first. · fix: Distinguish a transport failure from an explicit refusal: raise a dedicated `HeimdallUnreachable(HeimdallUpstreamError)` from `heimdall._request`'s `httpx.HTTPError` branch, and in this handler leave such a row `pending` with a null `heimdall_id` (recording the reason in `sync_error`) so the documented same-key replay path in `start_terminal_payment` can adopt whatever Heimdall actually did; keep the `failed` stamp for the 4xx/5xx and not-configured cases, where nothing was created. · user-visible change: After a Heimdall timeout the card will show the charge as still in progress (and block a new one until the operator replays or it ages out) instead of immediately showing 'Failed' with a Retry button.
fingerprint: 7a70172a95a015cc
source: audit-robustness
reason: user-approved behavior change

## T-012
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 4
title: update_project() raises AttributeError on an explicit null description
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:3361 · `if "description" in fields:` / `project.description = fields["description"].strip()` — `AitoProjectUpdate.description` is `str | None` and its `_description_not_blank` validator explicitly lets `None` through, while `model_dump(exclude_unset=True)` keeps an explicitly-sent null. Verified against this worktree: `PATCH /api/v1/aito/{id}` with body `{"description": null}` raises `AttributeError: 'NoneType' object has no attribute 'strip'` out of this line and the caller gets a 500 instead of a 4xx. Worse, it happens AFTER `_claim_expected_version` has already taken the row's write lock, so a guarded PATCH burns its version claim on an error the client is told nothing useful about. · fix: Reject a null description in the schema (make `description` non-nullable on `AitoProjectUpdate`, or 422 in `_description_not_blank` when the key is present and the value is None), or treat `None` as 'leave alone' before the `.strip()`. · user-visible change: An API caller sending `{"description": null}` gets a 422 with a message instead of a 500.
fingerprint: 9fa7134c6d6206e0
source: audit-robustness
reason: user-approved behavior change

## T-013
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 4
title: poll_invoices() pins its watermark forever on one permanently-failing invoice
files: backend/app/services/aito_invoice_poll.py
evidence: backend/app/services/aito_invoice_poll.py:299 · `watermark = min(x for x in (newest, oldest_failure) if x is not None) if (newest or oldest_failure) else None` — `oldest_failure` is set by the per-invoice `except (... ZohoUpstreamError, SQLAlchemyError, ValueError, TypeError, KeyError)` branch, and nothing bounds how many times the same row may fail. `_adopt` attempts `_repair_link` whenever `newly_invoiced = not project.quote_invoiced`, and since a failure writes nothing, `quote_invoiced` stays False, so an invoice Books permanently refuses to re-link (its estimate already invoiced, a stale/garbled row) fails on every single pass. The watermark is then frozen at that row's `last_modified_time - 300s` forever, so `list_invoices_modified_since(db, since)` is called every 300 s with a window that grows by five minutes each tick — after a month the poll is re-listing and re-adopting a month of the org's invoices every tick, and the failing card never gets its invoice adopted either. · fix: Bound the rewind: count consecutive failures per invoice id (or clamp `watermark` to at most `BACKFILL_DAYS` before now) so a poison row stops holding the window open, and log it once at ERROR rather than re-attempting it silently forever. · user-visible change: An invoice that keeps failing adoption will eventually stop being retried by the poll instead of being retried on every tick.
fingerprint: 08689b494195907d
source: audit-robustness
reason: user-approved behavior change

## T-017
priority: P3
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 5
title: cancel_invoice_payment_link is the only counter-payment route with no _check_counter_payment_rate_limit
files: backend/app/api/routes/aito_payments.py
evidence: backend/app/api/routes/aito_payments.py:273 · @router.post("/{project_id}/payment-link/{link_id}/cancel", response_model=AitoProjectResponse) async def cancel_invoice_payment_link( project_id: int, link_id: int, db: AsyncSession = Depends(get_db), current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE), ): project = await _get_active_project_or_404(db, project_id) — no request: Request and no rate-limit call, while start_terminal_payment_route, record_manual_payment_route and create_invoice_payment_link in the same module all call _check_counter_payment_rate_limit, and routes/aito.py:3855 throttles the equivalent Heimdall-touching refresh_payment_link · fix: add a `request: Request` parameter and call `_check_counter_payment_rate_limit(request, current_user)` before `_get_active_project_or_404`, matching the other three counter-payment routes · user-visible change: an operator (or script) issuing more than 10 cancel requests inside the 60-second window would start receiving a 429 with the structured {"code":"rate_limited"} body instead of a successful cancel.
fingerprint: 65e03aba4e75193f
source: audit-security
reason: user-approved behavior change

## T-019
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 7
title: EVENT_LABEL_KEY has no entries for project.contacted.set / project.contacted.cleared, unlike every sibling flag pair
files: frontend/src/components/aito/history/eventKinds.ts
evidence: frontend/src/components/aito/history/eventKinds.ts:6 · backend/app/services/aito_events.py:90-91 registers `"project.contacted.set": "story"` and `"project.contacted.cleared": "story"` alongside urgent/sav/pause/due, all documented as real story-depth events ("it is part of 'who told them, and when'"), and they are actually recorded in backend/app/api/routes/aito.py:3758 (`record(db, project.id, "project.contacted.set" if payload.contacted else "project.contacted.cleared", ...)`) and backend/app/services/aito_quote_sync.py:1351. But frontend/src/components/aito/history/eventKinds.ts's EVENT_LABEL_KEY (lines 6-63) maps every other story-depth pair (projectUrgentSet/Cleared, projectSavSet/Cleared, projectPauseSet/Cleared, projectDueSet/Cleared) but has no `project.contacted.set` / `project.contacted.cleared` entries, and frontend/src/i18n/locales/en.ts's `aito.history` block (lines 760-825) has no `projectContactedSet`/`projectContactedCleared` keys either (grep -n 'contacted' frontend/src/i18n/locales/en.ts -> only the unrelated markContacted/holdToMarkContacted/contacted/clearContacted/holdToClearContacted board-pill strings, none under history); fr.ts confirmed the same gap. · fix: Add `'project.contacted.set': 'aito.history.projectContactedSet'` and `'project.contacted.cleared': 'aito.history.projectContactedCleared'` to EVENT_LABEL_KEY, and add the matching keys to every locale file (mirroring the urgent/sav/pause/due pattern), so the Activity Rail shows a real label instead of falling back to the raw event-kind string for a routine, every-day operator action (the 'Mark client as contacted' pill). · user-visible change: Currently every contacted/uncontacted toggle renders as the literal string 'project.contacted.set' or 'project.contacted.cleared' in the Activity Rail (per eventKinds.ts's own documented fallback); adding the label mapping plus new i18n keys changes that rendered text and adds keys the i18n-parity/golden tests count.
fingerprint: 96abda81d81ba580
source: audit-cleanliness
reason: user-approved behavior change

## T-020
priority: P1
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 6
title: _run_pass poll loop: when replacing a Heimdall-lost QUOTE payment link itself fails, the double-failure fallback is untested
files: backend/app/services/aito_payment_links.py
evidence: backend/app/services/aito_payment_links.py:983 · backend/app/services/aito_payment_links.py 984-989 (uncovered per coverage-aito20-backend.json missing_lines, along with 990-992): `try:\n await _replace_lost(db, project_id, exc, now=now, pct=pct, validity_days=validity, today=today)\nexcept HeimdallRateLimited:\n raise\nexcept (HeimdallUpstreamError, SQLAlchemyError) as exc2:\n logger.warning("payment link replacement failed for project %s: %s", project_id, exc2)\n await db.rollback()\n await _record_failure(db, project_id, exc2, now)` and the sibling `except SQLAlchemyError as exc:` at 990-992 that wraps the whole per-row poll iteration. `rg -n "_replace_lost" backend/tests/unit/test_aito_payment_links.py` only shows successful-replacement tests (test_a_lost_link_found_by_the_poll_is_replaced_in_the_same_pass, test_a_link_lost_at_heimdall_is_replaced_in_the_same_pass) and the invoice-fails-in-place test — none makes the replacement's own Heimdall create call fail a second time, and none triggers an unrelated SQLAlchemyError mid-poll. · fix: in backend/tests/unit/test_aito_payment_links.py, add a case where a QUOTE link's poll gets a 404 (HeimdallNotFound) and the fake Heimdall's subsequent `create` for the replacement also raises (HeimdallUpstreamError or a simulated SQLAlchemyError), asserting `_record_failure` runs (row gets sync_error/backoff, not silently dropped) and the pass does not crash; add a second case where poll_link itself raises an unrelated SQLAlchemyError and assert the loop rolls back and continues to the next row rather than aborting the whole pass.
fingerprint: 498040b7a6e4f873
source: audit-tests

## T-021
priority: P1
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 6
title: Zoho contact write routes (create_contact, patch_contact, create_contact_person, list_contact_persons, get_contact) have no test proving their permission gate actually rejects an unauthorized caller
files: backend/app/api/routes/zoho.py
evidence: backend/app/api/routes/zoho.py:242 · backend/app/api/routes/zoho.py declares `_: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_CREATE)` on create_contact (line 246), list_contact_persons (311), create_contact_person (336), get_contact (~227, AITO_UPDATE), and patch_contact (290) — every one of these writes or reads client PII in Zoho Books. `grep -rln "status_code == 403" backend/tests/unit/test_zoho*.py` returns no files at all. By contrast, backend/tests/unit/test_aito_permissions.py explicitly built a real-JWT 403 sweep over every gated route in aito.py + aito_payments.py and its own docstring says the file exists because an earlier override-based technique 'proves nothing about whether an unauthorized caller is rejected by the gate that is actually declared' — that same real-dependency sweep was never extended to zoho.py's gated routes, so a broken or accidentally-removed permission dependency on any of them (e.g. a caller with only aito:read creating or editing a Books contact) would pass CI silently. · fix: in backend/tests/unit/test_aito_permissions.py (or a new backend/tests/unit/test_zoho_permissions.py reusing its aito_tokens fixture), add the zoho.py write/PII routes (POST /zoho/contacts, PATCH /zoho/contacts/{id}, GET /zoho/contacts/{id}, GET+POST /zoho/contacts/{id}/persons) to a parametrized 403 sweep against a real persisted user holding no aito permission and one holding only aito:read, same pattern as WRITE_ROUTES.
fingerprint: 99ba42d066c11ce7
source: audit-tests

## T-022
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 7
title: PaymentLinkModal's create/cancel/retry mutation onError paths (setError from a rejected API call) are never exercised by a test
files: frontend/src/components/aito/payment/PaymentLinkModal.tsx
evidence: frontend/src/components/aito/payment/PaymentLinkModal.tsx:65 · frontend/src/components/aito/payment/PaymentLinkModal.tsx: `onError: (e: unknown) => setError(e instanceof Error && e.message ? e.message : t('common.errorLoading'))` appears identically on the `create`, `cancel`, and `retry` mutations (lines ~65, ~73, ~83). Every `it(...)` in frontend/src/__tests__/components/AitoPaymentLinkModal.test.tsx that touches these mutations mocks the api call with `.mockResolvedValue(...)` only — `grep -n 'mockRejectedValue\|onError' frontend/src/__tests__/components/AitoPaymentLinkModal.test.tsx` returns no matches. Compare frontend/src/__tests__/components/AitoManualPaymentModal.test.tsx, whose sibling modal DOES have `it('shows the server message verbatim', ...) { vi.spyOn(api, 'recordAitoManualPayment').mockRejectedValue(new ApiError(...)) }` — the same pattern is simply missing here, so a regression that swallows or mis-renders a 409/422 from create/cancel/refresh-link would ship unnoticed. · fix: in frontend/src/__tests__/components/AitoPaymentLinkModal.test.tsx, add cases mocking api.createAitoInvoicePaymentLink, api.cancelAitoPaymentLink, and api.refreshAitoPaymentLink to reject with an ApiError, and assert the modal renders the server's message via role="alert" (create/cancel) or the retry block's error state, staying open rather than closing.
fingerprint: 1c40e3e059547c02
source: audit-tests

## T-023
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 8
title: useTerminalPayment's poll-failure resilience (retry:false, stale data keeps driving refetchInterval) has no test
files: frontend/src/components/aito/payment/useTerminalPayment.ts
evidence: frontend/src/components/aito/payment/useTerminalPayment.ts:20 · frontend/src/components/aito/payment/useTerminalPayment.ts: `retry: false` combined with `refetchInterval: (query) => (isTerminalOpen(query.state.data) ? TERMINAL_POLL_MS : false)` means a single failed GET must not stop the poll while the last-known status was still open, and TerminalPaymentModal.tsx never reads `poll.isError` or `poll.error` (`grep -n 'isError\|error\b' frontend/src/components/aito/payment/TerminalPaymentModal.tsx` shows only the unrelated `error` state for the start-payment form). Every test in frontend/src/__tests__/components/AitoTerminalPaymentModal.test.tsx mocks `api.getAitoTerminalPayment` with `.mockResolvedValue(...)` exclusively (`grep -n 'getAitoTerminalPayment\|mockRejectedValue' frontend/src/__tests__/components/AitoTerminalPaymentModal.test.tsx` shows no rejected-value case) — nothing proves a transient poll failure keeps the modal showing the waiting screen and resumes polling rather than freezing, throwing, or silently stopping. · fix: in frontend/src/__tests__/components/AitoTerminalPaymentModal.test.tsx, mock api.getAitoTerminalPayment to reject once (or via mockResolvedValueOnce/mockRejectedValueOnce sequencing) while status is 'pending', advance the fake timer past TERMINAL_POLL_MS, and assert the modal still shows the waiting UI and that the API is called again on the next tick (poll survives a transient error) rather than getting stuck.
fingerprint: e9f8307c9044291c
source: audit-tests

## T-024
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 8
title: read_client_rating accepts an arbitrary client_id, so GET /aito/clients/{client_id}/rating amplifies into unbounded Zoho Books calls and permanent cache rows
files: backend/app/services/aito_client_rating.py
evidence: backend/app/services/aito_client_rating.py:346 · backend/app/api/routes/aito.py:1116 `@router.get("/clients/{client_id}/rating", ...)` with `client_id: str` unvalidated and only `RequirePermissionIfAuthEnabled(Permission.AITO_READ)`; aito_client_rating.py:319 `if refresh and cached is not None and moment - cached.computed_at < REFRESH_MIN_AGE:` — the comment above it says "ignore it rather than let a `?refresh=1` loop amplify Books calls", but the guard is skipped entirely when `cached is None`; the miss path then runs `rows = await zoho_service.list_customer_invoices(db, customer_id)` and `contact = await zoho_service.get_contact(db, customer_id)` and finally `if cached is None: cached = AitoClientRating(customer_id=customer_id); db.add(cached)`. The model docstring states "rows are never deleted". An id longer than 50 chars short-circuits list_customer_invoices (`if not customer_id or len(customer_id) > 50: return []` in zoho.py:1253) but still spends the get_contact call and still persists a row, in a String(50) primary key SQLite does not enforce. · fix: reject a client_id that is not the client of some AitoProject (or not a resolvable Books contact) before spending an upstream call, and put the route behind the existing `_check_rate_limit` helper in routes/aito.py with its own bucket; extend the REFRESH_MIN_AGE short-circuit to cover cache misses (e.g. a negative-result row or an in-process negative cache) so an unknown id cannot be re-queried on every request
fingerprint: b392a63ec496a7d3
source: audit-security
reason: user-approved behavior change

## T-025
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 8
title: send_pickup_sms has no rate limit despite relaying a caller-supplied message to Pushcut on every call
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:3913 · `@router.post("/{project_id}/pickup-sms", response_model=AitoPickupSmsResponse)` / `async def send_pickup_sms(project_id: int, payload: AitoPickupSmsRequest, db: AsyncSession = Depends(get_db), current_user: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),)` — no `request: Request` parameter and no `_check_rate_limit` call, while the sibling draft route `generate_pickup_message` (line 3876) calls `_check_ai_rate_limit(request, current_user)` and every counter-payment route in aito_payments.py calls `_check_counter_payment_rate_limit`. The body reaching the external service is caller-controlled: `await send_sms_notification(db, phone=phone, text=payload.message, title=...)`. · fix: add `request: Request` and call `_check_rate_limit(request, current_user, bucket="pickup_sms", max_calls=..., detail=...)` before the `send_sms_notification` call, mirroring the counter-payment limiter
fingerprint: 051f34c42182547d
source: audit-security
reason: user-approved behavior change

## T-027
priority: P1
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 6
title: apply_terminal_state() guards the settle with a check-then-act on row.settled_at, so two concurrent pollers credit the same card payment twice
files: backend/app/services/aito_terminal_payments.py
evidence: backend/app/services/aito_terminal_payments.py:322 · `already_settled = row.settled_at is not None` is read, then `_adopt(row, view, now)` and `await db.commit()` follow before `if already_settled or row.status not in SETTLED_STATUSES: return` — a check-then-act across two awaits, on rows loaded into two different sessions. `refresh_terminal_payment` is reached both from the operator's 3 s poll (`GET /{project_id}/terminal-payment/{payment_id}`) and from `poll_open_terminal_payments`, which calls it with `force=True` and so bypasses the `REFRESH_MIN_SECONDS` throttle entirely. When two of them (two tabs on the same card, or the tick's sweep landing inside a poll's Heimdall round trip) fetch the same charge in the same ~200 ms window and both see `status='paid'` with `settled_at` still NULL, both fall through: two `payment.terminal.paid` rows in the timeline, two `accept_quote()` calls (each recording `quote.accepted`, each pushing `accepted` to Books), two `on_aito_payment_received` notifications for one card payment, and two `refresh_after_payment` → `sync_project` passes. The link rail has no such hole — every `poll_link` runs under `_pass_lock`. · fix: claim the settle atomically before doing any of the work: `UPDATE aito_terminal_payments SET settled_at=:now WHERE id=:id AND settled_at IS NULL` and only continue when `rowcount` is 1 — the same conditional-UPDATE pattern `aito_tracking.ensure_tracking_token` already uses — or serialise the settle behind a module lock the way `start_terminal_payment` does with `_start_lock`. · user-visible change: a card payment settled by two pollers at once would stop producing a second payment.terminal.paid / quote.accepted entry in the timeline and a second payment notification.
fingerprint: f36f29b030d8d201
source: audit-robustness
reason: user-approved behavior change

## T-028
priority: P1
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 7
title: create_invoice() lets a Books 429 from read_customer_credit escape after the invoice has already been raised
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:2050 · `credit = await read_customer_credit(db, plan.customer_id)` sits outside every try in the route, and `read_customer_credit` re-raises `ZohoRateLimited` by design (`except ZohoRateLimited: raise`, aito_customer_credit.py:84). Books answering 429 on that one extra `GET /customerpayments` — likely precisely because the request just spent three calls creating the invoice and applying retainers — propagates to a 500. By then `zoho_service.create_invoice` has returned a real invoice and `apply_retainers` has spent the customer's deposits on it, yet everything below this line is skipped: `project.quote_invoiced = True` is never committed, no `invoice.created` event is written, and the operator sees a 500 that reads as "the invoice was not raised" — the exact outcome the route's own docstring says must never happen ("a 500 after that point would invite a retry that raises a SECOND one"). · fix: wrap the credit read in `try/except (ZohoNotConfiguredError, ZohoUpstreamError)` and fall back to `credit = None`, matching the best-effort contract every other post-create step in this route already follows. · user-visible change: an invoice creation that currently answers 500 when Books is rate-limited would answer 200 with the pre-existing (stale) "deposit available" figure instead.
fingerprint: e189e7628319773d
source: audit-robustness
reason: user-approved behavior change

## T-029
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 9
title: create_invoice_link() builds its idempotency key with an unsynchronised _next_key, so a concurrent reserve collides on the unique column
files: backend/app/services/aito_payment_links.py
evidence: backend/app/services/aito_payment_links.py:1079 · `idempotency_key=await _next_key(db, project_id)` where `_next_key` is `count = SELECT id WHERE project_id=…` then `f"aito:{project_id}:{len(count) + 1}"` — a read-then-insert with two awaits between them, and `idempotency_key` is `unique=True` (models/aito_payment_link.py:26). Nothing serialises it: the reconciler's own `_create` (line 371) computes keys from the same per-project counter under `_pass_lock`, which this HTTP path never takes, and two operator clicks (two tabs, two operators on one card) race each other as well. Both compute `aito:7:2`, the second `await db.commit()` raises IntegrityError, and since `create_invoice_link` only catches `(HeimdallUpstreamError, HeimdallNotConfigured)` it leaves the route as an unhandled 500 on the Create-link button. The sibling terminal path documents this exact hazard and takes `_start_lock` for it (aito_terminal_payments.py:48-53). · fix: reserve the row under the same `_pass_lock` the reconciler holds (or a dedicated lock), or derive the key from the row's own autoincrement id / a uuid4 instead of a counted SELECT. · user-visible change: a create-link click that currently 500s when it races the reconciler or a second click would succeed (or return the existing link) instead.
fingerprint: 6a479979ed4becff
source: audit-robustness
reason: user-approved behavior change

## T-030
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 9
title: send_pickup_sms() reports a Pushcut transport timeout as a clean failure, inviting a second SMS to the client
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:3953 · `except PushcutUpstreamError as e: raise HTTPException(status_code=502, detail=str(e)) from e` — and `send_sms_notification` folds every transport outcome into that one error (`except httpx.HTTPError as e: raise PushcutUpstreamError(f"Pushcut request failed: {e}")`, pushcut.py:55), read timeout included. A POST that Pushcut received but did not answer within `TIMEOUT_S = 8.0` therefore reaches the operator as `aito.smsSendFailed` (SmsPickupModal's `onError`), with no event recorded and no idempotency guard anywhere on the route — unlike `record_manual_payment`, which keeps a `_recent` key for exactly this case. The operator presses Send again, a second notification lands on the phone, and the client gets the pickup SMS twice. · fix: distinguish the transport case (a dedicated `PushcutUnreachable`, mirroring `HeimdallUnreachable`) and report it as "may already have been pushed", plus a short-window duplicate guard keyed on (project_id, message) so a reflex retry is refused. · user-visible change: a timed-out send would no longer read as a plain failure — the operator gets an "it may already have gone" message and an immediate identical retry is refused.
fingerprint: 64c1537894c472e0
source: audit-robustness
reason: user-approved behavior change

## T-031
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 9
title: edit_project_client() writes the contact to Books before claiming the version, so a lost race leaves Books holding an edit no card shows
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:3496 · `name = await zoho_service.update_contact(db, project.client_id, …)` runs at line 3496, and only afterwards does line 3531 run `if payload.expected_version is not None and not await _claim_expected_version(db, project, payload.expected_version): raise HTTPException(status_code=409, …)`. If another operator's write bumps `version` during that Books round trip (the pre-check at line 3454 passed a moment earlier), the client's name/phone/email have already been overwritten in Books while the 409 aborts every local write and the fan-out. The editor shows "Project was updated by someone else" — which reads as "nothing happened" — and from then on every card and every future quote PDF disagrees with the contact record in Books until somebody happens to re-save. · fix: claim the version first and undo it (or re-push the prior contact values) when the Books call fails, rather than ordering the two so a refused claim strands a completed upstream write. · user-visible change: a client edit that loses the version race would no longer reach Zoho Books at all, where today it lands there and nowhere else.
fingerprint: d68bf7269f6297c0
source: audit-robustness
reason: user-approved behavior change

## T-033
priority: P2
status: DONE
attempts: 1
round: 3
first_seen_iteration: 9
last_touched_iteration: 11
title: api.importAitoProjects has no frontend caller — the legacy localStorage-migration UI is gone
files: frontend/src/api/client.ts
evidence: frontend/src/api/client.ts:8275 · rg -n '\bimportAitoProjects\b' frontend/src -> only its own definition at client.ts:8275 (JSON.stringify body posted to '/aito/import'); rg -n "aito/import|importAitoProjects" frontend/src/**/*.tsx (excluding __tests__) -> no matches. The backend route it calls (backend/app/api/routes/aito.py:3132 import_legacy_projects) is explicitly documented as 'One-time localStorage migration' and is still exercised directly by backend/tests/unit/test_aito_routes.py via raw async_client.post — those tests never go through api.importAitoProjects, confirming the frontend wrapper itself has no caller anywhere in the app. · fix: Delete the importAitoProjects method from api/client.ts (the backend /aito/import route and its tests can stay — they are the backend's own concern and may still serve a fresh-install migration path called another way). · user-visible change: importAitoProjects is a named export listed in SURFACE.md's frozen contract for api/client.ts; removing it deletes a pinned public API-client method (no runtime UI effect today since nothing calls it, but any external script or future onboarding wizard that imported it directly would break).
fingerprint: 3cf9eece00ab488f
source: audit-cleanliness
reason: user-approved behavior change

## T-034
priority: P2
status: DONE
attempts: 1
round: 3
first_seen_iteration: 9
last_touched_iteration: 11
title: AddContactForm (in ContactPersonPicker.tsx) re-implements NewContactForm's name/phone/email capture and has drifted on error-clearing
files: frontend/src/components/aito/ContactPersonPicker.tsx
evidence: frontend/src/components/aito/ContactPersonPicker.tsx:237 · Both components independently wire up the same shape: local firstName/lastName state with onBlur={(e) => setFirstName(titleCaseSegments(e.target.value))} / setLastName(upperCaseName(...)) (NewContactForm.tsx:168-183 vs ContactPersonPicker.tsx:306-327), phone state via PhoneInput + validatePhone + a `blurred` map + maskVisibleErrors, an email input + validateEmail + FieldError, a `reachable = phone-or-email non-empty` gate, and a submit handler that force-sets blurred before checking canSubmit. They have already diverged: AddContactForm's onChange handlers call `setError(null)` on every keystroke (ContactPersonPicker.tsx:307-308, 325, 346, 363), clearing a failed-submit error message the instant any field is touched, while NewContactForm never clears `error` outside its submit handler (NewContactForm.tsx:59-113) — the same failed-create message a user sees in the drawer's create-contact step silently outlives one in the picker's inline add form. · fix: Extract the shared first/last-name + phone + email capture-and-validate wiring (state, blur casing, validatePhone/validateEmail, maskVisibleErrors, reachable/canSubmit) into one hook (e.g. useContactFields) that both NewContactForm and AddContactForm call, and pick one error-clearing behavior for both call sites.
fingerprint: 587b424016cae531
source: audit-cleanliness

## T-036
priority: P1
status: DONE
attempts: 1
round: 3
first_seen_iteration: 9
last_touched_iteration: 10
title: POST /api/v1/heimdall/test has no test proving RequirePermissionIfAuthEnabled(SETTINGS_UPDATE) actually rejects an unauthorized caller
files: backend/app/api/routes/heimdall.py
evidence: backend/app/api/routes/heimdall.py:28 · backend/app/api/routes/heimdall.py:28 declares `_: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE)`, but every test in backend/tests/unit/test_heimdall_route.py calls `await async_client.post("/api/v1/heimdall/test", json={...})` with no Authorization header and no 401/403 assertion (test_unconfigured, test_probe_outcomes, test_unreachable, test_overrides_probe_an_unsaved_token, test_override_url_is_ssrf_guarded, test_malformed_override_token_reads_as_not_configured); `grep -rn 'heimdall' backend/tests/unit/test_*permission*` returns nothing, and `grep -rln 'SETTINGS_UPDATE' backend/tests` finds no sweep that includes /heimdall/test. This is the same class of gap already fixed for zoho.py's contact routes (test_zoho_permissions.py), but heimdall.py's own route was never given the equivalent test even though it lets a caller probe reachability of an arbitrary internal host/port via `base_url`/`token` overrides (SSRF-guarded, but still an internal-network probe primitive) using the saved Heimdall credential. · fix: in backend/tests/unit/test_heimdall_route.py, add a case (reusing the aito_tokens-style real-JWT technique from test_aito_permissions.py: enable auth via a Settings row, mint a JWT for a user with no SETTINGS_UPDATE permission) that POSTs /api/v1/heimdall/test with that token and asserts 403, and that heimdall_service._transport is never invoked.
fingerprint: ce4a504e279634f5
source: audit-tests

## T-037
priority: P2
status: DONE
attempts: 1
round: 3
first_seen_iteration: 9
last_touched_iteration: 12
title: test_aito_permissions.py's WRITE_ROUTES sweep is a hand-maintained list, not a dynamic check against app.routes — an ungated new write route in aito.py/aito_payments.py would ship silently
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:129 · backend/tests/unit/test_aito_permissions.py:129 only does `assert len(WRITE_ROUTES) == 30, "WRITE_ROUTES must cover exactly the 30 gated write routes aito.py and aito_payments.py declare"` — a static count of a manually-written list, with no code anywhere in the file that inspects `app.routes` or `r.dependant.dependencies` to verify that count is actually still accurate. Its own sibling file, backend/tests/unit/test_zoho_permissions.py, added in this same campaign, DOES do this dynamically: `zoho_routes = [r for r in app.routes if getattr(r, 'path', '').startswith('/api/v1/zoho/')]` plus `ungated = [r.name for r in zoho_routes if not any(_is_permission_gate(d.call) for d in r.dependant.dependencies)]` (lines 76-78), with its own docstring explaining exactly why: "A NEW route added to zoho.py without RequirePermissionIfAuthEnabled ... fails HERE, rather than silently escaping the sweep below (which only iterates ZOHO_ROUTES by hand)". test_aito_permissions.py — the larger, higher-traffic surface (42 @router decorators in aito.py + 5 in aito_payments.py per `grep -c '^@router\.'`) — never got that same protection: a future write route added without a permission dependency would not fail any test until someone remembers to hand-add it to WRITE_ROUTES. · fix: in backend/tests/unit/test_aito_permissions.py, add a test mirroring test_zoho_permissions.py's test_every_zoho_route_declares_a_permission_gate: enumerate `app.routes` whose path starts with /api/v1/aito/, exclude the known read-only GET routes explicitly, and assert every remaining route's `dependant.dependencies` includes a callable matching require_permission_if_auth_enabled/require_any_permission_if_auth_enabled.
fingerprint: 2987a4f053ebed46
source: audit-tests

## T-038
priority: P2
status: DONE
attempts: 1
round: 3
first_seen_iteration: 9
last_touched_iteration: 12
title: _months_ago()'s year-rollover and day-clamp branches, and _balance()'s malformed-value catch, are structurally unreachable through the only caller's fixed 24-month window
files: backend/app/services/aito_client_rating.py
evidence: backend/app/services/aito_client_rating.py:196 · coverage: backend/app/services/aito_client_rating.py missing_lines includes [200, 201, 206, 207, 208, 214, 215] (from coverage-aito20-backend.json). `_months_ago` (line 196) has `if month < 1: month += 12; year -= 1` (200-201) and a day-clamp loop trying `(today.day, 30, 29, 28)` (206-208) for a target month too short for `today.day`; `_balance` (line 210) has a `except (TypeError, ValueError): return 0.0` (214-215) for a malformed Books balance. Its only caller is `rate_invoices`, line 242: `window_start = _months_ago(today, HISTORY_MONTHS)` with `HISTORY_MONTHS = 24` (line 105) — an exact multiple of 12, so `today.month - months % 12` never goes below 1 and the clamp loop's first candidate (`today.day`) always succeeds for the same month-of-year. `grep -n '_months_ago(' backend/tests/unit/test_aito_client_rating.py` and `grep -n '_balance\b' backend/tests/unit/test_aito_client_rating.py` both return no matches — the whole test file only drives `rate_invoices`/`get_client_rating` with `TODAY = date(2026, 9, 22)` and `HISTORY_MONTHS`. A bug in the year-rollover arithmetic or the day-clamp order would silently compute a wrong 24-month rating window (or misbehave the day HISTORY_MONTHS is ever changed to a non-multiple of 12) and no test would catch it. · fix: in backend/tests/unit/test_aito_client_rating.py, add direct unit tests for `_months_ago` (e.g. `_months_ago(date(2026, 1, 15), 1) == date(2025, 12, 15)` for the year-rollover branch, and `_months_ago(date(2026, 3, 31), 1) == date(2026, 2, 28)` for the day-clamp branch) and for `_balance` with a non-numeric `balance` value (e.g. `{'balance': 'n/a'}` -> `0.0`).
fingerprint: d9d5313bcfcbfb0d
source: audit-tests

## T-039
priority: P2
status: DONE
attempts: 1
round: 3
first_seen_iteration: 9
last_touched_iteration: 12
title: patch_contact rewrites any Zoho Books contact's email/phone under aito:create, unscoped to a card and unaudited
files: backend/app/api/routes/zoho.py
evidence: backend/app/api/routes/zoho.py:290 · @router.patch("/contacts/{contact_id}", status_code=204)\nasync def patch_contact(\n contact_id: str,\n payload: ZohoContactPatch,\n db: AsyncSession = Depends(get_db),\n _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_CREATE), — while the sibling read of the same record is stricter ("Gated like the edit it feeds (aito:update), not like the search (aito:create)", get_contact line 227/231) and create_contact_person's own docstring (line 340) asserts the opposite of the code: "Gated like `list_contact_persons` (aito:create), not `patch_contact` (aito:update)". The handler takes any contact_id (only the walk-in default is refused), calls zoho_service.update_contact_person(db, contact_id, email=..., phone=...) — which overwrites the PRIMARY contact person's email/mobile in Books — and records no Aito event. · fix: Either gate the write on Permission.AITO_UPDATE (the boundary get_contact and create_contact_person's docstrings already claim for it), or keep aito:create but require contact_id to be the client_id of an existing active AitoProject before calling update_contact_person, and record an aito event naming the old/new values so a Books-side recipient change is visible on the timeline the way an edit through /aito/{id}/client is; POST /contacts/{contact_id}/persons has the same unscoped shape and should be decided together. · user-visible change: A principal holding only aito:create (the new-project drawer's syncClientToZoho step, which pushes an edited phone/email back to Zoho after the card is created) would start getting a 403/404 instead of a silent 204 for contacts it is not allowed to touch, and the permission published for PATCH /api/v1/zoho/contacts/{contact_id} changes.
fingerprint: 51532fe9b3300133
source: audit-security
reason: user-approved behavior change

## T-040
priority: P1
status: DONE
attempts: 1
round: 3
first_seen_iteration: 9
last_touched_iteration: 10
title: edit_project_client() holds the SQLite write lock across the Zoho contact round trip
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:3572 · `if payload.expected_version is not None and not await _claim_expected_version(\n db, project, payload.expected_version\n ):` now runs BEFORE `name = await zoho_service.update_contact(` (line 3582). `_claim_expected_version` issues a real `UPDATE aito_projects ... SET version = version`, which takes SQLite's write lock inside this uncommitted transaction; `update_contact` then makes three Books calls (PUT /contacts, GET /contacts/{id}, PUT contactpersons) each at the client's 10 s httpx timeout with a 401-retry-once, so the lock can be held for 30 s+ while `PRAGMA busy_timeout = 15000` (backend/app/core/database.py:21) only makes other writers wait 15 s. During one slow contact edit every other board write — another operator's PATCH, the quote-sync worker's commit, the invoice poll, the payment-link reconciler — blocks and then fails with `database is locked`: the peer gets a 500 on a save that was valid, and the background tick logs 'Aito quote sync tick failed' and drops that pass. · fix: Make the claim its own committed transaction: have `_claim_expected_version` bump (`version = version + 1`) and `await db.commit()` before any Zoho call, so the row is claimed but the write lock is released while httpx is in flight; re-read `project` after the Books call for the remaining local writes. · user-visible change: The version is bumped before Books answers, so a contact edit that Books then refuses leaves the card at a new version and any other editor open on it gets a 409 even though nothing was actually changed.
fingerprint: 650fbcb659805d8c
source: audit-robustness
reason: user-approved behavior change

## T-041
priority: P1
status: DONE
attempts: 1
round: 3
first_seen_iteration: 9
last_touched_iteration: 10
title: create_invoice()'s duplicate guard is a check-then-act and ignores the local quote_invoiced flag
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:2063 · `existing = await zoho_service.list_project_invoices(db, quote_id, client_id)` / `if existing: raise HTTPException(status_code=409, ...)` is the ONLY duplicate protection, and between it and `created = await zoho_service.create_invoice(...)` the route makes three more Books round trips (plan_invoice reads the estimate, the customer's payments and retainers). Two operators on the same card — or one retry after a client-side timeout on a request that routinely runs 10 s+ — both read an empty list and both raise a REAL invoice for the client. `_project_ready_to_invoice` (line 1949) restates every other button rule (column, quote_id, sync pending) but never checks `project.quote_invoiced`, which the route itself sets to True on success and which `canCreateInvoice` (frontend/src/components/aito/canCreateInvoice.ts:32) relies on — so even the already-billed case reaches Books, and in the documented 'estimate link did not stick' case (logged at line 2178: 'the duplicate guard cannot see it') nothing at all stops a second bill. · fix: Add `if project.quote_invoiced: raise HTTPException(409, ...)` to `_project_ready_to_invoice`, and serialise the Books read-then-create window behind a module `asyncio.Lock` (the same idiom as `aito_payment_links._reserve_lock` and `aito_terminal_payments._start_lock`). · user-visible change: POST /aito/{id}/invoice on a card already flagged quote_invoiced now answers 409 immediately instead of asking Books, and a second concurrent request waits for the first rather than billing in parallel.
fingerprint: efc1755bbe5068e6
source: audit-robustness
reason: user-approved behavior change

## T-042
priority: P1
status: DONE
attempts: 1
round: 3
first_seen_iteration: 9
last_touched_iteration: 11
title: refresh_terminal_payment()'s HeimdallNotFound branch overwrites an already-paid counter payment with 'failed'
files: backend/app/services/aito_terminal_payments.py
evidence: backend/app/services/aito_terminal_payments.py:414 · `open_row = row.status in OPEN_STATUSES or (row.status == "paid" and row.booking_status == "pending")` (line 407) deliberately keeps polling a PAID row whose Zoho booking is still pending, and the 404 handler beneath it is unconditional: `except HeimdallNotFound as exc:` / `row.status = "failed"` / `row.settled_at = row.settled_at or now` / `await db.commit()`. One 404 on such a row — Heimdall's base URL repointed at another instance, a key rotation, a lost record — rewrites a card payment the client actually made as `failed`, with no `payment.terminal.failed` event recorded (unlike `_age_out_abandoned_reservations`, which does record one), so the panel shows the counter charge as failed with nothing in the timeline saying why. For an open row the same line stamps `settled_at`, after which `apply_terminal_state`'s `if was_settled ... return` (line 325) permanently refuses to adopt a later `paid` view: no `payment.terminal.paid`, no `accept_quote`, no Zoho payment. · fix: Only take the failed branch when the row is not already settled and not `status == "paid"`; for a paid (or settled) row record the 404 in `sync_error`/`checked_at` and leave `status`, `booking_status` and `settled_at` untouched, and record a `payment.terminal.failed` event on the branch that does mark a row failed. · user-visible change: A Heimdall 404 on a paid-but-unbooked counter payment no longer flips the card to 'failed'; it stays paid with a sync error, and a 404 that does fail a row now writes a timeline event.
fingerprint: bdd4505ad53ad2b3
source: audit-robustness
reason: user-approved behavior change

## T-043
priority: P2
status: DONE
attempts: 1
round: 3
first_seen_iteration: 9
last_touched_iteration: 13
title: _sms_guard_key_or_409()'s duplicate guard is check-then-act, so an in-flight send does not block a second one
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:4048 · `key = (project_id, message.strip())` / `if key in _recent_sms: raise HTTPException(status_code=409, detail=_SMS_DUPLICATE_DETAIL)` runs before `await send_sms_notification(...)`, but `_recent_sms[key] = time.monotonic()` is only executed after that call returns (line ~4107 on success, and in the `PushcutUnreachable` handler). Pushcut's POST runs at `TIMEOUT_S = 8.0`, so for up to eight seconds the key is unarmed: an operator whose request hangs or whose browser/proxy drops the response and who sends again — the exact 'reflex retry' the guard's own comment names — passes the check and a SECOND real SMS lands on the client's phone, the outcome the guard exists to prevent. · fix: Arm `_recent_sms[key]` before calling `send_sms_notification` and delete the key again only on the clean-refusal paths (`PushcutNotConfiguredError`, plain `PushcutUpstreamError`), leaving it armed on success and on `PushcutUnreachable`. · user-visible change: A second identical pickup SMS submitted while the first is still being pushed now gets the 409 'Already sent' refusal instead of sending.
fingerprint: 236452eff741e7e5
source: audit-robustness
reason: user-approved behavior change

