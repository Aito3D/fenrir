# Aito ↔ Zoho sync: fast pushes, light background, per-card buffer

**Date:** 2026-10-01
**Branch:** `aito-zoho-sync-smooth` (worktree `.claude/worktrees/aito-zoho-sync-smooth`, cut from local `main` 17cef9ed8)
**Status:** draft for review

## Goal

An operator who creates or edits a card must be able to print, download or send its quote right away, with the latest content, without ever going to Zoho Books to check.

Concretely:

1. A new card has its Zoho quote in about 3 seconds.
2. An edit reaches Zoho about 10 seconds after the operator stops changing that card, and never later than 45 seconds after the first unsynced change.
3. Clicking Print, Download, Send or Create invoice on a card with unsynced changes pushes that card first and then proceeds. The operator does not wait for a timer and never gets a stale document.
4. Background reconciliation never delays a push and never exhausts Zoho's per-minute limit.

## Why now: what production shows

Measured on the shop host on 2026-10-01 (image ef63aa88c, which contains the 2026-09-30 latency fix 33beb4f3e), from container logs and the `aito_events` table.

| Delay | Before the 09-30 deploy | Since the 09-30 deploy |
|---|---|---|
| Card created → quote exists | median 5 s; 13 of 33 took 1–5 min | median 703 s; all 10 took 157–892 s |
| Edit queued → pushed | median 13 s; 20 of 117 took 1–5 min | median 352 s; 21 of 31 took over 60 s |

Mechanism:

- Every periodic tick reconciles every open quoted card (77 on the production board): one `GET /estimates/{id}` each, plus a customer-payments read per distinct customer (74) and a retainer listing where a deposit is owed.
- The keep-alive HTTP client shipped on 09-30 made those calls fast enough that a tick now exceeds Zoho's limit of 100 requests per minute about 60 seconds in. Zoho answers HTTP 429. The persisted logs hold no 429 for 09-28 and 09-29; the first came 73 seconds after the new container started.
- `_arm_rate_limit_throttle` then holds `_throttled_until` for `_RATE_LIMIT_MAX_RETRY_SECONDS` (15 minutes; Zoho's `Retry-After` is evidently at least that, its value is not logged). `run_sync_once` returns 0 for every drain inside the window, so creations, edits and `POST /aito/{id}/sync` (panel close and Force sync) all wait for the window to end.
- Zoho itself accepted writes inside those windows (contact creations returned 201), so the 15-minute hold is self-imposed.

Side effects seen in the same logs:

- The sweep stops at the 429, so cards above roughly id 240–270 are not reconciled during the day.
- Operator calls made right after a tick fail (a quote PDF with 429, contact-person saves with 502).
- About 290 warnings a day `payment link reconcile failed … Heimdall HTTP 400 … Nothing to update`, from seven cards whose payment-link expiry date has passed (see "Payment-link no-op" below).

Verified against the live Zoho org on 2026-10-01 with three read-only requests:

- `GET /estimates`, `GET /customerpayments` and `GET /retainerinvoices` all accept `last_modified_time=<…+0000>` with `sort_column=last_modified_time` and return only rows modified since then.
- Estimate list rows carry `estimate_id`, `status`, `total`, `customer_id`, `last_modified_time`, `accepted_date`, `declined_date`, `is_viewed_by_client`. Payment rows carry `customer_id`, `unused_amount`, `retainerinvoice_id`. Retainer rows carry `customer_id`, `estimate_number`, `reference_number`, `status`, `balance`.
- Responses carry `x-rate-limit-limit: 50000`, `x-rate-limit-remaining` and `x-rate-limit-reset` (seconds): the daily budget is 50,000 calls and is not the binding limit.

## Non-goals

- No Zoho webhooks. Change polling gets most of the benefit with no Zoho-side configuration; webhooks can be added later.
- No parallel pushes. One Zoho sync operation at a time, as today.
- No change to what a per-card reconcile does (status rules, deposits, comments mirror, locks). Only which cards are reconciled, and when, changes.
- No change to how a quote is built or to the create/update calls themselves.
- No locally rendered quote PDF and no Fenrir-assigned quote numbers.
- No countdown in the interface.
- No new route and no new permission.

## Design

### 1. One worker, pushes first

`run_sync_loop` stays a single task that performs one sync operation at a time. It runs two cadences:

- the **change pass**, every `CHANGE_PASS_SECONDS = 60`: the three change polls and the reconcile queue (section 4);
- the **full tick**, every `aito_quote_poll_seconds` (default 300, unchanged): a pending drain, a change pass, then the passes that exist today.

Its wait ends at the earliest of: a push becoming due, a scheduled fast retry, the next change pass, the next full tick.

Between every background step (each poll, each reconciled card, each of the existing passes) the loop serves every push that is due. This replaces `_serve_wake_mid_tick`, which serves creations only; due edits and flushes are now served there too. A push therefore waits at most one background step, about 1–2 seconds.

### 2. Per-card push window

New module `backend/app/services/aito_push_schedule.py`, pure and clock-injected, holding process-local state:

- `note_edit(project_id, now)`: opens or extends that card's window. Due time is `min(now + EDIT_QUIET_SECONDS, first_unsynced_edit + EDIT_MAX_WAIT_SECONDS)`, with `EDIT_QUIET_SECONDS = 10` and `EDIT_MAX_WAIT_SECONDS = 45`.
- `note_immediate(project_id, now)`: due now. Used by creation, panel close, Force sync, merge, restore and every flush.
- `is_due(project_id, now)`: True when the card has no window (for example after a restart, when the database row is `pending` but memory is empty) or its window has closed.
- `next_due(now)`: seconds until the earliest open window closes, for the loop's wait.
- `take(project_id)`: removes the card's window when the drain selects it, before the push. An edit that lands during the push opens a fresh window and is not lost.
- `add_waiter(project_id)` / `resolve(project_id)` / `discard_waiter(...)`: the futures behind flush on intent (section 3).

`request_debounced_sync` and `request_immediate_sync` take the project id and delegate to this module. `_wake_worker` and `_commit_and_wake` in `routes/aito.py` pass the id they already have. The global `_debounce_deadline` and `EDIT_DEBOUNCE_SECONDS` are removed.

The pending drain selects `pending` rows as today and skips those whose window is still open. Order within a drain: flushed cards with a waiter first, then by due time.

The window is memory only. A restart loses it and the card, still `pending` in the database, is pushed by the full tick the loop starts with. That is the existing recovery behaviour.

### 3. Flush on intent

`aito_quote_sync.flush_and_wait(project_id, timeout=20.0)`:

1. Marks the card due now and wakes the loop.
2. Awaits a per-project waiter that the loop resolves after that card's push attempt has committed.
3. Returns; the caller re-reads the project through its own session.

A route helper `ensure_pushed(db, project)` in `routes/aito.py` calls it when `quote_sync_state == "pending"` and then applies one rule:

- State no longer `pending` (idle, error or locked): proceed exactly as the route does today for that state.
- Still `pending` after the timeout: HTTP 503 with detail code `sync_pending`. Nothing stale is served.

Routes that call `ensure_pushed` before touching Zoho:

- `GET /aito/{id}/quote.pdf` (Print and Download). For a card whose quote does not exist yet, the route waits for the creation; still no `quote_id` after the wait is the same 503.
- The quote email content and send routes.
- `POST /aito/{id}/invoice`, replacing the immediate 409 "changes still syncing"; the 409 remains only if the card is still pending after the wait.
- The invoice and retainer PDF routes, which the interface disables today for the same reason.

When the worker is not serving (sync disabled, Zoho not configured, loop not running), `ensure_pushed` does not wait and the routes behave as today.

### 4. Background: poll what changed

New module `backend/app/services/aito_change_poll.py`, modelled on `aito_invoice_poll` and using `aito_poll_watermark`:

- Three polls, each one list request per pass (paged, 200 rows, capped like the invoice poll): estimates, customer payments and retainer invoices modified since that poll's watermark. Watermarks live in settings `aito_estimate_poll_since`, `aito_payment_poll_since`, `aito_retainer_poll_since`. First run backfills one day.
- `zoho.py` gains `list_estimates_modified_since`, `list_customer_payments_modified_since`, `list_retainers_modified_since`, built like `list_invoices_modified_since`.
- Mapping to cards, restricted to cards the sweep predicate selects today (`_sweep_predicate`, non-pending): a changed estimate maps by `quote_id`; a changed payment or retainer maps by `client_id` to every selected card of that customer.

Matched card ids go into an in-memory reconcile queue (ordered, no duplicates). Each change pass also adds a safety trickle: the next `TRICKLE_PER_PASS = 2` selected cards after a rotating id cursor. On a 77-card board every card gets a full reconcile about every 40 minutes whatever the polls report.

Each change pass drains the queue through the existing reconcile branch of `sync_project`, unchanged, with the per-pass credit and retainer caches. Cards left in the queue when the pass stops (budget guard, 429) stay for the next pass. The queue is memory only; after a restart the trickle re-covers every card within one cycle.

The full tick no longer reconciles every quoted card. It queues only the cards that need a retry at today's cadence: cards in `error` state, and terminal cards whose status Books has not confirmed (`quote_status_confirmed` false). Production has one such card.

The passes that exist today keep their place, logic and cadence on the full tick: hourly invoice sweep, invoice poll, contact poll, tracking-view purge, payment-link reconcile, terminal-payment poll. They are not moved to the 60-second cadence because the payment-link reconcile polls Heimdall for every pending link and both existing polls are tuned for a five-minute pass. `aito_quote_poll_seconds` keeps its meaning and its default.

Estimated steady load of the change pass: 3 list calls, 2 trickle cards and the few changed cards, about 5–10 Books calls a minute.

Assumption to verify during implementation, read-only, on a real estimate: a client viewing or accepting a quote moves the estimate's `last_modified_time`. The comments mirror already relies on this. If it does not hold, `TRICKLE_PER_PASS` is raised so the cycle is 15 minutes or less.

### 5. Rate limits

- `_throttled_until` gates background work only: the change polls, queue reconciles, the invoice sweep and the invoice and contact polls. The pending drain no longer checks it.
- A background 429 holds background work for `min(Retry-After, 60 s)`; `_RATE_LIMIT_MAX_RETRY_SECONDS` drops from 15 minutes to 60 seconds.
- A 429 on a push leaves the card `pending` with no failure counted, as today, arms the same 60-second background hold, and schedules the existing fast retries (5, 15, 45 s). After those, the card is retried on every full tick and on every later wake.
- Budget guard: `zoho_service` keeps the send times of the last minute and exposes `calls_in_last_minute()`. Background work stops for the pass when the count reaches `BACKGROUND_CALL_CEILING = 50`. Pushes and operator requests are never held by the guard.
- Daily guard: `zoho_service` records `x-rate-limit-remaining` from each response. Below 5,000 remaining, the change pass runs only with the full tick until the count recovers.
- `ZohoRateLimited` carries Zoho's error code (44 per-minute, 45 daily, 1070 concurrent) and the raw `Retry-After`. Every 429 is logged at WARNING with both.
- Change-pass log line at INFO when the pass reconciled anything, DEBUG otherwise: duration, Books calls in the pass, calls in the last minute, daily remaining, queue length. The full tick keeps its existing `tick took` line.

### 6. Interface

- Quote Print, Quote Download, Send quote, invoice Print and Download: no longer disabled while `quote_sync_state === 'pending'`. They show their loading state while the server waits. On 503 `sync_pending` they show `aito.syncNotConfirmed` ("Zoho has not confirmed the latest changes yet — try again in a moment").
- `canCreateInvoice` drops its `pending` condition; the route waits instead.
- A managed card that is `pending` with no quote number yet shows the quote row with a "Creating quote…" placeholder in place of the number and working Print and Download buttons.
- Sync line on the Billing card: `pending` reads "Syncing with Zoho…" (`aito.syncPendingLabel`, reworded). When the open panel has seen the card go from `pending` to `idle`, the line reads "Up to date in Zoho" (`aito.syncUpToDate`) until the panel closes. An idle card that was never pending in this panel session shows no sync line, as today.
- New and reworded strings are translated in all 15 locales.

### 7. Payment-link no-op

For a pending link whose `expires_on` has passed, `_fields_match` reports drift (it compares against a clamped target) while the patch builder sends `expires_in_days` only when the raw dates differ, so `patch_link` goes out with an empty body and Heimdall answers 400. The fix makes the two agree: when there is no field to send, no call is made and the row is not marked failed. Production has seven such rows with `sync_failures` between 24 and 590; they clear on the first pass after deploy.

## Files

| File | Change |
|---|---|
| `backend/app/services/aito_push_schedule.py` | New: per-card windows, waiters |
| `backend/app/services/aito_change_poll.py` | New: three modified-since polls, card mapping |
| `backend/app/services/aito_quote_sync.py` | Loop rewired: due-push serving, reconcile queue, trickle, background-only throttle, `flush_and_wait`; global debounce removed |
| `backend/app/services/zoho.py` | Three list methods, call meter, rate-limit headers, `ZohoRateLimited.code` |
| `backend/app/api/routes/aito.py` | Project id passed to the wake; `ensure_pushed` in the PDF, email and invoice routes |
| `backend/app/services/aito_payment_links.py` | No-op patch fix |
| `frontend/src/components/aito/` | Print/Download/Send buttons, `canCreateInvoice.ts`, `quoteSync.ts`, `BillingCard.tsx`, `InvoiceCard.tsx` |
| `frontend/src/api/client.ts` | `sync_pending` error surfaced to the buttons |
| `frontend/src/i18n/locales/*.ts` | `syncNotConfirmed`, `syncUpToDate`, reworded `syncPendingLabel`, `pdfSyncPending` removed |

## Error handling

- A push that fails transiently keeps today's behaviour: fast retries, then the failure budget (`SYNC_FAILURE_LIMIT`) on passes. A waiter on that card is resolved after the attempt, sees `pending`, and the route returns 503 `sync_pending`.
- A change poll that fails (unreachable, 5xx) costs that poll for the pass; its watermark does not advance; the other passes run. A 429 arms the background hold.
- A poll row with an unparseable timestamp is skipped for the watermark, as in `aito_poll_watermark`.
- `flush_and_wait` always removes its waiter, on timeout and on cancellation.

## Testing

Backend unit tests (fake clock, `MockTransport`, the existing fixtures of `test_aito_quote_sync.py`):

- Push schedule: quiet period extends on each edit; ceiling caps it; windows are per card; immediate overrides; no window means due.
- Loop: a background 429 does not delay a creation or an edit push; a push's own 429 retries at 5/15/45 s; due pushes are served between background steps.
- Change poll: each of the three polls maps rows to the right cards; watermark advances and resumes; a failed poll leaves its watermark.
- Budget: one change pass on a 77-card board with nothing changed makes at most 10 Books calls; a full tick no longer reads every quoted card; the guard stops background work at the ceiling and leaves the queue intact.
- Flush: `ensure_pushed` waits and proceeds; times out to 503; does not wait when sync is disabled; waiter cleanup.
- Payment links: an expired-date pending link makes no Heimdall call and is not marked failed.
- Existing suites `test_aito_quote_sync*.py`, `test_aito_close_sync.py`, `test_aito_permissions.py` stay green; tests that assert the removed global debounce are rewritten against the per-card window.

Frontend (Vitest): buttons enabled while pending and showing the wait; 503 message; "Up to date in Zoho" only after a witnessed pending→idle; placeholder quote row; i18n parity.

Gates before merge: `./test_backend.sh`, `./test_frontend.sh` (output read, not exit code), `npm run typecheck`, `npm run build`.

## Rollout and verification

Local `main` is 57 commits ahead of the image running on the shop host. Deploying this branch through the normal path (merge to `main`, push, CI image, host pull) ships those commits too. That is the assumed path; the alternative is a cherry-pick onto ef63aa88c.

After deploy, on the shop host:

- `docker logs -t fenrir | grep -E "deferred \(Zoho|HTTP 429"`: none on a normal working day.
- Change-pass log lines: Books calls per pass at or under 10 in steady state.
- `aito_events` deltas over one working day: card created → quote created with 90% under 10 s; edit queued → pushed with median under 20 s and none over 60 s outside a Zoho outage.
- No `Nothing to update` warnings.
