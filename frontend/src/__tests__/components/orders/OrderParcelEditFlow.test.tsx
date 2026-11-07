/** "Edit" in the packed band: change what a waiting parcel holds, take lines out, add shelf lines, save to Zoho. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useQuery } from '@tanstack/react-query';
import { server } from '../../mocks/server';
import type { OrderBoardLine, OrderPanelRow } from '../../../api/client';

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

import { render } from '../../utils';
import { OrderLinesPanel } from '../../../components/orders/OrderLinesPanel';

afterEach(() => {
  server.resetHandlers();
  print.mockClear();
  mockUseAuth.hasPermission.mockImplementation(() => true);
});

const line = (o: Partial<OrderBoardLine> = {}): OrderBoardLine => ({
  id: 'l1', item_id: 'A', name: 'Bambu Lab PLA Basic Noir', sku: 'BL-PLA-BK', state: 'ready', quantity: 3, shipped: 0,
  cancelled: 0, remaining: 3, invoiced: 0, packed_waiting: 2, stock_available: 1, covered: 3, packable: 1, shortfall: 0, rate: 3400, floor: 0,
  covered_by_po: 0, po_numbers: [], ...o,
});
const lines = [line(), line({ id: 'l2', item_id: 'C', name: 'Filament B', quantity: 4, remaining: 4, packed_waiting: 0, stock_available: 4, covered: 4, packable: 4, rate: 1000 })];
const pkg = (id: string, number: string) => ({ id, shipment_id: `s-${id}`, number, status: 'not_shipped', date: '2026-11-05' });
const panelRow = (o: Partial<OrderPanelRow> = {}): OrderPanelRow => ({
  id: 'so1', number: 'SO-00412', customer: 'Lycée de Taravao', date: '2026-09-12', total: 14200, currency: 'XPF',
  age_days: 5, is_core: true, ready_ratio: 1, packed: 2, unbilled_units: 0, prep: null, customer_id: '', payment: null, contact: null,
  facts: { channel: '', reference: '', shopify_order: '', quote_number: '', delivery_method: '', payment_terms: '', shopify_url: null, quote_url: null }, version: 'v1', estimable: true,
  units: { total: 7, shipped: 0, ready: 7, backordered: 0, to_order: 0 }, packages: [pkg('p1', 'PKG-00031')],
  picklists: [{ id: 'pl1', number: 'PL-00020', status: 'completed', date: '2026-11-05' }], lines,
  zoho_url: null, ...o,
});

const BASE = '/api/v1/order-board/orders/so1';
const content = http.get(`${BASE}/packages/p1`, () =>
  HttpResponse.json({ id: 'p1', number: 'PKG-00031', version: 'v1', picklist_id: 'pl1', lines: [{ line_id: 'l1', quantity: 2, max: 3 }, { line_id: 'l2', quantity: 0, max: 4 }] }),
);
const board = { rows: [], computed_at: null, stock_loaded_at: null, sync: {} };
const qty = (id = 'l1') => screen.getByTestId(`pack-qty-${id}`) as HTMLInputElement;
const editButtons = () => screen.getAllByRole('button', { name: /^Edit/ });
const parcelButton = (id = 'p1') => editButtons().find(b => b.dataset.opens === `parcel-${id}`) as HTMLElement;
const openParcel = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(parcelButton());
  await screen.findByRole('columnheader', { name: 'In the parcel' });
};
const more = (name = 'Bambu Lab PLA Basic Noir') => screen.getByRole('button', { name: `One more · ${name}` });
const less = (name = 'Bambu Lab PLA Basic Noir') => screen.getByRole('button', { name: `One less · ${name}` });

describe('editing a parcel', () => {
  it('Edit sits beside Hand over for each waiting parcel and opens the parcel from Books', async () => {
    const user = userEvent.setup();
    let asked = 0;
    server.use(http.get(`${BASE}/packages/p1`, () => {
      asked += 1;
      return HttpResponse.json({ id: 'p1', number: 'PKG-00031', version: 'v1', picklist_id: 'pl1', lines: [{ line_id: 'l1', quantity: 2, max: 3 }] });
    }));
    const first = render(<OrderLinesPanel row={panelRow({ packages: [pkg('p1', 'PKG-00031'), pkg('p2', 'PKG-00032')] })} />);
    expect(screen.getByRole('button', { name: 'Edit · PKG-00031' })).toHaveAttribute('data-opens', 'parcel-p1');
    expect(screen.getByRole('button', { name: 'Edit · PKG-00032' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hand over PKG-00031' })).toBeInTheDocument();
    first.unmount();
    render(<OrderLinesPanel row={panelRow()} />);
    expect(screen.getByRole('button', { name: 'Hand over the parcel' })).toBeInTheDocument();
    await openParcel(user);
    expect(asked).toBe(1);
    expect(qty()).toHaveValue(2);
  });

  it('the parcel lines step between 0 and their ceiling with a +n/−n tag; a shelf line starts at 0 as an add row', async () => {
    const user = userEvent.setup();
    server.use(content);
    render(<OrderLinesPanel row={panelRow()} />);
    await openParcel(user);
    expect(screen.getByText('Add to the parcel')).toBeInTheDocument();
    expect(screen.getByText('To prepare · 4 in stock')).toBeInTheDocument();
    expect(qty('l2')).toHaveValue(0);
    await user.click(more());
    await user.click(more());
    expect(qty()).toHaveValue(3);
    expect(screen.getByText('+1')).toBeInTheDocument();
    for (let i = 0; i < 4; i += 1) await user.click(less());
    expect(qty()).toHaveValue(0);
    expect(screen.getByText('−2')).toBeInTheDocument();
    expect(screen.getByText('Taken out')).toBeInTheDocument();
    await user.click(more('Filament B'));
    expect(screen.getByText('Added to the parcel')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
  });

  it('a packed line of another parcel is dimmed with its count', async () => {
    const user = userEvent.setup();
    server.use(content);
    const row = panelRow({ lines: [lines[0], line({ id: 'l3', name: 'Buse 0.4', packed_waiting: 1, remaining: 1, quantity: 1, packable: 0 }), lines[1]] });
    render(<OrderLinesPanel row={row} />);
    await openParcel(user);
    expect(screen.getByText('1 in another parcel')).toBeInTheDocument();
    expect(screen.getByText('Buse 0.4').closest('tr')).toHaveClass('opacity-40');
    expect(screen.queryByTestId('pack-qty-l3')).not.toBeInTheDocument();
  });

  it('a line of another parcel the shelf still covers renders once, as an add row with its count', async () => {
    const user = userEvent.setup();
    server.use(http.get(`${BASE}/packages/p1`, () => HttpResponse.json({
      id: 'p1', number: 'PKG-00031', version: 'v1', picklist_id: 'pl1',
      lines: [{ line_id: 'l1', quantity: 2, max: 3 }, { line_id: 'l3', quantity: 0, max: 2 }],
    })));
    const row = panelRow({ packages: [pkg('p1', 'PKG-00031'), pkg('p2', 'PKG-00032')], lines: [lines[0], line({ id: 'l3', name: 'Buse 0.4', packed_waiting: 1, remaining: 3, quantity: 3, packable: 2 })] });
    render(<OrderLinesPanel row={row} />);
    await user.click(parcelButton());
    await screen.findByRole('columnheader', { name: 'In the parcel' });
    const rows = screen.getAllByText('Buse 0.4').map(el => el.closest('tr'));
    const packed = rows.filter(r => r?.closest('tbody')?.querySelector('[data-testid="pack-qty-l3"]'));
    expect(packed).toHaveLength(1);
    expect(screen.getAllByTestId('pack-qty-l3')).toHaveLength(1);
    expect(packed[0]).toHaveTextContent('1 in another parcel');
    expect(packed[0]).toHaveTextContent('To prepare · 2 in stock');
    expect(packed[0]).toContainElement(screen.getByTestId('pack-qty-l3'));
  });

  it('the bar sums units, added and removed, and names the picklist; Save is disabled until something changed', async () => {
    const user = userEvent.setup();
    server.use(content);
    render(<OrderLinesPanel row={panelRow()} />);
    await openParcel(user);
    expect(screen.getByText('PKG-00031: 2 units')).toBeInTheDocument();
    expect(screen.getByText('Sets picklist PL-00020 to the same quantities, then the parcel, in Zoho Books.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save the parcel' })).toBeDisabled();
    await user.click(less());
    await user.click(more('Filament B'));
    await user.click(more('Filament B'));
    expect(screen.getByText('PKG-00031: 3 units')).toBeInTheDocument();
    expect(screen.getByText('(was 2)')).toBeInTheDocument();
    expect(screen.getByText('· +2 from the shelf')).toBeInTheDocument();
    expect(screen.getByText('· −1 back to prepare')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save the parcel' })).toBeEnabled();
  });

  it('at zero units the bar offers Delete the parcel in red', async () => {
    const user = userEvent.setup();
    server.use(content);
    render(<OrderLinesPanel row={panelRow()} />);
    await openParcel(user);
    await user.click(less());
    await user.click(less());
    expect(screen.getByText('Empty parcel: deletes PKG-00031 and picklist PL-00020 in Zoho Books; everything goes back to prepare.')).toBeInTheDocument();
    const del = screen.getByRole('button', { name: 'Delete the parcel' });
    expect(del).toBeEnabled();
    expect(del).toHaveClass('bg-red-500');
    expect(screen.queryByRole('button', { name: 'Save the parcel' })).not.toBeInTheDocument();
  });

  it('saves was and lines, drops zeros, and toasts', async () => {
    const user = userEvent.setup();
    let body: unknown;
    server.use(content, http.put(`${BASE}/packages/p1`, async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ board, row: null });
    }));
    render(<OrderLinesPanel row={panelRow()} />);
    await openParcel(user);
    await user.click(less());
    await user.click(more('Filament B'));
    await user.click(more('Filament B'));
    await user.click(screen.getByRole('button', { name: 'Save the parcel' }));
    expect(await screen.findByText('Parcel PKG-00031 updated in Zoho Books · 3 units')).toBeInTheDocument();
    expect(body).toEqual({ version: 'v1', was: [{ line_id: 'l1', quantity: 2 }], lines: [{ line_id: 'l1', quantity: 1 }, { line_id: 'l2', quantity: 2 }] });
    expect(screen.queryByRole('columnheader', { name: 'In the parcel' })).not.toBeInTheDocument();
  });

  it('a 400 package_changed toasts the reason and refetches the board', async () => {
    const user = userEvent.setup();
    server.use(content, http.put(`${BASE}/packages/p1`, () => HttpResponse.json({ detail: { code: 'package_changed', message: 'changed' } }, { status: 400 })));
    let reads = 0;
    const Probe = () => { useQuery({ queryKey: ['order-board'], queryFn: () => { reads += 1; return board; }, staleTime: Infinity }); return null; };
    render(<><Probe /><OrderLinesPanel row={panelRow()} /></>);
    await waitFor(() => expect(reads).toBe(1));
    await openParcel(user);
    await user.click(less());
    await user.click(screen.getByRole('button', { name: 'Save the parcel' }));
    expect(await screen.findByText('Parcel edit failed: the parcel changed in Books, look again')).toBeInTheDocument();
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.queryByRole('columnheader', { name: 'In the parcel' })).not.toBeInTheDocument(); // what it showed is stale
  });

  it('the hand-over buttons are hidden while a parcel is being edited', async () => {
    const user = userEvent.setup();
    server.use(content);
    render(<OrderLinesPanel row={panelRow()} />);
    await openParcel(user);
    expect(screen.queryByRole('button', { name: 'Hand over the parcel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit/ })).not.toBeInTheDocument(); // one bar at a time
    expect(screen.queryByRole('button', { name: 'Prepare' })).not.toBeInTheDocument();
    fireEvent.keyDown(qty(), { key: 'Escape' });
    expect(screen.queryByRole('columnheader', { name: 'In the parcel' })).not.toBeInTheDocument();
    expect(parcelButton()).toHaveFocus();
    await openParcel(user);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(parcelButton()).toHaveFocus();
  });
});
