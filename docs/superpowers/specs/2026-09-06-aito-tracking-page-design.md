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
6. A view log: every successful open of the page is recorded, and the
   Stats page's pipeline widget gains a "Suivi client" block (views, cards
   viewed, cards with a link) so the operator can see whether the page is
   actually used.

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
  "tasks": [                                // position order; untitled → "Pièce {n}" (1-based) — done SERVER-side so the page has no rule
    {"title": "Support GoPro", "quantity": null},
    {"title": "Boîtier capteur", "quantity": 2}   // quantity: the count when EVERY priced service on the task carries the same count > 1; null otherwise (1, or services that disagree)
  ],
  "due_date": "2026-09-20" | null,
  "shipping": {"island": "Rangiroa", "service": "Livraison Avion Tuamotu"} | null,   // labels from _shipping_names / shipping_service
  "done_at": "2026-09-01T18:20:00" | null,  // the latest move-to-Done event's occurred_at; null unless column == 'done' and an event exists
  "invoice": "paid" | "unpaid" | "overdue" | null,  // a STATE, never an amount — see below
  "reference": "EST-000142" | null,         // project.quote_number: the number printed on the client's own quote; null before a quote exists
  "updated_at": "2026-09-06T09:42:00"       // the card's last ACTIVITY (naive UTC): the latest aito_events.occurred_at for the project, or project.updated_at when it has no events — the page's "Mis à jour …" line; real data, never a fake "recently"
}
```

`tasks[].quantity`: per-service counts live on the task (`scan_quantity`,
`modelisation_quantity`, `usinage_quantity`, `impression_quantity`); the
page shows one number only when it is unambiguous — every service with a
non-null cost has the same count and it is greater than 1. A print step at
×2 next to a scan at ×1 sends `null`, never a guess.

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
midnight ground, one centred card 640 px wide (padding 36 px, 20 px on
phones with 16 px page margins), cyan accent reserved for three things: the
current stage, the primary action, and the estimated date. Other links are
`aito-ink`, not cyan. Four blocks — progression, current state, parts,
payment — separated by 32 px (26 px on phones) and as few rules as possible.

Design tokens, added to the `@theme` block of `frontend/src/index.css`
(fixed literals, never theme-aware — the public page must not follow
whichever preset the operator picks):

```
--color-aito-cyan: #04A1E4;        /* accent: current stage, done stages, status box, dates */
--color-aito-midnight: #0c1016;    /* page ground = the app's "Midnight Blue" dark preset (--bg-primary) */
--color-aito-card: #141b23;        /* the card (= that preset's --bg-secondary) */
--color-aito-line: #212c37;        /* separators, outlined stages (= --bg-tertiary / --border-color) */
--color-aito-ink: #e9eff6;         /* text (= --text-primary) */
--color-aito-muted: #a3b1c0;       /* secondary text — the preset's #93a4b6 lifted one step for outdoor phone legibility */
```

Four of the neutrals are copied from `.dark.bg-midnight` in `index.css`,
so the page matches an operator who runs the app on Midnight Blue; the
muted text is deliberately one step lighter than the preset. Invoice
states keep semantic colours (green `#22C55E` paid, amber `#F59E0B` unpaid,
red `#EF4444` overdue) as 15 % tints with a 45 % border, so cyan stays the
one brand accent. The `aito3d_logo.png` asset is black + cyan; on the dark
card it gets `filter: invert(1) hue-rotate(180deg)`, which turns the black
white and brings the cyan back to cyan (a dedicated light logo asset can
replace the filter later without touching anything else).

Copy is a `const FR = {...}` map in `utils/aitoTracking.ts` (so tests can
import it), not the i18n catalogues. Layout:

Typography, strict: title 23 px semibold; reference 13.5 px muted; state
title 20 px semibold; secondary text 15 px muted; section label 12 px
uppercase with light tracking; content 15.5 px. Two weights only (400/600).

1. **Header**, centred, logo only: the Aito3D logo (`src/assets/aito3d_logo.png`,
   the asset the shipping label already imports, 32 px tall, `alt="Aito3D"`),
   28 px of air, then `FR.title` = "Suivi de votre commande", then when
   `reference` is set a muted line "Devis n° {reference}", so the client
   knows they are looking at THEIR order and can quote the number on the
   phone. No contact line here — it lives in the footer only, so the state
   below is the page's hero.
2. **Progression** (`components/aito/TrackingRail.tsx`, new, read-only):
   the seven columns in board order with French labels from `trackStages`
   (`devis` → "Devis", `waiting` → "Accord", `scan` → "Scan", `model` →
   "Modélisation", `print` → "Fabrication", `finish` → "Prête") and a LAST
   label that says what actually ends the order: "Expédiée" when the card
   has a shipment, "Récupérée" otherwise. Done stages are SECONDARY: a
   28 %-cyan disc with a check, 11 px muted label; the current stage
   dominates: a full cyan disc with a small white pulsing centre dot,
   12.5 px semibold `aito-ink` label; later stages are outlined in
   `aito-line`. The track's cyan fill is dimmed to 55 %. Props
   `{ column: AitoColumnId; shipped: boolean }`. Below 600 px the row is
   replaced by a compact variant: "Étape {n} sur 7" left, the current label
   semibold right, and a 3 px cyan progress bar under them (same component,
   two markups toggled by Tailwind's `sm:` classes).
3. **Current state** (`statusCopy(data): { title: string; sub: string }` in
   `utils/aitoTracking.ts`), the hero: a cyan-tinted panel (10 % tint, 35 %
   border; neutral for the two pre-order states) with a SHORT 20 px title,
   a human one-liner, then, when `due_date` is set, a separated block with
   the label "Disponibilité estimée" small uppercase muted over the date as
   an 18 px semibold cyan value (French long date) — label and value
   isolated so the date scans on its own. Under it, always, a 12.5 px muted
   line `FR.updated(...)` = "Mis à jour {when}" built from `updated_at`:
   "aujourd'hui à 09:42" / "hier à 18:20" / "le 4 septembre à 11:05"
   (local time of the browser). Real data only.
   - `devis` → "Devis en préparation" / "Vous le recevrez par e-mail dès qu'il est prêt."
   - `waiting` → "En attente de votre accord" / "Dites-nous si vous validez le devis, et nous lançons la fabrication."
   - `scan`, `model`, `print` → "En fabrication" / "Nous préparons actuellement vos pièces."
   - `finish` → "Prête" / "Contactez-nous ou passez au magasin pour la récupérer."
   - `done` with `shipping` → "Expédiée" / "Vers {island} par {service}."
   - `done` with `done_at`, no shipping → "Récupérée" / "Le {date}. Merci pour votre confiance !"
   - `done` with neither → "Terminée" / "Merci pour votre confiance !"
4. **Parts**: `FR.tasksHeading` = "Vos pièces" as the 12 px section label,
   then a `<ul>` of `tasks` at 15.5 px with 11 px vertical padding and
   60 %-opacity `aito-line` separators — a client summary, not a table.
   A right-aligned "×N" only when the server sent a `quantity` (see §2's
   rule); nothing for a count of 1 or an ambiguous task.
5. **Payment** (`components/aito/TrackingInvoice.tsx`, new): drawn only
   when `invoice` is non-null, as a bordered secondary card (`aito-line`
   border, no tint): a 10 px status dot, a semibold title with a muted
   sub-line, and on the right an outlined cyan button:
   - `paid` (green dot): "Facture réglée" / "Merci pour votre confiance." — no button.
   - `unpaid` (amber dot): "Facture à régler" / "À régler avant le retrait ou l'expédition." — button "Voir les modalités".
   - `overdue` (red dot): "Facture en retard" / "Contactez-nous si vous avez déjà payé." — same button.
   The button toggles a muted paragraph `FR.paymentTerms` under the card
   (a fixed constant, no request): "Règlement par virement ou au magasin,
   en indiquant le numéro de votre devis. Répondez à notre message pour
   toute question." There is no online payment and no invoice PDF on this
   page (a PDF carries amounts, which the page never shows); a "Régler la
   facture" button is a follow-up for the day a payment link exists.
   `data-testid="track-invoice"` with `data-state` = the value.
6. **Footer**, centred, 13.5 px muted, above a soft rule: "Une question
   sur votre commande ? Nous sommes disponibles au {phone} ou à {email}."
   with the phone and email as `aito-ink` `tel:` / `mailto:` links (not
   cyan: the accent is reserved).

States: loading renders the header and a neutral "Chargement…" line. Any
error (404, network) renders the header, `FR.invalid` = "Ce lien n'est plus
valide." and the contact line — never the app's login screen and never a
raw status code. `document.title` is set to "Suivi de commande · Aito 3D".

## 6. API client

`AitoTracking { column: AitoColumnId; tasks: { title: string; quantity: number | null }[]; due_date: string | null; shipping: { island: string; service: string } | null; done_at: string | null; invoice: 'paid' | 'unpaid' | 'overdue' | null; reference: string | null; updated_at: string }`;
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
- View log: a 200 inserts exactly one `aito_tracking_views` row for the
  card; a 404 inserts none; an insert failure (patched to raise) still
  returns 200. Stats: `tracking.views` counts rows in the local-day window
  only, `cards_viewed` is distinct, `cards_with_link` counts active cards
  with a token and ignores trashed ones; zeros when nothing was viewed.
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

## 7b. Finishing pass (binding)

The visual direction above is the source of truth; this section is the
production polish, states and responsive behaviour. Nothing here adds an
element for decoration.

**Composition and spacing.** Card `max-width: 620px`, fluid below; on
phones `width: calc(100% - 32px)`; comfortable top margin, no forced
vertical centring. One spacing scale — 4 / 8 / 12 / 16 / 24 / 32 / 48 px:
32 px between the four blocks, 16 px between a heading and its content,
8 px between a primary text and its secondary line. No other values.
Radius 12 px on the card, the state panel and the payment card; 8 px on
buttons. Borders at `aito-line`, never stronger; shadow none.

**Typography.** Page title 22–24 px semibold; reference 13 px muted; state
title 18–20 px semibold; body 14–15 px; date 17–18 px semibold; section
labels 11–12 px uppercase with light tracking; line-height 1.4–1.5; two
weights only. Three text levels: `aito-ink`, `aito-muted` (`#a3b1c0`, AA
on the card) and a very-secondary `aito-muted/70` for the update line.

**Header.** Logo only (28 px tall), 20 px of air, title, reference. The
logo signs the page; it does not lead it.

**Timeline.** Desktop: disc centres and the track share one axis; the
cyan fill stops at the active disc; labels centred under their discs;
"Modélisation" and "Fabrication" fit at 11 px in 7 equal columns at
620 px. Done discs at 30 % cyan with a check in `aito-ink`, labels muted;
future discs outlined; the active disc is the only bright one: full cyan,
white centre dot, soft halo, label semibold `aito-ink`. `aria-current="step"`
on the active item and a visually-hidden "Étape 5 sur 7 : Fabrication"
for screen readers. The halo pulse is `motion-safe:` only. Below 560 px
the row is replaced by "Étape 5 sur 7" / "Fabrication" / a 3 px bar, plus
a "Voir les étapes" disclosure that lists the seven stages vertically with
the same done/active/future marks.

**State panel.** Order: title, sub-line, hairline, "DISPONIBILITÉ ESTIMÉE"
label, date, update line. No icons. Date rules:
- set and not passed → the date;
- set, passed, and the card is still before Finish → "Estimation en cours
  de mise à jour" (never the stale date as if all were well);
- unset and the card is in Scan / Modélisation / Fabrication → "Nous vous
  communiquerons une date dès que possible.";
- unset in the other states → the block is omitted entirely, no gap.
The update line reads "Mis à jour aujourd'hui à 09:42" / "hier à 16:20" /
"le 3 septembre à 11:05" from `updated_at`, which is the card's last
activity, never fabricated.

**Parts.** 12 px vertical padding, separators at `aito-line/60`; the name
wraps on two lines on phones while the quantity stays top-aligned right in
its own column (`flex` with `shrink-0` on the quantity, `min-w-0` on the
name); quantity rendered "×2" only when non-null. Above 8 parts, show the
first 6 and a "Voir les {n} pièces" button that expands the list.

**Payment.** Paid: borderless, a green dot, "Facture réglée", "Merci pour
votre confiance." — quiet, it must not compete with the state. Unpaid: a
bordered card, amber dot, "Facture à régler", "À régler avant le retrait ou
l'expédition.", and a "Voir les modalités" button (44 px tall, full width
under 400 px) with hover / focus-visible / active states. Overdue: same
card with a red dot and the word "retard" in the title, so colour is not
the only signal; "Contactez-nous si vous avez déjà payé." A "Régler la
facture" button is reserved for the day a payment link exists.

**Footer.** "Une question sur votre commande ?" then, on its own line,
phone · email as `tel:` / `mailto:` links with 44 px tap targets.

**States.** Loading: a skeleton of the rail and the state panel, no
spinner. Any non-404 error: the header, "Impossible de charger le suivi
pour le moment." and a "Réessayer" button that refetches. 404: a dedicated
page — logo, "Ce lien de suivi n'est plus valide", one sentence ("Il a
peut-être expiré ou été remplacé. Contactez-nous et nous vous enverrons un
nouveau lien.") and the footer contacts. Expired and unknown are the same
404 on purpose (§2), so one page covers both. Never a stack trace, a raw
API message or the login screen.

**Interaction.** Links and buttons: subtle hover, visible keyboard focus
(2 px cyan outline offset 2 px), 150–200 ms transitions; nothing animates
on purely informational elements. Full keyboard support.

**Responsive.** Checked at 320, 360, 390, 430, 768, 1024 and 1440 px: no
horizontal scroll, no truncation, footer legible, card radius 12 px on
phones too. Long content must hold: a 60-character part name, 10+ parts, a
long reference, a multi-line sub-line.

**Performance.** No new library; the logo PNG is the existing 5 KB asset;
the skeleton reserves the panel's height so nothing shifts when data lands.

## 8. Usage statistics

Question to answer: is the page used at all, and by how many clients?

- **Table** `aito_tracking_views (id INTEGER PK, project_id INTEGER NOT NULL,
  viewed_at DATETIME NOT NULL)`, indexes on `viewed_at` and `project_id`;
  model `backend/app/models/aito_tracking_view.py` (`AitoTrackingView`),
  created in `run_migrations()` with `CREATE TABLE IF NOT EXISTS`. No IP,
  no user agent, no cookie: a row is a timestamp and a card, nothing that
  identifies a person or a device. Every open counts (a refresh is a view);
  there is no dedup window, because "how often do clients come back" is
  part of the question.
- **Write**: `get_tracking` inserts one row after `compute_tracking` returns
  a payload (never for a 404), in the same request, best-effort: a failed
  insert is logged at warning and the page still renders — the log must
  never break the page it measures.
- **Read**: `GET /aito/stats` gains a fifth block,
  `tracking: {"views": int, "cards_viewed": int, "cards_with_link": int}`:
  `views` = rows with `viewed_at` in the widget's local-day window (the same
  `local_day_bounds` the other blocks use), `cards_viewed` = distinct
  `project_id` among them, `cards_with_link` = active cards with a
  `tracking_token` (snapshot, like the board). Two queries.
- **Widget**: `PipelineWidget` gains a `pipeline-tracking` section after
  Invoicing — heading `stats.pipelineTracking` ("Client tracking"), three
  plain count tiles: `stats.pipelineTrackingViews` ("Page opens"),
  `stats.pipelineTrackingCards` ("Cards viewed"),
  `stats.pipelineTrackingLinks` ("Cards with a link"). The widget's empty
  rule ("every count 0") includes these counts. All 13 locales.
- Per-card counts in the detail panel are a follow-up, not in this spec.

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
| Usage statistics | Every successful open logged as (card, timestamp) only; surfaced as a fifth block of the Stats pipeline widget; no per-visitor data |
| Part quantities | Shown only when every priced service on the task agrees and the count is > 1; otherwise omitted |
| Update time | The card's last activity (latest event, else `updated_at`); never a synthetic "recently" |
| Missing / passed date | "Nous vous communiquerons une date dès que possible." while in production; "Estimation en cours de mise à jour" once passed before Finish; block omitted otherwise |
| Expired vs unknown | One "link no longer valid" page for both, since the API answers one 404 by design |
