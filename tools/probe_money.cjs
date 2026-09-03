// Campaign-9 golden probe: the app's pure money math over FIXED inputs.
// Pure functions only -- no clock, no network, no DOM -- so the output is
// byte-stable. Any change to a rounding rule, a margin curve, a discount
// ladder, or a forecast rate moves this file.
const m = require('/tmp/bambuddy-refactor-probe/money.cjs');
const D = {
  electricity_tariff: 0.25, labor_rate_per_hour: 35, consumables_packaging_flat: 2,
  failure_rate_pct: 5, prototype_rate_pct: 3, ads_rate_pct: 4, filament_markup_pct: 20,
  global_markup_pct: 0, tax_pct: 20, default_difficulty_pct: 100, stuff_markup_pct: 10,
  base_fee_flat: 8, margin_min_mult: 1.15, margin_max_mult: 1.6, margin_k: 33,
  qty_min_factor: 0.4, qty_k: 5, min_task_price: 12,
};
const FIL = { cost_per_kg: 18, sale_price_per_kg: 24.5, difficulty_pct: 150 };
const PRN = { purchase_price: 1200, lifetime_years: 5, daily_usage_hours: 8, power_watts: 120, repair_rate_pct: 10 };
const INPUTS = {
  weight_g: 250, printing_time_h: 6, quantity: 3, modeling_hours: 1.5,
  modeling_base_price: 40, prep_model_min: 10, prep_slicing_min: 8, prep_transfer_min: 4,
  post_removal_min: 6, post_support_min: 9, post_additional_min: 3, post_fulfillment_min: 5,
  stuff_amount: 15, stuff_markup_pct: 10,
};
const out = {};
const show = (k, fn) => { try { out[k] = fn(); } catch (e) { out[k] = 'THREW: ' + e.message; } };

show('CURVE_DEFAULTS', () => m.CURVE_DEFAULTS);
show('CURVE_QUANTITIES', () => m.CURVE_QUANTITIES);
show('DISCOUNT_COLUMNS', () => m.DISCOUNT_COLUMNS);
show('MEDIAN_MIN_MAX', () => [m.MEDIAN_MIN_SAMPLES, m.MEDIAN_MAX_SAMPLES]);

show('moneyDecimals', () => ['XPF', 'EUR', 'USD', 'JPY'].map((c) => [c, m.moneyDecimals(c)]));
show('formatMoney', () => [[1234.567, 'EUR'], [1234.567, 'XPF'], [0, 'USD'], [-9.5, 'EUR']]
  .map(([v, c]) => [v, c, m.formatMoney(v, c)]));
show('formatPct', () => [0, 0.125, 1, -0.4].map((v) => [v, m.formatPct(v)]));

show('qtyFactor', () => [1, 2, 5, 10, 25, 100].map((q) => [q, m.qtyFactor(q, D)]));
show('sizeMargin', () => [0, 1, 10, 100, 1000].map((c) => [c, m.sizeMargin(c, D)]));
show('unitMultiplier', () => [1, 3, 12, 60].map((q) => [q, m.unitMultiplier(100, q, D)]));
show('unitPriceCurve', () => m.unitPriceCurve(INPUTS, FIL, PRN, D));
show('computePricing', () => m.computePricing(INPUTS, FIL, PRN, D));
show('breakEvenDiscount', () => [0.1, 0.25, 0.5].map((g) => [g, m.breakEvenDiscount(g)]));
show('targetPriceProfit', () => [[100, 0.3], [250, 0.5]].map(([c, g]) => [c, g, m.targetPriceProfit(c, g)]));
show('discountMatrix', () => m.discountMatrix(0.4));
show('printerRates', () => [
  ['lifetimeHours', m.printerLifetimeHours(PRN)],
  ['depreciation', m.printerDepreciationPerHour(PRN)],
  ['repairs', m.printerRepairsPerHour(PRN)],
]);
show('filamentLineCost', () => m.filamentLineCost(250, FIL, D));
show('estimateFilamentCost', () => m.estimateFilamentCost(250, 24.5));
show('estimateArchiveSalePrice', () => m.estimateArchiveSalePrice({ filament_cost: 6, print_time: 7200 }));
show('containsEitherWay', () => [['abc', 'b'], ['b', 'abc'], ['x', 'y']].map(([a, b]) => [a, b, m.containsEitherWay(a, b)]));
show('skuKey', () => m.skuKey({ brand: 'Bambu', material: 'PLA', color: 'Black' }));
show('medianUnitCost', () => m.medianUnitCost([10, 12, 11, 30, 9]));
show('addDays', () => m.addDays(new Date('2026-01-31T00:00:00Z'), 45).toISOString());
// computeHistoryRate / computeDeltaRate / computeSkuForecasts are deliberately
// NOT probed: they read Date.now() and would drift every day. Their behaviour is
// covered by the unit suite instead -- a golden probe that changes on its own is
// a disabled alarm, not a gate.

console.log(JSON.stringify(out, null, 1));
