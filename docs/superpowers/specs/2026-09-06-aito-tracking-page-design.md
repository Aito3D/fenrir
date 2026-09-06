# Aito client tracking page — design

Date: 2026-09-06. Status: approved in chat, awaiting written review.

Sixth and last of the 2026-09-03 brainstorm features (after due date + rush,
the follow-ups strip, the print backlog badge, the pipeline widget and the
repeat-client recall). A public, tokenised link per card that shows the
client where their order stands, without a login.

## Goal

1. A per-card random token and a link `<external_url>/track/<token>`.
2. A public read endpoint, `GET /api/v1/aito/track/{token}`, returning only
   what the page draws.
3. A standalone French page at `/track/:token`: the Aito3D logo, stage
   rail, one status sentence, the invoice state when an invoice exists
   (paid / to pay / overdue, no amount), task titles, promised date.
4. The link reaches the client three ways: a Copy button in the detail
   panel, a final line on the pickup SMS draft, and the Zoho estimate's
   customer notes (so it prints on the quote PDF Books emails).
5. Regenerate from the panel to kill a leaked link.

## Non-goals

- No prices, quote status, invoice amounts, client name or contact details
  on the page (the invoice appears as a state only). No login, no comments,
  no notifications from the page.
- No i18n: the page is fixed French, outside the 13-locale catalogues.
- No new permission: Copy/Regenerate reuse `aito:update`; the URL is
  readable with `aito:read`.
- No stored expiry: it is computed from the event log.
- No change to how Zoho sends its email; only the estimate's `notes` field.

## 1. Token

- New nullable column `aito_projects.tracking_token VARCHAR(64)` with a
  unique index, added in `run_migrations()` like `due_date`. NOT in
  `VERSIONED_FIELDS` (a token change is not an edit the panel conflicts on).
- `services/aito_tracking.py`:
  - `mint_token() -> str`: `secrets.token_urlsafe(32)` (43 chars).
  - `async ensure_tracking_token(db, project) -> str`: returns the stored
    token, or mints, assigns and flushes one. Never regenerates.
  - `async tracking_url(db, project) -> str | None`: `None` when the
    `external_url` setting is empty (after `rstrip('/')`), or when the
    project has no token; else `f"{external_url}/track/{token}"`. Does NOT
    mint: read paths must not write.
  - `async build_tracking_url(db, project) -> str | None`: `ensure` then
    `tracking_url`; the write path the SMS draft, the quote sync and the
    panel use. Returns `None` only when `external_url` is empty (the token
    is still minted, so the link appears the moment the setting is filled).
- `POST /aito/{project_id}/tracking-token` (`aito:update`, route name
  `regenerate_tracking_token`): replaces the token, records event
  `tracking.regenerated` (detail `{}`; the old token is never logged),
  commits, returns `{"tracking_url": str | None}`. Declared with the other
  `/{project_id}/...` routes.
- `GET /aito/{project_id}/tracking-link` (`aito:update`, route name
  `get_tracking_link`): `build_tracking_url` (mints if needed), commits,
  returns `{"tracking_url": str | None}`. This is the Copy button's call; it
  is an update because it may write the token.
- `AitoProjectResponse.tracking_url: str | None` via `tracking_url()` (no
  mint) — `_to_response` gains the value; `_project_response`'s callers pass
  it the way they pass shipping names (fetch `external_url` once per
  request, not per card, for `list_projects`). Add to
  `_minimal_project_response()` in `test_aito_routes.py`, the golden board
  fixture, and the TS `AitoProject` mirror.
- Trash does not clear the token; the public endpoint refuses trashed cards
  and restore brings the same link back.

## 2. Public endpoint

`GET /api/v1/aito/track/{token}` — no auth dependency; `"/api/v1/aito/track/"`
added to `PUBLIC_API_PREFIXES` in `backend/app/main.py` so the auth
middleware lets it through when auth is enabled. Declared in `routes/aito.py`
after `get_client_history` and before the `/{project_id}` routes. Route name
`get_tracking`.

Lookup: `tracking_token == token AND status == 'active'`; a miss is a 404
`{"detail": "Lien introuvable"}`. Expiry: when `board_column == 'done'`, take
the latest `aito_events` row for the project with `kind == 'stage.changed'`
whose `changes` JSON has an entry `{"field": "column", "to": "done"}`; if it
exists and `occurred_at + 30 days < now (UTC)`, the same 404. A Done card
with no such event (pre-event-log rows) never expires. A card that left Done
and came back is judged by its latest move, so it gets a fresh window.

Response `AitoTrackingResponse`:

```
{
  "column": "print",                        // AitoColumn
  "tasks": ["Support GoPro", "Pièce 2"],    // titles in position order; untitled → "Pièce {n}" (1-based) — done SERVER-side so the page has no rule
  "due_date": "2026-09-20" | null,
  "shipping": {"island": "Rangiroa", "service": "Livraison Avion Tuamotu"} | null,   // labels from _shipping_names / shipping_service
  "done_at": "2026-09-01T18:20:00" | null,  // the latest move-to-Done event's occurred_at; null unless column == 'done' and an event exists
  "invoice": "paid" | "unpaid" | "overdue" | null,  // a STATE, never an amount — see below
  "reference": "EST-000142" | null          // project.quote_number: the number printed on the client's own quote; null before a quote exists
}
```

`invoice` is derived from `project.invoice_status` (kept fresh by the hourly
invoice sweep): `paid` → `"paid"`; `overdue` → `"overdue"`; `sent`, `unpaid`
and `partially_paid` → `"unpaid"`; `draft`, `void`, `None` and a card with
no invoice → `null` (the block is not drawn). The balance is never sent.

Nothing else: no ids, no client fields, no prices, no quote data, no invoice
amounts. `Cache-Control: no-store` on the response.

Cost: one project lookup on the unique token index, one tasks query, one
events query (only for Done cards), one settings read for shipping names.

## 3. Link delivery

- **Pickup SMS** (`generate_pickup_message` in `routes/aito.py`): after
  `pickup_message(...)` returns, `url = await build_tracking_url(db, project)`;
  when non-null, append `"\n\nSuivi : " + url` to the message before it is
  returned to the textarea. The textarea stays editable, so the operator can
  delete the line. The token mint is committed with the draft request.
- **Zoho estimate notes** (`services/aito_quote_sync.py`): `url = await
  build_tracking_url(db, project)`; when non-null, the `create_estimate`
  payload gains `"notes": "Suivez votre commande : " + url`, and the update
  path passes the same string through a new optional keyword
  `zoho_service.update_estimate_lines(db, estimate_id, line_items, notes=None)`,
  which adds `"notes"` to its partial PUT body only when given. When the
  url is null the key is omitted on both paths (never an empty string, which
  would blank notes someone typed in Books; the partial PUT preserves them).
  `notes` is Books' "customer notes" and prints on the estimate PDF that
  Books attaches to its email. The token mint rides on the sync's own
  commit.
- **Panel** — see §4.

## 4. Panel control — `components/aito/TrackingLinkControl.tsx`

Mounted in `ProjectDetailPanel` in the contact area, directly after
`ContactedControl` / `FlagControl` (both branches), for every active card.
Props: `project: AitoProject`.

- A Copy button (`Link2` icon, label `aito.trackingCopy`): calls
  `api.getAitoTrackingLink(project.id)`, writes the URL to the clipboard via
  the same helper `CopyableValue` uses, shows the existing copied state for
  1.5 s, and invalidates `['aito-projects']` so `tracking_url` lands on the
  card. Shown only with `aito:update` (the gate lives at the panel call site,
  like the other buttons).
- A Regenerate `HoldButton` (`RotateCcw`, label `aito.trackingRegenerate`,
  hold 0.5 s like delete): `api.regenerateAitoTrackingToken(project.id)`,
  then a success toast `aito.trackingRegenerated` and the same invalidation.
  `aito:update` only.
- When `project.tracking_url === null` AND the card already has a token
  (detectable only server-side) the panel cannot tell "no token" from "no
  external URL"; so the disabled state keys on a new boolean in the project
  response, `tracking_configured: bool` (= `external_url` non-empty),
  computed once per request beside `tracking_url`. When false, both buttons
  are disabled with `title = t('aito.trackingNeedsExternalUrl')` and a
  `Link` to `/settings?tab=general` (the General tab of `SettingsPage` is
  where `external_url` is edited) rendered beside them.
- i18n keys (app side, all 13 locales): `aito.trackingCopy`,
  `aito.trackingCopied`, `aito.trackingRegenerate`,
  `aito.trackingRegenerated`, `aito.trackingNeedsExternalUrl`,
  `aito.trackingSettingsLink`. The public page uses none of these.

## 5. Public page — `pages/AitoTrackPage.tsx`

Route `/track/:token` registered in `App.tsx` beside `/overlay/:printerId`
(outside `ProtectedRoute`, no layout, `lazyWithReload`). Fetches
`api.getAitoTracking(token)` under `['aito-track', token]`, `retry: false`,
`staleTime: 30_000`. The page is DARK, independent of the operator's theme:
midnight ground, one centred card, max width 40rem, cyan accent.

Design tokens, added to the `@theme` block of `frontend/src/index.css`
(fixed literals, never theme-aware — the public page must not follow
whichever preset the operator picks):

```
--color-aito-cyan: #04A1E4;        /* accent: current stage, done stages, status box, dates */
--color-aito-midnight: #0c1016;    /* page ground = the app's "Midnight Blue" dark preset (--bg-primary) */
--color-aito-card: #141b23;        /* the card (= that preset's --bg-secondary) */
--color-aito-line: #212c37;        /* separators, outlined stages (= --bg-tertiary / --border-color) */
--color-aito-ink: #e9eff6;         /* text (= --text-primary) */
--color-aito-muted: #93a4b6;       /* secondary text (= --text-secondary) */
```

The five neutrals are copied from `.dark.bg-midnight` in `index.css`, so
the page matches an operator who runs the app on Midnight Blue. Invoice
states keep semantic colours (green `#22C55E` paid, amber `#F59E0B` unpaid,
red `#EF4444` overdue) as 15 % tints with a 45 % border, so cyan stays the
one brand accent. The `aito3d_logo.png` asset is black + cyan; on the dark
card it gets `filter: invert(1) hue-rotate(180deg)`, which turns the black
white and brings the cyan back to cyan (a dedicated light logo asset can
replace the filter later without touching anything else).

Copy is a `const FR = {...}` map in `utils/aitoTracking.ts` (so tests can
import it), not the i18n catalogues. Layout:

1. **Header**, centred: the Aito3D logo (`src/assets/aito3d_logo.png`, the
   asset the shipping label already imports, 40 px tall, `alt="Aito3D"`)
   and under it the contact line from `utils/shippingLabel.ts`'s sender
   constant (phone · email · website) in `aito-muted` at 13.5 px, reused so
   the page and the label read as one brand. Below it, `FR.title` = "Suivi
   de votre commande", centred, and when `reference` is set a muted line
   "Devis n° {reference}" right under it, so the client knows they are
   looking at THEIR order and can quote the number on the phone.
2. **Rail** (`components/aito/TrackingRail.tsx`, new, read-only): the seven
   columns in board order with French labels from `TRACK_STAGES` (`devis` →
   "Devis", `waiting` → "Accord", `scan` → "Scan", `model` → "Modélisation",
   `print` → "Fabrication", `finish` → "Prête") and a LAST label that says
   what actually ends the order: "Expédiée" when the card has a shipment,
   "Récupérée" otherwise. Stages before the current get a check on a cyan
   disc; the current is a FULL cyan disc with a small white pulsing centre
   dot and its label in cyan bold, so the current state reads in half a
   second; later stages are outlined in `aito-line`. Props
   `{ column: AitoColumnId; shipped: boolean }`. Below 560 px the row is
   replaced by a compact variant: "Étape {n} sur 7" left, the current label
   in cyan right, and a thin cyan progress bar under them (same component,
   two markups toggled by Tailwind's `max-sm:`/`sm:` classes).
3. **State block** (`statusCopy(data): { title: string; sub: string }` in
   `utils/aitoTracking.ts`), a cyan-tinted panel (neutral tint for the two
   pre-order states) holding a bold title, a human one-liner, and, when
   `due_date` is set, a separated line with a calendar icon:
   "Disponibilité estimée : **{date}**" (French long date). The date lives
   HERE, next to the state, not under the parts list: after the state it is
   what the client most wants to know.
   - `devis` → "Nous préparons votre devis" / "Vous le recevrez par e-mail dès qu'il est prêt."
   - `waiting` → "Votre devis vous attend" / "Dites-nous si vous le validez, et nous lançons la fabrication."
   - `scan`, `model`, `print` → "Votre commande est en fabrication" / "Nous préparons actuellement vos pièces."
   - `finish` → "Votre commande est prête" / "Contactez-nous ou passez au magasin pour la récupérer."
   - `done` with `shipping` → "Votre commande a été expédiée" / "Vers {island} par {service}."
   - `done` with `done_at`, no shipping → "Votre commande a été récupérée" / "Le {date}. Merci pour votre confiance !"
   - `done` with neither → "Votre commande est terminée" / "Merci pour votre confiance !"
4. **Tasks**: `FR.tasksHeading` = "Vos pièces" as a small uppercase
   heading, then a `<ul>` of `tasks` as delivered by the server, thin
   `aito-line` separators.
5. **Invoice line** (`components/aito/TrackingInvoice.tsx`, new): drawn
   only when `invoice` is non-null, UNDER the parts list, compact: a small
   coloured disc with a glyph, two lines of text, and on the right a
   disclosure link — no full-width tinted box, so the page does not stack
   panel inside panel:
   - `paid` (green ✓): "Facture réglée" / "Merci pour votre confiance." — no link.
   - `unpaid` (amber !): "Facture à régler" / "Avant le retrait ou l'expédition." — link "Modalités de paiement →".
   - `overdue` (red !): "Facture en retard" / "Contactez-nous si vous avez déjà payé." — same link.
   The link toggles an inline paragraph `FR.paymentTerms` under the line
   (a fixed constant, no request): "Règlement par virement ou au magasin,
   en indiquant le numéro de votre devis. Répondez à notre message pour
   toute question." There is no online payment and no invoice PDF on this
   page (a PDF carries amounts, which the page never shows).
   `data-testid="track-invoice"` with `data-state` = the value.
6. **Footer**, centred, 13.5 px: `FR.footer` = "Une question sur votre
   commande ? Nous sommes disponibles au {phone} ou à {email}." with the
   phone and email as cyan `tel:` / `mailto:` links.

States: loading renders the header and a neutral "Chargement…" line. Any
error (404, network) renders the header, `FR.invalid` = "Ce lien n'est plus
valide." and the contact line — never the app's login screen and never a
raw status code. `document.title` is set to "Suivi de commande · Aito 3D".

## 6. API client

`AitoTracking { column: AitoColumnId; tasks: string[]; due_date: string | null; shipping: { island: string; service: string } | null; done_at: string | null; invoice: 'paid' | 'unpaid' | 'overdue' | null; reference: string | null }`;
`AitoProject.tracking_url: string | null; tracking_configured: boolean`;
`api.getAitoTracking(token)`, `api.getAitoTrackingLink(id)`,
`api.regenerateAitoTrackingToken(id)`. Default msw handlers: track → 404,
tracking-link → `{ tracking_url: null }`.

## 7. Testing

Backend (`tests/unit/test_aito_tracking.py`):
- `ensure_tracking_token` mints once and is stable across calls; a second
  card gets a different token; `tracking_url` is None without `external_url`
  and `<url>/track/<token>` with it (trailing slash stripped).
- Regenerate replaces the token, the old one 404s, the event is recorded
  without the token in its detail.
- Public endpoint: 200 shape (titles in position order with "Pièce n"
  fallback, due_date, shipping labels, done_at, `invoice` mapped from each
  `invoice_status` value and null without one; `reference` = quote_number
  or null; no balance key); trashed → 404; unknown →
  404; Done 31 days ago → 404; Done 29 days ago → 200; Done with no event →
  200; card that left Done and returned 2 days ago → 200; no client field or
  price key in the body; `Cache-Control: no-store`.
- Middleware: with auth enabled the route answers without a bearer, and
  `/api/v1/aito/{id}` still 401s (pin the prefix).
- SMS draft ends with `"Suivi : <url>"` when configured and is unchanged
  when not; the draft request commits the minted token.
- Quote sync: create and update payloads carry `notes` when configured and
  omit the key when not (patch `zoho_service.create_estimate` /
  `update_estimate` as the existing sync tests do).
- Project responses carry `tracking_url` / `tracking_configured`; permission
  closures: `regenerate_tracking_token` and `get_tracking_link` are
  `aito:update`, `get_tracking` declares none.

Frontend:
- `aitoTracking.test.ts`: every branch of `statusCopy`, French dates, the
  last-stage label for shipped vs not.
- `AitoTrackPage.test.tsx`: renders the logo, the reference line (and its
  absence when null), rail (current stage `aria-current`, earlier done,
  later todo, last label "Expédiée" with a shipment / "Récupérée" without),
  state title + sub-line, the estimated date inside the state block, tasks,
  from a fixture; shipped and picked-up variants; the three invoice states
  with the terms disclosure opening on click, and its absence; 404 → the
  invalid line and the contact line; no login redirect.
- `TrackingLinkControl.test.tsx`: Copy calls the link endpoint and writes
  the clipboard; disabled with the hint when `tracking_configured` is false;
  Regenerate needs the hold and toasts; buttons absent without
  `aito:update`.
- i18n parity for the six app keys.

## Open decisions, resolved

| Question | Decision |
|---|---|
| Page content | Logo, quote reference, rail (last stage named Expédiée/Récupérée, compact on mobile), state block with human sub-line and the estimated date, task titles, compact invoice line with payment-terms disclosure (no amount, no PDF, no online payment); nothing about the client, no prices |
| Token life | Computed: active card, and ≤ 30 days after the latest move to Done; Regenerate replaces |
| Delivery | Copy button, SMS draft line, Zoho estimate notes (Zoho's email body is not writable) |
| Language | Fixed French constants, no i18n |
| Look | Dark, the app's Midnight Blue neutrals (`#0c1016` ground) with cyan `#04A1E4` accent, logo centred at the top, independent of the operator's theme |
| Link origin | `external_url` setting only; empty → no link anywhere, buttons disabled with a Settings hint |
| Expiry storage | None; the event log is the source |
