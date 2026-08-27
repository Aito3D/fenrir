# Hyperbolic margin curve — design

Date: 2026-08-27. Status: approved in chat, awaiting written review.

## Goal

Replace the flat `global_markup_pct` margin with a per-task multiplier that
falls hyperbolically as the task's cost base grows, plus a per-task price
floor. Small jobs carry a high margin, large jobs a lean one, and ten copies
of a 5-unit part earn the margin of a 50-unit task — never of a 5-unit one.
The four curve parameters are operator-editable in their own calculator
settings panel, and the calculator's bulk table is replaced by a panel that
draws the curve so the operator can see unit price versus quantity.

## Non-goals

- No change to filament margin (`margin_filament`), extras markup
  (`margin_stuff`), provisions, ads, base fee or tax.
- No recompute of stored Aito `impression_cost` values on existing projects.
- No per-project fee in Aito (a project with three print tasks pays the
  floor/multiplier three times, once per task — same trade-off as the base
  fee decision of 2026-08-27).
- `global_markup_pct` is not deleted from the database (this repo only adds
  columns). It is removed from the settings UI and stops being read by the
  engine.

## 1. Engine — `frontend/src/utils/pricing.ts`

Only Phase C ("margins") changes. Phase A/B (`total_cost`, provisions, ads,
amortized one-time costs) are untouched, so `total_cost` remains the per-unit
cost base and `unit_base` of the request is exactly `total_cost`.

New fields on `PricingDefaults`:

| field | default | bound | meaning |
|---|---|---|---|
| `margin_min_mult` | 1.15 | ≥ 1 | M_MIN — multiplier on very large tasks |
| `margin_max_mult` | 1.60 | ≥ 1, ≥ `margin_min_mult` | M_MAX — multiplier on very small tasks |
| `margin_k` | 33 | > 0 | K — task cost base (app currency) at which the multiplier is the midpoint |
| `min_task_price` | 12 | ≥ 0 | MIN_PRICE — pre-tax floor per task (app currency) |

All four are optional on `PricingDefaults` (like `base_fee_flat`) so a
pre-migration config still computes; absent → the defaults above.

Pure helper, exported and unit-tested on its own:

```
marginMultiplier(c, d) =
  d.margin_min_mult + (d.margin_max_mult − d.margin_min_mult) × d.margin_k / (c + d.margin_k)
```

Guards (never NaN/Infinity): if `margin_k ≤ 0` or `margin_max_mult <
margin_min_mult` the multiplier is `margin_min_mult`; `c < 0` is clamped to 0.

In `computePricing`:

```
task_base      = total_cost × quantity             // c is per TASK, never per unit
multiplier     = marginMultiplier(task_base, defaults)
margin_global  = total_cost × (multiplier − 1)     // per unit, same slot as today
margin_filament, margin_stuff                       // unchanged
total_ht       = total_cost + margin_global + margin_filament + margin_stuff
floor_shortfall = max(0, min_task_price − total_ht × quantity)
if floor_shortfall > 0:
    margin_global += floor_shortfall / quantity     // floor is booked as margin
    total_ht       = total_cost + margin_global + margin_filament + margin_stuff
marge, total_ttc, margin_pct, *_qty                // unchanged formulas
```

New `PricingResult` fields: `margin_multiplier: number` (the value before the
floor adjustment), `floor_applied: boolean`. Everything else keeps its name
and meaning, so the breakdown card, waterfall (`buildWaterfall` invariant:
last cumulative = `total_ttc`), discount matrix, break-even and target-price
helpers need no formula changes.

Rounding: the engine stays full precision (project convention: round at
display via `formatMoney`). The quote page rounds the task figure
(`total_ht_qty` / `total_ttc_qty`) to the currency's decimals and derives the
displayed unit price as `rounded task ÷ quantity`, so the quote's unit × qty
reproduces its task total.

`bulkPricing()` and `BULK_QUANTITIES/BULK_DISCOUNTS` are removed together
with the bulk table (section 4). A new pure helper replaces them:

```
unitPriceCurve(inputs, filament, printer, defaults, quantities): CurvePoint[]
CurvePoint = { quantity, unit_ht, unit_ttc, task_ttc, multiplier, floor_applied }
```

Each point is a full `computePricing` at that quantity (one-time costs
amortize, the multiplier slides down the curve, the floor bites at low
quantities).

Sanity rows pinned by tests (formula values; the request's table drifts by a
few cents at larger c and the formula is the authority):

| unit_base | qty | task_base | multiplier | task_price |
|---|---|---|---|---|
| 5 | 1 | 5 | 1.5408 | 12.00 (floor) |
| 5 | 4 | 20 | 1.4302 | 28.60 |
| 5 | 20 | 100 | 1.2617 | 126.17 |
| 60 | 1 | 60 | 1.3097 | 78.58 |
| 60 | 10 | 600 | 1.1735 | 704.08 |

(These rows are exercised with filament sale price = cost and no extras, so
`margin_filament = margin_stuff = 0` and `task_price = total_ht_qty`.)

## 2. Persistence and API

- `backend/app/models/calculator.py` `CalculatorDefaults`: four new
  `Float` columns with the defaults above.
- `backend/app/core/database.py:run_migrations()`: four additive
  `ALTER TABLE calculator_defaults ADD COLUMN …` with the same defaults,
  next to the `base_fee_flat` migration.
- `backend/app/schemas/calculator.py`: `CalculatorDefaultsUpdate` gets the
  four optional fields with bounds (`margin_min_mult ge=1 le=100`,
  `margin_max_mult ge=1 le=100`, `margin_k gt=0 le=_MONEY_CEILING`,
  `min_task_price ge=0 le=_MONEY_CEILING`) and a model validator rejecting
  `margin_max_mult < margin_min_mult` when both are present in the PATCH —
  and, in the route, against the stored row when only one is sent, so a
  partial update cannot leave the pair inverted. `CalculatorDefaultsResponse`
  gets the four required fields.
- `frontend/src/api/client.ts` `CalculatorDefaults`: four new number fields.
- Currency note: K and the floor are amounts in the app currency. The
  request's defaults (33, 12) are Euro figures; they are stored verbatim as
  the column defaults and the operator adjusts them in the panel for other
  currencies (an XPF shop would set K ≈ 4 000, floor ≈ 1 400).

## 3. Settings UI — new "Margin curve" panel

New component `frontend/src/components/calculator/CalculatorMarginCurvePanel.tsx`,
exported through the `CalculatorSettingsPanels.tsx` barrel and mounted as its
own tab of the calculator settings (next to Defaults / Filaments / Printers;
the tab list and its sidebar/nav test fixtures are updated).

- Four `NumberField`s (`calc-def-margin_min_mult`, …) with the bounds of
  section 2 mirrored client-side, the same dirty/refetch/save mechanics as
  `CalculatorDefaultsPanel` (extract the shared form logic into
  `calculatorSettingsShared.ts` rather than copy it), Save gated by
  `canUpdate`.
- A live preview under the fields: the multiplier at a handful of task
  costs (K/4, K/2, K, 2K, 4K, 10K — formatted with `formatMoney`) and a
  small line chart of `marginMultiplier` from 0 to 10K, rendered with the
  form's current (unsaved) values so the operator sees what they are about
  to save. Chart follows the `dataviz` skill (load it before writing the
  chart) and reuses the `--viz-*` tokens the waterfall uses.
- Client-side cross-field error when max < min (same message key the server
  returns).
- `global_markup_pct` is removed from `DEFAULTS_FIELDS_GENERAL` in
  `CalculatorDefaultsPanel.tsx`; its i18n key stays for old translations.
- i18n: new keys (`calculator.tabMarginCurve`, `calculator.marginCurveHint`,
  `calculator.marginMinMult`, `calculator.marginMaxMult`, `calculator.marginK`,
  `calculator.minTaskPrice`, `calculator.marginCurvePreview`,
  `calculator.marginCurveMaxBelowMin`, `calculator.multiplier`,
  `calculator.floorApplied`, `calculator.curveTitle`, `calculator.curveHint`,
  `calculator.curveUnitPrice`, `calculator.curveTaskPrice`) in all 13 locales
  — the parity gate rejects English placeholders, so each locale gets a real
  translation.

## 4. Calculator page — curve panel replaces the bulk table

`CalculatorBulkTable.tsx` is deleted. New
`CalculatorQuantityCurve.tsx` takes `unitPriceCurve(...)` output and
renders, in the same slot (`CalculatorPage.tsx` non-easy mode):

- A line chart, x = quantity (the fixed ladder 1, 2, 5, 10, 20, 50, 100,
  200, 500 plus the current quantity, sorted, deduped), y = unit price TTC.
  The current quantity's point is highlighted; floored points are marked.
- A compact table under the chart with quantity, unit price TTC, task total
  TTC, multiplier (×1.43) — replacing the discount-column grid the bulk
  table had. Discounts stay in the separate discount matrix card.
- Empty/zero states as the bulk table today (nothing when no result).

Breakdown card: the global-margin row shows the multiplier
(`t('calculator.multiplier')` → "×1.43") and a `floorApplied` note when the
floor bit. Totals card unchanged.

## 5. Consumers

`CalculatorPage`, `estimateArchiveSalePrice` (archives: quantity 1, so c is
the whole job's cost) and `computeImpressionCost` (Aito: quantity = task
quantity) all call `computePricing` and pick the curve up with no code
change. Aito's stored `impression_cost` is what the engine returns per unit;
the quote line's `rate × quantity` (see `aito_quote_export.rate_quantity`)
already rounds per unit — the floor therefore lands in the per-unit rate,
which is acceptable.

Tests of those consumers that assert exact totals computed with
`global_markup_pct` are rewritten against the curve.

## 6. Tests

Frontend (`__tests__/utils/pricing.test.ts`):
- `marginMultiplier`: the five sanity rows; strictly decreasing over an
  increasing c series; equals midpoint at c = K; guards for `k ≤ 0`,
  `max < min`, negative c; never NaN.
- `computePricing`: c uses quantity (unit 5 × qty 10 gets the c = 50
  multiplier); floor raises `margin_global` and sets `floor_applied`, and
  `total_ht_qty === min_task_price` exactly; no floor → `floor_applied`
  false; `buildWaterfall` invariant still holds with the floor; absent curve
  fields fall back to defaults; `margin_filament`/`margin_stuff` unchanged.
- `unitPriceCurve`: monotone non-increasing `unit_ht` over the ladder for a
  job with no one-time costs; includes the current quantity.
- Components: MarginCurvePanel bound-driving test in the pattern of
  `CalculatorSettingsPanels.test.tsx`; QuantityCurve renders the ladder and
  highlights the current quantity; CalculatorPage no longer renders the
  bulk table.
- `archivePricing.test.ts`, `taskDraft.test.ts`, CalculatorPage/QuotePage
  tests: expected totals updated.

Backend (`tests/unit/test_calculator_routes.py` + migration test):
- GET returns the four fields with defaults on a fresh DB.
- PATCH bounds; `margin_max_mult < margin_min_mult` → 422 both when sent
  together and when one is sent against a stored value that inverts it.
- Migration adds the columns to a pre-existing table.

Verification before merge: `cd frontend && npm run build`,
`./test_frontend.sh`, `./test_backend.sh`.
