# TRIAGE (schema v2)

## T-002
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: HeimdallConflict.code is captured but never read by any production caller
files: backend/app/services/heimdall.py
evidence: backend/app/services/heimdall.py:54 · `class HeimdallConflict(HeimdallUpstreamError): def __init__(self, message, code): ...; self.code = code` (heimdall.py:54-60), raised at heimdall.py:218 as `raise HeimdallConflict(message, code)`. Both production catch sites, `aito_payment_links.py:329` and `:513` (`except HeimdallConflict:`), never reference `.code` — they always re-GET and adopt the truth regardless of which 409 sub-code Heimdall returned (this matches the spec table at docs/superpowers/specs/2026-09-12-aito-heimdall-payment-links-design.md:138, which says both `conflict` and `idempotency_conflict` get the same re-GET treatment, so this is not a missed branch). The code is also already embedded in the exception's own message string (`message = f"Heimdall HTTP {response.status_code} {code}: ..."` at heimdall.py:212), so `str(exc)` (what `_fail`/`sync_error` and the loggers actually use) already carries it. `rg -n "\.code\b" backend/app/services/aito_payment_links.py backend/app/api/routes/aito.py backend/app/api/routes/heimdall.py` -> no hits; the only reads of `.code` are `backend/tests/unit/test_heimdall_client.py:245` (`assert info.value.code == code`), which tests a value nothing in production consumes. · fix: either drop the separate `code` attribute (the message string already carries it) or, if it is being kept for a planned future branch (e.g. distinguishing a genuine idempotency-key-reuse bug from an ordinary race), say so in the class docstring so the next reader does not go looking for a consumer that does not exist.
fingerprint: 56a403999c1bfe00
source: audit-cleanliness

## T-003
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: The five-status payment-link vocabulary is spelled out separately in four places with no shared constant
files: backend/app/services/aito_payment_links.py
evidence: backend/app/services/aito_payment_links.py:726 · The literal status set `pending | paid | failed | cancelled | expired` is hand-written four times with no shared source: the model comment `backend/app/models/aito_payment_link.py:38`, the Pydantic `Literal["pending", "paid", "failed", "cancelled", "expired"]` in `backend/app/schemas/aito.py:548`, the inline tuple in `link_view()` at `backend/app/services/aito_payment_links.py:726` (`row.status if row.status in ("pending", "paid", "failed", "cancelled", "expired") else "pending"`), and the frontend union `export type AitoPaymentLinkState = 'pending' | 'paid' | 'failed' | 'cancelled' | 'expired';` in `frontend/src/api/client.ts:4314`. They currently agree, but nothing enforces that: if Heimdall ever adds a sixth status, `link_view()` silently downgrades an unrecognized value to `'pending'` (masking the real state on the board) rather than raising, while the schema `Literal` would separately need updating or FastAPI response validation would 500 — two different, unsynchronized failure modes from one missed edit. · fix: define the status tuple once (e.g. a `_KNOWN_STATUSES` frozenset next to `_DEAD_STATUSES`/`_CLOSED_QUOTE_STATUSES` in aito_payment_links.py) and have both `link_view()` and the schema's `Literal` derive from it (or at least reference it in a comment so the two are kept in step); mirror the same set of literals on the frontend type with a comment pointing back to the backend source.
fingerprint: 8322c36869947b39
source: audit-cleanliness

