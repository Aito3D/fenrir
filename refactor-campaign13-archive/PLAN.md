# PLAN (schema v2)

## T-027
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 4
title: Password-reset token issuance duplicated between forgot_password() and reset_user_password()
files: backend/app/api/routes/auth.py
evidence: backend/app/api/routes/auth.py:1126 · forgot_password() (POST /forgot-password, lines ~1126-1165) and reset_user_password() (POST /reset-password, lines ~1277-1310) both: delete any outstanding AuthEphemeralToken(PASSWORD_RESET) rows for the user, mint `reset_token = secrets.token_urlsafe(32)`, add a new AuthEphemeralToken with `expires_at=now + _RESET_TOKEN_TTL`, commit, build `reset_url = f"{login_url}#reset_token={reset_token}"` from `get_external_login_url(db)`, call `create_password_reset_link_email_from_template(db, user.username, reset_url)`, and queue `_send_reset_email_or_delete_token` with the same argument shape (only the trailing log_label string, "forgot_password" vs "admin_reset", differs). Confirmed by reading both blocks verbatim in the file. · fix: extract a private helper, e.g. `_issue_password_reset_email(db, background_tasks, user, smtp_settings, log_label)`, that both routes call — the only per-caller input is the log_label
fingerprint: 1b2640250f9af087
source: audit-cleanliness

## T-028
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 4
title: 2FA-challenge cookie/token issuance duplicated between login() and oidc_exchange()
files: backend/app/api/routes/auth.py
evidence: backend/app/api/routes/auth.py:596 · auth.py login() (POST /login, lines 596-625) and mfa.py oidc_exchange() (POST /oidc/exchange, lines 2161-2177) both: mint `challenge_id = secrets.token_urlsafe(32)`, call `create_pre_auth_token(db, user.username, challenge_id=challenge_id)`, set an identical `response.set_cookie(key="2fa_challenge", value=challenge_id, httponly=True, secure=raw_request.url.scheme=="https", samesite="lax", max_age=300, path="/api/v1/auth/2fa")`, build a `methods`/`two_fa_methods` list in the same totp->email->backup order, and return a LoginResponse with `requires_2fa=True`. Verified by reading both call sites verbatim; they are line-for-line identical apart from variable names and oidc_exchange() also setting `user=`. · fix: extract a shared helper (e.g. in mfa.py, since auth.py already imports from mfa.py lazily) `issue_2fa_challenge(db, response, raw_request, user, totp_enabled, email_enabled) -> LoginResponse` and call it from both login() and oidc_exchange()
fingerprint: a56cedd47a7fba3d
source: audit-cleanliness

## T-029
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 5
title: verify_2fa()'s backup-code branch duplicates the function's own token-issuance tail
files: backend/app/api/routes/mfa.py
evidence: backend/app/api/routes/mfa.py:1243 · mfa.py verify_2fa() (POST /2fa/verify) has two near-identical blocks that both do `consume_pre_auth_token`, `create_access_token(data={"sub": user.username}, expires_delta=timedelta(minutes=await resolve_session_max_minutes(db)))`, reload the user with `select(User).where(User.id == user.id).options(selectinload(User.groups))`, and return `TwoFAVerifyResponse(access_token=..., token_type="bearer", user=_user_to_response(user))`: once inside the `method == "backup"` branch (lines 1233-1249) and once at the function's shared tail for totp/email (lines 1254-1272). · fix: let the backup branch fall through to the shared tail instead of early-returning (or factor the shared 4 lines into a small `_issue_2fa_success(db, user)` helper used by both paths)
fingerprint: 2b48f7a5de11444f
source: audit-cleanliness

## T-030
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 5
title: OIDC discovery-document fetch duplicated between oidc_authorize() and oidc_callback()
files: backend/app/api/routes/mfa.py
evidence: backend/app/api/routes/mfa.py:1651 · oidc_authorize() (GET /oidc/authorize/{id}, lines 1651-1659) and oidc_callback()'s Step 1 (GET /oidc/callback, lines 1773-1781) both build `discovery_url = f"{provider.issuer_url.rstrip('/')}/.well-known/openid-configuration"`, then `async with httpx.AsyncClient(timeout=10) as client: resp = await client.get(discovery_url); resp.raise_for_status(); discovery = resp.json()` inside a try/except that logs `'...discovery...for provider %d: %s', provider_id, exc` and fails the request on any exception. Verified by reading both blocks verbatim. · fix: extract a small `_fetch_oidc_discovery(issuer_url: str) -> dict` (raising on failure) used by both callers, leaving each caller's own field extraction and failure-response shape (HTTPException vs RedirectResponse) as-is
fingerprint: 585f9743d4b31e7f
source: audit-cleanliness

## T-032
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 5
title: logout() clears the token before calling api.logout(), so the JWT is never revoked server-side
files: frontend/src/contexts/AuthContext.tsx
evidence: frontend/src/contexts/AuthContext.tsx:185 · const logout = () => { setAuthToken(null); setUser(null); // Clear the new-project draft (client name/email/phone) so it can't be // read back by whoever logs into this browser next (T-021). clearNewProjectDraft(); api.logout().catch(() => { — setAuthToken(null) also nulls the module-level `authToken` that api/client.ts's request() reads (`if (authToken) { headers['Authorization'] = `Bearer ${authToken}` }`), so POST /auth/logout arrives with no credentials and backend/app/api/routes/auth.py:751 takes the `if credentials is not None:` branch not at all — revoke_jti() is never called. The revocation it skips is enforced everywhere else (auth.py:709 `if not jti or await is_jti_revoked(jti, db)`, main.py:9257), so the token stays fully valid until its natural expiry, which resolve_session_max_minutes clamps only to [1h, 720h]. · fix: capture the token before clearing it and send the logout request carrying it — e.g. read getAuthToken() first and pass it to a client.ts logout(token) that sets the Authorization header explicitly, or await api.logout() before setAuthToken(null); also avoid racing the request against the immediate window.location.href = '/login' navigation (keepalive or await) · user-visible change: logging out will actually invalidate the session: a JWT captured from storage before logout (including a Remember Me token persisted in localStorage) stops working immediately instead of staying valid until expiry, and a revoked_jti row is now written on every logout.
fingerprint: a12b142454e2c387
source: audit-security
reason: user-approved behavior change

## T-033
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 6
title: oidc_authorize() is unauthenticated and unthrottled: one outbound discovery fetch plus one DB write per request
files: backend/app/api/routes/mfa.py
evidence: backend/app/api/routes/mfa.py:1637 · @router.get("/oidc/authorize/{provider_id}", response_model=OIDCAuthorizeResponse) async def oidc_authorize( provider_id: int, db: AsyncSession = Depends(get_db), ) -> OIDCAuthorizeResponse: — reachable with no credentials via main.py's PUBLIC_API_PREFIXES entry "/api/v1/auth/oidc/authorize/", and every call runs `async with httpx.AsyncClient(timeout=10) as client: resp = await client.get(discovery_url)` (line 1654, no caching) and then `db.add(AuthEphemeralToken(token=state, token_type=TokenType.OIDC_STATE, ...))` + `await db.commit()` (lines 1692-1702). There is no rate limiter on this route and no global one in main.py — unlike the public tracking route, which carries _track_rate_limited. · fix: throttle the route with the same sliding-window pattern get_tracking uses (per-IP via auth.py's _get_client_ip plus a global cap), and/or cache the discovery document per provider for a short TTL so a flood cannot be relayed 1:1 at the configured IdP · user-visible change: a client requesting authorize URLs faster than the new ceiling receives 429 instead of an auth_url, and with discovery caching an IdP that changes its authorization_endpoint is picked up only after the cache TTL rather than on the next login attempt.
fingerprint: ae447a8ac10fe61f
source: audit-security
reason: user-approved behavior change (NARROWED: per-IP rate limit only, no discovery caching)

## T-034
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: forgot_password_confirm() never exercises the expired-token rejection branch
files: backend/app/api/routes/auth.py
evidence: backend/app/api/routes/auth.py:1202 · backend/app/api/routes/auth.py 1200->1202, 1203 missing (pytest --cov-config=../pyproject.toml term-missing on tests/integration/test_auth_api.py + test_advanced_auth_api.py + test_mfa_api.py). The docstring claims 'Expired or already-used tokens are silently rejected with the same response' but `rg -n 'expires_at' backend/tests/integration/test_advanced_auth_api.py backend/tests/integration/test_mfa_api.py backend/tests/integration/test_auth_api.py` finds no test that inserts an AuthEphemeralToken with a past expires_at and confirms with it — TestForgotPasswordTokenSingleUse (test_mfa_api.py:2734) only exercises the already-consumed (row is None) branch, and TestAdvancedAuth's test_forgot_password_changes_password only exercises the still-valid token. · fix: in backend/tests/integration/test_advanced_auth_api.py (near test_forgot_password_changes_password), add a case that inserts an AuthEphemeralToken(token_type=PASSWORD_RESET) with expires_at in the past and asserts POST /api/v1/auth/forgot-password/confirm returns 400 'Invalid or expired password reset token'
fingerprint: 9d534b9fdf229a26
source: audit-tests

## T-035
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: verify_2fa()'s per-method precondition failures (no outstanding email OTP, TOTP not enabled) are untested
files: backend/app/api/routes/mfa.py
evidence: backend/app/api/routes/mfa.py:1188 · backend/app/api/routes/mfa.py term-missing: 1165-1166 (method='totp' but no enabled UserTOTP row), 1189-1190 (method='email' with no unused/unexpired UserOTPCode — 'No valid OTP code found'), 1215-1216 (method='backup' but no enabled UserTOTP row). `rg -n "No valid OTP|TOTP is not enabled" backend/tests/` returns zero matches anywhere in the repo — these three branches, each a distinct 400/401 a real client hits (OTP email expired before the user typed the code; a user picks a 2FA method they never actually set up), have no test at all. · fix: in backend/tests/integration/test_mfa_api.py (TestTwoFAVerifyTOTP / a new TestTwoFAVerifyPreconditions class), add cases: (1) POST /2fa/verify method=email with a pre_auth_token but no UserOTPCode row ever created -> 401 'No valid OTP code found'; (2) method=totp for a user with 2FA never set up -> 400 'TOTP is not enabled for this user'; (3) same for method=backup
fingerprint: 0202f7736c445ec2
source: audit-tests

## T-036
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: verify_2fa()'s anti-replay guard (consume_pre_auth_token racing to None) is never triggered by a test
files: backend/app/api/routes/mfa.py
evidence: backend/app/api/routes/mfa.py:1256 · backend/app/api/routes/mfa.py term-missing includes 1235 and 1256 — the two `if not consumed_username: raise 401` checks the code's own comment (line 1252-1253) calls out as deliberate: 'C-1: Check the return value; if None the token was already consumed by a concurrent request (race condition) — reject to prevent double-use.' `rg -n 'consume_pre_auth_token' backend/tests/` finds no test that drives this path (e.g. two concurrent /2fa/verify calls, or a pre-consumed token) for either the TOTP/email branch (1256) or the backup-code branch (1235) — the documented anti-double-use control is unverified. · fix: in backend/tests/integration/test_mfa_api.py, add a test that consumes the pre_auth_token out of band (call consume_pre_auth_token directly, or fire two concurrent POST /2fa/verify with the same pre_auth_token via asyncio.gather) and asserts the loser gets 401 'Invalid or expired pre-auth token', for both a totp/email verify and a backup-code verify
fingerprint: ba6e7495b832275f
source: audit-tests

## T-037
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: sanitizeRedirectTarget()'s open-redirect checks are never exercised by any test
files: frontend/src/pages/LoginPage.tsx
evidence: frontend/src/pages/LoginPage.tsx:40 · v8 coverage (src/pages/LoginPage.tsx, isolated per-statement dump of coverage-final.json): lines 42,43,44,45 (the `!target.startsWith('/')`, `startsWith('//')`, and `startsWith('/login')` guards inside sanitizeRedirectTarget) are 0-hit; line 41 (`if (!target) return null`) is the only branch ever taken, meaning every call in the suite passes a falsy/absent target. `rg -n 'sanitizeRedirectTarget|stashPostLoginRedirect|consumePostLoginRedirect' frontend/src/__tests__/` finds zero matches — the function's own comment says it exists to stop 'a tampered sessionStorage entry' from opening 'protocol-relative (`//evil.com`), absolute URLs, and the login page itself (would loop)', and none of those three cases is tested. · fix: in frontend/src/__tests__/pages/LoginPage.test.tsx, add cases that seed sessionStorage['auth_post_login_redirect'] with '//evil.com', 'https://evil.com', and '/login', trigger the OIDC-return or a plain mount, and assert the post-login navigation target falls back to '/' rather than the tampered value (export sanitizeRedirectTarget for direct unit testing if the component-level path is too indirect to assert on)
fingerprint: 6923a629caf4314e
source: audit-tests

## T-038
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: The credentials-login failure toast (wrong username/password) is never triggered by a test
files: frontend/src/pages/LoginPage.tsx
evidence: frontend/src/pages/LoginPage.tsx:349 · v8 coverage: LoginPage.tsx line 349 (`showToast(error.message || t('login.loginFailed'), 'error')` inside loginMutation.onError) is 0-hit. frontend/src/__tests__/pages/LoginPage.test.tsx's 'login flow' describe block has a mock server handler at line 107-110 that returns 401 'Incorrect username or password' for any credentials other than validuser/validpass, but `rg -n "401|Incorrect username" frontend/src/__tests__/pages/LoginPage.test.tsx` shows the 401 branch of that handler is wired but never actually hit — no test submits wrong credentials or asserts the error toast appears. · fix: in frontend/src/__tests__/pages/LoginPage.test.tsx 'login flow' describe block, add a test that submits mismatched credentials against the existing 401 mock handler and asserts the error toast/message renders
fingerprint: b7c3b309ad769c16
source: audit-tests

## T-039
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: The entire forgot-password / reset-password UI flow has no test
files: frontend/src/pages/LoginPage.tsx
evidence: frontend/src/pages/LoginPage.tsx:456 · v8 coverage: LoginPage.tsx lines 356-358 (forgotPasswordMutation.onSuccess), 361 (onError), 367-390 (resetPasswordMutation + sendEmailOTP wiring), 457-485 (handleForgotPassword and the reset-password step's handleResetSubmit, including the client-side password-match and length checks) are all 0-hit. `rg -in 'forgot|reset-password|resetToken|newPassword' frontend/src/__tests__/pages/LoginPage.test.tsx` and `rg -rl 'forgotPassword|ForgotPassword' frontend/src/__tests__/` return zero matches anywhere in the frontend test suite — the password-recovery flow the task explicitly names as a priority (/forgot-password*) has zero frontend coverage. · fix: in frontend/src/__tests__/pages/LoginPage.test.tsx, add a 'forgot password' describe block covering: submitting the forgot-password form (success toast + form reset), the mismatched-password and too-short-password client-side validation on the reset-password step, and a successful password-reset submission via api.forgotPasswordConfirm
fingerprint: 48d5a311cebe6c0a
source: audit-tests

## T-040
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: The kiosk ?token= URL bootstrap and its session-fixation defense are untested
files: frontend/src/contexts/AuthContext.tsx
evidence: frontend/src/contexts/AuthContext.tsx:45 · v8 coverage: AuthContext.tsx lines 45-48,51 (reading `?token=` from the URL, storing it session-only, and stripping it from the URL) and line 97 (`setAuthToken(urlToken, 'persistent')` — promoting the token to persistent storage only after the server has confirmed it valid) are 0-hit. The surrounding comment is explicit about why this matters: 'Persistence to localStorage is deferred until the token has been verified by the server (L-4: prevents session fixation where an attacker-crafted URL immediately persists a forged/stolen token).' `rg -n "[?&]token=" frontend/src/__tests__/contexts/AuthContext.test.tsx` finds no test that mounts with a `?token=` query param, so neither the session-only bootstrap nor the confirm-then-persist promotion this security comment describes is exercised. · fix: in frontend/src/__tests__/contexts/AuthContext.test.tsx, add a describe block that sets window.location.search to '?token=kiosk-abc' before mount and asserts: (1) the token is stored session-only and the URL is stripped of the param, (2) on a successful /auth/me it is promoted to persistent storage, (3) on a failed /auth/me it is never promoted
fingerprint: 636fafac36c78680
source: audit-tests

## T-041
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: canModify()'s ownership logic (*_own vs *_all permission, ownerless items) is never exercised against the real implementation
files: frontend/src/contexts/AuthContext.tsx
evidence: frontend/src/contexts/AuthContext.tsx:256 · v8 coverage: AuthContext.tsx lines 256,257,260,263,265,266,269 (the *_own/*_all permission branching and the ownerId comparison inside canModify) are 0-hit. AuthContext.test.tsx's only canModify test is 'canModify allows all modifications when auth disabled' (line 198), which only exercises the `!authEnabled` early-return at line 253. Every other consumer test mocks canModify directly instead of exercising this implementation — e.g. `canModify: vi.fn(() => true)` in frontend/src/__tests__/components/PrintModalBilling.test.tsx:31 — so the actual own-vs-all authorization decision (which gates delete/update/reprint on queue, archives and library items) has no test anywhere in the suite. · fix: in frontend/src/__tests__/contexts/AuthContext.test.tsx, add cases with auth enabled and a non-admin user holding only a `*_own` permission: assert canModify returns true when createdById matches the user's id, false when it belongs to another user, and false when createdById is null (ownerless items require *_all); add a matching case proving `*_all` returns true regardless of owner
fingerprint: f23c561c9c35c550
source: audit-tests

## T-042
priority: P1
status: WONTFIX-AUTO
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: logout() clears the auth token before calling api.logout(), so the JWT is never revoked server-side
files: frontend/src/contexts/AuthContext.tsx
evidence: frontend/src/contexts/AuthContext.tsx:185 · `const logout = () => { setAuthToken(null); setUser(null); ... api.logout().catch(() => { /* Ignore logout errors */ }); window.location.href = '/login'; }` — `setAuthToken(null)` nulls client.ts's module-level `authToken`, and `request()` only attaches `headers['Authorization'] = `Bearer ${authToken}`` when it is truthy, so the logout POST leaves with no credentials. `/api/v1/auth/logout` is not in main.py's PUBLIC_API_ROUTES, so with auth enabled the auth middleware 401s it before the handler runs and the `.catch(() => {})` swallows that; auth.py's `revoke_jti` ("revokes the current JWT so it cannot be reused after logout") therefore never executes on any real logout. The token stays valid until natural expiry — up to the 720 h session ceiling — so a copy taken from localStorage/sessionStorage, a kiosk `?token=` URL, or a proxy log still authenticates every endpoint after the user has pressed Log out. `window.location.href = '/login'` on the next line can additionally abort the request mid-flight. · fix: read the token before clearing and send it explicitly (e.g. an `api.logout(token)` that sets the header), or await api.logout() first and only then setAuthToken(null) and navigate · user-visible change: logout starts actually invalidating the JWT, so any other tab, device or kiosk still holding that same token is signed out too, and a token restored from storage after a logout no longer works.
fingerprint: d55fbc487de67f16
source: audit-robustness
reason: folded into T-032 (same logout/revoke finding from audit-security)

## T-043
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: send_email_otp blocks the event loop on the synchronous SMTP send
files: backend/app/api/routes/mfa.py
evidence: backend/app/api/routes/mfa.py:1100 · `send_email(smtp_settings=smtp_settings, to_email=user.email, subject="Your Bambuddy verification code", ...)` is called directly inside the `async def send_email_otp` handler; services/email_service.py's `send_email` is a plain `def` that runs `smtplib.SMTP(smtp_settings.smtp_host, smtp_settings.smtp_port, timeout=10)` plus starttls/login/sendmail. A mail host that accepts TCP but answers slowly (a greylisting relay, a saturated Office365 endpoint) freezes the single uvicorn event loop for up to 10 s per socket operation — 40 s+ across connect, TLS, auth and DATA — during which no other request in the process is served: printer status polls, WebSocket pushes and camera snapshots all stall for every user because one person asked for a 2FA code. · fix: await starlette.concurrency.run_in_threadpool(send_email, ...) so the SMTP round trip runs off the loop
fingerprint: fb6aa68e673d075e
source: audit-robustness

## T-044
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 4
title: login() calls the blocking ldap3 authenticate_ldap_user directly on the event loop
files: backend/app/api/routes/auth.py
evidence: backend/app/api/routes/auth.py:496 · `ldap_user = authenticate_ldap_user(ldap_config, request.username, request.password)` inside `async def login`. services/ldap_service.py's `authenticate_ldap_user` is a plain `def`: it builds `Server(..., connect_timeout=10)` and then `conn.open()` / `conn.start_tls()` / `conn.bind()` on ldap3 `Connection` objects created with no `receive_timeout`. An unreachable directory blocks the whole process for the 10 s connect timeout on every login attempt, and a directory that completes the TCP handshake but never answers the bind (a hung DC, a firewall that blackholes after SYN-ACK) blocks the recv forever — the entire app, not just that request, stops responding until the socket is torn down. · fix: wrap the call in starlette.concurrency.run_in_threadpool so a slow directory only blocks its own request
fingerprint: 29e4881fbb13fb97
source: audit-robustness

## T-045
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 6
title: _send_reset_email_or_delete_token runs the blocking SMTP send inside an async background task
files: backend/app/api/routes/auth.py
evidence: backend/app/api/routes/auth.py:1009 · `send_email(smtp_settings, to_email, subject, text_body, html_body)` inside `async def _send_reset_email_or_delete_token`, which is registered via `background_tasks.add_task(...)`. Because the wrapper is `async def`, Starlette awaits it on the event loop rather than in a threadpool, so the blocking `smtplib` calls (timeout=10 per socket operation) freeze the loop after the response is returned — a forgot-password request against a slow or unreachable mail relay stalls every other in-flight request for tens of seconds, and the comment's promise that sending 'asynchronously' keeps response time independent of the user's existence only holds for the requester, not for anyone else on the instance. · fix: await starlette.concurrency.run_in_threadpool(send_email, ...) inside the wrapper
fingerprint: ae27db21ad225f46
source: audit-robustness

## T-046
priority: P2
status: WONTFIX-AUTO
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: oidc_authorize is unauthenticated yet performs an outbound fetch and a DB insert per call with no throttle
files: backend/app/api/routes/mfa.py
evidence: backend/app/api/routes/mfa.py:1638 · `async def oidc_authorize(provider_id: int, db: AsyncSession = Depends(get_db))` has no rate-limit call, and main.py's PUBLIC_API_PREFIXES contains `"/api/v1/auth/oidc/authorize/"`, so anonymous callers reach it. Each call does `async with httpx.AsyncClient(timeout=10) as client: resp = await client.get(discovery_url)` and then `db.add(AuthEphemeralToken(token=state, token_type=TokenType.OIDC_STATE, ...))` with `OIDC_STATE_TTL = timedelta(minutes=10)`, while the prune above it only deletes rows that have *already* expired. A single host looping this endpoint parks one pooled DB session per request for up to 10 s waiting on the IdP — the SQLite pool is 20 + 200 overflow, so a few hundred concurrent calls exhaust it and every authenticated request queues behind them — and commits one state row per call, so the table holds ten minutes' worth of the attacker's request rate the whole time. · fix: throttle by client IP the way routes/aito.py's `_track_rate_limited` throttles the other public route, and cache the discovery document per provider instead of refetching it on every click · user-visible change: a burst of authorize requests from one address starts receiving 429 instead of an auth_url, so a shared-NAT site clicking the SSO button many times in a minute can be told to wait.
fingerprint: 1a8dc3b9d54ba786
source: audit-robustness
reason: folded into T-033 (same oidc_authorize throttle finding from audit-security)

## T-047
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 6
title: AitoTrackEntryPage renders a bare empty screen, with no timeout or fallback, while the locale chunk loads
files: frontend/src/pages/AitoTrackEntryPage.tsx
evidence: frontend/src/pages/AitoTrackEntryPage.tsx:75 · `if (!ready) return <div className="min-h-screen bg-aito-midnight" />;` — `ready` comes from useTrackingLanguage/useTranslation, and the page's default language is French (TRACKING_FALLBACK_LANGUAGE), which i18n/index.ts ships as a lazily imported chunk (`fr: () => import('./locales/fr')`), so the very first `/t` visit always waits on a ~350 KB chunk fetch. On the mobile links this page exists for, a stalled chunk request means the client stares at a plain dark rectangle — no logo, no message, no retry — for as long as the request hangs, and there is nothing to distinguish it from a broken site. Its sibling AitoTrackPage handles the same gate by rendering the card, the logo and a pulsing skeleton while `!settled`. · fix: render the same card shell (Logo + skeleton, as AitoTrackPage does) while !ready, and fall through to the English bundle after a short timeout instead of gating the whole page on the chunk
fingerprint: c6e0f4e47ea66f9a
source: audit-robustness
reason: user-approved behavior change (NARROWED: Logo + skeleton shell while !ready only, no English fallback timeout)

## T-048
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 6
last_touched_iteration: 7
title: New OIDC-authorize rate limiter isn't reset by conftest.py's global fixture, unlike the aito.py limiter it was modelled on
files: backend/tests/conftest.py
evidence: backend/tests/conftest.py:920 · conftest.py:920-928 has an autouse fixture `_reset_tracking_rate_limits` that clears aito.py's `_track_rate_ip_calls`/`_track_rate_ip_misses` dicts before/after every test in the suite. mfa.py's `_oidc_authorize_rate_ip_calls` dict (added this round, routes/mfa.py:178) is a process-global module dict with the exact same shape and the same comment lineage ('modelled on aito.py's _track_rate_limited', routes/mfa.py:167-170), but its reset (`_reset_oidc_authorize_rate_limits`, routes/mfa.py:181) is only wired into an autouse fixture scoped to backend/tests/integration/test_mfa_api.py:40-47. `rg -n "oidc/authorize" backend/tests/` shows two other files call the same route without resetting it: backend/tests/integration/test_security.py:783 and backend/tests/unit/test_route_auth_coverage.py:70 (the latter only lists the path string, does not call it). Since `./test_backend.sh` runs pytest with `-n 30` and xdist's default 'load' distribution interleaves tests from different files onto the same worker process, any accumulated per-IP call count from test_security.py's call is not cleared before/after it runs, unlike every other test in the suite that touches this module-global state. · fix: fold mfa.py's `_reset_oidc_authorize_rate_limits()` into conftest.py's existing autouse `_reset_tracking_rate_limits` fixture (or a sibling one) so it resets for every test file the same way aito.py's limiter does, then drop the now-redundant file-local fixture in test_mfa_api.py
fingerprint: 09c126fae8230686
source: audit-cleanliness

## T-049
priority: P3
status: WONTFIX-AUTO
attempts: 0
round: 2
first_seen_iteration: 6
last_touched_iteration: 6
title: TRACKING_FALLBACK_LANGUAGE is exported but only ever used inside its own file
files: frontend/src/utils/aitoTracking.ts
evidence: frontend/src/utils/aitoTracking.ts:8 · `rg -n "\bTRACKING_FALLBACK_LANGUAGE\b" frontend/ backend/ tools/ PROBES.json` -> only frontend/src/utils/aitoTracking.ts:8 (the `export const` declaration) and :21 (its one use, inside trackingDefaultLanguage() in the same file); no other file in frontend/, backend/, tools/, or PROBES.json references it. It is listed in SURFACE.md:1640, so it is a tracked export, not truly dead — just needlessly public. · fix: drop the `export` keyword so the constant is file-private, since nothing outside frontend/src/utils/aitoTracking.ts imports it · user-visible change: removing the export changes SURFACE.md's frozen public-surface listing for frontend/src/utils, even though no import site is affected today
fingerprint: 6396e60ef15a1fdb
source: audit-cleanliness
reason: behavior change declined (SURFACE churn for no caller)

## T-050
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 6
last_touched_iteration: 8
title: oidc_callback() fetches token_endpoint/jwks_uri from the discovery document with only a scheme check
files: backend/app/api/routes/mfa.py
evidence: backend/app/api/routes/mfa.py:1895 · if not token_endpoint.startswith(("https://", "http://")) or not jwks_uri.startswith(("https://", "http://")): · fix: call _oidc_helpers.assert_safe_public_https_url() on token_endpoint and jwks_uri (and on authorization_endpoint at mfa.py:1777) before either fetch, mapping ValueError to the existing invalid_discovery_document redirect — the issuer_url the document came from already passes that same guard via schemas/auth.py:_validate_issuer_url, so the endpoints it declares should not escape it · user-visible change: an IdP whose discovery document declares an http:// or private-address token_endpoint/jwks_uri would stop working: its users' logins would bounce to /?oidc_error=invalid_discovery_document instead of completing.
fingerprint: 92d9598e034bd350
source: audit-security
reason: user-approved behavior change (assert_safe_public_https_url on token_endpoint/jwks_uri/authorization_endpoint)

## T-051
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 6
last_touched_iteration: 8
title: forgot_password() records the per-email rate event only for real local users, so its 429 is an account-existence oracle
files: backend/app/api/routes/auth.py
evidence: backend/app/api/routes/auth.py:1163 · db.add(AuthRateLimitEvent(username=identifier, event_type=EventType.PASSWORD_RESET_SEND)) # staged only inside `if user and user.is_active and user.auth_source not in ("ldap", "oidc")` — the per-IP cap is 10, so 4 requests for one address return 429 for a local account and the generic 200 for an unknown one · fix: stage the PASSWORD_RESET_SEND event for the normalised identifier unconditionally, alongside the PASSWORD_RESET_IP event, instead of inside the user-exists branch · user-visible change: a visitor who submits the same unknown or SSO-only email 3 times in 15 minutes now gets 429 'Too many password reset requests' on the 4th attempt, where today every attempt returns the generic success message.
fingerprint: 652dfabedcba1986
source: audit-security
reason: user-approved behavior change (PASSWORD_RESET_SEND event staged for every identifier)

## T-052
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 6
last_touched_iteration: 8
title: checkAuthStatus() adopts any ?token= from the URL on every route, overwriting a live session and persisting it once validated
files: frontend/src/contexts/AuthContext.tsx
evidence: frontend/src/contexts/AuthContext.tsx:45 · setAuthToken(urlToken, 'session'); // session-only until server confirms it's valid … if (urlToken && token === urlToken) { setAuthToken(urlToken, 'persistent'); } · fix: only adopt the URL token when no token is already stored, and require an explicit kiosk marker (e.g. a dedicated /kiosk route or a second query flag) before writing it — the L-4 comment only defers persistence past validation, it does not stop an attacker-supplied token being adopted in the first place · user-visible change: SpoolBuddy kiosk links that today authenticate by appending ?token= to any page URL would stop working until they are re-issued against the kiosk entry point, and a ?token= link would no longer replace an already-signed-in session.
fingerprint: cf2cf808c02727ab
source: audit-security
reason: user-approved behavior change (NARROWED: adopt ?token= only when no token is already stored; NO kiosk marker/entry point)

## T-054
priority: P1
status: DONE
attempts: 1
round: 2
first_seen_iteration: 6
last_touched_iteration: 7
title: _send_reset_email_or_delete_token()'s token-delete-on-failure runs against the real DB engine, not the test DB — T-045 only checks a log line, so the deletion itself is silently broken and unverified
files: backend/app/api/routes/auth.py
evidence: backend/app/api/routes/auth.py:1003 · backend/app/api/routes/auth.py:40 does `from backend.app.core.database import async_session, get_db`, and line 1003 calls `async with async_session() as db:` using that bound name. backend/tests/conftest.py:399-406 patches `backend.app.core.database.async_session`, `backend.app.core.auth.async_session`, `backend.app.main.async_session`, and `backend.app.services.obico_detection.async_session` — but NOT `backend.app.api.routes.auth.async_session` — so the patch never reaches the name already bound inside auth.py. Running the T-045 test (test_forgot_password_send_runs_off_event_loop_and_deletes_token_on_failure in backend/tests/integration/test_advanced_auth_api.py) with -s reproduces this live: `ERROR backend.app.api.routes.auth Failed to delete reset token after send failure: (sqlite3.OperationalError) no such table: auth_ephemeral_tokens` appears in its own captured logs, and the test still passes because its only assertion is `failure_logs = [r for r in caplog.records if 'deleting token to unblock re-request' in r.getMessage()]; assert len(failure_logs) == 1` — it never queries the DB or re-uses the token to confirm it was actually deleted. A standalone repro (`_send_reset_email_or_delete_token` called directly against the same test process) reproduces the identical `no such table` error. · fix: Add `patch("backend.app.api.routes.auth.async_session", test_async_session)` to the `with (...)` block in backend/tests/conftest.py (same pattern already used for services/obico_detection.py at conftest.py:406), then extend backend/tests/integration/test_advanced_auth_api.py's test_forgot_password_send_runs_off_event_loop_and_deletes_token_on_failure to assert the token row is actually gone (query AuthEphemeralToken by the captured reset_url's token via db_session) and that a subsequent /forgot-password/confirm with that token now 400s.
fingerprint: 09c052aaf32c01c9
source: audit-tests

## T-055
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 6
last_touched_iteration: 9
title: 'shows an error toast ... and does not navigate away' (T-038) races an earlier successful-login test's uncleared 700ms exitToDashboard timer
files: frontend/src/__tests__/pages/LoginPage.test.tsx
evidence: frontend/src/__tests__/pages/LoginPage.test.tsx:172 · The 'shows loading state during login' test at line 130 (and 'submits login request with credentials' at line 86) complete a successful login (access_token returned), which drives LoginPage.tsx's exitToDashboard() at line 142-150: `window.setTimeout(() => navigate(target, { replace: true }), 700);` — a raw, never-cleared window.setTimeout that survives component unmount. The T-038 test at line 175-213 does `mockNavigate.mockClear()` at its start (line 177) and later asserts `expect(mockNavigate).not.toHaveBeenCalled()` (line 211), with no fake timers and no reduced-motion trick. The T-037 block 500+ lines later (lines 734-745) explicitly documents this exact hazard in a comment: '...a real, uncleared 700ms window.setTimeout left over from an *earlier* test's render — LoginPage never clears it on unmount, so it can fire mid-way through a later test and pollute mockNavigate's call list' — and defends against it by forcing prefers-reduced-motion so navigate() fires synchronously instead. The T-038 test uses none of that protection, so if the earlier successful-login test's 700ms timer fires during the real time T-038 spends on userEvent.type/click between its mockClear() and its final assertion, mockNavigate would be called and the assertion would fail (confirmed to have failed once in a full-suite run per campaign notes). · fix: In frontend/src/__tests__/pages/LoginPage.test.tsx, apply the same defence T-037 uses in its own describe block (e.g. force `window.matchMedia` reduced-motion so exitToDashboard() navigates synchronously) to the two successful-login tests in the 'login flow' describe (lines 86 and 130), or switch those two tests to `vi.useFakeTimers()` and never advance past 700ms before unmounting, so no pending real setTimeout survives into later tests in the file.
fingerprint: e8053dd1a8d24f54
source: audit-tests

## T-056
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 6
last_touched_iteration: 9
title: oidc_callback()'s post-discovery failure branches (invalid/non-HTTP discovery document, token-exchange network error, token-exchange non-2xx body) are untested, including the SSRF host-scheme guard
files: backend/app/api/routes/mfa.py
evidence: backend/app/api/routes/mfa.py:1895 · term-missing coverage for backend/app/api/routes/mfa.py (pytest ... --cov-report=term-missing) lists 1892, 1896-1899, 1920-1922, 1925-1944 as missing. Those lines are: `if not token_endpoint or not jwks_uri: return RedirectResponse(...invalid_discovery_document...)` (1891-1892), the non-HTTP(S) SSRF guard `if not token_endpoint.startswith(("https://","http://")) or not jwks_uri.startswith(...)` and its redirect (1895-1899), the token-exchange network-error except branch (1920-1922), and the token-exchange non-success JSON/error-body parsing + redirect (1925-1944). `grep -rln 'token_exchange_network_error\|invalid_discovery_document\|token_exchange_' backend/tests/` only matches frontend-adjacent unrelated files, confirming no backend test drives any of these branches — even though this campaign just extracted the shared `_fetch_oidc_discovery()` helper (used by both oidc_authorize and oidc_callback) and added a new discovery-failure test only for oidc_authorize's own 404/502 path and one callback discovery-failure test (test_oidc_relogin.py::TestOidcCallbackDiscoveryFailure), leaving the callback's own-document-validation and token-exchange failure branches, including the anti-SSRF scheme check, uncovered. · fix: In backend/tests/integration/test_oidc_relogin.py, add cases alongside the new TestOidcCallbackDiscoveryFailure class: (1) discovery document missing token_endpoint/jwks_uri -> asserts redirect to invalid_discovery_document, (2) discovery document with a non-http(s) token_endpoint or jwks_uri (e.g. file:// or gopher://) -> asserts redirect to invalid_discovery_document (proves the SSRF guard fires), (3) the token endpoint POST raising (httpx.ConnectError or similar) -> asserts redirect to token_exchange_network_error, (4) the token endpoint returning a non-2xx JSON error body -> asserts redirect to token_exchange_<urlencoded-error-code>.
fingerprint: ca1f8b84383c1ee3
source: audit-tests

## T-057
priority: P1
status: DONE
attempts: 1
round: 2
first_seen_iteration: 6
last_touched_iteration: 7
title: login()'s LDAP bind runs on the shared default executor with no bound on how long a thread is held
files: backend/app/api/routes/auth.py
evidence: backend/app/api/routes/auth.py:497 · `ldap_user = await asyncio.to_thread(authenticate_ldap_user, ldap_config, request.username, request.password)` — the ldap3 objects it drives set only `connect_timeout=10` (services/ldap_service.py:102) and never `receive_timeout`, so a directory that completes the TCP handshake and then stops answering (firewall drop mid-session, VPN flap, hung LDAP box) leaves the bind blocked in a read forever. asyncio.to_thread runs on the loop's *default* ThreadPoolExecutor (min(32, cpu+4) workers), shared process-wide: after ~32 such login attempts every other to_thread in the process queues behind them indefinitely — the 2FA OTP email (mfa.py:1145) and the password-reset email (auth.py:993) that this campaign just moved off the loop, plus main.py's photo/timelapse file IO. The user sees a login request that never returns, and users who do not use LDAP at all stop being able to complete email 2FA. · fix: bound the wait at the call site (e.g. asyncio.wait_for around the to_thread, mapping the timeout to the existing 'fall back to local auth' path), and/or run the LDAP bind on a dedicated bounded executor instead of the default one · user-visible change: a login attempted while the LDAP server is unresponsive would return an error (or fall through to local auth) after a few seconds instead of hanging until the browser gives up
fingerprint: e61a932e80031196
source: audit-robustness
reason: user-approved behavior change (asyncio.wait_for ~15 s around the LDAP bind; on timeout take the existing LDAP-failure path)

## T-058
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 6
last_touched_iteration: 9
title: send_email_otp re-issues a pre-auth token but never refreshes the 2fa_challenge cookie it is bound to
files: backend/app/api/routes/mfa.py
evidence: backend/app/api/routes/mfa.py:1172 · `fresh_token = await create_pre_auth_token(db, username, challenge_id=challenge_id)` — send_email_otp takes no `response` parameter, so the only place the binding cookie is written is `_issue_2fa_challenge` at login time with `max_age=300`. The fresh token gets a full PRE_AUTH_TOKEN_TTL (5 min) from the send, but its cookie still dies 300 s after login, and consume_pre_auth_token fails closed when `stored_challenge_id is not None and stored_challenge_id != challenge_id`. A user who logs in, picks the email method, waits for delivery and types the code more than five minutes after login gets HTTP 401 'Invalid or expired pre-auth token' — while the email they are reading says the code is good for 10 minutes — and has to re-enter username and password. · fix: give send_email_otp a `response: Response` parameter and re-set the 2fa_challenge cookie (same attributes, fresh max_age) alongside the fresh token · user-visible change: the 2fa_challenge cookie's expiry is extended on each OTP send, so the email-2FA step stays usable for five minutes after the code is sent rather than five minutes after the password was entered
fingerprint: ef59848470d8a40c
source: audit-robustness
reason: user-approved behavior change (send_email_otp re-sets the 2fa_challenge cookie with fresh max_age)

## T-059
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 6
last_touched_iteration: 10
title: _fetch_oidc_discovery returns any JSON as `dict`, so a non-object discovery body crashes oidc_authorize
files: backend/app/api/routes/mfa.py
evidence: backend/app/api/routes/mfa.py:1741 · `return resp.json()` — the helper is annotated `-> dict` and its docstring promises it 'raises on any failure', but a provider whose /.well-known/openid-configuration answers 200 with `null`, a list or a string returns that value happily. In oidc_authorize the consumer is outside the try: `discovery = await _fetch_oidc_discovery(...)` is guarded, then `authorization_endpoint = discovery.get("authorization_endpoint")` (line 1770) raises AttributeError -> an unauthenticated caller gets a 500 with a traceback in the log instead of the 502 'Failed to fetch OIDC discovery document' the code two lines above intends. In oidc_callback the same access lands in the outer catch-all and redirects to `?oidc_error=internal_error`, so the operator debugging a mistyped issuer_url is told 'internal error' rather than 'invalid discovery document'. · fix: in the helper, reject a non-dict body (`if not isinstance(data, dict): raise ValueError(...)`) so both callers take their existing discovery-failure branch · user-visible change: a provider serving a non-object discovery document turns a 500 into the existing 502 on /oidc/authorize and an 'invalid_discovery_document' toast instead of 'internal_error' on the callback
fingerprint: 9028160c244835c4
source: audit-robustness
reason: user-approved behavior change (non-dict discovery body -> ValueError -> existing failure branches)

## T-060
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 6
last_touched_iteration: 10
title: _oidc_authorize_rate_limited's per-IP cap collapses to one install-wide bucket on a default reverse-proxy install
files: backend/app/api/routes/mfa.py
evidence: backend/app/api/routes/mfa.py:1716 · `host = _get_client_ip(request)` with the docstring 'behind nginx the latter is the proxy for every visitor, and the per-IP cap would silently become a per-shop cap' — but `_get_client_ip` (auth.py:187) only consults X-Forwarded-For `if _TRUSTED_PROXY_IPS and direct_ip in _TRUSTED_PROXY_IPS`, and `_TRUSTED_PROXY_IPS` is built from an env var that is empty by default (auth.py:144). Behind the reverse proxy that any install with a public `external_url` runs, every visitor is the proxy's address, so `_OIDC_AUTHORIZE_RATE_MAX_CALLS_PER_IP = 30` is 30 calls per minute for the whole site. With the #1589 autologin effect firing one getOIDCAuthorizeUrl per unauthenticated /login mount, an office reloading the login page ~30 times a minute pushes everyone onto the 429 path: the SSO buttons error and autologin shows its 'autologin failed' banner with no way in. · fix: either require/warn that TRUSTED_PROXY_IPS is configured before treating the key as per-client, or size the cap for a whole site sharing one address · user-visible change: raising or re-keying the cap changes when /auth/oidc/authorize starts answering 429
fingerprint: 62fcfef80aa45851
source: audit-robustness
reason: user-approved behavior change (NARROWED: raise _OIDC_AUTHORIZE_RATE_MAX_CALLS_PER_IP 30 -> 120, matching the tracking route; no re-keying, no warning)

## T-061
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 6
last_touched_iteration: 10
title: exitToDashboard's 700 ms timer is never cleared on unmount
files: frontend/src/pages/LoginPage.tsx
evidence: frontend/src/pages/LoginPage.tsx:150 · `window.setTimeout(() => navigate(target, { replace: true }), 700);` — nothing captures the id and LoginPage registers no cleanup effect, so the callback still fires after the component is gone. In the app a user who logs in and immediately clicks elsewhere (or is moved by the #1889 effect) is yanked to `target` up to 0.7 s later; the campaign's own test file documents the same leak polluting a later test's navigate calls (__tests__/pages/LoginPage.test.tsx:738). · fix: store the id in a ref and clear it in a `useEffect(() => () => clearTimeout(ref.current), [])`
fingerprint: 8ccc460552ea58a8
source: audit-robustness

## T-062
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 6
last_touched_iteration: 11
title: the #1889 already-authenticated effect races exitToDashboard after a password login
files: frontend/src/pages/LoginPage.tsx
evidence: frontend/src/pages/LoginPage.tsx:210 · `useEffect(() => { if (!loading && user && step === 'credentials') navigate('/', { replace: true }); }, [loading, user, step, navigate])` — AuthContext.login() awaits checkAuthStatus(), which calls setUser() before the mutation's onSuccess runs, so on the credentials step `user` is already set when onSuccess calls `exitToDashboard(resolvePostLoginRedirect())` (line 345). The effect fires on the very next render and navigates to '/' while the 700 ms timer is still pending: the card's exit animation never plays, and a user who was bounced here from a deep link (`location.state.from`) lands on the dashboard for 0.7 s and is then thrown to the real target — two navigations and a visible flash for one login. · fix: skip the effect while a login has just succeeded (e.g. gate it on `!isExiting`/`!loginMutation.isSuccess`) so exitToDashboard owns the post-login navigation
fingerprint: 3c094bcf52de47c2
source: audit-robustness
reason: user-approved behavior change (gate the #1889 effect while a login has just succeeded so exitToDashboard owns the navigation)

## T-063
priority: P2
status: DONE
attempts: 1
round: 3
first_seen_iteration: 11
last_touched_iteration: 13
title: _setup_provider_and_state() is copy-pasted verbatim between TestOidcCallbackDiscoveryEndpointSSRFGuard and TestOidcCallbackTokenExchangeFailure (plus a third inline copy)
files: backend/tests/integration/test_oidc_relogin.py
evidence: backend/tests/integration/test_oidc_relogin.py:523 · rg -n '_setup_provider_and_state' backend/tests/integration/test_oidc_relogin.py -> defined identically at line 523 (used 2x within TestOidcCallbackDiscoveryEndpointSSRFGuard) and again at line 684 (used 6x within TestOidcCallbackTokenExchangeFailure); both bodies are byte-for-byte the same ~44-line admin-setup + create-provider + seed-oidc_state-token sequence. TestOidcCallbackDiscoveryFailure (line 330) inlines a third copy of the same sequence in a single test rather than calling a shared helper. · fix: hoist one module-level async helper (e.g. `_setup_provider_and_state(async_client, db_session, *, tag)`) above the classes in test_oidc_relogin.py and have all three call sites use it instead of each class defining/inlining its own copy
fingerprint: 16bc4f1d9377a814
source: audit-cleanliness

## T-066
priority: P2
status: DONE
attempts: 1
round: 3
first_seen_iteration: 11
last_touched_iteration: 14
title: oidc_exchange() returns the full user record before 2FA is verified
files: backend/app/api/routes/mfa.py
evidence: backend/app/api/routes/mfa.py:2302 · return LoginResponse( requires_2fa=True, pre_auth_token=pre_auth_token, two_fa_methods=two_fa_methods, user=_user_to_response(user), ) # _user_to_response includes email, role, is_admin, groups, sorted(user.get_permissions()) · fix: drop the `user=_user_to_response(user)` argument from the requires_2fa branch of oidc_exchange so it matches auth.py:login(), which returns only requires_2fa/pre_auth_token/two_fa_methods (LoginResponse.user is already Optional and LoginPage never reads resp.user in that branch) · user-visible change: an OIDC user with 2FA enabled no longer receives the `user` object in the POST /auth/oidc/exchange response; any client that reads resp.user before completing 2FA would now see null (Bambuddy's own LoginPage does not)
fingerprint: cd7d8d9d380286d2
source: audit-security
reason: user-approved behavior change (drop user= from the requires_2fa branch of oidc_exchange)

## T-067
priority: P2
status: DONE
attempts: 1
round: 3
first_seen_iteration: 11
last_touched_iteration: 14
title: list_oidc_providers() exposes each provider's account-linking policy to unauthenticated callers
files: backend/app/api/routes/mfa.py
evidence: backend/app/api/routes/mfa.py:1389 · @router.get("/oidc/providers", response_model=list[OIDCProviderResponse]) # main.py PUBLIC_API_ROUTES: "/api/v1/auth/oidc/providers" — OIDCProviderResponse carries auto_create_users, auto_link_existing_accounts, email_claim, require_email_verified, default_group_id, is_env_managed · fix: give the public route a slim response model containing only id, name and has_icon (the fields OIDCProviderButton uses) and keep the full OIDCProviderResponse on the SETTINGS_READ-gated /oidc/providers/all · user-visible change: the unauthenticated GET /api/v1/auth/oidc/providers response loses issuer_url, client_id, scopes and the auto-create/auto-link/email-claim policy fields, so any external client reading those from the public list stops receiving them
fingerprint: ef51c17918ce76be
source: audit-security
reason: user-approved behavior change (slim public /oidc/providers to id/name/has_icon; openapi golden re-record)

## T-069
priority: P1
status: DONE
attempts: 1
round: 3
first_seen_iteration: 11
last_touched_iteration: 12
title: oidc_callback sends every failure to `/?oidc_error=`, a protected route that drops the query
files: backend/app/api/routes/mfa.py
evidence: backend/app/api/routes/mfa.py:1869 · `frontend_error_url = f"{external_url}/?oidc_error="` — but `/` is the index route under `ProtectedRoute` (App.tsx:265-266), which for an unauthenticated visitor renders `<Navigate to="/login" replace state={{ from: location }} />` (App.tsx:157) and drops the search string. So after any SSO failure the browser lands on a bare `/login` with no `oidc_error` param: LoginPage's whole `KNOWN_OIDC_ERRORS` table (LoginPage.tsx:299-320) never fires and the user is shown the plain credentials form with no explanation of why SSO failed. Worse, LoginPage's autologin effect skips its redirect only `if (... || searchParams.get('oidc_error'))` (LoginPage.tsx:251) — with the param stripped, an install with `autologin_provider_id` set bounces the browser straight back to the IdP, which fails again, giving an endless IdP<->Bambuddy redirect loop with no reachable login form. The frontend test at LoginPage.test.tsx:858 hides the mismatch by pushing `/login?oidc_error=invalid_state` itself, a URL the backend never produces. · fix: point `frontend_error_url` at `f"{external_url}/login?oidc_error="` — the success redirect already targets `/login`; the existing backend assertions (`"oidc_error=..." in location` / `endswith(...)` in test_oidc_relogin.py) still hold · user-visible change: after a failed SSO sign-in the address bar reads /login?oidc_error=… instead of /?oidc_error=…, and the user now sees the corresponding error toast where previously they saw nothing.
fingerprint: 4ca6a69c12c4bd62
source: audit-robustness
reason: user-approved behavior change (frontend_error_url -> /login?oidc_error=)

## T-070
priority: P1
status: DONE
attempts: 1
round: 3
first_seen_iteration: 11
last_touched_iteration: 12
title: send_email_otp holds the SQLite write transaction open across the SMTP send
files: backend/app/api/routes/mfa.py
evidence: backend/app/api/routes/mfa.py:1131 · `await db.execute(UserOTPCode.__table__.update()...values(used=True))` at line 1131 opens the write transaction, `db.add(otp_record)` stages into it, and the first commit is `record_email_otp_send` at line 1169 — after `await asyncio.to_thread(send_email, ...)` (line 1156). SQLite holds the RESERVED write lock for that whole span, and send_email uses `timeout=10` per socket operation (email_service.py:218-231: connect, starttls, login, send_message), so a slow or half-dead SMTP relay pins the lock for up to ~40 s while `PRAGMA busy_timeout = 15000` (database.py:21) gives every other writer only 15 s. One user tapping "Send code" while the relay is degraded makes unrelated writers — MQTT status persistence, the queue, the Aito sync worker — fail with "database is locked". Moving the send to a worker thread removed the event-loop block but left the lock held, so those writers now actually run concurrently and collide instead of being serialised behind the blocked loop. · fix: commit the invalidation and the new UserOTPCode row before the send, and mark that row used (or delete it) in an except branch if the send raises, so no write transaction spans the SMTP round trip · user-visible change: when an OTP email fails to send, the user's previously e-mailed code is now already invalidated rather than being restored by the rolled-back transaction, so they must request a new code instead of reusing the old one.
fingerprint: f1d57eb66c60ebf3
source: audit-robustness
reason: user-approved behavior change (commit OTP invalidation + new row before the SMTP send; mark used on send failure)

## T-071
priority: P2
status: DONE
attempts: 1
round: 3
first_seen_iteration: 11
last_touched_iteration: 14
title: _fetch_oidc_discovery has no overall deadline and no response-size cap
files: backend/app/api/routes/mfa.py
evidence: backend/app/api/routes/mfa.py:1760 · `async with httpx.AsyncClient(timeout=10) as client:` — httpx applies that 10 s per phase (connect/read/write/pool), not to the request as a whole, and `resp.json()` buffers the entire body. An issuer that trickles one byte every few seconds resets the read timer forever, so a call to the unauthenticated `GET /oidc/authorize/{id}` never returns: the handler's `db: AsyncSession = Depends(get_db)` connection stays checked out of the pool for the duration, and at the 120/min per-IP cap a single client can park a large number of connections and tasks on a stuck IdP until the pool (20 + 200) is starved and unrelated requests block on pool_timeout. The same helper backs oidc_callback, where a hung fetch also holds the user's login round trip open indefinitely. · fix: wrap the fetch in `asyncio.wait_for(...)` with an explicit overall deadline and stream-check `resp.headers.get('content-length')` / cap the bytes read before parsing JSON · user-visible change: a discovery fetch against a very slow IdP that today eventually succeeds after tens of seconds would start failing with the existing 502 once the new overall deadline elapses.
fingerprint: be5736240f77f630
source: audit-robustness
reason: user-approved behavior change (overall wait_for deadline ~15 s + body-size cap on _fetch_oidc_discovery)

## T-072
priority: P2
status: DONE
attempts: 1
round: 3
first_seen_iteration: 11
last_touched_iteration: 15
title: check() has no request deadline, so a hung fetch locks the code squares in 'checking' forever
files: frontend/src/pages/AitoTrackEntryPage.tsx
evidence: frontend/src/pages/AitoTrackEntryPage.tsx:55 · `const data = await api.getAitoTracking(value);` — `request()` in api/client.ts calls `fetch` with no AbortSignal and no timeout, and while `state === 'checking'` TrackingCodeInput sets `busy` and renders the input `readOnly={busy}` (TrackingCodeInput.tsx:32,95). A client on a flaky mobile connection whose request is accepted but never answered (carrier black-hole, backend stalled on a SQLite write lock) is left with six frozen squares, the caret hidden and "Vérification…" on screen: they cannot edit, cannot re-submit, and there is no retry — the only way out is to reload the page they were told to type their code into. · fix: give the check an AbortController armed with a timeout and abort it in the same catch, so the existing `state='error'` / `failure='error'` branch surfaces a retryable message · user-visible change: a tracking-code check that hangs now shows the generic error message after the timeout instead of staying on "checking" indefinitely.
fingerprint: 214cd2e07c21e7ea
source: audit-robustness
reason: user-approved behavior change (AbortController timeout on the /t code check -> existing error state)

## T-073
priority: P2
status: DONE
attempts: 1
round: 3
first_seen_iteration: 11
last_touched_iteration: 15
title: login() ignores checkAuthStatus()'s failure, so a transient /me error reports a successful login that did not take
files: frontend/src/contexts/AuthContext.tsx
evidence: frontend/src/contexts/AuthContext.tsx:181 · `setAuthToken(response.access_token, persistence); await checkAuthStatus();` — checkAuthStatus swallows every non-401 failure: after three failed `api.getCurrentUser()` attempts it runs `setUser(null)` (line 114) and returns normally. login() then resolves with the LoginResponse, so LoginPage's onSuccess takes the `resp.access_token && resp.user` branch, toasts `login.loginSuccess` and calls exitToDashboard (LoginPage.tsx:370-372). With `user` still null, ProtectedRoute immediately bounces the browser back to /login, AuthProvider (mounted above the router) never re-runs checkAuthStatus, and the visitor is returned to an empty credentials form having just been told the login worked — with a valid token sitting in storage. A backend restart or proxy hiccup spanning the ~1.2 s retry window is enough to trigger it, and nothing in the UI or console names the cause. · fix: have checkAuthStatus report whether the token was validated (e.g. return the resolved user or a status flag) and make login() reject when the freshly stored token could not be confirmed, so LoginPage's onError path runs · user-visible change: a login whose follow-up /me call keeps failing now surfaces an error toast and stays on the form instead of announcing success and silently bouncing back.
fingerprint: ee05007510cd0769
source: audit-robustness
reason: user-approved behavior change (checkAuthStatus reports validation; login() rejects when /me cannot confirm the token)

## T-074
priority: P1
status: DONE
attempts: 1
round: 3
first_seen_iteration: 11
last_touched_iteration: 12
title: The autologin-to-SSO-provider effect (advancedAuthStatus.autologin_provider_id redirect) has no test at all
files: frontend/src/pages/LoginPage.tsx
evidence: frontend/src/pages/LoginPage.tsx:244 · coverage: frontend/src/pages/LoginPage.tsx statement lines 245,247,248,251,252,254,255,256,258,260,263 all 0-hit (branches (245,0),(247,0),(248,1),(251,0),(251,1) never taken) in the scoped run (/tmp/c13r3-fe.log). `grep -n autologin frontend/src/__tests__/pages/LoginPage.test.tsx` -> only one match, a fixture setting `autologin_provider_id: null` inside the unrelated forgot-password describe block (line 1272) — the effect itself, the `?fallback=local` escape hatch (line 247), the 5s-timeout Promise.race (255-257), the success redirect via `window.location.href` (260), and the failure banner (`showAutologinBanner`, line 268) are never exercised. · fix: in frontend/src/__tests__/pages/LoginPage.test.tsx, add a describe('autologin') block: mock GET /api/v1/auth/advanced-auth/status with a non-null autologin_provider_id and assert window.location.href is set to the authorize URL; assert `?fallback=local` in the query string suppresses the redirect and shows the normal form; assert a slow/failing api.getOIDCAuthorizeUrl (or the 5s timeout) surfaces the autologin-failed banner instead of hanging; assert an in-flight #oidc_token=/oidc_error= callback suppresses the autologin redirect.
fingerprint: 88028e8f1cc4407d
source: audit-tests

## T-075
priority: P1
status: DONE
attempts: 1
round: 3
first_seen_iteration: 11
last_touched_iteration: 13
title: oidc_callback()'s post-2xx token-response failures (unparseable JSON body, missing id_token) are untested
files: backend/app/api/routes/mfa.py
evidence: backend/app/api/routes/mfa.py:1984 · coverage: backend/app/api/routes/mfa.py 1986-1988, 1993-1998 missing (backend/tests scoped run against test_mfa_api.py+test_oidc_relogin.py only, --cov-config=../pyproject.toml). TestOidcCallbackTokenExchangeFailure in backend/tests/integration/test_oidc_relogin.py (T-056) covers discovery failure, missing token_endpoint/jwks_uri, network error, and non-2xx JSON/non-JSON bodies, but has no case for a *2xx* token response whose body is not valid JSON (`token_exchange_bad_response`, line 1988) or a 2xx JSON body missing the `id_token` key (`no_id_token`, line 1998) — grep for both strings in test_oidc_relogin.py and test_mfa_api.py finds no assertion that triggers either redirect. · fix: in backend/tests/integration/test_oidc_relogin.py, add two cases to TestOidcCallbackTokenExchangeFailure: a mocked token endpoint returning status 200 with a non-JSON body (assert redirect to .../login?oidc_error=token_exchange_bad_response) and one returning 200 with a JSON body that omits id_token (assert redirect to .../login?oidc_error=no_id_token, and that no JWKS fetch/JWT-decode is attempted).
fingerprint: 93b8292d2cd4f39d
source: audit-tests

## T-076
priority: P1
status: DONE
attempts: 1
round: 3
first_seen_iteration: 11
last_touched_iteration: 13
title: assert_safe_public_https_url()'s rejection branches (empty hostname, cloud-metadata hostname, numeric-encoded IP, unspecified, multicast) are never triggered by any test
files: backend/app/api/routes/_oidc_helpers.py
evidence: backend/app/api/routes/_oidc_helpers.py:61 · coverage: backend/app/api/routes/_oidc_helpers.py 62, 65, 68, 85, 89, 91, 92->exit missing, even when scoped to test_mfa_api.py + test_oidc_relogin.py (which exercise the OIDC callback/authorize SSRF guard). backend/tests/unit/test_url_safety.py only tests the shared primitives (CLOUD_METADATA_*, NUMERIC_IP_RE, unwrap_ipv4_mapped) — `grep -n 'def test_' backend/tests/unit/test_url_safety.py` shows no test calls assert_safe_public_https_url or assert_safe_lan_service_url directly, and `find backend/tests -iname '*oidc_helpers*'` finds no dedicated test file. The integration SSRF-guard tests (TestOidcCallbackDiscoveryEndpointSSRFGuard) only exercise a private/RFC-1918 address, so is_private is covered but is_unspecified, is_multicast, the empty-hostname guard, the literal cloud-metadata-hostname match, and the numeric-IP guard are all unverified on this function even though it gates the OIDC discovery document and issuer URL (schemas/auth.py:_validate_issuer_url) that an attacker-controlled response can influence. · fix: in a new backend/tests/unit/test_oidc_helpers.py (mirroring test_url_safety.py's style), unit-test assert_safe_public_https_url directly: non-https scheme, empty hostname ("https:///x"), a CLOUD_METADATA_HOSTNAMES entry, a numeric-encoded IP, 0.0.0.0, an IPv4 multicast address (e.g. 224.0.0.1), and an IPv4-mapped-IPv6 loopback ("::ffff:127.0.0.1") each raising ValueError, plus one accepted public https URL.
fingerprint: 00cbcb9ba2f1d6bd
source: audit-tests

## T-077
priority: P2
status: DONE
attempts: 1
round: 3
first_seen_iteration: 11
last_touched_iteration: 15
title: oidc_callback()'s account-resolution failure branches (no auto-create, account deactivated) are untested
files: backend/app/api/routes/mfa.py
evidence: backend/app/api/routes/mfa.py:2199 · coverage: backend/app/api/routes/mfa.py line 2199 (`return RedirectResponse(...no_linked_account...)` in the `else` of `elif provider.auto_create_users:` — the plain no-link/no-auto-create case, distinct from the already-tested M-NEW-6 auto-link-hijack guard at line 2094) and line 2202 (`if not user or not user.is_active: return ...account_inactive...`, gating an *existing OIDC-linked* user whose local account is now deactivated) both missing in the scoped run. `grep -rn no_linked_account backend/app/api/routes/mfa.py` shows two call sites; only line 2094's is exercised (test_mfa_api.py:3017's M-NEW-6 test). `grep -rn user_resolution_failed backend/tests/integration/` finds nothing, and no test creates a deactivated user with an existing UserOIDCLink before hitting /oidc/callback. · fix: in backend/tests/integration/test_oidc_relogin.py, add: (1) a provider with auto_create_users=False and no matching local account — callback must redirect to oidc_error=no_linked_account without creating a user; (2) an existing UserOIDCLink whose user.is_active is False — callback must redirect to oidc_error=account_inactive rather than issuing a session.
fingerprint: afcb75994aed5244
source: audit-tests

## T-078
priority: P2
status: DONE
attempts: 1
round: 3
first_seen_iteration: 11
last_touched_iteration: 16
title: oidc_callback()'s token-exchange form never omits client_secret or code_verifier (public-client / non-PKCE providers untested)
files: backend/app/api/routes/mfa.py
evidence: backend/app/api/routes/mfa.py:1943 · coverage: branches (1943->1945) and (1945->1948) missing in the scoped run — the False path of `if provider.client_secret:` and `if code_verifier:` when building token_form is never taken. `grep -n client_secret backend/tests/integration/test_oidc_relogin.py` shows every provider fixture sets `"client_secret": "test-secret"`, and every callback test threads a real `code_verifier`, so a public OIDC client (no client_secret, confidential-client-only in this codebase today but the code path exists) or a provider configured without PKCE is never exercised through the actual POST body sent. · fix: in backend/tests/integration/test_oidc_relogin.py, add a provider created with client_secret omitted/empty and assert the token-exchange POST body sent to the mocked token endpoint has no client_secret key; separately, drive a callback whose stored OIDC state has no code_verifier and assert the POST body has no code_verifier key.
fingerprint: 4cd57ed337f41064
source: audit-tests

## T-079
priority: P2
status: DONE
attempts: 1
round: 3
first_seen_iteration: 11
last_touched_iteration: 16
title: _set_2fa_challenge_cookie()'s `secure` flag (http vs https) is never asserted by any test
files: backend/app/api/routes/mfa.py
evidence: backend/app/api/routes/mfa.py:285 · `grep -rn secure= backend/tests/integration/test_mfa_api.py backend/tests/integration/test_oidc_relogin.py backend/tests/integration/test_auth_api.py` returns nothing — test_mfa_api.py's TestEmailSendCookieRefresh (`_parse_2fa_challenge_cookie`) asserts value/path/max-age/samesite/httponly parity between the login cookie and the refreshed one but never reads the `secure` attribute (`send_cookie['secure']`) it also carries. Every integration test hits the app over http (the test client's base_url), so `secure=raw_request.url.scheme == "https"` (line 285) always evaluates False and its True branch — the deployment mode this flag exists to protect (H-1: mixed-content interception) — is completely unexercised. · fix: in backend/tests/integration/test_mfa_api.py, extend _parse_2fa_challenge_cookie's assertions to check `send_cookie['secure']` is empty/False for the existing http-based client, and add a case using an AsyncClient with an https:// base_url (or a request built with scope['scheme']='https') asserting the Set-Cookie header includes `Secure` for both login's and send's 2fa_challenge cookie.
fingerprint: e30b031ebbaed79c
source: audit-tests

## T-080
priority: P2
status: DONE
attempts: 1
round: 3
first_seen_iteration: 11
last_touched_iteration: 16
title: _send_reset_email_or_delete_token()'s nested cleanup-failure branch (the token delete itself fails) is uncovered
files: backend/app/api/routes/auth.py
evidence: backend/app/api/routes/auth.py:1021 · coverage: backend/app/api/routes/auth.py 1021-1022 missing in the scoped run — the `except Exception as db_exc:` around the token-delete-on-send-failure cleanup (the second, nested try/except inside the SMTP-failure branch) never runs. `grep -rn 'Failed to delete reset token after send failure' backend/tests/` returns no match, so a double failure (SMTP send fails AND the subsequent cleanup DELETE also fails, e.g. the engine is unavailable) is never simulated — this is the log line an operator would rely on to notice a stuck reset token. · fix: in backend/tests/integration/test_advanced_auth_api.py, extend TestForgotPasswordEmail (or the T-045 test near test_forgot_password_send_runs_off_event_loop_and_deletes_token_on_failure) with a case that patches the module-level async_session (or the delete() execute call inside the nested try) to raise, alongside a failing send_email, and assert the 'Failed to delete reset token after send failure' log line is emitted via caplog.
fingerprint: 72b243638a8dbc77
source: audit-tests

## T-081
priority: P2
status: DONE
attempts: 1
round: 3
first_seen_iteration: 11
last_touched_iteration: 17
title: refreshUser() — the context's exposed manual-refresh/token-invalidation function — has no test at all
files: frontend/src/contexts/AuthContext.tsx
evidence: frontend/src/contexts/AuthContext.tsx:208 · coverage: frontend/src/contexts/AuthContext.tsx statement lines 209,210,211,212,213,216,217,218 all 0-hit and branches (209,0),(209,1),(212,0),(212,1),(217,0),(217,1) all missing in the scoped run (/tmp/c13r3-fe.log). `grep -n refreshUser frontend/src/__tests__/contexts/AuthContext.test.tsx` returns no match — neither the success path (setUser(currentUser) when mounted) nor the failure path (setAuthToken(null) + setUser(null) on any getCurrentUser rejection, unconditionally, unlike checkAuthStatus's retry-then-401-only clearing) is exercised, despite refreshUser being part of the public AuthContextType contract any future consumer will call after e.g. a profile/permission change. · fix: in frontend/src/__tests__/contexts/AuthContext.test.tsx, add tests calling result.current.refreshUser(): one where GET /auth/me succeeds and user updates in place, one where it fails (any status) and assert both setAuthToken(null) (token cleared unconditionally, unlike checkAuthStatus's retry logic) and user becomes null, and one confirming it no-ops when authEnabled is false or no token is present.
fingerprint: ed657ba6af2004f1
source: audit-tests

