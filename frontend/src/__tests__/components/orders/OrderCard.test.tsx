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
type PanelProps = { start?: string; onHandoverOpen?: (open: boolean) => void };
const panel = vi.fn((p: PanelProps) => (
  <div data-testid="panel"><button type="button" onClick={() => p.onHandoverOpen?.(true)}>open hand-over</button></div>
));
vi.mock('../../../components/orders/OrderLinesPanel', () => ({ OrderLinesPanel: (p: PanelProps) => panel(p) }));

import { render } from '../../utils';
import { OrderCard } from '../../../components/orders/OrderCard';

afterEach(() => {
  print.mockClear();
  panel.mockClear();
  mockUseAuth.hasPermission.mockImplementation(() => true);
});

const line = (o: Partial<OrderBoardLine> = {}): OrderBoardLine => ({
  id: 'l1', item_id: 'A', name: 'PLA', sku: 'P', state: 'ready', quantity: 1, shipped: 0, cancelled: 0, remaining: 1, invoiced: 0,
  packed_waiting: 0, stock_available: 1, covered: 1, packable: 1, shortfall: 0, rate: 3400, floor: 0, covered_by_po: 0, po_numbers: [], ...o,
});
const row = (o: Partial<OrderBoardRow> = {}): OrderBoardRow => ({
  id: 'so1', number: 'SO-00412', customer: 'Lycée', date: '2026-09-12', total: 13600, currency: 'XPF', status: 'to_ship', age_days: 5,
  is_core: true, ready_ratio: 1, packed: 0, unbilled_units: 0, prep: null, customer_id: '', payment: null, contact: null,
  facts: { channel: '', reference: '', shopify_order: '', quote_number: '', delivery_method: '', payment_terms: '', shopify_url: null, quote_url: null }, version: 'v1', estimable: true,
  units: { total: 1, shipped: 0, ready: 1, backordered: 0, to_order: 0 }, packages: [], lines: [line()], zoho_url: null, ...o,
});
const waiting = { packages: [{ id: 'p9', shipment_id: 's9', number: 'PKG-9', status: 'not_shipped', date: '2026-11-05' }], lines: [line({ packable: 0, packed_waiting: 1 })] };

const open = { picklists: [{ id: 'pl1', number: 'PL-00013', status: 'yet_to_start', date: '2026-11-06' }], picked: 0 };

describe('the row icon', () => {
  it('is a sibling of the row button, starts the picking step and does not toggle the row', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const onStart = vi.fn();
    render(<OrderCard row={row()} open={false} onToggle={onToggle} onStart={onStart} />);
    const icon = screen.getByRole('button', { name: 'Prepare' });
    expect(screen.getByRole('button', { expanded: false }).contains(icon)).toBe(false);
    await user.click(icon);
    expect(onStart).toHaveBeenCalledWith('pick');
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.queryByTestId('row-printed')).not.toBeInTheDocument();
  });

  it('an open picklist turns it into Create parcel and the row reads Being prepared', async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    render(<OrderCard row={row(open)} open={false} onToggle={vi.fn()} onStart={onStart} />);
    expect(screen.getByText(/Being prepared/)).toBeInTheDocument();
    expect(screen.queryByTestId('row-printed')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create parcel' }));
    expect(onStart).toHaveBeenCalledWith('pack-pl1');
  });

  it('shows a tick once the sheet was printed', () => {
    render(<OrderCard row={row({ ...open, prep: { at: '2026-11-06T18:30:00+00:00', by: 'Hina' } })} open={false} onToggle={vi.fn()} />);
    expect(screen.getByTestId('row-printed')).toBeInTheDocument();
    expect(screen.getByText(/Being prepared/)).toBeInTheDocument();
  });

  it('pops the tick only when the sheet gets printed on screen', () => {
    const printed = row({ ...open, prep: { at: '2026-11-06T18:30:00+00:00', by: 'Hina' } });
    const first = render(<OrderCard row={printed} open={false} onToggle={vi.fn()} />);
    expect(screen.getByTestId('row-printed')).not.toHaveClass('animate-slice-done');
    first.unmount();
    const { rerender } = render(<OrderCard row={row(open)} open={false} onToggle={vi.fn()} />);
    rerender(<OrderCard row={printed} open={false} onToggle={vi.fn()} />);
    expect(screen.getByTestId('row-printed')).toHaveClass('animate-slice-done');
  });

  it('is absent when there is nothing to do', () => {
    render(<OrderCard row={row({ lines: [line({ packable: 0 })] })} open={false} onToggle={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Prepare' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hand over the parcel' })).not.toBeInTheDocument();
  });

  it('needs orders:update, and opens the order for that package', async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    mockUseAuth.hasPermission.mockImplementation(() => false);
    const first = render(<OrderCard row={row(waiting)} open={false} onToggle={vi.fn()} onStart={onStart} />);
    expect(screen.queryByRole('button', { name: 'Hand over the parcel' })).not.toBeInTheDocument();
    first.unmount();
    const second = render(<OrderCard row={row()} open={false} onToggle={vi.fn()} onStart={onStart} />);
    expect(screen.queryByRole('button', { name: 'Prepare' })).not.toBeInTheDocument();
    second.unmount();
    mockUseAuth.hasPermission.mockImplementation(() => true);
    render(<OrderCard row={row(waiting)} open={false} onToggle={vi.fn()} onStart={onStart} />);
    await user.click(screen.getByRole('button', { name: 'Hand over the parcel' }));
    expect(onStart).toHaveBeenCalledWith('handover-p9');
  });

  it('hides while the open panel shows a hand-over bar', async () => {
    const user = userEvent.setup();
    render(<OrderCard row={row()} open onToggle={vi.fn()} onStart={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Prepare' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'open hand-over' }));
    expect(screen.queryByRole('button', { name: 'Prepare' })).not.toBeInTheDocument();
  });

  it('hands the step down to the panel', () => {
    render(<OrderCard row={row(waiting)} open onToggle={vi.fn()} start="handover-p9" startTick={3} />);
    expect(panel).toHaveBeenCalledWith(expect.objectContaining({ start: 'handover-p9', startTick: 3 }));
  });
});
