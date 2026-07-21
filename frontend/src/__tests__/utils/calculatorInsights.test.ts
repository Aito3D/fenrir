import { describe, it, expect } from 'vitest';
import { correctedTimeH, pickTimeAccuracy, selectRealityChecks } from '../../utils/calculatorInsights';
import type { CalculatorDefaults, CalculatorFilament, CalculatorInsights, CalculatorPrinter } from '../../api/client';

const insights: CalculatorInsights = {
  window_days: 365,
  failure: {
    overall_pct: 10,
    sample: 100,
    by_printer: [{ printer_id: 3, printer_name: 'X1 Carbon', material: null, rate_pct: 15, sample: 40 }],
    by_material: [{ printer_id: null, printer_name: null, material: 'PLA', rate_pct: 5, sample: 60 }],
  },
  energy_cost_per_kwh: 0.25,
  spool_cost_by_material: [{ material: 'PLA', avg_cost_per_kg: 18, sample: 12 }],
  time_accuracy: {
    overall_pct: 104,
    sample: 50,
    by_printer: [{ printer_id: 3, printer_name: 'X1 Carbon', accuracy_pct: 120, sample: 30 }],
  },
};

const defaults = { failure_rate_pct: 30, electricity_tariff: 0.15 } as CalculatorDefaults;
const filament = { id: 1, material: 'PLA', cost_per_kg: 25 } as CalculatorFilament;
const printer = { id: 9, name: 'X1 Carbon' } as CalculatorPrinter;
const noOverrides = { failureRateOverride: '', tariffOverride: '' };

describe('selectRealityChecks', () => {
  it('prefers the selected printer failure rate and reports its scope', () => {
    const checks = selectRealityChecks(insights, filament, printer, defaults, noOverrides);
    const failure = checks.find((c) => c.kind === 'failure');
    expect(failure).toMatchObject({ measured: 15, sample: 40, scope: 'X1 Carbon', assumed: 30 });
  });

  it('falls back to material then overall when the printer has no data', () => {
    const otherPrinter = { id: 9, name: 'Unmatched 9000' } as CalculatorPrinter;
    const checks = selectRealityChecks(insights, filament, otherPrinter, defaults, noOverrides);
    expect(checks.find((c) => c.kind === 'failure')).toMatchObject({ measured: 5, scope: 'PLA' });

    const otherFilament = { id: 2, material: 'TPU', cost_per_kg: 30 } as CalculatorFilament;
    const overall = selectRealityChecks(insights, otherFilament, otherPrinter, defaults, noOverrides);
    expect(overall.find((c) => c.kind === 'failure')).toMatchObject({ measured: 10, scope: null });
  });

  it('hides rows when the measured value agrees with the assumption', () => {
    const agreeing = { ...defaults, failure_rate_pct: 15.5, electricity_tariff: 0.25 } as CalculatorDefaults;
    const agreeingFilament = { ...filament, cost_per_kg: 18.5 } as CalculatorFilament;
    const checks = selectRealityChecks(insights, agreeingFilament, printer, agreeing, noOverrides);
    expect(checks).toEqual([]);
  });

  it('keeps a row visible while its override is applied so Revert stays reachable', () => {
    const checks = selectRealityChecks(insights, filament, printer, defaults, {
      failureRateOverride: '15',
      tariffOverride: '',
    });
    expect(checks.find((c) => c.kind === 'failure')).toBeDefined();
  });

  it('emits tariff and spool cost rows with meaningful deltas', () => {
    const checks = selectRealityChecks(insights, filament, printer, defaults, noOverrides);
    expect(checks.find((c) => c.kind === 'tariff')).toMatchObject({ assumed: 0.15, measured: 0.25 });
    expect(checks.find((c) => c.kind === 'spoolCost')).toMatchObject({ assumed: 25, measured: 18, filamentId: 1 });
  });

  it('returns nothing without insights or defaults', () => {
    expect(selectRealityChecks(undefined, filament, printer, defaults, noOverrides)).toEqual([]);
    expect(selectRealityChecks(insights, filament, printer, undefined, noOverrides)).toEqual([]);
  });
});

describe('pickTimeAccuracy', () => {
  it('matches the selected printer by name', () => {
    expect(pickTimeAccuracy(insights, printer)).toMatchObject({ accuracy_pct: 120, scope: 'X1 Carbon' });
  });

  it('falls back to the overall accuracy', () => {
    const other = { id: 9, name: 'Nope' } as CalculatorPrinter;
    expect(pickTimeAccuracy(insights, other)).toMatchObject({ accuracy_pct: 104, scope: null });
  });
});

describe('correctedTimeH', () => {
  it('pins the inversion: 120% accuracy means the printer is FASTER than the estimate', () => {
    // Slicer says 6h, printer historically finishes at 120% accuracy
    // (estimate/actual) → actual should be 5h, not 7.2h.
    expect(correctedTimeH(6, 120)).toBeCloseTo(5);
  });

  it('slower printers get more time', () => {
    expect(correctedTimeH(6, 80)).toBeCloseTo(7.5);
  });

  it('ignores invalid accuracy', () => {
    expect(correctedTimeH(6, 0)).toBe(6);
  });
});
