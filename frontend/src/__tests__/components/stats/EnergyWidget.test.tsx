import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen } from '../../utils';
import { server } from '../../mocks/server';
import { EnergyWidget } from '../../../components/stats/EnergyWidget';

const populated = {
  bucket: 'day',
  total_kwh: 3.5,
  total_cost: 0.53,
  cost_per_kwh: 0.15,
  buckets: [
    { period: '2024-06-14', kwh: 1.5 },
    { period: '2024-06-15', kwh: 2.0 },
  ],
  plugs: [
    { plug_id: 1, plug_name: 'X1C Plug', printer_id: 1, total_kwh: 3.5, buckets: [] },
  ],
  warming_up: false,
};

describe('EnergyWidget', () => {
  it('renders totals from the energy history', async () => {
    server.use(
      http.get('/api/v1/smart-plugs/energy/history', () => HttpResponse.json(populated)),
    );
    render(<EnergyWidget dateFrom="2024-06-14" dateTo="2024-06-15" currency="€" totalPrints={7} />);

    expect(await screen.findByText('3.50 kWh')).toBeInTheDocument();
    expect(screen.getByText('€ 0.53')).toBeInTheDocument();
    // 3.5 kWh / 7 prints
    expect(screen.getByText('0.50 kWh')).toBeInTheDocument();
  });

  it('shows the no-plugs empty state', async () => {
    render(<EnergyWidget currency="€" totalPrints={0} />);
    expect(
      await screen.findByText('No smart plugs with energy monitoring configured'),
    ).toBeInTheDocument();
  });
});
