/**
 * Smoke tests for the printable quote page: re-reads the calculator's
 * persisted state and renders a client-facing document.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils';
import { CalculatorQuotePage } from '../../pages/CalculatorQuotePage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const mockFilaments = [
  {
    id: 1,
    name: 'Generic PLA',
    brand: 'Generic',
    material: 'PLA',
    cost_per_kg: 3731,
    sale_price_per_kg: 5597,
    difficulty_pct: 150,
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

  it('renders the persisted job as a quote with the reference total', async () => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'calculator-state' ? JSON.stringify({ weight: '40', timeH: '2', timeM: '' }) : null,
    );

    render(<CalculatorQuotePage />);

    expect(await screen.findByText('Quote')).toBeInTheDocument();
    // Same reference case as the calculator page tests: 2 031 FCFP TTC —
    // shown twice: the headline total and the breakdown's total row.
    expect(await screen.findAllByText('2 031 FCFP')).toHaveLength(2);
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
  });

  it('shows the empty hint when no job is stored', async () => {
    vi.mocked(localStorage.getItem).mockImplementation(() => null);
    render(<CalculatorQuotePage />);
    expect(await screen.findByText('No job to quote yet — fill in the calculator first.')).toBeInTheDocument();
  });
});
