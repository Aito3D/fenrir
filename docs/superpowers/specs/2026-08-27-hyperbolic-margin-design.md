# Hyperbolic margin curve — design

Date: 2026-08-27. Status: approved in chat, awaiting written review.

## Goal

Replace the flat `global_markup_pct` margin with two independent hyperbolic
curves per task, plus a per-task price floor:

1. **Size margin** — the margin multiplier falls as the *unit's* cost base
   grows (small parts carry more management overhead).
2. **Quantity discount** — the margin *above cost* shrinks as the quantity
   grows; cost itself is never discounted, so price ≥ cost always.

The six curve parameters are operator-editable in their own calculator
settings panel, and the calculator's bulk table is replaced by a panel that
draws the resulting unit price versus quantity.

## Non-goals

- No change to filament margin (`margin_filament`), extras markup
  (`margin_stuff`), provisions, ads, base fee or tax.
- No recompute of stored Aito `impression_cost` values on existing projects.
- No per-project fee in Aito (a project with three print tasks meets the
  floor three times, once per task — same trade-off as the base fee decision
  of 2026-08-27).
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
| `margin_min_mult` | 1.15 | ≥ 1 | M_MIN — multiplier on very large parts |
| `margin_max_mult` | 1.60 | ≥ 1, ≥ `margin_min_mult` | M_MAX — multiplier on very small parts |
| `margin_k` | 33 | > 0 | K — unit cost base (app currency) at which the size margin is the midpoint |
| `qty_min_factor` | 0.40 | > 0, ≤ 1 | Q_MIN — fraction of the margin kept at very high quantity |
| `qty_k` | 5 | > 0 | KQ — quantity at which the discount is halfway to Q_MIN |
| `min_task_price` | 12 | ≥ 0 | MIN_PRICE — pre-tax floor per task (app currency) |

All six are optional on `PricingDefaults` (like `base_fee_flat`) so a
pre-migration config still computes; absent → the defaults above.

Pure helpers, exported and unit-tested on their own:

```
sizeMargin(u, d)  = d.margin_min_mult + (d.margin_max_mult − d.margin_min_mult) × d.margin_k / (u + d.margin_k)
qtyFactor(q, d)   = d.qty_min_factor + (1 − d.qty_min_factor) × d.qty_k / (q − 1 + d.qty_k)
unitMultiplier(u, q, d) = 1 + (sizeMargin(u, d) − 1) × qtyFactor(q, d)
```

Guards (never NaN/Infinity): `margin_k ≤ 0` or `margin_max_mult <
margin_min_mult` → `sizeMargin = margin_min_mult`; `qty_k ≤ 0` or
`qty_min_factor` outside (0, 1] → `qtyFactor = 1`; `u < 0` clamped to 0;
`q < 1` treated as 1 (so `qtyFactor(1) = 1` exactly).

In `computePricing`:

```
multiplier     = unitMultiplier(total_cost, quantity, defaults)   // size on the UNIT, discount on the qty
margin_global  = total_cost × (multiplier − 1)                     // per unit, same slot as today
margin_filament, margin_stuff                                        // unchanged
total_ht       = total_cost + margin_global + margin_filament + margin_stuff
floor_shortfall = max(0, min_task_price − total_ht × quantity)
if floor_shortfall > 0:
    margin_global += floor_shortfall / quantity                      // floor is booked as margin
    total_ht       = total_cost + margin_global + margin_filament + margin_stuff
marge, total_ttc, margin_pct, *_qty                                  // unchanged formulas
```

New `PricingResult` fields: `size_margin: number`, `qty_factor: number`,
`margin_multiplier: number` (all before the floor adjustment),
`floor_applied: boolean`. Everything else keeps its name and meaning, so the
breakdown card, waterfall (`buildWaterfall` invariant: last cumulative =
`total_ttc`), discount matrix, break-even and target-price helpers need no
formula changes.

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
amortize, the quantity discount slides down its curve, the floor bites at
low quantities).

Sanity rows pinned by tests (formula values; the request's table drifts by a
few cents from rounding and the formula is the authority):

| unit_base | qty | size_margin | qty_factor | multiplier | unit | task_price |
|---|---|---|---|---|---|---|
| 5 | 1 | 1.5408 | 1.0000 | 1.5408 | 7.70 | 12.00 (floor) |
| 5 | 4 | 1.5408 | 0.7750 | 1.4191 | 7.10 | 28.38 |
| 5 | 10 | 1.5408 | 0.6143 | 1.3322 | 6.66 | 66.61 |
| 5 | 50 | 1.5408 | 0.4556 | 1.2464 | 6.23 | 311.60 |
| 60 | 1 | 1.3097 | 1.0000 | 1.3097 | 78.58 | 78.58 |
| 60 | 10 | 1.3097 | 0.6143 | 1.1902 | 71.41 | 714.10 |
| 200 | 1 | 1.2137 | 1.0000 | 1.2137 | 242.75 | 242.75 |
| 200 | 10 | 1.2137 | 0.6143 | 1.1313 | 226.26 | 2262.6 |

(These rows are exercised with filament sale price = cost, no extras and no
one-time costs, so `margin_filament = margin_stuff = 0`, `total_cost` is
constant across quantities and `task_price = total_ht_qty`.)

## 2. Persistence and API

- `backend/app/models/calculator.py` `CalculatorDefaults`: six new
  `Float` columns with the defaults above.
- `backend/app/core/database.py:run_migrations()`: six additive
  `ALTER TABLE calculator_defaults ADD COLUMN …` with the same defaults,
  next to the `base_fee_flat` migration.
- `backend/app/schemas/calculator.py`: `CalculatorDefaultsUpdate` gets the
  six optional fields with bounds (`margin_min_mult ge=1 le=100`,
  `margin_max_mult ge=1 le=100`, `margin_k gt=0 le=_MONEY_CEILING`,
  `qty_min_factor gt=0 le=1`, `qty_k gt=0 le=1_000_000`,
  `min_task_price ge=0 le=_MONEY_CEILING`) and a model validator rejecting
  `margin_max_mult < margin_min_mult` when both are present in the PATCH —
  and, in the route, against the stored row when only one is sent, so a
  partial update cannot leave the pair inverted. `CalculatorDefaultsResponse`
  gets the six required fields.
- `frontend/src/api/client.ts` `CalculatorDefaults`: six new number fields.
- Currency note: K and the floor are amounts in the app currency. The
  request's defaults (33, 12) are Euro figures; they are stored verbatim as
  the column defaults and the operator adjusts them in the panel for other
  currencies (an XPF shop would set K ≈ 4 000, floor ≈ 1 400).

## 3. Settings UI — new "Margin curve" panel

New component `frontend/src/components/calculator/CalculatorMarginCurvePanel.tsx`,
exported through the `CalculatorSettingsPanels.tsx` barrel and mounted as its
own tab of the calculator settings (next to Defaults / Filaments / Printers;
the tab list and its sidebar/nav test fixtures are updated).

- Six `NumberField`s (`calc-def-margin_min_mult`, …), grouped as "Size
  margin" (M_MIN, M_MAX, K) and "Quantity discount" (Q_MIN, KQ) plus the
  floor, with the bounds of
  section 2 mirrored client-side, the same dirty/refetch/save mechanics as
  `CalculatorDefaultsPanel` (extract the shared form logic into
  `calculatorSettingsShared.ts` rather than copy it), Save gated by
  `canUpdate`.
- A live preview under the fields, two small charts side by side:
  `sizeMargin` over unit cost 0 → 10K (with the midpoint at K marked) and
  `qtyFactor` over quantity 1 → 100 (midpoint at KQ marked), each with a
  short value strip (K/4, K/2, K, 2K, 4K, 10K; and q = 1, 2, 5, 10, 20, 50,
  100), rendered with the form's current (unsaved) values so the operator sees what they are about
  to save. Chart follows the `dataviz` skill (load it before writing the
  chart) and reuses the `--viz-*` tokens the waterfall uses.
- Client-side cross-field error when max < min (same message key the server
  returns).
- `global_markup_pct` is removed from `DEFAULTS_FIELDS_GENERAL` in
  `CalculatorDefaultsPanel.tsx`; its i18n key stays for old translations.
- i18n: new keys (`calculator.tabMarginCurve`, `calculator.marginCurveHint`,
  `calculator.marginMinMult`, `calculator.marginMaxMult`, `calculator.marginK`,
  `calculator.qtyMinFactor`, `calculator.qtyK`, `calculator.minTaskPrice`,
  `calculator.sizeMarginGroup`, `calculator.qtyDiscountGroup`, `calculator.marginCurvePreview`,
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
  TTC, quantity factor and multiplier (×1.43) — replacing the discount-column grid the bulk
  table had. Discounts stay in the separate discount matrix card.
- Empty/zero states as the bulk table today (nothing when no result).

Breakdown card: the global-margin row shows the multiplier
(`t('calculator.multiplier')` → "×1.43", with a tooltip "size ×1.54 · qty
0.78") and a `floorApplied` note when the floor bit. Totals card unchanged.

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
- `sizeMargin`: strictly decreasing in u; midpoint at u = K; guards for
  `k ≤ 0`, `max < min`, negative u. `qtyFactor`: exactly 1 at q = 1;
  strictly decreasing; equals `(1 + Q_MIN) / 2` at q = KQ + 1; guards for `qty_k ≤ 0`, `qty_min_factor` out of (0, 1],
  q < 1. `unitMultiplier` ≥ 1 always. The eight sanity rows. Never NaN.
- `computePricing`: size margin uses the UNIT cost (unit 5 × qty 10 keeps
  the u = 5 size margin, discounted by qtyFactor(10)); price ≥ total_cost
  at any quantity; floor raises `margin_global` and sets `floor_applied`, and
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
- GET returns the six fields with defaults on a fresh DB.
- PATCH bounds; `margin_max_mult < margin_min_mult` → 422 both when sent
  together and when one is sent against a stored value that inverts it.
- Migration adds the columns to a pre-existing table.

Verification before merge: `cd frontend && npm run build`,
`./test_frontend.sh`, `./test_backend.sh`.
