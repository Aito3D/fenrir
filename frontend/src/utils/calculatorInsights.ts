// Selectors turning GET /calculator/insights payloads into the "reality
// check" rows the calculator shows next to its assumptions. Pure module —
// no React, no API. Rows are only emitted when the sample is big enough
// AND the measured value meaningfully disagrees with the assumption;
// confirming an assumption is silence, not a row.

import type { CalculatorDefaults, CalculatorFilament, CalculatorInsights, CalculatorPrinter } from '../api/client';
import { containsEitherWay } from './archivePricing';
import {
  computePricing,
  type PricingDefaults,
  type PricingFilament,
  type PricingInputs,
  type PricingPrinter,
} from './pricing';

export const MIN_SAMPLE = 5;
/** Percentage-point disagreement below which the failure row stays hidden. */
const FAILURE_DELTA_PTS = 2;
/** Percentage-point drift off 100% below which the time row stays hidden. */
const TIME_DELTA_PTS = 2;
/** Relative disagreement thresholds for the remaining rows. */
const TARIFF_DELTA_REL = 0.05;
const SPOOL_COST_DELTA_REL = 0.1;
// Nameplate watts vs averaged real draw is inherently noisy (heating phases,
// idle tails), and usage patterns swing week to week — hence the wide bands.
const POWER_DELTA_REL = 0.2;
const DAILY_HOURS_DELTA_REL = 0.3;

export type RealityCheckKind = 'failure' | 'tariff' | 'spoolCost' | 'time' | 'power' | 'dailyHours';
export type RealityCheckSeverity = 'minor' | 'significant';

export interface RealityCheck {
  kind: RealityCheckKind;
  /** What the calculator currently assumes. */
  assumed: number;
  /** What the app actually measured. */
  measured: number;
  sample: number;
  /** Scope label: printer or material name; null = overall/global. */
  scope: string | null;
  /** How far past its emit threshold the disagreement is (2× = significant). */
  severity: RealityCheckSeverity;
  /** Filament profile the spool-cost row would update. */
  filamentId?: number;
  /** Set when the spool-cost row matched on brand+material, not material alone. */
  brand?: string;
  /** Calculator printer profile the power/daily-hours rows would update. */
  printerId?: number;
  /** Days of history behind the daily-usage measurement (for the tooltip). */
  observedDays?: number;
  /** How many physical printers the profile matched — a profile usually names
      a model ("X1C"), so a fleet averages across every machine of that model. */
  printerCount?: number;
}

/** Session overrides currently applied on the calculator (from CalcState). */
export interface RealityCheckOverrides {
  failureRateOverride: string;
  tariffOverride: string;
  timeAccuracyOverride: string;
  powerWattsOverride: string;
  dailyHoursOverride: string;
}

/** Stable identity for a row — used for dismissals and impact lookups. */
export const checkKey = (check: Pick<RealityCheck, 'kind' | 'scope'>): string =>
  `${check.kind}:${check.scope ?? 'all'}`;

const severityFor = (delta: number, threshold: number): RealityCheckSeverity =>
  delta >= threshold * 2 ? 'significant' : 'minor';

/**
 * All measured per-printer entries the selected profile matches, by name. A
 * calculator profile usually names a MODEL ("X1C") while physical printers
 * carry unit names ("X1C04", "X1C05"…) — every machine of the model matches,
 * and the caller averages across them instead of picking an arbitrary one.
 */
function matchPrinters<T extends { printer_name: string; sample: number }>(
  entries: T[] | undefined,
  printer: CalculatorPrinter | undefined,
): T[] {
  if (!printer) return [];
  const name = printer.name.toLowerCase();
  // `?? []`: tolerate payloads from an older backend that predates the field.
  return (entries ?? []).filter((p) => p.sample >= MIN_SAMPLE && containsEitherWay(p.printer_name.toLowerCase(), name));
}

/** Scope label for a fleet: the profile (model) name when several machines
 *  matched, the single machine's own name otherwise. */
const fleetScope = (matches: Array<{ printer_name: string }>, printer: CalculatorPrinter): string =>
  matches.length > 1 ? printer.name : matches[0].printer_name;

/**
 * The measured failure rate most specific to the current selection: the
 * selected printer profile's machines (sample-weighted across the fleet),
 * else the selected filament material's rate, else the overall rate — always
 * with its scope label so the UI can say which.
 */
function pickFailureRate(
  insights: CalculatorInsights,
  filament: CalculatorFilament | undefined,
  printer: CalculatorPrinter | undefined,
): { rate_pct: number; sample: number; scope: string | null; printerCount?: number } | null {
  const named = insights.failure.by_printer.flatMap((p) =>
    p.printer_name ? [{ ...p, printer_name: p.printer_name }] : [],
  );
  // A suppressed entry (rate_pct null — T-027 cross-window guard) contributes
  // nothing: it's excluded here exactly like a below-MIN_SAMPLE entry, from
  // both the aggregation numerator and the sample denominator.
  const matches = matchPrinters(named, printer).filter((p) => p.rate_pct !== null);
  if (printer && matches.length > 0) {
    const sample = matches.reduce((s, m) => s + m.sample, 0);
    const rate_pct = matches.reduce((s, m) => s + m.rate_pct! * m.sample, 0) / sample;
    return { rate_pct, sample, scope: fleetScope(matches, printer), printerCount: matches.length };
  }
  if (filament?.material) {
    const material = filament.material.toLowerCase();
    const match = insights.failure.by_material.find(
      (m) => m.material && containsEitherWay(m.material.toLowerCase(), material),
    );
    if (match && match.sample >= MIN_SAMPLE && match.rate_pct !== null) {
      return { rate_pct: match.rate_pct, sample: match.sample, scope: match.material };
    }
  }
  if (insights.failure.overall_pct !== null && insights.failure.sample >= MIN_SAMPLE) {
    return { rate_pct: insights.failure.overall_pct, sample: insights.failure.sample, scope: null };
  }
  return null;
}

/** Sample-weighted average watts across the profile's matched machines. */
function pickPowerDraw(insights: CalculatorInsights, printer: CalculatorPrinter | undefined) {
  const matches = matchPrinters(insights.power_by_printer, printer);
  if (!printer || matches.length === 0) return null;
  const sample = matches.reduce((s, m) => s + m.sample, 0);
  const avg_watts = matches.reduce((s, m) => s + m.avg_watts * m.sample, 0) / sample;
  return { avg_watts, sample, scope: fleetScope(matches, printer), printerCount: matches.length };
}

/** Usage-hours/day averaged (weighted by observed days) across the profile's
 *  matched machines — the per-MACHINE figure the depreciation assumption is. */
function pickDailyUsage(insights: CalculatorInsights, printer: CalculatorPrinter | undefined) {
  const matches = matchPrinters(insights.usage_by_printer, printer);
  if (!printer || matches.length === 0) return null;
  const totalDays = matches.reduce((s, m) => s + m.observed_days, 0);
  const hours_per_day = matches.reduce((s, m) => s + m.hours_per_day * m.observed_days, 0) / totalDays;
  return {
    hours_per_day,
    sample: matches.reduce((s, m) => s + m.sample, 0),
    observed_days: Math.max(...matches.map((m) => m.observed_days)),
    scope: fleetScope(matches, printer),
    printerCount: matches.length,
  };
}

export function selectRealityChecks(
  insights: CalculatorInsights | undefined,
  filament: CalculatorFilament | undefined,
  printer: CalculatorPrinter | undefined,
  defaults: CalculatorDefaults | undefined,
  applied: RealityCheckOverrides,
  time?: { fromEstimate: boolean; estimateH: number },
): RealityCheck[] {
  if (!insights || !defaults) return [];
  const checks: RealityCheck[] = [];

  const failure = pickFailureRate(insights, filament, printer);
  if (failure) {
    const assumed = applied.failureRateOverride !== '' ? Number(applied.failureRateOverride) : defaults.failure_rate_pct;
    const delta = Math.abs(failure.rate_pct - assumed);
    if (delta >= FAILURE_DELTA_PTS || applied.failureRateOverride !== '') {
      checks.push({
        kind: 'failure',
        assumed: defaults.failure_rate_pct,
        measured: failure.rate_pct,
        sample: failure.sample,
        scope: failure.scope,
        severity: severityFor(Math.abs(failure.rate_pct - defaults.failure_rate_pct), FAILURE_DELTA_PTS),
        printerCount: failure.printerCount,
      });
    }
  }

  const tariff = insights.energy_cost_per_kwh;
  const assumedTariff = applied.tariffOverride !== '' ? Number(applied.tariffOverride) : defaults.electricity_tariff;
  if (
    tariff > 0 &&
    defaults.electricity_tariff > 0 &&
    (Math.abs(tariff - assumedTariff) / assumedTariff >= TARIFF_DELTA_REL || applied.tariffOverride !== '')
  ) {
    checks.push({
      kind: 'tariff',
      assumed: defaults.electricity_tariff,
      measured: tariff,
      sample: 1,
      scope: null,
      severity: severityFor(
        Math.abs(tariff - defaults.electricity_tariff) / defaults.electricity_tariff,
        TARIFF_DELTA_REL,
      ),
    });
  }

  // Time row only makes sense while the entered time still IS a slicer
  // estimate — once the user types a real duration there is nothing to correct.
  if (time?.fromEstimate && time.estimateH > 0) {
    const accuracy = pickTimeAccuracy(insights, printer);
    if (
      accuracy &&
      (Math.abs(accuracy.accuracy_pct - 100) >= TIME_DELTA_PTS || applied.timeAccuracyOverride !== '')
    ) {
      checks.push({
        kind: 'time',
        assumed: time.estimateH,
        measured: correctedTimeH(time.estimateH, accuracy.accuracy_pct),
        sample: accuracy.sample,
        scope: accuracy.scope,
        severity: severityFor(Math.abs(accuracy.accuracy_pct - 100), TIME_DELTA_PTS),
        printerCount: accuracy.printers,
      });
    }
  }

  const power = pickPowerDraw(insights, printer);
  if (power && printer && printer.power_watts > 0) {
    const assumedWatts = applied.powerWattsOverride !== '' ? Number(applied.powerWattsOverride) : printer.power_watts;
    if (
      Math.abs(power.avg_watts - assumedWatts) / assumedWatts >= POWER_DELTA_REL ||
      applied.powerWattsOverride !== ''
    ) {
      checks.push({
        kind: 'power',
        assumed: printer.power_watts,
        measured: power.avg_watts,
        sample: power.sample,
        scope: power.scope,
        severity: severityFor(Math.abs(power.avg_watts - printer.power_watts) / printer.power_watts, POWER_DELTA_REL),
        printerId: printer.id,
        printerCount: power.printerCount,
      });
    }
  }

  const usage = pickDailyUsage(insights, printer);
  if (usage && printer && printer.daily_usage_hours > 0) {
    const assumedHours =
      applied.dailyHoursOverride !== '' ? Number(applied.dailyHoursOverride) : printer.daily_usage_hours;
    if (
      Math.abs(usage.hours_per_day - assumedHours) / assumedHours >= DAILY_HOURS_DELTA_REL ||
      applied.dailyHoursOverride !== ''
    ) {
      checks.push({
        kind: 'dailyHours',
        assumed: printer.daily_usage_hours,
        measured: usage.hours_per_day,
        sample: usage.sample,
        scope: usage.scope,
        severity: severityFor(
          Math.abs(usage.hours_per_day - printer.daily_usage_hours) / printer.daily_usage_hours,
          DAILY_HOURS_DELTA_REL,
        ),
        printerId: printer.id,
        observedDays: usage.observed_days,
        printerCount: usage.printerCount,
      });
    }
  }

  if (filament?.material) {
    const material = filament.material.toLowerCase();
    // Prefer the exact brand+material average when the profile names a brand
    // the inventory knows; fall back to the material-wide average.
    let spool: { avg_cost_per_kg: number; sample: number; material: string } | undefined;
    let brand: string | undefined;
    if (filament.brand) {
      const wanted = filament.brand.toLowerCase();
      const match = (insights.spool_cost_by_brand ?? []).find(
        (s) => containsEitherWay(s.brand.toLowerCase(), wanted) && containsEitherWay(s.material.toLowerCase(), material),
      );
      if (match) {
        spool = match;
        brand = match.brand;
      }
    }
    if (!spool) {
      spool = insights.spool_cost_by_material.find((s) => containsEitherWay(s.material.toLowerCase(), material));
    }
    if (
      spool &&
      filament.cost_per_kg > 0 &&
      Math.abs(spool.avg_cost_per_kg - filament.cost_per_kg) / filament.cost_per_kg >= SPOOL_COST_DELTA_REL
    ) {
      checks.push({
        kind: 'spoolCost',
        assumed: filament.cost_per_kg,
        measured: spool.avg_cost_per_kg,
        sample: spool.sample,
        scope: spool.material,
        severity: severityFor(
          Math.abs(spool.avg_cost_per_kg - filament.cost_per_kg) / filament.cost_per_kg,
          SPOOL_COST_DELTA_REL,
        ),
        filamentId: filament.id,
        brand,
      });
    }
  }

  return checks;
}

/**
 * Price impact of applying one check: Δ on the per-unit price (TTC), computed
 * against the RAW (un-overridden) inputs/printer/defaults. Positive means
 * applying raises the quote — the assumption was underpricing the job.
 * Returns null for rows with no price effect (spool cost is informational —
 * the quote prices filament from sale_price_per_kg, not cost_per_kg).
 */
export function realityCheckImpact(
  check: RealityCheck,
  inputs: PricingInputs,
  filament: PricingFilament,
  printer: PricingPrinter,
  defaults: PricingDefaults,
): number | null {
  let variantInputs = inputs;
  let variantPrinter = printer;
  let variantDefaults = defaults;
  switch (check.kind) {
    case 'failure':
      variantDefaults = { ...defaults, failure_rate_pct: check.measured };
      break;
    case 'tariff':
      variantDefaults = { ...defaults, electricity_tariff: check.measured };
      break;
    case 'time':
      variantInputs = { ...inputs, printing_time_h: check.measured };
      break;
    case 'power':
      variantPrinter = { ...printer, power_watts: check.measured };
      break;
    case 'dailyHours':
      variantPrinter = { ...printer, daily_usage_hours: check.measured };
      break;
    case 'spoolCost':
      return null;
  }
  const base = computePricing(inputs, filament, printer, defaults).total_ttc;
  const variant = computePricing(variantInputs, filament, variantPrinter, variantDefaults).total_ttc;
  return variant - base;
}

/**
 * Time-accuracy hint for the selected printer profile — sample-weighted
 * across every machine the profile name matches (falls back to the overall
 * figure). accuracy_pct = slicer estimate / actual × 100, so >100 means the
 * printer finishes FASTER than the slicer predicted.
 */
export function pickTimeAccuracy(
  insights: CalculatorInsights | undefined,
  printer: CalculatorPrinter | undefined,
): { accuracy_pct: number; sample: number; scope: string | null; printers?: number } | null {
  if (!insights) return null;
  if (printer) {
    const name = printer.name.toLowerCase();
    // A suppressed entry (accuracy_pct null — T-027 cross-window guard)
    // contributes nothing, same as a below-sample entry: excluded from both
    // the aggregation numerator and the sample denominator.
    const matches = insights.time_accuracy.by_printer.filter(
      (p) => p.sample >= 3 && p.accuracy_pct !== null && containsEitherWay(p.printer_name.toLowerCase(), name),
    );
    if (matches.length > 0) {
      const sample = matches.reduce((s, m) => s + m.sample, 0);
      const accuracy_pct = matches.reduce((s, m) => s + m.accuracy_pct! * m.sample, 0) / sample;
      return { accuracy_pct, sample, scope: fleetScope(matches, printer), printers: matches.length };
    }
  }
  if (insights.time_accuracy.overall_pct !== null && insights.time_accuracy.sample >= 3) {
    return { accuracy_pct: insights.time_accuracy.overall_pct, sample: insights.time_accuracy.sample, scope: null };
  }
  return null;
}

/** Corrected wall-clock hours from a slicer estimate and a measured accuracy %. */
export function correctedTimeH(estimateH: number, accuracyPct: number): number {
  if (!(accuracyPct > 0)) return estimateH;
  return (estimateH * 100) / accuracyPct;
}

/**
 * True when the insights payload had enough data to check ANYTHING — used to
 * show a quiet "all clear" line instead of nothing when every check agrees.
 * A fresh install with no history should stay silent, not celebrate.
 */
export function hasRealityCheckData(insights: CalculatorInsights | undefined): boolean {
  if (!insights) return false;
  return (
    insights.failure.sample >= MIN_SAMPLE ||
    insights.energy_cost_per_kwh > 0 ||
    insights.spool_cost_by_material.length > 0 ||
    insights.time_accuracy.sample >= 3 ||
    (insights.power_by_printer ?? []).length > 0 ||
    (insights.usage_by_printer ?? []).length > 0
  );
}
