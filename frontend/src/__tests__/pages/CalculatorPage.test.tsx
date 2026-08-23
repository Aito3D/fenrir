/**
 * Tests for the CalculatorPage component.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { CalculatorPage } from '../../pages/CalculatorPage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { computePricing, formatMoney } from '../../utils/pricing';
import { buildQuoteSummary } from '../../utils/quoteSummary';
import { DEFAULT_STATE, num, splitDecimalHours } from '../../hooks/useCalculatorState';
import { correctedTimeH } from '../../utils/calculatorInsights';

const mockFilaments = [
  {
    id: 1,
    name: 'Sunlu PA6-CF',
    brand: 'Sunlu',
    material: 'PA6-CF',
    cost_per_kg: 3731,
    // Derived server-side: round(3731 * 1.50, 2).
    sale_price_per_kg: 5596.5,
    margin_pct: 50,
    difficulty_pct: 150,
    zoho_item_id: null,
    zoho_item_name: null,
    zoho_sku: null,
    spool_weight_kg: null,
    zoho_synced_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

const mockPrinters = [
  {
    id: 1,
    name: 'H2S',
    purchase_price: 347000,
    lifetime_years: 2,
    daily_usage_hours: 5,
    power_watts: 400,
    repair_rate_pct: 30,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

const mockDefaults = {
  id: 1,
  electricity_tariff: 120,
  labor_rate_per_hour: 3000,
  consumables_packaging_flat: 30,
  base_fee_flat: 0,
  failure_rate_pct: 30,
  prototype_rate_pct: 30,
  ads_rate_pct: 5,
  filament_markup_pct: 5,
  global_markup_pct: 50,
  tax_pct: 13,
  default_difficulty_pct: 100,
  default_margin_over_cost_pct: 50,
  stuff_markup_pct: 20,
  updated_at: '2026-01-01T00:00:00Z',
};

// Reality-check insights matching the "applying the measured failure rate"
// scenario: measured failure 8% vs the mock defaults' assumed 30%, tariff
// equal to the default so only one reality-check row (and one Apply button).
const failureCheckInsights = {
  window_days: 365,
  failure: {
    overall_pct: 8.0,
    sample: 25,
    by_printer: [{ printer_id: 1, printer_name: 'H2S', material: null, rate_pct: 8.0, sample: 25 }],
    by_material: [],
  },
  energy_cost_per_kwh: 120,
  spool_cost_by_material: [],
  spool_cost_by_brand: [],
  time_accuracy: { overall_pct: null, sample: 0, by_printer: [] },
  power_by_printer: [],
  usage_by_printer: [],
};

// Reality-check insights with every row-triggering field neutralized —
// callers spread this and add back only the field(s) under test, so a check
// that isn't the one being tested never sneaks in and creates an ambiguous
// second row (e.g. two "Update profile" buttons, which share label text).
const neutralInsights = {
  window_days: 365,
  failure: { overall_pct: null, sample: 0, by_printer: [], by_material: [] },
  // Equal to mockDefaults.electricity_tariff → no tariff row.
  energy_cost_per_kwh: 120,
  spool_cost_by_material: [],
  spool_cost_by_brand: [],
  time_accuracy: { overall_pct: null, sample: 0, by_printer: [] },
  power_by_printer: [],
  usage_by_printer: [],
};

// Pricing-engine inputs mirroring the reference case (40 g, 2 h, qty 1,
// mockFilaments[0]/mockPrinters[0]/mockDefaults) — used to compute the exact
// expected total after the 8% measured failure rate is applied, so the
// save-as-default tests assert a specific recomputed price instead of merely
// "not the old total".
const referencePricingInputs = {
  weight_g: 40,
  printing_time_h: 2,
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
  stuff_markup_pct: 20,
};
const referencePricingFilament = { cost_per_kg: 3731, sale_price_per_kg: 5596.5, difficulty_pct: 150 };
const referencePricingPrinter = {
  purchase_price: 347000,
  lifetime_years: 2,
  daily_usage_hours: 5,
  power_watts: 400,
  repair_rate_pct: 30,
};
const referencePricingDefaults = {
  electricity_tariff: 120,
  labor_rate_per_hour: 3000,
  consumables_packaging_flat: 30,
  base_fee_flat: 0,
  failure_rate_pct: 30,
  prototype_rate_pct: 30,
  ads_rate_pct: 5,
  filament_markup_pct: 5,
  global_markup_pct: 50,
  tax_pct: 13,
  default_difficulty_pct: 100,
  stuff_markup_pct: 20,
};
// formatMoney() uses narrow-no-break (\u202f) and no-break (\u00a0) spaces as
// separators, but testing-library's default text normalizer collapses all
// whitespace to a plain " " before matching -- so screen.getByText/findByText
// need the same collapsing applied to the string we search for.
const collapseSpaces = (s: string) => s.replace(/[\u202f\u00a0]/g, ' ');
const measuredFailureTotal = collapseSpaces(
  formatMoney(
    computePricing(
      referencePricingInputs,
      referencePricingFilament,
      referencePricingPrinter,
      { ...referencePricingDefaults, failure_rate_pct: 8 },
    ).total_ttc,
    'XPF',
  ),
);

// Global-defaults-edit scenario: saving a new electricity tariff (5000) on
// the Defaults tab must recompute the Calculator tab's total using that new
// tariff — not merely make the old total disappear (a blank or "NaN FCFP"
// render would also satisfy that).
const tariffUpdateTotal = collapseSpaces(
  formatMoney(
    computePricing(referencePricingInputs, referencePricingFilament, referencePricingPrinter, {
      ...referencePricingDefaults,
      electricity_tariff: 5000,
    }).total_ttc,
    'XPF',
  ),
);

// Time-correction chip scenario: the reference case's 2 h slicer estimate
// measured at 120% of actual (accuracy_pct) → the corrected wall-clock time
// is shorter. Both the corrected field split and the resulting total are
// derived from the real correctedTimeH/splitDecimalHours/computePricing
// helpers — exactly what the component itself computes on Apply — instead
// of a hand-typed literal that could silently drift from the source.
const timeCorrectionAccuracyPct = 120;
const timeCorrectionSplit = splitDecimalHours(correctedTimeH(2, timeCorrectionAccuracyPct));
const timeCorrectionReconstructedH =
  num(timeCorrectionSplit.timeD) * 24 + num(timeCorrectionSplit.timeH) + num(timeCorrectionSplit.timeM) / 60;
const timeCorrectionTotal = collapseSpaces(
  formatMoney(
    computePricing(
      { ...referencePricingInputs, printing_time_h: timeCorrectionReconstructedH },
      referencePricingFilament,
      referencePricingPrinter,
      referencePricingDefaults,
    ).total_ttc,
    'XPF',
  ),
);

// Expected clipboard payload for the "copy summary" tests below, built from
// the exact same helper the totals card calls (buildQuoteSummary) fed the
// same filament/printer/state the reference-case tests use (weight '40',
// time '2' -> timeH '2'). Deriving it this way pins the real content instead
// of a hand-typed string that could silently drift from the component.
const summaryState = { ...DEFAULT_STATE, weight: '40', timeH: '2' };
const expectedSummaryText = buildQuoteSummary(mockFilaments[0], mockPrinters[0], summaryState);

function useCalculatorHandlers({ filaments = mockFilaments, printers = mockPrinters, currency = 'XPF' } = {}) {
  server.use(
    http.get('/api/v1/calculator/filaments/', () => HttpResponse.json(filaments)),
    http.get('/api/v1/calculator/printers/', () => HttpResponse.json(printers)),
    http.get('/api/v1/calculator/defaults', () => HttpResponse.json(mockDefaults)),
    http.get('/api/v1/settings/', () => HttpResponse.json({ currency })),
    http.get('/api/v1/auth/status', () =>
      HttpResponse.json({ auth_enabled: false, requires_setup: false }),
    ),
  );
}

describe('CalculatorPage', () => {
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.setItem).mockReset();
    // The active tab lives in the URL now — reset it between tests.
    window.history.replaceState({}, '', '/');
    useCalculatorHandlers();
  });

  it('renders the reference case totals (40 g, 2 h, filament at 150% difficulty)', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state' ? JSON.stringify({ weight: '40', time: '2' }) : null,
    );

    render(<CalculatorPage />);

    // Costs at true value, margins at the end (global + filament):
    // TTC = 2 031, HT = 1 798, machine = 644
    await screen.findByText('2 031 FCFP');
    expect(screen.getByText('1 798 FCFP')).toBeInTheDocument();
    expect(screen.getByText('644 FCFP')).toBeInTheDocument();
    // Margin fraction over the pre-tax price: 685.09 / 1797.77
    expect(screen.getByText('38.11%')).toBeInTheDocument();
    // Difficulty comes from the filament profile and is shown read-only
    expect(screen.getByText('150%')).toBeInTheDocument();
    expect(screen.queryByLabelText('Difficulty factor (%)')).not.toBeInTheDocument();
  });

  it('shows a per-printer price comparison above the total and switches printer on click', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state' ? JSON.stringify({ weight: '40', time: '2' }) : null,
    );
    useCalculatorHandlers({
      printers: [
        ...mockPrinters,
        // Cheaper machine: lower depreciation, energy and repair inputs.
        {
          ...mockPrinters[0],
          id: 2,
          name: 'Cheapo',
          purchase_price: 100000,
          power_watts: 100,
          repair_rate_pct: 10,
        },
      ],
    });

    render(<CalculatorPage />);
    await screen.findByText('2 031 FCFP');

    // The selected printer (H2S) is hidden — only the alternative shows,
    // with its price and a signed % delta vs the current selection.
    const group = screen.getByRole('group', { name: 'Price by printer' });
    let chips = within(group).getAllByRole('button');
    expect(chips).toHaveLength(1);
    expect(within(group).getByText('Cheapo')).toBeInTheDocument();
    expect(within(group).queryByText('H2S')).not.toBeInTheDocument();
    // Cheapo is cheaper → negative delta.
    expect(chips[0].textContent).toMatch(/−\d+(\.\d+)?%/);

    // Clicking the chip re-prices with that printer; the roles flip.
    await userEvent.click(chips[0]);
    await waitFor(() => expect(within(group).getByText('H2S')).toBeInTheDocument());
    expect(within(group).queryByText('Cheapo')).not.toBeInTheDocument();
    chips = within(group).getAllByRole('button');
    // H2S is now the pricier alternative → positive delta.
    expect(chips[0].textContent).toMatch(/\+\d+(\.\d+)?%/);
  });

  it('reality check: applying the measured failure rate re-prices the job', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state' ? JSON.stringify({ weight: '40', time: '2' }) : null,
    );
    server.use(
      http.get('/api/v1/calculator/insights', () =>
        HttpResponse.json({
          window_days: 365,
          failure: {
            overall_pct: 8.0,
            sample: 25,
            by_printer: [{ printer_id: 1, printer_name: 'H2S', material: null, rate_pct: 8.0, sample: 25 }],
            by_material: [],
          },
          // Equal to the defaults' tariff → no tariff row, keeps one Apply button.
          energy_cost_per_kwh: 120,
          spool_cost_by_material: [],
          spool_cost_by_brand: [],
          time_accuracy: { overall_pct: null, sample: 0, by_printer: [] },
          power_by_printer: [],
          usage_by_printer: [],
        }),
      ),
    );

    render(<CalculatorPage />);
    await screen.findByText('2 031 FCFP');

    // Measured 8% vs assumed 30% → the reality-check row appears.
    await screen.findByText('Reality check');
    expect(screen.getByText(/Failure rate/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    // Provisions shrink (30% → 8% failure provision), so the total drops to
    // the exact recomputed figure (not just "no longer the old total").
    await screen.findByText(measuredFailureTotal);
    expect(screen.queryByText('2 031 FCFP')).not.toBeInTheDocument();
    expect(screen.getByText('Applied')).toBeInTheDocument();
  });

  it('reality check: saving the measured failure rate as default clears the override only after the save succeeds', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state' ? JSON.stringify({ weight: '40', time: '2' }) : null,
    );
    let defaults = { ...mockDefaults };
    server.use(
      http.get('/api/v1/calculator/insights', () => HttpResponse.json(failureCheckInsights)),
      http.get('/api/v1/calculator/defaults', () => HttpResponse.json(defaults)),
      http.patch('/api/v1/calculator/defaults', async ({ request }) => {
        const body = (await request.json()) as Record<string, number>;
        defaults = { ...defaults, ...body, updated_at: '2026-01-02T00:00:00Z' };
        return HttpResponse.json(defaults);
      }),
    );
    const user = userEvent.setup();

    render(<CalculatorPage />);
    await screen.findByText('2 031 FCFP');
    await screen.findByText('Reality check');

    await user.click(screen.getByRole('button', { name: 'Apply' }));
    // Positive proof the override is live before we ever touch "save".
    await screen.findByText(measuredFailureTotal);
    expect(screen.getByText('Applied')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save as default' }));

    await screen.findByText('Default updated');
    // The session override is cleared only now that the PATCH resolved —
    // the price stays pinned to the measured value throughout (the new
    // server-side default equals it, so nothing flickers).
    expect(screen.getByText(measuredFailureTotal)).toBeInTheDocument();
    expect(defaults.failure_rate_pct).toBe(8);
  });

  it('reality check: a failed save-as-default keeps the override applied and shows an error toast', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state' ? JSON.stringify({ weight: '40', time: '2' }) : null,
    );
    server.use(
      http.get('/api/v1/calculator/insights', () => HttpResponse.json(failureCheckInsights)),
      http.patch('/api/v1/calculator/defaults', () =>
        HttpResponse.json({ detail: 'Could not save default' }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();

    render(<CalculatorPage />);
    await screen.findByText('2 031 FCFP');
    await screen.findByText('Reality check');

    await user.click(screen.getByRole('button', { name: 'Apply' }));
    // Positive proof the override is live before the failed save.
    await screen.findByText(measuredFailureTotal);
    expect(screen.getByText('Applied')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save as default' }));

    await screen.findByText('Could not save default');
    // The override survives the failed save — still applied, still priced
    // off the measured figure instead of silently reverting to the old
    // assumption-based total.
    expect(screen.getByText('Applied')).toBeInTheDocument();
    expect(screen.getByText(measuredFailureTotal)).toBeInTheDocument();
    expect(screen.queryByText('2 031 FCFP')).not.toBeInTheDocument();
  });

  it('reality check: reverting an applied override restores the original total', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state' ? JSON.stringify({ weight: '40', time: '2' }) : null,
    );
    server.use(http.get('/api/v1/calculator/insights', () => HttpResponse.json(failureCheckInsights)));
    const user = userEvent.setup();

    render(<CalculatorPage />);
    await screen.findByText('2 031 FCFP');
    await screen.findByText('Reality check');

    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByText(measuredFailureTotal);
    expect(screen.getByText('Applied')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Revert' }));

    // Positive proof: the ORIGINAL total is back, not merely that the
    // overridden one left.
    await screen.findByText('2 031 FCFP');
    expect(screen.queryByText(measuredFailureTotal)).not.toBeInTheDocument();
    expect(screen.queryByText('Applied')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument();
  });

  it('reality check: updating the filament profile from a spool-cost check calls the API with the measured value', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state' ? JSON.stringify({ weight: '40', time: '2' }) : null,
    );
    let capturedBody: Record<string, number> | null = null;
    server.use(
      http.get('/api/v1/calculator/insights', () =>
        HttpResponse.json({
          ...neutralInsights,
          spool_cost_by_material: [{ material: 'PA6-CF', avg_cost_per_kg: 4500, sample: 12 }],
        }),
      ),
      http.patch('/api/v1/calculator/filaments/:id', async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, number>;
        return HttpResponse.json({ ...mockFilaments[0], ...capturedBody });
      }),
    );
    const user = userEvent.setup();

    render(<CalculatorPage />);
    await screen.findByText('2 031 FCFP');
    await screen.findByText('Reality check');

    // Row-scoped: this label text only exists inside the spool-cost row.
    const row = screen.getByText('Filament cost (PA6-CF)').closest('.animate-calc-tab-in') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Update profile' }));

    await screen.findByText('Filament profile updated');
    expect(capturedBody).toEqual({ cost_per_kg: 4500 });
  });

  it('reality check: updating the printer profile from power/dailyHours checks calls the API with the measured values', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state' ? JSON.stringify({ weight: '40', time: '2' }) : null,
    );
    const capturedBodies: Record<string, number>[] = [];
    server.use(
      http.get('/api/v1/calculator/insights', () =>
        HttpResponse.json({
          ...neutralInsights,
          power_by_printer: [{ printer_id: 1, printer_name: 'H2S', avg_watts: 500, sample: 20 }],
          usage_by_printer: [{ printer_id: 1, printer_name: 'H2S', hours_per_day: 8, observed_days: 30, sample: 20 }],
        }),
      ),
      http.patch('/api/v1/calculator/printers/:id', async ({ request }) => {
        const body = (await request.json()) as Record<string, number>;
        capturedBodies.push(body);
        return HttpResponse.json({ ...mockPrinters[0], ...body });
      }),
    );
    const user = userEvent.setup();

    render(<CalculatorPage />);
    await screen.findByText('2 031 FCFP');
    await screen.findByText('Reality check');

    // Both rows are present at once — scope every click/query to its own row
    // since "Update profile" labels both buttons identically.
    const powerRow = screen.getByText('Power draw (H2S)').closest('.animate-calc-tab-in') as HTMLElement;
    await user.click(within(powerRow).getByRole('button', { name: 'Update profile' }));
    await screen.findByText('Printer profile updated');
    expect(capturedBodies).toContainEqual({ power_watts: 500 });

    const hoursRow = screen.getByText('Daily usage (H2S)').closest('.animate-calc-tab-in') as HTMLElement;
    await user.click(within(hoursRow).getByRole('button', { name: 'Update profile' }));
    await waitFor(() => expect(capturedBodies).toContainEqual({ daily_usage_hours: 8 }));
  });

  it('reality check: a failed printer-profile update keeps the applied power override and shows an error toast', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state' ? JSON.stringify({ weight: '40', time: '2' }) : null,
    );
    server.use(
      http.get('/api/v1/calculator/insights', () =>
        HttpResponse.json({
          ...neutralInsights,
          power_by_printer: [{ printer_id: 1, printer_name: 'H2S', avg_watts: 500, sample: 20 }],
        }),
      ),
      http.patch('/api/v1/calculator/printers/:id', () =>
        HttpResponse.json({ detail: 'Could not update printer' }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();

    render(<CalculatorPage />);
    await screen.findByText('2 031 FCFP');
    await screen.findByText('Reality check');

    let row = screen.getByText('Power draw (H2S)').closest('.animate-calc-tab-in') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Apply' }));

    // The exact recomputed total with power_watts overridden to the measured
    // 500 W — positive proof the override is live before the failed save.
    const overriddenTotal = collapseSpaces(
      formatMoney(
        computePricing(
          referencePricingInputs,
          referencePricingFilament,
          { ...referencePricingPrinter, power_watts: 500 },
          referencePricingDefaults,
        ).total_ttc,
        'XPF',
      ),
    );
    await screen.findByText(overriddenTotal);
    row = screen.getByText('Power draw (H2S)').closest('.animate-calc-tab-in') as HTMLElement;
    expect(within(row).getByText('Applied')).toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Update profile' }));

    await screen.findByText('Could not update printer');
    // The session override survives the failed profile-update save — still
    // applied, still priced off the measured figure, not silently reverted.
    row = screen.getByText('Power draw (H2S)').closest('.animate-calc-tab-in') as HTMLElement;
    expect(within(row).getByText('Applied')).toBeInTheDocument();
    expect(screen.getByText(overriddenTotal)).toBeInTheDocument();
    expect(screen.queryByText('2 031 FCFP')).not.toBeInTheDocument();
  });

  it('reality check: a failed filament-cost profile update leaves the check in place and shows an error toast', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state' ? JSON.stringify({ weight: '40', time: '2' }) : null,
    );
    server.use(
      http.get('/api/v1/calculator/insights', () =>
        HttpResponse.json({
          ...neutralInsights,
          spool_cost_by_material: [{ material: 'PA6-CF', avg_cost_per_kg: 4500, sample: 12 }],
        }),
      ),
      http.patch('/api/v1/calculator/filaments/:id', () =>
        HttpResponse.json({ detail: 'Could not update filament' }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();

    render(<CalculatorPage />);
    await screen.findByText('2 031 FCFP');
    await screen.findByText('Reality check');

    const row = screen.getByText('Filament cost (PA6-CF)').closest('.animate-calc-tab-in') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Update profile' }));

    await screen.findByText('Could not update filament');
    // Spool cost has no session override to revert to — the invariant here
    // is that the check (and its retry button) is still there, not silently
    // dropped, after the failed save.
    const rowAfter = screen.getByText('Filament cost (PA6-CF)').closest('.animate-calc-tab-in') as HTMLElement;
    expect(within(rowAfter).getByRole('button', { name: 'Update profile' })).toBeInTheDocument();
  });

  it('easy mode: the time-correction chip applies the corrected time split and re-prices the job', async () => {
    // Gate: easyMode (showTimeChip) + timeFromEstimate true, both seeded via
    // the persisted state — typing into the time fields would itself clear
    // timeFromEstimate and un-gate the chip, so the reference case's 2 h
    // estimate is seeded as already "from a slicer" instead.
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state'
        ? JSON.stringify({ weight: '40', time: '2', easyMode: true, timeFromEstimate: true })
        : null,
    );
    server.use(
      http.get('/api/v1/calculator/insights', () =>
        HttpResponse.json({
          ...neutralInsights,
          // 120% vs the assumed 100% is a 20-point drift, well past the 2%
          // gate; by_printer empty falls through to the overall figure.
          time_accuracy: { overall_pct: timeCorrectionAccuracyPct, sample: 10, by_printer: [] },
        }),
      ),
    );
    const user = userEvent.setup();

    render(<CalculatorPage />);
    await screen.findByText('2 031 FCFP');

    // Baseline fields before any correction — the reference case's 2 h.
    expect(screen.getByLabelText('Hours')).toHaveValue(2);
    expect(screen.getByLabelText('Minutes')).toHaveValue(null);

    // The chip is up with the measured-accuracy hint text.
    expect(screen.getByText('Your printers average 120% of slicer estimates')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Apply corrected time' }));

    // Fields updated to the exact corrected split (derived from the real
    // correctedTimeH/splitDecimalHours helpers, not a hand-typed literal).
    await waitFor(() => {
      expect(screen.getByLabelText('Hours')).toHaveValue(num(timeCorrectionSplit.timeH) || null);
    });
    expect(screen.getByLabelText('Minutes')).toHaveValue(num(timeCorrectionSplit.timeM) || null);
    expect(screen.getByLabelText('Days')).toHaveValue(num(timeCorrectionSplit.timeD) || null);

    // Total recomputes to the exact value computePricing predicts for the
    // corrected time.
    await screen.findByText(timeCorrectionTotal);
    expect(screen.queryByText('2 031 FCFP')).not.toBeInTheDocument();

    // Applying clears timeFromEstimate, so the chip is gone even though the
    // drift condition alone would still be satisfied.
    expect(screen.queryByRole('button', { name: 'Apply corrected time' })).not.toBeInTheDocument();
  });

  it('easy mode: dismissing the time-correction chip hides it and leaves the time fields unchanged', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state'
        ? JSON.stringify({ weight: '40', time: '2', easyMode: true, timeFromEstimate: true })
        : null,
    );
    server.use(
      http.get('/api/v1/calculator/insights', () =>
        HttpResponse.json({
          ...neutralInsights,
          time_accuracy: { overall_pct: timeCorrectionAccuracyPct, sample: 10, by_printer: [] },
        }),
      ),
    );
    const user = userEvent.setup();

    render(<CalculatorPage />);
    await screen.findByText('2 031 FCFP');
    // Positive evidence the chip rendered before we dismiss it.
    await screen.findByText('Your printers average 120% of slicer estimates');

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    // Positive evidence the card itself is still there (not merely gone as
    // a side effect of an unmount), then assert the chip's absence.
    expect(screen.getByLabelText('Hours')).toHaveValue(2);
    expect(screen.queryByText('Your printers average 120% of slicer estimates')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply corrected time' })).not.toBeInTheDocument();

    // The time fields are untouched — dismiss only clears timeFromEstimate,
    // it never rewrites the split.
    expect(screen.getByLabelText('Hours')).toHaveValue(2);
    expect(screen.getByLabelText('Minutes')).toHaveValue(null);
    expect(screen.getByLabelText('Days')).toHaveValue(null);
    // The total is still the untouched reference-case total.
    expect(screen.getByText('2 031 FCFP')).toBeInTheDocument();
  });

  it('easy mode: the time-correction chip stays hidden when the measured drift is below the 2% threshold', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state'
        ? JSON.stringify({ weight: '40', time: '2', easyMode: true, timeFromEstimate: true })
        : null,
    );
    server.use(
      http.get('/api/v1/calculator/insights', () =>
        HttpResponse.json({
          ...neutralInsights,
          // 101% vs 100% is only a 1-point drift — below the 2% gate.
          time_accuracy: { overall_pct: 101, sample: 10, by_printer: [] },
        }),
      ),
    );

    render(<CalculatorPage />);
    await screen.findByText('2 031 FCFP');
    // Positive evidence the inputs card (and its time fields) rendered
    // before asserting the chip's absence.
    expect(screen.getByLabelText('Hours')).toHaveValue(2);

    expect(screen.queryByRole('button', { name: 'Apply corrected time' })).not.toBeInTheDocument();
    expect(screen.queryByText(/of slicer estimates/)).not.toBeInTheDocument();
  });

  it('reality check card stays hidden without insights data', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state' ? JSON.stringify({ weight: '40', time: '2' }) : null,
    );
    render(<CalculatorPage />);
    await screen.findByText('2 031 FCFP');
    expect(screen.queryByText('Reality check')).not.toBeInTheDocument();
  });

  it('hides the printer comparison when only one printer is configured', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state' ? JSON.stringify({ weight: '40', time: '2' }) : null,
    );

    render(<CalculatorPage />);
    await screen.findByText('2 031 FCFP');

    expect(screen.queryByRole('group', { name: 'Price by printer' })).not.toBeInTheDocument();
  });

  it('migrates a saved legacy decimal-hours value into hours + minutes fields', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state' ? JSON.stringify({ weight: '40', time: '2.5' }) : null,
    );

    render(<CalculatorPage />);

    expect(await screen.findByLabelText('Hours')).toHaveValue(2);
    expect(screen.getByLabelText('Minutes')).toHaveValue(30);
  });

  it('formats amounts in the currency from app settings', async () => {
    useCalculatorHandlers({ currency: 'USD' });
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state' ? JSON.stringify({ weight: '40', time: '2' }) : null,
    );

    render(<CalculatorPage />);

    // Same reference case as above, rendered as USD: prefixed symbol, two decimals
    await screen.findByText('$2 031.44');
    expect(screen.queryByText(/FCFP/)).not.toBeInTheDocument();
  });

  it('shows the discount and bulk tables in full mode', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state' ? JSON.stringify({ weight: '40', time: '2' }) : null,
    );

    render(<CalculatorPage />);

    await screen.findByText('Discount calculation');
    expect(screen.getByText('Bulk pricing')).toBeInTheDocument();
    expect(screen.getByText('Cost breakdown')).toBeInTheDocument();
    expect(screen.getByText('Potential profit')).toBeInTheDocument();
    // Break-even on the pre-tax price = the margin fraction (all margins at the end)
    expect(screen.getByText(/Break-even discount: 38\.1%/)).toBeInTheDocument();
  });

  it('easy mode hides breakdown, bulk table and profit rows but keeps discounted prices', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state'
        ? JSON.stringify({ weight: '40', time: '2', easyMode: true })
        : null,
    );

    render(<CalculatorPage />);

    await screen.findByText('2 031 FCFP');
    expect(screen.queryByText('Cost breakdown')).not.toBeInTheDocument();
    expect(screen.queryByText('Bulk pricing')).not.toBeInTheDocument();
    expect(screen.queryByText('Potential profit')).not.toBeInTheDocument();
    expect(screen.getByText('Price w/ discount')).toBeInTheDocument();
  });

  it('recomputes live when inputs change (hours + minutes)', async () => {
    const user = userEvent.setup();
    render(<CalculatorPage />);

    const weight = await screen.findByLabelText('Object weight');
    const hours = screen.getByLabelText('Hours');
    const minutes = screen.getByLabelText('Minutes');
    await user.type(weight, '40');
    await user.type(hours, '1');
    await user.type(minutes, '60'); // 1 h + 60 min = the 2 h reference case

    // 2s timeout: three typed fields under a fully parallel suite run can
    // outlast the default 1s (same allowance as the localStorage test below).
    await waitFor(
      () => {
        expect(screen.getByText('2 031 FCFP')).toBeInTheDocument();
      },
      { timeout: 2000 },
    );
  });

  it('validates quantity ≥ 1 and dims results behind an alert', async () => {
    const user = userEvent.setup();
    render(<CalculatorPage />);

    const quantity = await screen.findByLabelText('Quantity');
    await user.clear(quantity);
    await user.type(quantity, '0');

    await screen.findByText('Must be at least 1');
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('shows an enter-inputs hint instead of a price when weight and time are empty', async () => {
    render(<CalculatorPage />);

    await screen.findByText('Enter weight and print time');
    expect(screen.queryByText('Discount calculation')).not.toBeInTheDocument();
    expect(screen.queryByText('Totals')).not.toBeInTheDocument();
  });

  it('target price section reports the implied net margin', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state' ? JSON.stringify({ weight: '40', time: '2' }) : null,
    );
    const user = userEvent.setup();
    render(<CalculatorPage />);

    await screen.findByText('2 031 FCFP');
    await user.click(screen.getByText('Target price'));
    // 2260 TTC → net 2000 → profit 887.32 over costs 1112.68 (margin 44.4%)
    await user.type(screen.getByLabelText('Target price (incl. tax)'), '2260');
    expect(await screen.findByText('887 FCFP')).toBeInTheDocument();
    expect(screen.getByText('(44.4%)')).toBeInTheDocument();

    // Below costs → negative profit
    await user.clear(screen.getByLabelText('Target price (incl. tax)'));
    await user.type(screen.getByLabelText('Target price (incl. tax)'), '1130');
    expect(await screen.findByText('-113 FCFP')).toBeInTheDocument();
  });

  it('typing labor and stuff costs in each Labor collapsible recomputes the total by the exact predicted amount', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state' ? JSON.stringify({ weight: '40', time: '2' }) : null,
    );
    const user = userEvent.setup();
    render(<CalculatorPage />);
    await screen.findByText('2 031 FCFP');

    // "Modeling" etc. also label a line in the Cost breakdown card, so all
    // clicks/queries for the Labor card's own controls are scoped to it.
    const laborCard = screen.getByRole('heading', { name: 'Labor', level: 2 }).closest('.bg-bambu-dark-secondary') as HTMLElement;
    const labor = within(laborCard);

    const priceFor = (inputs: typeof referencePricingInputs) =>
      collapseSpaces(
        formatMoney(
          computePricing(inputs, referencePricingFilament, referencePricingPrinter, referencePricingDefaults)
            .total_ttc,
          'XPF',
        ),
      );

    // ── Modeling ──────────────────────────────────────────────────────
    await user.click(labor.getByText('Modeling'));
    await user.type(labor.getByLabelText('Working hours'), '1');
    await user.type(labor.getByLabelText('Base price'), '500');
    const stage1Inputs = { ...referencePricingInputs, modeling_hours: 1, modeling_base_price: 500 };
    const stage1Total = priceFor(stage1Inputs);
    await screen.findByText(stage1Total);
    expect(screen.queryByText('2 031 FCFP')).not.toBeInTheDocument();

    // ── Preparation ───────────────────────────────────────────────────
    await user.click(labor.getByText('Preparation'));
    await user.type(labor.getByLabelText('Model preparation'), '10');
    await user.type(labor.getByLabelText('Slicing'), '5');
    await user.type(labor.getByLabelText('Transfer & start'), '2');
    const stage2Inputs = { ...stage1Inputs, prep_model_min: 10, prep_slicing_min: 5, prep_transfer_min: 2 };
    const stage2Total = priceFor(stage2Inputs);
    await screen.findByText(stage2Total);
    expect(screen.queryByText(stage1Total)).not.toBeInTheDocument();

    // ── Post-processing ───────────────────────────────────────────────
    await user.click(labor.getByText('Post-processing'));
    await user.type(labor.getByLabelText('Job removal'), '3');
    await user.type(labor.getByLabelText('Support removal'), '4');
    await user.type(labor.getByLabelText('Additional work'), '1');
    await user.type(labor.getByLabelText('Fulfillment'), '2');
    const stage3Inputs = {
      ...stage2Inputs,
      post_removal_min: 3,
      post_support_min: 4,
      post_additional_min: 1,
      post_fulfillment_min: 2,
    };
    const stage3Total = priceFor(stage3Inputs);
    await screen.findByText(stage3Total);
    expect(screen.queryByText(stage2Total)).not.toBeInTheDocument();

    // ── Stuff (extras & supplies) ────────────────────────────────────
    await user.click(labor.getByText('Extras & supplies'));
    await user.type(labor.getByLabelText('Amount'), '100');
    await user.type(labor.getByLabelText('Markup'), '25');
    const stage4Inputs = { ...stage3Inputs, stuff_amount: 100, stuff_markup_pct: 25 };
    const stage4Total = priceFor(stage4Inputs);
    await screen.findByText(stage4Total);
    expect(screen.queryByText(stage3Total)).not.toBeInTheDocument();
  });

  it('shows the labor amortization hint once modeling costs are split across multiple units', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state' ? JSON.stringify({ weight: '40', time: '2' }) : null,
    );
    const user = userEvent.setup();
    render(<CalculatorPage />);
    await screen.findByText('2 031 FCFP');
    // Quantity 1, no modeling/prep cost yet — hint absent.
    expect(screen.queryByText(/one-time costs, split across/)).not.toBeInTheDocument();

    const laborCard = screen.getByRole('heading', { name: 'Labor', level: 2 }).closest('.bg-bambu-dark-secondary') as HTMLElement;
    const labor = within(laborCard);

    await user.click(screen.getByRole('button', { name: 'Increase quantity' }));
    await user.click(labor.getByText('Modeling'));
    await user.type(labor.getByLabelText('Working hours'), '1');

    // Positive evidence: the exact interpolated hint text for 2 units.
    await screen.findByText('Modeling & preparation are one-time costs, split across 2 units.');
  });

  it('prefills measured energy from the URL and clears it via the chip', async () => {
    window.history.pushState({}, '', '/calculator?weight=15.5&time=1.25&energyKwh=0.5');
    try {
      const user = userEvent.setup();
      render(<CalculatorPage />);

      await screen.findByText('Measured energy: 0.5 kWh (from archive)');
      await waitFor(() => {
        expect(window.location.search).toBe('');
      });

      await user.click(screen.getByRole('button', { name: 'Clear measured energy' }));
      expect(screen.queryByText(/Measured energy/)).not.toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('quantity stepper buttons adjust the value and clamp at 1', async () => {
    const user = userEvent.setup();
    render(<CalculatorPage />);

    const quantity = await screen.findByLabelText('Quantity');
    expect(quantity).toHaveValue(1);

    const inc = screen.getByRole('button', { name: 'Increase quantity' });
    const dec = screen.getByRole('button', { name: 'Decrease quantity' });
    expect(dec).toBeDisabled(); // already at the minimum

    await user.click(inc);
    expect(quantity).toHaveValue(2);
    await user.click(dec);
    expect(quantity).toHaveValue(1);
  });

  it('shows the empty-state call to action when no filament exists', async () => {
    useCalculatorHandlers({ filaments: [] });

    render(<CalculatorPage />);

    await screen.findByText('Set up your calculator');
    expect(screen.getByRole('button', { name: /Open calculator settings/ })).toBeInTheDocument();
  });

  it('filament dropdown is searchable and switching filament recomputes', async () => {
    useCalculatorHandlers({
      filaments: [
        ...mockFilaments,
        {
          id: 2,
          name: 'Generic PLA',
          brand: 'Generic',
          material: 'PLA',
          cost_per_kg: 2000,
          sale_price_per_kg: 3000,
          margin_pct: 50,
          difficulty_pct: 100,
          zoho_item_id: null,
          zoho_item_name: null,
          zoho_sku: null,
          spool_weight_kg: null,
          zoho_synced_at: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    });
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state' ? JSON.stringify({ weight: '40', time: '2' }) : null,
    );
    const user = userEvent.setup();

    render(<CalculatorPage />);
    await screen.findByText('2 031 FCFP'); // Sunlu PA6-CF selected by default

    const combo = screen.getByLabelText('Filament');
    await user.click(combo);
    // Both options listed when the search is empty
    expect(screen.getByRole('option', { name: 'Sunlu PA6-CF' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Generic PLA' })).toBeInTheDocument();

    // Typing filters the list
    await user.type(combo, 'PLA');
    expect(screen.queryByRole('option', { name: 'Sunlu PA6-CF' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('option', { name: 'Generic PLA' }));
    await waitFor(
      () => {
        expect(screen.getByText('1 310 FCFP')).toBeInTheDocument(); // PLA at 100% difficulty
      },
      { timeout: 2000 },
    );
  });

  it('prefills weight/time/quantity/printer from URL params and strips them, keeping labor fields', async () => {
    useCalculatorHandlers({
      printers: [
        ...mockPrinters,
        {
          id: 2,
          name: 'A1 Mini',
          purchase_price: 40000,
          lifetime_years: 2,
          daily_usage_hours: 5,
          power_watts: 150,
          repair_rate_pct: 30,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    });
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state' ? JSON.stringify({ weight: '99', time: '9', modelingHours: '3' }) : null,
    );
    window.history.pushState({}, '', '/calculator?weight=15.5&time=1.25&quantity=2&filamentId=1&printerId=2');

    try {
      render(<CalculatorPage />);

      const weight = await screen.findByLabelText('Object weight');
      expect(weight).toHaveValue(15.5);
      // Decimal hours from the URL are split into hour + minute fields
      expect(screen.getByLabelText('Hours')).toHaveValue(1);
      expect(screen.getByLabelText('Minutes')).toHaveValue(15);
      expect(screen.getByLabelText('Quantity')).toHaveValue(2);
      // The printer from the URL is selected instead of the default first one
      expect(screen.getByLabelText('Printer')).toHaveValue('A1 Mini');
      // Labor fields from the saved state survive the prefill
      expect(screen.getByLabelText('Working hours')).toHaveValue(3);
      // Params are consumed and removed from the URL
      await waitFor(() => {
        expect(window.location.search).toBe('');
      });
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('ignores invalid URL prefill values', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state' ? JSON.stringify({ weight: '40', time: '2' }) : null,
    );
    window.history.pushState({}, '', '/calculator?weight=-5&time=abc&quantity=0');

    try {
      render(<CalculatorPage />);

      const weight = await screen.findByLabelText('Object weight');
      expect(weight).toHaveValue(40);
      // Saved legacy time '2' survives the invalid prefill, migrated to hours
      expect(screen.getByLabelText('Hours')).toHaveValue(2);
      await waitFor(() => {
        expect(window.location.search).toBe('');
      });
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('filaments tab lists filaments with search, material/brand filters and sorting', async () => {
    const plaFilament = {
      id: 2,
      name: 'Generic PLA',
      brand: 'Generic',
      material: 'PLA',
      cost_per_kg: 2000,
      sale_price_per_kg: 3000,
      margin_pct: 50,
      difficulty_pct: 100,
      zoho_item_id: null,
      zoho_item_name: null,
      zoho_sku: null,
      spool_weight_kg: null,
      zoho_synced_at: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    useCalculatorHandlers({ filaments: [...mockFilaments, plaFilament] });
    const user = userEvent.setup();

    render(<CalculatorPage />);
    await user.click(await screen.findByRole('tab', { name: 'Filaments' }));

    // Both filaments listed in the table
    await screen.findByRole('button', { name: 'Add filament' });
    expect(screen.getByRole('cell', { name: 'PA6-CF' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'PLA' })).toBeInTheDocument();

    // Material filter narrows the list
    await user.selectOptions(screen.getByLabelText('Material'), 'PLA');
    expect(screen.queryByRole('cell', { name: 'PA6-CF' })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Material'), '');

    // Brand filter narrows the list
    await user.selectOptions(screen.getByLabelText('Brand'), 'Sunlu');
    expect(screen.queryByRole('cell', { name: 'PLA' })).not.toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'PA6-CF' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Brand'), '');

    // Search matches the combined brand + material name
    await user.type(screen.getByLabelText('Search'), 'sunlu');
    expect(screen.queryByRole('cell', { name: 'PLA' })).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText('Search'));

    // Sorting by cost: ascending puts the cheaper PLA first, toggling reverses
    const costHeader = screen.getByRole('button', { name: /Cost per kg/ });
    await user.click(costHeader);
    let rows = screen.getAllByRole('row').slice(1); // skip header row
    expect(rows[0]).toHaveTextContent('PLA');
    await user.click(costHeader);
    rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('PA6-CF');
  });

  it('printers tab lists printers and opens the ?tab= URL param directly', async () => {
    window.history.pushState({}, '', '/calculator?tab=printers');
    try {
      render(<CalculatorPage />);

      await screen.findByRole('button', { name: 'Add printer' });
      expect(await screen.findByRole('cell', { name: /H2S/ })).toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('switching tabs is reflected in the URL so refresh keeps the tab', async () => {
    const user = userEvent.setup();
    render(<CalculatorPage />);

    await user.click(await screen.findByRole('tab', { name: 'Printers' }));
    expect(window.location.search).toBe('?tab=printers');
    expect(screen.getByRole('tab', { name: 'Printers' })).toHaveAttribute('aria-selected', 'true');

    // Back to the calculator tab → clean URL again
    await user.click(screen.getByRole('tab', { name: 'Calculator' }));
    expect(window.location.search).toBe('');
  });

  it('empty-state button jumps to the filaments tab', async () => {
    useCalculatorHandlers({ filaments: [] });
    const user = userEvent.setup();

    render(<CalculatorPage />);

    await user.click(await screen.findByRole('button', { name: /Open calculator settings/ }));
    await screen.findByRole('button', { name: 'Add filament' });
  });

  it('editing global defaults changes the calculator tab totals', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state' ? JSON.stringify({ weight: '40', time: '2' }) : null,
    );
    let defaults = { ...mockDefaults };
    server.use(
      http.get('/api/v1/calculator/defaults', () => HttpResponse.json(defaults)),
      http.patch('/api/v1/calculator/defaults', async ({ request }) => {
        const body = (await request.json()) as Record<string, number>;
        defaults = { ...defaults, ...body, updated_at: '2026-01-02T00:00:00Z' };
        return HttpResponse.json(defaults);
      }),
    );
    const user = userEvent.setup();

    render(<CalculatorPage />);
    // Positive evidence of the pre-save reference total before asserting a change.
    await screen.findByText('2 031 FCFP');

    await user.click(screen.getByRole('tab', { name: 'Defaults' }));
    const tariff = await screen.findByLabelText(/Electricity tariff/);
    await user.clear(tariff);
    await user.type(tariff, '5000');
    await user.click(screen.getByRole('button', { name: 'Save defaults' }));
    await screen.findByText('Defaults saved');

    await user.click(screen.getByRole('tab', { name: 'Calculator' }));
    // Positive proof: the recomputed total matches computePricing() with the
    // new electricity_tariff applied, not merely "the old total is gone".
    await screen.findByText(tariffUpdateTotal);
    // Secondary sanity check: the stale total must also be gone.
    expect(screen.queryByText('2 031 FCFP')).not.toBeInTheDocument();
  });

  it('persists inputs to localStorage (debounced)', async () => {
    const user = userEvent.setup();
    render(<CalculatorPage />);

    const weight = await screen.findByLabelText('Object weight');
    await user.type(weight, '40');

    await waitFor(
      () => {
        const calls = vi.mocked(localStorage.setItem).mock.calls.filter(([k]) => k === 'calculator-state');
        expect(calls.length).toBeGreaterThan(0);
        expect(JSON.parse(calls[calls.length - 1][1]).weight).toBe('40');
      },
      { timeout: 2000 },
    );
  });

  // navigator.clipboard is a global; stub-and-restore around each test so a
  // leaked stub can't affect later tests in this file (or other files run
  // in the same worker).
  describe('totals card — copy summary button', () => {
    let originalClipboard: PropertyDescriptor | undefined;

    beforeEach(() => {
      originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
      vi.mocked(localStorage.getItem).mockImplementation((key) =>
        key === 'calculator-state' ? JSON.stringify({ weight: '40', time: '2' }) : null,
      );
    });

    afterEach(() => {
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', originalClipboard);
      } else {
        delete (navigator as { clipboard?: unknown }).clipboard;
      }
    });

    it('writes the job summary to the clipboard and shows a success toast', async () => {
      // userEvent.setup() installs its own clipboard stub on the view, which
      // would clobber ours if defined first — so the stub must be set up
      // *after* setup(), matching VirtualPrinterCard.test.tsx / PrinterInfoModal.test.tsx.
      const user = userEvent.setup();
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: writeTextMock },
        configurable: true,
      });

      render(<CalculatorPage />);
      await screen.findByText('2 031 FCFP');

      await user.click(screen.getByRole('button', { name: 'Copy summary' }));

      await waitFor(() => {
        expect(writeTextMock).toHaveBeenCalledWith(expectedSummaryText);
      });
      await screen.findByText('Summary copied to clipboard');
    });

    it('shows an error toast when the clipboard write is rejected', async () => {
      const user = userEvent.setup();
      const writeTextMock = vi.fn().mockRejectedValue(new Error('permission denied'));
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: writeTextMock },
        configurable: true,
      });

      render(<CalculatorPage />);
      await screen.findByText('2 031 FCFP');

      await user.click(screen.getByRole('button', { name: 'Copy summary' }));

      // Positive proof the real summary was attempted (not a vacuous reject).
      await waitFor(() => {
        expect(writeTextMock).toHaveBeenCalledWith(expectedSummaryText);
      });
      await screen.findByText('Copy failed — your browser blocked clipboard access');
      expect(screen.queryByText('Summary copied to clipboard')).not.toBeInTheDocument();
    });
  });
});
