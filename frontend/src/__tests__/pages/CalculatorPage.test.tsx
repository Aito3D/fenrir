/**
 * Tests for the CalculatorPage component.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { CalculatorPage } from '../../pages/CalculatorPage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const mockFilaments = [
  {
    id: 1,
    name: 'Sunlu PA6-CF',
    brand: 'Sunlu',
    material: 'PA6-CF',
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
    // Provisions shrink (30% → 8% failure provision), so the total drops.
    await waitFor(() => expect(screen.queryByText('2 031 FCFP')).not.toBeInTheDocument());
    expect(screen.getByText('Applied')).toBeInTheDocument();
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
    await screen.findByText('$2 031.48');
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
          difficulty_pct: 100,
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
      difficulty_pct: 100,
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
    await waitFor(() => {
      expect(screen.queryByText('2 031 FCFP')).not.toBeInTheDocument();
    });
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
});
