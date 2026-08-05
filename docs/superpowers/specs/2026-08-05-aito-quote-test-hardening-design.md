# Aito quote pipeline — test hardening design

**Date:** 2026-08-05 · **Branch:** `aito-quote-tests` (based on `aito-send-quote`)

## Goal

Make the Aito ↔ Zoho quote pipeline (generation/export, importation, sync,
shipping, all four services) bullet-proof by closing the audited coverage
gaps. We do not rewrite existing tests — ~7,900 lines already cover the pure
translators and the reconciler well. We attack what is *not* covered.

## Audit summary (what is missing today)

1. **Transport-layer failure behaviour** — the biggest hole. No test raises a
   real `httpx.ConnectError`/`ReadTimeout` from the transport; 429 is entirely
   untested (and counts toward `SYNC_FAILURE_LIMIT`, escalating a healthy
   project to `error` after 5 ticks — behaviour we pin, not fix, in this
   branch); the double-401 path and a token-endpoint failure mid-business-call
   are unreached; non-JSON bodies are only tested for the token endpoint and
   `search_contacts`.
2. **No route → worker → wire end-to-end.** Nothing proves a project created
   through `POST /api/v1/aito/` produces the exact line items Books receives.
   The chain is covered only in two disjoint halves.
3. **Malformed 200 bodies** — create returning `{}`/missing `estimate` key,
   `estimate_id: null`, `line_items` not a list.
4. **SKU/service edges** — `P3D2024` (legacy), empty/missing SKU through
   `parse_lines`, laser mixed with Aito services on one estimate, the two
   halves of `is_foreign` disagreeing (unknown `item_id` + Aito-looking SKU),
   vente (`U3DIMP-VENTE`) never round-tripped back out.
5. **Numeric edges** — discount `"10.5%"`, `>100%`, negative, `"0%"`,
   discount on non-impression lines on import; fractional quantity (1.5)
   export recompute; `impression_rate_quantity` at quantity 0;
   `price_precision` ≠ 0; multiple `line_item_taxes` entries; missing
   `line_item_taxes` key.
6. **Degenerate estimates** — `line_items: []` / key absent; shipping-only
   estimate on the *import* side; no Books-shaped `header_name` fixture (all
   header tests use inline builders); large (60-line) estimate.
7. **Shipping catalogue cache defence** — corrupt JSON settings row, non-dict
   payload, tz-aware `checked_at` `TypeError` branch: all unreached.
8. **Frontend branches** — `zoho_synced: false` toast; `ShippingCard` save
   failure toast; `ShippingFields` unresolved-catalogue warning, name
   normalisation on blur, `maxLength` mirror; chip off → `null` (not `0`) as
   a unit; `importableShipping` empty *first* name; import placeholder task
   mapping (`*_done ?? false`, null title); drawer `submitting` state;
   import → placeholder → poll sequence.

Out of scope: quote-email UI (no frontend callers exist — unimplemented
feature, flagged to the user, nothing to test); fixing the 429-escalation
behaviour (pin it; changing retry semantics is a product decision); load/perf
testing beyond the one 60-line correctness case.

## Approach

Considered: (a) HTTP-level `httpx.MockTransport` everywhere, (b) instance
monkeypatching everywhere, (c) layered — transport-level for wire/E2E/failure
tests, instance-level only where the wire shape is irrelevant. **Chosen: (c)**,
which is also the codebase's own documented convention. Class-level patches
are forbidden (instance-shadow landmine, `test_aito_quote_email.py:19`).

Test DB/app fixtures follow `backend/tests/conftest.py` exactly
(`db_session`, `async_client`, `_configure_zoho`, `zoho_handler`,
autouse resets for token cache / `_wake` / `_deferred_reasons`).

## Deliverables

### Backend — new files (names mirror existing conventions)

1. `backend/tests/unit/services/test_zoho_transport_failures.py`
   `MockTransport` handlers that raise `httpx.ConnectError`,
   `httpx.ReadTimeout`; 429 → `ZohoUpstreamError`; double-401; token refresh
   500 mid-business-call; non-JSON 200s on `create_estimate`,
   `update_estimate_lines`, `get_estimate`, `list_items`,
   `list_estimate_comments`; shipping-catalogue cache defence (corrupt JSON
   row, non-dict payload, tz-aware `checked_at`).
2. `backend/tests/unit/test_aito_quote_e2e.py`
   Route → `run_sync_once` → wire, all over one `MockTransport` with the
   `zoho_handler`/`seen` request recorder:
   - create a project via `POST /aito/` with all four services (+ vente SKU
     mapping), assert the exact `line_items` JSON Books receives — headers,
     order, rates, tax id, unit, descriptions;
   - same with shipping attached (line after tasks, no header, qty 1);
   - PATCH an edit → pending → sync → `update_estimate_lines` wire body;
   - detach shipping via `PATCH` island `null` → line dropped on the wire;
   - Zoho 429/network failure during the sweep: failures accumulate,
     escalate at 5, recover to idle after a healthy read;
   - quote-status route → wire `POST /estimates/{id}/status/...` shape
     (today only asserted through class-level spies).
3. `backend/tests/unit/test_aito_quote_import_edgecases.py`
   New Books-shaped fixtures + inline builders through
   `parse_lines`/`build_preview`:
   - `dev-2470-headers.json` — real header_name/header_id payload;
   - `dev-2471-empty.json` — `line_items: []`;
   - `dev-2472-shipping-only.json` — one shipping line, no services;
   - mixed laser + Aito services; `P3D2024`; empty/None SKU; unknown
     item_id with Aito SKU prefix; discount edge strings; multi-entry
     `line_item_taxes`; missing `line_item_taxes` key; `price_precision: 2`;
     60-line estimate grouped correctly.
4. `backend/tests/unit/test_aito_quote_export_edgecases.py`
   `is_foreign` disagreement matrix; vente export round-trip;
   `impression_rate_quantity` at qty 0 / fractional / non-dividing totals
   with discount; malformed-200 create/update bodies via the sync worker
   (`{}`, `estimate_id: null`, `line_items` not a list) — pin that the
   worker degrades to `error`/retry, never crashes or half-writes.

### Frontend — extend existing files (same mocking patterns: MSW + spyOn)

- `useQuoteStatusMutation`/`AitoQuoteStatusActions`: `zoho_synced: false`
  fires the `aito.zohoNotUpdated` toast.
- `AitoShippingCard.test.tsx`: rejected save mutation → `aito.saveFailed`
  toast; Add-path save reaches the mutation.
- `AitoShippingFields.test.tsx`: `catalogueResolved={false}` warning text;
  blur normalisation (`jean-pierre` → `Jean-Pierre`, `dupont` → `DUPONT`);
  `maxLength=100` present.
- `AitoTaskStepFields.test.tsx`: chip off emits `null` not `0`;
  `removeServiceChip` aria-label.
- `useAitoPageMutations.test.tsx`: `importableShipping` empty first name.
- `AitoPage.test.tsx`: import preview with done-flags/null-title line builds a
  sane placeholder; drawer submitting state while POST in flight;
  import → placeholder (no `quote_number`) → poll lands the quote.

## Error handling philosophy

Every new failure-path test asserts *both* halves: the user-visible outcome
(state field, HTTP code, toast) *and* the absence of collateral damage (no
half-written rows, failure counters owned by the right handler, debounced
events emitted once). Tests pin current behaviour; genuine bugs found along
the way are recorded in the final report, not silently fixed in test code.

## Success criteria

- All new tests pass under `-n 30` xdist (no new module-state leaks; every
  singleton mutation goes through the established autouse reset fixtures).
- Full `./test_frontend.sh` and `./test_backend.sh` stay green.
- No changes to production code (test-only branch), except where a test
  exposes a real bug — those are reported first.
