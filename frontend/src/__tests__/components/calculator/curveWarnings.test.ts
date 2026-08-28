import { describe, it, expect } from 'vitest';
import { curveWarnings } from '../../../components/calculator/curveWarnings';
import type { PricingDefaults } from '../../../utils/pricing';

const base: PricingDefaults = {
  electricity_tariff: 100, labor_rate_per_hour: 4500, consumables_packaging_flat: 30,
  failure_rate_pct: 30, prototype_rate_pct: 30, ads_rate_pct: 5, filament_markup_pct: 10,
  global_markup_pct: 0, tax_pct: 13, default_difficulty_pct: 100, stuff_markup_pct: 20,
  margin_min_mult: 1.5, margin_max_mult: 2, margin_k: 5000, qty_min_factor: 0.6, qty_k: 20, min_task_price: 500,
};
const example = { unitCost: 5000, quantity: 1 };

describe('curveWarnings', () => {
  it('is empty for a healthy configuration', () => {
    expect(curveWarnings(base, example)).toEqual({});
  });
  it('flags a flat size curve when M_MAX equals M_MIN', () => {
    expect(curveWarnings({ ...base, margin_max_mult: 1.5 }, example).margin_max_mult).toEqual({
      key: 'calculator.warnFlatSize', values: { m: '1.50' },
    });
  });
  it('flags K far above or far below the example cost, only when there is an example', () => {
    expect(curveWarnings({ ...base, margin_k: 200_000 }, example).margin_k?.key).toBe('calculator.warnKFar');
    expect(curveWarnings({ ...base, margin_k: 100 }, example).margin_k?.key).toBe('calculator.warnKNear');
    expect(curveWarnings({ ...base, margin_k: 100 }, null).margin_k).toBeUndefined();
    expect(curveWarnings({ ...base, margin_k: 100_000 }, example).margin_k).toBeUndefined(); // exactly 20× is fine
  });
  it('flags no quantity discount when Q_MIN is 1', () => {
    expect(curveWarnings({ ...base, qty_min_factor: 1 }, example).qty_min_factor?.key).toBe('calculator.warnNoQtyDiscount');
  });
  it('flags a floor that exceeds the example price (pre-tax, quantity 1)', () => {
    // price = unitCost × sizeMargin(unitCost) = 5000 × 1.75 = 8750
    expect(curveWarnings({ ...base, min_task_price: 9000 }, example).min_task_price?.key).toBe('calculator.warnFloorDominates');
    expect(curveWarnings({ ...base, min_task_price: 8000 }, example).min_task_price).toBeUndefined();
    expect(curveWarnings({ ...base, min_task_price: 9000 }, null).min_task_price).toBeUndefined();
  });
});
