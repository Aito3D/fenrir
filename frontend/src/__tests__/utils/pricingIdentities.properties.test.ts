// Property tests for the pricing engine's CROSS-FUNCTION identities — the
// claims one exported function makes about another (filamentLineCost vs
// computePricing, discountMatrix/unitPriceCurve vs computePricing,
// breakEvenDiscount vs computePricing). Single-function invariants live in
// pricing.properties.test.ts; this file is about the promises between them.
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { arbDefaults } from './pricingArbitraries';
import {
  computePricing,
  filamentLineCost,
  discountMatrix,
  unitPriceCurve,
  breakEvenDiscount,
  CURVE_QUANTITIES,
  type PricingFilament,
  type PricingInputs,
  type PricingPrinter,
} from '../../utils/pricing';

const RUNS = { seed: 42, numRuns: 150 } as const;

const arbFilament = (): fc.Arbitrary<PricingFilament> =>
  fc.record({
    cost_per_kg: fc.double({ min: 0, max: 20000, noNaN: true }),
    sale_price_per_kg: fc.double({ min: 0, max: 40000, noNaN: true }),
    difficulty_pct: fc.double({ min: 1, max: 400, noNaN: true }),
  });

const arbPrinter = (): fc.Arbitrary<PricingPrinter> =>
  fc.record({
    purchase_price: fc.double({ min: 0, max: 1e6, noNaN: true }),
    lifetime_years: fc.double({ min: 0.1, max: 20, noNaN: true }),
    daily_usage_hours: fc.double({ min: 0.1, max: 24, noNaN: true }),
    power_watts: fc.double({ min: 0, max: 3000, noNaN: true }),
    repair_rate_pct: fc.double({ min: 0, max: 200, noNaN: true }),
  });

const arbInputs = (): fc.Arbitrary<PricingInputs> =>
  fc.record({
    weight_g: fc.double({ min: 0, max: 20000, noNaN: true }),
    printing_time_h: fc.double({ min: 0, max: 500, noNaN: true }),
    quantity: fc.integer({ min: 1, max: 500 }),
    modeling_hours: fc.double({ min: 0, max: 100, noNaN: true }),
    modeling_base_price: fc.double({ min: 0, max: 50000, noNaN: true }),
    prep_model_min: fc.double({ min: 0, max: 600, noNaN: true }),
    prep_slicing_min: fc.double({ min: 0, max: 600, noNaN: true }),
    prep_transfer_min: fc.double({ min: 0, max: 600, noNaN: true }),
    post_removal_min: fc.double({ min: 0, max: 600, noNaN: true }),
    post_support_min: fc.double({ min: 0, max: 600, noNaN: true }),
    post_additional_min: fc.double({ min: 0, max: 600, noNaN: true }),
    post_fulfillment_min: fc.double({ min: 0, max: 600, noNaN: true }),
    stuff_amount: fc.double({ min: 0, max: 100000, noNaN: true }),
    stuff_markup_pct: fc.double({ min: 0, max: 200, noNaN: true }),
    rush: fc.boolean(),
  });

const MONEY_FIELDS = [
  'filament_cost', 'depreciation_cost', 'energy_cost', 'repairs_cost',
  'machine_cost', 'prototype_cost', 'failures_cost', 'machine_cost_safety',
  'ads_cost', 'consumables_flat', 'base_fee_total', 'base_fee',
  'modeling_cost_total', 'prep_cost_total', 'modeling_cost', 'prep_cost',
  'post_processing_cost', 'stuff_cost', 'labor_total', 'risk_base',
  'total_cost', 'margin_global', 'margin_filament', 'margin_stuff',
  'margin_rush', 'marge', 'total_ht', 'total_ttc', 'total_ht_qty',
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
        const r = computePricing(i, f, p, { ...d, tax_pct: Math.abs(d.tax_pct) });
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
});
