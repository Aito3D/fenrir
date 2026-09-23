# PLAN (schema v2)

## T-001
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: The public-page outer wrapper div is hand-copied 4 times across the two tracking pages
files: frontend/src/pages/AitoTrackPage.tsx
evidence: frontend/src/pages/AitoTrackPage.tsx:153 · `grep -n "min-h-screen bg-aito-midnight" frontend/src/pages/AitoTrackPage.tsx frontend/src/pages/AitoTrackEntryPage.tsx` -> four byte-identical hits: AitoTrackPage.tsx:153 (the 404 branch) and :183 (the main return), AitoTrackEntryPage.tsx:132 (the !ready branch) and :145 (the main return), all `<div className="min-h-screen bg-aito-midnight pt-[64px] pb-[48px] text-aito-ink">`. Every other repeated primitive on these two pages (the card shell, focus ring, press feedback, delayAt helper) was already hoisted into `CARD`/`FOCUS`/`PRESS`/`delayAt` in utils/trackingShell.ts and the Logo/CardSkeleton/Footer pieces in components/aito/trackingShell.tsx — this one outer wrapper was left behind. · fix: Add a `PAGE` (or `SCREEN`) class-string constant next to `CARD` in utils/trackingShell.ts and use it at all four call sites instead of retyping the literal.
fingerprint: 4b0f0794e66aa2a3
source: audit-cleanliness

## T-002
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: TrackingPayment and TrackingInvoice duplicate the same 'paid' markup and the same terms-toggle button classes
files: frontend/src/components/aito/TrackingPayment.tsx
evidence: frontend/src/components/aito/TrackingPayment.tsx:24 · TrackingPayment.tsx:24-31 (paid branch): `<div data-testid="track-payment" data-state="paid" className="text-[15px]"><div className="flex items-center gap-[8px]"><span className="h-[8px] w-[8px] shrink-0 rounded-full bg-green-500" aria-hidden="true" /><span className="font-semibold text-aito-ink">{...}</span></div><p className="mt-[4px] text-[13px] text-aito-muted">{...}</p></div>` is structurally identical (same wrapper class, same dot size/shape, same title/sub layout) to TrackingInvoice.tsx:19-27's paid branch, differing only in the dot colour source and text source. Separately, TrackingPayment.tsx:39 composes a `button` constant then applies it at line 58 as `` `${button} border text-aito-cyan hover:bg-aito-cyan/10 active:bg-aito-cyan/15 ${terms.open ? 'border-aito-cyan/60 bg-aito-cyan/12' : 'border-aito-cyan/35'}` `` for the 'See payment terms' button; TrackingInvoice.tsx:46 writes out the same full set of utility classes inline: `inline-flex min-h-[44px] w-full shrink-0 items-center justify-center whitespace-nowrap rounded-[8px] border px-[16px] text-[13.5px] font-semibold text-aito-cyan transition-[color,background-color,border-color,transform] duration-150 hover:bg-aito-cyan/10 active:scale-[0.97] active:bg-aito-cyan/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aito-cyan min-[400px]:w-auto ${terms.open ? ...}` — the same class set, just not composed from a shared source. TrackingInvoice.tsx's own docstring even says it 'Mirrors TrackingInvoice/TrackingPayment... so the two read as the same kind of thing', confirming the duplication is structural, not coincidental. · fix: Extract the shared 'paid state' row (dot colour + title + sub) into one small component parameterised by dot colour and copy, and lift the terms-toggle button's class string into a shared constant (e.g. `TERMS_BUTTON_CLS` in utils/trackingShell.ts) that both TrackingPayment.tsx and TrackingInvoice.tsx import.
fingerprint: b0d83804dfd05adc
source: audit-cleanliness

## T-004
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 1
title: useSheetDrag() — the phone bottom-sheet drag-to-dismiss gesture has no test at all
files: frontend/src/components/aito/TrackingPanel.tsx
evidence: frontend/src/components/aito/TrackingPanel.tsx:97 · coverage: frontend/src/components/aito/TrackingPanel.tsx 66.66% stmts, missing 112-116,123-125 (verified via `vitest run ... --coverage.include=TrackingPanel.tsx`: stmts [103-106,112-116,123-126,131], branches on every `if` inside onPointerDown/onPointerMove/onPointerEnd) | `rg -n 'onPointerDown|onSheetDrag|SHEET_QUERY' frontend/src/__tests__` -> no matches outside the component itself. The whole `useSheetDrag` function (lines 97-134) — the SHEET_QUERY/REDUCE_QUERY gate, the 1:1 drag-follow transform, the `--track-sheet-progress` custom property, and the dismiss decision `velocity > 0.45 || dy > offsetHeight*0.45` — is exercised by zero tests. · fix: in a new frontend/src/__tests__/components/AitoTrackingPanel.test.tsx, render <TrackingPanel> directly, mock window.matchMedia to report the sheet breakpoint as active, and drive fireEvent.pointerDown/pointerMove/pointerUp (or pointerCancel) on the header row to assert: (a) below the sheet breakpoint or under reduced motion the drag is a no-op, (b) a drag past 45% of offsetHeight or a fast downward flick calls onClose, (c) a short drag springs back (onClose not called) and clears the inline transform/transition
fingerprint: 36f7896e7f4a3ca1
source: audit-tests

## T-005
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: check()'s stale-response sequence guard is untested on both the success and the error branch
files: frontend/src/pages/AitoTrackEntryPage.tsx
evidence: frontend/src/pages/AitoTrackEntryPage.tsx:103 · coverage: frontend/src/pages/AitoTrackEntryPage.tsx 95.31% stmts, missing 103,109,117 (verified: `vitest run AitoTrackEntryPage.test.tsx --coverage` -> coverage-final.json shows statement ids 40/47/53, exactly lines 103, 109, 117, with 0 hits). Line 103 `if (seq !== sequence.current) return;` (success path) and line 109 `if (seq !== sequence.current) return;` (catch/error path) are the guard the file's own docstring calls out by name ("each check carries a sequence number and only the latest may speak"), but no test in AitoTrackEntryPage.test.tsx issues two overlapping checks (e.g. type a full code, then edit it before the first response lands) for either the success or the failure response — every existing test lets exactly one `check()` call resolve per test. · fix: in frontend/src/__tests__/pages/AitoTrackEntryPage.test.tsx, add a case that fires a first full 6-char code against a delayed (msw `delay()`) 200 response, edits one character before it resolves (bumping `sequence.current`), lets the stale response land, and asserts the row does NOT flip to 'found'/navigate on the stale answer, plus the symmetric case where the stale response is a 404/500 and the row does NOT flip to 'error' either — both assert on the CURRENT (second) check's state, not the stale one's
fingerprint: 3ab539ee7f23ae05
source: audit-tests

## T-006
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: The pane's height-tween effect never runs its animate body in this suite — untested on any real layout
files: frontend/src/components/aito/TrackingPaymentMethods.tsx
evidence: frontend/src/components/aito/TrackingPaymentMethods.tsx:105 · coverage: frontend/src/components/aito/TrackingPaymentMethods.tsx 86.79% stmts, missing 112-121 (verified via targeted coverage run: statement ids 64-72, lines 112-121, and branch id 9 `if (to === from) return;` at line 111 taking only the true/early-return side). The switching-tabs test at frontend/src/__tests__/components/AitoTrackingPaymentMethods.test.tsx:93 ('moves between tabs with the arrow keys') and :68 ('shows one method at a time') both click through every tab, but jsdom reports `wrap.offsetHeight`/`wrap.scrollHeight` as 0 for every pane, so `to === from` (0===0) is true every time and the actual tween body — `wrap.style.height = from+'px'; ...; wrap.style.height = to+'px'` plus the `transitionend` cleanup listener at lines 112-121 — has literally never executed in this test suite. · fix: in frontend/src/__tests__/components/AitoTrackingPaymentMethods.test.tsx, before switching methods stub the wrap element's offsetHeight/scrollHeight (e.g. `Object.defineProperty(wrapEl, 'offsetHeight', {value: 120})` then a different scrollHeight after the switch) so `to !== from`, assert `wrap.style.height` is set to the `from` value synchronously then to `to`, and assert a dispatched `transitionend` event clears the inline height back to ''
fingerprint: f555a5d51236a52c
source: audit-tests

## T-007
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 2
title: copy()'s clipboard-failure early return is untested — a failed copy of the IBAN/reference could silently show no feedback and no test would catch a regression that shows 'Copied' anyway
files: frontend/src/components/aito/TrackingPaymentMethods.tsx
evidence: frontend/src/components/aito/TrackingPaymentMethods.tsx:58 · coverage: frontend/src/components/aito/TrackingPaymentMethods.tsx missing statement/branch at line 59 (`if (!(await copyTextToClipboard(value))) return;`) — verified via targeted coverage (`branches [...('4', 0, 59, 'if')...]`, `stmts [...('19', 59)...]`). Every copy test in frontend/src/__tests__/components/AitoTrackingPaymentMethods.test.tsx ('copies a row on press and confirms briefly on that row only', line 122) mocks `navigator.clipboard.writeText` to resolve, so `copyTextToClipboard` always returns true there; no test ever makes it fail. TrackingLinkControl (a sibling component) DOES cover this exact scenario for its own copy button (AitoTrackingLinkControl.test.tsx:181), so the same care was applied elsewhere but skipped for the payment-methods rows that copy the bank IBAN/RIB/transfer reference — arguably higher stakes since it's what a client types into their banking app. · fix: in frontend/src/__tests__/components/AitoTrackingPaymentMethods.test.tsx, add a case where `navigator.clipboard.writeText` rejects (and document.execCommand also returns false, mirroring AitoTrackingLinkControl.test.tsx's fallback simulation), click a copy row (e.g. the IBAN button), and assert the row never shows 'Copié' / never sets `data-copied`
fingerprint: e8432f1283bf2f8a
source: audit-tests

## T-008
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: The deposit-vs-full-amount wording is only ever tested for one deposit value per payment state — the other two combinations are unverified
files: frontend/src/components/aito/TrackingPayment.tsx
evidence: frontend/src/components/aito/TrackingPayment.tsx:28 · coverage: frontend/src/components/aito/TrackingPayment.tsx branches missing at line 28 (`t(payment.deposit ? 'depositPaidTitle' : 'paidTitle')`) and line 47 (`t(payment.deposit ? 'unpaidDepositSub' : 'unpaidSub')`) — verified via targeted coverage run (`branches [('1', 1, 28, 'cond-expr'), ('3', 0, 47, 'cond-expr')]`, each missing exactly one side). `rg -n 'deposit' frontend/src/__tests__/pages/AitoTrackPage.test.tsx` shows `deposit: true` used only with `state: 'paid'` (line 580) and `deposit: false` used only with `state: 'unpaid'` (lines 549, 561, 596, 589) — so a paid FULL payment (deposit:false) never asserts the plain 'paidTitle' wording, and an unpaid DEPOSIT invoice (deposit:true) never asserts 'unpaidDepositSub'. A copy/wording regression that swapped these — telling a client who paid the deposit that they paid in full, or vice-versa — would pass every existing test. · fix: in frontend/src/__tests__/pages/AitoTrackPage.test.tsx's 'AitoTrackPage — online payment' describe, add two cases: payment.state='paid', deposit=false asserting the plain paid title (not the deposit wording), and payment.state='unpaid', deposit=true asserting the deposit sub-line
fingerprint: 903af619e7a88b72
source: audit-tests

## T-010
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: Google Maps iframe in TrackingShopPanel downgrades the referrer policy and leaks the tracking code to google.com
files: frontend/src/components/aito/TrackingShopPanel.tsx
evidence: frontend/src/components/aito/TrackingShopPanel.tsx:71 · referrerPolicy="no-referrer-when-downgrade" — on `<iframe ... src={mapSrc ?? undefined}>` whose src is `https://www.google.com/maps?...&output=embed` (frontend/src/utils/aitoShop.ts:19). The document is served with `Referrer-Policy: strict-origin-when-cross-origin` (backend/app/main.py:9886), which would send only the origin; the per-element attribute overrides it with a weaker policy that, https→https, sends the FULL embedding-document URL. That URL is `https://<host>/t/<CODE>` — and the code IS the credential for the page (routes/aito.py get_tracking: "No auth: the token IS the credential"). Opening "Nous trouver" therefore hands the tracking code to a third party in the Referer header, where it also lands in that party's logs. · fix: set referrerPolicy="no-referrer" (or "origin") on the iframe; the embed is the keyless `output=embed` form per the aitoShop.ts comment, so confirm against a live load that it still renders without a Referer before landing · user-visible change: ORCHESTRATOR HOLD (auditor filed it as neutral): the map iframe would stop sending the page URL as Referer to google.com; if Google's keyless output=embed form requires a Referer the 'Nous trouver' map would stop rendering, and no automated gate here can tell — a live browser check is needed.
fingerprint: 1f8b0048c69f7a40
source: audit-security
reason: user-approved behavior change

## T-011
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 3
title: _track_rate_net_key buckets IPv6 sources per /64, so the per-network miss budget multiplies for any attacker holding a routed prefix
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1144 · prefix = 24 if addr.version == 4 else 64 — the docstring one line above claims "a flood spread over many addresses on one network still shares one budget". That holds for IPv4 (a /24 is 256 addresses and costs money) but not for IPv6: any VPS or hosting account is routed a /64 at minimum and commonly a /56 or /48, so _TRACK_RATE_MAX_MISSES_PER_NET (600/min, line 1117) is granted once per /64 the attacker owns — 65,536 budgets for a /48, i.e. ~39M guesses/min against a 32**6 ≈ 1.07e9 code space (services/aito_tracking.py TOKEN_ALPHABET/TOKEN_LENGTH). The per-address caps do not bind, because each /64 holds 2**64 addresses to spread across. This is the compensating control for the deliberately-short code, so its IPv6 half being ~65k× weaker than its IPv4 half is worth closing. · fix: collapse IPv6 hosts to a shorter prefix (a /48, or /56, is still one subscriber allocation) instead of /64, so one routed allocation maps to one budget the way a /24 does for IPv4
fingerprint: 5639728d6470b352
source: audit-security
reason: user-approved behavior change (IPv6 /48 keying, golden re-record sanctioned)

## T-012
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 4
title: _track_rate_net_key's `__no_ip_` fallback is per-request unique, so the tracking rate limiter is inert when request.client is None
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1136 · Docstring at 1135-1139: "A host that does not parse as an IP — the `__no_ip_...` placeholder `_get_client_ip` mints when there is no peer ... gets its own key equal to the raw host: fail closed, one bucket per source rather than one shared by everything unparseable." But that placeholder is minted fresh per request — backend/app/api/routes/auth.py:230 `direct_ip = request.client.host if request.client else f"__no_ip_{secrets.token_hex(8)}__"` — so every such request gets a brand-new, empty per-IP and per-net bucket and no cap can ever be reached. `request.client` is None whenever uvicorn's get_remote_addr cannot produce an (addr, port) tuple, which is exactly the case for a unix-socket bind (`uvicorn --uds`, a standard nginx→app deployment). On such an install the only compensating control for the guessable code is entirely absent, and the docstring asserts the opposite. · fix: detect the no-peer case explicitly (e.g. treat a host that does not parse as an IP as one shared, fixed bucket key such as "__no_ip__", or refuse the request) so it is genuinely fail-closed; correct the docstring either way
fingerprint: a500150da03f2763
source: audit-security
reason: user-approved behavior change (shared fail-closed no-peer bucket, golden re-record sanctioned)

## T-014
priority: P3
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 5
title: payment_state ships the Heimdall checkout URL on a PAID link, contrary to AitoTrackingPayment's own contract
files: backend/app/services/aito_tracking.py
evidence: backend/app/services/aito_tracking.py:263 · state="paid" if row.status == "paid" else "unpaid", url=row.url, deposit=(await deposit_pct(db)) > 0 — `url` is populated for both branches, but the schema documents it as the unpaid-only field: backend/app/schemas/aito.py:1278-1280 "The online payment link as the client sees it: a state and, while unpaid, the page to pay on." The public payload is deliberately state-only and never an amount (schemas/aito.py:1295 "A state, never an amount"), yet the checkout page the URL points at does show the amount. TrackingPayment.tsx returns early for `payment.state === 'paid'` and never renders the href, so the URL is pure over-disclosure to anyone who reads the JSON for a guessed code on a settled order. · fix: return url=None when row.status == "paid" in payment_state, matching the schema's documented contract · user-visible change: ORCHESTRATOR HOLD (auditor filed it as neutral): the public JSON for a paid order would carry payment.url = null instead of the Heimdall checkout URL; the page never renders it, but the tracking-backend and tracking-http golden probes pin the current value and would need a sanctioned re-record.
fingerprint: a3ca95645dad7e83
source: audit-security
reason: user-approved behavior change

## T-015
priority: P3
status: WONTFIX-AUTO
attempts: 0
round: 1
first_seen_iteration: 0
last_touched_iteration: 0
title: is_expired gives no expiry clock to the five production columns, so a card parked in scan/model/print/finish keeps a live code forever
files: backend/app/services/aito_tracking.py
evidence: backend/app/services/aito_tracking.py:230 · return False — reached for every column other than "done" and DORMANT_COLUMNS (line 46: `DORMANT_COLUMNS = frozenset({"devis", "waiting"})`). The module comment at 40-45 explains the dormant TTL was added because "with only Done expiring, abandoned quotes kept live codes forever and the guessable space slowly filled with them", but the same is still true for an order abandoned mid-production or never collected from "finish": its code never dies, and it keeps serving part names, quote reference, shipping island/waybill and the payment URL indefinitely into a guessable 30-bit space. · fix: extend the dormant-silence clock (TRACKING_TTL_DORMANT, or a separate longer TTL) to the production and finish columns so every column has a clock, keyed on last_activity as the dormant rule already is · user-visible change: a client whose order has sat untouched in a production or ready-for-pickup column past the TTL would find their tracking link starts returning the 'invalid link' page instead of their order, and would have to be sent a regenerated link.
fingerprint: af80f89e406df988
source: audit-security
reason: behavior change declined

## T-016
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 4
title: purge_tracking_views failure in run_sync_loop leaves the tick's session un-rolled-back
files: backend/app/services/aito_quote_sync.py
evidence: backend/app/services/aito_quote_sync.py:2386 · `try:\n await purge_tracking_views(db)\nexcept Exception as exc:\n logger.warning("Tracking-view purge failed: %s", exc)` — the handler logs but never rolls back, and `purge_tracking_views` ends in `await db.commit()` (services/aito_tracking.py:343). A commit that fails (SQLite "database is locked" against the request path / MQTT writers — the cascade #1112 documents) poisons the session: I confirmed with SQLAlchemy 2.0 + aiosqlite that the next statement on that session raises `InvalidRequestError: This session is in 'prepared' state; no further SQL can be emitted within this transaction`. The very next block on the same `db` is `await reconcile_payment_links(db)` (line 2396), so a failed purge silently costs that tick's whole payment-link reconcile, and its own `logger.exception("Payment-link reconcile failed")` reports the session error instead of the lock that actually caused it. · fix: call `await db.rollback()` inside the purge's except handler (contextlib.suppress around it), before the payment-link block runs
fingerprint: ac100a2d1cb0c1da
source: audit-robustness

## T-017
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 4
title: _track_rate_limited's per-IP CALLS cap becomes a 120/min site-wide cap behind an unconfigured proxy
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1214 · `len(calls) >= _TRACK_RATE_MAX_CALLS_PER_IP` is checked unconditionally, while the line below it (`or (not collapsed and len(misses) >= _TRACK_RATE_MAX_MISSES_PER_IP)`) suspends only the MISS cap for the collapsed-proxy case. With TRUSTED_PROXY_IPS unset (the documented default for an nginx-in-front install), `_get_client_ip` returns the proxy's own address for every visitor, so `_TRACK_RATE_MAX_CALLS_PER_IP = 120` is 120 requests per minute for the entire install — 5x tighter than the 600-miss per-net budget the collapse path was widened to rely on. A quote/SMS batch that lands a dozen clients on their pages at once (each load is one call, plus a refetch every time the phone's browser regains focus past the 30 s stale time) exhausts it, and every remaining client — holding a valid code printed on their own quote — gets `429 {"detail": "Trop de tentatives"}` and the page's "please wait" copy for the rest of the minute. · fix: in the `collapsed` branch, scale or suspend the per-IP calls cap the same way the per-IP miss cap is suspended, leaving the per-net miss budget as the bound · user-visible change: an install behind an unconfigured reverse proxy stops returning 429 to clients once it passes 120 tracking requests a minute, so the public page's site-wide request ceiling rises.
fingerprint: 5bcf88103274ce99
source: audit-robustness
reason: user-approved behavior change

## T-018
priority: P2
status: DONE
attempts: 1
round: 1
first_seen_iteration: 0
last_touched_iteration: 5
title: the i18n `settled` gate has no deadline, so a stalled locale chunk hides data that already arrived
files: frontend/src/pages/AitoTrackPage.tsx
evidence: frontend/src/pages/AitoTrackPage.tsx:76 · `if (ready) everReady.current = true;\nconst settled = everReady.current;` gates every rendered state — `{(query.isPending || !settled) && !query.isError && !retrying && <CardSkeleton />}` (line 198) and `const showContent = data !== undefined && copy !== null && settled` (line 134). A client with `navigator.language = fr-PF` (the page's primary audience) renders first with `ready === false` while the lazily imported `fr` chunk is fetched; that dynamic import has no timeout and no fallback, so a request that stalls rather than fails — the flaky mobile link the sibling `TRACK_TIMEOUT_MS = 10_000` comment was written for — leaves the client staring at a pulsing skeleton indefinitely, with no error, no Réessayer button and no way forward, even though the tracking data itself has already landed in the query cache. · fix: start a deadline alongside the language effect and force `settled` true when it expires (i18next falls back to the bundled English strings), the same shape as the query's TRACK_TIMEOUT_MS · user-visible change: a client whose locale bundle is slow past the deadline now sees the page in English instead of a skeleton that waits for the translation.
fingerprint: 13a75024e52d48b4
source: audit-robustness
reason: user-approved behavior change

## T-019
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 6
title: PAGE wrapper-class local is duplicated verbatim in AitoTrackPage and AitoTrackEntryPage
files: frontend/src/pages/AitoTrackPage.tsx
evidence: frontend/src/pages/AitoTrackPage.tsx:40 · git diff refactor-base..HEAD shows both files add the identical line `const PAGE = 'min-h-screen bg-aito-midnight pt-[64px] pb-[48px] text-aito-ink';` (AitoTrackPage.tsx:40, AitoTrackEntryPage.tsx:30) with near-identical comments ('The outer wrapper shared by every state of this page ... the same literal, not re-typed at each call site'). rg -n "const PAGE =" frontend/src -> only these two lines. · fix: hoist `PAGE` into utils/trackingShell.ts (additive export permitted per the current scope rule) and import it from both pages instead of redeclaring it
fingerprint: 021dbc622798285b
source: audit-cleanliness

## T-020
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 6
title: I18N_SETTLE_TIMEOUT_MS is a duplicated local (identical value) in both tracking pages
files: frontend/src/pages/AitoTrackPage.tsx
evidence: frontend/src/pages/AitoTrackPage.tsx:34 · git diff refactor-base..HEAD adds `const I18N_SETTLE_TIMEOUT_MS = 10_000;` to both AitoTrackPage.tsx:34 and AitoTrackEntryPage.tsx:22, each driving its own `useEffect(() => window.setTimeout(() => setI18nTimedOut(true), I18N_SETTLE_TIMEOUT_MS), [])` latch. rg -n "I18N_SETTLE_TIMEOUT_MS" frontend/src -> only these two definitions and their own use sites. · fix: move the constant to utils/trackingShell.ts next to the existing shared tokens (BRAND/CARD/FOCUS/PRESS) so both pages import one value instead of two independently-typed 10_000s that could drift
fingerprint: 0baa9c837da52d4e
source: audit-cleanliness

## T-021
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 7
title: Terms-toggle button class string is duplicated between TrackingPayment and TrackingInvoice, only token order differs
files: frontend/src/components/aito/TrackingPayment.tsx
evidence: frontend/src/components/aito/TrackingPayment.tsx:40 · TrackingInvoice.tsx:40 button class: `inline-flex min-h-[44px] w-full shrink-0 items-center justify-center whitespace-nowrap rounded-[8px] border px-[16px] text-[13.5px] font-semibold text-aito-cyan transition-[color,background-color,border-color,transform] duration-150 hover:bg-aito-cyan/10 active:scale-[0.97] active:bg-aito-cyan/15 ${FOCUS} min-[400px]:w-auto ${terms.open ? '...' : '...'}`. TrackingPayment.tsx:40+60 builds the same button via `const button = 'inline-flex min-h-[44px] w-full shrink-0 items-center justify-center whitespace-nowrap rounded-[8px] px-[16px] text-[13.5px] font-semibold transition-[color,background-color,border-color,transform] duration-150 active:scale-[0.97] ${FOCUS} min-[400px]:w-auto'` then `${button} border text-aito-cyan hover:bg-aito-cyan/10 active:bg-aito-cyan/15 ${terms.open ? ...}`. Sorting both token lists confirms an identical token SET (verified programmatically), so the visual result is the same — only the source order differs, a leftover from round 1's extraction of TrackingPaidRow which left this string untouched in each file. · fix: define the terms-toggle button classes once (e.g. in components/aito/trackingShell.tsx, additive export permitted) and have both TrackingPayment and TrackingInvoice consume it instead of retyping the same token set in a different order
fingerprint: 355fcad35c7cb0f8
source: audit-cleanliness

## T-022
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 7
title: The rate-limit clock/reset boilerplate is retyped in ~17 test functions instead of a shared fixture
files: backend/tests/unit/test_aito_tracking.py
evidence: backend/tests/unit/test_aito_tracking.py:558 · The pattern `clock = _Clock(); monkeypatch.setattr(aito_routes, "time", clock); ...; aito_routes._reset_track_rate_limits()` (setup) plus a trailing `aito_routes._reset_track_rate_limits()` (teardown) is hand-written at lines 561-572, 579-588, 595-599, 626-637, 647-655, 669-682, 700-711, 720-730, 745-759, 772-781, 974-992, 1005-1018, 1035-1047, 1059-1072, 1082-1087, 1096-1108, 1121-1137, 1147-1155, 1166-1183, 1193-1207 (rg -n 'clock = _Clock\(\)|_reset_track_rate_limits\(\)' backend/tests/unit/test_aito_tracking.py -> 40+ matches). Several also repeat the identical `for _ in range(aito_routes._TRACK_RATE_MAX_MISSES_PER_IP): assert (await async_client.get(...)).status_code == 404` miss-loop verbatim at lines 564, 600, 630, 651, 754, 778. · fix: extract a pytest fixture (e.g. `track_rate_clock`) that constructs `_Clock`, patches `aito_routes.time`, and resets the limiter before and after the test, and a small helper for 'exhaust the per-IP miss cap' to replace the repeated range loop
fingerprint: e78235525684ed71
source: audit-cleanliness

## T-024
priority: P1
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 6
title: notes_with_tracking mints the tracking token inside the open transaction, holding SQLite's write lock across the Books round trip
files: backend/app/services/aito_quote_sync.py
evidence: backend/app/services/aito_quote_sync.py:1238 · `updated = await zoho_service.update_estimate_lines(db, project.quote_id, line_items, notes=await notes_with_tracking(db, project, estimate.get("notes")))` — the argument is evaluated first, and for a card whose tracking_token is still NULL it runs ensure_tracking_token's `UPDATE aito_projects ... WHERE tracking_token IS NULL` + `await db.flush()` (aito_tracking.py:175-188) with no commit. That flush upgrades the worker session to a RESERVED write transaction, which is then held for the whole update_estimate_lines HTTP call (zoho.py:289 `httpx.AsyncClient(timeout=10.0)`, plus the 401-retry-once path) and until run_sync_once's per-project commit. SQLite allows one writer, so for those seconds every other writer — MQTT status, a board PATCH, log_view on the public tracking route — blocks and then fails once PRAGMA busy_timeout=15000 expires: a 500 'database is locked' on unrelated requests whenever Books is slow during a new card's first push. regenerate_tracking_token's own docstring records this exact failure ('the first settings read inside the Zoho client would autoflush it and hold SQLite's write lock for up to two request timeouts ... unrelated writers (MQTT status, the sync worker) failed with "database is locked"'), and the same shape exists on the create path at line 637. · fix: mint and commit the token before the Books call — resolve the URL/notes in a step that ends with a commit (the order regenerate_tracking_token already uses) and pass the resulting string into update_estimate_lines / update_estimate_notes, so no write transaction is open across the HTTP round trip · user-visible change: ORCHESTRATOR HOLD (auditor filed it as neutral): the fix inserts a commit into the quote-sync worker's per-project transaction before the Books HTTP call, so a freshly minted tracking token (and any other change pending on that session at that point) is committed even when the Books push then fails — the same order regenerate_tracking_token already uses, but a change to the sync loop's transaction boundary.
fingerprint: ff2bdcd681e93048
source: audit-robustness
reason: user-approved behavior change

## T-025
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 7
title: AitoTrackPage leaves panel.open === 'pay' when a refetch removes the payment panel
files: frontend/src/pages/AitoTrackPage.tsx
evidence: frontend/src/pages/AitoTrackPage.tsx:310 · `const hasTerms = showContent && (data.invoice !== null ? data.invoice !== 'paid' : ...)` gates `{hasTerms && (<TrackingPanel id="track-panel-pay" ...>)}`, but nothing resets `panel.open`. A client opens the payment terms panel, leaves the tab, the operator marks the invoice paid in Books; on return React Query refetches (staleTime 30 s, refetchOnWindowFocus), data.invoice becomes 'paid', hasTerms flips false and the panel plus its trigger button unmount while useTrackingPanel still holds open='pay'. `.track-stage[data-open='pay']` (index.css:2701) keeps the card translated ~200 px off-centre with nothing beside it, and under the 1119 px sheet breakpoint `.track-stage[data-open] .track-scrim` (index.css:2798) keeps a full-screen opaque scrim with pointer-events:auto over the page and no sheet behind it. On desktop the scrim is inert, so the only way back to a centred page is the Escape key — the close button went with the panel. · fix: drive the open panel off what is still rendered: clear `panel.open` (or call panel.close()) in an effect when hasTerms goes false while open === 'pay'
fingerprint: 5f32507f670c6958
source: audit-robustness

## T-026
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 8
title: copy() in TrackingPaymentMethods swallows a failed clipboard write and shows nothing
files: frontend/src/components/aito/TrackingPaymentMethods.tsx
evidence: frontend/src/components/aito/TrackingPaymentMethods.tsx:59 · `const copy = async (key: string, value: string) => { if (!(await copyTextToClipboard(value))) return; ... }` — copyTextToClipboard returns false when navigator.clipboard rejects and the execCommand fallback also fails (a WebView or locked-down mobile browser). The row then does nothing at all: no check, no 'copié', no message. The client taps IBAN or the transfer reference, believes it is on the clipboard, switches to their banking app and pastes whatever was there before — a wrong IBAN or a missing quote reference on a real transfer. The operator-side twin (TrackingLinkControl) already toasts on the same false; this public row is the one that silently lies. · fix: surface the refusal — render the value as selectable text or set an error state in the status line when copyTextToClipboard returns false · user-visible change: a client whose browser refuses the clipboard write now sees a failure message (or a selectable value) where the row previously appeared to do nothing
fingerprint: 02cff939c77e8449
source: audit-robustness
reason: user-approved behavior change

## T-027
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 8
title: the public tracking routes have no client-facing error boundary and fall through to the developer UI Crash screen
files: frontend/src/App.tsx
evidence: frontend/src/App.tsx:239 · `<Route path="/t/:token" element={<AitoTrackPage />} />` sits under the single app-wide ErrorBoundary (App.tsx:84-115), whose render is `<h1>UI Crash</h1>` plus `<pre>{this.state.error.message}</pre>` and `<pre>{this.state.error.stack}</pre>`. lazyWithReload retries a failed chunk import exactly once (guarded by CHUNK_RELOAD_KEY in sessionStorage); a second failure — a redeploy that replaced the hashed chunks while the service worker still serves the old index.html, or a flaky mobile link during the reload — rethrows, and the paying client who followed the link printed on their quote gets a red monospace JavaScript stack trace. That is the one outcome AitoTrackPage's own contract rules out: 'never a stack trace, a raw API message or the login screen'. · fix: wrap the four /t and /track routes in their own boundary that renders the tracking card's error state (logo + translated message + retry) instead of inheriting the developer crash screen · user-visible change: a crash on the tracking routes would render a branded retry card instead of the current stack-trace page, so the raw error text stops being visible to whoever hits it
fingerprint: d38ab2d820799100
source: audit-robustness
reason: user-approved behavior change

## T-028
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 8
title: _track_rate_limited leaves hits completely unbounded on a collapsed bucket
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1225 · if not collapsed: calls.append(now) misses.append(now) net_misses.append(now) — combined with _track_rate_hit (line 1248): `_release_miss(_track_rate_net_misses, _track_rate_net_key(host), stamp)`. On a collapsed bucket no CALLS entry is ever recorded, and every successful lookup hands its per-net reservation straight back, so nothing at all counts a hit. The intent is pinned by test_public_route_collapsed_bucket_never_429s_past_the_old_calls_cap_on_hits ('making more than 120 real-code hits inside one window must never see a 429'). The collapse path is the DEFAULT proxied deployment the module comment describes ('When TRUSTED_PROXY_IPS is unset and the request still carries an X-Forwarded-For header'), and every hit costs ~6 DB round trips (project select, done_at event scan, last_activity aggregate, tasks select, current_link, deposit_pct) plus the two settings reads _shipping_names does before it, against one SQLite file shared with the MQTT and sync writers. · fix: keep a ceiling on the collapsed bucket itself — e.g. a separate _TRACK_RATE_MAX_CALLS_PER_NET window (generous, sized for a whole shop rather than one visitor) recorded on the `net` key whether or not the bucket is collapsed, so hits stop being free; do not simply restore the 120/min per-IP cap, which is what T-017 removed for good availability reasons · user-visible change: on an install behind a reverse proxy with TRUSTED_PROXY_IPS unset, tracking-page requests past the new site-wide ceiling would start returning 429 where they are answered today, and the test that asserts 130 consecutive valid-code hits all return 200 would have to be rewritten.
fingerprint: 5217cca9f57e3972
source: audit-security
reason: user-approved behavior change

## T-029
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 9
title: _peer_is_private infers proxy trust from a private TCP peer, which Docker bridge networking gives every internet visitor
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1150 · def _peer_is_private(request: Request) -> bool: ... `return addr.is_loopback or addr.is_private` — docstring: 'True when the direct TCP peer looks like an unconfigured reverse proxy ... Used only to decide whether an X-Forwarded-For header is plausibly trustworthy enough to suspend the per-IP miss cap — a public-internet peer's own X-Forwarded-For never does.' That assumption does not hold under the bridge networking CLAUDE.md documents for macOS/Windows (and under any publish that goes through docker-proxy): the peer the app sees is the bridge gateway, an RFC-1918 address, for EVERY external client. Such a client only has to add its own `X-Forwarded-For:` header to satisfy `collapsed` at line 1203 and suspend both per-IP caps (line 1225), which is exactly the self-granted ceiling lift the T-121 comment above says it closed. · fix: gate the collapse on explicit operator configuration (a TRUSTED_PROXY_IPS entry, or a dedicated 'behind an unconfigured proxy' setting) rather than inferring it from the peer's address family; document that a containerised install must set TRUSTED_PROXY_IPS · user-visible change: installs that today get the loosened limits automatically (reverse proxy on loopback, or any Docker bridge publish) would fall back to the tighter shared per-IP caps until TRUSTED_PROXY_IPS is configured, so busy shops could start seeing 429s on the tracking page where they do not today.
fingerprint: 188caa88f396e1f1
source: audit-security
reason: user-approved behavior change

## T-030
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 9
title: the shared "__no_ip__" bucket makes the per-IP caps site-wide when no request has a peer address
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1201 · host = "__no_ip__" # no real peer, or unparseable — one shared, cappable bucket (T-012) — and `_peer_is_private` returns False for that same case ('A peer that fails to parse (no `request.client` ...) counts as NOT private: fail closed'), so `collapsed` is False and the full per-IP budget applies to the one shared key: 30 misses and 120 calls per minute for the entire install. test_no_peer_collapses_onto_one_shared_bucket pins it: `assert {host for host, _ in stamps} == {"__no_ip__"}` then `assert aito_routes._track_rate_limited(request) is None`. Any deployment where request.client is None for every request — uvicorn bound to a unix socket behind nginx is the realistic one — therefore lets a single source at 2 req/s 429 every client of the shop for the rest of the window. · fix: treat the "__no_ip__" sentinel the same way the collapsed bucket is treated — suspend the per-IP CALLS/MISS caps for it and let the per-net miss budget (plus the ceiling from finding 1) bound it — so a cap can still trip without being a one-visitor site-wide lockout · user-visible change: on an install where requests carry no peer address, visitors who are 429'd today once the shared 30-miss/120-call budget is spent would start being served; the two unit tests that assert the shared bucket trips the per-IP cap would need to assert the per-net budget instead.
fingerprint: 7264815f8b67552a
source: audit-security
reason: user-approved behavior change

## T-031
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 9
title: useSheetDrag()'s pointer-history clamp (`s.history.length > 6`) and its zero-elapsed-time velocity fallback are never exercised, even by the round-1 drag test suite
files: frontend/src/components/aito/TrackingPanel.tsx
evidence: frontend/src/components/aito/TrackingPanel.tsx:114 · coverage (vitest --coverage.include on the tracking scope): 'TrackingPanel.tsx | 97.77 | 92.85 | 100 | 100 | 114,125'. Source: `if (s.history.length > 6) s.history.shift();` (line 114) and `const velocity = t1 > t0 ? (y1 - y0) / (t1 - t0) : 0;` (line 125). The dedicated test file's own header admits the second gap: frontend/src/__tests__/components/AitoTrackingPanel.test.tsx:18-22 says jsdom 'dispatches synthetic events fast enough that two calls can land in the same millisecond, which the component treats as zero velocity... not exercising the velocity branch at all unless the clock is controlled' — but every test in the file (lines 152-203) uses `vi.advanceTimersByTime(...)` with a nonzero delta before each pointermove, so `t1 > t0` is always true and the `: 0` fallback is never hit; no test ever fires more than 2 pointermove events, so the `history.shift()` truncation is never entered either. · fix: in frontend/src/__tests__/components/AitoTrackingPanel.test.tsx, add a case that fires two pointermoves back-to-back with the timer NOT advanced between them (velocity falls back to 0, so a fast finger flick reported at the same millisecond must not be misread) and a case that fires 7+ pointermoves during one drag, asserting the release math still reflects only the most recent samples (i.e. is not skewed by history entries from early in a long drag).
fingerprint: 4e2e4209cea1806b
source: audit-tests

## T-032
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 10
title: mint_unique_token()'s collision-retry loop has never actually retried in any test
files: backend/app/services/aito_tracking.py
evidence: backend/app/services/aito_tracking.py:91 · coverage (pytest --cov=backend/app --cov-branch over test_aito_tracking.py + test_aito_tracking_payment.py + test_aito_tracking_delivery.py + test_aito_quote_sync.py + test_aito_routes.py + test_aito_permissions.py + test_external_url_setting.py + test_route_auth_coverage.py + integration/test_static_html_cache_headers.py, run twice): 'backend/app/services/aito_tracking.py 152 1 44 4 97% 94->91, 214, ...' — branch 94->91 (the `for _ in range(10):` loop looping back after `taken is not None`) is never taken. `rg -n "mint_unique_token|collision|taken" backend/tests/unit/test_aito_tracking*.py` -> no matches beyond the function's own definition and an unrelated docstring hit. Every existing test mints tokens against an otherwise-empty `tracking_token` column, so `taken` is always None on the first iteration and the retry body (lines 91-96) never runs a second time. · fix: in backend/tests/unit/test_aito_tracking.py, add a test that monkeypatches `mint_token` to return a value already present on another project's `tracking_token` for the first call and a fresh value on the second, then asserts `mint_unique_token` retries and returns the second (unique) value rather than colliding — this is the only test protecting the uniqueness guarantee the docstring promises ('a clash there would be a 500 on a Copy click').
fingerprint: f027791f940876e3
source: audit-tests

## T-033
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 10
title: the entry page's I18N_SETTLE_TIMEOUT_MS proceed-anyway deadline has no test, unlike its twin on AitoTrackPage
files: frontend/src/pages/AitoTrackEntryPage.tsx
evidence: frontend/src/pages/AitoTrackEntryPage.tsx:108 · Source: `const I18N_SETTLE_TIMEOUT_MS = 10_000;` (line 26) and the effect `window.setTimeout(() => setI18nTimedOut(true), I18N_SETTLE_TIMEOUT_MS)` (lines 108-111) that lets the page render past a stalled locale chunk. `rg -n 'SETTLE|i18nTimedOut|advanceTimersByTimeAsync' frontend/src/__tests__/pages/AitoTrackEntryPage.test.tsx` finds no occurrence of the deadline being exercised: the two `ready`-related tests (lines 355-370) flip a mocked `ready` override directly and never advance fake timers by 10s+ while `ready` stays false. By contrast `frontend/src/__tests__/pages/AitoTrackPage.test.tsx:342` has 'settles past the i18n deadline even if the locale chunk never becomes ready' using `vi.advanceTimersByTimeAsync(9_000)` then `(1_001)` against the page's identical timer — the entry page never got the equivalent test even though the production code (and the T-018 commit that introduced it) is symmetric between the two pages. · fix: in frontend/src/__tests__/pages/AitoTrackEntryPage.test.tsx, add a test mirroring AitoTrackPage.test.tsx's i18n-deadline case: pin `ready` false via `setReadyOverride(false)`, use fake timers, advance 9_000ms (still on the skeleton), then advance past 1_001ms more and assert the code-entry UI (heading / TrackingCodeInput) renders instead of the skeleton even though `ready` never became true.
fingerprint: 423f3cf21ce51bf0
source: audit-tests

## T-034
priority: P2
status: DONE
attempts: 1
round: 2
first_seen_iteration: 5
last_touched_iteration: 10
title: _release_miss()'s already-swept-bucket guard (`if bucket is None: return`) is never exercised
files: backend/app/api/routes/aito.py
evidence: backend/app/api/routes/aito.py:1240 · coverage (same two runs as above): 'backend/app/api/routes/aito.py ... 1241' listed among missing statements/branches in the 1085-1300 tracking rate-limiter block. Source: `bucket = buckets.get(key); if bucket is None: return` (lines 1239-1241) inside `_release_miss`, called from `_track_rate_hit` on every successful `/track/{token}` hit. This guard only matters when the sweep in `_track_rate_limited` (`if len(bucket) > _TRACK_RATE_SWEEP_ABOVE: ... del bucket[stale]`) has already deleted a host's/net's bucket key between a request's arrival (reservation) and its completion (release) — a genuine race under load on this public, unauthenticated, rate-limited route. `rg -n '_release_miss|SWEEP_ABOVE' backend/tests/unit/test_aito_tracking.py` shows no test that grows a bucket past `_TRACK_RATE_SWEEP_ABOVE` and then completes a request whose reservation was swept away; without this guard a swept-then-completed request would raise on `del buckets[key]`/dict access with no test to catch the regression. · fix: in backend/tests/unit/test_aito_tracking.py, add a test that monkeypatches `aito_routes._TRACK_RATE_SWEEP_ABOVE` low, pre-populates enough stale (expired) entries in `_track_rate_ip_misses`/`_track_rate_net_misses` to trigger the sweep on the next call (deleting the in-flight request's own key), then completes that request and asserts it 200s without raising — proving `_release_miss` tolerates a bucket that vanished out from under it.
fingerprint: 167f77bbbd0f3871
source: audit-tests

