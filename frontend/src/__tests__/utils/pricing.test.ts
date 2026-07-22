import { describe, it, expect } from 'vitest';
import {
  breakEvenDiscount,
  buildWaterfall,
  computePricing,
  discountMatrix,
  bulkPricing,
  formatMoney,
  formatPct,
  targetPriceProfit,
  printerLifetimeHours,
  printerDepreciationPerHour,
  printerRepairsPerHour,
  type PricingDefaults,
  type PricingFilament,
  type PricingInputs,
  type PricingPrinter,
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
    // Margins, all at the end: global markup on total cost + the filament
    // sale-price uplift (0.04 × (5597 × 1.05 − 3731) × 1.5).
    expect(r.margin_global).toBeCloseTo(556.34, 0);
    expect(r.margin_filament).toBeCloseTo(128.75, 1);
    expect(r.margin_stuff).toBe(0);
    expect(r.marge).toBeCloseTo(685.09, 0);
    expect(r.total_ht).toBeCloseTo(1797.77, 0);
    expect(r.total_ttc).toBeCloseTo(2031.48, 0);
    // Margin fraction is over the pre-tax price (collected tax is not revenue)
    expect(r.margin_pct).toBeCloseTo(0.3811, 3);
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
    expect(withFee.total_ttc).toBeCloseTo(base.total_ttc + 500 * 1.05 * 1.5 * 1.13, 6);
  });

  it('base fee is one-time per job — amortized across the quantity', () => {
    const d = { ...defaults, base_fee_flat: 500 };
    const r10 = computePricing({ ...referenceInputs, quantity: 10 }, filament, printer, d);
    expect(r10.base_fee_total).toBeCloseTo(500, 6);
    expect(r10.base_fee).toBeCloseTo(50, 6);
    // The whole job carries the fee exactly once
    const r1 = computePricing(referenceInputs, filament, printer, d);
    const jobDelta10 = r10.total_ht_qty - computePricing({ ...referenceInputs, quantity: 10 }, filament, printer, defaults).total_ht_qty;
    const jobDelta1 = r1.total_ht - computePricing(referenceInputs, filament, printer, defaults).total_ht;
    expect(jobDelta10).toBeCloseTo(jobDelta1, 4);
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
    // modeling does not. Both carry ads overhead and the global margin.
    const base = computePricing({ ...referenceInputs, quantity: 10 }, filament, printer, defaults);
    expect(r10.total_ht_qty).toBeCloseTo(base.total_ht_qty + (3000 + 1500 * 1.6) * 1.05 * 1.5, 4);
    expect(r10.total_ht_qty).toBeLessThan(r1.total_ht * 10);
  });

  it('post-processing and stuff stay per unit under quantity', () => {
    const inputs = { ...referenceInputs, post_removal_min: 60, stuff_amount: 1000 };
    const r1 = computePricing(inputs, filament, printer, defaults);
    const r10 = computePricing({ ...inputs, quantity: 10 }, filament, printer, defaults);
    expect(r10.post_processing_cost).toBeCloseTo(r1.post_processing_cost, 6);
    expect(r10.stuff_cost).toBeCloseTo(r1.stuff_cost, 6);
    expect(r10.total_ttc).toBeCloseTo(r1.total_ttc, 6);
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
    expect(r.marge).toBeCloseTo(base.marge + 1000 * 1.05 * 0.5 + 200, 4);
  });

  it('measured energy replaces the watts × hours estimate (surcharge kept)', () => {
    const base = computePricing(referenceInputs, filament, printer, defaults);
    const r = computePricing({ ...referenceInputs, measured_energy_kwh: 0.5 }, filament, printer, defaults);
    expect(r.energy_cost).toBeCloseTo(0.5 * 120 * 1.5, 6); // = 90 vs estimated 144
    expect(r.machine_cost).toBeCloseTo(base.machine_cost - 54, 4);
    expect(r.total_ttc).toBeCloseTo(1877.71, 0);
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
    expect(withLabor.total_ht).toBeCloseTo(base.total_ht + 3000 * 1.05 * 1.5, 6);
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

describe('bulkPricing', () => {
  const r = computePricing(referenceInputs, filament, printer, defaults);
  const rows = bulkPricing(referenceInputs, filament, printer, defaults);

  it('uses the standard quantities and discounts', () => {
    expect(rows.map((row) => row.quantity)).toEqual([10, 20, 30, 50, 100, 300]);
    expect(rows[0].prices).toHaveLength(6);
  });

  it('cell = qty × TTC × (1 − discount) when there are no one-time costs', () => {
    expect(rows[0].prices[0]).toBeCloseTo(10 * r.total_ttc * 0.95, 4);
    expect(rows[5].prices[5]).toBeCloseTo(300 * r.total_ttc * 0.5, 4);
  });

  it('recomputes per quantity so one-time costs are amortized, not multiplied', () => {
    const inputs = { ...referenceInputs, modeling_hours: 1 };
    const withModeling = bulkPricing(inputs, filament, printer, defaults);
    const perUnit = computePricing(inputs, filament, printer, defaults); // qty 1
    // A 10-unit job pays modeling once (× ads overhead, margin, tax), not 10×
    expect(withModeling[0].prices[0]).toBeCloseTo(
      (rows[0].prices[0] / 0.95 + 3000 * 1.05 * 1.5 * 1.13) * 0.95,
      2,
    );
    expect(withModeling[0].prices[0]).toBeLessThan(10 * perUnit.total_ttc * 0.95);
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
    expect(be).toBeCloseTo(0.3811, 3);
  });

  it('is null without a price', () => {
    const r = computePricing({ ...referenceInputs, weight_g: 0, printing_time_h: 0 }, filament, printer, {
      ...defaults,
      consumables_packaging_flat: 0,
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
});
