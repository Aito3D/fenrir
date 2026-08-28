// Soft sanity checks on the margin-curve settings — valid values the backend
// accepts that nevertheless make a curve degenerate. Pure: returns i18n keys,
// the component turns them into strings. Never blocks Save.

import { CURVE_DEFAULTS, sizeMargin, type PricingDefaults } from '../../utils/pricing';

export type CurveWarningKey = 'margin_max_mult' | 'margin_k' | 'qty_min_factor' | 'min_task_price';
export interface CurveExample {
  unitCost: number;
  quantity: number;
}
export type CurveWarning = { key: string; values?: Record<string, string | number> };

const num = (v: number | undefined, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export function curveWarnings(d: PricingDefaults, example: CurveExample | null): Partial<Record<CurveWarningKey, CurveWarning>> {
  const out: Partial<Record<CurveWarningKey, CurveWarning>> = {};
  const mMin = num(d.margin_min_mult, CURVE_DEFAULTS.margin_min_mult);
  const mMax = num(d.margin_max_mult, CURVE_DEFAULTS.margin_max_mult);
  const k = num(d.margin_k, CURVE_DEFAULTS.margin_k);
  const qMin = num(d.qty_min_factor, CURVE_DEFAULTS.qty_min_factor);
  const floor = num(d.min_task_price, CURVE_DEFAULTS.min_task_price);

  if (mMax === mMin) out.margin_max_mult = { key: 'calculator.warnFlatSize', values: { m: mMin.toFixed(2) } };
  if (example && example.unitCost > 0) {
    if (k > 20 * example.unitCost) out.margin_k = { key: 'calculator.warnKFar' };
    else if (k < example.unitCost / 20) out.margin_k = { key: 'calculator.warnKNear' };
  }
  if (qMin === 1) out.qty_min_factor = { key: 'calculator.warnNoQtyDiscount' };
  if (example && example.unitCost > 0) {
    const priceAtExample = example.unitCost * sizeMargin(example.unitCost, d);
    if (floor > priceAtExample) out.min_task_price = { key: 'calculator.warnFloorDominates' };
  }
  return out;
}
