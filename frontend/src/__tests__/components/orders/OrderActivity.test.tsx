/** The order's Activité tab, its tab memory, and the last-activity line on the row. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../../../api/client';
import type { OrderBoardRow, OrderEvent, OrderPanelRow } from '../../../api/client';

const mockUseAuth = {
  user: { id: 1, username: 'operator', permissions: [] as string[] },
  authEnabled: true, requiresSetup: false, loading: false, isAdmin: false,
  login: vi.fn(), loginWithToken: vi.fn(), logout: vi.fn(), refreshUser: vi.fn(), refreshAuth: vi.fn(),
  hasPermission: vi.fn((_permission: string) => true),
  hasAnyPermission: vi.fn(() => true), hasAllPermissions: vi.fn(() => true), canModify: vi.fn(() => true),
};
vi.mock('../../../contexts/AuthContext', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../contexts/AuthContext')>();
  return { ...actual, useAuth: () => mockUseAuth };
});

import { render } from '../../utils';
import { OrderActivity } from '../../../components/orders/OrderActivity';
import { OrderLinesPanel } from '../../../components/orders/OrderLinesPanel';
import { OrderCard } from '../../../components/orders/OrderCard';

afterEach(() => {
  vi.restoreAllMocks();
  mockUseAuth.hasPermission.mockImplementation(() => true);
  sessionStorage.clear();
  localStorage.clear();
});

const ev = (o: Partial<OrderEvent>): OrderEvent => ({
  id: 1, occurred_at: '2026-11-11T09:00:00', kind: 'note.added', actor_class: 'user', actor_name: 'Marie',
  changes: null, detail: null, note: null, ...o,
});

const row = (o: Partial<OrderBoardRow> = {}): OrderBoardRow => ({
  id: 'so1', number: 'SO-00441', customer: 'Jeanne Tehei', date: '2026-11-06', total: 21640, currency: 'XPF', status: 'to_ship', age_days: 5,
  is_core: true, ready_ratio: 1, packed: 0, unbilled_units: 0, prep: null, contacted: null, customer_id: '', payment: null, contact: null,
  facts: { channel: '', reference: '', shopify_order: '', quote_number: '', delivery_method: '', payment_terms: '', shopify_url: null, quote_url: null },
  version: 'v1', estimable: true, picked: 0, picklists: [],
  units: { total: 1, shipped: 0, ready: 1, backordered: 0, to_order: 0 }, packages: [], lines: [], zoho_url: null, ...o,
} as unknown as OrderBoardRow);

describe('OrderActivity', () => {
  it('renders order events newest first', async () => {
    vi.spyOn(api, 'getOrderEvents').mockResolvedValue({
      events: [
        ev({ id: 3, kind: 'package.created', detail: { package: 'PKG-00087' } }),
        ev({ id: 2, kind: 'order.ready', actor_class: 'system', actor_name: null }),
        ev({ id: 1, kind: 'order.received', actor_class: 'system', actor_name: null, detail: { source: 'shopify', reference: '#1093' } }),
      ],
      has_more: false,
    });
    render(<OrderActivity soId="so1" currency="XPF" />);
    const items = await screen.findAllByRole('listitem');
    expect(items.map(i => i.textContent)).toEqual([
      expect.stringContaining('Marie created package PKG-00087'),
      expect.stringContaining('Stock arrived'),
      expect.stringContaining('Order received from Shopify #1093'),
    ]);
    expect(items[1].textContent).toContain('seen by the sync');
    expect(api.getOrderEvents).toHaveBeenCalledWith('so1', { depth: 'detail', cursor: undefined, limit: 50 });
  });

  it('depth switch refetches with depth=everything', async () => {
    const spy = vi.spyOn(api, 'getOrderEvents').mockResolvedValue({ events: [], has_more: false });
    render(<OrderActivity soId="so1" currency="XPF" />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Everything' }));
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith('so1', expect.objectContaining({ depth: 'everything' })));
    expect(localStorage.getItem('orders.history.depth')).toBe('everything');
  });

  it('note adds optimistically and posts', async () => {
    vi.spyOn(api, 'getOrderEvents').mockResolvedValue({ events: [], has_more: false });
    let resolve!: (e: OrderEvent) => void;
    const add = vi.spyOn(api, 'addOrderNote').mockReturnValue(new Promise(r => { resolve = r; }));
    const user = userEvent.setup();
    render(<OrderActivity soId="so1" currency="XPF" />);
    await user.type(await screen.findByPlaceholderText(/note/i), 'client passe jeudi');
    await user.keyboard('{Enter}');
    expect(await screen.findByText('client passe jeudi')).toBeInTheDocument();
    expect(add).toHaveBeenCalledWith('so1', 'client passe jeudi');
    resolve(ev({ id: 9, note: 'client passe jeudi' }));
  });

  it('hides the note box without orders:update', async () => {
    mockUseAuth.hasPermission.mockImplementation((p: string) => p !== 'orders:update');
    vi.spyOn(api, 'getOrderEvents').mockResolvedValue({ events: [], has_more: false });
    render(<OrderActivity soId="so1" currency="XPF" />);
    await screen.findByText(/Nothing recorded/i);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});

describe('the side column tabs', () => {
  it('tab choice persists in sessionStorage', async () => {
    vi.spyOn(api, 'getOrderEvents').mockResolvedValue({ events: [], has_more: false });
    const user = userEvent.setup();
    const first = render(<OrderLinesPanel row={row() as OrderPanelRow} />);
    await user.click(screen.getByRole('tab', { name: 'Activity' }));
    expect(sessionStorage.getItem('orders.panel.tab')).toBe('activity');
    expect(await screen.findByText(/Nothing recorded/i)).toBeInTheDocument();
    first.unmount();
    render(<OrderLinesPanel row={row() as OrderPanelRow} />);
    expect(screen.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('the row', () => {
  it('row shows last activity', () => {
    const at = new Date(Date.now() - 2 * 3600_000).toISOString();
    render(<OrderCard row={row({ last_event: { kind: 'sms.sent', actor_name: 'Marie', occurred_at: at, detail: null } })} open={false} onToggle={() => {}} />);
    expect(within(screen.getByTestId('order-last-activity')).getByText('Marie · Pickup SMS · 2 hours ago')).toBeInTheDocument();
  });
});
