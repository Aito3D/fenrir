import { describe, it, expect } from 'vitest';
import {
  breakEvenDiscount,
  buildWaterfall,
  computePricing,
  discountMatrix,
  unitPriceCurve,
  CURVE_QUANTITIES,
  formatMoney,
  formatPct,
  moneyDecimals,
  targetPriceProfit,
  printerLifetimeHours,
  printerDepreciationPerHour,
  printerRepairsPerHour,
  sizeMargin,
  qtyFactor,
  unitMultiplier,
  CURVE_DEFAULTS,
  type PricingDefaults,
  type PricingFilament,
  type PricingInputs,
  type PricingPrinter,
  type PricingResult,
} from '../../utils/pricing';

const filament: PricingFilament = { cost_per_kg: 3731, sale_price_per_kg: 5597, difficulty_pct: 150 };

const printer: PricingPrinter = {
  purchase_price: 347000,
  lifetime_years: 2,
  daily_usage_hours: 5,
  power_watts: 400,
  repair_rate_pct: 30,
};

const defaults: PricingDefaults = {
  electricity_tariff: 120,
  labor_rate_per_hour: 3000,
  consumables_packaging_flat: 30,
  failure_rate_pct: 30,
  prototype_rate_pct: 30,
  ads_rate_pct: 5,
  filament_markup_pct: 5,
  global_markup_pct: 50,
  tax_pct: 13,
  default_difficulty_pct: 150,
  stuff_markup_pct: 20,
};

const zeroLabor = {
  modeling_hours: 0,
  modeling_base_price: 0,
  prep_model_min: 0,
  prep_slicing_min: 0,
  prep_transfer_min: 0,
  post_removal_min: 0,
  post_support_min: 0,
  post_additional_min: 0,
  post_fulfillment_min: 0,
  stuff_amount: 0,
  stuff_markup_pct: 20,
};

const referenceInputs: PricingInputs = {
  weight_g: 40,
  printing_time_h: 2,
  quantity: 1,
  ...zeroLabor,
};

// Independent inline closed-form size margin (quantity 1 → qty factor 1),
// literal constants only, not the exported sizeMargin/unitMultiplier —
// so a regression in Phase C itself would be caught by these tests.
const closedFormMult = (c: number): number => 1.15 + (0.45 * 33) / (c + 33);

// A configuration where total_cost is exactly the filament cost: 1 kg at
// 5/kg = 5 per unit, no printer, energy, provisions, ads, consumables or tax,
// and sale price = cost so margin_filament is 0. The spec's sanity table.
const bareFilament: PricingFilament = { cost_per_kg: 5, sale_price_per_kg: 5, difficulty_pct: 100 };
const barePrinter: PricingPrinter = { purchase_price: 0, lifetime_years: 1, daily_usage_hours: 1, power_watts: 0, repair_rate_pct: 0 };
const bareDefaults: PricingDefaults = {
  electricity_tariff: 0,
  labor_rate_per_hour: 0,
  consumables_packaging_flat: 0,
  failure_rate_pct: 0,
  prototype_rate_pct: 0,
  ads_rate_pct: 0,
  filament_markup_pct: 0,
  global_markup_pct: 0,
  tax_pct: 0,
  default_difficulty_pct: 100,
  stuff_markup_pct: 0,
  // curve fields deliberately absent: CURVE_DEFAULTS must apply
};
const bareInputs = (weightG: number, quantity: number): PricingInputs => ({
  ...zeroLabor,
  stuff_markup_pct: 0,
  weight_g: weightG,
  printing_time_h: 1,
  quantity,
});

describe('sizeMargin / qtyFactor / unitMultiplier', () => {
  it('sizeMargin is the midpoint at u = K and strictly decreasing', () => {
    expect(sizeMargin(33, bareDefaults)).toBeCloseTo((1.15 + 1.6) / 2, 10);
    const series = [0, 1, 5, 33, 60, 200, 1e6].map((u) => sizeMargin(u, bareDefaults));
    for (let i = 1; i < series.length; i++) expect(series[i]).toBeLessThan(series[i - 1]);
    expect(series[0]).toBeCloseTo(1.6, 10);
    expect(series[series.length - 1]).toBeGreaterThanOrEqual(1.15);
  });

  it('sizeMargin guards: k <= 0, max < min, negative u', () => {
    expect(sizeMargin(10, { ...bareDefaults, margin_k: 0 })).toBe(1.15);
    expect(sizeMargin(10, { ...bareDefaults, margin_max_mult: 1.1 })).toBe(1.15);
    expect(sizeMargin(-50, bareDefaults)).toBeCloseTo(1.6, 10);
    expect(Number.isFinite(sizeMargin(NaN, bareDefaults))).toBe(true);
  });

  it('qtyFactor is exactly 1 at q = 1, (1+Q_MIN)/2 at q = KQ + 1, strictly decreasing', () => {
    expect(qtyFactor(1, bareDefaults)).toBe(1);
    expect(qtyFactor(6, bareDefaults)).toBeCloseTo((1 + 0.4) / 2, 10);
    const series = [1, 2, 4, 10, 50, 1e6].map((q) => qtyFactor(q, bareDefaults));
    for (let i = 1; i < series.length; i++) expect(series[i]).toBeLessThan(series[i - 1]);
    expect(series[series.length - 1]).toBeGreaterThanOrEqual(0.4);
  });

  it('qtyFactor guards: qty_k <= 0, qty_min_factor out of (0,1], q < 1', () => {
    expect(qtyFactor(10, { ...bareDefaults, qty_k: 0 })).toBe(1);
    expect(qtyFactor(10, { ...bareDefaults, qty_min_factor: 0 })).toBe(1);
    expect(qtyFactor(10, { ...bareDefaults, qty_min_factor: 1.5 })).toBe(1);
    expect(qtyFactor(0, bareDefaults)).toBe(1);
    expect(qtyFactor(-3, bareDefaults)).toBe(1);
  });

  it('unitMultiplier >= 1 and the sanity table holds', () => {
    const rows: Array<[number, number, number]> = [
      [5, 1, 1.5408], [5, 4, 1.4191], [5, 10, 1.3322], [5, 50, 1.2464],
      [60, 1, 1.3097], [60, 10, 1.1902], [200, 1, 1.2137], [200, 10, 1.1313],
    ];
    for (const [u, q, expected] of rows) {
      expect(unitMultiplier(u, q, bareDefaults)).toBeCloseTo(expected, 3);
      expect(unitMultiplier(u, q, bareDefaults)).toBeGreaterThanOrEqual(1);
    }
    expect(CURVE_DEFAULTS.margin_k).toBe(33);
  });
});

describe('computePricing with the margin curves', () => {
  // weight_g = u * 200 grams = (u / cost_per_kg) kg, so filament_cost (the
  // only cost line here) is exactly u: total_cost = u kg-equivalent... i.e.
  // weight_kg * cost_per_kg(5) = u. (u * 1000 would give total_cost = 5u.)
  const task = (u: number, q: number) => computePricing(bareInputs(u * 200, q), bareFilament, barePrinter, bareDefaults);

  it('reproduces the sanity table task prices (formula is the authority)', () => {
    const rows: Array<[number, number, number, boolean]> = [
      [5, 1, 12, true], [5, 4, 28.38, false], [5, 10, 66.61, false], [5, 50, 311.6, false],
      [60, 1, 78.58, false], [60, 10, 714.1, false], [200, 1, 242.75, false], [200, 10, 2262.6, false],
    ];
    for (const [u, q, price, floored] of rows) {
      const r = task(u, q);
      expect(r.total_cost).toBeCloseTo(u, 10);
      expect(r.total_ht_qty).toBeCloseTo(price, 1);
      expect(r.floor_applied).toBe(floored);
      expect(r.margin_multiplier).toBeCloseTo(unitMultiplier(u, q, bareDefaults), 10);
      expect(r.size_margin).toBeCloseTo(sizeMargin(u, bareDefaults), 10);
      expect(r.qty_factor).toBeCloseTo(qtyFactor(q, bareDefaults), 10);
    }
  });

  it('size margin uses the UNIT cost, the discount uses the quantity', () => {
    const r = task(5, 10);
    expect(r.size_margin).toBeCloseTo(sizeMargin(5, bareDefaults), 10); // not sizeMargin(50)
    expect(r.qty_factor).toBeCloseTo(qtyFactor(10, bareDefaults), 10);
  });

  it('the floor is booked as global margin and hits the floor exactly', () => {
    const r = task(5, 1);
    expect(r.total_ht_qty).toBeCloseTo(12, 10);
    expect(r.margin_global).toBeCloseTo(12 - 5, 10);
    expect(r.marge).toBeCloseTo(r.margin_global, 10);
    expect(r.total_ht).toBeCloseTo(r.total_cost + r.marge, 10);
    // A floor of 0 disables it (weight_g = 1000 → total_cost = 5, same as task(5, 1))
    const noFloor = computePricing(bareInputs(1000, 1), bareFilament, barePrinter, { ...bareDefaults, min_task_price: 0 });
    expect(noFloor.floor_applied).toBe(false);
    expect(noFloor.total_ht).toBeCloseTo(5 * 1.5408, 3);
  });

  it('price never drops below cost at any quantity', () => {
    for (const q of [1, 2, 5, 10, 100, 1000, 100000]) {
      const r = task(5, q);
      expect(r.total_ht).toBeGreaterThanOrEqual(r.total_cost);
    }
  });

  it('filament and extras margins are untouched by the curves', () => {
    const inputs = { ...referenceInputs, stuff_amount: 100, stuff_markup_pct: 20 };
    const r = computePricing(inputs, filament, printer, defaults);
    const d = filament.difficulty_pct / 100;
    expect(r.margin_filament).toBeCloseTo(
      (inputs.weight_g / 1000) * (filament.sale_price_per_kg * 1.05 - filament.cost_per_kg) * d,
      6,
    );
    expect(r.margin_stuff).toBeCloseTo(20, 6);
    expect(r.margin_global).toBeCloseTo(r.total_cost * (r.margin_multiplier - 1), 6);
  });

  it('waterfall still ends exactly at total_ttc when the floor applies', () => {
    // weight_g = 1000 → total_cost = 5 (same as task(5, 1)), which is below
    // the floor, so this test actually exercises the floor path.
    const r = computePricing(bareInputs(1000, 1), bareFilament, barePrinter, { ...bareDefaults, tax_pct: 13 });
    const steps = buildWaterfall(r);
    expect(steps[steps.length - 1].cumulative).toBeCloseTo(r.total_ttc, 10);
    expect(steps.reduce((s, step) => s + step.value, 0)).toBeCloseTo(r.total_ttc, 6);
  });
});

describe('printer derived values', () => {
  it('computes lifetime hours, depreciation and repairs per hour for H2S', () => {
    expect(printerLifetimeHours(printer)).toBe(3650);
    expect(printerDepreciationPerHour(printer)).toBeCloseTo(95.07, 2);
    expect(printerRepairsPerHour(printer)).toBeCloseTo(28.52, 2);
  });
});

describe('computePricing — reference case (40 g, 2 h, qty 1, 150% difficulty, labor 0)', () => {
  // Costs first, margins at the end: filament is priced at cost_per_kg (the
  // sale-price uplift is booked as margin_filament in Phase C), provisions
  // come off the per-print risk base, and ads overhead spreads over all costs.
  const r = computePricing(referenceInputs, filament, printer, defaults);

  it('machine cost components', () => {
    // filament = 0.04 kg × 3731 cost × 1.5 difficulty
    expect(r.filament_cost).toBeCloseTo(223.86, 1);
    expect(r.depreciation_cost).toBeCloseTo(190.14, 1);
    expect(r.energy_cost).toBeCloseTo(144, 1); // 48/h × 2 h × 1.5
    expect(r.repairs_cost).toBeCloseTo(85.56, 1);
  });

  it('totals (±1 FCFP)', () => {
    expect(r.machine_cost).toBeCloseTo(643.56, 0);
    expect(r.risk_base).toBeCloseTo(643.56, 0); // labor 0 ⇒ risk base = machine cost
    expect(r.prototype_cost).toBeCloseTo(193.07, 0);
    expect(r.failures_cost).toBeCloseTo(193.07, 0);
    expect(r.machine_cost_safety).toBeCloseTo(1029.69, 0);
    expect(r.ads_cost).toBeCloseTo(52.98, 0); // 5% of (safety + consumables)
    expect(r.total_cost).toBeCloseTo(1112.68, 0);
    // Margins, all at the end: the size/quantity curve on total cost (closed
    // form at quantity 1, so qty factor is 1): mult = 1.15 + 0.45×33/(u+33),
    // u ≈ 1112.68 ⇒ mult ≈ 1.16296 ⇒ margin_global ≈ 1112.68 × 0.16296 ≈
    // 181.32. Plus the filament sale-price uplift
    // (0.04 × (5597 × 1.05 − 3731) × 1.5) ≈ 128.75. Pinned to a concrete
    // end-to-end scenario, same as the old flat-markup pin was.
    expect(r.margin_global).toBeCloseTo(181.32, 1);
    expect(r.margin_filament).toBeCloseTo(128.75, 1);
    expect(r.margin_stuff).toBe(0);
    expect(r.marge).toBeCloseTo(310.08, 2);
    expect(r.total_ht).toBeCloseTo(1422.75, 2);
    expect(r.total_ttc).toBeCloseTo(1607.71, 2);
    // Margin fraction is over the pre-tax price (collected tax is not revenue)
    expect(r.margin_pct).toBeCloseTo(0.22, 2);
  });

  it('pre-tax price is exactly total cost + the three margin lines', () => {
    expect(r.total_ht).toBeCloseTo(r.total_cost + r.margin_global + r.margin_filament + r.margin_stuff, 6);
  });

  it('safety equals machine cost × 1.6 with 30% + 30% provisions and no labor', () => {
    expect(r.machine_cost_safety).toBeCloseTo(r.machine_cost * 1.6, 6);
  });

  it('provisions come off the risk base (machine + prep + post), not machine cost alone', () => {
    const withLabor = computePricing(
      { ...referenceInputs, prep_slicing_min: 30, post_removal_min: 60, modeling_hours: 1, stuff_amount: 1000 },
      filament,
      printer,
      { ...defaults, base_fee_flat: 500 },
    );
    // prep 1500 + post 3000 join the risk base; modeling, base fee,
    // consumables and stuff stay out (not lost when a print fails).
    expect(withLabor.risk_base).toBeCloseTo(withLabor.machine_cost + 1500 + 3000, 6);
    expect(withLabor.prototype_cost).toBeCloseTo(withLabor.risk_base * 0.3, 6);
    expect(withLabor.failures_cost).toBeCloseTo(withLabor.risk_base * 0.3, 6);
    expect(withLabor.machine_cost_safety).toBeGreaterThan(withLabor.machine_cost * 1.6);
  });

  it('quantity 1 leaves totals unchanged', () => {
    expect(r.total_ttc_qty).toBeCloseTo(r.total_ttc, 6);
    expect(r.total_ht_qty).toBeCloseTo(r.total_ht, 6);
  });
});

describe('computePricing — behaviors', () => {
  it('difficulty 100% on the filament is neutral (no surcharge anywhere)', () => {
    const r = computePricing(referenceInputs, { ...filament, difficulty_pct: 100 }, printer, defaults);
    expect(r.energy_cost).toBeCloseTo(96, 5); // 48/h × 2 h, no surcharge
    expect(r.repairs_cost).toBeCloseTo(57.04, 1);
    expect(r.filament_cost).toBeCloseTo(0.04 * 3731, 6);
    expect(r.margin_filament).toBeCloseTo(0.04 * (5597 * 1.05 - 3731), 6);
  });

  it('filament margin has no clamp — a sale price below cost shows the loss', () => {
    const r = computePricing(referenceInputs, { ...filament, sale_price_per_kg: 1000 }, printer, defaults);
    expect(r.margin_filament).toBeCloseTo(0.04 * (1000 * 1.05 - 3731) * 1.5, 6);
    expect(r.margin_filament).toBeLessThan(0);
    expect(r.total_ht).toBeCloseTo(r.total_cost + r.margin_global + r.margin_filament, 6);
  });

  it('multiplies per-unit totals by quantity', () => {
    const r = computePricing({ ...referenceInputs, quantity: 10 }, filament, printer, defaults);
    expect(r.total_ttc_qty).toBeCloseTo(r.total_ttc * 10, 6);
    expect(r.total_ht_qty).toBeCloseTo(r.total_ht * 10, 6);
  });

  it('base fee: absent or zero is neutral; when set it lands in total_cost with overhead, margin + tax on top', () => {
    const base = computePricing(referenceInputs, filament, printer, defaults);
    const absent = computePricing(referenceInputs, filament, printer, { ...defaults, base_fee_flat: undefined });
    expect(absent.total_ttc).toBeCloseTo(base.total_ttc, 6);
    expect(base.base_fee).toBe(0);
    expect(base.base_fee_total).toBe(0);

    const withFee = computePricing(referenceInputs, filament, printer, { ...defaults, base_fee_flat: 500 });
    expect(withFee.base_fee_total).toBe(500);
    expect(withFee.base_fee).toBe(500);
    // Flat cost behaves like consumables: ads overhead, then margin and tax
    expect(withFee.total_cost).toBeCloseTo(base.total_cost + 500 * 1.05, 6);
    expect(withFee.total_ttc).toBeCloseTo(withFee.total_ht * 1.13, 6);
  });

  it('base fee is one-time per job — amortized across the quantity', () => {
    const d = { ...defaults, base_fee_flat: 500 };
    const r10 = computePricing({ ...referenceInputs, quantity: 10 }, filament, printer, d);
    expect(r10.base_fee_total).toBeCloseTo(500, 6);
    expect(r10.base_fee).toBeCloseTo(50, 6);
    // The whole job pays the fee's cost impact exactly once, regardless of
    // quantity — amortized per unit in Phase A/B, multiplied back by
    // quantity. (The margin curve is non-linear in unit cost, so the same
    // check can no longer be made on total_ht — this checks the cost-level
    // invariant instead, which margin curves don't touch.)
    const r1 = computePricing(referenceInputs, filament, printer, d);
    const costDelta10 =
      (r10.total_cost - computePricing({ ...referenceInputs, quantity: 10 }, filament, printer, defaults).total_cost) *
      10;
    const costDelta1 = r1.total_cost - computePricing(referenceInputs, filament, printer, defaults).total_cost;
    expect(costDelta10).toBeCloseTo(costDelta1, 4);
  });

  it('amortizes one-time modeling and preparation costs across the quantity', () => {
    const inputs = { ...referenceInputs, modeling_hours: 1, prep_slicing_min: 30 };
    const r1 = computePricing(inputs, filament, printer, defaults);
    const r10 = computePricing({ ...inputs, quantity: 10 }, filament, printer, defaults);

    // Full one-time costs are reported, per-unit shares are ÷ quantity
    expect(r10.modeling_cost_total).toBeCloseTo(3000, 6);
    expect(r10.prep_cost_total).toBeCloseTo(1500, 6);
    expect(r10.modeling_cost).toBeCloseTo(300, 6);
    expect(r10.prep_cost).toBeCloseTo(150, 6);
    expect(r1.modeling_cost).toBeCloseTo(3000, 6);

    // The job pays modeling/prep once, not once per unit. Prep sits in the
    // risk base (redone on a failed print) so it carries the 60% provisions;
    // modeling does not. Both carry ads overhead (the margin curve is
    // non-linear in unit cost, so this checks the cost-level delta, which
    // margin curves don't touch — not the final price).
    const base = computePricing({ ...referenceInputs, quantity: 10 }, filament, printer, defaults);
    const costDeltaQty = (r10.total_cost - base.total_cost) * 10;
    expect(costDeltaQty).toBeCloseTo((3000 + 1500 * 1.6) * 1.05, 4);
    expect(r10.total_ht_qty).toBeLessThan(r1.total_ht * 10);
  });

  it('post-processing and stuff stay per unit under quantity', () => {
    const inputs = { ...referenceInputs, post_removal_min: 60, stuff_amount: 1000 };
    const r1 = computePricing(inputs, filament, printer, defaults);
    const r10 = computePricing({ ...inputs, quantity: 10 }, filament, printer, defaults);
    expect(r10.post_processing_cost).toBeCloseTo(r1.post_processing_cost, 6);
    expect(r10.stuff_cost).toBeCloseTo(r1.stuff_cost, 6);
    // Nothing here amortizes over quantity, so the per-unit cost basis is
    // identical at qty 1 and qty 10 (the margin curve differs by quantity —
    // that's qty_factor's job, not this test's — so total_ttc is not).
    expect(r10.total_cost).toBeCloseTo(r1.total_cost, 6);
  });

  it('clamps invalid quantity to 1', () => {
    const r = computePricing({ ...referenceInputs, quantity: 0 }, filament, printer, defaults);
    expect(r.quantity).toBe(1);
  });

  it('modeling cost = hours × labor rate + base price', () => {
    const r = computePricing(
      { ...referenceInputs, modeling_hours: 2, modeling_base_price: 500 },
      filament,
      printer,
      defaults,
    );
    expect(r.modeling_cost).toBeCloseTo(2 * 3000 + 500, 6);
  });

  it('preparation and post-processing minutes are billed at labor rate', () => {
    const r = computePricing(
      {
        ...referenceInputs,
        prep_model_min: 10,
        prep_slicing_min: 15,
        prep_transfer_min: 5,
        post_removal_min: 6,
        post_support_min: 12,
        post_additional_min: 30,
        post_fulfillment_min: 12,
      },
      filament,
      printer,
      defaults,
    );
    expect(r.prep_cost).toBeCloseTo((30 / 60) * 3000, 6);
    expect(r.post_processing_cost).toBeCloseTo((60 / 60) * 3000, 6);
  });

  it('stuff is costed at its amount; the markup lands as an end-stage margin', () => {
    const base = computePricing(referenceInputs, filament, printer, defaults);
    const r = computePricing(
      { ...referenceInputs, stuff_amount: 1000, stuff_markup_pct: 20 },
      filament,
      printer,
      defaults,
    );
    expect(r.stuff_cost).toBeCloseTo(1000, 6);
    expect(r.labor_total).toBeCloseTo(1000, 6); // stuff at cost, no other labor
    expect(r.margin_stuff).toBeCloseTo(200, 6);
    // Independent inline closed-form check (quantity 1 → qty factor 1), not
    // the exported sizeMargin/unitMultiplier helpers, so a regression in
    // Phase C itself would be caught. margin_filament doesn't depend on
    // stuff, so cross-check it against a separately computed base case.
    expect(r.margin_global).toBeCloseTo(r.total_cost * (closedFormMult(r.total_cost) - 1), 6);
    expect(r.marge).toBeCloseTo(r.margin_global + base.margin_filament + 200, 6);
  });

  it('measured energy replaces the watts × hours estimate (surcharge kept)', () => {
    const base = computePricing(referenceInputs, filament, printer, defaults);
    const r = computePricing({ ...referenceInputs, measured_energy_kwh: 0.5 }, filament, printer, defaults);
    expect(r.energy_cost).toBeCloseTo(0.5 * 120 * 1.5, 6); // = 90 vs estimated 144
    expect(r.machine_cost).toBeCloseTo(base.machine_cost - 54, 4);
    expect(r.total_ttc).toBeCloseTo(r.total_ht * 1.13, 6);
  });

  it('measured energy of 0 or omitted falls back to the estimate', () => {
    const base = computePricing(referenceInputs, filament, printer, defaults);
    const zero = computePricing({ ...referenceInputs, measured_energy_kwh: 0 }, filament, printer, defaults);
    expect(zero.energy_cost).toBeCloseTo(base.energy_cost, 6);
    expect(zero.total_ttc).toBeCloseTo(base.total_ttc, 6);
  });

  it('labor feeds total_cost and the totals', () => {
    const base = computePricing(referenceInputs, filament, printer, defaults);
    const withLabor = computePricing(
      { ...referenceInputs, modeling_hours: 1 },
      filament,
      printer,
      defaults,
    );
    // Modeling is not in the risk base; it carries ads overhead and margin.
    expect(withLabor.total_cost).toBeCloseTo(base.total_cost + 3000 * 1.05, 6);
    // Independent inline closed-form check (quantity 1 → qty factor 1), not
    // the exported sizeMargin/unitMultiplier helpers, so a regression in
    // Phase C itself would be caught.
    expect(withLabor.total_ht).toBeCloseTo(
      withLabor.total_cost * closedFormMult(withLabor.total_cost) + withLabor.margin_filament + withLabor.margin_stuff,
      6,
    );
  });
});

describe('discountMatrix', () => {
  const r = computePricing(referenceInputs, filament, printer, defaults);
  const matrix = discountMatrix(r);

  it('has the standard 6 columns', () => {
    expect(matrix.map((c) => c.discount)).toEqual([0, 0.05, 0.1, 0.2, 0.3, 0.5]);
  });

  it('0% column matches the base result, profit is pre-tax', () => {
    expect(matrix[0].price).toBeCloseTo(r.total_ttc, 6);
    expect(matrix[0].price_ht).toBeCloseTo(r.total_ht, 6);
    expect(matrix[0].machine_cost).toBeCloseTo(r.machine_cost, 6);
    expect(matrix[0].discount_amount).toBeCloseTo(0, 6);
    // Undiscounted profit is exactly the marge — collected tax is not profit
    expect(matrix[0].potential_profit).toBeCloseTo(r.marge, 6);
  });

  it('applies the discount to price and computes pre-tax profit vs costs', () => {
    const c = matrix[3]; // 20%
    expect(c.price).toBeCloseTo(r.total_ttc * 0.8, 6);
    expect(c.price_ht).toBeCloseTo(r.total_ht * 0.8, 6);
    expect(c.discount_amount).toBeCloseTo(r.total_ttc * 0.2, 6);
    expect(c.potential_profit).toBeCloseTo(r.total_ht * 0.8 - r.total_cost, 6);
  });

  it('deep discounts can produce a negative profit', () => {
    const c = matrix[5]; // 50%
    expect(c.potential_profit).toBeLessThan(0);
  });
});

describe('unitPriceCurve', () => {
  it('walks the ladder, includes and flags the current quantity, sorted and deduped', () => {
    const pts = unitPriceCurve({ ...referenceInputs, quantity: 7 }, filament, printer, defaults);
    expect(pts.map((p) => p.quantity)).toEqual([1, 2, 5, 7, 10, 20, 50, 100, 200, 500]);
    expect(pts.filter((p) => p.current).map((p) => p.quantity)).toEqual([7]);
    const onLadder = unitPriceCurve({ ...referenceInputs, quantity: 10 }, filament, printer, defaults);
    expect(onLadder.map((p) => p.quantity)).toEqual(CURVE_QUANTITIES);
    expect(onLadder.find((p) => p.quantity === 10)?.current).toBe(true);
  });

  it('each point is a full recompute at that quantity', () => {
    const pts = unitPriceCurve(referenceInputs, filament, printer, defaults);
    for (const p of pts) {
      const r = computePricing({ ...referenceInputs, quantity: p.quantity }, filament, printer, defaults);
      expect(p.unit_ht).toBeCloseTo(r.total_ht, 8);
      expect(p.unit_ttc).toBeCloseTo(r.total_ttc, 8);
      expect(p.task_ttc).toBeCloseTo(r.total_ttc_qty, 8);
      expect(p.multiplier).toBeCloseTo(r.margin_multiplier, 10);
      expect(p.qty_factor).toBeCloseTo(r.qty_factor, 10);
      expect(p.floor_applied).toBe(r.floor_applied);
    }
  });

  it('unit price is non-increasing in quantity when there are no one-time costs', () => {
    const pts = unitPriceCurve(referenceInputs, filament, printer, defaults);
    for (let i = 1; i < pts.length; i++) expect(pts[i].unit_ht).toBeLessThanOrEqual(pts[i - 1].unit_ht + 1e-9);
  });

  it('amortizes one-time costs: 10 units pay modeling once, not 10×', () => {
    const inputs = { ...referenceInputs, modeling_hours: 1 };
    const perUnit = computePricing({ ...inputs, quantity: 1 }, filament, printer, defaults);
    const ten = unitPriceCurve(inputs, filament, printer, defaults).find((p) => p.quantity === 10)!;
    expect(ten.task_ttc).toBeLessThan(10 * perUnit.total_ttc);
  });
});

describe('breakEvenDiscount', () => {
  it('is the discount where the pre-tax price meets costs', () => {
    const r = computePricing(referenceInputs, filament, printer, defaults);
    const be = breakEvenDiscount(r)!;
    expect(be).toBeCloseTo(1 - r.total_cost / r.total_ht, 6);
    expect(r.total_ht * (1 - be)).toBeCloseTo(r.total_cost, 4);
    // Every margin sits at the end of the build-up, so the break-even
    // discount is exactly the margin fraction of the pre-tax price.
    expect(be).toBeCloseTo(r.margin_pct, 6);
  });

  it('is null without a price', () => {
    const r = computePricing({ ...referenceInputs, weight_g: 0, printing_time_h: 0 }, filament, printer, {
      ...defaults,
      consumables_packaging_flat: 0,
      min_task_price: 0, // otherwise the floor lifts a zero-cost job to a price
    });
    expect(breakEvenDiscount(r)).toBeNull();
  });
});

describe('targetPriceProfit', () => {
  it('recovers the reference marge from the reference TTC price', () => {
    const p = targetPriceProfit(2031.48, 13, 1112.68)!;
    expect(p.net).toBeCloseTo(1797.77, 1);
    expect(p.profit).toBeCloseTo(685.09, 1);
    expect(p.margin).toBeCloseTo(0.3811, 3);
  });

  it('reports a loss when the target does not cover costs', () => {
    const p = targetPriceProfit(1130, 13, 1112.68)!;
    expect(p.net).toBeCloseTo(1000, 6);
    expect(p.profit).toBeCloseTo(-112.68, 2);
    expect(p.margin).toBeLessThan(0);
  });

  it('is null for unusable targets', () => {
    expect(targetPriceProfit(0, 13, 1112.68)).toBeNull();
    expect(targetPriceProfit(-5, 13, 1112.68)).toBeNull();
    expect(targetPriceProfit(Number.NaN, 13, 1112.68)).toBeNull();
  });
});

describe('formatMoney', () => {
  it('rounds zero-decimal currencies to whole units, thin-space grouped, symbol suffixed', () => {
    expect(formatMoney(22699, 'XPF')).toBe('22\u202F699\u00A0FCFP');
    expect(formatMoney(2295.15, 'XPF')).toBe('2\u202F295\u00A0FCFP');
    expect(formatMoney(1234567.89, 'XPF')).toBe('1\u202F234\u202F568\u00A0FCFP');
  });

  it('formats decimal currencies with two decimals and a prefixed symbol', () => {
    expect(formatMoney(2295.15, 'USD')).toBe('$2\u202F295.15');
    expect(formatMoney(999.4, 'EUR')).toBe('\u20AC999.40');
    expect(formatMoney(-165, 'USD')).toBe('-$165.00');
  });

  it('suffixes alphabetic symbols like kr', () => {
    expect(formatMoney(1250, 'SEK')).toBe('1\u202F250.00\u00A0kr');
  });

  it('handles small, zero, and negative values', () => {
    expect(formatMoney(0, 'XPF')).toBe('0\u00A0FCFP');
    expect(formatMoney(999.4, 'XPF')).toBe('999\u00A0FCFP');
    expect(formatMoney(-165, 'XPF')).toBe('-165\u00A0FCFP');
    expect(formatMoney(-0.2, 'XPF')).toBe('0\u00A0FCFP');
  });

  it('can omit the unit', () => {
    expect(formatMoney(22699, 'XPF', false)).toBe('22\u202F699');
    expect(formatMoney(22699, 'USD', false)).toBe('22\u202F699.00');
  });

  it('is safe on non-finite input', () => {
    expect(formatMoney(Number.NaN, 'XPF')).toBe('—\u00A0FCFP');
    expect(formatMoney(Number.NaN, 'USD')).toBe('$—');
  });
});

describe('moneyDecimals', () => {
  it('is the single source of truth formatMoney rounds to', () => {
    expect(moneyDecimals('xpf')).toBe(0);
    expect(moneyDecimals('USD')).toBe(2);
    // formatMoney must still format JPY with no decimals -- proof the two
    // stayed in sync after formatMoney was rewritten to call this function.
    expect(formatMoney(1.005, 'JPY')).toBe('\u00A51');
  });
});

describe('formatPct', () => {
  it('formats fractions as percentages', () => {
    expect(formatPct(0.2842)).toBe('28.42%');
    expect(formatPct(1.5, 0)).toBe('150%');
  });
});

describe('buildWaterfall', () => {
  it('assembles ordered steps whose final cumulative is exactly total_ttc', () => {
    const result = computePricing({ ...referenceInputs, modeling_hours: 1 }, filament, printer, defaults);
    const steps = buildWaterfall(result);
    expect(steps.length).toBeGreaterThan(3);
    // Strictly increasing cumulative, each step = previous cumulative + value.
    let running = 0;
    for (const step of steps) {
      expect(step.value).toBeGreaterThan(0);
      expect(step.cumulative).toBeCloseTo(running + step.value, 6);
      running = step.cumulative;
    }
    expect(steps[steps.length - 1].cumulative).toBe(result.total_ttc);
    expect(steps[steps.length - 1].key).toBe('tax');
  });

  it('drops zero-value steps (no labor → no labor step)', () => {
    const result = computePricing(referenceInputs, filament, printer, defaults);
    const steps = buildWaterfall(result);
    expect(steps.find((s) => s.key === 'labor')).toBeUndefined();
  });

  // Minimal fake PricingResult so the negative-marge case (a hand-typed
  // sale_price_per_kg below cost_per_kg, backfilled to a negative margin_pct
  // — see CalculatorFilamentBase) can be pinned directly, without depending
  // on a specific computePricing input combination that happens to go
  // negative. Only the fields buildWaterfall reads are non-zero.
  const fakeResult = (overrides: Partial<PricingResult>): PricingResult => ({
    filament_cost: 0,
    depreciation_cost: 0,
    energy_cost: 0,
    repairs_cost: 0,
    machine_cost: 0,
    prototype_cost: 0,
    failures_cost: 0,
    machine_cost_safety: 0,
    ads_cost: 0,
    consumables_flat: 0,
    base_fee_total: 0,
    base_fee: 0,
    modeling_cost_total: 0,
    prep_cost_total: 0,
    modeling_cost: 0,
    prep_cost: 0,
    post_processing_cost: 0,
    stuff_cost: 0,
    labor_total: 0,
    risk_base: 0,
    total_cost: 0,
    margin_global: 0,
    size_margin: 1,
    qty_factor: 1,
    margin_multiplier: 1,
    floor_applied: false,
    margin_filament: 0,
    margin_stuff: 0,
    marge: 0,
    total_ht: 0,
    total_ttc: 0,
    margin_pct: 0,
    quantity: 1,
    total_ht_qty: 0,
    total_ttc_qty: 0,
    ...overrides,
  });

  it('keeps a negative marge as its own signed step, sum reconciling with total_ttc', () => {
    // total_cost = 100 + 20 + 5 = 125; marge = -30 → total_ht = 95; tax = 5 → total_ttc = 100.
    const result = fakeResult({
      filament_cost: 100,
      depreciation_cost: 20,
      energy_cost: 5,
      marge: -30,
      total_cost: 125,
      total_ht: 95,
      total_ttc: 100,
    });
    const steps = buildWaterfall(result);

    const margeStep = steps.find((s) => s.key === 'marge');
    expect(margeStep).toBeDefined();
    expect(margeStep!.value).toBe(-30);

    // Consistent cumulative walk: each step's cumulative is the previous
    // cumulative plus its own value (the whole point of the fix — no
    // re-anchoring past a dropped negative step).
    let running = 0;
    for (const step of steps) {
      expect(step.cumulative).toBeCloseTo(running + step.value, 6);
      running = step.cumulative;
    }
    // Steps sum to total_ttc — the line items add up to the printed total.
    const sum = steps.reduce((acc, s) => acc + s.value, 0);
    expect(sum).toBeCloseTo(result.total_ttc, 6);
    expect(steps[steps.length - 1].cumulative).toBe(result.total_ttc);
  });

  it('still drops a legitimately-zero/rounding-noise marge (0 <= value <= 0.005), unchanged from before', () => {
    const result = fakeResult({
      filament_cost: 100,
      marge: 0.003,
      total_cost: 100,
      total_ht: 100.003,
      total_ttc: 100.003,
    });
    const steps = buildWaterfall(result);
    expect(steps.find((s) => s.key === 'marge')).toBeUndefined();
  });

  it('keeps a marge just below zero (not rounding noise) as a visible step', () => {
    const result = fakeResult({
      filament_cost: 100,
      marge: -0.006,
      total_cost: 100,
      total_ht: 99.994,
      total_ttc: 99.994,
    });
    const steps = buildWaterfall(result);
    const margeStep = steps.find((s) => s.key === 'marge');
    expect(margeStep).toBeDefined();
    expect(margeStep!.value).toBeCloseTo(-0.006, 6);
  });
});
