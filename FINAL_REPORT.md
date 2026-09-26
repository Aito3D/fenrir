# FINAL_REPORT.md — refactor-loop campaign 20 (the whole Aito feature — "check for bug or issue on the Aito feature")

Campaign 20 · worktree `../bambuddy-refactor` · branch `auto-refactor-loop` · BASE `refactor-base` (ec2a51c02, cut from main f91147642 on 2026-09-23 — the counter-payments merge; main == origin/main at setup)
Scope: the whole Aito feature, front and back end — routes aito / aito_payments / heimdall / zoho, schemas aito + heimdall, the seven aito_* models, the 20 aito_* services plus openrouter / heimdall / pushcut / zoho, the Aito slices of database.py / permissions.py / main.py / ws.py; pages/Aito*, components/aito/**, the four useAito*/useTracking* hooks, utils/aito* + tracking* + projectSeed, the Aito slice of api/client.ts and App.tsx, the aito.* keys in 14 locales, the --color-aito-* tokens. Calculator, printers, filament, library, spoolman, camera, auth core and upstream code were out of scope.
Brief: bugs and issues first (robustness + security lenses), cleanliness second.
Parameters: TRIAGE P3 · MAX_ITER 12 → 13 (raised by the user on 2026-09-24 so all seven round-3 tasks could be worked) · MAX_ROUNDS 3 · BATCH 3 · MODE auto · COMMIT_STYLE grouped · MERGE_CADENCE at-exit.

## Run summary

- Iterations run: 13 (every one verified PASS by the blind verifier; no reverts, no FAIL verdicts)
- Survey rounds completed: 3 of 3 (rounds 1, 2 and 3 all productive — no dry round)
- Commits on the branch: 13 squashed iteration commits + the setup commit (+ this report); tags loop-1 … loop-13
- Why the loop ended: **MAX_ROUNDS** — round 3 was the cap, its plan was fully worked (35 of 35 tasks DONE, 0 OPEN, 0 BLOCKED, 0 WONTFIX-AUTO) and the campaign did not converge in the formal sense (no dry round was ever surveyed; every round filed workable tasks). MAX_ITER was reached in the same iteration (13 of 13).
- Behavior-change approvals: 19 tasks were filed as behavior changes across the three rounds; the user approved every one (0 denied), plus one sanctioned probe re-baseline and one sanctioned additive export.

## User-approved behavior changes this campaign (BASELINE-CHANGELOG.md, 2026-09-23 → 2026-09-25)

Money / payments (routes/aito_payments.py, services/aito_terminal_payments.py, aito_payment_links.py, aito_invoice_create.py, aito_quote_sync.py, heimdall.py):
- T-010 counter deposits count toward the quote — `retainer_paid_total` also counts the customer's PAID retainer invoices whose reference_number is this quote's number (the sweep's own `_same_reference` rule), so a deposit taken at the counter or booked by Heimdall stops the online payment link, clears the "due" figure, drops the tracking page's pay button and auto-accepts the quote instead of inviting a second payment. One memoised Books call per customer per tick; a 429 defers the tick. **Verifier note:** the retainer read runs BEFORE read_customer_credit, so a 429 on /retainerinvoices leaves both figures unassigned that tick (pinned by a test).
- T-011 a Heimdall TRANSPORT failure on the terminal POST (new `HeimdallUnreachable(HeimdallUpstreamError)`) leaves the reservation an unminted `pending` row with the reason in sync_error instead of stamping it `failed`, so the operator's next start for the same document+amount replays it under its own idempotency key and adopts whatever Heimdall actually did. The operator sees "charge in progress" instead of a red Failed screen. Golden heimdall-wire re-recorded (2 outcome rows); SURFACE +1 class line.
- T-027 `apply_terminal_state` claims the settle atomically (`UPDATE … SET settled_at=:now WHERE id=:id AND settled_at IS NULL`, committed before any side effect) so the operator's 3 s poll and the forced sweep can no longer credit one card payment twice (two timeline entries, two accept_quote pushes, two notifications).
- T-028 create_invoice's post-create customer-credit read is best-effort — a Books 429/5xx there no longer 500s an invoice that was already raised.
- T-029 create_invoice_link reserves its row under a `_reserve_lock` shared with the reconciler, and a unique-key collision from another process is answered as the existing 409 link_exists instead of a 500.
- T-041 create_invoice refuses (409 "This project already has an invoice in Zoho") a card already flagged quote_invoiced before any Books call, and serialises the read → create → flag window under a module `_invoice_lock`; the preview route refuses the same card so the dialog does not open on a create that will refuse.
- T-042 refresh_terminal_payment's 404 branch no longer flips a paid (or settled) terminal payment to failed; an OPEN row Heimdall lost is still marked failed and now also writes a `payment.terminal.failed` event (reason not_found). Two iteration-4 tests of the old rule were rewritten.
- T-017 cancel_invoice_payment_link shares the counter_payment rate-limit bucket (10 calls / 60 s per principal) like every sibling counter-payment route.

Client / contact edits (routes/aito.py, routes/zoho.py):
- T-031 then T-040 edit_project_client claims the version BEFORE the Books contact write — first as a lock-only claim inside the request transaction (T-031), then (T-040) as its own COMMITTED transaction (version = expected+1) so SQLite's write lock is released for the Zoho round trip. A lost race is the same 409 as before with nothing sent upstream; a Books refusal now leaves the card at the new version with none of its fields written. Golden aito-openapi re-recorded twice for the route docstring's Ordering bullet (FastAPI publishes it as the endpoint description). **Verifier addendum:** a guarded NO-OP client edit now ends at expected+1, and updated_at moves even on a Books refusal or a no-op edit (updated_at feeds DoneGrid/TrashGrid ordering, aitoSearch reordering and the panel's last-activity fallback).
- T-039 PATCH /zoho/contacts/{id} keeps its aito:create gate but is scoped to the client_id of an ACTIVE AitoProject (404 "No active project for this contact" otherwise, no Books call). Nothing is recorded on the timeline — `project.updated` is a coalescing kind whose changes contract would lie. POST /contacts/{id}/persons stays unscoped (the drawer calls it before any card exists).
- T-012 an explicitly-sent `{"description": null}` on PATCH /api/v1/aito/{id} is a 422 instead of a 500 that had already burnt the row's version claim. An omitted description is still left alone.

Rate limits and abuse bounds (routes/aito.py):
- T-024 GET /aito/clients/{client_id}/rating: 422 for an id outside `^[A-Za-z0-9_-]{1,50}$` (validated in the route body so the OpenAPI golden is untouched), its own `client_rating` bucket (60 / 60 s per principal), and a 60 s negative cache (`_missing_until`, capped 512) for ids Books answers 404 for — previously every such request spent two Books calls and left a permanent aito_client_ratings row. The drawer's rate-a-fresh-contact flow is unaffected (no project membership required).
- T-025 POST /aito/{project_id}/pickup-sms is rate-limited (`pickup_sms` bucket, 10 / 60 s per principal) ahead of every lookup.

Pickup SMS (services/pushcut.py, routes/aito.py, SmsPickupModal):
- T-030 pushcut.py raises `PushcutUnreachable` on a transport failure; send_pickup_sms answers 502 "Pushcut did not answer in time — the notification may already have been pushed; check the phone before sending again" and writes no `project.sms.sent` event; a 60 s (project, message) guard (`_recent_sms`) armed on success AND on that ambiguous outcome refuses an identical retry with 409 "Already sent". New keys aito.smsMaybeSent / aito.smsAlreadySent in 14 locales; golden fe-i18n-parity re-recorded (7791 → 7793); SURFACE +1 class line.
- T-043 (iteration 13) the guard is armed BEFORE the Pushcut call and un-armed only on a clean refusal, so an identical retry submitted while the first push is still in flight is refused instead of sending a second SMS.

Invoice poll (services/aito_invoice_poll.py):
- T-013 `poll_invoices` counts CONSECUTIVE adoption failures per Books invoice (`_adopt_failures`, `MAX_ADOPT_FAILURES = 3`); a row at the cap is logged ONCE at ERROR and treated as seen, so the watermark advances instead of staying pinned at a row that will never succeed while the window grew every tick.

Frontend:
- T-019 the Activity Rail labels project.contacted.set / cleared (two EVENT_LABEL_KEY entries + aito.history.projectContactedSet/Cleared in 14 locales; previously the raw kind string). Golden fe-i18n-parity + SURFACE i18n section re-recorded.
- T-033 `api.importAitoProjects` deleted from api/client.ts (no caller since the localStorage-migration UI went; backend /aito/import untouched). SURFACE −1 API-client line.

Sanctioned re-baselines (not behavior changes):
- Iteration 9: the `payment-link-reconcile` probe was a clock bomb — link_kw never set created_at, so `expires_in_days` drifted with the UTC date (7 → 6 at the 2026-09-25 rollover). The user chose "freeze created_at"; the probe seeds now set every timestamp column and the golden was re-recorded. Lesson for every future campaign: every probe fixture must set every server-default timestamp column explicitly.
- Iteration 11: user rule "additive internal exports are sanctioned" (SURFACE regenerated in the same commit + changelog line). T-034 added the `useContactFields` hook shared by NewContactForm and AddContactForm (each form keeps its own error-clearing via a hook option). SURFACE +2 export lines.

## Non-behavior work (refactors, tests, hardening with no user-visible change)

- T-001 dead tuples removed; T-003 aito_client_rating docstring made truthful + characterization test of the empty paid-date rule; T-007 `not_configured` → 502 mapping on three counter-payment routes; T-008 service-level link_exists 409 guard (the test monkeypatches the ROUTE module's `current_link` binding to simulate the race).
- Tests filed by audit-tests and worked: T-004/T-005 terminal-payment tests; T-006 invoice-create DB-failure tests; T-009 settings-read failure test; T-020 poll-pass fallback tests; T-021 test_zoho_permissions.py with a route-completeness check (no hole found); T-022 PaymentLinkModal error-path tests; T-023 useTerminalPayment hook tests (React Query's tracked-props proxy means an unread poll.error never re-renders); T-036 heimdall 403 sweep; T-037 test_aito_permissions.py's WRITE_ROUTES sweep is now DYNAMIC against app.routes — it immediately found `set_project_due_date` missing from the hand-maintained list (30 → 31 routes, no gate was missing in production); T-038 `_months_ago` year-rollover / day-clamp and `_balance` malformed-value tests.

## What each survey round found

- Round 1 (2026-09-23): 17 findings — security 2, robustness 6, cleanliness 3, tests 6; 13 filed + 4 triaged (T-002, T-014, T-015, T-016). 5 behavior changes, all approved. Headline: T-010 (P0) counter deposits blind to retainer_paid_total — a customer who paid a deposit at the counter was still invited to pay online.
- Round 2 (2026-09-24, steered at the frontend and the services round 1 never reached — zoho routes, AI routes, export/import, shipping/SMS, stats, events, permission matrix): 15 findings — security 3, robustness 6, cleanliness 2, tests 4; 12 filed + 3 triaged (T-018, T-026, T-032). 8 behavior changes, all approved. Headline: T-027 terminal double-settle race.
- Round 3 (2026-09-24, final): 11 findings — security 1, robustness 4, cleanliness 3, tests 3; 10 filed + 1 triaged (T-035). 6 behavior changes, all approved. Headline: T-041 double-invoice guard, T-042 a Heimdall 404 flipping a PAID row to failed.
- No round was dry; MAX_ROUNDS stopped the campaign, not convergence.

## Findings by auditor (plan.py stats, by_source)

| auditor | filed in PLAN.md | DONE | BLOCKED | WONTFIX-AUTO | triaged (campaign-wide) |
|---|---|---|---|---|---|
| audit-security | 4 | 4 | 0 | 0 | 2 (T-016, T-026) |
| audit-robustness | 13 | 13 | 0 | 0 | 3 (T-014, T-015, T-032) |
| audit-cleanliness | 5 | 5 | 0 | 0 | 3 (T-002, T-018, T-035) |
| audit-tests | 13 | 13 | 0 | 0 | 0 |
| survey (hand-added) | 0 | 0 | 0 | 0 | — |
| **total** | **35** | **35** | **0** | **0** | **8** |

Raw panel output: 43 findings over three rounds (r1 17, r2 15, r3 11); 35 filed, 8 triaged, 0 suppressed as duplicates.

## Triaged findings (8, all P3) — TRIAGE.md holds each with full evidence

`plan.py --file TRIAGE.md render --iteration 13` lists them; promote one with `python tools/plan.py promote <id> --iteration N` (the `--iteration` flag is required). TRIAGE.md holds only this campaign's entries (the previous campaign's worktree was removed after its merge).
- T-002 `_response()` / `_response_from_rating()` duplicate the 10-field AitoClientRatingResponse mapping (aito_client_rating.py)
- T-014 record_manual_payment's `_recent` duplicate-guard dict is never evicted (aito_manual_payments.py)
- T-015 / T-016 `_check_rate_limit`'s `_ai_rate_limit_calls` never drops stale principal keys (routes/aito.py; robustness and security filed the same shape)
- T-018 the 409 version_conflict HTTPException body is copy-pasted 4× across update_project / edit_project_client
- T-026 HeimdallService.patch_link / cancel_link / get_payment interpolate heimdall_id into the request path without escaping the segment (heimdall.py)
- T-032 `_ai_rate_limit_key()` falls back to request.client.host, collapsing every caller onto one bucket behind a reverse proxy
- T-035 isTerminalOpen() duplicates backend OPEN_STATUSES + booking_status predicate with no shared constant (useTerminalPayment.ts)

## Gates at exit (iteration-13 verifier, 2026-09-25)

- Coverage (scoped statements, ratchet): backend 97.18% (6161/6340) → 97.93% (6387/6522) · frontend 92.61% (4853/5240) → 92.86% (4866/5240)
- known_broken: none before → none after
- Snapshot probes: 34/34 matching (the 34 goldens = 10 app-wide + 5 tracking + 19 Aito/Heimdall/payment-link/stats probes)
- SURFACE.md: regenerates byte-identical after the sanctioned changes (+1 HeimdallUnreachable, +1 PushcutUnreachable, +2 i18n keys, +2 useContactFields exports, −1 importAitoProjects), every diff line mapped to a changelog entry
- Static gates: ruff check/format, ESLint, tsc -b, vite build, i18n parity (7793 keys per locale, all locales in parity) all green
- Tests: backend pytest 15595 passed / 1 skipped / 0 failed (15462 at BASE) · frontend vitest 478 files, 7142 tests passed, 0 failed
- Diff vs BASE: 61 files, +4882 / −290 lines; production code 32 files +1164 / −257; tests 22 files +3658 / −13 (every removed test line is a strengthening or a sanctioned adaptation, per the verifiers)

## Tasks left for humans

- OPEN: none · BLOCKED: none · WONTFIX-AUTO: none.
- TRIAGED: the 8 P3 entries above.
- Leads noted by workers/verifiers but never filed (no auditor round remained to file them): `create_contact_person`'s docstring still misstates `patch_contact`'s gate (it is an aito-openapi golden line, so fixing it is a sanctioned re-record); the SURFACE generator's i18n regex only captures nested `aito.*.*` keys, so single-segment keys such as aito.smsMaybeSent are invisible to the surface freeze; T-010's retainer read ordering (a 429 on /retainerinvoices blanks both figures that tick).

## Operator notes (deploy-relevant)

- Two new rate-limit buckets (`client_rating` 60/min, `pickup_sms` 10/min per principal) and the shared counter_payment bucket now also covering cancel — all in-process, per worker.
- New 409/422/502 responses: 409 "This project already has an invoice in Zoho" (create + preview), 409 "Already sent — …" on a duplicate pickup SMS within 60 s, 422 on a null description PATCH, 422 on a malformed rating client id, 502 "Pushcut did not answer in time …" on an SMS transport timeout, 404 "No active project for this contact" on an unscoped contact PATCH.
- A Heimdall transport timeout on a terminal charge now leaves the card in "charge in progress" until the operator replays it or the sweep ages it out (ABANDONED_RESERVATION_SECONDS) — no longer a red Failed screen.

## Lessons for the next campaign (also in the orchestrator's memory)

- Every probe fixture must set every server-default timestamp column; a probe that reads a date derived from now() is a clock bomb.
- The security auditor under-flags `behavior_change` when a change adds a refusal (T-024, T-025) — hold such tasks BLOCKED for approval by hand.
- A route docstring is the published OpenAPI description: editing one moves the aito-openapi golden.
- Under system-daemon load (~27–32, fseventsd/mds) the frontend coverage run exceeds 10 min and idling agents are killed by the 600 s watchdog; resume the same agent with "background the run to a log, poll with short commands".
- Keep workers sequential — two workers collide on BASELINE-CHANGELOG.md.

## Iteration-13 verifier addendum for T-043 (not recorded in BASELINE-CHANGELOG.md — no later task commit existed to fold it into)

Two consequences of arming the pickup-SMS guard before the Pushcut call, both mechanical results of the approved change:
1. The 60 s duplicate window now starts when the push BEGINS, not when it returns, so after a successful send it ends up to about 8 s (Pushcut's timeout) earlier than before. A code comment calls this deliberate.
2. Any UNEXPECTED exception inside `send_sms_notification` (a `get_setting` failure such as SQLite "database is locked", or a cancelled request) now leaves the key armed for 60 s, so the next identical retry gets the 409 "Already sent" although nothing was pushed. For the cancelled case this is the intended in-flight protection; for the database-error case it is a new false "Already sent" that clears itself after 60 s. Worth a follow-up: un-arm the key on any exception that is not `PushcutUnreachable`.

## Where the loop's untracked state went

PLAN.md, TRIAGE.md, BASELINE.md, VERDICTS.log and the twelve `findings-audit-*-r{1,2,3}.json` files were copied to `refactor-campaign20-archive/` in the main checkout at EXIT (untracked there until you commit it, as `refactor-campaign19-archive/` was). Removing the worktree deletes the originals.
