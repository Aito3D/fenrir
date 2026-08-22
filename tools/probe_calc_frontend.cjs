// Snapshot probe: the calculator's pure frontend decision logic — the
// reality-check selection/impact table (calculatorInsights.ts) and the quote
// summary builder (quoteSummary.ts) — over fixed inputs.
// The bundle is produced by rolldown into /tmp/bambuddy-refactor-probe/ by the
// probe command in PROBES.json before this script runs.
// Floats are rounded to 8 dp so re-association noise cannot flake the probe
// while any real change in the arithmetic still trips it.
const m = require("/tmp/bambuddy-refactor-probe/calcFrontend.cjs");

const defaults = {
  id: 1,
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
  default_margin_over_cost_pct: 50,
  stuff_markup_pct: 15,
  base_fee_flat: 4,
};
const filament = {
  id: 1, name: "Generic PLA", brand: "Generic", material: "PLA",
  cost_per_kg: 25, sale_price_per_kg: 40, margin_pct: 60, difficulty_pct: 150,
  zoho_item_id: null, zoho_item_name: null, zoho_sku: null,
  spool_weight_kg: null, zoho_synced_at: null,
};
const printer = {
  id: 1, name: "X1C", purchase_price: 1200, lifetime_years: 3,
  daily_usage_hours: 8, power_watts: 110, repair_rate_pct: 10,
};
// A populated payload that trips several reality checks at once, and an
// under-sample variant that must trip none (MIN_SAMPLE is the boundary).
const insightsFull = {
  window_days: 365,
  failure: {
    overall_pct: 18, sample: 40,
    by_printer: [{ printer_id: 1, printer_name: "X1C", material: null, rate_pct: 22, sample: 30 }],
    by_material: [{ printer_id: null, printer_name: null, material: "PLA", rate_pct: 15, sample: 18 }],
  },
  energy_cost_per_kwh: 0.31,
  spool_cost_by_material: [{ material: "PLA", avg_cost_per_kg: 31.5, sample: 9 }],
  spool_cost_by_brand: [{ brand: "Generic", material: "PLA", avg_cost_per_kg: 33, sample: 7 }],
  time_accuracy: {
    overall_pct: 130, sample: 25,
    by_printer: [{ printer_id: 1, printer_name: "X1C", accuracy_pct: 118, sample: 20 }],
  },
  power_by_printer: [{ printer_id: 1, printer_name: "X1C", avg_watts: 145, sample: 12 }],
  usage_by_printer: [{ printer_id: 1, printer_name: "X1C", hours_per_day: 3.5, observed_days: 60, sample: 60 }],
};
const thin = (n) => ({
  window_days: 365,
  failure: { overall_pct: 18, sample: n, by_printer: [], by_material: [] },
  energy_cost_per_kwh: 0.31,
  spool_cost_by_material: [{ material: "PLA", avg_cost_per_kg: 31.5, sample: n }],
  spool_cost_by_brand: [],
  time_accuracy: { overall_pct: 130, sample: n, by_printer: [] },
  power_by_printer: [{ printer_id: 1, printer_name: "X1C", avg_watts: 145, sample: n }],
  usage_by_printer: [{ printer_id: 1, printer_name: "X1C", hours_per_day: 3.5, observed_days: 60, sample: n }],
});
const noOverrides = {
  failureRateOverride: "", tariffOverride: "", timeAccuracyOverride: "",
  powerWattsOverride: "", dailyHoursOverride: "",
};
// Overrides already applied: the "acknowledged" branch, which selects rows even
// when the delta is under threshold.
const someOverrides = { ...noOverrides, failureRateOverride: "22", powerWattsOverride: "145" };

const pricingInputs = {
  weight_g: 250, printing_time_h: 7.5, quantity: 3,
  modeling_hours: 1.5, modeling_base_price: 10,
  prep_model_min: 10, prep_slicing_min: 5, prep_transfer_min: 2,
  post_removal_min: 5, post_support_min: 8, post_additional_min: 0,
  post_fulfillment_min: 6, stuff_amount: 3, stuff_markup_pct: 15,
};

const state = {
  weight: "250", timeD: "1", timeH: "7", timeM: "30", energyKwh: "",
  quantity: "3", modelingHours: "1.5", modelingBasePrice: "10",
  prepModel: "10", prepSlicing: "5", prepTransfer: "2",
  postRemoval: "5", postSupport: "8", postAdditional: "0", postFulfillment: "6",
  stuffAmount: "3", stuffMarkup: "15", targetPrice: "", filamentId: 1,
  printerId: 1, easyMode: false, ...noOverrides, dismissedChecks: [],
  timeFromEstimate: false,
};

const sel = (ins, ov, time) => m.insights.selectRealityChecks(ins, filament, printer, defaults, ov, time);
const checksFull = sel(insightsFull, noOverrides);
const checksApplied = sel(insightsFull, someOverrides);
const checksFromEstimate = sel(insightsFull, noOverrides, { fromEstimate: true, estimateH: 7.5 });

const round = (_k, v) => (typeof v === "number" ? Number(v.toFixed(8)) : v);
console.log(
  JSON.stringify(
    {
      MIN_SAMPLE: m.insights.MIN_SAMPLE,
      checksFull,
      checksApplied,
      checksFromEstimate,
      // MIN_SAMPLE boundary: one below, exactly at, one above.
      checksSampleBoundary: [4, 5, 6].map((n) => sel(thin(n), noOverrides)),
      checksNoInsights: sel(undefined, noOverrides),
      checksNoDefaults: m.insights.selectRealityChecks(insightsFull, filament, printer, undefined, noOverrides),
      checkKeys: checksFull.map((c) => m.insights.checkKey(c)),
      impacts: checksFull.map((c) => ({
        key: m.insights.checkKey(c),
        impact: m.insights.realityCheckImpact(c, pricingInputs, filament, printer, defaults),
      })),
      pickTimeAccuracyPrinter: m.insights.pickTimeAccuracy(insightsFull, printer),
      pickTimeAccuracyNoPrinter: m.insights.pickTimeAccuracy(insightsFull, undefined),
      pickTimeAccuracyThin: m.insights.pickTimeAccuracy(thin(1), printer),
      correctedTime: [130, 100, 50, 0].map((a) => m.insights.correctedTimeH(7.5, a)),
      hasData: [
        m.insights.hasRealityCheckData(insightsFull),
        m.insights.hasRealityCheckData(thin(1)),
        m.insights.hasRealityCheckData(undefined),
      ],
      quoteSummary: m.quote.buildQuoteSummary(filament, printer, state),
      quoteSummaryNoMaterial: m.quote.buildQuoteSummary(
        { ...filament, material: "" }, printer, { ...state, weight: "", timeD: "", timeH: "", timeM: "" },
      ),
    },
    round,
  ),
);
