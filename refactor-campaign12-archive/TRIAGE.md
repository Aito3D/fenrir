# TRIAGE (schema v2)

## T-005
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: get_invoice_pdf() and get_quote_pdf() return client financial PDFs with no Cache-Control
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1549 · backend/app/api/routes/aito.py:1549 `return Response(content=pdf, media_type="application/pdf", headers={"Content-Disposition": build_content_disposition(filename, disposition="inline")})` — and the identical shape at line 1848 for the quote PDF. Neither sets `Cache-Control`, so these 200 GET responses containing a named client's invoice/quote are heuristically cacheable; get_tracking() in the same module sets `response.headers["Cache-Control"] = "no-store"` for exactly this reason. · fix: add "Cache-Control": "no-store" to the headers dict of both Response constructions
fingerprint: 984d3e574b47f14c
source: audit-security

## T-011
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: _check_ai_rate_limit prunes timestamps but never evicts idle keys from _ai_rate_limit_calls
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1266 · `calls = _ai_rate_limit_calls.setdefault(key, []); calls[:] = [t for t in calls if now - t < _AI_RATE_LIMIT_WINDOW_S]` — the list is trimmed but the dict entry itself is never removed, and `_ai_rate_limit_key` falls back to `f"ip:{request.client.host}"` whenever `current_user is None`, i.e. on every auth-disabled install and every API-key caller. `_ai_rate_limit_calls` is module state on a process that runs for weeks, so one empty-list entry accumulates per distinct source address that has ever touched /summarize, /proofread or /pickup-message and never goes away — an install on host networking with rotating DHCP clients, or one reachable beyond the LAN, grows this monotonically with no ceiling. · fix: drop the key when the pruned list is empty (`if not calls: _ai_rate_limit_calls.pop(key, None)` before the length check), or sweep entries whose newest timestamp is older than the window
fingerprint: b7be59b58fe4ae2d
source: audit-robustness

## T-012
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: usePrintBlob's fontsReady rejection path skips the mountedRef guard its siblings have
files: frontend/src/components/aito/usePrintBlob.ts
evidence: frontend/src/components/aito/usePrintBlob.ts:209 · `fontsReady.then(() => { if (!mountedRef.current) return; ... }, () => openInTab(objectUrl, element));` — the success arm and the load-timeout timer (line 179, `if (settled || !mountedRef.current) return;`) both bail after unmount, but the rejection arm calls `openInTab` unconditionally, and `openInTab` does `window.open(url, '_blank')`. The effect cleanup at line 68 states the requirement in so many words: "closing the detail panel within IFRAME_LOAD_TIMEOUT_MS of clicking print must not later pop a stray tab for a screen the user has already left." A font in the shipping-label document failing to load (offline, or a decode error) after the operator has closed the panel does exactly that — a tab opens on a label for a card they have moved on from, plus a toast about a screen that is gone. · fix: add the same `if (!mountedRef.current) return;` bail to the rejection handler before calling openInTab
fingerprint: 4dd4b325302641dc
source: audit-robustness

## T-019
priority: P3
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 3
last_touched_iteration: 3
title: import_legacy_projects' emptiness guard is a check-then-act despite its docstring's claim
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:2406 · `"""One-time localStorage migration. Guard counts ALL rows (incl. soft-deleted) so a double-fire can never duplicate the board."""` followed by `total = await db.scalar(select(func.count(AitoProject.id)))` / `if total: raise HTTPException(status_code=409, ...)` and then a plain `db.add(p)` loop. The count and the inserts are not atomic and nothing backs them with a uniqueness constraint, so two overlapping POST /aito/import — a retried request, or the migration script run twice — both read 0 before either commits, both pass the guard, and both insert the whole payload, leaving every legacy card on the board twice. That is exactly the outcome the docstring states cannot happen, and cleanup is manual row deletion. · fix: make the emptiness test atomic — insert a uniquely-constrained sentinel (or a marker settings row) as the first statement of the transaction and let the loser's IntegrityError become the 409 — instead of trusting a preceding COUNT
fingerprint: deae8573971bb10c
source: audit-robustness

## T-022
priority: P3
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 3
last_touched_iteration: 3
title: buildQuoteSummary()'s filament.name fallback (material falsy) is never exercised
files: frontend/src/utils/quoteSummary.ts
evidence: frontend/src/utils/quoteSummary.ts:19 · frontend/src/utils/quoteSummary.ts:19 `Matériau: ${filament.material || filament.name}` -- v8 branch coverage confirms only the truthy `filament.material` side is taken (verified directly: `vitest run src/__tests__/pages/CalculatorPage.test.tsx --coverage --coverage.include=src/utils/quoteSummary.ts` -> `100/75/100/100`, `Uncovered Line #s: 19`). The only caller of buildQuoteSummary in tests is CalculatorPage.test.tsx:226, which always feeds `mockFilaments[0]` with a non-empty `material`. A filament row with an empty/null `material` (plausible for a hand-entered or legacy filament profile) would silently fall through to `filament.name` untested. · fix: in frontend/src/__tests__/pages/CalculatorPage.test.tsx (or a new frontend/src/__tests__/utils/quoteSummary.test.ts calling buildQuoteSummary directly), add a case with a filament whose `material` is '' or undefined and assert the copied summary text falls back to `filament.name`.
fingerprint: f4372437a5160f9d
source: audit-tests

