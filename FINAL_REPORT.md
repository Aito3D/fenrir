# Refactor-loop campaign 23 — final report

**Scope:** the whole Aito feature, front and back end (routes `aito.py`, `aito_payments.py`, `zoho.py`, `heimdall.py`; services `aito_*`, `zoho.py`, `heimdall.py`, `pushcut.py`, `openrouter.py`; schemas/models; `components/aito/**`, `pages/Aito*`, Aito hooks/utils) plus the Aito-fed notification inbox (`routes/inbox.py`, `services/inbox.py`, `NotificationBell`/`NotificationPanel`, `InboxPreferences`, `inboxTarget.ts`).
**Branch:** `auto-refactor-loop` in `../bambuddy-refactor` · **BASE:** `refactor-base` = b078e6979 · **UPSTREAM** (main at setup): 703c033876187ceb2023510d960d84bc45cf2185
**Dates:** 2026-10-01 → 2026-10-04 (resumed once, 2026-10-03, after a lost session left iteration 10 unverified)

## Summary

| | |
|---|---|
| Campaign | 23 |
| Iterations run | 18 (`loop-1` … `loop-18`), MAX_ITER raised 12 → 20 by the user at round 3 |
| Survey rounds | 3 of 3 |
| Commits | 18 (one squashed commit per iteration) + this report |
| Tags | `loop-1` … `loop-18` |
| Why it ended | **MAX_ROUNDS** — the round-3 plan was worked to empty; round 3 was the last round allowed |
| Tasks | 55 filed · 48 DONE · 7 WONTFIX-AUTO (all declined by the user) · 0 open · 0 blocked |
| Triaged for humans | 40 in TRIAGE.md (table below) |
| Verifier runs | 20 (18 iterations; iterations 8 and 16 failed once and passed on re-run) |

## Metrics: BASE → loop-18

| Metric | Baseline (UPSTREAM) | Final (loop-18) |
|---|---|---|
| Backend scoped statements | 97.82% (7843/8018) | **99.05% (7960/8036)** |
| Frontend scoped statements | 93.37% (5809/6221) | **93.66% (5828/6222)** |
| Backend tests | 17159 passed / 0 failed | 17787 passed / 0 failed |
| Frontend tests | 7998 passed / 2 failed (load flakes) | 8011+ passed; failures only under machine load, all pass alone |
| Known-broken tests | none | none |
| Golden snapshot probes | 35/35 | 35/35 (4 goldens re-recorded under user-approved changes, see below) |
| ruff / ESLint / tsc / i18n parity | clean | clean |
| Diff (BASE..loop-18) | — | 68 files, +8055 / −2071; production +2594 / −1967 in 25 files; tests +4871 / −63 in 38 files |

## SURFACE.md

Unchanged except for changes each named in BASELINE-CHANGELOG.md:
- **Additive internal exports:** `AitoDialogShell` (T-104), `PanelMenuModals` + `useDescriptionEditor` (T-112), `CandidatePicker` (T-128), class `_OptionalClientContactChecks` (T-138), `AitoDialogFooter` (T-173).
- **Changed lines (wrapped signatures):** `async def sweep_invoices(` (T-102), `async def poll_open_terminal_payments(` (T-157). The surface generator keeps only a signature's first line (see follow-up leads).
- **Removed (user-approved T-154):** `client_id` and `client_name` from `AitoProjectUpdate`.

## User-approved behavior changes (from BASELINE-CHANGELOG.md)

The round-3 approval sweep asked about 22 behavior-change findings. The user approved 15 and declined 7 on 2026-10-03. Each approved change was implemented with a changelog entry in the same commit and verified blind against that entry.

| Task | User-visible change |
|---|---|
| T-096 | Transferring a card to another client (or a reassignment in Books) rotates its public tracking token; the old `/t/` link returns "Lien introuvable". |
| T-100 | `create_invoice` refuses (503 "not confirmed") a card that went back to pending while it waited for the invoice lock, instead of billing pre-edit lines. |
| T-101 | Inbox read-all is bounded by the newest row shown (optional `up_to`), and both mark-read writes refetch when they settle; an arrival during "mark all read" stays unread and rings. Golden `app-openapi-index` re-recorded (+`up_to`). |
| T-102 | The hourly invoice sweep serves due pushes between projects and stops at the Books per-minute ceiling (may finish over several ticks). |
| T-121 | Only Books' own status history (`comment_type == "system"`) becomes quote viewed/accepted/declined events; staff-typed comments mentioning those words stay plain comments. Backed by a user-authorised read-only probe of real Books payloads (2026-10-03). Golden `aito-status-comments` re-recorded. |
| T-123 | The abandoned-reservation sweep no longer writes off a terminal reservation being replayed; the write-off is a conditional claim. |
| T-124 | An error escaping the tick's attention pass no longer skips the tick's later passes. |
| T-125 | A DB error on one card no longer strands the rest of its push drain or its waiting routes. |
| T-126 | The second of two concurrent/duplicated merges gets a 409 instead of duplicating tasks or trashing both cards. |
| T-155 | Previewing/sending the quote email for a card with unpushed edits is refused with 409 "changes still syncing" (cards with no quote keep their 404). |
| T-156 | A failed change pass in the wake lap no longer drops the push windows that fell due during it. |
| T-157 | Due pushes are served between rows of the payment-link and terminal passes (with same-task re-entry so the nested changes-only pass cannot deadlock on `_pass_lock`). |
| T-158 | A reconcile card edited mid-tick is pushed when its 10 s quiet window closes, not immediately. |
| T-098 | A Heimdall answer with a null, oversized or oddly-formed payment id is treated as unreadable (row stays a pending reservation with a sync error); integer ids still accepted. |
| T-154 | `PATCH /aito/{id}` carrying `client_id`/`client_name` is refused with 422 (use transfer-client). Goldens `aito-pydantic-schemas` and `app-openapi-index` re-recorded. |

**Declined by the user (WONTFIX-AUTO):** T-108 (`_guarded_pass` refactor of `run_sync_loop`), T-103 (counter payment defers its sync to the worker), T-136 (email-recipient widening de-dup; casing change), T-172 (migrate 7 dialogs to `AitoDialogShell`; backdrop-while-busy change), T-120 (per-user rate limit on Zoho-proxy GETs), T-161 (unify Zoho error mappers; status/message change), T-114 (delete `AitoFxDemoPage`).

## What each survey round found

- **Round 1 (2026-10-01):** 22 filed (tests 7, security 2, robustness 5, cleanliness 8) + 12 triaged (8 new + 4 carried from campaign 21). 8 needed approval.
- **Round 2 (2026-10-01):** 19 filed (tests 5, security 2, robustness 5, cleanliness 7) + 14 triaged. 5 more needed approval. Leads from round-1 work (change-poll memo, terminal sweep ordering, duplicated Zoho ladders) surfaced here.
- **Round 3 (2026-10-03):** 14 filed (tests 3, security 1, robustness 4, cleanliness 6) + 14 triaged. 7 more needed approval. The security auditor confirmed none of the 10 refactor iterations dropped an authorization check or widened Zoho access.

## Findings by auditor (`plan.py stats`)

| Auditor | Filed | DONE | BLOCKED | WONTFIX-AUTO |
|---|---|---|---|---|
| audit-security | 5 | 4 | 0 | 1 (T-120) |
| audit-robustness | 14 | 13 | 0 | 1 (T-103) |
| audit-cleanliness | 21 | 16 | 0 | 5 (T-108, T-114, T-136, T-161, T-172) |
| audit-tests | 15 | 15 | 0 | 0 |

**Triaged this campaign, by source auditor** (from TRIAGE.md, 40 entries; 4 of them — T-066, T-072, T-076, T-081 — were carried over from campaign 21 and keep their original round): cleanliness 29, tests 7, robustness 2, security 2. TRIAGE.md holds every one with full evidence; promote one with `python tools/plan.py promote <id> --iteration N` (the `--iteration` flag is required).

## Verifier verdicts

| Iteration | Tasks | Verdict | Backend → | Frontend → |
|---|---|---|---|---|
| 1 | T-085, T-086, T-088 | PASS | 97.94% | 93.37% |
| 2 | T-087, T-089, T-090 | PASS | 98.20% | 93.37% |
| 3 | T-091, T-099, T-104 | PASS | 98.35% | 93.63% |
| 4 | T-106, T-110, T-109 | PASS | 98.40% | 93.63% |
| 5 | T-111, T-112 | PASS | 98.41% | 93.64% |
| 6 | T-115, T-116, T-117 | PASS | 98.50% | 93.64% |
| 7 | T-118, T-119, T-122 | PASS | 98.61% | 93.64% |
| 8 run 1 | T-124, T-132, T-128 | **FAIL** — T-124 changed the tick's failure behavior without approval; reverted, T-124 BLOCKED for approval | 98.69% | 93.66% |
| 8 run 2 | T-132, T-128 (T-124 reverted) | PASS | 98.69% | 93.66% |
| 9 | T-135, T-137, T-133 | PASS | 98.78% | 93.66% |
| 10 | T-138 | PASS (re-run after a lost session) | 98.79% | 93.66% |
| 11 | T-096, T-100, T-101 | PASS | 98.79% | 93.66% |
| 12 | T-102, T-123, T-121 | PASS | 98.87% | 93.66% |
| 13 | T-125, T-126, T-148 | PASS | 98.87% | 93.66% |
| 14 | T-124, T-149, T-150 | PASS | 98.87% | 93.66% |
| 15 | T-155, T-156, T-157 | PASS (T-157 re-entry reviewed for deadlock/leaks) | 98.87% | 93.66% |
| 16 run 1 | T-159, T-160, T-167 | **FAIL** — T-160 edited a route docstring, which FastAPI publishes as the OpenAPI description (`aito-openapi` golden) | 99.05% | 93.66% |
| 16 run 2 | + docstring restored byte-for-byte | PASS (AST compare of 863 route docstrings/signatures) | 99.05% | 93.66% |
| 17 | T-173, T-098, T-154 | PASS | 99.05% | 93.66% |
| 18 | T-158 | PASS | 99.05% | 93.66% |

## Follow-up leads (noticed by workers/verifiers, not fixed — outside what was approved)

1. **Books reassignment leaves a dead link in the estimate notes** (T-096): `_follow_customer` rotates the token but queues no push, so Books' notes show the old link until the next line push.
2. **Invoice billing window** (T-100): an edit landing during the three Books plan reads after the lock re-check can still be billed.
3. **Module-level asyncio locks** (`_invoice_lock`, `_reserve_lock`, `_start_lock`) bind to the first event loop that waits on them — harmless in production, fragile in tests.
4. **Invoice sweep ignores `_throttled_until`** between projects (T-102): a 429 inside a served push arms the throttle, but the sweep keeps calling Books until its own 429 or the ceiling.
5. **Terminal age-out race before `_in_flight`** (T-123): a replay that read the row but has not yet registered in `_in_flight` can still be claimed; the listing also lacks `settled_at IS NULL`.
6. **Staff status changes attributed to the client** (T-121): "Devis marqué comme accepté/refusé" by staff is `system` and still recorded with `actor_class` client.
7. **Wake-drain handler wipes re-armed windows** (T-125/T-156): `run_sync_loop`'s outer `drop_due_except(now, set())` still deletes windows `run_sync_once`'s `finally` re-armed, if an error escapes `run_sync_once`.
8. **`transfer_tasks` has the same check-then-act shape** T-126 fixed for merge (target read as active, then tasks moved).
9. **Quote-email dialog has no specific copy for the new 409** (T-155); it falls back to its generic error.
10. **Frontend `AitoProjectUpdate` TS interface** still declares `client_id`/`client_name` (T-154) — harmless, but a future caller could send a key the server now refuses.
11. **SURFACE generator keeps only the first line of wrapped signatures**, so it is blind to parameter changes on them (`tools/gen_surface_aito23.sh`).
12. **Payment-link nested pass** (T-157) can create/patch links mid outer-pass; the outer pass then finds nothing to do (idempotent, harmless).
13. **`HeimdallAmbiguous` docstring** lists only missing `id`/`amount` as unreadable; malformed ids are now too (T-098).
14. **c21 T-084** (`_recheck_aito_read` only on inbound ws messages) was never asked this campaign — it sits in campaign 21's archived plan.
15. **Test-suite load sensitivity:** under heavy machine load (load average 25–75) whole vitest files time out at worker start; known_flaky grew this campaign (NotificationBell row-click, AitoPageMobile 1280 px). Consider `--maxWorkers` in `test_frontend.sh` for loaded machines.

## Process lessons

- An "isolate this pass's failure so the others still run" fix is a behavior change (iteration 8 FAIL). Pre-screen such findings as approval questions before dispatch.
- Route docstrings are observable through OpenAPI (iteration 16 FAIL); zero-behavior tasks must not touch them.
- `check-stuck` counted a pre-approval attempt and auto-closed approved T-124; re-arming it needed a BLOCKED → OPEN move (the only transition that resets `first_seen_iteration`).
- Verifier blindness: verifiers are told explicitly never to read PLAN/TRIAGE/BASELINE/VERDICTS/findings files (a campaign-23 verifier read PLAN.md once in iteration 3).

## Tasks completed (48)

- T-085 [P1] _drain_reconcile_queue: throttle-hold break and rate-limited requeue are never exercised
- T-086 [P1] invoice sweep deposit-apply: re-read failure fallback and ZohoRateLimited re-raise untested
- T-088 [P1] cancel_link: 'money wins over the cancel' branch where the row was already paid is untested
- T-087 [P2] hourly inbox sweep SQLAlchemyError branch (rollback and return) untested; only a monkeypatched stand-in exists
- T-089 [P2] terminal payment abandoned-reservation sweep: per-row failure isolation untested
- T-090 [P2] retainer PDF / email routes: Zoho failure branches and the send-succeeded-but-event-not-recorded path untested
- T-091 [P2] invoice email / invoice create: trailing-rollback guards and the 'invoice not listed under estimate' warning untested
- T-096 [P2] transfer_client keeps the card's public tracking token, so the previous client's /t/ link keeps showing the new client's job
- T-099 [P2] poll_changes() records rows in _seen before the watermark commit and the caller's enqueue, so a failure loses the changes
- T-100 [P2] create_invoice() re-reads the card under _invoice_lock but never re-checks quote_sync_state, so it can bill pre-edit lines
- T-101 [P2] markAllRead()/markRead() cancel an in-flight arrival refetch and never refetch, and read-all marks rows the user never saw
- T-102 [P2] sweep_invoices() loop neither serves due pushes nor respects BACKGROUND_CALL_CEILING
- T-104 [P2] Five Aito dialogs copy the same modal scaffolding (backdrop, Escape trap, header, footer)
- T-106 [P2] The 'capture was_pending, _mark_pending_if_ours, record sync.queued on transition' idiom is pasted into nine route bodies
- T-109 [P2] run_sync_once's default full-sweep selection (_sweep_predicate) is no longer used by any production caller
- T-110 [P2] _drain_reconcile_queue re-implements run_sync_once's per-card loop body (old and new reconcile paths)
- T-111 [P2] sync_project() is a ~580-line function (lines 1554-2132)
- T-112 [P2] ProjectDetailPanel() is a single ~840-line component (861-1698) holding all menu-modal state plus description, client, tracking and watch logic
- T-115 [P2] broadcast_pending: a failing ws push is swallowed and the remaining recipients still get their nudge
- T-116 [P2] purge_old: the RETENTION_DAYS cutoff is only tested at 31 days versus a fresh row
- T-117 [P2] payment-link reservation age-out and reconcile pass: per-row SQLAlchemyError isolation untested
- T-118 [P2] contact poll: aito_changed broadcast failure and rollback-failure inside the poison-contact path untested
- T-119 [P2] manual payment recording: rollback failure after a Books-side payment and refresh_after_payment's project-gone and poisoned-session paths untested
- T-121 [P2] map_comment promotes free-text Books comments to client quote.accepted/declined/viewed events by keyword, ignoring comment_type, which fans out forged inbox notifications
- T-122 [P2] _age_out_abandoned_reservations() and the 404 branch of _refresh_terminal_payment() commit status 'failed' before recording payment.terminal.failed
- T-123 [P2] _age_out_abandoned_reservations() writes off a reservation whose replay start_terminal_payment is currently POSTing
- T-124 [P2] run_sync_loop tick calls run_sync_once(attention_only=True) outside its own try, so an escaping error skips every later pass
- T-125 [P2] run_sync_once() takes every due push window up front, so an exception mid-loop strands the rest pending with no wake and their flush waiters unresolved
- T-126 [P2] merge_project() trashes the source with an unconditional write after a check-then-act active check, so concurrent merges duplicate tasks or trash both cards
- T-128 [P2] Search box + radiogroup candidate wrapper is copy-pasted between TaskTransferModal and MergeProjectModal
- T-132 [P2] The Zoho-error to HTTPException mapping (409 not configured / 404 / 409 rejected / 502 upstream) is retyped in eleven except-ladders across routes/zoho.py and routes/aito.py
- T-133 [P2] edit_project_client() is a ~230-line route doing validation, version claim, Books write, re-read, social/person diffing and sibling fan-out
- T-135 [P2] The three document-PDF routes (quote.pdf, invoice.pdf, retainer.pdf) repeat the same load/guard/fetch/Content-Disposition body
- T-137 [P2] get_estimate_pdf / get_invoice_pdf / get_retainer_invoice_pdf are three copies of one fetch-and-verify-PDF body; email-content and email-send methods are likewise tripled
- T-138 [P2] Client contact fields and their email/phone validators are redeclared in AitoProjectCreate, AitoProjectUpdate, AitoClientTransfer and AitoClientEdit
- T-148 [P2] NotificationBell hidden-state tests prove a negative after a fixed 50 ms sleep
- T-149 [P2] AitoTrackEntryPage stale-answer race tests use a 50 ms sleep to prove the stale response was ignored
- T-150 [P2] AppRouterAitoGuard tests: load-sensitive 1 s findByText, and the redirect test asserts absence immediately
- T-155 [P2] send_quote_email() emails a quote whose card still has unpushed edits when no sync worker is serving
- T-156 [P2] run_sync_loop wake lap drops every due push window when run_change_pass raises
- T-157 [P2] _run_pass() poll half runs up to MAX_POLLS_PER_TICK Heimdall calls without serving due pushes, so flush_and_wait times out
- T-159 [P2] 'live project or 404' prologue is inlined in seven routes next to _get_active_project_or_404 and _load_project_with_quote_or_404
- T-160 [P2] send_retainer_email and send_invoice_email repeat one ~90-line send skeleton, including nine copies of the swallow-a-failed-rollback idiom
- T-167 [P2] ZohoService.get_retainer_invoice() is unreferenced
- T-173 [P2] The error-line plus Cancel/confirm-with-spinner footer is copy-pasted across MergeProjectModal, TaskTransferModal, TransferClientModal and WatchModal
- T-098 [P3] _to_view stores the Heimdall payment id unvalidated (follow-up to c21 T-026, which added only URL quoting)
- T-154 [P3] update_project accepts client_id/client_name, bypassing transfer_client's invoiced-card guard and client-push flag
- T-158 [P3] run_sync_once() pushes a card that turned pending after selection, inside its edit quiet window

## Triage list (40 findings, full evidence in TRIAGE.md)

| Id | Pri | Source | Round | File | Title |
|---|---|---|---|---|---|
| T-066 | P3 | audit-cleanliness | r1 | backend/app/services/aito_quote_sync.py | _write_back_rounded_costs()'s project_id parameter is unused |
| T-072 | P3 | audit-security | r2 | backend/app/services/zoho.py | zoho _seg leaves bare '.'/'..' ids unescaped, so httpx collapses them as dot segments in Books request paths |
| T-076 | P3 | audit-cleanliness | r2 | backend/app/services/aito_payment_links.py | `return isinstance(exc, HeimdallUnreachable)` "stand down the pass" idiom is repeated at 5 call sites across two files |
| T-081 | P3 | audit-robustness | r2 | backend/app/models/aito_project.py | _bump_version_on_content_change() derives the new version from the loaded value, so overlapping writers land on the same number |
| T-092 | P3 | audit-tests | r1 | backend/app/services/aito_quote_sync.py | mid-tick wake drain: exception and CancelledError handling untested; contact-poll 429 arming untested |
| T-093 | P3 | audit-tests | r1 | backend/app/api/routes/aito.py | test_ensure_pushed_returns_at_once / test_strict_ensure_pushed_leaves_a_card_alone assert only that a monkeypatched stub was not called |
| T-094 | P3 | audit-tests | r1 | backend/app/models/aito_event.py | test_many_events_may_have_no_zoho_comment_id and test_release_miss_tolerates_a_key_with_nothing_reserved have no assertions |
| T-095 | P3 | audit-tests | r1 | frontend/src/components/aito/celebration/render.ts | celebration renderer (glowSprite, drawGlow, ribbon pass) at 2.4% statements; the engine test never touches a canvas |
| T-097 | P3 | audit-security | r1 | frontend/package-lock.json | dompurify 3.4.13 locked inside the GHSA-p98j-92pf-mc4p range (used by aito/ZohoEmailPreview.tsx) |
| T-105 | P3 | audit-cleanliness | r1 | frontend/src/components/aito/MergeProjectModal.tsx | MODAL_OUT_MS = 170 is redeclared in eight Aito dialogs |
| T-107 | P3 | audit-cleanliness | r1 | backend/app/api/routes/aito.py | 'Next task position' (select max + 1 else 0) is inlined in add_task, transfer_tasks and merge_project |
| T-113 | P3 | audit-cleanliness | r1 | backend/app/api/routes/inbox.py | The 'aito:read' permission string is declared twice instead of using Permission.AITO_READ |
| T-127 | P3 | audit-robustness | r2 | backend/app/services/aito_quote_sync.py | _sync_reconcile() reads project.client_push_pending after _pull_comments() may have rolled the session back, and the MissingGreenlet strands an escalated card in 'error' |
| T-129 | P3 | audit-cleanliness | r2 | backend/app/services/aito_quote_sync.py | Rate-limit hold predicate `_throttled_until is not None and time.monotonic() < _throttled_until` is inlined at four sites |
| T-130 | P3 | audit-cleanliness | r2 | backend/app/services/aito_quote_sync.py | credit_cache / retainer_cache pair is built in run_sync_once and _drain_reconcile_queue and threaded through as two loose arguments |
| T-131 | P3 | audit-cleanliness | r2 | backend/app/api/routes/aito.py | update_task tests the same `project` twice back to back (`is not None`, then truthiness) |
| T-134 | P3 | audit-cleanliness | r2 | backend/app/services/aito_payment_links.py | _run_pass() (94 statements, complexity 25) and reconcile_project() (75 statements, complexity 25) are the next oversized units after sync_project |
| T-139 | P3 | audit-cleanliness | r2 | backend/app/schemas/aito.py | AitoInvoiceCreatedResponse claims to extend AitoInvoiceResponse but re-declares every field; email-content models repeat subject/body/recipients/default_email |
| T-140 | P3 | audit-cleanliness | r2 | frontend/src/utils/clientDraft.ts | The 'mobile first, else phone, else mobile' phone-field rule is spelled out four times |
| T-141 | P3 | audit-cleanliness | r2 | frontend/src/components/aito/ClientEditor.tsx | The two ContactPersonPicker mounts in ClientEditor are identical apart from their position |
| T-142 | P3 | audit-cleanliness | r2 | frontend/src/components/aito/NewProjectDrawer.tsx | 'Request a summary if the task signature changed' is written twice, and the blurred-reveal literals twice |
| T-143 | P3 | audit-cleanliness | r2 | frontend/src/components/aito/TaskStepFields.tsx | Impression's unit/line-total/unit-rate arithmetic re-implements renderPlainService's block |
| T-144 | P3 | audit-cleanliness | r2 | frontend/src/components/aito/TaskStepFields.tsx | Orphaned doc comment: StepBlock's description sits above UNFOLD_CLS, leaving two stacked JSDoc blocks |
| T-145 | P3 | audit-cleanliness | r2 | frontend/src/components/aito/WatchModal.tsx | Selectable-row class ternary and the 'NOTIFICATION_KINDS[kind] ?? UNKNOWN_KIND' fallback are pasted across components |
| T-146 | P3 | audit-cleanliness | r2 | frontend/src/pages/AitoPage.tsx | In-production count badge + PrintBacklogBadge JSX is duplicated between boardCaption and the desktop header; cubic-bezier easing literal repeated across eight Aito files |
| T-147 | P3 | audit-cleanliness | r2 | frontend/src/pages/AitoPage.tsx | Stale and misplaced comments and a mid-imports const in AitoPage |
| T-151 | P3 | audit-tests | r3 | frontend/src/components/aito/AitoDialogShell.tsx | AitoDialogShell test pins exact Tailwind class strings instead of behavior |
| T-152 | P3 | audit-tests | r3 | frontend/src/utils/inboxTarget.ts | inboxTarget: unknown target_type, printer-family fallback and unknown-family default are untested |
| T-153 | P3 | audit-tests | r3 | backend/app/services/aito_quote_sync.py | quote_validity_days / poll-seconds settings: non-numeric fallback and _paid_retainer_total bad-total skip untested |
| T-162 | P3 | audit-cleanliness | r3 | backend/app/api/routes/aito.py | transfer_tasks re-spells the invoiced-target 409 that _reject_task_change_if_invoiced already raises |
| T-163 | P3 | audit-cleanliness | r3 | backend/app/api/routes/aito.py | The client column list is written out four times: create_project, update_project, transfer_client and the split-card constructor in transfer_tasks |
| T-164 | P3 | audit-cleanliness | r3 | backend/app/api/routes/aito.py | create_invoice() is oversized: five sequential phases in one 200-line route (ruff C901 17, PLR0915 65 statements) |
| T-165 | P3 | audit-cleanliness | r3 | backend/app/api/routes/aito.py | _CONTROL_CHARS_RE comment and the PDF-route docstrings still name get_quote_pdf as the home of logic that moved into _pdf_response and _load_project_with_quote_or_404 |
| T-166 | P3 | audit-cleanliness | r3 | backend/app/services/zoho.py | Zoho docstrings still describe get_estimate_pdf as the binary-response caller and as 'not routed through _request' |
| T-168 | P3 | audit-cleanliness | r3 | backend/app/services/heimdall.py | heimdall.PaymentView = LinkView alias is unused |
| T-169 | P3 | audit-cleanliness | r3 | backend/app/services/aito_client_rating.py | GOOD_MIN_SETTLED 'historical name' constant is read by nothing |
| T-170 | P3 | audit-cleanliness | r3 | frontend/src/utils/aitoBoardRules.ts | COLUMN_ORDER is exported but nothing imports or reads it |
| T-171 | P3 | audit-cleanliness | r3 | backend/app/services/aito_quote_sync.py | _write_back_rounded_costs takes a project_id it never reads |
| T-174 | P3 | audit-cleanliness | r3 | frontend/src/components/aito/useDescriptionEditor.ts | Comments in useDescriptionEditor still refer to markup 'below' that moved to ProjectDetailPanel in the extraction |
| T-175 | P3 | audit-cleanliness | r3 | backend/app/api/routes/inbox.py | The 'defaults when nothing is stored' preferences are built in two places: routes/inbox.get_preferences and services/inbox.preferences_for |

## Left for humans

- OPEN: none · BLOCKED: none
- WONTFIX-AUTO (user-declined): T-108, T-103, T-136, T-172, T-120, T-161, T-114
- TRIAGED: 40 (above)
- Follow-up leads: 15 (above)
