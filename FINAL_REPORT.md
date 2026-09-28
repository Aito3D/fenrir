# Refactor loop — campaign 21 final report (whole Aito feature, seeded by campaign 20's leftovers)

Campaign 21 · 2026-09-26 → 2026-09-27 · branch `auto-refactor-loop` · BASE `refactor-base` = 4a9fc782c · UPSTREAM 636305d9c

## Why the loop ended

**Stopped on user request** after iteration 15 (`loop-15` = fc432b0b2), during the round-3 (final) survey.
Round 3's security auditor had finished (1 finding, T-084, left BLOCKED for approval); the robustness,
cleanliness and tests auditors were stopped before reporting, so round 3 is **incomplete**.
Not converged, not MAX_ROUNDS, not MAX_ITER (15 of 18 iterations used).

## Numbers

| | |
|---|---|
| Iterations run | 15 (each squashed to one commit + tagged `loop-1` … `loop-15`) |
| Survey rounds | 3 started (round 1 and 2 complete, round 3 partial) |
| Commits on the branch since BASE | 15 iteration commits (+ this report) |
| Diff since BASE | 67 files, +5356 / −440 |
| Tasks | 45 filed: **41 DONE**, 1 BLOCKED (T-084, awaiting approval), 3 WONTFIX (T-016 duplicate, T-062 + T-063 declined) |
| Triaged (P3, not worked) | 4 — T-066, T-072, T-076, T-081 (full evidence in the archived TRIAGE.md) |
| Behavior changes approved by the user | 28 tasks (see below) + 6 changelog addenda |
| Verifier verdicts | 15/15 PASS, 0 FAIL |

## Findings by auditor (from `plan.py stats`)

| Source | Filed | DONE | BLOCKED | WONTFIX | Triaged (campaign-wide) |
|---|---|---|---|---|---|
| audit-security | 9 | 5 | 1 (T-084) | 3 (T-016 dup of T-015 was a c20 carry-over; T-062, T-063 declined) | 1 (T-072) |
| audit-robustness | 19 (incl. c20 seeds) | 19 | 0 | 0 | 1 (T-081) |
| audit-cleanliness | 8 (incl. c20 seeds) | 8 | 0 | 0 | 2 (T-066, T-076) |
| audit-tests | 4 | 4 | 0 | 0 | 0 |
| survey (c20 leads + user requests) | 5 | 5 | 0 | 0 | — |

Seeds carried over from campaign 20: its 8 triaged P3s (T-002, T-014, T-015, T-016, T-018, T-026, T-032, T-035) and 3 unfiled
leads (T-044, T-045, T-046). User-requested tasks: T-069, T-070.

## What each survey round found

- **Round 1** (2026-09-26): 21 filed (tests 4, robustness 10, security 5, cleanliness 2) + 1 triaged. Headline: money-path
  ambiguity (a Books timeout on a manual payment could double-book), Heimdall/Books outages freezing the other passes, poll
  watermarks skipping truncated windows, payment follow-up steps lost after a commit, imports trusting the browser's quote
  figures, unbounded email sends, websocket read access checked only at connect.
- **Round 2** (2026-09-27): 10 filed (security 1, robustness 6, cleanliness 3, tests 0) + 3 triaged. Headline: Books 5xx /
  Heimdall unparseable 2xx still treated as clean failures, retainer-creation timeout, contact-poll poison row, a
  **regression introduced by T-060** (a failing acceptance blocked the whole payment-link poll — fixed as T-083), deactivated
  users on the websocket, and three duplication clean-ups of code this campaign added.
- **Round 3** (partial): security only — T-084 (the T-065 websocket re-check only runs when the client sends a message).

## User-approved behavior changes (full text in BASELINE-CHANGELOG.md, campaign-21 entries)

Money / payments: T-051 (+T-078 addendum) manual payment Books timeout/5xx/non-JSON → "outcome unknown, check before retrying",
guard kept · T-078 · T-079 retainer-creation timeout keeps the guard · T-058 (+addendum) Heimdall 5xx/non-JSON on a terminal
charge stays pending/replayable · T-077 unparseable 2xx likewise · T-059 terminal follow-up steps re-driven (new nullable column
`aito_terminal_payments.effects_pending_at`, additive migration) · T-082 re-drive capped with a sync_error · T-060 paid link +
event + acceptance in one transaction · T-083 a failing acceptance backs off instead of blocking the poll · T-061 imported quote
figures read from Books (+T-070 duplicate import refused before any Books call) · T-064 quote/invoice email rate limit +
duplicate guard.
Sync / polls: T-046 retainer 429 keeps the credit refresh · T-052 a Books outage no longer skips the Heimdall passes · T-054 /
T-055 Books polls read oldest-first and resume a truncated window (`sort_order` D→A) · T-069 newest-first processing order
restored within a pass (user request) · T-080 contact-poll poison cap · T-056 malformed Heimdall token recorded, Retry 200 ·
T-057 a hung Heimdall stops the pass after the first transport failure · T-053 card version never moves backwards.
Security / access: T-026 Heimdall ids escaped as one path segment · T-032 proxy-aware anonymous rate-limit keys · T-065
websocket read re-check + no-change presence skip · T-071 deactivated users get no Aito websocket data · T-044 SMS guard
un-armed after an unexpected failure.
Docs / i18n: T-045 create_contact_person description · T-068 four unused i18n keys deleted.
Declined: T-062, T-063 (contact scope — would break the new-project drawer / too intrusive for a staff tool).

## Deviations and consequences the user should know (verifier notes)

1. **T-061 delivered only its first half.** Imports now read the quote from Books, but `wanted_link` was NOT gated on a
   confirmed snapshot (the gate would cancel live links on every card left in sync error after a Books outage). Cards imported
   with forged figures *before* this change keep them until the next sweep.
2. **T-082's "visible on the panel" is not delivered for paid charges.** The capped re-drive error is stored and returned, but
   `TerminalPaymentModal.tsx` shows `sync_error` only for pending/processing and failed/cancelled/expired rows. A stale
   "Settle effects failed" error can also survive a restart (the counter is in memory).
3. **T-051** no longer writes the `payment.manual.partial` Activity event on a quote-path payment timeout (its label was the
   misleading instruction); only an ERROR log line remains.
4. **T-060** — while its acceptance keeps failing, a quote link shows `pending` instead of `paid`.
5. **Known limits documented, not fixed (user decisions):** >~2000 Books rows sharing one second stall the fixed polls;
   the T-059 re-drive waits while the Heimdall token is empty; T-080/T-082 counters reset on restart.
6. **T-078/T-058:** a non-JSON 4xx (proxy/WAF HTML page) is also treated as "outcome unknown" (user accepted).

## Operator notes (deploy-relevant)

- **Migration 257** adds `aito_terminal_payments.effects_pending_at` (nullable, no backfill) — runs on the next backend restart.
- **Books polls now send `sort_order=A`** on `list_invoices_modified_since` / `list_contacts_modified_since`. This was never
  exercised against the real Zoho Books API — watch the first poll after deploy (log lines "Invoice poll" / "Contact poll").
- **TRUSTED_PROXY_IPS** must list only proxies that append the real client to X-Forwarded-For (T-032): with a proxy that
  forwards a client-supplied header unchanged, anonymous callers could rotate their rate-limit key.
- New refusals operators may see: 409 duplicate quote/invoice email within 60 s, 429 past 10 emails/min, 502
  `manual_outcome_unknown` (three wordings), 404/502/503 on a quote import Books cannot confirm.
- New rate-limit bucket: `zoho_email` 10/min per principal.

## Gates

- Coverage (scope statements): backend 97.87% → **FINAL_BACKEND**; frontend 92.86% → **FINAL_FRONTEND**.
- known_broken: none → none. One pre-existing load-sensitive test: `AppRouterAitoGuard.test.tsx` "mounts the Aito board"
  fails under heavy machine load at BASE too (1 s `findByText` vs the lazy AitoPage chunk) — needs an idle-machine re-check.
- Snapshot probes: 34/34 matching at every iteration; sanctioned re-records confined to `heimdall-wire` (T-026, T-058,
  T-077), `aito-openapi` (T-045), `app-ddl` + `app-migrations-index` (T-059), `fe-i18n-parity` (T-068).
- SURFACE.md: +12 sanctioned lines (new exception classes, `ModifiedSinceRows`, `utc_now_naive`, `DuplicateSendGuard`,
  the four watermark helpers, the `effects_pending_at` DDL line); no removals.
- Backend tests 15609 → FINAL_BE_TESTS; frontend 7142 → 7148 tests (479 files).

## Left for humans

- **T-084 (BLOCKED, needs approval):** drive the websocket Aito read re-check from a timer / receive timeout so a silent
  socket is also re-evaluated.
- **Triaged P3s (TRIAGE.md):** T-066 unused `project_id` param in `_write_back_rounded_costs`; T-072 zoho `_seg` bare-dot
  escaping; T-076 repeated stand-down idiom; T-081 version listener bumps from the loaded value (SQL-side bump).
- **Round 3 was not completed** for robustness, cleanliness and tests — a campaign-22 panel should start there, with these
  leads: T-082 paid-row sync_error not displayed; stale sync_error after restart; AppRouterAitoGuard test wait.

## Preserved state

All loop state files (PLAN.md, PLAN.campaign20.md, TRIAGE.md, BASELINE.md, VERDICTS.log, every findings-audit-*-r*.json)
are copied to `refactor-campaign21-archive/` in the main checkout (untracked — commit it with the merge).
