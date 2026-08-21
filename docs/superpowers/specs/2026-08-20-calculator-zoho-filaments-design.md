# Calculator filaments linked to Zoho products

**Date:** 2026-08-20
**Status:** Approved, ready for planning

## Problem

Calculator filament costs are typed by hand. When a dealer price changes in Zoho,
every affected filament has to be found and re-entered, and nothing records where
a price came from. The 17 rows in `calculator_filaments` today carry no link to
the Zoho catalogue at all.

## Goal

Let the user pick a filament from Zoho when adding one, derive its cost per kg
from the Zoho dealer price, keep the link, and refresh every linked filament's
price on demand with one button.

## Zoho reality (probed 2026-08-20, live org)

These facts drove most of the design and are worth keeping written down.

- Filament items are identified by the custom field `cf_nature_du_produit ==
  "Filaments"`. Zoho accepts it as a **server-side query parameter** on
  `GET /items`, and it combines with `search_text`.
- **256 items** match: 251 `active`, 3 `confirmation_pending`, 2 `inactive`.
  Brands: eSUN 108, SUNLU 67, Polymaker 33, Inslogic 29, Bambu Lab 19.
- Dealer price lives in `cf_prix_dealer_usd_unformatted` (float). Despite the
  name, values are in app currency, not USD.
- **55 of 256 have a dealer price of 0.** `purchase_rate` is populated on 206
  items but matches the dealer price on only 17 of them — it is a *different*
  number and must never be used as a fallback.
- Item names follow `Brand - Material - Colour - 1.75mm - Weight`, e.g.
  `Bambu Lab - ABS-GF - Bleu (Blue) - 1.75mm - 1kg`.
- **Spools are not all 1 kg.** 10 items are 0.5 / 0.75 / 0.9 kg. Zoho's own
  `weight` field is empty (`""`) for every filament, so the weight exists only
  inside the name string.
- Two names carry no weight at all (`SUNLU - PETG - Gris Argent (Silver)`).
- One name has a doubled suffix:
  `Bambu Lab - ABS - Argent (Silver) - 1.75mm - 1kg Refill - 1.75mm - 1kg`.
- Zoho's own `search_text` matches item descriptions, so a bare search for
  "PLA" returns things like `Ancre Britanny 3,5KG` — unusable on its own.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Cost per kg | `dealer_price / spool_weight_kg`, weight parsed from the name | 10 sub-1kg spools would otherwise be under-costed by up to 2× |
| Colour | Ignored; one calculator filament per brand + material | Matches the existing `name = brand + material` model; 44 PETG colours would otherwise become 44 rows |
| Dealer price of 0 | Shown in search but flagged; never written to the DB | Prevents silently zeroing a filament's printing cost |
| Sync scope | Price only | A Zoho rename must not rewrite a hand-corrected brand/material |
| Manual entry | Still allowed | The 17 existing unlinked rows keep working; a filament can be priced before it exists in Zoho |
| Catalogue access | Server-side TTL cache | One Zoho call per window, instant search, and the sync reuses the same fetch |

### Why the catalogue is cached rather than proxied

A live proxy per keystroke costs a Zoho call per search and exposes the feature
to rate limits. A persisted mirror table is more machinery than the problem
needs. Caching the 256 items (2 pages) in memory for ~10 minutes — the pattern
`get_shipping_catalogue` already uses — gives fast local search, keeps search
scoring under our control, and hands the sync its data for free. The one thing a
cache cannot do is show a linked product's name after a restart, which is solved
by denormalizing `zoho_item_name` onto the filament row.

### Why `sale_price_per_kg` survives

`pricing.ts`, `calculatorInsights.ts`, archives and quotes all read
`sale_price_per_kg`. It stays as the stored column and stays the source of truth
for those consumers. What changes is that it becomes *derived output*, always
written as `round(cost_per_kg × (1 + margin_pct / 100), 2)` and never typed by
the user. Nothing downstream needs to change.

## Data model

`calculator_filaments` gains, via additive `ALTER TABLE` in
`backend/app/core/database.py:run_migrations()`:

| Column | Type | Meaning |
|---|---|---|
| `zoho_item_id` | `String(50)`, nullable | The linked Zoho item; `NULL` means a manual filament |
| `zoho_item_name` | `String(255)`, nullable | Denormalized for panel display without a Zoho call |
| `zoho_sku` | `String(100)`, nullable | Shown alongside the name to disambiguate |
| `spool_weight_kg` | `Float`, nullable | Divisor used to derive cost per kg; stored so sync can recompute |
| `margin_pct` | `Float`, default `50.0` | User-chosen margin over cost |
| `zoho_synced_at` | `DateTime`, nullable | Last successful price refresh |

**Backfill:** `margin_pct = (sale_price_per_kg / cost_per_kg - 1) × 100`, run once
for rows where `cost_per_kg > 0`. All 17 existing rows land on exactly 50% or 0%,
both already on the 25% grid, so no row is disturbed.

**Invariant:** `sale_price_per_kg == round(cost_per_kg × (1 + margin_pct/100), 2)`
must hold after every create, update and sync.

## Components

### `backend/app/services/zoho_filaments.py` (new)

Three independently testable pieces:

- `parse_filament_name(name) -> ParsedName` — pure, no I/O. Returns brand,
  material, colour and `spool_weight_kg`. Weight comes from the **last**
  `<number>kg` occurrence in the string (handles the doubled-suffix name);
  material is the second ` - ` segment; missing weight defaults to `1.0` and is
  reported as `weight_inferred=True` so the UI can flag it.
- `fetch_catalogue(db, *, refresh=True) -> list[FilamentProduct]` — paginates
  `GET /items?cf_nature_du_produit=Filaments&per_page=200`, keeps `active` items
  only, maps each through `parse_filament_name`, computes
  `cost_per_kg = dealer_price / spool_weight_kg`. Module-level TTL cache (~10
  min). A failed refresh returns the previous cache rather than raising.
- `search(catalogue, q, limit) -> list[FilamentProduct]` — local scoring over
  brand, material, colour, SKU and full name. Zoho's `search_text` is not used.

### Endpoints on `/api/v1/calculator`

- `GET /zoho-filaments?q=&limit=` — `CALCULATOR_READ`. Returns matching products
  with `item_id`, `name`, `sku`, `brand`, `material`, `colour`,
  `spool_weight_kg`, `weight_inferred`, `dealer_price`, `cost_per_kg`,
  `has_price`. Returns `503` when Zoho is not configured.
- `POST /filaments/zoho-sync` — `CALCULATOR_UPDATE`. Body `{offset, limit}`.
  Processes one chunk of linked filaments and returns
  `{processed, total, updated, unchanged, skipped_no_price, missing, next_offset}`.
  `next_offset` is `null` on the final chunk. Chunks walk filaments where
  `zoho_item_id IS NOT NULL` **ordered by `id`** — a stable ordering is required
  or offset-based paging will skip or repeat rows.

`CalculatorFilamentCreate` / `Update` / `Response` gain the six new columns.
`sale_price_per_kg` is dropped from the *create* and *update* inputs (the server
derives it from `cost_per_kg` and `margin_pct`) but stays in the response, where
every existing consumer reads it.

Chunking is driven by the client looping sequential requests, not by a background
job. Each chunk commits its own work, so progress is real and a retry resumes
from the last offset.

### Frontend

**`FilamentForm`** (`components/CalculatorSettingsPanels.tsx`) — field order:

1. Zoho product search (top), debounced ~300 ms. Each result shows
   `Brand · Material · Colour`, the dealer price, the spool weight, and a
   "no dealer price" badge for the 55 zero-priced items.

   Results are listed **per Zoho item, colour included** — not collapsed to
   brand + material. Colour is not stored on the filament, but dealer prices
   genuinely differ between colours of the same material (Bambu ABS-GF is 1866
   in Blue and 3208 in Black), so which colour the user picks determines the
   price and must stay visible. Searching "PETG" therefore lists all 44 PETG
   colours; the search box is expected to be narrowed by brand or colour.
2. Brand — read-only when linked
3. Material — read-only when linked
4. Spool weight (kg) — shown only when linked, prefilled from the parse,
   editable so an odd name can be corrected; cost per kg recomputes live
5. Cost per kg — read-only when linked, editable when manual
6. Difficulty — unchanged
7. **Margin** — `<select>` with 0, 25, … 200. If a stored margin is off-grid it
   is prepended as a selectable option so the row can be saved unchanged
8. **Printing cost per kg** — read-only, last field,
   `cost_per_kg × (1 + margin/100)`

When linked, the form shows a `Zoho: <item name> (<sku>)` chip with an **Unlink**
action that clears the four Zoho columns and restores manual editing.

Selecting a zero-priced product fills brand and material and leaves cost blank.

**`CalculatorFilamentsPanel`** — a **Sync** button in the header beside Add,
rendered only when the user has `CALCULATOR_UPDATE` and Zoho is configured. It
loops chunks of 25, shows an inline `75 / 180` progress bar, disables itself
while running, and ends with a summary of updated / unchanged / skipped-no-price
/ no-longer-in-Zoho counts.

**Table** — the `Sale/kg` column header becomes `Printing cost/kg`; linked rows
carry a small Zoho indicator.

**i18n** — `calculator.salePerKg` is renamed to `calculator.printingCostPerKg`,
and new keys are added for the search bar, link chip, margin label, sync button,
progress and summary. All 13 locales need real translations; the project's i18n
gate rejects English placeholders.

## Error handling

| Case | Behaviour |
|---|---|
| Zoho not configured | Search bar and Sync button hidden; endpoints return `503` |
| Zoho unreachable during search | Search shows an error row; the rest of the form still works |
| Zoho fails mid-sync | The chunk errors, the progress bar stops with a message, earlier chunks stay committed, retry resumes from the offset |
| Dealer price is 0 | Never written; counted as `skipped_no_price` |
| Linked item deleted from Zoho | Counted as `missing`; the filament keeps its last price and its link |
| Link duplicates an existing brand + material | Warn, do not block — duplicates already exist (SUNLU/ASA appears twice) |
| Name has no parseable weight | Defaults to 1 kg, flagged in the form so the user can correct it |

## Testing

**Backend**

- `parse_filament_name` against the real name corpus: standard names, all 10
  sub-1kg spools, the 2 weightless names, and the doubled-suffix Refill name.
  This is the highest-value test in the feature.
- Catalogue pagination, `active`-only filtering, TTL behaviour, and
  failed-refresh-returns-stale-cache.
- Sync chunk arithmetic: offsets, `next_offset` termination, counts summing to
  `processed`.
- Zero dealer price never overwrites an existing cost.
- The `sale_price_per_kg == cost × (1 + margin)` invariant after create, update
  and sync.
- Migration backfill produces 50% / 0% for the existing rows.

**Frontend**

- Selecting a product fills brand/material/cost and locks them; Unlink restores
  editability.
- Margin dropdown recomputes the read-only printing cost.
- Selecting a zero-priced product leaves cost blank.
- Sync loop issues sequential chunks and renders progress, then the summary.
- Existing `CalculatorSettingsPanels` tests updated for the renamed field.

**Fixture sweep:** `sale_price_per_kg` appears in ~15 test files. Per CLAUDE.md,
`tsconfig.app.json` excludes `src/__tests__`, so adding required fields to the
`CalculatorFilament` interface produces **no compiler error** in fixtures — they
must be found by grepping the field name, not by running `tsc`.

## Out of scope

- Pushing prices from the calculator back into Zoho.
- Automatic or scheduled syncing; the button is manual by design.
- Per-colour filament rows.
- Linking existing filament-inventory records (`models/filament.py`) to Zoho.
