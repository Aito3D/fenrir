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

## T-025
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: get_current_user_info() re-imports jwt/PyJWTError instead of the module-level aliases
files: backend/app/api/routes/auth.py
evidence: backend/app/api/routes/auth.py:675 · backend/app/api/routes/auth.py:7 `import jwt as _jwt` and :10 `from jwt.exceptions import PyJWTError` are already module-level imports (and are what routes/mfa.py and the rest of auth.py, e.g. logout() at line 764/779, use). GET /me's handler (get_current_user_info, line 662) instead does its own `import jwt` and `from jwt.exceptions import PyJWTError as JWTError` at lines 675-676 and uses those local names for the rest of the function (jwt.decode, except JWTError). rg -n '^import jwt|PyJWTError' backend/app/api/routes/auth.py confirms both the module-level and the function-local imports exist side by side. · fix: drop the two local imports in get_current_user_info and use the existing module-level `_jwt`/`PyJWTError` names, matching logout() and the rest of the file
fingerprint: a91fb9c2b608e379
source: audit-cleanliness

## T-026
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: login()'s LDAP-fallback warning bypasses the module's own _logger
files: backend/app/api/routes/auth.py
evidence: backend/app/api/routes/auth.py:519 · backend/app/api/routes/auth.py:74 defines `_logger = logging.getLogger(__name__)`, used consistently by logout(), forgot_password(), forgot_password_confirm() and reset_user_password() (all in scope) via `_logger.info/.error(...)`. Inside login() (POST /login, in scope), the LDAP-authentication except-block instead does a fresh `import logging` followed by `logging.getLogger(__name__).warning(...)` (lines 518-521) rather than reusing `_logger`. · fix: replace the local `import logging; logging.getLogger(__name__).warning(...)` with `_logger.warning(...)`, dropping the redundant local import
fingerprint: 80689e65ebbdae51
source: audit-cleanliness

## T-031
priority: P3
status: TRIAGED
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: The three 2FA method-selector buttons (totp/email/backup) are copy-pasted markup
files: frontend/src/pages/LoginPage.tsx
evidence: frontend/src/pages/LoginPage.tsx:583 · LoginPage.tsx lines 583-625: three `<button onClick={() => handleMethodChange(...)}>` blocks (totp/email/backup) share the identical className template (`flex-1 flex flex-col items-center gap-1 py-2 px-3 rounded-lg border text-xs font-medium transition-colors ${twoFAMethod === X ? 'border-bambu-green bg-bambu-green/10 text-bambu-green' : 'border-bambu-dark-tertiary text-bambu-gray hover:border-bambu-green/50'}`) and structure, differing only in the method id, icon and label — the same shape the file already extracted for OIDC provider buttons via the local `OIDCProviderButton` component (lines 78-110). · fix: extract a small local `TwoFAMethodButton({ method, icon, label, active, onClick })` component, mirroring the existing `OIDCProviderButton` pattern in this same file
fingerprint: 1d40d97dc5664d14
source: audit-cleanliness

## T-053
priority: P3
status: TRIAGED
attempts: 0
round: 2
first_seen_iteration: 6
last_touched_iteration: 6
title: oidc_callback() logs the attacker-controlled `error` query parameter with %s
files: backend/app/api/routes/mfa.py
evidence: backend/app/api/routes/mfa.py:1843 · logger.warning("OIDC callback received error: %s", error) # `error: str | None = Query(default=None, max_length=256)` on a route in PUBLIC_API_ROUTES · fix: log it as %r, matching the convention the rest of this module already uses for untrusted claim values (e.g. "…for sub=%r"), so newlines and control characters are escaped rather than forging log lines
fingerprint: 07686551520410cd
source: audit-security

## T-064
priority: P3
status: TRIAGED
attempts: 0
round: 3
first_seen_iteration: 11
last_touched_iteration: 11
title: The reduced-motion window.matchMedia mock object is copy-pasted three times in this round's new tests
files: frontend/src/__tests__/pages/LoginPage.test.tsx
evidence: frontend/src/__tests__/pages/LoginPage.test.tsx:98 · rg -n 'addListener: \(\) => \{\}' frontend/src/__tests__/pages/LoginPage.test.tsx -> lines 103, 423, 995: the identical 13-line `window.matchMedia = ((query) => ({matches: true, ...})) as typeof window.matchMedia` block appears in the 'login flow' describe's beforeEach (T-055), the T-062 'navigates exactly once...' test, and the T-037 'post-login redirect sanitization' describe's beforeEach — all added/touched by this campaign round. · fix: extract a shared `mockReducedMotion()` / `withReducedMotion()` test helper (module-level, or in the shared test-utils file) and call it from the three sites instead of re-declaring the mock object
fingerprint: 811507055c53bb15
source: audit-cleanliness

## T-065
priority: P3
status: TRIAGED
attempts: 0
round: 3
first_seen_iteration: 11
last_touched_iteration: 11
title: Email-OTP-enable DB-injection dance is duplicated between TestTwoFAVerifyPreconditions._enable_email_otp and TestEmailOTPSendCookieRefresh._enable_email_otp_and_login
files: backend/tests/integration/test_mfa_api.py
evidence: backend/tests/integration/test_mfa_api.py:540 · backend/tests/integration/test_mfa_api.py:540 (`_enable_email_otp`) and :1908 (`_enable_email_otp_and_login`), both added this round, run the same sequence — set user.email, commit, stage an AuthEphemeralToken(token_type="email_otp_setup") with a hashed setup code, commit, POST /2fa/email/enable/confirm — differing only in the setup code literal and whether the caller's own token/login is folded in. · fix: factor the shared DB-injection steps into one module-level async helper (e.g. `_enable_email_otp(client, db_session, username, token, code=...)`) that both new test classes call
fingerprint: 03031ab81d5984bf
source: audit-cleanliness

## T-068
priority: P3
status: TRIAGED
attempts: 0
round: 3
first_seen_iteration: 11
last_touched_iteration: 11
title: verify_2fa() email branch uses scalar_one_or_none() on a query that can match several OTP rows
files: backend/app/api/routes/mfa.py
evidence: backend/app/api/routes/mfa.py:1274 · select(UserOTPCode).where(UserOTPCode.user_id == user.id).where(UserOTPCode.used.is_(False)).where(UserOTPCode.expires_at > now).order_by(UserOTPCode.created_at.desc()) ) otp_record = result.scalar_one_or_none() · fix: take the newest row explicitly — `.limit(1)` plus `result.scalars().first()` — so more than one live code raises no MultipleResultsFound; the existing order_by already expresses that intent
fingerprint: add8b7047c18a6dd
source: audit-security

## T-082
priority: P3
status: TRIAGED
attempts: 0
round: 3
first_seen_iteration: 11
last_touched_iteration: 11
title: hasPermission()/hasAnyPermission()/hasAllPermissions()'s admin short-circuit is never tested with auth actually enabled
files: frontend/src/contexts/AuthContext.tsx
evidence: frontend/src/contexts/AuthContext.tsx:242 · coverage: branches (242,0),(248,0),(254,0) missing in the scoped run — the `if (isAdmin) return true` True-path inside hasPermission/hasAnyPermission/hasAllPermissions is never taken. All existing hasPermission*/hasAnyPermission/hasAllPermissions assertions in frontend/src/__tests__/contexts/AuthContext.test.tsx run under the authEnabled=false describe block (where the earlier `if (!authEnabled) return true` short-circuits first); the only real-auth admin fixture (`admin short-circuit: grants modify access with no matching permission at all`, line ~652) exercises canModify, not these three functions, so the admin bypass on the plain permission checks is unverified. · fix: in frontend/src/__tests__/contexts/AuthContext.test.tsx, add a case with auth_enabled: true and is_admin: true, permissions: [] and assert hasPermission/hasAnyPermission/hasAllPermissions all return true for permissions absent from the (empty) permission list.
fingerprint: 0b215d9bcc840f88
source: audit-tests

