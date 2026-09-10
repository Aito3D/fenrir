# FINAL_REPORT.md — refactor-loop campaign 13 (tracking page + login page)

Campaign 13 · branch `auto-refactor-loop` in `/Users/paultheis/Documents/Code/bambuddy-refactor` · cut from main `e160b2da5` (UPSTREAM) on 2026-09-09 · BASE `refactor-base` = `feabef49f` (setup commit) · finished 2026-09-09.

## Campaign at a glance

| | |
|---|---|
| Scope | Client tracking pages (`/t`, `/t/:code`, legacy `/track`) and the login page, front and back end |
| Parameters | TRIAGE P3 · MAX_ITER 8 → 12 → 18 (raised at the round-2 and round-3 sweeps) · MAX_ROUNDS 3 · BATCH 3 · auto · grouped · at-exit |
| Iterations run | 17 (`loop-1` … `loop-17`), every one verified PASS by the blind verifier |
| Survey rounds | 3 of 3 (round 1 at setup, rounds 2 and 3 as resurveys) |
| Commits on the branch | 17 squashed iteration commits + 1 setup commit + this report |
| Tags | `refactor-base`, `loop-1` … `loop-17` |
| Why it ended | **MAX_ROUNDS** — round 3 was the last permitted survey round and the plan it filled was worked to exhaustion (no OPEN tasks). Not converged: none of the three rounds was dry. |

## Findings by auditor (`plan.py stats`)

| Auditor | Filed | DONE | BLOCKED | WONTFIX-AUTO | Triaged this campaign |
|---|---|---|---|---|---|
| audit-security | 7 | 7 | 0 | 0 | 2 |
| audit-robustness | 17 | 15 | 0 | 2 (T-042, T-046: duplicates folded into T-032/T-033) | 0 |
| audit-cleanliness | 7 | 6 | 0 | 1 (T-049: export drop declined) | 5 |
| audit-tests | 19 | 19 | 0 | 0 | 1 |
| survey (hand-added) | 0 | — | — | — | — |
| **Total** | **50** | **47** | **0** | **3** | **8** |

Triaged per round (from the ingest counts): round 1 — cleanliness 3; round 2 — security 1; round 3 — cleanliness 2, security 1, tests 1. TRIAGE.md holds 13 entries with full evidence: these 8 plus 5 carried from campaign 12 (its TRIAGE.md was copied in as the dedup seed). Any of them can be worked later with `plan.py promote <id> --iteration N` (the `--iteration` flag is required).

## What each round found

- **Round 1 (setup)** — 20 filed: 15 workable, 3 behavior changes held for approval (all approved: T-032 as proposed, T-033 and T-047 narrowed), 2 folded duplicates; 3 triaged. The tracking page came back nearly clean (campaign 12 had just covered it; the rate limiter was found "exceptionally well tested"). The login flow dominated: 8 coverage gaps on /login, /2fa/verify, forgot-password, the kiosk token and canModify; 3 blocking calls on the event loop; 4 duplications in auth.py/mfa.py; the logout request sent without its JWT.
- **Round 2** — 14 filed: 5 workable, 9 held (8 approved, T-052 and T-060 narrowed; T-049 declined); 1 triaged. Exposed by round 1's changes: the new limiter's reset was file-local, the LDAP bind was unbounded on the default executor, the OTP cookie never refreshed, the discovery helper accepted non-object bodies, the limiter keyed on the proxy IP behind a default install, the login page's leaked exit timer and double navigation, and a fixture gap that made the reset-token delete-on-failure path untestable.
- **Round 3** — 16 filed: 9 workable, 7 held (all approved); 4 triaged. Deeper OIDC findings: failure redirects went to a protected route that dropped the error, the OTP send held a SQLite write lock across SMTP, the discovery fetch had no overall deadline, the public providers list leaked linking policy, the exchange returned the user before 2FA, the `/t` check had no timeout, and login reported success when /me could not confirm the token; plus 8 more coverage gaps and 3 test-helper duplications.

## User-approved behavior changes (18, all in BASELINE-CHANGELOG.md)

Round 1: T-032 logout sends its JWT (server revokes it) · T-033 per-IP limiter on GET /auth/oidc/authorize (narrowed: no caching, no global cap) · T-047 `/t` entry page shows a skeleton while the locale loads (narrowed: no English fallback).
Round 2: T-057 LDAP bind bounded by a 15 s wait_for · T-050 public-HTTPS guard on discovery endpoints · T-051 forgot-password rate event for every identifier (closes an account-existence oracle) · T-052 `?token=` adopted only when no token is stored (narrowed: no kiosk marker) · T-058 OTP resend refreshes the 2fa_challenge cookie · T-059 non-object discovery body → existing failure branch · T-060 authorize cap 30 → 120/min (narrowed: no re-keying, no warning) · T-062 single post-login navigation.
Round 3: T-069 OIDC failure redirect → `/login?oidc_error=` · T-070 OTP row committed before the SMTP send · T-066 exchange drops the user record before 2FA · T-067 public providers list slimmed to id/name/has_icon (OpenAPI golden re-recorded) · T-071 discovery fetch 15 s deadline + 256 KiB cap · T-072 `/t` code check 10 s abort → existing error state · T-073 login rejects when /me cannot confirm the token.

Declined: T-049 (drop the `TRACKING_FALLBACK_LANGUAGE` export — SURFACE churn for no caller).

## Metrics

| | Baseline (BASE) | Final (`loop-17`) |
|---|---|---|
| Backend statements (whole tree, branch + greenlet) | 72% (72537 stmts, 18302 missed, 3140 partial branches) | 72% (72584 stmts, 18253 missed, 3122 partial) |
| Backend tests | 13127 passed, 0 failed | 13205 passed, 0 failed |
| Frontend lines (whole tree) | 61.49% | 61.67% |
| Frontend tests | 6037 passed (4 load flakes) | 6085 passed (2 load flakes) |
| Known-broken tests | 0 | 0 |
| Golden probes | 10/10 | 10/10 at every iteration (one sanctioned re-record: `app-openapi-index` for T-067) |
| SURFACE.md | byte-identical at every iteration | |
| Lint (ruff, eslint, tsc) | clean | clean |
| Diff since BASE | | 19 files, +5718 / −259; production +479 / −192 across 7 files; tests +4899 / −66 across 10 files |
| Scoped file movement (from workers' scoped runs) | | `_oidc_helpers.py` 56% → 100% · `mfa.py` ~73% → ~82% · `LoginPage.tsx` lines ~60% → ~78% · `AuthContext.tsx` lines ~70% → ~98% |

New load-flaky test files observed this campaign (pass alone every time): `AppRouterAitoGuard.test.tsx`, `QueuePage.test.tsx`, `SettingsPage.test.tsx`, `SlicerSettingsPanel.test.tsx` (the last two are timeouts under parallel load).

## Left for humans

- **WONTFIX-AUTO (3)**: T-042 and T-046 are duplicates of T-032/T-033 (both DONE); T-049 was declined by the user.
- **Verifier residues (not FAILs, no survey round left to file them)**: (1) T-070's `except` in `send_email_otp` also wraps `record_email_otp_send`, so a DB error there would hit the new mark-used UPDATE/commit before the intended 500 — narrow the try to the send or make the cleanup best-effort; (2) after a successful send, the raced/expired pre-auth-token 401 leaves the new OTP row committed (caller is 401'd either way); (3) T-057's `wait_for` returns the request but cannot kill the worker thread — a dedicated bounded executor for LDAP is the fuller fix.
- **Test-infra gap surfaced by T-045/T-054**: conftest's `async_client` now patches `backend.app.api.routes.auth.async_session`; any other module that binds `async_session` at import time and opens its own session in a background task would still hit the real engine under test.
- **Leftover on main from the merge composition**: `refactor-campaign12-archive/` seeded this campaign's dedup; this campaign's state files should get the same archive treatment at merge time (see the merge instruction).
- **TRIAGE.md (13 entries, verbatim below)** — the P3 findings not worked.

## Merge / cleanup

Review branch `auto-refactor-loop` in `/Users/paultheis/Documents/Code/bambuddy-refactor` (based on UPSTREAM `e160b2da5`; if main has moved, merge or rebase accordingly — the branch touches `routes/mfa.py`, `routes/auth.py`, `AuthContext.tsx`, `LoginPage.tsx`, the OpenAPI golden and `BASELINE-CHANGELOG.md`). Merge with `git merge auto-refactor-loop` in the main checkout; run `npm run build` there afterwards to refresh the tracked `static/` bundle. Clean up with `git worktree remove --force /Users/paultheis/Documents/Code/bambuddy-refactor` — `--force` is required because PLAN.md, TRIAGE.md, BASELINE.md, VERDICTS.log and the findings JSON are untracked, and removing the worktree discards every untracked file for good; copy them out first (`cp WORKDIR/{PLAN.md,TRIAGE.md,BASELINE.md,VERDICTS.log,findings-audit-*.json} <archive>`).

---

## Appendix — TRIAGE.md verbatim

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

