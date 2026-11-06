/** The collapsed row's next-step icon. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OrderBoardLine, OrderBoardRow } from '../../../api/client';

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
const print = vi.fn((produce: () => Promise<Blob>) => produce());
vi.mock('../../../components/aito/usePrintBlob', () => ({ usePrintBlob: () => ({ print, busy: false }) }));
const panel = vi.fn((_props: { startHandover?: string }) => <div data-testid="panel" />);
vi.mock('../../../components/orders/OrderLinesPanel', () => ({ OrderLinesPanel: (p: { startHandover?: string }) => panel(p) }));

import { render } from '../../utils';
import { OrderCard } from '../../../components/orders/OrderCard';

afterEach(() => {
  print.mockClear();
  panel.mockClear();
  mockUseAuth.hasPermission.mockImplementation(() => true);
});

const line = (o: Partial<OrderBoardLine> = {}): OrderBoardLine => ({
  id: 'l1', item_id: 'A', name: 'PLA', sku: 'P', state: 'ready', quantity: 1, shipped: 0, cancelled: 0, remaining: 1, invoiced: 0,
  packed_waiting: 0, stock_available: 1, covered: 1, packable: 1, shortfall: 0, covered_by_po: 0, po_numbers: [], ...o,
});
const row = (o: Partial<OrderBoardRow> = {}): OrderBoardRow => ({
  id: 'so1', number: 'SO-00412', customer: 'Lycée', date: '2026-09-12', total: 13600, currency: 'XPF', status: 'to_ship', age_days: 5,
  is_core: true, ready_ratio: 1, packed: 0, unbilled_units: 0, prep: null, customer_id: '', payment: null, contact: null,
  facts: { channel: '', reference: '', delivery_method: '', payment_terms: '', shopify_url: null, quote_url: null },
  units: { total: 1, shipped: 0, ready: 1, backordered: 0, to_order: 0 }, packages: [], lines: [line()], zoho_url: null, ...o,
});
const waiting = { packages: [{ id: 'p9', shipment_id: 's9', number: 'PKG-9', status: 'not_shipped', date: '2026-11-05' }], lines: [line({ packable: 0, packed_waiting: 1 })] };

describe('the row icon', () => {
  it('is a sibling of the row button, prints for the print step and does not toggle the row', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<OrderCard row={row()} open={false} onToggle={onToggle} />);
    const icon = screen.getByRole('button', { name: 'Prep sheet' });
    expect(screen.getByRole('button', { expanded: false }).contains(icon)).toBe(false);
    await user.click(icon);
    expect(print).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.queryByTestId('row-printed')).not.toBeInTheDocument();
  });

  it('shows a tick and Being prepared once the sheet was printed', () => {
    render(<OrderCard row={row({ prep: { at: '2026-11-06T18:30:00+00:00', by: 'Hina' } })} open={false} onToggle={vi.fn()} />);
    expect(screen.getByTestId('row-printed')).toBeInTheDocument();
    expect(screen.getByText(/Being prepared/)).toBeInTheDocument();
  });

  it('is absent when there is nothing to do', () => {
    render(<OrderCard row={row({ lines: [line({ packable: 0 })] })} open={false} onToggle={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Prep sheet' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hand over the parcel' })).not.toBeInTheDocument();
  });

  it('the hand icon needs orders:update, and opens the order for that package', async () => {
    const user = userEvent.setup();
    const onHandover = vi.fn();
    mockUseAuth.hasPermission.mockImplementation(() => false);
    const first = render(<OrderCard row={row(waiting)} open={false} onToggle={vi.fn()} onHandover={onHandover} />);
    expect(screen.queryByRole('button', { name: 'Hand over the parcel' })).not.toBeInTheDocument();
    first.unmount();
    mockUseAuth.hasPermission.mockImplementation(() => true);
    render(<OrderCard row={row(waiting)} open={false} onToggle={vi.fn()} onHandover={onHandover} />);
    await user.click(screen.getByRole('button', { name: 'Hand over the parcel' }));
    expect(onHandover).toHaveBeenCalledWith('p9');
  });

  it('hands the package id down to the panel', () => {
    render(<OrderCard row={row(waiting)} open onToggle={vi.fn()} startHandover="p9" handoverTick={3} />);
    expect(panel).toHaveBeenCalledWith(expect.objectContaining({ startHandover: 'p9', handoverTick: 3 }));
  });
});
