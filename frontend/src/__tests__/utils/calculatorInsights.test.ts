import { describe, it, expect } from 'vitest';
import {
  checkKey,
  correctedTimeH,
  hasRealityCheckData,
  pickTimeAccuracy,
  realityCheckImpact,
  selectRealityChecks,
  type RealityCheck,
} from '../../utils/calculatorInsights';
import { foldSessionOverrides, DEFAULT_STATE, type CalcState } from '../../hooks/useCalculatorState';
import type { PricingDefaults, PricingFilament, PricingInputs, PricingPrinter } from '../../utils/pricing';
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
  spool_cost_by_brand: [{ brand: 'POLYMAKER', material: 'PLA', avg_cost_per_kg: 21, sample: 4 }],
  time_accuracy: {
    overall_pct: 104,
    sample: 50,
    by_printer: [{ printer_id: 3, printer_name: 'X1 Carbon', accuracy_pct: 120, sample: 30 }],
  },
  power_by_printer: [{ printer_id: 3, printer_name: 'X1 Carbon', avg_watts: 105, sample: 25 }],
  usage_by_printer: [{ printer_id: 3, printer_name: 'X1 Carbon', hours_per_day: 3.2, observed_days: 90, sample: 48 }],
};

const defaults = { failure_rate_pct: 30, electricity_tariff: 0.15 } as CalculatorDefaults;
const filament = { id: 1, material: 'PLA', cost_per_kg: 25 } as CalculatorFilament;
const printer = { id: 9, name: 'X1 Carbon', power_watts: 200, daily_usage_hours: 8 } as CalculatorPrinter;
const noOverrides = {
  failureRateOverride: '',
  tariffOverride: '',
  timeAccuracyOverride: '',
  powerWattsOverride: '',
  dailyHoursOverride: '',
};

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
    const agreeingPrinter = { ...printer, power_watts: 110, daily_usage_hours: 3.5 } as CalculatorPrinter;
    const checks = selectRealityChecks(insights, agreeingFilament, agreeingPrinter, agreeing, noOverrides);
    expect(checks).toEqual([]);
  });

  it('keeps a row visible while its override is applied so Revert stays reachable', () => {
    const checks = selectRealityChecks(insights, filament, printer, defaults, {
      ...noOverrides,
      failureRateOverride: '15',
    });
    expect(checks.find((c) => c.kind === 'failure')).toBeDefined();
  });

  it('emits tariff and spool cost rows with meaningful deltas', () => {
    const checks = selectRealityChecks(insights, filament, printer, defaults, noOverrides);
    expect(checks.find((c) => c.kind === 'tariff')).toMatchObject({ assumed: 0.15, measured: 0.25 });
    expect(checks.find((c) => c.kind === 'spoolCost')).toMatchObject({ assumed: 25, measured: 18, filamentId: 1 });
  });

  it('prefers the brand+material spool average when the profile names a known brand', () => {
    const branded = { ...filament, brand: 'Polymaker' } as CalculatorFilament;
    const checks = selectRealityChecks(insights, branded, printer, defaults, noOverrides);
    expect(checks.find((c) => c.kind === 'spoolCost')).toMatchObject({ measured: 21, brand: 'POLYMAKER' });
  });

  it('emits a power row when measured watts disagree with the profile', () => {
    const checks = selectRealityChecks(insights, filament, printer, defaults, noOverrides);
    // 105 W vs 200 W assumed → 47.5% off, past the 20% band and 2× it → significant.
    expect(checks.find((c) => c.kind === 'power')).toMatchObject({
      assumed: 200,
      measured: 105,
      scope: 'X1 Carbon',
      printerId: 9,
      severity: 'significant',
    });
  });

  it('emits a daily-usage row with the observed window attached', () => {
    const checks = selectRealityChecks(insights, filament, printer, defaults, noOverrides);
    expect(checks.find((c) => c.kind === 'dailyHours')).toMatchObject({
      assumed: 8,
      measured: 3.2,
      observedDays: 90,
      printerId: 9,
    });
  });

  it('averages across every machine matching the profile and labels the row with the model', () => {
    // A fleet: the "X1C" profile matches both physical machines by name.
    const fleet: CalculatorInsights = {
      ...insights,
      failure: {
        ...insights.failure,
        by_printer: [
          { printer_id: 3, printer_name: 'X1C04', material: null, rate_pct: 10, sample: 10 },
          { printer_id: 4, printer_name: 'X1C05', material: null, rate_pct: 20, sample: 30 },
        ],
      },
      power_by_printer: [
        { printer_id: 3, printer_name: 'X1C04', avg_watts: 100, sample: 10 },
        { printer_id: 4, printer_name: 'X1C05', avg_watts: 130, sample: 30 },
      ],
      usage_by_printer: [
        { printer_id: 3, printer_name: 'X1C04', hours_per_day: 2, observed_days: 50, sample: 20 },
        { printer_id: 4, printer_name: 'X1C05', hours_per_day: 6, observed_days: 100, sample: 40 },
      ],
    };
    const profile = { id: 9, name: 'X1C', power_watts: 200, daily_usage_hours: 8 } as CalculatorPrinter;
    const checks = selectRealityChecks(fleet, filament, profile, defaults, noOverrides);

    // Failure: (10×10 + 20×30) / 40 = 17.5%, scoped to the profile name.
    expect(checks.find((c) => c.kind === 'failure')).toMatchObject({
      measured: 17.5,
      sample: 40,
      scope: 'X1C',
      printerCount: 2,
    });
    // Power: (100×10 + 130×30) / 40 = 122.5 W.
    expect(checks.find((c) => c.kind === 'power')).toMatchObject({
      measured: 122.5,
      sample: 40,
      scope: 'X1C',
      printerCount: 2,
    });
    // Usage, weighted by observed days: (2×50 + 6×100) / 150 ≈ 4.67 h/day —
    // a per-MACHINE average, never the fleet's summed hours.
    const usage = checks.find((c) => c.kind === 'dailyHours');
    expect(usage?.measured).toBeCloseTo(4.667, 3);
    expect(usage).toMatchObject({ sample: 60, scope: 'X1C', observedDays: 100, printerCount: 2 });
  });

  it('fleet averages skip machines below the minimum sample', () => {
    const fleet: CalculatorInsights = {
      ...insights,
      usage_by_printer: [
        { printer_id: 3, printer_name: 'X1C04', hours_per_day: 2, observed_days: 50, sample: 20 },
        { printer_id: 4, printer_name: 'X1C05', hours_per_day: 20, observed_days: 50, sample: 3 },
      ],
    };
    const profile = { id: 9, name: 'X1C', power_watts: 200, daily_usage_hours: 8 } as CalculatorPrinter;
    const checks = selectRealityChecks(fleet, filament, profile, defaults, noOverrides);
    expect(checks.find((c) => c.kind === 'dailyHours')).toMatchObject({ measured: 2, sample: 20 });
  });

  it('skips printer-scoped rows for an unmatched printer name', () => {
    const other = { id: 9, name: 'Unmatched 9000', power_watts: 200, daily_usage_hours: 8 } as CalculatorPrinter;
    const checks = selectRealityChecks(insights, filament, other, defaults, noOverrides);
    expect(checks.find((c) => c.kind === 'power')).toBeUndefined();
    expect(checks.find((c) => c.kind === 'dailyHours')).toBeUndefined();
  });

  it('emits a time row only while the time is a slicer estimate', () => {
    const withEstimate = selectRealityChecks(insights, filament, printer, defaults, noOverrides, {
      fromEstimate: true,
      estimateH: 6,
    });
    // X1 Carbon at 120% accuracy → 6h estimate corrects to 5h.
    expect(withEstimate.find((c) => c.kind === 'time')).toMatchObject({ assumed: 6, measured: 5, scope: 'X1 Carbon' });

    const manualTime = selectRealityChecks(insights, filament, printer, defaults, noOverrides, {
      fromEstimate: false,
      estimateH: 6,
    });
    expect(manualTime.find((c) => c.kind === 'time')).toBeUndefined();
  });

  it('grades severity by distance past the emit threshold', () => {
    // Failure: |15 - 18| = 3 pts → past 2 but under 4 → minor.
    const nearDefaults = { ...defaults, failure_rate_pct: 18 } as CalculatorDefaults;
    const checks = selectRealityChecks(insights, filament, printer, nearDefaults, noOverrides);
    expect(checks.find((c) => c.kind === 'failure')?.severity).toBe('minor');
    // |15 - 30| = 15 pts → ≥ 4 → significant.
    const farChecks = selectRealityChecks(insights, filament, printer, defaults, noOverrides);
    expect(farChecks.find((c) => c.kind === 'failure')?.severity).toBe('significant');
  });

  it('returns nothing without insights or defaults', () => {
    expect(selectRealityChecks(undefined, filament, printer, defaults, noOverrides)).toEqual([]);
    expect(selectRealityChecks(insights, filament, printer, undefined, noOverrides)).toEqual([]);
  });
});

describe('checkKey', () => {
  it('is stable per kind and scope', () => {
    expect(checkKey({ kind: 'failure', scope: 'X1 Carbon' })).toBe('failure:X1 Carbon');
    expect(checkKey({ kind: 'tariff', scope: null })).toBe('tariff:all');
  });
});

describe('realityCheckImpact', () => {
  const pricingInputs: PricingInputs = {
    weight_g: 100,
    printing_time_h: 6,
    quantity: 1,
    modeling_hours: 0,
    modeling_base_price: 0,
    prep_model_min: 0,
    prep_slicing_min: 0,
    prep_transfer_min: 0,
    post_removal_min: 0,
    post_support_min: 0,
    post_additional_min: 0,
    post_fulfillment_min: 0,
    stuff_amount: 0,
    stuff_markup_pct: 0,
  };
  const pricingFilament: PricingFilament = { cost_per_kg: 20, sale_price_per_kg: 60, difficulty_pct: 100 };
  const pricingPrinter: PricingPrinter = {
    purchase_price: 1200,
    lifetime_years: 3,
    daily_usage_hours: 8,
    power_watts: 200,
    repair_rate_pct: 10,
  };
  const pricingDefaults: PricingDefaults = {
    electricity_tariff: 0.15,
    labor_rate_per_hour: 30,
    consumables_packaging_flat: 0.5,
    failure_rate_pct: 10,
    prototype_rate_pct: 0,
    ads_rate_pct: 0,
    filament_markup_pct: 0,
    global_markup_pct: 30,
    tax_pct: 20,
    default_difficulty_pct: 100,
    stuff_markup_pct: 0,
    // This fixture's total cost (~$4-10) sits well under the engine's
    // default $12 per-task floor (utils/pricing.ts CURVE_DEFAULTS), so a
    // small reality-check delta (e.g. watts 200 -> 100) can land BOTH the
    // baseline and the variant on the floor — total_ht pinned to 12 either
    // way, hiding the underlying cost swing this describe block exists to
    // pin. Disabling the floor here isolates the size-margin/quantity-curve
    // sensitivity under test from that unrelated floor behavior.
    min_task_price: 0,
  };
  const impact = (check: Partial<RealityCheck> & Pick<RealityCheck, 'kind' | 'assumed' | 'measured'>) =>
    realityCheckImpact(
      { sample: 10, scope: null, severity: 'minor', ...check },
      pricingInputs,
      pricingFilament,
      pricingPrinter,
      pricingDefaults,
    );

  it('a higher measured failure rate raises the price', () => {
    expect(impact({ kind: 'failure', assumed: 10, measured: 25 })!).toBeGreaterThan(0);
  });

  it('LOWER measured daily hours RAISE the price (depreciation spreads over fewer hours)', () => {
    expect(impact({ kind: 'dailyHours', assumed: 8, measured: 3 })!).toBeGreaterThan(0);
  });

  it('lower measured watts lower the price', () => {
    expect(impact({ kind: 'power', assumed: 200, measured: 100 })!).toBeLessThan(0);
  });

  it('spool cost has no price effect — the quote prices from sale price', () => {
    expect(impact({ kind: 'spoolCost', assumed: 25, measured: 18 })).toBeNull();
  });

  it('a higher measured electricity tariff raises the price', () => {
    expect(impact({ kind: 'tariff', assumed: 0.15, measured: 0.25 })!).toBeGreaterThan(0);
  });

  it('a higher measured printing time raises the price', () => {
    expect(impact({ kind: 'time', assumed: 6, measured: 10 })!).toBeGreaterThan(0);
  });
});

describe('foldSessionOverrides', () => {
  const pricingInputs = { printing_time_h: 6 } as PricingInputs;
  const foldDefaults = { failure_rate_pct: 10, electricity_tariff: 0.15 };
  const foldPrinter = { power_watts: 200, daily_usage_hours: 8 };
  const state = (patch: Partial<CalcState>): CalcState => ({ ...DEFAULT_STATE, ...patch });

  it('passes everything through untouched without overrides', () => {
    const out = foldSessionOverrides(state({}), foldDefaults, foldPrinter, pricingInputs);
    expect(out.defaults).toBe(foldDefaults);
    expect(out.printer).toBe(foldPrinter);
    expect(out.inputs).toBe(pricingInputs);
  });

  it('folds printer overrides into a clone, leaving the profile object alone', () => {
    const out = foldSessionOverrides(
      state({ powerWattsOverride: '105', dailyHoursOverride: '3.2' }),
      foldDefaults,
      foldPrinter,
      pricingInputs,
    );
    expect(out.printer).toMatchObject({ power_watts: 105, daily_usage_hours: 3.2 });
    expect(foldPrinter.power_watts).toBe(200);
  });

  it('corrects the print time only while it still comes from an estimate', () => {
    const applied = state({ timeAccuracyOverride: '120', timeFromEstimate: true });
    expect(foldSessionOverrides(applied, foldDefaults, foldPrinter, pricingInputs).inputs.printing_time_h).toBeCloseTo(5);

    const manual = state({ timeAccuracyOverride: '120', timeFromEstimate: false });
    expect(foldSessionOverrides(manual, foldDefaults, foldPrinter, pricingInputs).inputs.printing_time_h).toBe(6);
  });

  it('folds failure and tariff overrides into the defaults', () => {
    const out = foldSessionOverrides(
      state({ failureRateOverride: '15', tariffOverride: '0.25' }),
      foldDefaults,
      foldPrinter,
      pricingInputs,
    );
    expect(out.defaults).toMatchObject({ failure_rate_pct: 15, electricity_tariff: 0.25 });
  });
});

describe('hasRealityCheckData', () => {
  it('is false for missing or empty insights', () => {
    expect(hasRealityCheckData(undefined)).toBe(false);
    expect(
      hasRealityCheckData({
        window_days: 365,
        failure: { overall_pct: null, sample: 0, by_printer: [], by_material: [] },
        energy_cost_per_kwh: 0,
        spool_cost_by_material: [],
        spool_cost_by_brand: [],
        time_accuracy: { overall_pct: null, sample: 0, by_printer: [] },
        power_by_printer: [],
        usage_by_printer: [],
      }),
    ).toBe(false);
  });

  it('is true once any signal has enough data', () => {
    expect(hasRealityCheckData(insights)).toBe(true);
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
