# Aito: client rating — "is this customer good for the money?"

**Date:** 2026-09-22 — amended 2026-09-23 (company profile, record-weighted override)
**Status:** shipped 2026-09-22; the 2026-09-23 amendment below supersedes the
flat overdue override and adds the company profile

## Problem

Before committing a printer to a job the operator wants one fact about the
customer: do they pay, and do they pay on time? Today that answer lives in
Zoho Books, spread over the customer's invoice list, and nothing on the board
or in the new-project drawer surfaces it. A regular with a real unpaid debt
looks exactly like a regular in good standing.

## What is being built

A per-customer **rating** in four tiers — `good`, `medium`, `bad`, `new` —
computed from the customer's invoice history in Books, cached for an hour,
and shown as a small pill in two places: next to the chosen client in the
new-project drawer, and next to the client name on the project panel
masthead. A tooltip explains the tier.

## Decisions taken

| Question | Decision |
|---|---|
| Source of truth | Zoho Books, customer-wide: every invoice for the contact, including bills raised by hand and pre-Fenrir history |
| What "late" means | Against the invoice's **due date**, so agreed payment terms are respected |
| A currently overdue invoice | Counts as `overdue` after the profile's grace; **`bad` only when severe or when the record is too thin or weak to buffer it**, else `medium` (amended 2026-09-23 — was a flat override to `bad`) |
| Companies | Scored on **their own profile**: a company is the more willing payer and the slower one (approval, payment run), so its timing thresholds are looser and it reaches `good` on fewer invoices (added 2026-09-23) |
| When a rating first appears | After the **first settled invoice**, or at once on overdue debt |
| Chronic lateness with no live debt | **Bad**, not medium |
| Partial payments | An invoice with a balance is open until the balance is zero |
| Pill style | Dot + word (option A of the brainstorm); glyph-only and signal-bar meters rejected |
| `new` on the masthead | **Hidden**; shown as a grey pill in the drawer only |

## The algorithm

### Inputs

One Books call: `GET /invoices?customer_id=<id>`, paginated like
`list_invoices_modified_since` and capped at the same page limit. Rows are
reduced to `date`, `due_date`, `status`, `balance`, `total`,
`invoice_number`, `last_payment_date`.

Filtering:

- `void` and `draft` rows are ignored.
- Only SETTLED invoices whose `date` falls in the last 24 months count, so an
  old lapse fades; an open invoice with a balance counts whatever its age —
  an unpaid debt never fades.
- **Settled**: `status == 'paid'`. Lateness = `last_payment_date − due_date`
  in days (negative is early). A paid invoice with no `last_payment_date` or
  no `due_date` counts as on time.
- **Open**: `status` in `sent`, `overdue`, `partially_paid`, `unpaid`, or
  any other non-terminal status, with `balance > 0`. Overdue days =
  `today − due_date`, floored at 0. No `due_date` means 0.

`last_payment_date` on list rows has **not yet been verified on the live
org**. Task one of the plan is a read-only probe (the same recipe as the
customer-payments verification of 2026-09-15). If list rows do not carry it,
the fallback is `last_modified_time` of a paid invoice, which Books stamps
when the payment is recorded; the spec's rules do not change.

### Profiles (amended 2026-09-23)

The customer's Books contact decides the profile: `customer_sub_type ==
"business"` is a company, anything else an individual. Read with the
invoices at recompute time (one extra Books call per customer per hour) and
remembered on the cache row; when that read fails the last known flag is
kept, and an unseen customer is scored as an individual, the stricter
profile.

| Threshold (`RatingProfile`) | Individual | Company | Meaning |
|---|---|---|---|
| `on_time_slack_days` | 3 | 14 | A settled invoice paid this many days after due still counts as on time (bank delay, late bookkeeping — for a company, the approval-and-payment-run cycle) |
| `grace_days` | 7 | 21 | Overdue days before an open invoice counts as `overdue` rather than merely past due |
| `good_min_settled` | 3 | 2 | Settled invoices needed before `good` is reachable |
| `severe_overdue_days` | 45 | 60 | Overdue days past which an open invoice forces `bad` whatever the record |

### Constants

| Name | Value | Meaning |
|---|---|---|
| `GOOD_MIN_ON_TIME_RATIO` | 0.9 | Share of settled invoices on time for `good` — and the share that makes a record strong enough to buffer a mild overdue invoice |
| `CHRONIC_MIN_SETTLED` | 3 | Settled invoices needed before `chronic` can be called, either profile |
| `CHRONIC_MAX_ON_TIME_RATIO` | 0.5 | At or below this share, with `CHRONIC_MIN_SETTLED` or more settled, the tier is `bad` |
| `HISTORY_MONTHS` | 24 | Window of invoice dates considered |
| `CACHE_TTL` | 1 hour | Age at which a cached row is recomputed on read |

`GRACE_DAYS`, `ON_TIME_SLACK_DAYS` and `GOOD_MIN_SETTLED` remain exported as
the individual profile's figures.

All live in the service module as named constants, not settings. Nothing
suggests the shop will tune them per install, and a setting is a promise to
keep honouring.

### Tier rules, evaluated top down (amended 2026-09-23)

A **strong record** means settled count `>= good_min_settled` and on-time
ratio `>= GOOD_MIN_ON_TIME_RATIO`. An open invoice is **overdue** when its
overdue days exceed the profile's `grace_days`, and **past due** when they
are between 1 and the grace.

1. **`bad`** — any overdue invoice more than `severe_overdue_days` past due,
   whatever the record. Reason: `overdue`, with the count of overdue
   invoices, the worst overdue days and that invoice's number.
2. **`bad`** — any overdue invoice and the record is NOT strong. Reason:
   `overdue`, same fields. Ten invoices paid on time and one a fortnight
   overdue is a good customer having a slow month; two invoices paid on
   time and one a fortnight overdue is not yet anything, so the debt
   decides.
3. **`medium`** — any overdue invoice, buffered by a strong record. Reason:
   `overdue`, same fields — the tooltip still names the debt.
4. **`bad`** — settled count `>= CHRONIC_MIN_SETTLED` and on-time ratio
   `<= CHRONIC_MAX_ON_TIME_RATIO`. Reason: `chronic`, with on-time and
   settled counts.
5. **`new`** — settled count is 0. Reason: `new`.
6. **`good`** — a strong record and **no** open invoice past due at all.
   Reason: `punctual`, with on-time and settled counts.
7. **`medium`** — everything else. Reason: `mixed`, with on-time and settled
   counts, plus the count of open invoices past due when that is what kept
   the tier down.

"On time" for a settled invoice means lateness `<= on_time_slack_days` of
the profile.

Worked examples, all with today = 2026-09-22:

| Customer | Outcome |
|---|---|
| 20 invoices paid early, one open invoice issued 10 days ago, due in 20 days | `good` — the open invoice is inside its terms |
| Same, but the open invoice is 3 days past due | `medium` — inside the grace, so history decides, but `good` requires nothing past due |
| Same, but 9 days past due | `medium` (`overdue`) — overdue, but twenty on time buffer it |
| 10 invoices paid on time, one open 12 days past due | `medium` (`overdue`) — the case that motivated the amendment |
| Same, but 50 days past due | `bad` (`overdue`) — severe, the record no longer matters |
| 2 invoices paid on time, one open 12 days past due | `bad` (`overdue`) — too thin a record to buffer |
| 7 on time, 3 paid 20 days late, one open 12 days past due | `bad` (`overdue`) — 70 % is too weak a record to buffer |
| **Company**, 2 invoices paid on time | `good` — enough volume for a company |
| **Company**, 5 invoices each paid 10 days late | `good` — inside the company slack; an individual would be `bad` (`chronic`) |
| **Company**, 20 paid on time, one open 15 days past due | `medium` (`mixed`) — inside the company grace; an individual's would be `overdue` |
| **Company**, 10 paid on time, one open 60 days past due | `medium` (`overdue`) — the company severe line is 60; at 61 it is `bad` |
| **Company**, 2 invoices paid 20 days late | `medium` — `chronic` needs 3 settled for a company too |
| 1 invoice, paid on time | `medium` — rated, but not enough volume for `good` |
| 5 invoices, 2 paid on time, 3 paid 20 days late, nothing open | `bad` (`chronic`) |
| 5 invoices, 4 on time, 1 late, nothing open | `medium` (80 % < 90 %) |
| 0 settled, 1 open invoice 2 days past due | `new` |
| 0 settled, 1 open invoice 30 days past due | `bad` (`overdue`) |
| 3 paid invoices, one 92 % paid and 12 days past due | `medium` (`overdue`) — a balance is a balance, and three on time buffer it; with 2 paid it is `bad` |

## Backend

### Zoho service

`zoho_service.list_customer_invoices(db, customer_id) -> list[dict]`.
Refuses an empty `customer_id` before any call, for the reason
`list_customer_payments` documents: Books reads an empty filter as no
filter. Pages through `page`/`per_page=200` up to `_MAX_INVOICE_PAGES`.
Returns rows mapped by a new `_map_invoice_history` that keeps the fields
listed under Inputs.

### Scoring service — `backend/app/services/aito_client_rating.py`

Two layers:

- `rate_invoices(rows: list[dict], today: date) -> ClientRating` — pure,
  no I/O, no clock. `ClientRating` is a frozen dataclass: `tier`, `reason`,
  `settled_count`, `on_time_count`, `overdue_count`, `worst_overdue_days`,
  `worst_overdue_number`, `past_due_count`.
- `read_client_rating(db, customer_id, *, refresh=False) -> AitoClientRatingResponse`
  — the cached reader:
  1. Empty id, or the walk-in default contact (`zoho_service.get_default_contact`):
     return `new`, never computed, never cached — same rule as client history.
  2. A cached row younger than `CACHE_TTL` and no `refresh`: return it.
  3. Otherwise call Books, score, upsert the cache row with
     `computed_at = now`, return it with `stale = False`.
  4. On `ZohoNotConfiguredError` / `ZohoUpstreamError` / `ZohoRateLimited`:
     if a cached row exists, return it with `stale = True`; otherwise return
     `tier = 'unavailable'`. Never raise to the route — this only decorates
     a name. A 429 is logged and treated the same; no retry loop here.

### Cache table — `aito_client_ratings`

| Column | Type | Notes |
|---|---|---|
| `customer_id` | String(50) PK | Zoho contact id |
| `tier` | String(10) NOT NULL | good/medium/bad/new |
| `reason` | String(20) NOT NULL | overdue/chronic/new/punctual/mixed |
| `settled_count` | Integer NOT NULL | |
| `on_time_count` | Integer NOT NULL | |
| `overdue_count` | Integer NOT NULL | open invoices past the grace |
| `past_due_count` | Integer NOT NULL | open invoices past due, inside the grace |
| `worst_overdue_days` | Integer NOT NULL default 0 | |
| `worst_overdue_number` | String(50) NULL | invoice number |
| `is_company` | Boolean NOT NULL default 0 | scored under the company profile (added 2026-09-23 as an ALTER migration) |
| `computed_at` | DateTime NOT NULL | naive UTC |

New model `backend/app/models/aito_client_rating.py`, registered in the
three import lists the project's memory notes require, and created by
`Base.metadata.create_all` like the other Aito tables (no ALTER migration
needed for a new table). Rows are never deleted; a customer who disappears
from Books keeps a harmless stale row.

### Endpoint

`GET /api/v1/aito/clients/{client_id}/rating?refresh=0|1`, permission
`aito:read`, declared next to `/clients/{client_id}/history` and for the
same reason ahead of the `/{project_id}` routes.

Response `AitoClientRatingResponse`:

```
tier: 'good' | 'medium' | 'bad' | 'new' | 'unavailable'
reason: 'overdue' | 'chronic' | 'new' | 'punctual' | 'mixed' | null
settled_count, on_time_count, overdue_count, past_due_count: int
worst_overdue_days: int
worst_overdue_number: str | null
is_company: bool
computed_at: datetime | null
stale: bool
```

`is_company` is echoed so the tooltip can append "rated as a company": a
company reading `good` with invoices paid a fortnight late needs the
explanation when the figures are compared across clients.

Structured fields, not a sentence, so the frontend builds the tooltip in
the viewer's language.

`aito:read` is the permission even though this route reads Zoho: the
existing `GET /{project_id}/invoice` sets that precedent and the drawer's
history call is already `aito:read`. The API-key classification list gets
the new path.

### No sweep or board changes

The board list response does not carry the rating. Each surface asks the
endpoint when a client is on screen, and the one-hour cache bounds Books
traffic to one call per customer per hour whatever the number of cards.

## Frontend

### API client

`api.getAitoClientRating(clientId, refresh?)` and the
`AitoClientRating` type mirroring the response.

### Hook — `useClientRating(clientId: string)`

React Query, key `['aito-client-rating', clientId]`, `enabled` when the id
is non-empty, `staleTime` 5 minutes, `retry: false` (the backend already
degrades gracefully). Both sites use it, so the drawer and the panel share
one cache entry per customer.

### Component — `ClientRatingPill`

Props: `rating: AitoClientRating | undefined`, `hideNew?: boolean`,
`className?`.

- Renders nothing while `rating` is undefined, when `tier` is
  `unavailable`, or when `tier` is `new` and `hideNew` is set. The name
  never jumps: the pill is a trailing sibling that appears, never a
  placeholder that resizes.
- Otherwise a `<span>` pill: coloured dot (`::before`), a translated
  one-word label, `text-xs font-semibold`, rounded-full, tinted background
  and border via `color-mix` on one of four colour tokens (`--rating-good`
  green, `--rating-medium` amber, `--rating-bad` red, `--rating-new` grey),
  defined in `index.css` for both themes and chosen to contrast on the
  masthead gradient and on the drawer's surface.
- Wrapped in the existing `Tooltip` component. Tooltip text by `reason`:
  - `overdue`: "{{count}} invoice(s) overdue · worst {{days}} days, {{number}}"
  - `chronic`: "Usually pays late · {{onTime}} of {{settled}} paid on time"
  - `punctual`: "{{onTime}} of {{settled}} invoices paid on time"
  - `mixed`: "{{onTime}} of {{settled}} paid on time" plus
    " · {{count}} past due" when `past_due_count > 0`
  - `new`: "No settled invoice yet"
  Followed by "checked {{ago}}" from `computed_at`.
- `stale`: pill at 55 % opacity, label suffixed with the cache age
  (e.g. "Good · 3 h"), tooltip prefixed with "Books unreachable —".
- `aria-label` carries the label and the reason so the tier is announced,
  and the dot is decorative.

### Sites

1. **New-project drawer** (`ClientCombobox`'s row in `ClientSection`):
   the pill sits in the flex row that holds the search input and the reset
   button, between the two, `hideNew` off. The input keeps `flex-1`, so
   the pill takes only its own width. It appears once the query resolves
   for the chosen contact, and disappears the moment the contact is reset
   or the id changes.
2. **Project panel masthead** (`ProjectDetailPanel`, the `h2.group/client`
   row): the pill is a peer of the pencil, `flex-shrink-0`, after the name
   `span.truncate`, `hideNew` on. The masthead keeps one row: the name
   truncates first. Hidden when `client_id` is null (legacy cards).

### i18n

Keys under `aito.rating.*` in all 14 locale files (`en, fr, de, es, it,
ja, ko, nl, pt-BR, ru, tr, uk, zh-CN, zh-TW`): the four labels, the five
reason strings (with `_one`/`_other` plural pairs where a count is
interpolated), the stale prefix and the "checked" suffix. The parity gate
rejects English placeholders, so every locale gets a real translation.

Labels: EN Good / Medium / Bad / New, FR Bon / Moyen / Mauvais / Nouveau.

## Testing

### Backend

- `tests/unit/services/test_aito_client_rating.py`: a parametrised table
  over `rate_invoices` covering every row of the worked examples above,
  the grace edge (7 vs 8 days), the on-time slack edge (3 vs 4 days),
  void/draft exclusion, the 24-month window edge, a paid invoice missing
  `last_payment_date`, and a partially paid invoice. The 2026-09-23 table
  adds the severe edge (45/46, company 60/61), the thin and weak records
  that get no buffer, the 90 % record that just does, and the company
  slack (14/15), grace (21/22), `good`-at-two and `chronic`-needs-three
  edges.
- Reader tests with `zoho_service` monkeypatched **on the instance** (the
  project's memory notes the class-vs-instance landmine): cache miss
  computes and writes, cache hit within TTL skips Books, TTL expiry
  recomputes, `refresh=1` forces, Books failure with a cached row returns
  `stale=True`, Books failure without one returns `unavailable`, default
  contact short-circuits, 429 does not raise; the contact read selects
  the company profile and is cached with the row, and a failed contact
  read keeps the cached flag (or scores an unseen customer as an
  individual) rather than dropping the rating.
- Route test: permission gate (static closure read, per the memory note),
  path registered ahead of `/{project_id}`, API-key classification.

### Frontend

- `ClientRatingPill.test.tsx`: the four tiers render their label and
  colour class, `unavailable` renders nothing, `new` with `hideNew` renders
  nothing, stale suffix and tooltip prefix, each reason's tooltip text,
  plural forms.
- `NewProjectDrawer.test.tsx`: picking a client shows the pill once the
  rating resolves; the walk-in default shows nothing.
- `ProjectDetailPanel` test: masthead shows the pill for a rated client,
  nothing for `new`, nothing for a null `client_id`; the row count of the
  masthead is unchanged.

## Out of scope

- Ratings in the client search dropdown (one Books call per row).
- A board-card badge or column sort by rating.
- Per-install tuning of the thresholds.
- Recording rating changes in the project timeline.
- A manual "override this customer's rating" control.
