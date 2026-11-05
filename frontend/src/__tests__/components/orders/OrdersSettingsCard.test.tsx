/** Settings → Orders: every change saves at once and sends the whole settings object. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import type { OrderBoardSettings } from '../../../api/client';

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

vi.mock('../../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../contexts/AuthContext')>();
  return { ...actual, useAuth: () => mockUseAuth };
});

import { render } from '../../utils';
import { OrdersSettingsCard } from '../../../components/orders/OrdersSettingsCard';

const SAVED: OrderBoardSettings = { sync_enabled: true, sync_minutes: 15, max_age_days: 365, core_brands: ['Bambu Lab', 'Polymaker'] };

const BOARD = {
  rows: [], computed_at: '2026-11-05T19:42:00+00:00', stock_loaded_at: '2026-11-05T19:42:00+00:00',
  sync: { enabled: true, configured: true, running: false, pending: 0, last_error: null, last_error_at: null, last_success_at: '2026-11-05T19:42:00+00:00' },
};

function setup() {
  const puts: OrderBoardSettings[] = [];
  let refreshes = 0;
  server.use(
    http.get('/api/v1/order-board/settings', () => HttpResponse.json(SAVED)),
    http.put('/api/v1/order-board/settings', async ({ request }) => {
      const body = (await request.json()) as OrderBoardSettings;
      puts.push(body);
      return HttpResponse.json(body);
    }),
    http.get('/api/v1/order-board', () => HttpResponse.json(BOARD)),
    http.post('/api/v1/order-board/refresh', () => {
      refreshes += 1;
      return HttpResponse.json(BOARD);
    }),
  );
  return { puts, refreshes: () => refreshes };
}

afterEach(() => {
  server.resetHandlers();
  mockUseAuth.hasPermission.mockImplementation(() => true);
});

describe('OrdersSettingsCard', () => {
  it('shows the saved values', async () => {
    setup();
    render(<OrdersSettingsCard />);
    expect(await screen.findByRole('switch', { name: 'Keep the order board in sync' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('combobox', { name: 'Check Zoho every' })).toHaveValue('15');
    expect(screen.getByRole('spinbutton', { name: 'Ignore orders older than' })).toHaveValue(365);
    expect(screen.getByText('Bambu Lab')).toBeInTheDocument();
    expect(screen.getByText('Polymaker')).toBeInTheDocument();
    expect(await screen.findByText(/^Last sync /)).toBeInTheDocument();
  });

  it('turning sync off sends the whole object with only that field changed', async () => {
    const user = userEvent.setup();
    const { puts } = setup();
    render(<OrdersSettingsCard />);
    await user.click(await screen.findByRole('switch', { name: 'Keep the order board in sync' }));
    await waitFor(() => expect(puts).toEqual([{ ...SAVED, sync_enabled: false }]));
    expect(await screen.findByRole('switch', { name: 'Keep the order board in sync' })).toHaveAttribute('aria-checked', 'false');
  });

  it('changing the interval saves it', async () => {
    const user = userEvent.setup();
    const { puts } = setup();
    render(<OrdersSettingsCard />);
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Check Zoho every' }), '60');
    await waitFor(() => expect(puts).toEqual([{ ...SAVED, sync_minutes: 60 }]));
  });

  it('the age limit saves on blur, and 0 is allowed', async () => {
    const user = userEvent.setup();
    const { puts } = setup();
    render(<OrdersSettingsCard />);
    const days = await screen.findByRole('spinbutton', { name: 'Ignore orders older than' });
    await user.clear(days);
    await user.type(days, '0');
    expect(puts).toEqual([]); // nothing until the field is left
    await user.tab();
    await waitFor(() => expect(puts).toEqual([{ ...SAVED, max_age_days: 0 }]));
  });

  it('an invalid age limit is dropped, not sent', async () => {
    const user = userEvent.setup();
    const { puts } = setup();
    render(<OrdersSettingsCard />);
    const days = await screen.findByRole('spinbutton', { name: 'Ignore orders older than' });
    await user.clear(days);
    await user.type(days, '99999');
    await user.tab();
    expect(days).toHaveValue(365);
    expect(puts).toEqual([]);
  });

  it('adds a brand on Enter, trimmed', async () => {
    const user = userEvent.setup();
    const { puts } = setup();
    render(<OrdersSettingsCard />);
    await user.type(await screen.findByRole('textbox', { name: 'Add a brand' }), '  Marlow {Enter}');
    await waitFor(() => expect(puts).toEqual([{ ...SAVED, core_brands: ['Bambu Lab', 'Polymaker', 'Marlow'] }]));
  });

  it('ignores a brand that is already there, whatever its case', async () => {
    const user = userEvent.setup();
    const { puts } = setup();
    render(<OrdersSettingsCard />);
    const input = await screen.findByRole('textbox', { name: 'Add a brand' });
    await user.type(input, ' polymaker {Enter}');
    await user.type(input, '   {Enter}');
    expect(puts).toEqual([]);
  });

  it('removes a brand', async () => {
    const user = userEvent.setup();
    const { puts } = setup();
    render(<OrdersSettingsCard />);
    await user.click(await screen.findByRole('button', { name: 'Remove Polymaker' }));
    await waitFor(() => expect(puts).toEqual([{ ...SAVED, core_brands: ['Bambu Lab'] }]));
  });

  it('locks the controls while a save is in flight, so a second change cannot undo the first', async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    setup();
    server.use(
      http.put('/api/v1/order-board/settings', async ({ request }) => {
        const body = await request.json();
        await new Promise<void>(resolve => { release = resolve; });
        return HttpResponse.json(body);
      }),
    );
    render(<OrdersSettingsCard />);
    await user.click(await screen.findByRole('switch', { name: 'Keep the order board in sync' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Check Zoho every' })).toBeDisabled());
    expect(screen.getByRole('switch', { name: 'Keep the order board in sync' })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: 'Ignore orders older than' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Add a brand' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove Polymaker' })).toBeDisabled();
    release();
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Check Zoho every' })).toBeEnabled());
  });

  it('Sync now asks the server for one pass', async () => {
    const user = userEvent.setup();
    const { refreshes } = setup();
    render(<OrdersSettingsCard />);
    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(refreshes()).toBe(1));
  });

  it('renders nothing without orders:update', () => {
    mockUseAuth.hasPermission.mockImplementation((p: string) => p !== 'orders:update');
    setup();
    render(<OrdersSettingsCard />);
    // The providers render their own wrappers, so look for the card's content.
    expect(screen.queryByText('Zoho sync')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });
});
