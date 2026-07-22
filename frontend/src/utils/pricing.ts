// Pure pricing engine for the 3D print cost calculator.
// Single source of truth for all calculator math — no React, no API calls.
// All monetary values are in the app-configured currency, kept at full float
// precision; rounding happens only at display time via formatMoney().

import { getCurrencySymbol } from './currency';

export interface PricingFilament {
  cost_per_kg: number;
  sale_price_per_kg: number;
  difficulty_pct: number; // per-filament difficulty multiplier, e.g. 150 for abrasive filaments
}

export interface PricingPrinter {
  purchase_price: number;
  lifetime_years: number;
  daily_usage_hours: number;
  power_watts: number;
  repair_rate_pct: number;
}

export interface PricingDefaults {
  electricity_tariff: number;
  labor_rate_per_hour: number;
  consumables_packaging_flat: number;
  failure_rate_pct: number;
  prototype_rate_pct: number;
  ads_rate_pct: number;
  filament_markup_pct: number;
  global_markup_pct: number;
  tax_pct: number;
  default_difficulty_pct: number;
  stuff_markup_pct: number;
  /** One-time per-job base fee (quotation time, order handling). Optional so
   *  pre-migration configs keep working; treated as 0 when absent. */
  base_fee_flat?: number;
}

export interface PricingInputs {
  weight_g: number;
  printing_time_h: number;
  /** Actual measured energy for the job in kWh (e.g. from an archive).
   *  When > 0 it replaces the watts × hours estimate. */
  measured_energy_kwh?: number;
  quantity: number;
  modeling_hours: number;
  modeling_base_price: number;
  prep_model_min: number;
  prep_slicing_min: number;
  prep_transfer_min: number;
  post_removal_min: number;
  post_support_min: number;
  post_additional_min: number;
  post_fulfillment_min: number;
  stuff_amount: number;
  stuff_markup_pct: number;
}

export interface PricingResult {
  filament_cost: number;
  depreciation_cost: number;
  energy_cost: number;
  repairs_cost: number;
  machine_cost: number;
  prototype_cost: number;
  failures_cost: number;
  machine_cost_safety: number;
  ads_cost: number;
  consumables_flat: number;
  /** Full one-time base fee for the whole job (quotation time etc.). */
  base_fee_total: number;
  /** Per-unit share of the one-time base fee (total ÷ quantity). */
  base_fee: number;
  /** Full one-time modeling cost for the whole job. */
  modeling_cost_total: number;
  /** Full one-time preparation cost for the whole job. */
  prep_cost_total: number;
  /** Per-unit share of the one-time modeling cost (total ÷ quantity). */
  modeling_cost: number;
  /** Per-unit share of the one-time preparation cost (total ÷ quantity). */
  prep_cost: number;
  post_processing_cost: number;
  stuff_cost: number;
  labor_total: number;
  /** Per-print production costs redone when a print fails — the base the
   *  prototype and failure provisions are computed on. */
  risk_base: number;
  /** Full per-unit cost basis (all costs, provisions and overhead — no margin). */
  total_cost: number;
  margin_global: number;
  margin_filament: number;
  margin_stuff: number;
  marge: number;
  total_ht: number;
  total_ttc: number;
  margin_pct: number; // marge over the pre-tax price (marge / total_ht), e.g. 0.3333
  quantity: number;
  total_ht_qty: number;
  total_ttc_qty: number;
}

export const printerLifetimeHours = (p: PricingPrinter): number =>
  p.lifetime_years * 365 * p.daily_usage_hours;

export const printerDepreciationPerHour = (p: PricingPrinter): number => {
  const hours = printerLifetimeHours(p);
  return hours > 0 ? p.purchase_price / hours : 0;
};

export const printerRepairsPerHour = (p: PricingPrinter): number => {
  const hours = printerLifetimeHours(p);
  return hours > 0 ? (p.purchase_price * (p.repair_rate_pct / 100)) / hours : 0;
};

/** Quote-style filament line (sale price × difficulty × filament markup) —
 *  used by the Statistics tile via archivePricing. computePricing prices
 *  filament at cost_per_kg and books the sale-price delta as margin_filament;
 *  the two split this line exactly (cost part + margin part ≡ this value). */
export const filamentLineCost = (weightG: number, filament: PricingFilament, defaults: PricingDefaults): number =>
  (weightG / 1000) *
  filament.sale_price_per_kg *
  (filament.difficulty_pct / 100) *
  (1 + defaults.filament_markup_pct / 100);

export function computePricing(
  inputs: PricingInputs,
  filament: PricingFilament,
  printer: PricingPrinter,
  defaults: PricingDefaults,
): PricingResult {
  const t = inputs.printing_time_h;
  const d = filament.difficulty_pct / 100; // per-filament, e.g. 1.5
  const quantity = Math.max(1, Math.floor(inputs.quantity || 1));

  // ── Phase A: true costs (per unit). No margin or markup enters here —
  // every line is what the job actually costs to produce.

  // Filament at purchase cost; the difficulty factor covers waste/handling
  // (the sale-price uplift is booked in Phase C as margin_filament).
  const filament_cost = (inputs.weight_g / 1000) * filament.cost_per_kg * d;

  // Printer depreciation (pure time, no difficulty)
  const depreciation_cost = printerDepreciationPerHour(printer) * t;

  // Energy — measured kWh (from an archive) wins over the nameplate
  // watts × hours estimate; the difficulty surcharge applies either way.
  const measured = inputs.measured_energy_kwh ?? 0;
  const energy_base =
    measured > 0
      ? measured * defaults.electricity_tariff
      : (printer.power_watts / 1000) * defaults.electricity_tariff * t;
  const energy_cost = energy_base * d;

  // Repairs
  const repairs_cost = printerRepairsPerHour(printer) * t * d;

  const machine_cost = filament_cost + depreciation_cost + energy_cost + repairs_cost;

  // Labor + consumables. Modeling and preparation are one-time costs for
  // the whole job (you design and slice once), so their per-unit share is the
  // total amortized across the quantity; post-processing and stuff recur per
  // unit. All downstream figures are per unit.
  const laborRate = defaults.labor_rate_per_hour;
  const modeling_cost_total = inputs.modeling_hours * laborRate + inputs.modeling_base_price;
  const prep_cost_total =
    ((inputs.prep_model_min + inputs.prep_slicing_min + inputs.prep_transfer_min) / 60) * laborRate;
  const modeling_cost = modeling_cost_total / quantity;
  const prep_cost = prep_cost_total / quantity;
  const post_processing_cost =
    ((inputs.post_removal_min + inputs.post_support_min + inputs.post_additional_min + inputs.post_fulfillment_min) /
      60) *
    laborRate;
  // Extras at cost — their markup is booked in Phase C as margin_stuff.
  const stuff_cost = inputs.stuff_amount;
  const labor_total = modeling_cost + prep_cost + post_processing_cost + stuff_cost;
  const consumables_flat = defaults.consumables_packaging_flat;
  // Base fee: a one-time per-job amount (quotation time, order handling) —
  // like modeling/prep it is amortized across the quantity, and like the
  // other flat costs it sits in total_cost so margin and tax apply.
  const base_fee_total = defaults.base_fee_flat ?? 0;
  const base_fee = base_fee_total / quantity;

  // ── Phase B: risk + overhead. The risk provisions cover what is redone
  // when a print fails: the machine costs plus the prep and post-processing
  // labor. Modeling, base fee, consumables and extras are not lost on a
  // failure, so they stay out of the risk base.
  const risk_base = machine_cost + prep_cost + post_processing_cost;
  const prototype_cost = risk_base * (defaults.prototype_rate_pct / 100);
  const failures_cost = risk_base * (defaults.failure_rate_pct / 100);
  const machine_cost_safety = machine_cost + prototype_cost + failures_cost;

  // Ads are business overhead, spread over everything the job costs.
  const cost_subtotal =
    machine_cost + prototype_cost + failures_cost + labor_total + consumables_flat + base_fee;
  const ads_cost = cost_subtotal * (defaults.ads_rate_pct / 100);
  const total_cost = cost_subtotal + ads_cost;

  // ── Phase C: margins, all applied at the end on the full cost basis.
  // margin_filament: kg·sale·d·(1+fm) ≡ filament_cost + this line, so the
  // filament contribution to the pre-margin price is exactly the old quote
  // line, just split honestly between cost and margin. No clamp — a sale
  // price below cost shows a negative margin rather than hiding the loss.
  const margin_global = total_cost * (defaults.global_markup_pct / 100);
  const margin_filament =
    (inputs.weight_g / 1000) *
    (filament.sale_price_per_kg * (1 + defaults.filament_markup_pct / 100) - filament.cost_per_kg) *
    d;
  const margin_stuff = inputs.stuff_amount * (inputs.stuff_markup_pct / 100);
  const marge = margin_global + margin_filament + margin_stuff;

  // Totals. Collected tax is not revenue, so the margin fraction is
  // expressed over the pre-tax price.
  const total_ht = total_cost + marge;
  const total_ttc = total_ht * (1 + defaults.tax_pct / 100);
  const margin_pct = total_ht > 0 ? marge / total_ht : 0;

  return {
    filament_cost,
    depreciation_cost,
    energy_cost,
    repairs_cost,
    machine_cost,
    prototype_cost,
    failures_cost,
    machine_cost_safety,
    ads_cost,
    consumables_flat,
    base_fee_total,
    base_fee,
    modeling_cost_total,
    prep_cost_total,
    modeling_cost,
    prep_cost,
    post_processing_cost,
    stuff_cost,
    labor_total,
    risk_base,
    total_cost,
    margin_global,
    margin_filament,
    margin_stuff,
    marge,
    total_ht,
    total_ttc,
    margin_pct,
    quantity,
    total_ht_qty: total_ht * quantity,
    total_ttc_qty: total_ttc * quantity,
  };
}

export const DISCOUNT_COLUMNS = [0, 0.05, 0.1, 0.2, 0.3, 0.5];
const BULK_QUANTITIES = [10, 20, 30, 50, 100, 300];
export const BULK_DISCOUNTS = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5];

export interface DiscountColumn {
  discount: number; // fraction
  machine_cost: number;
  machine_cost_safety: number;
  price: number; // customer-facing, TTC × (1 − discount)
  price_ht: number; // pre-tax price at this discount, total_ht × (1 − discount)
  discount_amount: number;
  potential_profit: number; // pre-tax: price_ht − total_cost (tax is not profit)
}

/** Largest discount that still covers total_cost on the pre-tax price
 *  (collected tax is owed to the tax authority, not profit) — beyond it every
 *  sale loses money. Returns null when there is no price yet. */
export function breakEvenDiscount(result: PricingResult): number | null {
  if (result.total_ht <= 0) return null;
  return Math.max(0, 1 - result.total_cost / result.total_ht);
}

/** Profit implied by a customer-facing target price (tax included): the net
 *  (pre-tax) revenue, the profit vs total_cost and the margin fraction over
 *  net. Returns null when the target is not a usable price. */
export function targetPriceProfit(
  targetTtc: number,
  taxPct: number,
  totalCost: number,
): { net: number; profit: number; margin: number } | null {
  if (!Number.isFinite(targetTtc) || targetTtc <= 0) return null;
  const net = targetTtc / (1 + taxPct / 100);
  return { net, profit: net - totalCost, margin: net > 0 ? (net - totalCost) / net : 0 };
}

export function discountMatrix(result: PricingResult, discounts: number[] = DISCOUNT_COLUMNS): DiscountColumn[] {
  return discounts.map((discount) => {
    const price = result.total_ttc * (1 - discount);
    const price_ht = result.total_ht * (1 - discount);
    return {
      discount,
      machine_cost: result.machine_cost * (1 - discount),
      machine_cost_safety: result.machine_cost_safety * (1 - discount),
      price,
      price_ht,
      discount_amount: result.total_ttc - price,
      potential_profit: price_ht - result.total_cost,
    };
  });
}

export interface BulkRow {
  quantity: number;
  prices: number[]; // one per discount, job TTC at that quantity × (1 − discount)
}

/** Bulk price table. Each row is a full recompute at that quantity so that
 *  one-time costs (modeling, preparation) are amortized rather than
 *  multiplied — the whole point of bulk pricing. */
export function bulkPricing(
  inputs: PricingInputs,
  filament: PricingFilament,
  printer: PricingPrinter,
  defaults: PricingDefaults,
  quantities: number[] = BULK_QUANTITIES,
  discounts: number[] = BULK_DISCOUNTS,
): BulkRow[] {
  return quantities.map((quantity) => {
    const r = computePricing({ ...inputs, quantity }, filament, printer, defaults);
    return {
      quantity,
      prices: discounts.map((discount) => r.total_ttc_qty * (1 - discount)),
    };
  });
}

const THIN_SPACE = '\u202F'; // narrow no-break space, thousands separator
const NBSP = '\u00A0';

// ISO 4217 currencies without minor units among the app's supported set.
const ZERO_DECIMAL_CURRENCIES = new Set(['XPF', 'JPY', 'KRW']);
// Symbols conventionally written after the amount ("22 699 FCFP", "129 kr");
// everything else is prefixed ("$22.70").
const SUFFIX_SYMBOLS = new Set(['FCFP', 'kr', 'zł', 'Kč', 'Ft']);

/** Format a monetary amount for display in the given ISO currency code:
 * thin-space thousands separators, whole units for zero-decimal currencies
 * (e.g. "22 699 FCFP"), two decimals otherwise (e.g. "$2 295.15"). */
export function formatMoney(value: number, currency: string, withUnit = true): string {
  const code = currency.toUpperCase();
  const symbol = getCurrencySymbol(code);
  const suffix = SUFFIX_SYMBOLS.has(symbol);
  const compose = (sign: string, amount: string) => {
    if (!withUnit) return `${sign}${amount}`;
    return suffix ? `${sign}${amount}${NBSP}${symbol}` : `${sign}${symbol}${amount}`;
  };
  if (!Number.isFinite(value)) return compose('', '—');
  const decimals = ZERO_DECIMAL_CURRENCIES.has(code) ? 0 : 2;
  const fixed = Math.abs(value).toFixed(decimals);
  const [intPart, fracPart] = fixed.split('.');
  const digits = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, THIN_SPACE);
  const sign = value < 0 && Number(fixed) !== 0 ? '-' : '';
  return compose(sign, fracPart ? `${digits}.${fracPart}` : digits);
}

/** Format a fraction as a percentage for display, e.g. 0.2842 → "28.42%". */
export function formatPct(fraction: number, decimals = 2): string {
  if (!Number.isFinite(fraction)) return '—%';
  return `${(fraction * 100).toFixed(decimals)}%`;
}

export interface WaterfallStep {
  key: 'filament' | 'printer' | 'energy' | 'provisions' | 'other' | 'labor' | 'marge' | 'tax';
  value: number;
  /** Running total AFTER this step — the last step's cumulative is total_ttc. */
  cumulative: number;
}

/** i18n label key per waterfall step — lives here (not in a component file)
 *  so component modules keep fast refresh. */
export const STEP_LABEL_KEY: Record<WaterfallStep['key'], string> = {
  filament: 'calculator.costFilament',
  printer: 'calculator.splitPrinter',
  energy: 'calculator.costEnergy',
  provisions: 'calculator.groupProvisions',
  other: 'calculator.splitAdsConsumables',
  labor: 'calculator.groupLabor',
  marge: 'calculator.marge',
  tax: 'calculator.waterfall.tax',
};

/**
 * The price build-up as ordered waterfall steps: machine costs, provisions,
 * ads+consumables, labor, then margin and tax. The marge step is the combined
 * margin (global + filament + extras) — the split lives in the breakdown card.
 * Zero-value steps are dropped (a non-positive combined marge simply drops its
 * step; the drift-absorb below keeps the right edge at total_ttc). Invariant
 * (pinned by tests): the final cumulative equals total_ttc.
 */
export function buildWaterfall(result: PricingResult): WaterfallStep[] {
  const raw: Array<{ key: WaterfallStep['key']; value: number }> = [
    { key: 'filament', value: result.filament_cost },
    { key: 'printer', value: result.depreciation_cost + result.repairs_cost },
    { key: 'energy', value: result.energy_cost },
    { key: 'provisions', value: result.prototype_cost + result.failures_cost },
    { key: 'other', value: result.ads_cost + result.consumables_flat + result.base_fee },
    { key: 'labor', value: result.labor_total },
    { key: 'marge', value: result.marge },
    { key: 'tax', value: result.total_ttc - result.total_ht },
  ];
  const steps: WaterfallStep[] = [];
  let cumulative = 0;
  for (const step of raw) {
    if (step.value <= 0.005) continue;
    cumulative += step.value;
    steps.push({ ...step, cumulative });
  }
  // Absorb float drift so the right edge is exactly the displayed total.
  if (steps.length > 0) steps[steps.length - 1].cumulative = result.total_ttc;
  return steps;
}
