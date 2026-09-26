# TRIAGE (schema v2)

## T-002
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: _response() and _response_from_rating() duplicate the same 10-field AitoClientRatingResponse mapping
files: backend/app/services/aito_client_rating.py
evidence: backend/app/services/aito_client_rating.py:242 · lines 242-255: `def _response(row: AitoClientRating, *, stale: bool) -> AitoClientRatingResponse: return AitoClientRatingResponse(tier=row.tier, reason=row.reason, settled_count=row.settled_count, on_time_count=row.on_time_count, overdue_count=row.overdue_count, past_due_count=row.past_due_count, worst_overdue_days=row.worst_overdue_days, worst_overdue_number=row.worst_overdue_number, is_company=row.is_company, computed_at=row.computed_at, stale=stale)` vs lines 258-271: `def _response_from_rating(rating: ClientRating, computed_at: datetime) -> AitoClientRatingResponse: return AitoClientRatingResponse(tier=rating.tier, reason=rating.reason, settled_count=rating.settled_count, on_time_count=rating.on_time_count, overdue_count=rating.overdue_count, past_due_count=rating.past_due_count, worst_overdue_days=rating.worst_overdue_days, worst_overdue_number=rating.worst_overdue_number, is_company=rating.is_company, computed_at=computed_at, stale=False)` — same 8 fields copied field-by-field from two differently-typed sources (the AitoClientRating ORM row and the ClientRating dataclass) that happen to share attribute names · fix: since AitoClientRating and ClientRating expose the same attribute names, write one private helper that takes any object with those attributes (a typing.Protocol or just duck-typed) plus stale/computed_at, and have both call sites use it — so a future new field only has to be added in one place instead of two that can silently drift apart
fingerprint: 5f857a0f9128d2e8
source: audit-cleanliness

## T-014
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: record_manual_payment()'s _recent duplicate-guard dict is never evicted
files: backend/app/services/aito_manual_payments.py
evidence: backend/app/services/aito_manual_payments.py:31 · `# (project_id, kind, document_id, amount, reference) -> time.monotonic() of the last success.` / `_recent: dict[tuple, float] = {}` — entries are written by `_recent[key] = time.monotonic()` on every attempt and removed only by `_recent.pop(key, None)` on the failure path; a SUCCESSFUL payment's key stays for the life of the process even though `DUPLICATE_WINDOW_SECONDS` is 60. Every distinct (project, document, amount, reference) tuple ever paid accumulates in a long-lived process, and nothing sweeps expired entries, so the dict only grows between restarts. · fix: Prune entries older than `DUPLICATE_WINDOW_SECONDS` on each call (the same `calls[:] = [t for t in calls if ...]` shape `_check_rate_limit` uses), or key the guard in a bounded structure such as an OrderedDict trimmed to a max size.
fingerprint: d9c5ef6710b9cc7e
source: audit-robustness

## T-015
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: _check_rate_limit()'s _ai_rate_limit_calls never drops stale principal keys
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1633 · `_ai_rate_limit_calls: dict[str, list[float]] = {}` and, in `_check_rate_limit`, `calls = _ai_rate_limit_calls.setdefault(key, [])` / `calls[:] = [t for t in calls if now - t < _AI_RATE_LIMIT_WINDOW_S]` — the per-key list is pruned only when that key is hit again, and the key itself is never deleted. On an auth-disabled install the key is `f"ip:{host}"` (`_ai_rate_limit_key`), so every distinct client IP that ever touches `/summarize`, `/proofread`, a counter-payment route or the link Retry leaves a permanent dict entry. The sibling tracking limiter in this same module already sweeps (`_TRACK_RATE_SWEEP_ABOVE`); this one does not. · fix: Drop keys whose pruned list is empty, and periodically sweep buckets older than the window — mirroring the `_TRACK_RATE_SWEEP_ABOVE` housekeeping already in this module.
fingerprint: 9dcf5608a1996445
source: audit-robustness

## T-016
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: _check_rate_limit's _ai_rate_limit_calls map never evicts stale principal keys
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1633 · _ai_rate_limit_calls: dict[str, list[float]] = {} ... calls = _ai_rate_limit_calls.setdefault(key, []); calls[:] = [t for t in calls if now - t < _AI_RATE_LIMIT_WINDOW_S] — the per-key list is trimmed but the key itself is never deleted, unlike the tracking limiter in the same file: 'for bucket in (_track_rate_ip_calls, ...): if len(bucket) > _TRACK_RATE_SWEEP_ABOVE:' (line 1309) · fix: sweep empty/expired entries out of _ai_rate_limit_calls the way _track_rate_limited already sweeps its four buckets (delete keys whose live() list is empty once the dict exceeds a threshold)
fingerprint: b4fd2a161c104ca5
source: audit-security

## T-018
priority: P3
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 5
last_touched_iteration: 5
title: 409 version_conflict HTTPException body is copy-pasted 4x across update_project/edit_project_client
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:3295 · Identical 3-line block `raise HTTPException(status_code=409, detail={"code": "version_conflict", "message": "Project was updated by someone else"})` appears verbatim at lines 3293-3296 and 3334-3337 inside `update_project`, and again at 3455-3458 and 3534-3537 inside `edit_project_client` (grep -n 'version_conflict' backend/app/api/routes/aito.py -> exactly these 4 hits, all with the same literal dict). Each function repeats it once for the cheap pre-check and once for the atomic `_claim_expected_version` re-check. · fix: Factor a small `_version_conflict() -> HTTPException` helper (or reuse a shared `_refuse`-style builder like aito_payments.py's) and call it from all 4 sites so the code/message pair can't drift between the two guarded routes.
fingerprint: c39b9acc7b04c632
source: audit-cleanliness

## T-026
priority: P3
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 5
last_touched_iteration: 5
title: HeimdallService.patch_link / cancel_link / get_payment interpolate heimdall_id into the request path without escaping the segment
files: backend/app/services/heimdall.py
evidence: backend/app/services/heimdall.py:338 · `return _to_view(await self._request(db, "PATCH", f"/api/v1/payments/{heimdall_id}", json_body=payload))` (line 338), `f"/api/v1/payments/{heimdall_id}/cancel"` (341), `f"/api/v1/payments/{heimdall_id}"` (344). `heimdall_id` is stored verbatim from an unauthenticated upstream body — `_to_view` does `link_id = str(data["id"])` with no character validation — and httpx normalises dot segments when it builds the request, the exact hazard services/zoho.py:26 `_seg()` was added to close ("an id of ``../../../crm/v2/Leads`` escapes the ``/books/v3`` prefix entirely"). Not currently exploitable because `sign()` hashes the un-normalised path so a traversal would fail Heimdall's signature check, but that is an accident of the signing recipe, not a control. · fix: wrap the id in `urllib.parse.quote(value, safe="")` (or reuse the same one-line helper zoho.py's `_seg` provides) at all three call sites, and validate `data["id"]` in `_to_view` against an id character class the way `_validate_link_url` already validates the url field
fingerprint: 62cec00ac12729a4
source: audit-security

## T-032
priority: P3
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 5
last_touched_iteration: 5
title: _ai_rate_limit_key() falls back to request.client.host, collapsing every caller onto one bucket behind a reverse proxy
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1642 · `host = request.client.host if request.client else "unknown"` — the raw TCP peer, not the proxy-aware `_get_client_ip` that `_track_rate_limited` in this same module deliberately uses ("behind nginx the latter is the proxy for every visitor, and the per-IP cap would silently become a per-shop cap"). This branch is taken whenever `current_user is None`, i.e. on an auth-disabled install and for every API-key caller, so behind nginx all of them share one key: one 30-calls/minute AI budget and one 10-calls/minute counter-payment budget (`_COUNTER_PAYMENT_MAX_CALLS`) for the whole shop, and the eleventh Create-link/cancel click of the minute 429s a different operator than the one who spent the budget. · fix: use the same proxy-aware `_get_client_ip` helper the tracking limiter uses for the anonymous fallback.
fingerprint: 777bd1f3d09da8d6
source: audit-robustness

## T-035
priority: P3
status: TRIAGED
attempts: 0
round: 3
first_seen_iteration: 9
last_touched_iteration: 9
title: isTerminalOpen() duplicates backend OPEN_STATUSES + booking_status predicate with no shared constant
files: frontend/src/components/aito/payment/useTerminalPayment.ts
evidence: frontend/src/components/aito/payment/useTerminalPayment.ts:12 · Frontend: `if (p.status === 'pending' || p.status === 'processing') return true; return p.status === 'paid' && p.booking_status === 'pending';` (useTerminalPayment.ts:12-16). Backend: `OPEN_STATUSES = frozenset({"pending", "processing"})` (aito_terminal_payments.py:32) reused at `row.status in OPEN_STATUSES or (row.status == "paid" and row.booking_status == "pending")` (aito_terminal_payments.py:407) and again as a SQL predicate at line 503-504. The backend itself already unified its two internal call sites behind OPEN_STATUSES; the frontend re-derives the same boolean from hardcoded string literals with no reference back to it. · fix: Add a one-line comment on isTerminalOpen pointing at OPEN_STATUSES/refresh_terminal_payment's predicate (the way aitoBoardRules.ts and aitoPayment.ts already do for their backend mirrors) so a new terminal-payment status added to one side is caught by a reviewer checking the other.
fingerprint: 2dceaf335396fda9
source: audit-cleanliness

