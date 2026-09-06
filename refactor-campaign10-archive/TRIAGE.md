# TRIAGE (schema v2)

## T-001
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: get_invoice_pdf() builds Content-Disposition from an unsanitised Zoho invoice number
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1300 · backend/app/api/routes/aito.py:1300 ` filename = f"{invoice['number'] or invoice['id']}.pdf"` is passed straight to `build_content_disposition(filename, disposition="inline")` on line 1308, with no control-character strip. The sibling route does strip: backend/app/api/routes/aito.py:1596-1597 ` filename = f"{project.quote_number or project.quote_id}.pdf"` / ` filename = _CONTROL_CHARS_RE.sub("", filename)`. backend/app/utils/http.py:52-53 shows the helper only removes non-ASCII, `"` and `\` from the legacy parameter — `ascii_fallback = filename.encode("ascii", "ignore").decode("ascii").strip(" ._-") or "download"` — so ASCII C0 controls (CR, LF, TAB, ESC, DEL) in Books' `invoice_number` survive into the raw `filename="..."` header value. The module comment at aito.py:101-110 states the consequence for exactly this class of value: "A handful of them (CR, LF, and a few other C0 controls) make h11 refuse to send the response at all". · fix: In get_invoice_pdf, apply the same strip the quote route already uses before building the header: `filename = _CONTROL_CHARS_RE.sub("", filename)` immediately after line 1300 (or route the name through backend/app/utils/http.safe_download_filename, which does the same replacement). No new regex is needed — _CONTROL_CHARS_RE is already defined at aito.py:111 in the same module.
fingerprint: bfa739503f078e7d
source: audit-security

## T-003
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: Guarded-rollback swallow block repeated three times inside send_invoice_email
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1504 · The identical three-line pattern `try:\n await db.rollback()\nexcept Exception: # noqa: BLE001 — see the comment above\n pass` (or "see the comment on the rollback above") occurs verbatim at lines 1504-1507, 1545-1548 and 1558-1561, all inside the single `send_invoice_email` handler (1394-1564). `rg -n "except Exception: # noqa: BLE001" backend/app/api/routes/aito.py` -> only these three lines, all in this one function. · fix: Extract a tiny local helper, e.g. `async def _rollback_quietly(db): try: await db.rollback() except Exception: pass # noqa: BLE001`, defined once near the other `_`-prefixed helpers in this module, and call it from the three sites; keep the surrounding explanatory comments attached to the call sites since they explain *why* each swallow is needed, not what the swallow does.
fingerprint: c638929025b62e9f
source: audit-cleanliness

## T-006
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: Several one-off aito i18n keys (clearClient, deleteTitle, descriptionPlaceholder, done, markDone, markNotDone, newClientTitle, quoteImportAgain, showLess, showMore, stepPending, syncIdle, trashTitle) have no call site
files: frontend/src/i18n/locales/en.ts
evidence: frontend/src/i18n/locales/en.ts:108 · For each of `clearClient` (108), `deleteTitle` (14), `descriptionPlaceholder` (7), `done` (192), `markDone` (194), `markNotDone` (195), `newClientTitle` (130), `quoteImportAgain` (213), `showLess`/`showMore` (~ same block), `stepPending` (193), `syncIdle` (275), `trashTitle` (59) in en.ts, `rg -n "aito\\.<key>\\b" frontend/src -g '*.ts' -g '*.tsx'` returns zero matches anywhere outside the locale files, and no dynamic `t(\`aito.${...}\`)` template-literal lookup exists in the aito components that could reach them (checked via `rg "t\\(\\\`aito\\.\\$\\{\" frontend/src`). For example `deleteTitle` ('Delete Project') predates the current hold-to-delete UX (DeleteHoldButton.tsx uses `aito.holdToDelete` instead), and `trashTitle` ('Deleted projects') is unused while the trash button itself uses the separate `aito.trash` key. · fix: Remove these orphaned keys from all 13 locale files, or wire them up if the missing UI (e.g. a trash-drawer heading, a delete confirmation title) was meant to use them.
fingerprint: ab129bb6cac3c975
source: audit-cleanliness

## T-012
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: useCalculatorState's errors memo assumes every persisted field is a string and throws on a non-string value
files: frontend/src/hooks/useCalculatorState.ts
evidence: frontend/src/hooks/useCalculatorState.ts:232 · `const raw = state[key] as string;\n if (raw.trim() !== '' && ...)` — `loadState` merges `{ ...DEFAULT_STATE, ...legacy }` straight from `JSON.parse(localStorage)` with no per-field shape check, so a stored `{"weight": null}` (a hand-edited key, a value written by an older build, or partially-corrupt storage) survives into `state.weight` and `raw.trim()` raises TypeError during render — white-screening the whole Calculator page, and repeating on every reload because the bad value is persisted. `state.quantity.trim()` two lines below has the same exposure. The sibling `num()` helper in this very file explicitly documents tolerating this case ('a partially-shaped state ... degrades to the fallback instead of crashing'); this memo is the gap. · fix: Coerce in loadState (keep the DEFAULT_STATE value for any key whose parsed type does not match) or read through a `typeof raw === 'string' ? raw : ''` guard here and at the quantity check.
fingerprint: cf4a9e49e1a2fa29
source: audit-robustness

## T-025
priority: P3
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 5
last_touched_iteration: 5
title: _parse_retry_after() accepts inf/nan/negative seconds from the Retry-After header
files: backend/app/services/zoho.py
evidence: backend/app/services/zoho.py:143 · backend/app/services/zoho.py:141-144 ` try:\n return float(value)\n except ValueError:\n pass` — the numeric branch does no finiteness or sign check, so an upstream `Retry-After: inf`, `Retry-After: nan` or `Retry-After: -1` is carried verbatim onto ZohoRateLimited.retry_after (set at :356-359 in _raise_for_status). RFC 9110 permits only a non-negative whole number of seconds; the HTTP-date branch immediately below is already floored at 0 (`max((when - datetime.now(timezone.utc)).total_seconds(), 0.0)`), so the two branches disagree on the invariant. The class docstring (:118-127) states the value is 'not currently acted on', so there is no exploit path today — but the attribute is public and the first caller to do `await asyncio.sleep(e.retry_after)` would hang the sync worker forever on `inf` and raise on `nan`. · fix: in the numeric branch, reject non-finite and negative values the same way the date branch already floors at 0 — e.g. parse to a float, then `return max(parsed, 0.0) if math.isfinite(parsed) else None`, so the header can only ever yield a finite non-negative number of seconds or None.
fingerprint: f33c89cc84fe8825
source: audit-security

## T-029
priority: P3
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 5
last_touched_iteration: 5
title: get_invoice_pdf builds Content-Disposition from an unsanitised Zoho invoice number
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1300 · `filename = f"{invoice['number'] or invoice['id']}.pdf"` goes straight into `build_content_disposition(filename, disposition="inline")`, which only strips non-ASCII and quotes (`ascii_fallback.replace('"', "").replace("\\", "")` in utils/http.py) — ASCII control characters survive into the header value. get_quote_pdf, 300 lines below, does `filename = _CONTROL_CHARS_RE.sub("", filename)` for exactly this reason and explains that the helper's non-ASCII stripping never touches them. Books invoice numbers carry an operator-configured prefix, so a stray CR/LF or control byte there makes the response header invalid (h11 rejects it) and the operator gets a failed print with nothing in the app's own logs to explain it. · fix: apply the same `_CONTROL_CHARS_RE.sub("", filename)` used by get_quote_pdf before building the header.
fingerprint: 2274336f96e03b2f
source: audit-robustness

## T-040
priority: P3
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 5
last_touched_iteration: 5
title: _parse_retry_after's malformed-value and naive-HTTP-date branches are untested
files: backend/app/services/zoho.py
evidence: backend/app/services/zoho.py:133 · coverage: backend/app/services/zoho.py 148-149, 151, 153 missing. Those lines are `except (TypeError, ValueError): return None` (a Retry-After header that is neither a number nor a parseable HTTP-date), `if when is None: return None`, and `when = when.replace(tzinfo=timezone.utc)` (a naive/no-timezone HTTP-date, which the function's own docstring documents as a deliberate design choice: "naive dates treated as UTC"). The three existing tests in backend/tests/unit/services/test_zoho_service.py (test_request_429_raises_rate_limited_with_seconds_retry_after, test_request_429_parses_an_http_date_retry_after, test_request_429_without_retry_after_header_leaves_it_none) cover a numeric header, a well-formed tz-aware GMT date, and a missing header -- none covers garbage text or a naive/tz-less date string. · fix: in backend/tests/unit/services/test_zoho_service.py, add test_request_429_with_an_unparseable_retry_after_header_leaves_it_none (Retry-After: "soon" or similar garbage) and test_request_429_parses_a_naive_http_date_retry_after (an HTTP-date string with no timezone/offset, asserting it is treated as UTC per the docstring) alongside the three existing _parse_retry_after tests.
fingerprint: 7e646383a01b3ea0
source: audit-tests

