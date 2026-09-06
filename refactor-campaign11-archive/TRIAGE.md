# TRIAGE (schema v2)

## T-004
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: Guarded-rollback swallow block now repeated four times in aito.py (a new pickup-SMS site copied the pattern instead of sharing it)
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1567 · The identical `try:\n await db.rollback()\nexcept Exception: # noqa: BLE001 — see the comment above\n pass` block occurs at aito.py:1565-1568, 1606-1609 and 1619-1622 (all inside send_invoice_email, previously flagged as 3 sites in campaign 10's T-003, still unfixed) and now also at 2797-2800 inside the newer pickup-SMS handler (send_pickup_sms), added by the 2026-09-04/05 pickup-SMS feature. `rg -n "except Exception: # noqa: BLE001" backend/app/api/routes/aito.py` -> 4 hits, one more than campaign 10 recorded. · fix: extract a tiny local helper, e.g. `async def _rollback_quietly(db): try: await db.rollback() except Exception: pass # noqa: BLE001`, and call it from all four sites, keeping each site's own explanatory comment about *why* the swallow is needed.
fingerprint: 58a701c59a2a83b7
source: audit-cleanliness

## T-005
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: _write_back_rounded_costs()'s project_id parameter is unused
files: backend/app/services/aito_quote_sync.py
evidence: backend/app/services/aito_quote_sync.py:692 · ruff (ARG001): `Unused function argument: project_id` at backend/app/services/aito_quote_sync.py:692. `rg -n "project_id" backend/app/services/aito_quote_sync.py` restricted to lines 691-722 (the function body) shows it appears only in the signature — the loop over `pushed_costs.items()` keys every UPDATE off `task_id`/`service` alone, never `project_id`. Both call sites (lines 594 and 1138) pass `project.id` in. · fix: drop the project_id parameter from _write_back_rounded_costs and update its two call sites (aito_quote_sync.py:594, 1138) to stop passing it.
fingerprint: cb58642b4ce47799
source: audit-cleanliness

## T-014
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: user-controlled filament/printer names are logged unsanitized in the calculator CRUD routes
files: backend/app/api/routes/calculator.py
evidence: backend/app/api/routes/calculator.py:89 · logger.info("Created calculator filament: %s", filament.name) — name is derived from CalculatorFilamentCreate.brand/material, which are `Field(max_length=100)` with no character class, so a newline is accepted; the same pattern appears at calculator.py:150, :317 and :357. backend/app/core/logging_filters.py performs URL-credential redaction only and never strips newlines from records written to logs/bambuddy.log. · fix: collapse newlines/carriage returns in the name before logging it (e.g. a small helper applied at all four call sites), so a stored name cannot forge additional log lines
fingerprint: 844aa522a2be132a
source: audit-security

## T-029
priority: P3
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 7
last_touched_iteration: 7
title: loadState() spreads unvalidated JSON into CalcState, so a non-string field crashes the calculator on render
files: frontend/src/hooks/useCalculatorState.ts
evidence: frontend/src/hooks/useCalculatorState.ts:133 · `const state: CalcState = { ...DEFAULT_STATE, ...legacy };` — `legacy` is a bare cast of `JSON.parse(raw)`, with only `typeof parsed !== 'object'` checked, and the try/catch ends when loadState returns. The `errors` memo then does `const raw = state[key] as string; if (raw.trim() !== '' ...)`, and `num()` does `s.trim()` on the same values. A persisted entry of `{"weight":5}` (devtools, a hand-edited profile, any foreign writer of the un-namespaced `calculator-state` key) makes `raw.trim` undefined and throws during CalculatorPage's render, on every load, until localStorage is cleared by hand — despite loadState's own docstring promising that "hand-edited localStorage) degrades to the fallback instead of crashing". · fix: coerce per field when merging — keep the parsed value only when its `typeof` matches DEFAULT_STATE's, otherwise fall back to the default
fingerprint: 0ad6ed36399f79c7
source: audit-robustness

## T-047
priority: P3
status: TRIAGED
attempts: 0
round: 3
first_seen_iteration: 12
last_touched_iteration: 12
title: Inline comment misattributes the per-project-commit behavior to T-027 instead of T-010
files: backend/app/services/aito_invoice_sweep.py
evidence: backend/app/services/aito_invoice_sweep.py:171 · Module docstring (lines 20-22) and the function docstring (line 80, 'the 429 was already committed on its own (T-010)') both correctly credit T-010 with committing each project's refresh on its own, and T-027 only with catching a failure on that commit -- also matched by the test file's own comment at test_aito_invoice_sweep.py:293 ('T-010's per-project commit'). But the inline comment right above the code reads: '# T-027 (loop-9): commit this project's refresh on its own rather than batching the whole pass into one commit at the end.' -- attributing T-010's behavior to T-027, contradicting every other reference to the same fact in this file and its test. · fix: Reword the line-171 comment to credit T-010 for the per-project commit and keep T-027 scoped to the try/except around it, matching the module and function docstrings.
fingerprint: 0b21ad628daac054
source: audit-cleanliness

## T-048
priority: P3
status: TRIAGED
attempts: 0
round: 3
first_seen_iteration: 12
last_touched_iteration: 12
title: dueDateLevel() re-tests ISO_DATE inline instead of calling isIsoDateKey(), defined two lines above for exactly this check
files: frontend/src/utils/aitoAging.ts
evidence: frontend/src/utils/aitoAging.ts:108 · isIsoDateKey (line 100-102) is documented as 'Shared with aitoFollowups.ts's unpaid rule so the two never drift apart' and wraps `ISO_DATE.test(value)`. aitoFollowups.ts does call it (import at line 8, use at line 62). But dueDateLevel(), defined in the same file five lines later, writes `if (!dueDate || !ISO_DATE.test(dueDate)) return 'none';` directly instead of `!isIsoDateKey(dueDate)` -- the one call site in the file that defines the wrapper doesn't use it. · fix: Change dueDateLevel()'s guard to `!isIsoDateKey(dueDate)` for consistency; ISO_DATE itself should stay module-private (isIsoDateKey is still the only cross-file consumer).
fingerprint: a30f67372a06cde2
source: audit-cleanliness

