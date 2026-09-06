/**
 * StatsPage gates the Aito pipeline widget on `aito:read` (see StatsPage.tsx's
 * `hasPermission('aito:read')` spread, mirroring the maintenance widget just
 * above it). `StatsPage.test.tsx` runs with auth disabled, where every
 * permission is granted, so it cannot see the widget disappear — this file
 * follows AitoPageAitoPermissions.test.tsx's `vi.mock` pattern to drive
 * `hasPermission` directly instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const mockUseAuth = {
  user: { id: 1, username: 'operator', permissions: [] as string[] },
  authEnabled: true,
  requiresSetup: false,
  loading: false,
  isAdmin: false,
  login: vi.fn(),
  loginWithToken: vi.fn(),
  logout: vi.fn(),
  refreshUser: vi.fn(),
  refreshAuth: vi.fn(),
  hasPermission: vi.fn((_permission: string) => true),
  hasAnyPermission: vi.fn(() => true),
  hasAllPermissions: vi.fn(() => true),
  canModify: vi.fn(() => true),
};

vi.mock('../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contexts/AuthContext')>();
  return { ...actual, useAuth: () => mockUseAuth };
});

import { render } from '../utils';
import { StatsPage } from '../../pages/StatsPage';

const mockStats = {
  total_prints: 150,
  successful_prints: 140,
  failed_prints: 10,
  cancelled_prints: 0,
  total_print_time_hours: 500.5,
  total_filament_grams: 5500,
  total_cost: 125.5,
  prints_by_filament_type: { PLA: 80, PETG: 50, ABS: 20 },
  prints_by_printer: { '1': 100, '2': 50 },
  average_time_accuracy: 98.5,
  time_accuracy_by_printer: { '1': 99.0, '2': 97.0 },
  total_energy_kwh: 45.5,
  total_energy_cost: 12.5,
};

const mockPrinters = [
  { id: 1, name: 'X1 Carbon', model: 'X1C', enabled: true },
  { id: 2, name: 'P1S', model: 'P1S', enabled: true },
];

const mockSettings = {
  currency: 'USD',
  check_updates: false,
  check_printer_firmware: false,
};

const mockFailureAnalysis = {
  period_days: 30,
  total_prints: 100,
  failed_prints: 5,
  failure_rate: 5.0,
  failures_by_reason: {},
  failures_by_filament: {},
  failures_by_printer: {},
  failures_by_hour: {},
  recent_failures: [],
  trend: [],
};

const emptyAitoStats = {
  board: [
    { column: 'devis', count: 0, total: 0 },
    { column: 'waiting', count: 0, total: 0 },
    { column: 'scan', count: 0, total: 0 },
    { column: 'model', count: 0, total: 0 },
    { column: 'print', count: 0, total: 0 },
    { column: 'finish', count: 0, total: 0 },
    { column: 'done', count: 0, total: 0 },
  ],
  conversion: {
    sent: { count: 0, total: 0 },
    accepted: { count: 0, total: 0 },
    declined: { count: 0, total: 0 },
    acceptance_rate: null,
  },
  stage_days: [
    { column: 'devis', median_days: null, sample: 0 },
    { column: 'waiting', median_days: null, sample: 0 },
    { column: 'scan', median_days: null, sample: 0 },
    { column: 'model', median_days: null, sample: 0 },
    { column: 'print', median_days: null, sample: 0 },
    { column: 'finish', median_days: null, sample: 0 },
  ],
  invoicing: { invoiced_total: 0, invoiced_count: 0, outstanding_balance: 0, outstanding_count: 0 },
  date_from: null,
  date_to: null,
};

beforeEach(() => {
  mockUseAuth.hasPermission.mockReset();

  server.use(
    http.get('/api/v1/archives/stats', () => HttpResponse.json(mockStats)),
    http.get('/api/v1/printers/', () => HttpResponse.json(mockPrinters)),
    http.get('/api/v1/archives/slim', () => HttpResponse.json([])),
    http.get('/api/v1/settings/', () => HttpResponse.json(mockSettings)),
    http.get('/api/v1/archives/analysis/failures', () => HttpResponse.json(mockFailureAnalysis)),
    http.get('/api/v1/aito/stats', () => HttpResponse.json(emptyAitoStats)),
  );
});

describe('StatsPage — aito:read permission gating', () => {
  it('without aito:read: hides the Aito pipeline widget', async () => {
    mockUseAuth.authEnabled = true;
    mockUseAuth.hasPermission.mockImplementation((permission: string) => permission !== 'aito:read');

    render(<StatsPage />);

    await waitFor(() => {
      expect(screen.getByText('Statistics')).toBeInTheDocument();
    });
    expect(screen.queryByText('Aito pipeline')).not.toBeInTheDocument();
  });

  it('with aito:read: shows the Aito pipeline widget', async () => {
    mockUseAuth.authEnabled = true;
    mockUseAuth.hasPermission.mockImplementation(() => true);

    render(<StatsPage />);

    await waitFor(() => {
      expect(screen.getByText('Aito pipeline')).toBeInTheDocument();
    });
  });
});
