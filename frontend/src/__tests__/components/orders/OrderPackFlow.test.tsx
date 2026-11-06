/** The prep sheet band and the parcel check of an opened order. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
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
  id: 'l1', item_id: 'A', name: 'Bambu Lab PLA Basic Noir', sku: 'BL-PLA-BK', state: 'ready', quantity: 2, shipped: 0,
  cancelled: 0, remaining: 2, invoiced: 0, packed_waiting: 0, stock_available: 2, covered: 2, packable: 2, shortfall: 0,
  covered_by_po: 0, po_numbers: [], ...o,
});
const panelRow = (o: Partial<OrderPanelRow> = {}, lines = [line()]): OrderPanelRow => ({
  id: 'so1', number: 'SO-00412', customer: 'Lycée de Taravao', date: '2026-09-12', total: 13600, currency: 'XPF',
  age_days: 5, is_core: true, ready_ratio: 1, packed: 0, unbilled_units: 0, prep: null, customer_id: '', payment: null, contact: null,
  facts: { channel: '', reference: '', delivery_method: '', payment_terms: '', shopify_url: null, quote_url: null },
  units: { total: 2, shipped: 0, ready: 2, backordered: 0, to_order: 0 }, packages: [], lines,
  zoho_url: null, ...o,
});

const created = (board = {}) => ({ board: { rows: [], computed_at: null, stock_loaded_at: null, sync: {}, ...board }, package_number: 'PKG-7' });
const qty = (id = 'l1') => screen.getByTestId(`pack-qty-${id}`);

describe('the prep sheet band', () => {
  it('shows the sheet button only when something is packable, and Create parcel only with orders:update', () => {
    const first = render(<OrderLinesPanel row={panelRow()} />);
    expect(screen.getByRole('button', { name: 'Prep sheet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create parcel' })).toBeInTheDocument();
    first.unmount();
    mockUseAuth.hasPermission.mockImplementation(() => false);
    const second = render(<OrderLinesPanel row={panelRow()} />);
    expect(screen.getByRole('button', { name: 'Prep sheet' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create parcel' })).not.toBeInTheDocument();
    second.unmount();
    mockUseAuth.hasPermission.mockImplementation(() => true);
    render(<OrderLinesPanel row={panelRow({}, [line({ packable: 0 })])} />);
    expect(screen.queryByRole('button', { name: 'Prep sheet' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create parcel' })).not.toBeInTheDocument();
  });

  it('a printed order reads Printed at … by … and offers Reprint', () => {
    const at = '2026-11-06T18:30:00+00:00';
    const time = new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const first = render(<OrderLinesPanel row={panelRow({ prep: { at, by: 'Hina' } })} />);
    expect(screen.getByText(`Printed at ${time} by Hina`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reprint' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prep sheet' })).not.toBeInTheDocument();
    first.unmount();
    render(<OrderLinesPanel row={panelRow({ prep: { at, by: '' } })} />);
    expect(screen.getByText(`Printed at ${time}`)).toBeInTheDocument();
  });

  it('printing asks the order-board endpoint for the sheet', async () => {
    const user = userEvent.setup();
    let asked = 0;
    server.use(http.post('/api/v1/order-board/orders/so1/prep-sheet', () => { asked++; return new HttpResponse('%PDF', { headers: { 'Content-Type': 'application/pdf' } }); }));
    render(<OrderLinesPanel row={panelRow()} />);
    await user.click(screen.getByRole('button', { name: 'Prep sheet' }));
    await waitFor(() => expect(asked).toBe(1));
    expect(print).toHaveBeenCalledTimes(1);
  });
});

describe('the parcel check', () => {
  it('starts at the packable quantity and never leaves 0..packable', async () => {
    const user = userEvent.setup();
    render(<OrderLinesPanel row={panelRow()} />);
    await user.click(screen.getByRole('button', { name: 'Create parcel' }));
    expect(qty()).toHaveTextContent('2');
    expect(screen.queryByRole('button', { name: 'Prep sheet' })).not.toBeInTheDocument();
    for (let i = 0; i < 3; i++) await user.click(screen.getByRole('button', { name: /^One less/ }));
    expect(qty()).toHaveTextContent('0');
    for (let i = 0; i < 3; i++) await user.click(screen.getByRole('button', { name: /^One more/ }));
    expect(qty()).toHaveTextContent('2');
  });

  it('lines without packable units get no stepper, and the bar says what is left', async () => {
    const user = userEvent.setup();
    const lines = [line(), line({ id: 'l2', name: 'AMS', packable: 0, state: 'backorder', stock_available: 0 })];
    render(<OrderLinesPanel row={panelRow({}, lines)} />);
    await user.click(screen.getByRole('button', { name: 'Create parcel' }));
    expect(screen.queryByTestId('pack-qty-l2')).not.toBeInTheDocument();
    expect(screen.getByText(/Parcel: 2 of 2 in stock/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^One less/ }));
    expect(screen.getByText(/1 left to prepare/)).toBeInTheDocument();
  });

  it('a fractional maximum is sent as is', async () => {
    const user = userEvent.setup();
    let body: unknown;
    server.use(http.post('/api/v1/order-board/orders/so1/packages', async ({ request }) => { body = await request.json(); return HttpResponse.json(created()); }));
    render(<OrderLinesPanel row={panelRow({}, [line({ packable: 2.5, quantity: 2.5, remaining: 2.5 })])} />);
    await user.click(screen.getByRole('button', { name: 'Create parcel' }));
    await user.click(screen.getAllByRole('button', { name: 'Create parcel' })[0]);
    await waitFor(() => expect(body).toEqual({ lines: [{ line_id: 'l1', quantity: 2.5 }] }));
  });

  it('confirm sends only the lines above zero and closes on success with a toast', async () => {
    const user = userEvent.setup();
    let body: unknown;
    server.use(http.post('/api/v1/order-board/orders/so1/packages', async ({ request }) => { body = await request.json(); return HttpResponse.json(created()); }));
    render(<OrderLinesPanel row={panelRow({}, [line(), line({ id: 'l2', name: 'Filament B', packable: 1, quantity: 1, remaining: 1 })])} />);
    await user.click(screen.getByRole('button', { name: 'Create parcel' }));
    const lessButtons = screen.getAllByRole('button', { name: /^One less/ });
    await user.click(lessButtons[1]);
    await user.click(screen.getAllByRole('button', { name: 'Create parcel' })[0]);
    expect(await screen.findByText('Parcel PKG-7 created in Zoho Books')).toBeInTheDocument();
    expect(body).toEqual({ lines: [{ line_id: 'l1', quantity: 2 }] });
    expect(screen.queryByTestId('pack-qty-l1')).not.toBeInTheDocument();
  });

  it.each([
    [400, 'too_many', 'The order changed, check the quantities.'],
    [409, 'busy', 'The order changed, check the quantities.'],
    [503, 'unavailable', 'Zoho is busy, try again in a moment.'],
    [502, 'Books said no', 'The parcel could not be created: Books said no'],
  ])('a refused parcel (%i) keeps the check open and says why', async (status, detail, text) => {
    const user = userEvent.setup();
    server.use(http.post('/api/v1/order-board/orders/so1/packages', () => HttpResponse.json({ detail }, { status })));
    render(<OrderLinesPanel row={panelRow()} />);
    await user.click(screen.getByRole('button', { name: 'Create parcel' }));
    await user.click(screen.getAllByRole('button', { name: 'Create parcel' })[0]);
    const shown = await screen.findAllByText((_c, el) => (el?.textContent ?? '').includes(text) && el?.children.length === 0);
    expect(shown.length).toBeGreaterThan(0);
    expect(qty()).toBeInTheDocument();
  });

  it('cancel closes the check', async () => {
    const user = userEvent.setup();
    render(<OrderLinesPanel row={panelRow()} />);
    await user.click(screen.getByRole('button', { name: 'Create parcel' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('pack-qty-l1')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prep sheet' })).toBeInTheDocument();
  });

  it('walks a fractional maximum by one, clamped to 0..packable', async () => {
    const user = userEvent.setup();
    render(<OrderLinesPanel row={panelRow({}, [line({ packable: 2.5, quantity: 2.5, remaining: 2.5 })])} />);
    await user.click(screen.getByRole('button', { name: 'Create parcel' }));
    const walk = async (name: RegExp, expected: string[]) => {
      for (const v of expected) {
        await user.click(screen.getByRole('button', { name }));
        expect(qty()).toHaveTextContent(new RegExp(`^${v}$`));
      }
    };
    await walk(/^One less/, ['1.5', '0.5', '0']);
    await walk(/^One more/, ['1', '2', '2.5', '2.5']);
  });

  it('follows the live lines: capped, zeros dropped, counted and sent from the same values', async () => {
    const user = userEvent.setup();
    let body: unknown;
    server.use(http.post('/api/v1/order-board/orders/so1/packages', async ({ request }) => { body = await request.json(); return HttpResponse.json(created()); }));
    const two = [line(), line({ id: 'l2', name: 'Filament B', packable: 1, quantity: 1, remaining: 1 })];
    const view = render(<OrderLinesPanel row={panelRow({}, two)} />);
    await user.click(screen.getByRole('button', { name: 'Create parcel' }));
    expect(screen.getByText(/Parcel: 3 of 3 in stock/)).toBeInTheDocument();
    view.rerender(<OrderLinesPanel row={panelRow({}, [line({ packable: 1 }), line({ id: 'l2', name: 'Filament B', packable: 0, quantity: 1, remaining: 1 })])} />);
    expect(qty()).toHaveTextContent('1');
    expect(screen.queryByTestId('pack-qty-l2')).not.toBeInTheDocument();
    expect(screen.getByText(/Parcel: 1 of 1 in stock/)).toBeInTheDocument();
    expect(screen.queryByText(/left to prepare/)).not.toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Create parcel' })[0]);
    await waitFor(() => expect(body).toEqual({ lines: [{ line_id: 'l1', quantity: 1 }] }));
  });

  it('sends one request however often confirm is hit, and locks the steppers meanwhile', async () => {
    const user = userEvent.setup();
    let hits = 0;
    server.use(http.post('/api/v1/order-board/orders/so1/packages', async () => {
      hits++;
      await new Promise(r => setTimeout(r, 150));
      return HttpResponse.json(created());
    }));
    render(<OrderLinesPanel row={panelRow()} />);
    await user.click(screen.getByRole('button', { name: 'Create parcel' }));
    const confirm = screen.getAllByRole('button', { name: 'Create parcel' })[0];
    await user.click(confirm);
    await user.click(confirm);
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: /^One less/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^One more/ })).toBeDisabled();
    expect(await screen.findByText('Parcel PKG-7 created in Zoho Books')).toBeInTheDocument();
    expect(hits).toBe(1);
  });
});
