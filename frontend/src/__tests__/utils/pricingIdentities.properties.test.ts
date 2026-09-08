// Property tests for the pricing engine's CROSS-FUNCTION identities — the
// claims one exported function makes about another (filamentLineCost vs
// computePricing, discountMatrix/unitPriceCurve vs computePricing,
// breakEvenDiscount vs computePricing). Single-function invariants live in
// pricing.properties.test.ts; this file is about the promises between them.
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { arbDefaults, arbFilament, arbInputs, arbPrinter } from './pricingArbitraries';
import {
  computePricing,
  filamentLineCost,
  discountMatrix,
  unitPriceCurve,
  breakEvenDiscount,
  CURVE_QUANTITIES,
} from '../../utils/pricing';

const RUNS = { seed: 42, numRuns: 150 } as const;

const MONEY_FIELDS = [
  'filament_cost', 'depreciation_cost', 'energy_cost', 'repairs_cost',
  'machine_cost', 'prototype_cost', 'failures_cost', 'machine_cost_safety',
  'ads_cost', 'consumables_flat', 'base_fee_total', 'base_fee',
  'modeling_cost_total', 'prep_cost_total', 'modeling_cost', 'prep_cost',
  'post_processing_cost', 'stuff_cost', 'labor_total', 'risk_base',
  'total_cost', 'margin_global', 'margin_filament', 'margin_stuff',
  'marge', 'total_ht', 'total_ttc', 'total_ht_qty',
  'total_ttc_qty',
] as const;

describe('computePricing is total', () => {
  it('never produces a NaN or Infinity in any money field', () => {
    fc.assert(
      fc.property(arbInputs(), arbFilament(), arbPrinter(), arbDefaults(), (i, f, p, d) => {
        const r = computePricing(i, f, p, d);
        for (const key of MONEY_FIELDS) {
          expect(Number.isFinite(r[key]), `${key} = ${r[key]}`).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it('never charges less tax-inclusive than pre-tax', () => {
    fc.assert(
      fc.property(arbInputs(), arbFilament(), arbPrinter(), arbDefaults(), (i, f, p, d) => {
        const r = computePricing(i, f, p, d);
        expect(r.total_ttc).toBeGreaterThanOrEqual(r.total_ht - 1e-6);
        expect(r.total_ttc_qty).toBeGreaterThanOrEqual(r.total_ht_qty - 1e-6);
      }),
      RUNS,
    );
  });

  // min_task_price is documented as "Pre-tax floor per task" (pricing.ts),
  // i.e. a whole-job amount — computePricing enforces it against
  // pre_floor_ht * quantity, not against the per-unit total_ht. The brief's
  // original property compared the floor to total_ht (per unit), which is
  // wrong for quantity > 1: at quantity 10 a 100-currency floor produces a
  // ~10-currency per-unit total_ht by design. Fixed to compare against
  // total_ht_qty (= total_ht * quantity), the actual task-level figure the
  // floor logic targets.
  it('applies the per-task floor whenever it says it did', () => {
    fc.assert(
      fc.property(arbInputs(), arbFilament(), arbPrinter(), arbDefaults(), (i, f, p, d) => {
        const r = computePricing(i, f, p, d);
        const floor = d.min_task_price ?? 0;
        if (r.floor_applied) {
          expect(r.total_ht_qty).toBeGreaterThanOrEqual(floor - 1e-6);
        }
      }),
      RUNS,
    );
  });

  // Converse of the property above: `floor_applied` isn't just true whenever
  // it's safe to be true (a mutation pinning it to `false` unconditionally
  // would still pass "applies the floor whenever it says it did" — that
  // property only checks the true branch). pricing.ts computes
  // `floor_shortfall = max(0, min_task_price - pre_floor_ht * quantity)` and
  // `floor_applied = floor_shortfall > 0`, i.e. floor_applied must be true
  // whenever the PRE-floor task total falls short of min_task_price.
  // `margin_global` on the returned result is already post-floor (the lift
  // is added in place), so the pre-floor value is rebuilt from
  // `margin_multiplier`, which computePricing never adjusts for the floor:
  // pre-floor margin_global ≡ total_cost * (margin_multiplier - 1).
  it('applies the floor whenever the pre-floor task total genuinely falls short of it', () => {
    fc.assert(
      fc.property(arbInputs(), arbFilament(), arbPrinter(), arbDefaults(), (i, f, p, d) => {
        const r = computePricing(i, f, p, d);
        const floor = d.min_task_price ?? 0;
        const preFloorMarginGlobal = r.total_cost * (r.margin_multiplier - 1);
        const preFloorHt = r.total_cost + preFloorMarginGlobal + r.margin_filament + r.margin_stuff;
        const preFloorTotal = preFloorHt * r.quantity;
        if (preFloorTotal < floor - 1e-6) {
          expect(r.floor_applied).toBe(true);
        }
      }),
      RUNS,
    );
  });
});

describe('the filament line splits exactly', () => {
  // pricing.ts on filamentLineCost: "computePricing prices filament at
  // cost_per_kg and books the sale-price delta as margin_filament; the two
  // split this line exactly (cost part + margin part ≡ this value)."
  it('cost part plus margin part equals the quote-style line', () => {
    fc.assert(
      fc.property(arbInputs(), arbFilament(), arbPrinter(), arbDefaults(), (i, f, p, d) => {
        const r = computePricing(i, f, p, d);
        const line = filamentLineCost(i.weight_g, f, d);
        const rebuilt = r.filament_cost + r.margin_filament;
        const scale = Math.max(1, Math.abs(line));
        expect(Math.abs(rebuilt - line) / scale).toBeLessThan(1e-6);
      }),
      RUNS,
    );
  });
});

describe('discount and quantity curves are monotone', () => {
  it('a deeper discount never raises the price', () => {
    fc.assert(
      fc.property(arbInputs(), arbFilament(), arbPrinter(), arbDefaults(), (i, f, p, d) => {
        const rows = discountMatrix(computePricing(i, f, p, d));
        for (let n = 1; n < rows.length; n += 1) {
          expect(rows[n].price).toBeLessThanOrEqual(rows[n - 1].price + 1e-6);
        }
      }),
      RUNS,
    );
  });

  it('a larger quantity never raises the unit price', () => {
    fc.assert(
      fc.property(arbInputs(), arbFilament(), arbPrinter(), arbDefaults(), (i, f, p, d) => {
        const points = unitPriceCurve(i, f, p, d, CURVE_QUANTITIES);
        for (let n = 1; n < points.length; n += 1) {
          expect(points[n].unit_ht).toBeLessThanOrEqual(points[n - 1].unit_ht + 1e-6);
        }
      }),
      RUNS,
    );
  });

  it('break-even discount, when it exists, lands at zero profit', () => {
    fc.assert(
      fc.property(arbInputs(), arbFilament(), arbPrinter(), arbDefaults(), (i, f, p, d) => {
        const r = computePricing(i, f, p, d);
        const be = breakEvenDiscount(r);
        if (be === null) return;
        expect(be).toBeGreaterThanOrEqual(0);
        expect(be).toBeLessThanOrEqual(1);
        const priceAtBe = r.total_ht * (1 - be);
        expect(Math.abs(priceAtBe - r.total_cost) / Math.max(1, r.total_cost)).toBeLessThan(1e-6);
      }),
      RUNS,
    );
  });

  // breakEvenDiscount's null return is behaviour-bearing now — it decides
  // whether CalculatorDiscountTable shows the break-even line and (via
  // belowCost's fallback) whether every column gets tinted red — so pin
  // WHEN it is null, not just what holds when it isn't. pricing.ts:
  // null iff total_ht <= 0 OR total_cost > total_ht; a number otherwise. An
  // unconditional-null mutation of breakEvenDiscount fails the `else`
  // branch here (be would never be a number even when total_ht > total_cost
  // > 0), and a never-null mutation fails the `if` branch.
  it('breakEvenDiscount is null exactly when total_ht <= 0 or total_cost > total_ht', () => {
    fc.assert(
      fc.property(arbInputs(), arbFilament(), arbPrinter(), arbDefaults(), (i, f, p, d) => {
        const r = computePricing(i, f, p, d);
        const be = breakEvenDiscount(r);
        const shouldBeNull = r.total_ht <= 0 || r.total_cost > r.total_ht;
        if (shouldBeNull) {
          expect(be).toBeNull();
        } else {
          expect(be).not.toBeNull();
          expect(typeof be).toBe('number');
        }
      }),
      RUNS,
    );
  });
});
