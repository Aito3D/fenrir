# PLAN (schema v2)

## T-001
priority: P2
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: HeimdallNotFound recovery (rollback -> _replace_lost -> nested rate-limit/upstream handling) is duplicated verbatim between reconcile_project and _run_pass's poll loop
files: backend/app/services/aito_payment_links.py
evidence: backend/app/services/aito_payment_links.py:525 · reconcile_project's `except HeimdallNotFound as exc:` block (lines 525-541: log, `await db.rollback()`, guard `project_id is None`, then `try: await _replace_lost(...) except HeimdallRateLimited: raise except (HeimdallUpstreamError, SQLAlchemyError) as exc2: log, rollback, await _record_failure(...)`) is structurally identical to _run_pass's poll-loop `except HeimdallNotFound as exc:` block (lines 692-707), differing only in the log message's noun ("project %s" vs "row %s") and in how project_id is obtained (already in scope vs read off `row.project_id` first). Both exist because a lost link can be discovered either by the reconcile half or by the poll half of the same pass. A maintainer changing the lost-link recovery policy (e.g. adding a metric, changing which exceptions are swallowed, or fixing a bug in the nested try) has to remember to edit both copies — the second copy is the kind of thing that is easy to miss during a quick fix under `reconcile_project`. · fix: extract a private async helper, e.g. `_recover_lost_link(db, project_id, exc, *, now, pct, validity_days, today, log_subject)`, containing the rollback + `_replace_lost` + nested exception handling, and call it from both sites with a different `log_subject` string for the log line.
fingerprint: 19c38dc503674ecf
source: audit-cleanliness

## T-004
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: payment URL adopted verbatim from an unauthenticated Heimdall response in _to_view()
files: backend/app/services/heimdall.py
evidence: backend/app/services/heimdall.py:128 · `url=link.get("url"),` — no scheme, host or type check, unlike every sibling field which is at least `str()`-cast. The HMAC in `sign()` authenticates the REQUEST only; nothing authenticates the response, and the LAN guard deliberately permits plain HTTP (`assert_safe_lan_service_url` docstring: "Loopback (127.0.0.1) and RFC-1918 private ranges are deliberately **permitted**"; the Settings placeholder is `http://192.168.1.20:8081`, HeimdallSettings.tsx:138). That value is stored (`_adopt`: `row.url = view.url`, aito_payment_links.py:161), published unauthenticated to the customer (`aito_tracking.py:259` `AitoTrackingPayment(... url=row.url ...)` -> `TrackingPayment.tsx:45` `<a href={payment.url} target="_blank">`) and handed to the operator (`PaymentLinkRow.tsx:113` `<OpenLinkButton href={link.url}>`). Exploit: an attacker on the plain-HTTP LAN hop (ARP/DNS spoof, or a compromised POS host) answers one `POST /api/v1/payments` with `"link":{"url":"https://attacker.example/pay"}`; Bambuddy stores it and the customer who opens the tracking page for an accepted quote pays the attacker instead of the shop, while the operator's Copy button hands out the same URL. A `javascript:` value in the same field becomes stored script in the operator's authenticated session (React does not sanitize `href`). · fix: validate in `_to_view` before building the LinkView: require `url` to be a `str` whose `urlparse` scheme is `https` (or `http`) with a non-empty hostname, and raise `HeimdallUpstreamError` otherwise so the failure lands in `sync_error` instead of in a customer-facing anchor; separately document that `heimdall_base_url` should be https where the hop is not trusted · user-visible change: a link whose Heimdall-supplied URL is not an http(s) URL would stop rendering Open/Copy on the panel and stop appearing on the tracking page, showing a sync error instead — an operator testing against a stub that returns a non-HTTP url would newly see that error.
fingerprint: 0bdbf60fc1b26697
source: audit-security
reason: user-approved behavior change

## T-005
priority: P2
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: signed path is the raw interpolated one while httpx sends a normalised path (get_payment/patch_link/cancel_link)
files: backend/app/services/heimdall.py
evidence: backend/app/services/heimdall.py:259 · `await self._request(db, "GET", f"/api/v1/payments/{heimdall_id}")` (also lines 253 and 256) interpolates `heimdall_id` raw, and line 194 signs that exact string — `sign(method, path, body, secret, ...)` — while line 202 hands `f"{base_url}{path}"` to httpx, which normalises and percent-encodes it. `snapshots/heimdall-wire.golden` proves the divergence: `get_payment-id-with-space` signs `"path": "/api/v1/payments/hd 1"` but puts `"url": "http://pos.local:8081/api/v1/payments/hd%201"` on the wire, and `get_payment-id-with-slash` (probe input `"hd-1/../ping"`) signs the dotted form but sends `"path": "/api/v1/payments/ping"`. heimdall/docs/API.md, Signing: "Normalise **before** signing, not after ... so a space or a `..` cannot be signed in one form and sent in another by `fetch`" — Heimdall verifies over `request.url` as received. Failure path (fail-closed, not a bypass): any `heimdall_id` Heimdall hands back containing a space, `#` or a dot segment, or a `heimdall_base_url` saved with a path prefix (the field only documents "origin only", nothing rejects a path — `snapshots/payment-link-api.golden` step `11-test-url-guard-07-http://pos.local:8081/../../etc` is accepted with `reachable: true`), makes every subsequent GET/PATCH/cancel for that link a permanent `401 Invalid request signature`; `_fail` then backs the row off forever, so a payment the customer has already made is never polled as `paid`, never credited, and the quote is never auto-accepted. · fix: normalise before signing: parse `f"{base_url}{path}"` once (e.g. `httpx.URL(...)`), sign `url.raw_path` (path + query) and send that same `httpx.URL` object, so the signed bytes and the wire bytes cannot differ; reject a `heimdall_base_url` carrying a path in the settings validator
fingerprint: 93f96f0d2740cfb6
source: audit-security

## T-006
priority: P2
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: HeimdallNotConfigured is not a HeimdallUpstreamError, so a malformed token aborts every reconcile pass silently
files: backend/app/services/heimdall.py
evidence: backend/app/services/heimdall.py:34 · `class HeimdallNotConfigured(Exception):` — verified `issubclass(HeimdallNotConfigured, HeimdallUpstreamError) is False`. `is_configured()` (line 158) only calls `_load_config`, which checks non-emptiness alone (`if not base_url or not token`), so a token saved in the wrong shape passes it: `parse_credential('hmd_live.abc')` raises `HeimdallNotConfigured`. That raise happens inside `_request` (line 185), i.e. AFTER `reconcile_payment_links`' `is_configured` gate (aito_payment_links.py:607), and is caught by NONE of `reconcile_project`'s handlers (`except HeimdallRateLimited` / `except HeimdallNotFound` / `except (HeimdallUpstreamError, SQLAlchemyError)`, lines 523-542) nor by `_run_pass`' per-project `except SQLAlchemyError` (line 666). Failure path: an operator pastes only the secret, or a credential truncated at the second dot (the field is `type="password"` and write-only, so it is never echoed back for them to check) — every tick the pass dies on the FIRST project, `_record_failure` never runs, no row gets a `sync_error`, `PaymentLinkRow` renders nothing at all, and the only trace is one `logger.exception("Payment-link reconcile failed")` line in aito_quote_sync.py:2329. Every quote silently goes without a payment link. · fix: have `is_configured`/`_load_config` run `parse_credential` so a malformed credential reports "not configured", and add `HeimdallNotConfigured` to the `except` tuples in `reconcile_project` and `_run_pass` so it is recorded on the row like any other Heimdall failure instead of escaping the pass
fingerprint: 001bdeeae1b4cdf7
source: audit-security

## T-007
priority: P2
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: unclamped Retry-After lets one 429 disable the whole reconciler for the process's life
files: backend/app/services/heimdall.py
evidence: backend/app/services/heimdall.py:139 · `return max(0.0, float(value))` — verified `_parse_retry_after('inf') == inf` and `_parse_retry_after('1e9') == 1000000000.0`; there is no upper bound. `aito_payment_links.py:89` does `_throttled_until = time.monotonic() + (retry_after if retry_after and retry_after > 0 else 60.0)`, and the guard at line 609 (`if _throttled_until is not None and time.monotonic() < _throttled_until: return 0`) returns before anything can reset it — `_throttled_until = None` (line 670) is only reachable INSIDE a pass that got past that guard. Exploit: any party that can answer as Heimdall for one request — a MITM on the plain-HTTP hop, a misbehaving reverse proxy or WAF in front of it, or Heimdall itself with a bad header — returns `429` with `Retry-After: inf` (or `1e9`), and every mint, patch, cancel and poll stops permanently until the process restarts. Consequence is money-shaped, not just availability: a link the customer has already paid is never polled to `paid`, so `_became_paid`/`accept_quote` never run and the quote stays 'sent' forever. API.md's own rate-limit window is per minute, so no legitimate value is anywhere near this. · fix: clamp in `_parse_retry_after` — reject non-finite values and cap at a sane ceiling (e.g. `min(float(value), 3600.0)`), and log the armed stand-down duration at WARNING so an operator can see it
fingerprint: 825db4e0125a5b4a
source: audit-security

## T-008
priority: P3
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: POST /heimdall/test signs a ping with the SAVED credential when only base_url is overridden
files: backend/app/api/routes/heimdall.py
evidence: backend/app/api/routes/heimdall.py:33 · `overriding = payload.base_url is not None and payload.token is not None` and then line 37 `await heimdall_service.ping(db, base_url=payload.base_url, token=payload.token)`. With a `base_url` but no `token`, `overriding` is False but the override still reaches `_request`, whose fallback is `base_url = base_url or cfg_url; token = token or cfg_token` (heimdall.py:181-183) — so the SAVED live secret keys a signature that is sent to the caller-chosen host, along with the public `X-Heimdall-Key-Id`. A caller with `settings:update` (including an API key holding it) therefore gets a repeatable blind-SSRF probe against any host the LAN guard allows, with no persisted setting and no audit trail, plus a harvested single-use `GET /api/v1/ping` signature valid for 300 s against the real Heimdall. `snapshots/payment-link-api.golden` confirms the guard's permissiveness here by design (`11-test-url-guard-04-http://localhost:8081`, `-11-http://192.168.1.50:8081`, `-13-http://8.8.8.8:8081` all answer 200). · fix: require both overrides together or neither — when `payload.token is None`, ignore `payload.base_url` and ping the saved pair (or reject with 422) so the saved secret is only ever presented to the saved host · user-visible change: clicking "Test connection" after editing only the URL field, with the token box left blank, would stop testing the typed URL — it would test the saved URL instead (or return a validation error), so an operator verifying a new host must re-paste the credential first.
fingerprint: 599aa59c608a462b
source: audit-security
reason: user-approved behavior change

## T-009
priority: P0
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: reconcile_project completes a reservation without re-checking wanted_link, minting a live link for a dead quote
files: backend/app/services/aito_payment_links.py
evidence: backend/app/services/aito_payment_links.py:463 · `if row.heimdall_id is None:` / `await _complete(db, project, row, now=now, kind="payment_link.created")` / `return` — the reservation branch runs BEFORE any use of `wanted` and ignores it entirely. Sequence: pass 1 commits a reservation and the POST fails (network/429/500); the operator then trashes the project, the client declines, or the quote gets invoiced; pass 2 re-reads the row, sees `heimdall_id is None`, and POSTs anyway. I confirmed this against the real reconciler with the test suite's FakeHeimdall for all three kills (`status='deleted'`, `quote_status='declined'`, `quote_invoiced=True`): every one produced `calls [('create','aito:1:1','DEV-2026-1234',12500,15)]`, `heimdall_id L1`, `url https://osb/pay/L1` and a `payment_link.created` story event. A second pass then cancels it (`PASS2 status cancelled`), so the window is one tick — 300 s (`_TICK_SECONDS`) at best, and unbounded if the process is down, or if the reconcile half aborts on a 429 (`except HeimdallRateLimited` at line 711) before reaching that project again. During that window the panel renders Open/Copy for it (`live = (link.state === 'pending' ...) && !!link.url`) and anyone holding the URL can pay a quote that was already declined or already invoiced — for `quote_invoiced` the shop collects money against a document it has already invoiced separately. · fix: in the reservation branch, re-evaluate `wanted`: only `_complete` when `wanted is not None` and its reference/amount still match the row; otherwise supersede the reservation (and, if it may already exist at Heimdall, complete-then-cancel under the same key rather than abandoning it blind) · user-visible change: a reservation left over a quote that has since been declined, invoiced or trashed would no longer produce a live link and a `payment_link.created` timeline entry; the card would show no link at all instead of one that appears for one tick and is then cancelled
fingerprint: 2f1af2bdd965d1ea
source: audit-robustness
reason: user-approved behavior change

## T-010
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: link_view hides a reservation's sync_error, so a mint that can never succeed is invisible in the panel and its Retry is unreachable
files: backend/app/services/aito_payment_links.py
evidence: backend/app/services/aito_payment_links.py:723 · `if row is None or row.heimdall_id is None: return None` — a reservation is reported to the API as no link at all, together with its stored `sync_error`. `PaymentLinkRow.tsx:50` then does `if (!link) return null;`, and the Retry button only exists inside `{link.sync_error && ...}` (line 141), so the one case that most needs Retry can never offer it. I drove three forced passes with `create_link` raising the contract's permanent link refusal (`Heimdall HTTP 422 invalid_request: reference matches no document` — API.md POST /api/v1/payments: a `reference` with no DEV/FA/RET prefix or matching no Books document is 422, forever): the row ends up `('aito:1:1', heimdall_id=None, 'pending', superseded_at=None, sync_failures=3, 'Heimdall HTTP 422 invalid_requ...')`, `link_view(...)` returns `None`, and `events []`. Nothing but a `logger.warning` exists anywhere a human looks. `snapshots/payment-link-api.golden` steps `27-refresh-upstream-500`, `28-refresh-unreachable` and `29-refresh-upstream-429` confirm it end-to-end: all three answer `200` with `payment_link: null`, so an operator clicking Retry three times is told nothing happened and nothing is wrong, while the quote silently has no payable link. · fix: let `link_view` emit a reservation-state view (no url, no amount to copy) carrying `sync_error`, and have `PaymentLinkRow` render that state with its Retry; alternatively record a `payment_link.failed` story event once the failure count crosses a threshold so the timeline shows it · user-visible change: `GET /aito/projects` would start returning a non-null `payment_link` for a quote whose link was never minted, and the panel would show an error line plus a Retry button where it currently shows nothing
fingerprint: 7e7a05dc49bd560e
source: audit-robustness
reason: user-approved behavior change

## T-011
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: a PATCH that Heimdall accepts but does not apply makes the drift branch re-PATCH every tick forever, with no error and no backoff
files: backend/app/services/aito_payment_links.py
evidence: backend/app/services/aito_payment_links.py:500 · `if not _fields_match(row, wanted):` -> `view = await heimdall_service.patch_link(...)` -> `_adopt(row, view, now)`, and `_adopt` unconditionally does `row.amount = view.amount` / `row.sync_error = None` / `row.sync_failures = 0`. So a 2xx whose body still carries the old amount (Heimdall clamped it, answered from a stale read, or the change did not stick) leaves the row un-converged AND resets the failure counter, so `_in_backoff` is False forever. I confirmed it: with a `patch_link` that returns 200 but keeps `amount=12500` while the quote wants 20000, four passes produced four identical calls — `[('patch','L1',20000,None)] x 4` — and the row after them is `amount 12500, sync_failures 0, sync_error None, events ['payment_link.created']`. In production that is one wasted PATCH per drifted project per 300 s tick indefinitely, spending Heimdall's 60 req/min per-key budget (API.md, Rate limits) until the pass starts tripping 429s, while the operator's panel shows a perfectly healthy link for the WRONG amount and the client is offered that wrong amount. `snapshots/payment-link-reconcile.golden` scenario `04-amount-drift` shows the matching blind spot on the success path too: `events: []`, so an amount change a client already saw is never recorded anywhere. · fix: after `_adopt`, verify the returned view actually matches `wanted` and treat a non-converging PATCH as a failure (`_fail`, so the backoff and `sync_error` engage) with a cap; record a story event for an applied amount change · user-visible change: an amount or expiry change would start appearing in the project timeline, and a link Heimdall refuses to converge would start showing a sync error and backing off instead of looking healthy
fingerprint: 415178bf477fdb6d
source: audit-robustness
reason: user-approved behavior change

## T-012
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: expires_on records the expiry we asked for, never the expires_at Heimdall confirmed, so a clamped or swallowed date is a permanent silent lie
files: backend/app/services/aito_payment_links.py
evidence: backend/app/services/aito_payment_links.py:511 · `row.expires_on = wanted.expires_on` is written straight after `_adopt`, and `_adopt` (line 153) copies `view.id/status/amount/url` but never `view.expires_at` — `heimdall.py:129` parses `expires_at=link.get("expires_at")` into `LinkView` and nothing ever reads it. Meanwhile `expires_in_days` clamps: `return max(1, min(365, days))` (line 128). Traced with the real reconciler: a quote with `quote_expiry_date='2030-01-01'` POSTs `('create','aito:1:1','DEV-2026-1234',12500,365)` — a link that actually dies 365 days out — while the row stores `expires_on 2030-01-01`. Because `_fields_match` compares that stored value against `wanted.expires_on`, they agree forever and no later pass ever notices. The panel (`PaymentLinkRow.tsx:62-78`, `parseLocalDateKey(link.expires_on)`) and the public tracking page therefore promise the client a link valid until 2030 that OSB closes in 2027, and the client clicking it after that gets a dead link with the shop's own page still saying it is good. · fix: store the expiry Heimdall reports (`LinkView.expires_at`, normalised to its calendar day) as `expires_on`, and compare that against `wanted.expires_on` in `_fields_match` · user-visible change: the expiry shown in the panel and on the tracking page would change to the date the link really closes, which for a quote expiring more than 365 days out (or with an unparseable date) is an earlier date than today's display
fingerprint: c7c0936804749102
source: audit-robustness
reason: user-approved behavior change

## T-013
priority: P2
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: expires_in_days swallows an unparseable quote_expiry_date as a one-day link
files: backend/app/services/aito_payment_links.py
evidence: backend/app/services/aito_payment_links.py:125 · `try: days = (date.fromisoformat(expires_on) - today).days` / `except ValueError: days = 1`. `wanted.expires_on` is `project.quote_expiry_date or ...` (line 117) — a string copied off the Zoho estimate, never validated. Sequence: Books reports an expiry in any non-ISO shape (a locale format, a truncated value, `'2026-13-45'`); `expires_in_days` returns 1; the link Heimdall mints closes tomorrow instead of in the quote's validity window; `row.expires_on` keeps the unparseable string so `_fields_match` is satisfied and no pass revisits it. The operator sees `parseLocalDateKey` produce an Invalid Date in the panel — `daysLeft` is `NaN`, so neither `daysLeft > 0` nor `=== 0` holds and line 78 renders the `state.expired` string under a link that is live and copyable — and the client's link is dead the next day with no error recorded anywhere. · fix: validate `quote_expiry_date` where `wanted_link` builds `Wanted` and fall back to `today + validity_days` (the same default as a missing date) instead of collapsing to one day; log the rejected value · user-visible change: a quote with a malformed expiry date would get a link lasting the configured validity window instead of one day, and its panel row would show a real date instead of "expired"
fingerprint: cc73f846e705448c
source: audit-robustness
reason: user-approved behavior change

## T-014
priority: P2
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: permanent upstream refusals (401/403/422) are retried on the transient backoff forever
files: backend/app/services/aito_payment_links.py
evidence: backend/app/services/aito_payment_links.py:542 · `except (HeimdallUpstreamError, SQLAlchemyError) as exc:` -> `await _record_failure(db, project_id, exc, now)`. `HeimdallAuthError` is a subclass of `HeimdallUpstreamError` (`heimdall.py:42`), and a 422 raises the plain base class (`heimdall.py:221`), so the one code path that separates a permanent no from a transient one — `except HeimdallNotFound` at line 525 — is the only distinction the reconciler makes. `_fail` caps the wait at `_TICK_SECONDS * min(sync_failures, 6)` = 30 min, so a revoked or rotated Heimdall credential, or a `reference` that will never resolve in Books, is re-sent for every quote on the board every 30 minutes indefinitely. My 3-pass probe shows exactly that: `422 creates` lists three identical POSTs and `sync_failures` climbs to 3 with no terminal state. Nothing anywhere distinguishes "Heimdall says our key is dead" (which needs an operator in Settings) from "Heimdall was briefly unreachable" (which needs nothing) — and API.md's error table defines `unauthorized`/`forbidden`/`invalid_request` precisely so a client can stop. · fix: branch on `HeimdallAuthError` and on a 422 separately: mark the row terminally failed (or surface a configuration-level alarm) instead of feeding them into the transient backoff · user-visible change: with a dead credential or an unresolvable reference, the reconciler would stop re-calling Heimdall and the affected rows would show a terminal failure state instead of retrying every 30 minutes forever
fingerprint: 753af5de19e94d0e
source: audit-robustness
reason: user-approved behavior change

## T-015
priority: P2
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: reconcile_payment_links waits on _pass_lock with no timeout from inside a request handler
files: backend/app/services/aito_payment_links.py
evidence: backend/app/services/aito_payment_links.py:611 · `async with _pass_lock:` — an unbounded acquire. `routes/aito.py:3496` reaches it synchronously inside a request: `await reconcile_payment_links(db, only_project_id=project.id, force=True)`. A background tick that is already inside `_run_pass` can hold the lock for the whole reconcile half plus up to `MAX_POLLS_PER_TICK` (40) polls, each a fresh `httpx.AsyncClient(timeout=10.0)` (`heimdall.py:166`) — roughly 400 s with Heimdall slow, and longer with more drifted projects. Sequence: Heimdall goes slow, an operator clicks Retry, the POST blocks on the lock for minutes while still holding the request's `Depends(get_db)` session; the operator clicks again (the budget allows 10/minute) and each click parks another session and another hung request behind the same lock. The browser eventually times out with no answer, and the panel's `onError` toast says only "Error loading"; meanwhile the DB session pool is being consumed by requests that are doing nothing. · fix: wrap the acquire in `asyncio.wait_for` (or use `_pass_lock.locked()` to answer the request immediately with the row as it stands) so the handler returns promptly when a pass is already in flight · user-visible change: Retry would return immediately (reporting the current row) instead of blocking until a background pass finishes, so a click during a slow pass would no longer include that click's own Heimdall round trip
fingerprint: 94b65da4c84409fb
source: audit-robustness
reason: user-approved behavior change

## T-016
priority: P2
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: the reconcile half has no per-pass call budget and always visits projects in ascending id order, so a 429 starves the tail
files: backend/app/services/aito_payment_links.py
evidence: backend/app/services/aito_payment_links.py:643 · `project_ids = list((await db.execute(stmt.order_by(AitoProject.id))).scalars().all())` — every quoted, managed project, uncapped; only the poll half has a budget (`MAX_POLLS_PER_TICK = 40`, line 70). Heimdall's default is 60 requests/minute per key (API.md, Rate limits). Sequence: a settings change moves the deposit percentage, so every open quote drifts at once; the pass walks them in id order spending one or more calls each; around call 60 Heimdall answers 429, `HeimdallRateLimited` is re-raised out of `reconcile_project` (line 523) and caught by the pass's outer handler (line 711), which rolls back, arms the stand-down and returns — every project after that point is untouched. The next pass rebuilds the identical ascending-id list, so the same low-id projects spend the budget again and the high-id quotes never get their link. `snapshots/payment-link-reconcile.golden` scenario `17-rate-limited` shows what the aborted pass leaves behind: project 2's row is `heimdall_id: null, checked_at: null, sync_error: null, sync_failures: 0` — a reservation with no error stamped on it, which combines with `link_view` returning None to be wholly invisible. · fix: cap the reconcile half like the poll half, and order the candidate list so progress rotates (oldest `checked_at` first, or resume from where the previous pass stopped) instead of restarting at the lowest id · user-visible change: under rate-limit pressure the set of projects reconciled in a given tick would change — later-id quotes would start getting links, at the cost of low-id ones not being visited every single tick
fingerprint: 82d3641a5309e9c5
source: audit-robustness
reason: user-approved behavior change

## T-017
priority: P2
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: _to_view adopts the upstream url and id unbounded and untyped into fixed-width columns
files: backend/app/services/heimdall.py
evidence: backend/app/services/heimdall.py:128 · `url=link.get("url"),` — no `str()` coercion and no length bound, while `models/aito_payment_link.py:37` declares `url: Mapped[str | None] = mapped_column(String(500))`; likewise `id=str(data["id"])` (line 124) into `String(36)` (model line 30). Sequence: Heimdall (or anything answering on its base URL — the URL is operator-typed in Settings) returns `link.url` as a 5 000-character string or as a nested object. On SQLite the oversized string is stored silently and every consumer of `link_view(...).url` — the panel's Copy button and the public tracking page — gets it; the same row moved to Postgres raises `DataError` at commit. A non-string `url` fails at `_complete`'s `await db.commit()` (line 303), which raises `SQLAlchemyError`, gets rolled back into `_record_failure`, and is then retried under the same idempotency key against the same replayed payload forever — the link exists at Heimdall and the ledger can never adopt it. · fix: validate in `_to_view`: require `url` to be a string, bound it (and `id`, `reference`, `status`) to the column widths, and raise `HeimdallUpstreamError` when it does not fit rather than passing it to the ORM · user-visible change: an upstream payload with an oversized or non-string url/id would surface as a Heimdall upstream error on the row instead of being stored (SQLite) or crashing the commit (Postgres)
fingerprint: 26eab9467f8e4c0d
source: audit-robustness
reason: user-approved behavior change

## T-018
priority: P2
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: the 429 stand-down and the pass lock are process-local, and nothing outside a code comment states the single-process requirement
files: backend/app/services/aito_payment_links.py
evidence: backend/app/services/aito_payment_links.py:77 · `_throttled_until: float | None = None` and `_pass_lock = asyncio.Lock()` are module globals; the comment at line 82 says "Single-process app, so a lock is the whole fix — no partial unique index, no migration", so the DB has no guard of its own. The Dockerfile CMD (`exec uvicorn backend.app.main:app --host ... --port ...`) neither passes nor forbids `--workers`, and no deployment doc records the constraint. Sequence with two workers (or two containers on the same database): both ticks fire, both run `current_link` for a project with no row, both see None, both `_create` a reservation — `_next_key` derives `aito:{pid}:{n}` from a plain `SELECT` count (line 205), so both compute the same n and one commit dies on the unique index while the other's link is minted; or both compute different n and TWO live links exist at OSB for one quote, only one of which the ledger tracks as current. Separately, one worker's 429 stand-down leaves the other hammering Heimdall past its own backoff. · fix: enforce the invariant in the database (a partial unique index on `project_id` where `superseded_at IS NULL`, and `_next_key` from `MAX(id)` rather than a count) or add an explicit startup assertion/deployment note that more than one worker is unsupported
fingerprint: 990e4c37d3329dfd
source: audit-robustness

## T-019
priority: P3
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: the Retry mutation discards the backend's error detail
files: frontend/src/components/aito/PaymentLinkRow.tsx
evidence: frontend/src/components/aito/PaymentLinkRow.tsx:47 · `onError: () => showToast(t('common.errorLoading'), 'error'),` — every failure of `POST /aito/{id}/payment-link/refresh` renders the same generic "error loading" toast. `snapshots/payment-link-api.golden` shows the endpoint's 429 body is `{"detail": "Too many payment link refreshes. Please wait a moment and try again."}`; an operator who clicks Retry past the 10-per-minute budget is told the page failed to load rather than to wait, and clicks again. A 403 (missing `aito:update`) and a 404 (project trashed under them) are equally indistinguishable. · fix: surface `error.message` (the API client already carries `detail`) with the generic string only as a fallback · user-visible change: the Retry toast would show the server's own message, e.g. the rate-limit wording, instead of the generic "error loading" text
fingerprint: b54931a17211ed9d
source: audit-robustness
reason: user-approved behavior change

## T-020
priority: P1
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: heimdall_id is embedded unescaped into the signed path for patch_link/cancel_link/get_payment — no test covers an id needing percent-encoding
files: backend/app/services/heimdall.py
evidence: backend/app/services/heimdall.py:253 · backend/app/services/heimdall.py:253,256,259 build `path` as `f"/api/v1/payments/{heimdall_id}"` and that exact string is both signed (`sign(method, path, ...)` at line 194) and concatenated into the request URL (`f"{base_url}{path}"` at line 202) — never through `urllib.parse.quote`. httpx re-encodes unsafe characters when it parses that string into a URL: `httpx.URL('http://x/api/v1/payments/6f 1e').raw_path == b'/api/v1/payments/6f%201e'` (verified live in this worktree's venv). So if Heimdall ever returns/accepts a payment id containing a space (or any character httpx percent-encodes), the signature is computed over the raw path but the bytes actually sent carry the encoded path — Heimdall's own signature check (over what it received) would then disagree with ours, and we would only ever see this as an opaque `401 Invalid request signature`. `snapshots/heimdall-wire.golden` calls out exactly this scenario (`get_payment-id-with-slash`, `get_payment-id-with-space`) as worth pinning, but `test_heimdall_client.py::test_patch_cancel_get_hit_the_right_paths` (line 199) only ever uses the innocuous id `"6f1e"`, so a regression that stopped signing the exact wire path (or a Heimdall-side id format change) would ship green. · fix: in backend/tests/unit/test_heimdall_client.py, add a case to test_patch_cancel_get_hit_the_right_paths (or a new test) that calls patch_link/cancel_link/get_payment with a heimdall_id containing a space and/or slash, captures the actual request.url.raw_path the MockTransport receives, and asserts the X-Heimdall-Signature was computed over that same encoded path — not the raw f-string.
fingerprint: be48cfb326c5133b
source: audit-tests

## T-021
priority: P2
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: test_sign_matches_the_documented_recipe re-derives its own expected signature from the same recipe under test
files: backend/tests/unit/test_heimdall_client.py
evidence: backend/tests/unit/test_heimdall_client.py:71 · `_canonical_hmac` (line 67-68) does `hmac.new(secret, "\n".join(lines).encode(), hashlib.sha256).hexdigest()` — the exact six-line HMAC-SHA256 recipe `sign()` itself implements — and `test_sign_matches_the_documented_recipe` (line 71-84) computes its expected value with that helper. Any internally-consistent-but-wrong recipe (wrong line order, wrong hash, a 5-line signer) would still make `sign()` and `_canonical_hmac()` agree, so this test cannot fail for the exact defect class it claims to guard ("the documented recipe"). The adjacent `test_sign_reproduces_the_contracts_worked_example` (line 100) already does this correctly, asserting against the literal `sha256=a1bb7a33...` constant published in heimdall/docs/API.md — so the coverage gap this test implies is already closed by its neighbour, but the vacuous test itself remains and would mislead a future reader (or a coverage/mutation report) into thinking it independently pins the recipe. · fix: in backend/tests/unit/test_heimdall_client.py, delete test_sign_matches_the_documented_recipe (or rewrite it to assert against a literal precomputed hex digest, the same way test_sign_reproduces_the_contracts_worked_example does) so it cannot pass for an internally-consistent wrong recipe.
fingerprint: 2620806cb5571801
source: audit-tests

## T-022
priority: P2
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: the 404-replacement's OWN failure (create_link erroring right after a lost link is discovered) is never exercised, in either the reconcile pass or the poll pass
files: backend/app/services/aito_payment_links.py
evidence: backend/app/services/aito_payment_links.py:538 · coverage: backend/app/services/aito_payment_links.py missing_lines includes 533,536-541 (reconcile_project's `except HeimdallNotFound` -> `_replace_lost` -> `except (HeimdallUpstreamError, SQLAlchemyError) as exc2: ... await _record_failure(...)`) and 699,702-710 (the identical shape inside `_run_pass`'s poll loop). `rg -n 'test_a_link_lost_at_heimdall|test_a_lost_link' backend/tests/unit/test_aito_payment_links.py` finds three tests (lines 804, 838, 862) and all three let the replacement's `create_link`/`cancel_link` succeed via the `fake` Heimdall double — none makes the replacement call itself raise. If a bug in this branch left the session dirty, recorded the failure on the wrong project, or dropped the `HeimdallRateLimited` re-raise (so a 429 during a replacement stopped propagating to the pass's throttle handler), every test in the suite would stay green while a project whose link was lost at Heimdall AND whose replacement also failed would silently end up with no live payment link and no visible sync_error. · fix: in backend/tests/unit/test_aito_payment_links.py, add a test alongside test_a_link_lost_at_heimdall_is_replaced_in_the_same_pass where, after `fake.forget("L1")`, the fake's create_link is made to also raise HeimdallUpstreamError (and separately HeimdallRateLimited) for the replacement, and assert the old row still ends up `failed` with sync_error recorded (and, for the rate-limit case, that reconcile_payment_links's throttle is armed) — one variant reached via reconcile_project (the reconcile half) and one via poll_link's 404 (the poll half, around line 862's scenario).
fingerprint: 23206c9b37aa0213
source: audit-tests

## T-023
priority: P2
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: _to_view's malformed-shape guard (missing/wrong-typed id, status or amount) is never exercised
files: backend/app/services/heimdall.py
evidence: backend/app/services/heimdall.py:131 · coverage: backend/app/services/heimdall.py missing_lines includes 131-132 — the `except (KeyError, TypeError, ValueError) as e: raise HeimdallUpstreamError(...)` around `_to_view`'s construction of `LinkView`. Every test in test_heimdall_client.py builds its response body from `_link_json()` (line 39), which always includes valid `id`/`status`/`amount` keys with the right types; `rg -n 'del.*\[.\]|amount.*=.*"' backend/tests/unit/test_heimdall_client.py` finds no case that omits a field or sends `amount` as a non-numeric string. `amount` is the money value the reconciler stores on the ledger row via `_adopt` (aito_payment_links.py:156) — if Heimdall ever answers with `amount` as a string like `"12500"` and a future refactor changed `int(data["amount"])` to something that silently coerces instead of raising, or if the exception mapping here is broken, no test would notice, and a malformed upstream response would either crash uncaught or silently store a wrong amount. · fix: in backend/tests/unit/test_heimdall_client.py, add a test that returns a 201/200 body missing `id` (or with `amount` as a non-numeric string) and asserts `heimdall_service.create_link`/`get_payment` raises HeimdallUpstreamError with a message naming the offending field.
fingerprint: 15b025e4f5afd84c
source: audit-tests

## T-024
priority: P2
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: _parse_retry_after's missing-header and unparseable-value branches are untested, and both feed the 429 stand-down duration
files: backend/app/services/heimdall.py
evidence: backend/app/services/heimdall.py:140 · coverage: backend/app/services/heimdall.py missing_lines includes 137 (`if not value: return None`) and 140-141 (`except ValueError: return None`). The only test that exercises HeimdallRateLimited, test_error_envelope_maps_to_exception_classes (line 221-249), always sends `headers={"Retry-After": "7"}` — a clean numeric value. `_parse_retry_after(None)` (no header at all) and `_parse_retry_after("garbage")` (a non-numeric header) are never called. Both results flow straight into `_arm_throttle` in aito_payment_links.py (`retry_after if retry_after and retry_after > 0 else 60.0`), which decides how long the WHOLE reconciler stands down after a 429 — a bug that made a missing/garbage Retry-After produce a huge or negative throttle window (instead of falling back to the documented 60s) would ship undetected. · fix: in backend/tests/unit/test_heimdall_client.py, add cases to test_error_envelope_maps_to_exception_classes (or a dedicated test) for a 429 with no Retry-After header and one with Retry-After: "not-a-number", asserting `HeimdallRateLimited.retry_after is None` in both.
fingerprint: abece2c821c285c7
source: audit-tests

## T-025
priority: P2
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: the clipboard-failure toast and the Retry-mutation failure toast are never exercised — both paths are permanently mocked to succeed
files: frontend/src/__tests__/components/AitoPaymentLinkRow.test.tsx
evidence: frontend/src/__tests__/components/AitoPaymentLinkRow.test.tsx:10 · line 10: `vi.mock('../../utils/clipboard', () => ({ copyTextToClipboard: vi.fn(async () => true) }))` — hard-coded to always resolve `true` for every test in the file, so `PaymentLinkRow.tsx`'s `copy()` else-branch (`showToast(t('common.errorLoading'), 'error')`, PaymentLinkRow.tsx line 57) is never reached; `rg -n 'mockResolvedValueOnce\(false\)|mockImplementationOnce' frontend/src/__tests__/components/AitoPaymentLinkRow.test.tsx` finds nothing. Separately, the file's one Retry test (line 86-93, `test('a sync error shows the text and a retry that hits the refresh route')`) mocks `/api/v1/aito/12/payment-link/refresh` to always return 200 with `HttpResponse.json(project())`, so the mutation's `onError: () => showToast(...)` (PaymentLinkRow.tsx line 47) is never triggered either. A regression that broke either error toast — e.g. swallowing the clipboard failure silently, or crashing instead of toasting when the Retry network call fails — would leave every test in this file green. · fix: in frontend/src/__tests__/components/AitoPaymentLinkRow.test.tsx, add a test that makes the mocked copyTextToClipboard resolve false for one call and asserts the error toast renders instead of the 'Copied' confirmation, and a test that makes the refresh route return a 500/network error and asserts the error toast (not a crash) is shown.
fingerprint: ab1ccb5094a1ce4e
source: audit-tests

## T-026
priority: P1
status: OPEN
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: fix known-broken test test_delete_folder_removes_managed_files_from_disk without changing behavior
files: backend/tests/integration/test_library_api.py:188
evidence: Failing at BASE, deterministically and in isolation (2.15s, fails alone with -p no:randomly, so not a load flake): backend/tests/integration/test_library_api.py::TestLibraryFoldersAPI::test_delete_folder_removes_managed_files_from_disk, AssertionError at test_library_api.py:188. Recorded in BASELINE.md known_broken; the verifier only fails on NEW failures beyond it. Out of the campaign's payment-link SCOPE but in scope for fixing per SETUP step 7 (pre-existing failures are filed exactly once, here). Fix the test or the code it covers WITHOUT changing behavior; if the production behavior is actually wrong, stop and report rather than editing the assertion to match.
fingerprint: 
source: survey

