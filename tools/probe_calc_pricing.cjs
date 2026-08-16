// Snapshot probe: run the pure calculator pricing engine over fixed inputs.
// The bundle is produced by rolldown into /tmp/bambuddy-refactor-probe/ by the
// probe command in PROBES.json before this script runs.
// Floats are rounded to 8 decimal places so pure re-association noise cannot
// flake the probe while any real math change still trips it.
const p = require("/tmp/bambuddy-refactor-probe/pricing.cjs");

const filament = { cost_per_kg: 25, sale_price_per_kg: 40, difficulty_pct: 150 };
const printer = {
  purchase_price: 1200,
  lifetime_years: 3,
  daily_usage_hours: 8,
  power_watts: 110,
  repair_rate_pct: 10,
};
const defaults = {
  electricity_tariff: 0.25,
  labor_rate_per_hour: 30,
  consumables_packaging_flat: 1.5,
  failure_rate_pct: 5,
  prototype_rate_pct: 3,
  ads_rate_pct: 2,
  filament_markup_pct: 20,
  global_markup_pct: 30,
  tax_pct: 20,
  default_difficulty_pct: 100,
  stuff_markup_pct: 15,
  base_fee_flat: 4,
};
const inputsA = {
  weight_g: 250,
  printing_time_h: 7.5,
  quantity: 3,
  modeling_hours: 1.5,
  modeling_base_price: 10,
  prep_model_min: 10,
  prep_slicing_min: 5,
  prep_transfer_min: 2,
  post_removal_min: 5,
  post_support_min: 8,
  post_additional_min: 0,
  post_fulfillment_min: 6,
  stuff_amount: 3,
  stuff_markup_pct: 15,
};
// Edge scenario: measured energy override, quantity 1, pre-migration defaults
// (no base_fee_flat), zero stuff.
const defaultsNoBase = { ...defaults };
delete defaultsNoBase.base_fee_flat;
const inputsB = {
  ...inputsA,
  measured_energy_kwh: 1.8,
  quantity: 1,
  stuff_amount: 0,
  modeling_hours: 0,
  modeling_base_price: 0,
};

const rA = p.computePricing(inputsA, filament, printer, defaults);
const rB = p.computePricing(inputsB, filament, printer, defaultsNoBase);

const round = (_k, v) => (typeof v === "number" ? Number(v.toFixed(8)) : v);
console.log(
  JSON.stringify(
    {
      scenarioA: rA,
      scenarioB: rB,
      breakEvenA: p.breakEvenDiscount(rA),
      targetPriceProfit: p.targetPriceProfit(120, 20, 80),
      discountMatrixA: p.discountMatrix(rA),
      bulkA: p.bulkPricing(inputsA, filament, printer, defaults),
      waterfallA: p.buildWaterfall(rA),
      lineCost: p.filamentLineCost(250, filament, defaults),
      depreciationPerHour: p.printerDepreciationPerHour(printer),
      repairsPerHour: p.printerRepairsPerHour(printer),
      lifetimeHours: p.printerLifetimeHours(printer),
      formatMoney: p.formatMoney(1234.567, "EUR"),
      formatMoneyNoUnit: p.formatMoney(1234.567, "EUR", false),
      formatPct: p.formatPct(1 / 3),
      discountColumns: p.DISCOUNT_COLUMNS,
      bulkDiscounts: p.BULK_DISCOUNTS,
      stepLabelKeys: p.STEP_LABEL_KEY,
    },
    round,
  ),
);
