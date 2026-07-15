import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render, screen } from '../../utils';
import { server } from '../../mocks/server';
import { MaintenanceReliabilityWidget } from '../../../components/stats/MaintenanceReliabilityWidget';
import type { ArchiveSlim } from '../../../api/client';

const overview = [{
  printer_id: 1,
  printer_name: 'X1C',
  printer_model: 'X1 Carbon',
  total_print_hours: 120,
  maintenance_items: [
    {
      id: 1,
      printer_id: 1,
      printer_name: 'X1C',
      printer_model: 'X1 Carbon',
      maintenance_type_id: 1,
      maintenance_type_name: 'Clean nozzle',
      maintenance_type_icon: null,
      maintenance_type_wiki_url: null,
      enabled: true,
      interval_hours: 100,
      interval_type: 'hours',
      current_hours: 120,
      hours_since_maintenance: 110,
      hours_until_due: -10,
      days_since_maintenance: null,
      days_until_due: null,
      is_due: true,
      is_warning: false,
      last_performed_at: '2024-06-01T00:00:00Z',
    },
  ],
  due_count: 1,
  warning_count: 0,
}];

const archives = [
  // After last maintenance: counted
  { id: 1, printer_id: 1, status: 'completed', started_at: '2024-06-10T10:00:00Z', created_at: '2024-06-10T10:00:00Z' },
  { id: 2, printer_id: 1, status: 'failed', started_at: '2024-06-11T10:00:00Z', created_at: '2024-06-11T10:00:00Z' },
  // Before last maintenance: not counted
  { id: 3, printer_id: 1, status: 'completed', started_at: '2024-05-01T10:00:00Z', created_at: '2024-05-01T10:00:00Z' },
] as ArchiveSlim[];

describe('MaintenanceReliabilityWidget', () => {
  beforeEach(() => {
    server.use(http.get('/api/v1/maintenance/overview', () => HttpResponse.json(overview)));
  });

  it('shows badges and prints/failures since the last maintenance', async () => {
    render(<MaintenanceReliabilityWidget archives={archives} />);
    expect(await screen.findByText('X1C')).toBeInTheDocument();
    expect(screen.getByText('1 due')).toBeInTheDocument();
    expect(screen.getByText(/2 prints · 1 failed since/)).toBeInTheDocument();
  });

  it('shows the empty state when no printers track maintenance', async () => {
    server.use(http.get('/api/v1/maintenance/overview', () => HttpResponse.json([])));
    render(<MaintenanceReliabilityWidget archives={[]} />);
    expect(await screen.findByText('No printers with maintenance tracking')).toBeInTheDocument();
  });
});
