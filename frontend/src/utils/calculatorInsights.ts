// Selectors turning GET /calculator/insights payloads into the "reality
// check" rows the calculator shows next to its assumptions. Pure module —
// no React, no API. Rows are only emitted when the sample is big enough
// AND the measured value meaningfully disagrees with the assumption;
// confirming an assumption is silence, not a row.

import type { CalculatorDefaults, CalculatorFilament, CalculatorInsights, CalculatorPrinter } from '../api/client';
import { containsEitherWay } from './archivePricing';

export const MIN_SAMPLE = 5;
/** Percentage-point disagreement below which the failure row stays hidden. */
const FAILURE_DELTA_PTS = 2;
/** Relative disagreement thresholds for tariff and spool cost rows. */
const TARIFF_DELTA_REL = 0.05;
const SPOOL_COST_DELTA_REL = 0.1;

export interface RealityCheck {
  kind: 'failure' | 'tariff' | 'spoolCost';
  /** What the calculator currently assumes. */
  assumed: number;
  /** What the app actually measured. */
  measured: number;
  sample: number;
  /** Scope label for failure rows: printer or material name; null = overall. */
  scope: string | null;
  /** Filament profile the spool-cost row would update. */
  filamentId?: number;
}

/**
 * The measured failure rate most specific to the current selection:
 * selected printer's rate, else selected filament material's rate, else the
 * overall rate — always with its scope label so the UI can say which.
 */
function pickFailureRate(
  insights: CalculatorInsights,
  filament: CalculatorFilament | undefined,
  printer: CalculatorPrinter | undefined,
): { rate_pct: number; sample: number; scope: string | null } | null {
  if (printer) {
    const name = printer.name.toLowerCase();
    const match = insights.failure.by_printer.find(
      (p) => p.printer_name && containsEitherWay(p.printer_name.toLowerCase(), name),
    );
    if (match && match.sample >= MIN_SAMPLE) {
      return { rate_pct: match.rate_pct, sample: match.sample, scope: match.printer_name };
    }
  }
  if (filament?.material) {
    const material = filament.material.toLowerCase();
    const match = insights.failure.by_material.find(
      (m) => m.material && containsEitherWay(m.material.toLowerCase(), material),
    );
    if (match && match.sample >= MIN_SAMPLE) {
      return { rate_pct: match.rate_pct, sample: match.sample, scope: match.material };
    }
  }
  if (insights.failure.overall_pct !== null && insights.failure.sample >= MIN_SAMPLE) {
    return { rate_pct: insights.failure.overall_pct, sample: insights.failure.sample, scope: null };
  }
  return null;
}

export function selectRealityChecks(
  insights: CalculatorInsights | undefined,
  filament: CalculatorFilament | undefined,
  printer: CalculatorPrinter | undefined,
  defaults: CalculatorDefaults | undefined,
  applied: { failureRateOverride: string; tariffOverride: string },
): RealityCheck[] {
  if (!insights || !defaults) return [];
  const checks: RealityCheck[] = [];

  const failure = pickFailureRate(insights, filament, printer);
  if (failure) {
    const assumed = applied.failureRateOverride !== '' ? Number(applied.failureRateOverride) : defaults.failure_rate_pct;
    if (Math.abs(failure.rate_pct - assumed) >= FAILURE_DELTA_PTS || applied.failureRateOverride !== '') {
      checks.push({
        kind: 'failure',
        assumed: defaults.failure_rate_pct,
        measured: failure.rate_pct,
        sample: failure.sample,
        scope: failure.scope,
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
    });
  }

  if (filament?.material) {
    const material = filament.material.toLowerCase();
    const spool = insights.spool_cost_by_material.find((s) => containsEitherWay(s.material.toLowerCase(), material));
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
        filamentId: filament.id,
      });
    }
  }

  return checks;
}

/**
 * Time-accuracy hint for the selected printer (falls back to the overall
 * figure). accuracy_pct = slicer estimate / actual × 100, so >100 means the
 * printer finishes FASTER than the slicer predicted.
 */
export function pickTimeAccuracy(
  insights: CalculatorInsights | undefined,
  printer: CalculatorPrinter | undefined,
): { accuracy_pct: number; sample: number; scope: string | null } | null {
  if (!insights) return null;
  if (printer) {
    const name = printer.name.toLowerCase();
    const match = insights.time_accuracy.by_printer.find((p) =>
      containsEitherWay(p.printer_name.toLowerCase(), name),
    );
    if (match && match.sample >= 3) {
      return { accuracy_pct: match.accuracy_pct, sample: match.sample, scope: match.printer_name };
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
