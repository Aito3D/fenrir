# Aito × Heimdall payment links — design

**Date:** 2026-09-12
**Status:** approved in brainstorming, awaiting spec review
**Repos:** bambuddy (phases 1–3), heimdall (phase 3 only)

## 1. Goal

Every Aito quote carries an online payment link, created and kept in sync by
Bambuddy through Heimdall's `/api/v1` machine API (which fronts the OSB
payment-link gateway). The link always mirrors the quote: same reference
(the quote number, e.g. `DEV-2026-1234`), same amount (or a configured deposit
share of it), same expiry day. A paid link — or a paid retainer that covers
the same amount — accepts the quote automatically. The operator copies the
link from the detail panel; the client pays from the public tracking page.

Approved scope, in three phases, each with its own implementation plan:

| Phase | Contents |
|---|---|
| **1 — core** | settings + Heimdall client, link ledger + reconcile loop, quote expiry (15 days by default), deposit mode, auto-accept (link or retainer), panel row + copy, board badge, tracking "Pay online", paid notification, expiry nudge |
| **2 — accounting** | a paid link becomes a retainer invoice + customer payment in Zoho Books |
| **3 — instant** | Heimdall webhook → Bambuddy, polling kept as fallback |

Phase 1 is fully usable on its own.

## 2. Context and constraints

### 2.1 Heimdall `/api/v1` (contract: `heimdall/docs/API.md`, frozen)

| Call | Use |
|---|---|
| `POST /api/v1/payments` body `{method:"link", amount, currency:"XPF", reference, expires_in_days}` + header `Idempotency-Key` | create |
| `PATCH /api/v1/payments/:id` `{amount?, expires_in_days?, reference?}` | update — only while `status: pending`; `409 conflict` otherwise |
| `POST /api/v1/payments/:id/cancel` | cancel — `pending` only, `409` otherwise |
| `GET /api/v1/payments/:id` | poll |
| `GET /api/v1/ping` | credential check |

- Auth: `Authorization: Bearer hmd_live_<id>_<secret>`; key scopes needed: `payments:read` **and** `payments:write` (independent, not a hierarchy).
- Signing (on by default per key): headers `X-Heimdall-Timestamp` (unix s, ±300 s), `X-Heimdall-Nonce` (16–128 chars, single use), `X-Heimdall-Signature: sha256=<hex hmac>` over `METHOD\npath+query\ntimestamp\nnonce\nsha256hex(raw body)`; the HMAC key is the `<secret>` part only. Empty body hashes zero bytes.
- Money: integer minor units; XPF has none (`12500` = 12 500 F). Max `999 999 999 999`.
- `expires_in_days` (1–365) → end of that UTC day (`23:59:59.999Z`). There is no absolute `expires_at` on `/api/v1`.
- Unified `status`: `pending | processing | paid | failed | cancelled | expired | needs_attention`. Links only use `pending / paid / failed / cancelled / expired`. `status: paid` means money collected; `booking` (Zoho write-back) is separate and stays `pending` for links today — phase 2 does that write-back on our side.
- Idempotency: same key + identical body → `200` replay of the original; changed body → `409 idempotency_conflict`; a second create racing an in-flight one → `409 conflict` (retry later). Keys are namespaced per API key.
- Rate limit: per key, default 60 req/min, `429 rate_limited` with `Retry-After`.
- Errors: `{"error": {"code", "message"}}`; branch on `code`.
- Links created this way are `created_via: api` and appear on Heimdall's Payment links screen. PATCH/cancel are scoped to links this shop's keys created.
- Connectivity: same LAN, `http://<host>:8081` (decided).

### 2.2 Bambuddy facts this design relies on

- `services/aito_quote_sync.py`: `_create_quote` builds the Books estimate payload (no `expiry_date` today); `_apply_estimate` copies `estimate_number / date / total / status` back; the periodic sweep (`run_sync_once`, 300 s default tick, `_wake`-able) already GETs the full estimate for open quotes, and that payload carries `retainerinvoices[] {retainerinvoice_id, retainerinvoice_number, status, total}` (trusted by `_is_locked` and `aito_invoice_create`).
- `run_sync_loop` calls `sweep_invoices` (hourly gate, per-project commit) and `purge_tracking_views` every tick — the reconciler plugs in beside them.
- `routes/aito.py:set_quote_status` holds the accept logic (adopt status, clear block fields, `quote_status_confirmed=False`, `_apply_rules`, record event, best-effort Books push with rollback on failure).
- `services/aito_tracking.py:compute_tracking` builds the public page payload; it already exposes an invoice *state* (`paid/unpaid/overdue`).
- Settings secrets (`zoho_client_secret`, `openrouter_api_key`, `pushcut_sms_url`) are write-only: listed in `routes/settings.py`'s secret set, blanked on read. New `*_url` settings must be added to the SSRF backstop lists (see memory `aito-pickup-sms`).
- New models need three registrations: `models/__init__.py`, `core/database.py` import list, `CREATE TABLE IF NOT EXISTS` in `run_migrations`. New permissions need API-key classification. The i18n gate rejects English placeholders in the 12 other locales.
- Follow-ups are client-side rules (`frontend/src/utils/aitoFollowups.ts`, `RULES: Record<FollowupKey, Rule>`).
- Notifications are template-driven by `event_type` (`services/notification_service.py`).

## 3. Data model & settings

### 3.1 Table `aito_payment_links`

One row per link ever minted for a project. The project's **current** link is the newest row with `superseded_at IS NULL`. Older rows are history (the panel and timeline read them; nothing deletes them).

| column | type | notes |
|---|---|---|
| `id` | int pk | |
| `project_id` | int, indexed | `aito_projects.id` |
| `idempotency_key` | str(64), unique | `aito:{project_id}:{n}`; `n` starts at 1 and increments on each replacement link. Sent verbatim as `Idempotency-Key`. |
| `heimdall_id` | str(36), unique, nullable | NULL while the create is in flight (a *reservation*). A row with NULL `heimdall_id` is retried with the **same** key, which Heimdall replays instead of duplicating. |
| `reference` | str(64) | the quote number |
| `amount` | int | XPF, what Heimdall holds |
| `currency` | str(3) | always `XPF` (column kept so the ledger never has to guess) |
| `expires_on` | date | calendar day the link ends (Heimdall closes it at 23:59:59.999 UTC of that day) |
| `url` | str(500), nullable | `link.url` |
| `status` | str(20) | Heimdall unified status: `pending / paid / failed / cancelled / expired` |
| `paid_at` | datetime, nullable | first tick that observed `paid` |
| `checked_at` | datetime, nullable | last successful GET |
| `sync_error` | text, nullable | last Heimdall failure text; cleared on the next success |
| `sync_failures` | int | consecutive failures (for backoff and the panel) |
| `superseded_at` | datetime, nullable | set when a replacement row is created |
| `created_at`, `updated_at` | datetime | |

Phase 2 adds `zoho_retainer_id`, `zoho_payment_id`, `booking_error`.

### 3.2 `aito_projects` additions

- `quote_expiry_date` (str(10) ISO date, nullable) — copied back from Books' `expiry_date` in `_apply_estimate`, like `quote_date`. **Books is the source of truth**: editing the expiry there moves the link. Not in `VERSIONED_FIELDS`.
- `retainer_paid_total` (float, nullable) — sum of the estimate's `paid` retainer invoices as last read by the status reconcile (§6.3). A background fact like `invoice_balance`: not versioned, never edited in the panel.

Nothing else. Link state lives in the ledger; the API response joins it (§7.1).

### 3.3 Settings

| key | type | default | notes |
|---|---|---|---|
| `heimdall_base_url` | str | `""` | `http://` (private LAN hosts) or `https://`; validated with the same host rules as `pushcut_sms_url`, and added to both SSRF backstop lists. Empty = feature off. |
| `heimdall_api_token` | str | `""` | write-only (blanked on read, never echoed); the full `hmd_live_…` token. Empty = feature off. |
| `aito_deposit_pct` | int 0–100 | `0` | 0 = link for the full total; otherwise the deposit share. |
| `aito_quote_validity_days` | int 1–365 | `15` | Books `expiry_date = date + N` on quote creation, and for pre-existing quotes without an expiry. |

UI: a **Heimdall** card on the Settings → Zoho tab (with Zoho and OpenRouter), registered in the settings search. Fields above plus **Test connection** → `GET /api/v1/ping`, reporting one of: *ok* / *bad token* (401) / *missing scope* (403) / *unreachable*. The test uses the token just typed if the field is dirty (POST it in the test request body), so a mistyped key is caught before Save.

### 3.4 Money

```
required_amount(project) =
    round(quote_total)                                 if aito_deposit_pct == 0
    ceil(quote_total * aito_deposit_pct / 100)         otherwise
```

One function, `services/aito_payment_links.required_amount`, used by the link, the retainer rule and the panel warning. `quote_total ≤ 0` → no link.

## 4. Heimdall client — `services/heimdall.py`

Async httpx, same shape as `services/zoho.py`: settings read per call (edits take effect without restart), 10 s timeout, module-level singleton `heimdall_service`.

Methods (the whole surface):

- `is_configured(db) -> bool` — both URL and token non-empty.
- `ping(db)`
- `create_link(db, *, idempotency_key, reference, amount, expires_in_days) -> LinkView`
- `patch_link(db, heimdall_id, *, amount=None, expires_in_days=None) -> LinkView`
- `cancel_link(db, heimdall_id) -> LinkView`
- `get_payment(db, heimdall_id) -> LinkView`

`LinkView` is a small dataclass: `id, status, amount, currency, reference, url, expires_at (datetime|None), updated_at`.

Signing: `sign(method, path_with_query, body_bytes, secret, now, nonce)` is a pure function (unit-tested against a vector produced with the `openssl` recipe in Heimdall's doc). The body is serialised **once** (`json.dumps(..., separators=(",", ":"))`), hashed as those exact bytes, and sent as those exact bytes. Nonce: `secrets.token_hex(16)`. The secret is the substring after the second underscore of the token; the bearer header carries the whole token.

Exceptions:

| class | when | reconciler reaction |
|---|---|---|
| `HeimdallNotConfigured` | URL or token empty | feature off; nothing runs |
| `HeimdallConflict` | 409 `conflict` / `idempotency_conflict` | state moved under us: re-GET and re-derive next tick, never blind-retry the same write |
| `HeimdallRateLimited(retry_after)` | 429 | arm a module throttle window; the whole reconciler skips until it passes |
| `HeimdallUpstreamError` | 401/403/5xx/timeouts/bad JSON | per-project `sync_error`, retry next tick with backoff (§5.5) |

A 401/403 is also surfaced on the Settings card ("last error") so a rotated key is noticed.

## 5. Reconcile loop — `services/aito_payment_links.py`

### 5.1 When it runs

`run_sync_loop` calls `reconcile_payment_links(db)` after `sweep_invoices` and before `purge_tracking_views`, every tick, gated only by `heimdall_service.is_configured` (a Books outage must not stop link polling). It is also reached by the `_wake` path: `_create_quote` calls `request_immediate_sync()` after a successful create (it already wakes for pending drains), and the wake drain runs the reconciler for **that project only** so the Copy button lights up within seconds.

### 5.2 Selection

Projects with `quote_number IS NOT NULL`, `quote_total > 0`, `quote_sync_state != 'unmanaged'`, any `status` (a trashed project is selected so its link gets cancelled), plus every project that has a current link in `pending` (so a link outlives the conditions that created it only until the next pass).

### 5.3 Desired state

```
wanted(project, estimate_retainers) =
    None   if project.status != 'active'
    None   if project.quote_status in {'declined', 'expired'}
    None   if project.quote_invoiced
    None   if (project.retainer_paid_total or 0) >= required_amount(project)
    Link(reference=quote_number,
         amount=required_amount(project),
         expires_on=quote_expiry_date or today + aito_quote_validity_days)
```

`retainer_paid_total` is cached on the project by the status reconcile (§6.3) — the reconciler never calls Books.

### 5.4 Transition table

| current row | wanted | action |
|---|---|---|
| none | Link | **create**: insert reservation row (`heimdall_id NULL`, next `n`), commit, POST, fill `heimdall_id/url/status/expires_on`, commit. Record `payment_link.created`. |
| reservation (`heimdall_id NULL`) | Link | **re-POST with the same key** (Heimdall replays); if `wanted` fields differ from the reservation's, the reservation is completed first, then PATCHed on the next pass — never a new key for an incomplete row |
| reservation | None | re-POST to complete it, then it is a `pending` row and the next pass cancels it (an orphan at OSB is worse than one extra round trip) |
| `pending`, fields equal | Link | nothing |
| `pending`, amount and/or expiry differ | Link | **PATCH** the differing fields; on `409 conflict` re-GET (it was paid/expired meanwhile) and fall through to that row's rule |
| `pending`, reference differs | Link | treat as replacement: **cancel**, supersede, **create** `n+1`. (A quote is renumbered essentially never; keeping references honest matters more than one extra link.) |
| `pending` | None | **cancel**; record `payment_link.cancelled` with the reason (`declined`, `expired`, `invoiced`, `retainer`, `trashed`) |
| `paid` | anything | **never touched**. Stays current. Panel shows the delta when `amount != required_amount`. |
| `expired` / `cancelled` / `failed` | Link | set `superseded_at`, **create** `n+1`; record `payment_link.replaced` |
| `expired` / `cancelled` / `failed` | None | nothing |

`expires_in_days = max(1, (expires_on - today_utc).days)`; a quote expiring today still gets a 1-day link (Heimdall's minimum). Restoring a trashed project makes `wanted` non-None again → a fresh link.

### 5.5 Polling

Every current `pending` row is GET-ed, least-recently-`checked_at` first, **at most 40 per tick** (creates/patches/cancels share the key's 60/min budget; the remaining headroom is for the Settings test button and phase 3). Observed status is written as-is. On `paid`: `paid_at = now`, record `payment_link.paid {amount, reference, heimdall_id}`, then `accept_quote(source="payment_link")` (§6.2). Rows in a final status are never polled again.

### 5.6 Failure model

Per-project commit (the invoice sweep's pattern): a Heimdall error costs that project this tick, stores `sync_error`, bumps `sync_failures`; backoff = skip `min(sync_failures, 6)` ticks. Success clears both. `HeimdallRateLimited` stops the pass and arms a window honoured by every later tick until `Retry-After` passes. Nothing here writes `quote_sync_state` or `quote_sync_error` — the two outboxes are independent.

## 6. Quote expiry and acceptance

### 6.1 Expiry

- `_create_quote` adds `"expiry_date": quote_date + aito_quote_validity_days` (Books date format `YYYY-MM-DD`, computed from `date.today()` in the org's timezone — the same source `quote_date` comes from).
- `_apply_estimate` copies `estimate["expiry_date"]` → `project.quote_expiry_date`.
- `_update_quote` (the line-item push) adds `expiry_date` **only when the estimate has none** (pre-existing quotes get one, once); it never overwrites an expiry someone set in Books.
- When Books flips the estimate to `expired`, the existing status reconcile adopts it; `wanted` becomes `None`; the link is already dead at OSB on the same day (§5.4 cancels it anyway, tolerating `409`).

### 6.2 `accept_quote()`

Extracted from `set_quote_status` into `services/aito_quote_status.accept_quote(db, project, *, actor_class, actor_name, detail) -> bool`:

1. no-op (`False`) if already `accepted`;
2. `adopt_quote_status(project, "accepted")` (stamps `quote_accepted_at`), clear `quote_status_block/remote`, `quote_status_confirmed = False`;
3. `_apply_rules` with the summary (releases the card from Devis/Waiting; a declined card in Done comes back — "money wins", decided);
4. record `quote.accepted` with `actor_class` and `detail` (`{"source": "user" | "payment_link" | "retainer", "amount", "reference"}`);
5. commit, broadcast `quote-status`;
6. best-effort Books push (`advance_estimate_status(..., "accepted")`), `quote_status_confirmed = True` on success, rollback + warning on failure — exactly today's code;
7. fire the `aito_payment_received` notification when `source != "user"` (§7.4).

`set_quote_status` calls it for `accepted`; its `sent`/`declined` branches are unchanged. The 409 stale-view checks stay in the route (they are UI-shape rules, not acceptance rules).

### 6.3 Trigger B — paid retainers

In `_reconcile_status` (already holding the full estimate each sweep): compute `paid = sum(float(r["total"]) for r in estimate.get("retainerinvoices") or [] if r.get("status") == "paid")`, cache it on the project as `retainer_paid_total` (new nullable float column on `aito_projects`, background fact, not versioned), and if `paid >= required_amount(project)` and the quote is not accepted → `accept_quote(source="retainer", amount=paid)`. The link reconciler then cancels the pending link on its next pass (`wanted = None`). No extra Books calls.

### 6.4 Timeline events

`payment_link.created`, `payment_link.replaced`, `payment_link.paid`, `payment_link.cancelled` (detail: reason), and `quote.accepted` now carrying `detail.source`. One locale key each in the history renderer; system actor.

## 7. Surfaces

### 7.1 API

- `AitoProjectResponse` gains `payment_link: { state, amount, url, expires_on, paid_at, sync_error } | null` (the current row) and `quote_expiry_date`. `TaskSummary`/fixtures untouched.
- `POST /api/v1/aito/{project_id}/payment-link/refresh` — `AITO_UPDATE`: reconcile + poll this one project now (the panel's manual refresh; also what the Settings test can reuse). Rate-limited 10/min per user.
- Settings: the four keys above through the existing settings routes; `POST /api/v1/settings/heimdall/test` for the ping.
- `AitoTrackingResponse` gains `payment: { state: 'unpaid' | 'paid', url: str | None } | None`.

### 7.2 Detail panel — Quote card

One new `<dt>/<dd>` row under Number/Status, only when `payment_link` is non-null:

| state | row |
|---|---|
| `pending` | label *Paiement en ligne* · amount · **Copy** (clipboard + toast; input-select fallback like the tracking-link control) · muted "expire le {date}" |
| `paid` | label · **✓ payé** amount · Copy kept (receipt page) · if `amount != required_amount`: one muted-red line "Payé {paid}, devis à {required}" |
| `expired` / `cancelled` / `failed` | rendered only while no replacement exists (quote closed): label · state, no button |
| any, `sync_error` set | the row plus the error in the `quote_sync_error` style and a **Retry** link → refresh route |

The masthead never grows a row (memory `aito-panel-header-height`); everything goes in the Quote card. Visible to anyone who can open the panel — the URL is a public payment page.

### 7.3 Board card & tracking page

- Card: a small card icon beside `DueDateBadge` when `payment_link.state == 'paid'`, title *Payé en ligne*. Nothing for `pending`.
- Tracking (`AitoTrackPage`): precedence
  1. `invoice != null` → today's `TrackingInvoice`, unchanged;
  2. `payment.state == 'paid'` → the quiet paid style; title *Acompte reçu* when `aito_deposit_pct > 0` (the tracking payload carries a `deposit: bool` so the page needs no setting), else *Paiement reçu*;
  3. `payment.state == 'unpaid'` and `url` → the bordered card: *Projet non réglé* + **Payer en ligne** (`<a target="_blank" rel="noopener noreferrer">`), the payment-terms toggle beside it;
  4. otherwise nothing.
  The page never calls Heimdall. 13-locale copy.

### 7.4 Notification (extra 5)

Event type `aito_payment_received`, variables `{project_id, client_name, reference, amount, currency, source}`; default template in the seed list; fired from `accept_quote` (§6.2 step 7) so the link, the retainer and the future webhook all notify from one place. Appears in the notification-settings event list like the other events.

### 7.5 Expiry nudge (extra 6)

New follow-up rule `linkExpiring` in `aitoFollowups.ts`: `payment_link.state == 'pending'`, `quote_status ∈ {sent, viewed}`, `expires_on - today <= 3` → bucket *Devis expirant* with days left; opening a card goes to the panel where Copy is one click away. Thresholds default 3 days, configurable with the other follow-up thresholds.

## 8. Phase 2 — Books write-back

When a link reaches `paid` (and after `accept_quote`), Bambuddy books the money on the estimate so `plan_invoice` / `apply_retainers` spend it on the final invoice with no new logic there:

1. `GET /estimates/{id}` → if any `retainerinvoices[]` entry has `reference_number == "HMD-" + heimdall_id`, adopt its ids and stop (idempotent).
2. `POST /retainerinvoices` `{customer_id, estimate_id, reference_number: "HMD-<id>", date, line_items: [{description: "Paiement en ligne — <quote_number>", rate: amount, quantity: 1}]}`; mark it sent if Books requires that before a payment.
3. `POST /customerpayments` `{customer_id, payment_mode: "card" (or the org's online mode), amount, date, reference_number: "HMD-<id>", retainerinvoice_id}` — the exact field set is verified against the Zoho Books API reference in the plan; the design commits to *retainer + payment, keyed by the Heimdall id*.
4. Store `zoho_retainer_id`, `zoho_payment_id` on the link row; record `payment_link.booked`.

Failures: `booking_error` on the row, retried each tick with the same backoff; the panel row reads *Paiement reçu — non comptabilisé* until it lands, and the Books quota rules of the quote sync (429 throttle window) apply. `_is_locked` already treats a retainer as not-a-lock, so the quote stays editable.

## 9. Phase 3 — webhook

**Heimdall** (own spec in that repo): per-API-key optional `webhook_url` + `webhook_secret`; on any *link* status change (IPN or refresh) POST `{"event": "payment.updated", "id", "status", "reference", "occurred_at"}` signed with the same HMAC scheme (`X-Heimdall-Timestamp/Nonce/Signature`, secret = `webhook_secret`); 5 retries with exponential backoff; delivery log visible under Settings → Machine API.

**Bambuddy**: `POST /api/v1/aito/payments/webhook` — public (added to both public-route allow-lists like `/t/`), rate-limited per IP, verifies the signature against `heimdall_webhook_secret` (write-only setting), looks the `id` up in the ledger, and calls the same `reconcile_link(db, row)` §5.5 uses. The webhook is a trigger, never a source of truth: the GET is still what writes the status. Polling remains as the fallback; an unknown id is a 200 no-op (never a probe oracle).

## 10. Testing

- **Signing**: `sign()` against a vector produced with the `openssl` recipe from Heimdall's doc, plus the empty-body case.
- **Reconciler**: the §5.4 table as parametrised tests over `FakeHeimdall` (in-memory; replays idempotency keys; `mark_paid/expire/refuse`; can raise each exception class); reservation re-POST; the 40-per-tick cap and the least-recently-checked order; 429 arming; per-project commit isolation (one failure, others committed).
- **Acceptance**: `accept_quote` through the existing `set_quote_status` tests (unchanged behaviour) plus system-actor cases, the no-op path, the declined→accepted reopen; retainer trigger via `_reconcile_status` fixtures (paid < required, ≥ required, mixed statuses, deposit pct).
- **Expiry**: create payload carries `expiry_date`; `_apply_estimate` copies it back; `_update_quote` sets it only when absent.
- **Tracking**: precedence invoice > paid > unpaid, `deposit` flag, no Heimdall call.
- **Settings**: write-only token, SSRF lists, test endpoint result mapping.
- **Frontend (Vitest)**: panel row states and Copy, board badge, tracking card states and the new-tab anchor, follow-up rule, Settings card; locale parity for every new key (13 locales).
- **Live probe before merge**: `ping`, then a 1-franc link create + cancel against the real Heimdall (read-only otherwise), the way the Zoho probe recipe in memory does.

## 11. Out of scope

Per-quote deposit override; partial payments; refunds; EUR/USD links; Heimdall-side Zoho booking for links (phase 2 does it from Bambuddy); any change to Heimdall before phase 3.
