import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen } from '../../utils';
import { server } from '../../mocks/server';
import { CostBreakdownWidget } from '../../../components/stats/CostBreakdownWidget';
import type { ArchiveSlim } from '../../../api/client';

const archive = {
  id: 1,
  printer_id: 1,
  print_name: 'Benchy',
  print_time_seconds: 7200,
  actual_time_seconds: 7200,
  filament_used_grams: 100,
  filament_type: 'PLA',
  filament_color: null,
  status: 'completed',
  started_at: '2024-06-15T06:00:00Z',
  completed_at: '2024-06-15T08:00:00Z',
  cost: null,
  quantity: 1,
  created_at: '2024-06-15T08:00:00Z',
} as ArchiveSlim;

const filaments = [{
  id: 1,
  name: 'Generic PLA',
  brand: 'Generic',
  material: 'PLA',
  cost_per_kg: 20,
  sale_price_per_kg: 25,
  difficulty_pct: 100,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
}];

const printers = [{
  id: 1,
  name: 'X1C',
  purchase_price: 1200,
  lifetime_years: 3,
  daily_usage_hours: 8,
  power_watts: 100,
  repair_rate_pct: 5,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
}];

const defaults = {
  id: 1,
  electricity_tariff: 0.3,
  labor_rate_per_hour: 0,
  consumables_packaging_flat: 0,
  failure_rate_pct: 0,
  prototype_rate_pct: 0,
  ads_rate_pct: 0,
  filament_markup_pct: 0,
  global_markup_pct: 0,
  tax_pct: 0,
  default_difficulty_pct: 100,
  default_margin_over_cost_pct: 0,
  stuff_markup_pct: 0,
  updated_at: '2024-01-01T00:00:00Z',
};

describe('CostBreakdownWidget', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/v1/calculator/filaments/', () => HttpResponse.json(filaments)),
      http.get('/api/v1/calculator/printers/', () => HttpResponse.json(printers)),
      http.get('/api/v1/calculator/defaults', () => HttpResponse.json(defaults)),
    );
  });

  it('prices archives and shows segment breakdown with coverage', async () => {
    render(
      <CostBreakdownWidget
        archives={[archive]}
        printerMap={new Map([['1', 'X1C']])}
        currency="€"
      />,
    );

    expect(await screen.findByText('1 of 1 prints priced')).toBeInTheDocument();
    // Filament line: 100g × €25/kg = €2.50
    expect(screen.getByText('€ 2.50')).toBeInTheDocument();
    // Energy line: 0.1kW × 2h × €0.30 = €0.06
    expect(screen.getByText('€ 0.06')).toBeInTheDocument();
    expect(screen.getByText('Per print hour')).toBeInTheDocument();
    expect(screen.getByText('Per kg')).toBeInTheDocument();
  });

  it('shows the empty state when the calculator is unconfigured', async () => {
    server.use(
      http.get('/api/v1/calculator/filaments/', () => HttpResponse.json([])),
      http.get('/api/v1/calculator/printers/', () => HttpResponse.json([])),
    );
    render(
      <CostBreakdownWidget archives={[archive]} printerMap={new Map()} currency="€" />,
    );
    expect(
      await screen.findByText('No prints could be priced with the current calculator setup'),
    ).toBeInTheDocument();
  });
});
