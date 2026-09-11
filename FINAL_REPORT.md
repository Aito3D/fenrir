# Refactor-loop campaign 14 — final report

**Scope:** the client tracking pages (`/t`) and the login page, front and back end, with a security emphasis
(user request 2026-09-10: "focus on the login and tracking page, check for security stuff").
**Run:** 2026-09-10 → 2026-09-11 · worktree `../bambuddy-refactor` · branch `auto-refactor-loop` ·
UPSTREAM `560693873` (main, campaign 13 merged) · BASE `refactor-base` = `607970a69` (empty setup commit: goldens 10/10 and SURFACE.md matched main).
**Parameters:** TRIAGE P3 · MAX_ITER 12 → 16 (raised at the round-2 sweep) · MAX_ROUNDS 3 · BATCH 3 · auto · grouped commits · merge at exit.

## Outcome
- **Iterations run:** 13 (all 13 verifier verdicts PASS, 0 FAIL) · **survey rounds completed:** 2 of 3
- **Commits:** 13 squashed iteration commits on top of the setup commit (plus this report) · **tags:** `loop-1` … `loop-13`
- **Why the loop ended:** the user asked to stop after iteration 13 (plan had 1 task left; MAX_ITER 16 and MAX_ROUNDS 3 were not reached, so this is neither CONVERGED nor a cap exit)
- **Tasks:** 39 filed · 37 DONE · 1 OPEN (T-123) · 1 WONTFIX-AUTO (T-106, false positive) · 0 BLOCKED

## User-approved behavior changes (17 landed, 1 approved but not started)
All recorded in BASELINE-CHANGELOG.md with the auditor's user-visible-change note, each in a commit marked "(user-approved behavior change)".
Round 1 (approved 2026-09-10): T-086 tracking-page query 10 s deadline · T-087 tracking limiter suspends its per-IP miss cap on an unconfigured proxy · T-088 2FA resend no longer locks the code field · T-089 OIDC token/JWKS fetches bounded by deadline and size · T-090 copy-failure toast · T-091 email OTP requires email 2FA enabled · T-092 OIDC state bound to an HttpOnly cookie (login-CSRF fix) · T-093 cookie Secure flag from X-Forwarded-Proto behind TRUSTED_PROXY_IPS.
Round 2 (approved 2026-09-10): T-111 per-flow OIDC binding cookie · T-112 OIDC exchange honours the post-login redirect · T-113 autologin skipped for signed-in visitors and cancelled on unmount · T-114 LDAP-sync failure rolls back and drops the half-resolved user (**the worker proved this was an auth bypass: with local login disabled, a failed sync returned a valid token with no credential check**) · T-116 OIDC discovery/token document type guards · T-118 session login drops a remembered token · T-120 HSTS behind a trusted proxy via a shared `auth._request_is_https` · T-121 limiter collapse requires a private/loopback peer · T-122 tracking miss budget per source network instead of one global bucket.
Approved, not started: **T-123** (Cache-Control: no-store on GET /oidc/authorize/{id}) — OPEN.

## What each resurvey round found
- Round 1 (setup panel): security 5 (3 approvals, 2 triaged) · robustness 5 (all approvals) · cleanliness 3 (1 triaged) · tests 8 · plus 4 leads promoted from campaign 13's triage list (T-012, T-053, T-068, T-082). 22 tasks, all DONE by iteration 8.
- Round 2 (after iteration 8): security 6 (5 approvals, incl. the HSTS lead and the T-087 spoof trade-off) · robustness 7 (5 approvals, 2 triaged) · cleanliness 2 (1 triaged) · tests 5 (1 retired as a false positive). 16 tasks, 15 DONE, T-123 left.
- Round 3: not run (stopped by the user).

## Findings by auditor (plan.py stats, by_source)
| Auditor | Filed | DONE | OPEN | WONTFIX-AUTO | Triaged this campaign |
|---|---|---|---|---|---|
| audit-security | 11 | 10 | 1 (T-123) | 0 | 2 (T-094, T-095) |
| audit-robustness | 11 | 11 | 0 | 0 | 2 (T-115, T-117) |
| audit-cleanliness | 3 | 3 | 0 | 0 | 2 (T-083, T-105) |
| audit-tests | 14 | 13 | 0 | 1 (T-106, false positive: the T-068 race test exists in test_security.py) | 0 |
"Filed" includes the four campaign-13 leads promoted at setup (security 2, robustness 1, tests 1).

## Triage
6 findings were triaged this campaign (security 2, robustness 2, cleanliness 2); TRIAGE.md holds 15 entries in total — the 9 carried from campaigns 12/13 that were not promoted, plus these 6 — each with full evidence, for review or `plan.py promote <id> --iteration N` (the flag is required). Note `plan.py stats`'s `triaged` is the current count in TRIAGE.md, not a campaign sum.
- T-005 [P3] get_invoice_pdf() and get_quote_pdf() return client financial PDFs with no Cache-Control
- T-011 [P3] _check_ai_rate_limit prunes timestamps but never evicts idle keys from _ai_rate_limit_calls
- T-019 [P3] import_legacy_projects' emptiness guard is a check-then-act despite its docstring's claim
- T-022 [P3] buildQuoteSummary()'s filament.name fallback (material falsy) is never exercised
- T-025 [P3] get_current_user_info() re-imports jwt/PyJWTError instead of the module-level aliases
- T-026 [P3] login()'s LDAP-fallback warning bypasses the module's own _logger
- T-031 [P3] The three 2FA method-selector buttons (totp/email/backup) are copy-pasted markup
- T-064 [P3] The reduced-motion window.matchMedia mock object is copy-pasted three times in this round's new tests
- T-065 [P3] Email-OTP-enable DB-injection dance is duplicated between TestTwoFAVerifyPreconditions._enable_email_otp and TestEmailOTPSendCookieRefresh._enable_email_otp_and_login
- T-083 [P3] _set_external_url() test helper duplicated verbatim in test_aito_tracking.py
- T-094 [P3] logout() logs the raw User-Agent header at ERROR on any token that fails signature verification
- T-095 [P3] the "/icon" PUBLIC_API_PATTERNS entry also matches the admin-only OIDC icon delete/refresh routes
- T-105 [P3] _patch_pickup_message() test helper duplicated verbatim (minus one comment) in test_aito_tracking_delivery.py
- T-115 [P3] verify_2fa's email branch burns the OTP row before the pre-auth token is consumed
- T-117 [P3] verify_2fa's backup-code branch runs ten pbkdf2 verifications on the event loop

## Verification
- Coverage: backend 72% → 72% lines (18255 → 18237 missed of 72584 → 72659 statements) · frontend 61.67% → 61.76% lines
- Tests: backend 13205 → 13297 passed · frontend 6085 → 6124 passed (413 files)
- Known-broken tests: 0 → 0 · golden probes 10/10 matching at every verdict · SURFACE.md unchanged at every verdict
- Lint/typecheck/build clean at every verdict (ruff, eslint, tsc -b, npm run build)
- Load-flaky files (pass alone, documented for the verifier): FileUploadModal, ArchivesPage, AppRouterAitoGuard, QueuePage, SettingsPage, SlicerSettingsPanel, PrintModal, test_aito_routes thousand-projects, test_queue_creation_attribution, test_slicer_stall_timeout, test_plug_energy_history (22:00-22:30 UTC)
- Scanners at round 1 and 2: pip-audit no CVEs; npm audit only dev/build deps; semgrep, bandit, gitleaks false positives only.

## Left for humans
- **OPEN:** T-123 — `Cache-Control: no-store` on GET /api/v1/auth/oidc/authorize/{id} (approved; the handler already has `response: Response`, one line plus a header assertion).
- **WONTFIX-AUTO:** T-106 — retired as a false positive (TestEmailOTPMultipleLiveRows covers it).
- **Residue from T-119** (timing oracle): the dummy password verify runs only when no local account matches; a local account with local login disabled, or a username matched only via the email fallback, still short-circuits — closing it needs core/auth.py's authenticate_user, which was out of scope.
- **Upstream-merge caution:** mfa.py now carries `_cookie_secure`, `_bounded_fetch` (+ token/JWKS timeout constants), `_oidc_state_cookie_name`, the email-2FA gates and the callback type guards; auth.py carries `_request_is_https`, `_DUMMY_PASSWORD_HASH` and the LDAP-except rollback; aito.py's limiter has `_peer_is_private`, `_track_rate_net_key` and `_TRACK_RATE_MAX_MISSES_PER_NET`. Expect conflicts in mfa.py/auth.py at the next upstream merge.
- **Python `ipaddress` note:** `is_private` is True for the TEST-NET ranges (203.0.113.0/24, 2001:db8::/32) that the tracking tests use as placeholder visitors; use 1.2.3.4 / 8.8.8.8 for "public" fixtures.
- 15 TRIAGE.md leads (above).

## State files (untracked, live only in this worktree)
PLAN.md, TRIAGE.md, BASELINE.md, VERDICTS.log, findings-audit-*-r{1,2}.json, already-filed-audit-*.txt, PLAN.campaign13.md — copy them out before removing the worktree (campaign 13 archived them as a tracked `refactor-campaign13-archive/` directory after merging).
