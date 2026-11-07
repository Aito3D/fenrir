/** "Edit" in the prep band: change the ordered quantities, remove lines, add Books items, save to Zoho. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import type { OrderBoardLine, OrderPanelRow, OrderPayment } from '../../../api/client';
import { formatMoney } from '../../../utils/pricing';

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
  id: 'l1', item_id: 'A', name: 'Bambu Lab PLA Basic Noir', sku: 'BL-PLA-BK', state: 'ready', quantity: 2, shipped: 0,
  cancelled: 0, remaining: 2, invoiced: 0, packed_waiting: 0, stock_available: 2, covered: 2, packable: 2, shortfall: 0, rate: 3400, floor: 0,
  covered_by_po: 0, po_numbers: [], ...o,
});
const panelRow = (o: Partial<OrderPanelRow> = {}, lines = [line()]): OrderPanelRow => ({
  id: 'so1', number: 'SO-00412', customer: 'Lycée de Taravao', date: '2026-09-12', total: 11800, currency: 'XPF',
  age_days: 5, is_core: true, ready_ratio: 1, packed: 0, unbilled_units: 0, prep: null, customer_id: '', payment: null, contact: null,
  facts: { channel: '', reference: '', shopify_order: '', quote_number: '', delivery_method: '', payment_terms: '', shopify_url: null, quote_url: null }, version: 'v1', estimable: true,
  units: { total: 2, shipped: 0, ready: 2, backordered: 0, to_order: 0 }, packages: [], lines,
  zoho_url: null, ...o,
});
const payment = (o: Partial<OrderPayment> = {}): OrderPayment => ({
  state: 'partial', pct: 42, paid: 5000, invoice_paid: 0, advance: 5000, due: 0, overdue: 0, rest: 6800, left: 6800, next_due: null, invoices: [], ...o,
});

const BASE = '/api/v1/order-board/orders/so1';
/** As the DOM reads it once whitespace is normalised (the grouping space is a narrow no-break space). */
const money = (n: number) => formatMoney(n, 'XPF').replace(/\s/g, ' ');
const qty = (id = 'l1') => screen.getByTestId(`pack-qty-${id}`) as HTMLInputElement;
/** l1 can drop to 0; l2 has 3 units already invoiced. */
const floored = [line(), line({ id: 'l2', item_id: 'C', name: 'Filament B', quantity: 3, remaining: 3, invoiced: 3, floor: 3, rate: 1000 })];
const two = [line(), line({ id: 'l2', item_id: 'C', name: 'Filament B', quantity: 5, remaining: 5, rate: 1000 })];
const hits = http.get('/api/v1/order-board/items', ({ request }) =>
  HttpResponse.json({
    items: new URL(request.url).searchParams.get('q') === 'pla'
      ? [
          { id: 'A', name: 'Bambu Lab PLA Basic Noir', sku: 'BL-PLA-BK', rate: 3400, stock_on_hand: 9, product_type: 'goods' },
          { id: 'B', name: 'PLA Silk Or', sku: 'PLA-SILK-GD', rate: 1500, stock_on_hand: 4, product_type: 'goods' },
        ]
      : [],
  }),
);
const openEdit = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: 'Edit' }));
  await screen.findByRole('columnheader', { name: 'Ordered' });
};
const addSilk = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByRole('searchbox', { name: 'Add an item · name or SKU in Zoho Books' }), 'pla');
  await user.click(await screen.findByRole('button', { name: /PLA Silk Or/ }));
};

describe('editing the order', () => {
  it('Edit appears in the prep band with orders:update and is a lock caption while a picklist is open', () => {
    const first = render(<OrderLinesPanel row={panelRow()} />);
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    first.unmount();
    mockUseAuth.hasPermission.mockImplementation(() => false);
    const second = render(<OrderLinesPanel row={panelRow()} />);
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    second.unmount();
    mockUseAuth.hasPermission.mockImplementation(() => true);
    render(<OrderLinesPanel row={panelRow({ picklists: [{ id: 'pl1', number: 'PL-00013', status: 'yet_to_start', date: '2026-11-06' }], picked: 0 })} />);
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.getByText('Picklist PL-00013 open')).toHaveAttribute('title', 'Create its parcel or cancel it to edit the order');
  });

  it('opens every live line at its ordered quantity with a stepper floored at its floor', async () => {
    const user = userEvent.setup();
    render(<OrderLinesPanel row={panelRow({}, floored)} />);
    await openEdit(user);
    expect(qty('l1')).toHaveValue(2);
    expect(screen.getByRole('button', { name: 'One less · Bambu Lab PLA Basic Noir' })).toBeEnabled();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(qty('l2')).toHaveValue(3);
    expect(screen.getByText('min 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'One less · Filament B' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove the line · Filament B' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'One more · Filament B' }));
    await user.click(screen.getByRole('button', { name: 'One more · Filament B' }));
    expect(qty('l2')).toHaveValue(5); // no maximum
    await user.click(screen.getByRole('button', { name: 'One less · Bambu Lab PLA Basic Noir' }));
    expect(qty('l1')).toHaveValue(1);
    expect(screen.getByRole('button', { name: 'One less · Bambu Lab PLA Basic Noir' })).toBeDisabled(); // never 0: the trash removes
    expect(screen.getByRole('button', { name: 'One less · Filament B' })).toBeEnabled();
  });

  it('a removed line is struck through and can be restored; a floored line cannot be removed', async () => {
    const user = userEvent.setup();
    render(<OrderLinesPanel row={panelRow({}, floored)} />);
    await openEdit(user);
    expect(screen.getByRole('button', { name: 'Remove the line · Filament B' })).toHaveAttribute('title', 'Units are already packed, shipped or invoiced');
    await user.click(screen.getByRole('button', { name: 'Remove the line · Bambu Lab PLA Basic Noir' }));
    expect(screen.queryByTestId('pack-qty-l1')).not.toBeInTheDocument();
    expect(screen.getByText('Bambu Lab PLA Basic Noir').closest('td')).toHaveClass('line-through');
    expect(screen.getByText(/removes Bambu Lab PLA Basic Noir/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(qty('l1')).toHaveValue(2);
    expect(screen.getByText('Change a quantity, remove a line or add an item.')).toBeInTheDocument();
  });

  it('search lists Books items not already on the order and adds one at 1', async () => {
    const user = userEvent.setup();
    server.use(hits);
    render(<OrderLinesPanel row={panelRow()} />);
    await openEdit(user);
    await user.type(screen.getByRole('searchbox', { name: 'Add an item · name or SKU in Zoho Books' }), 'pla');
    const list = await screen.findByRole('list');
    expect(within(list).getAllByRole('button')).toHaveLength(1);
    expect(within(list).getByText('4 in stock')).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: /PLA Silk Or/ }));
    expect(qty('add-B')).toHaveValue(1);
    expect(screen.getByText(`New line · ${money(1500)}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'One less · PLA Silk Or' })).toBeDisabled(); // a new line is at least 1
    expect(screen.getByRole('searchbox', { name: 'Add an item · name or SKU in Zoho Books' })).toHaveValue('');
    await user.type(screen.getByRole('searchbox', { name: 'Add an item · name or SKU in Zoho Books' }), 'zz');
    expect(await screen.findByText('No item')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove the line · PLA Silk Or' }));
    expect(screen.queryByTestId('pack-qty-add-B')).not.toBeInTheDocument();
  });

  it('the bar lists the changes and the new total beside the old one; the payment card follows', async () => {
    const user = userEvent.setup();
    server.use(hits);
    render(<OrderLinesPanel row={panelRow({ payment: payment() }, two)} />);
    await openEdit(user);
    expect(screen.getByTestId('pay-left')).toHaveTextContent(money(6800));
    await user.click(screen.getByRole('button', { name: 'One more · Bambu Lab PLA Basic Noir' }));
    await addSilk(user);
    expect(screen.getByText('2 changes')).toBeInTheDocument();
    expect(screen.getByText(/Bambu Lab PLA Basic Noir: 2 → 3 · adds PLA Silk Or × 1/)).toBeInTheDocument();
    expect(screen.getByTestId('edit-total')).toHaveTextContent(money(3 * 3400 + 5000 + 1500));
    expect(screen.getByTestId('edit-total')).toHaveTextContent(`(was ${money(11800)})`);
    expect(screen.getByTestId('pay-left')).toHaveTextContent(money(3 * 3400 + 5000 + 1500 - 5000));
  });

  it('shows no total and keeps the payment card still when the estimate is impossible', async () => {
    const user = userEvent.setup();
    render(<OrderLinesPanel row={panelRow({ payment: payment(), estimable: false }, two)} />);
    await openEdit(user);
    await user.click(screen.getByRole('button', { name: 'One more · Bambu Lab PLA Basic Noir' }));
    expect(screen.queryByTestId('edit-total')).not.toBeInTheDocument();
    expect(screen.getByText('Total recalculated by Zoho Books on save')).toBeInTheDocument();
    expect(screen.getByTestId('pay-left')).toHaveTextContent(money(6800));
  });

  it('warns on a Shopify order and on an overpayment', async () => {
    const user = userEvent.setup();
    const facts = { ...panelRow().facts, channel: 'Shopify', reference: '1052', shopify_order: '1052' };
    render(<OrderLinesPanel row={panelRow({ payment: payment({ paid: 8000, advance: 8000, rest: 3800, left: 3800 }), facts }, two)} />);
    await openEdit(user);
    expect(screen.getByText('Shopify order: the shop is not updated.')).toBeInTheDocument();
    expect(screen.queryByText(/too much/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove the line · Bambu Lab PLA Basic Noir' }));
    expect(screen.getByText(`The customer paid ${money(3000)} too much: it stays as credit.`)).toBeInTheDocument();
    expect(screen.getByTestId('pay-left')).toHaveTextContent(`Credit left ${money(3000)}`);
  });

  it('saves the kept lines, the edited quantities and the new item, then shows the toast', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    server.use(hits, http.put(`${BASE}/lines`, async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json({ board: { rows: [], computed_at: null, stock_loaded_at: null, sync: {} }, row: null });
    }));
    render(<OrderLinesPanel row={panelRow({}, two)} />);
    await openEdit(user);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'One more · Bambu Lab PLA Basic Noir' }));
    await user.click(screen.getByRole('button', { name: 'Remove the line · Filament B' }));
    await addSilk(user);
    await user.dblClick(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Order SO-00412 updated in Zoho Books · 3 changes')).toBeInTheDocument();
    expect(bodies).toEqual([{ version: 'v1', lines: [{ line_id: 'l1', quantity: 3 }, { item_id: 'B', quantity: 1 }] }]);
    await waitFor(() => expect(screen.queryByRole('columnheader', { name: 'Ordered' })).not.toBeInTheDocument());
  });

  it('a quantity typed as 0 is never sent as 0', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    server.use(http.put(`${BASE}/lines`, async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json({ board: { rows: [], computed_at: null, stock_loaded_at: null, sync: {} }, row: null });
    }));
    render(<OrderLinesPanel row={panelRow({}, two)} />);
    await openEdit(user);
    await user.click(screen.getByRole('button', { name: 'One more · Bambu Lab PLA Basic Noir' }));
    await user.clear(qty('l1'));
    await user.type(qty('l1'), '0');
    await user.tab();
    expect(qty('l1')).toHaveValue(3); // the previous value comes back
    await user.clear(qty('l1'));
    await user.type(qty('l1'), '0.004'); // rounds to 0: held like a typed 0
    await user.tab();
    expect(qty('l1')).toHaveValue(3);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ version: 'v1', lines: [{ line_id: 'l1', quantity: 3 }, { line_id: 'l2', quantity: 5 }] });
  });

  it('a fractional quantity steps by one without crossing 0 and survives the field losing focus', async () => {
    const user = userEvent.setup();
    const rope = (id: string, quantity: number) => line({ id, item_id: id, name: `Corde ${id}`, quantity, remaining: quantity });
    render(<OrderLinesPanel row={panelRow({}, [rope('r1', 1.5), rope('r2', 0.5)])} />);
    await openEdit(user);
    await user.click(screen.getByRole('button', { name: 'One less · Corde r1' }));
    expect(qty('r1')).toHaveValue(0.5);
    expect(screen.getByRole('button', { name: 'One less · Corde r1' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'One less · Corde r2' })).toBeDisabled();
    await user.click(qty('r2'));
    await user.tab();
    expect(qty('r2')).toHaveValue(0.5);
    expect(screen.getByText(/Corde r1: 1.5 → 0.5/)).toBeInTheDocument();
    expect(screen.getByText('1 change')).toBeInTheDocument(); // r2 is untouched
  });

  it('a refused save (400 version) toasts the reason and keeps the edit open', async () => {
    const user = userEvent.setup();
    server.use(http.put(`${BASE}/lines`, () => HttpResponse.json({ detail: 'version' }, { status: 400 })));
    render(<OrderLinesPanel row={panelRow()} />);
    await openEdit(user);
    await user.click(screen.getByRole('button', { name: 'One more · Bambu Lab PLA Basic Noir' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Edit failed: the order changed in Books, look again')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Ordered' })).toBeInTheDocument();
    expect(qty('l1')).toHaveValue(3);
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('saves with the version the edit opened on, even after a refetch brought a newer one', async () => {
    const user = userEvent.setup();
    const bodies: { version: string }[] = [];
    server.use(http.put(`${BASE}/lines`, async ({ request }) => {
      bodies.push((await request.json()) as { version: string });
      return HttpResponse.json({ detail: 'version' }, { status: 400 });
    }));
    const view = render(<OrderLinesPanel row={panelRow()} />);
    await openEdit(user);
    await user.click(screen.getByRole('button', { name: 'One more · Bambu Lab PLA Basic Noir' }));
    view.rerender(<OrderLinesPanel row={panelRow({ version: 'v2' })} />); // a colleague saved in Books meanwhile
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].version).toBe('v1');
  });

  it('Escape and Annuler close the edit; the row icon does not open a check while editing', async () => {
    const user = userEvent.setup();
    let asked = 0;
    server.use(http.get(`${BASE}/picklist`, () => { asked += 1; return HttpResponse.json({ lines: [{ line_id: 'l1', quantity: 2 }] }); }));
    const view = render(<OrderLinesPanel row={panelRow()} start="pick" startTick={0} />);
    await waitFor(() => expect(asked).toBe(1));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await openEdit(user);
    view.rerender(<OrderLinesPanel row={panelRow()} start="pick" startTick={1} />);
    expect(screen.getByRole('columnheader', { name: 'Ordered' })).toBeInTheDocument();
    expect(asked).toBe(1);
    fireEvent.keyDown(qty('l1'), { key: 'Escape' });
    expect(screen.queryByRole('columnheader', { name: 'Ordered' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveFocus();
    await openEdit(user);
    expect(screen.queryByRole('button', { name: 'Prepare' })).not.toBeInTheDocument(); // one bar at a time
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('columnheader', { name: 'Ordered' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveFocus();
  });
});
