import { describe, it, expect } from 'vitest';
import {
  emptyTaskDraft,
  splitMinutes,
  joinMinutes,
  computeImpressionCost,
  taskTotal,
  projectTotal,
} from '../../utils/taskDraft';
import type { PricingDefaults, PricingFilament, PricingPrinter } from '../../utils/pricing';

const filament: PricingFilament = { cost_per_kg: 3000, sale_price_per_kg: 6000, difficulty_pct: 100 };
const printer: PricingPrinter = {
  purchase_price: 300000,
  lifetime_years: 5,
  daily_usage_hours: 8,
  power_watts: 150,
  repair_rate_pct: 5,
};
const defaults: PricingDefaults = {
  electricity_tariff: 30,
  labor_rate_per_hour: 3000,
  consumables_packaging_flat: 500,
  failure_rate_pct: 5,
  prototype_rate_pct: 5,
  ads_rate_pct: 3,
  filament_markup_pct: 50,
  global_markup_pct: 30,
  tax_pct: 0,
  default_difficulty_pct: 100,
  stuff_markup_pct: 20,
  base_fee_flat: 2000,
};

const impression = {
  printerId: 1,
  filamentId: 1,
  weightG: 120,
  timeMin: 270,
  quantity: 1,
  color: 'Noir',
};

describe('splitMinutes / joinMinutes', () => {
  it.each([
    [0, { days: 0, hours: 0, minutes: 0 }],
    [90, { days: 0, hours: 1, minutes: 30 }],
    [270, { days: 0, hours: 4, minutes: 30 }],
    [1500, { days: 1, hours: 1, minutes: 0 }],
  ])('splits %i minutes', (total, expected) => {
    expect(splitMinutes(total)).toEqual(expected);
  });

  it('round-trips', () => {
    for (const total of [0, 1, 59, 60, 90, 270, 1439, 1440, 1500]) {
      expect(joinMinutes(splitMinutes(total))).toBe(total);
    }
  });
});

describe('computeImpressionCost', () => {
  it.each([
    ['printer', { printerId: null }],
    ['filament', { filamentId: null }],
    ['weight', { weightG: null }],
    ['time', { timeMin: null }],
  ])('returns null when %s is missing', (_label, patch) => {
    expect(
      computeImpressionCost({ ...impression, ...patch }, filament, printer, defaults),
    ).toBeNull();
  });

  it('returns null when the filament or printer record is unavailable', () => {
    expect(computeImpressionCost(impression, null, printer, defaults)).toBeNull();
    expect(computeImpressionCost(impression, filament, null, defaults)).toBeNull();
  });

  it('zeroes the per-job flats so a project is not charged them per print', () => {
    // The engine treats base_fee_flat and consumables_packaging_flat as
    // one-time per JOB. A project is the job, so a task must not carry them —
    // three print tasks would otherwise be charged them three times.
    const withFlats = computeImpressionCost(impression, filament, printer, defaults);
    const withoutFlats = computeImpressionCost(impression, filament, printer, {
      ...defaults,
      base_fee_flat: 0,
      consumables_packaging_flat: 0,
    });
    expect(withFlats!.total_ttc_qty).toBeCloseTo(withoutFlats!.total_ttc_qty, 6);
    expect(withFlats!.base_fee_total).toBe(0);
    expect(withFlats!.consumables_flat).toBe(0);
  });

  it('excludes labour, which the sibling services carry', () => {
    const r = computeImpressionCost(impression, filament, printer, defaults)!;
    expect(r.modeling_cost_total).toBe(0);
    expect(r.prep_cost_total).toBe(0);
    expect(r.post_processing_cost).toBe(0);
    expect(r.stuff_cost).toBe(0);
  });

  it('multiplies the line total by quantity', () => {
    const one = computeImpressionCost(impression, filament, printer, defaults)!;
    const two = computeImpressionCost({ ...impression, quantity: 2 }, filament, printer, defaults)!;
    expect(two.total_ttc_qty).toBeCloseTo(one.total_ttc_qty * 2, 6);
  });

  it('treats a missing or zero quantity as 1', () => {
    const one = computeImpressionCost(impression, filament, printer, defaults)!;
    const zero = computeImpressionCost({ ...impression, quantity: 0 }, filament, printer, defaults)!;
    expect(zero.total_ttc_qty).toBeCloseTo(one.total_ttc_qty, 6);
  });
});

describe('taskTotal / projectTotal', () => {
  const base = emptyTaskDraft();

  it('sums only enabled services', () => {
    expect(taskTotal({ ...base, scanCost: 4000, usinageCost: 12000 })).toBe(16000);
  });

  it('treats null as disabled and 0 as free', () => {
    expect(taskTotal(base)).toBe(0);
    expect(taskTotal({ ...base, scanCost: 0 })).toBe(0);
    expect(taskTotal({ ...base, scanCost: null, modelisationCost: 500 })).toBe(500);
  });

  it('includes the frozen impression cost', () => {
    expect(taskTotal({ ...base, scanCost: 1000, impressionCost: 4200 })).toBe(5200);
  });

  it('sums tasks', () => {
    expect(projectTotal([{ ...base, scanCost: 1000 }, { ...base, usinageCost: 2000 }])).toBe(3000);
  });
});
