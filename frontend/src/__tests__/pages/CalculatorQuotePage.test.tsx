/**
 * Smoke tests for the printable quote page: re-reads the calculator's
 * persisted state and renders a client-facing document.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils';
import { CalculatorQuotePage } from '../../pages/CalculatorQuotePage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import i18n from '../../i18n';
import { computePricing, formatMoney } from '../../utils/pricing';

const mockFilaments = [
  {
    id: 1,
    name: 'Generic PLA',
    brand: 'Generic',
    material: 'PLA',
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
  margin_min_mult: 1.15,
  margin_max_mult: 1.6,
  margin_k: 33,
  qty_min_factor: 0.4,
  qty_k: 5,
  min_task_price: 12,
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

describe('CalculatorQuotePage', () => {
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockReset();
    server.use(
      http.get('/api/v1/calculator/filaments/', () => HttpResponse.json(mockFilaments)),
      http.get('/api/v1/calculator/printers/', () => HttpResponse.json(mockPrinters)),
      http.get('/api/v1/calculator/defaults', () => HttpResponse.json(mockDefaults)),
      http.get('/api/v1/settings/', () => HttpResponse.json({ currency: 'XPF' })),
      http.get('/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: false, requires_setup: false })),
    );
  });

  afterEach(() => {
    // Only the pinned-date test below moves the clock; restore real time so
    // it can never leak into a sibling test in this file (or the next file
    // in the same worker).
    vi.useRealTimers();
  });

  it('renders the persisted job as a quote with the reference total', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state' ? JSON.stringify({ weight: '40', timeH: '2', timeM: '' }) : null,
    );

    // Pin the clock (no vi.useFakeTimers() — that also fakes the timers
    // RTL's findBy* polls with and can hang the awaits below) to a fixed
    // instant so the header's "date of quote" line is deterministic instead
    // of drifting with the day the suite happens to run.
    const pinned = new Date('2026-03-15T12:00:00Z');
    vi.setSystemTime(pinned);

    render(<CalculatorQuotePage />);

    expect(await screen.findByText('Quote')).toBeInTheDocument();
    // Same reference case as the calculator page tests: 1 608 FCFP TTC —
    // shown twice: the headline total and the breakdown's total row.
    expect(await screen.findAllByText('1 608 FCFP')).toHaveLength(2);
    expect(screen.getByText('Generic PLA')).toBeInTheDocument();
    // Selected printer appears in the job details.
    expect(screen.getByText('H2S')).toBeInTheDocument();
    // Cost breakdown replaces the old volume-pricing table: waterfall lines
    // and no discount grid. "Filament" appears twice — job-details label and
    // the breakdown's first cost row.
    expect(screen.getByText('Cost breakdown')).toBeInTheDocument();
    expect(screen.getAllByText('Filament')).toHaveLength(2);
    expect(screen.queryByText('Volume pricing')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Print/ })).toBeInTheDocument();
    // Date-of-quote line: rendered in the app language (i18n.language), not
    // hardcoded, since a formatted string is machine/ICU-dependent — only
    // the underlying date is pinned by this test.
    expect(screen.getByText(pinned.toLocaleDateString(i18n.language))).toBeInTheDocument();
  });

  // Shared shape for the pricing-engine inputs the two tests below build —
  // only weight/time/quantity vary between them.
  const quoteFixtureInputs = (weight_g: number, printing_time_h: number, quantity: number) => ({
    weight_g,
    printing_time_h,
    quantity,
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
    // No stuffMarkup override in state, so buildPricingInputs falls back to
    // defaults.stuff_markup_pct (mockDefaults: 20).
    stuff_markup_pct: 20,
  });

  it('derives the unit price from the rounded task total, not the raw per-unit total', async () => {
    // Fixture chosen (via a throwaway scratch script scanning quantities
    // 3/6/7/9 across small weight/time tweaks) so the task total does NOT
    // divide evenly into the quantity at 2 dp: weight 15.5 g, time 1 h 15 m
    // (1.25 h), qty 6, Generic PLA / H2S / mockDefaults →
    //   total_ttc     = 839.0752273965487   (the old per-unit-first figure)
    //   total_ttc_qty = 5034.4513643792925  (= total_ttc × 6)
    //   taskRounded   = round(total_ttc_qty × 100) / 100 = 5034.45
    //   taskRounded / 6 = 839.075 → "$839.07" (NEW: task-first)
    //   formatMoney(total_ttc, 'USD') = "$839.08" (OLD: per-unit-first)
    // The two disagree by a cent, which is exactly what makes this fixture
    // discriminate the old implementation from the new one.
    server.use(http.get('/api/v1/settings/', () => HttpResponse.json({ currency: 'USD' })));
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state'
        ? JSON.stringify({ weight: '15.5', timeH: '1', timeM: '15', quantity: '6' })
        : null,
    );

    render(<CalculatorQuotePage />);
    await screen.findByText(/Total for 6 units/);

    const result = computePricing(quoteFixtureInputs(15.5, 1.25, 6), mockFilaments[0], mockPrinters[0], mockDefaults);
    const taskRounded = Math.round(result.total_ttc_qty * 100) / 100;

    // The task figure is the rounded TASK total, first.
    expect(screen.getByTestId('quote-task-ttc').textContent).toBe(formatMoney(taskRounded, 'USD'));
    // The unit figure is derived from that ROUNDED task, not from
    // result.total_ttc directly — this is what the old implementation got
    // wrong and this fixture catches.
    expect(screen.getByTestId('quote-unit-ttc').textContent).toBe(formatMoney(taskRounded / 6, 'USD'));
    expect(screen.getByTestId('quote-unit-ttc').textContent).not.toBe(formatMoney(result.total_ttc, 'USD'));

    // Bounded residual: rounding the unit price for display can leave at
    // most one display unit (one cent) of drift per unit sold.
    const money = (s: string) => Number(s.replace(/[^\d.-]/g, ''));
    const unit = money(screen.getByTestId('quote-unit-ttc').textContent!);
    const total = money(screen.getByTestId('quote-task-ttc').textContent!);
    expect(Math.abs(unit * 6 - total)).toBeLessThanOrEqual(0.01 * 6);
  });

  it('derives the unit price from the rounded task total for a zero-decimal currency', async () => {
    // Same reference case as the first test in this file (weight 40 g, 2 h),
    // at quantity 3, rendered in XPF (0-decimal currency).
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state' ? JSON.stringify({ weight: '40', timeH: '2', timeM: '', quantity: '3' }) : null,
    );

    render(<CalculatorQuotePage />);
    await screen.findByText(/Total for 3 units/);

    const result = computePricing(quoteFixtureInputs(40, 2, 3), mockFilaments[0], mockPrinters[0], mockDefaults);
    const taskRounded = Math.round(result.total_ttc_qty);

    expect(screen.getByTestId('quote-task-ttc').textContent).toBe(formatMoney(taskRounded, 'XPF'));
    expect(screen.getByTestId('quote-unit-ttc').textContent).toBe(formatMoney(taskRounded / 3, 'XPF'));

    // Bounded residual: at most one whole unit (this currency has no
    // fractional display unit) of drift per unit sold.
    const money = (s: string) => Number(s.replace(/[^\d.-]/g, ''));
    const unit = money(screen.getByTestId('quote-unit-ttc').textContent!);
    const total = money(screen.getByTestId('quote-task-ttc').textContent!);
    expect(Math.abs(unit * 3 - total)).toBeLessThanOrEqual(1 * 3);
  });

  it('shows the empty hint when no job is stored', async () => {
    vi.mocked(localStorage.getItem).mockImplementation(() => null);
    render(<CalculatorQuotePage />);
    expect(await screen.findByText('No job to quote yet — fill in the calculator first.')).toBeInTheDocument();
  });
});
