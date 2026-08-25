# Filament profiles — Zoho price sync

**Date:** 2026-08-25
**Status:** approved, ready for implementation plan

Price every filament profile from the Zoho dealer catalogue by matching it on
brand, material and colour, so a profile's `filament_cost` reflects what the
filament actually costs.

## Why this is not the calculator's sync

The calculator already syncs filament prices from Zoho, but by a different
mechanism, and the difference is deliberate on both sides.

| | Calculator | Filament profiles (this design) |
|---|---|---|
| How a row is linked | User picks the item in `ZohoFilamentSearch`; `zoho_item_id` is stored | Matched automatically on every run; nothing stored |
| What sync does | Refreshes prices for already-linked rows | Matches, then prices confident matches |
| Unmatched rows | Cannot exist — a row is either linked or not synced | Reported as "needs attention" |

The calculator's route docstring states its own rule: *"Prices only. Brand,
material, margin and difficulty are never rewritten from Zoho, so a rename
upstream cannot clobber a hand-corrected filament."* That protection exists
because a calculator filament is a costing record the operator tunes.

A slicer profile is not that. Its brand/material/colour come from the preset
itself and are the *input* to matching rather than something sync could damage,
and its price is a fact about the filament rather than a tuned figure. So
auto-matching is safe here in a way it would not be there.

## Decisions

Four decisions were taken during brainstorming and are settled:

1. **Auto-match** on brand + material + colour. Not an explicit user-picked link.
2. **Only confident matches are written.** Everything else is left untouched and
   reported.
3. **Zoho wins.** A confident match overwrites an existing `filament_cost`,
   including a hand-typed one. Sync is the source of truth for price.
4. **One button** in the Filament Profiles page header. No per-card action, no
   scheduled run.

## The matching rule

A new pure function in `backend/app/services/zoho_filaments.py`:

```python
def match_profile(
    catalogue: list[FilamentProduct],
    brand: str,
    material: str,
    colour: str,
) -> ProfileMatch
```

The existing `_score` cannot serve this. It is a relevance ranker for free-text
search: it always yields a best row, so it can express "which is most relevant"
but never "is this a match at all". Confidence needs a predicate.

**Algorithm**

1. Normalise every value on both sides: lowercase, trim, collapse internal
   whitespace, strip punctuation.
2. Candidates are catalogue items whose **brand and material both agree** after
   normalisation. Both must agree — brand alone would match every PLA that
   vendor sells.
3. If more than one candidate remains, narrow by **exact normalised colour**.
4. A match is **confident** when exactly one candidate survives **and** that
   item's `has_price` is true.

**Outcomes** — `ProfileMatch` carries one of:

| Outcome | Meaning | Effect |
|---|---|---|
| `matched` | one candidate, priced | write `filament_cost` |
| `no_match` | zero candidates | leave untouched, report |
| `ambiguous` | ≥2 candidates after colour narrowing | leave untouched, report |
| `no_price` | one candidate, `has_price` false | leave untouched, report |

`no_price` is its own outcome rather than folded into `no_match` because it is a
different problem with a different fix: the item exists in Zoho and simply has a
dealer price of 0. Roughly a fifth of the catalogue is in that state, and
`FilamentProduct`'s own docstring warns those "must never be written into a
calculator filament's cost, or they silently zero out its printing cost". The
same hazard applies here.

The function is pure and does no I/O, so the risky half of this feature is
unit-testable without a database or a Zoho connection.

## Endpoint

`POST /api/v1/filament-profiles/zoho-sync`

Permission: `FILAMENTS_UPDATE` — the write permission the other mutating
filament-profile routes already use.

Failure branches mirror the calculator's exactly:

- **503** — Zoho not configured (`zoho_service.is_configured` false)
- **500** — `ZohoFilamentMappingError`, the catalogue could not be mapped
- **502** — any other failure reaching Zoho

Keeping 500 and 502 distinct is the distinction T-074 established: a catalogue
this app failed to parse is a bug on this side, and reporting it as an upstream
outage sends the operator to check the wrong system.

**Response**

```
{
  "priced":     int,   # confident matches whose filament_cost was changed
  "unchanged":  int,   # confident matches whose price already equalled Zoho's
  "attention":  [ { "id", "name", "reason", "candidates": [str] } ]
}
```

`reason` is one of `no_match` / `ambiguous` / `no_price`.

`candidates` is a list, not a single name, because `ambiguous` means two or more
items collided and naming only one of them would hide the actual problem. It
holds: the colliding item names for `ambiguous`, the single unpriced item's name
for `no_price`, and an empty list for `no_match`.

**The three counts are disjoint and sum to the profile count.** `priced` and
`unchanged` are both confident matches, split by whether the value actually
moved — so a run that changes nothing is visibly different from one that
repriced everything. `len(attention)` is everything else. Nothing is counted
twice.

## What gets written

Confident matches write `filament_cost` into the profile's `content` JSON — the
existing Bambu/Orca preset key, already present as `PresetForm.filament_cost` and
already surfaced as the editor's COST field. Writing there means the price flows
through to the slicer with no further plumbing.

**No schema change.** With auto-matching on every run and Zoho winning, a stored
`zoho_item_id` buys nothing for correctness: the match is recomputed each time.
The matched item name travels in the response instead. This keeps the feature
migration-free and fully reversible.

The accepted cost: once the summary is dismissed there is no record of *which*
Zoho item priced a given profile. If that turns out to matter, adding
`zoho_item_id` and `zoho_synced_at` later is additive and does not invalidate
anything here.

## Frontend

A **Sync prices from Zoho** button in the Filament Profiles page header, beside
Import.

On completion, a summary: how many priced, how many unchanged, how many need
attention — with the unresolved profiles listed by name and reason. The
"needs attention" list is the feature's safety property made visible; without it
auto-matching would be silently lossy, which is what decision 2 exists to
prevent.

Invalidate the presets query afterwards so cards and the editor show new costs.

New i18n keys across all 13 locales, including one string per `reason`.

## Testing

**Matcher (unit, pure — the bulk of the value):** exact match; brand mismatch;
material mismatch; colour disambiguating two same-brand/material items;
ambiguous pair surviving colour narrowing; zero-price item; empty and missing
brand/material/colour; case and whitespace variation.

**Route:** each of the 503 / 500 / 502 branches; writes cost on a confident
match; leaves a `no_match` / `ambiguous` / `no_price` profile's content
byte-identical; response counts and `attention` entries.

**Frontend:** button triggers the call; summary renders each reason; query
invalidated.

## Deliberate simplifications

**No chunking.** The calculator's sync uses client-driven keyset paging because
its filament table can grow large. Filament profiles are a hand-curated set of
tens, so this does one pass. If profile counts reach the point where a single
request is slow, the calculator's paging pattern is the template to copy.

**No per-profile re-sync.** Considered and dropped: the bulk run is cheap enough
that re-running it after fixing one profile's brand or colour is not a burden,
and a per-card action would add a second surface and its own i18n for a case the
bulk button already covers.

**No confirmation step.** An earlier option would have proposed matches for the
operator to confirm before writing. Dropped because decision 2 already prevents
the failure it guards against: nothing uncertain is ever written.
