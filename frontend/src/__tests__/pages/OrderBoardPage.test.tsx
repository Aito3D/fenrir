/**
 * The Orders page: list states in the brief's sequence, the three filter
 * scopes, the "3D only" toggle and the grouped lines panel.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Link } from 'react-router-dom';
import { server } from '../mocks/server';
import type { FinishedOrderDetail, FinishedOrderRow, OrderPayment, OrderBoardLine, OrderBoardResponse, OrderBoardRow } from '../../api/client';

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

vi.mock('../../components/aito/usePrintBlob', () => ({ usePrintBlob: () => ({ print: (produce: () => Promise<Blob>) => produce(), busy: false }) }));

import { render } from '../utils';
import { OrderBoardPage } from '../../pages/OrderBoardPage';

afterEach(() => {
  server.resetHandlers();
  localStorage.clear();
  window.history.replaceState({}, '', '/'); // the filters live in the URL: never carry them into the next test
  mockUseAuth.hasPermission.mockImplementation(() => true);
});

const line = (o: Partial<OrderBoardLine> = {}): OrderBoardLine => ({
  id: 'l1', item_id: 'A', name: 'Bambu Lab PLA Basic Noir', sku: 'BL-PLA-BK', state: 'ready', quantity: 1, shipped: 0,
  cancelled: 0, remaining: 1, invoiced: 0, packed_waiting: 0, stock_available: 1, covered: 1, packable: 1, shortfall: 0, rate: 3400, floor: 0,
  covered_by_po: 0, po_numbers: [], ...o,
});

const row = (o: Partial<OrderBoardRow> = {}): OrderBoardRow => ({
  id: 'so1', number: 'SO-00412', customer: 'Lycée de Taravao', date: '2026-09-12', total: 13600, currency: 'XPF',
  status: 'to_ship', age_days: 54, is_core: true, ready_ratio: 1, packed: 0, unbilled_units: 0, prep: null, customer_id: '', payment: null, contact: null,
  facts: { channel: '', reference: '', shopify_order: '', quote_number: '', delivery_method: '', payment_terms: '', shopify_url: null, quote_url: null }, version: 'v1', estimable: true,
  units: { total: 1, shipped: 0, ready: 1, backordered: 0, to_order: 0 }, packages: [], lines: [line()],
  zoho_url: 'https://books.example/app/1#/salesorders/so1', ...o,
});

const ROWS = [
  row(),
  row({ id: 'so2', number: 'SO-00418', customer: 'Atelier Moana', status: 'partial', age_days: 34, total: 24750, ready_ratio: 0.5 }),
  row({ id: 'so3', number: 'SO-00421', customer: 'Tahiti Nautic Center', status: 'to_ship', is_core: false, age_days: 27, total: 61200,
        lines: [line({ name: 'Marlow Excel Racing', sku: 'MA-EXR-5' })] }),
];

const board = (o: Partial<OrderBoardResponse> = {}, sync: Partial<OrderBoardResponse['sync']> = {}): OrderBoardResponse => ({
  rows: ROWS, computed_at: '2026-11-05T19:42:00+00:00', stock_loaded_at: '2026-11-05T19:42:00+00:00',
  sync: { enabled: true, configured: true, running: false, pending: 0, last_error: null, last_error_at: null,
          last_success_at: '2026-11-05T19:42:00+00:00', ...sync },
  ...o,
});

const serve = (payload: OrderBoardResponse) =>
  server.use(http.get('/api/v1/order-board', () => HttpResponse.json(payload)));

const pay = (o: Partial<OrderPayment> = {}): OrderPayment => ({
  state: 'unpaid', pct: 0, paid: 0, invoice_paid: 0, retainer: 0, advance: 0, due: 0, overdue: 0, rest: 100, left: 100, next_due: null, invoices: [], ...o,
});

const fin = (n: number, o: Partial<FinishedOrderRow> = {}): FinishedOrderRow => ({
  id: `f${n}`, number: `SO-F${String(n).padStart(3, '0')}`, customer: `Client ${n}`, date: '2026-08-01', total: 5000, currency: 'XPF',
  reference: '', paid_flag: null, payment: null, is_core: null, zoho_url: null, ...o,
});

const serveFinished = (rows: FinishedOrderRow[], detail?: () => Response | Promise<Response>) =>
  server.use(
    http.get('/api/v1/order-board/finished', () => HttpResponse.json({ rows })),
    http.get('/api/v1/order-board/finished/:id', detail ?? (({ params }) => {
      const r = rows.find(x => x.id === params.id)!;
      const d: FinishedOrderDetail = { ...row({ id: r.id, number: r.number, customer: r.customer }), status: 'finished',
        contact: { name: 'Intendance', email: '', phone: '40 54 71 00', mobile: '' }, payment: pay({ state: 'partial', pct: 40, paid: 40, left: 60 }) };
      return HttpResponse.json(d);
    })),
  );

const tile = (name: RegExp) => screen.getByRole('button', { name });

describe('OrderBoardPage', () => {
  it('shows skeletons and the first-sync line on a cold start, never an empty board', async () => {
    serve(board({ rows: [], computed_at: null, stock_loaded_at: null }, { pending: 54, running: true }));
    render(<OrderBoardPage />);
    expect(await screen.findByText('First sync in progress — 54 documents remaining')).toBeInTheDocument();
    expect(screen.getByText('Syncing · 54 remaining')).toBeInTheDocument();
    expect(screen.queryByText('No open orders.')).not.toBeInTheDocument();
    expect(screen.getByTestId('orders-tiles')).not.toHaveTextContent(/\d/);
  });

  it('says sync is off instead of loading forever', async () => {
    serve(board({ rows: [], computed_at: null, stock_loaded_at: null }, { enabled: false }));
    render(<OrderBoardPage />);
    expect(await screen.findByText('Order sync is off.')).toBeInTheDocument();
  });

  it('says Zoho is not connected', async () => {
    serve(board({ rows: [], computed_at: null, stock_loaded_at: null }, { configured: false }));
    render(<OrderBoardPage />);
    expect(await screen.findByText('Zoho Books is not connected.')).toBeInTheDocument();
  });

  it('lists orders; tiles ignore the search, chips follow it, the list follows both', async () => {
    const user = userEvent.setup();
    serve(board());
    render(<OrderBoardPage />);
    expect(await screen.findByText('SO-00412')).toBeInTheDocument();
    expect(screen.getByText('SO-00418')).toBeInTheDocument();
    expect(screen.queryByText('SO-00421')).not.toBeInTheDocument(); // not a core brand
    expect(tile(/^To ship 1 13.600/)).toBeInTheDocument();
    expect(tile(/^In progress 2/)).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Order number, customer, product, SKU…'), 'moana');
    expect(screen.queryByText('SO-00412')).not.toBeInTheDocument();
    expect(tile(/^To ship 1 13.600/)).toBeInTheDocument(); // tiles unchanged
    expect(screen.getByRole('button', { name: 'To ship 0' })).toBeInTheDocument(); // chip follows the search
    expect(screen.getByRole('button', { name: 'Partial 1' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'To ship 0' }));
    expect(await screen.findByText('No results.')).toBeInTheDocument();
  });

  it('a tile sets the status filter and the In progress tile clears it', async () => {
    const user = userEvent.setup();
    serve(board());
    render(<OrderBoardPage />);
    await screen.findByText('SO-00412');
    await user.click(tile(/^Partial 1 partly/));
    expect(screen.queryByText('SO-00412')).not.toBeInTheDocument();
    expect(screen.getByText('SO-00418')).toBeInTheDocument();
    await user.click(tile(/^In progress 2/));
    expect(screen.getByText('SO-00412')).toBeInTheDocument();
  });

  it('3D only hides non-core orders, shows the hidden count and remembers the choice', async () => {
    const user = userEvent.setup();
    serve(board());
    render(<OrderBoardPage />);
    await screen.findByText('SO-00412');
    const toggle = screen.getByRole('button', { name: /3D only/ });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle).toHaveTextContent('+1 hidden');
    await user.click(toggle);
    expect(screen.getByText('SO-00421')).toBeInTheDocument();
    expect(toggle).not.toHaveTextContent('hidden');
    expect(localStorage.getItem('orders.coreOnly')).toBe('false');
  });

  it('starts with 3D only off when that was the last choice', async () => {
    localStorage.setItem('orders.coreOnly', 'false');
    serve(board());
    render(<OrderBoardPage />);
    expect(await screen.findByText('SO-00421')).toBeInTheDocument();
  });

  it('sorts by age oldest first and flips on a second click', async () => {
    const user = userEvent.setup();
    serve(board());
    render(<OrderBoardPage />);
    await screen.findByText('SO-00412');
    const numbers = () => screen.getAllByTestId('order-number').map(n => n.textContent);
    expect(numbers()).toEqual(['SO-00412', 'SO-00418']);
    await user.click(screen.getByRole('button', { name: /^Age/ }));
    expect(numbers()).toEqual(['SO-00418', 'SO-00412']);
    await user.click(screen.getByRole('button', { name: /^Value/ }));
    expect(numbers()).toEqual(['SO-00418', 'SO-00412']); // 24 750 before 13 600
  });

  it('the filters are mirrored into the URL with replace, defaults left out and ?order= kept', async () => {
    const user = userEvent.setup();
    window.history.pushState({}, '', '/orders?order=nope');
    const entries = window.history.length;
    serve(board());
    render(<OrderBoardPage />);
    await screen.findByText('SO-00412');
    expect(window.location.search).toBe('?order=nope');
    await user.type(screen.getByPlaceholderText('Order number, customer, product, SKU…'), 'moana');
    await user.click(screen.getByRole('button', { name: 'Partial 1' }));
    await user.click(screen.getByRole('button', { name: /^Value/ }));
    await user.click(screen.getByRole('button', { name: /^Value/ }));
    await user.click(screen.getByRole('button', { name: /^Unpaid/ }));
    const params = new URLSearchParams(window.location.search);
    expect(Object.fromEntries(params)).toEqual({ order: 'nope', q: 'moana', status: 'partial', sort: 'value', flip: '1', pay: 'unpaid' });
    expect(window.history.length).toBe(entries); // replace: typing does not fill the history
    await user.clear(screen.getByPlaceholderText('Order number, customer, product, SKU…'));
    await user.click(screen.getByRole('button', { name: /^All/ }));
    await user.click(screen.getByRole('button', { name: /^Age/ }));
    await user.click(screen.getByRole('button', { name: /^Any payment/ }));
    expect(window.location.search).toBe('?order=nope');
  });

  it('a URL with filters opens the board with them set', async () => {
    window.history.pushState({}, '', '/orders?q=moana&status=partial&sort=value&flip=1&pay=bogus');
    serve(board());
    render(<OrderBoardPage />);
    expect(await screen.findByText('SO-00418')).toBeInTheDocument();
    expect(screen.queryByText('SO-00412')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Order number, customer, product, SKU…')).toHaveValue('moana');
    expect(screen.getByRole('button', { name: 'Partial 1' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^Value/ })).toHaveTextContent('↑');
    expect(screen.getByRole('button', { name: /^Any payment/ })).toHaveAttribute('aria-pressed', 'true'); // an unknown value is the default
    expect(new URLSearchParams(window.location.search).get('pay')).toBeNull();
  });

  it('a link to bare /orders clears the filters instead of writing them back', async () => {
    const user = userEvent.setup();
    window.history.pushState({}, '', '/orders?status=partial&q=moana');
    serve(board());
    render(<><Link to="/orders">Orders link</Link><OrderBoardPage /></>);
    await screen.findByText('SO-00418');
    await user.click(screen.getByRole('link', { name: 'Orders link' }));
    expect(await screen.findByText('SO-00412')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Order number, customer, product, SKU…')).toHaveValue('');
    expect(screen.getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true');
    expect(window.location.search).toBe('');
  });

  it('back and forward bring the filters of that history entry back', async () => {
    const user = userEvent.setup();
    window.history.pushState({}, '', '/orders?status=partial');
    serve(board());
    render(<><Link to="/orders?sort=value">Sorted link</Link><OrderBoardPage /></>);
    await screen.findByText('SO-00418');
    await user.click(screen.getByRole('link', { name: 'Sorted link' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Value/ })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByText('SO-00412')).toBeInTheDocument();
    act(() => window.history.back());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Partial 1' })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.queryByText('SO-00412')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Age/ })).toHaveAttribute('aria-pressed', 'true');
    act(() => window.history.forward());
    await waitFor(() => expect(screen.getByRole('button', { name: /^Value/ })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByText('SO-00412')).toBeInTheDocument();
  });

  it('shows the failure notice over the last board', async () => {
    serve(board({}, { last_error: 'Zoho rate limit reached' }));
    render(<OrderBoardPage />);
    expect(await screen.findByText(/Last sync failed: Zoho rate limit reached — showing data from/)).toBeInTheDocument();
    expect(screen.getByText('SO-00412')).toBeInTheDocument();
  });

  it('expands a card into grouped lines, a partly shipped product in two groups', async () => {
    const user = userEvent.setup();
    serve(board({
      rows: [row({
        status: 'partial', packed: 2,
        units: { total: 12, shipped: 6, ready: 4, backordered: 2, to_order: 0 }, ready_ratio: 4 / 6,
        packages: [
          { id: 'pk31', shipment_id: 'sh31', number: 'PKG-00031', status: 'delivered', date: '2026-10-28' },
          { id: 'pk34', shipment_id: '', number: 'PKG-00034', status: 'not_shipped', date: '2026-11-04' },
        ],
        lines: [
          line({ id: 'ams', name: 'Bambu Lab AMS Lite', sku: 'BL-AMS', state: 'backorder', quantity: 6, shipped: 2, remaining: 4,
                 stock_available: 2, covered: 2, shortfall: 2, covered_by_po: 2, po_numbers: ['PO-0015'] }),
          line({ id: 'petg', name: 'eSUN PETG Blanc', sku: 'ES-PETG', state: 'shipped', quantity: 4, shipped: 4, remaining: 0 }),
          line({ id: 'asa', name: 'Polymaker ASA Gris', sku: 'PM-ASA', state: 'ready', quantity: 2, remaining: 2, packed_waiting: 2 }),
          line({ id: 'ship', name: 'Livraison Avion', sku: '', state: 'service', item_id: null, stock_available: null }),
        ],
      })],
    }));
    render(<OrderBoardPage />);
    const card = await screen.findByRole('button', { name: /SO-00412/ });
    expect(card).toHaveAttribute('aria-expanded', 'false');
    expect(card).toHaveTextContent('6/12 shipped · 2 packed');
    expect(card).toHaveTextContent('67 % ready');
    await user.click(card);
    expect(card).toHaveAttribute('aria-expanded', 'true');

    const panel = screen.getByRole('table');
    // Group headers are row headers, so they cannot be mistaken for product rows.
    const shortDay = (m: number, d: number) => new Date(2026, m, d, 12).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    expect(within(panel).getByRole('rowheader', { name: /^To prepare 4 units/ })).toBeInTheDocument();
    expect(within(panel).getByRole('rowheader', { name: /^Packed, awaiting delivery 2 units/ })).toHaveTextContent(`PKG-00034 · packed ${shortDay(10, 4)}`);
    expect(within(panel).getByRole('rowheader', { name: /^Shipped 6 units/ })).toHaveTextContent(`PKG-00031 · delivered ${shortDay(9, 28)}`);
    expect(within(panel).getByRole('rowheader', { name: /^Other lines/ })).toBeInTheDocument();
    expect(within(panel).getAllByText('Bambu Lab AMS Lite')).toHaveLength(2);
    expect(within(panel).getByText('PO-0015 · +2')).toBeInTheDocument();
    expect(within(panel).getByText('−2')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Zoho Books · SO-00412/ })).toHaveAttribute('href', 'https://books.example/app/1#/salesorders/so1');
  });

  it('shows a payment pill per row: Unpaid, 40% paid, Paid, and a dash without a total', async () => {
    const p = (o: Partial<OrderPayment>): OrderPayment => ({ state: 'unpaid', pct: 0, paid: 0, invoice_paid: 0, retainer: 0, advance: 0, due: 0, overdue: 0, rest: 100, left: 100, next_due: null, invoices: [], ...o });
    serve(board({ rows: [
      row({ id: 'a', number: 'SO-A', payment: p({}) }),
      row({ id: 'b', number: 'SO-B', payment: p({ state: 'partial', pct: 40, paid: 40, left: 60 }) }),
      row({ id: 'c', number: 'SO-C', payment: p({ state: 'paid', pct: 100, paid: 100, left: 0, rest: 0 }) }),
      row({ id: 'd', number: 'SO-D', total: null, payment: null }),
    ] }));
    render(<OrderBoardPage />);
    await screen.findByText('SO-A');
    const cell = (n: string) => screen.getByRole('button', { name: new RegExp(n) });
    expect(cell('SO-A')).toHaveTextContent('Unpaid');
    expect(cell('SO-B')).toHaveTextContent('40% paid');
    expect(cell('SO-C')).toHaveTextContent('Paid');
    expect(within(cell('SO-D')).getByTestId('order-pay')).toHaveTextContent('–');
  });

  it('an opened order shows contact and payment', async () => {
    const user = userEvent.setup();
    serve(board({ rows: [row({
      contact: { name: 'Intendance', email: '', phone: '40 54 71 00', mobile: '' },
      payment: { state: 'unpaid', pct: 0, paid: 0, invoice_paid: 0, retainer: 0, advance: 0, due: 0, overdue: 0, rest: 13600, left: 13600, next_due: null, invoices: [] },
    })] }));
    render(<OrderBoardPage />);
    await user.click(await screen.findByRole('button', { name: /SO-00412/ }));
    expect(screen.getByText('Intendance')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '40 54 71 00' })).toHaveAttribute('href', 'tel:40547100');
    expect(screen.getByText('Left to pay')).toBeInTheDocument();
  });

  it('prints a fractional quantity and a dash for an unknown value', async () => {
    const user = userEvent.setup();
    serve(board({ rows: [row({ total: null, lines: [line({ quantity: 2.5, remaining: 2.5, stock_available: 4.5 })] })] }));
    render(<OrderBoardPage />);
    const card = await screen.findByRole('button', { name: /SO-00412/ });
    expect(within(card).getByTestId('order-value')).toHaveTextContent('–');
    await user.click(card);
    expect(within(screen.getByRole('table')).getByText('2.5')).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('4.5')).toBeInTheDocument();
  });

  it('says there are no open orders', async () => {
    serve(board({ rows: [] }));
    render(<OrderBoardPage />);
    expect(await screen.findByText('No open orders.')).toBeInTheDocument();
  });

  it('says there are no open 3D orders when the toggle hides everything', async () => {
    serve(board({ rows: [ROWS[2]] }));
    render(<OrderBoardPage />);
    expect(await screen.findByText('No open 3D orders.')).toBeInTheDocument();
  });

  it('hides Refresh without orders:update', async () => {
    mockUseAuth.hasPermission.mockImplementation((p: string) => p !== 'orders:update');
    serve(board());
    render(<OrderBoardPage />);
    await screen.findByText('SO-00412');
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
  });

  it('Refresh asks the server for one pass and shows what comes back', async () => {
    const user = userEvent.setup();
    let posts = 0;
    serve(board());
    server.use(http.post('/api/v1/order-board/refresh', () => {
      posts += 1;
      return HttpResponse.json(board({ rows: [row({ number: 'SO-00999' })] }));
    }));
    render(<OrderBoardPage />);
    await screen.findByText('SO-00412');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('SO-00999')).toBeInTheDocument();
    expect(posts).toBe(1);
  });

  it('a load error offers Retry', async () => {
    const user = userEvent.setup();
    let fail = true;
    server.use(http.get('/api/v1/order-board', () => (fail ? HttpResponse.json({ detail: 'boom' }, { status: 500 }) : HttpResponse.json(board()))));
    render(<OrderBoardPage />);
    expect(await screen.findByText('Could not load the order board.')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('SO-00412')).toBeInTheDocument());
  });

  it('payment chips filter the list and count over the search', async () => {
    const user = userEvent.setup();
    serve(board({ rows: [
      row({ id: 'a', number: 'SO-A', payment: pay() }),
      row({ id: 'b', number: 'SO-B', payment: pay({ state: 'partial', pct: 40 }) }),
      row({ id: 'c', number: 'SO-C', payment: pay({ state: 'paid', pct: 100 }) }),
    ] }));
    render(<OrderBoardPage />);
    await screen.findByText('SO-A');
    expect(screen.getByRole('button', { name: 'Any payment 3' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Paid 1' }));
    expect(screen.getByRole('button', { name: 'Paid 1' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('SO-A')).not.toBeInTheDocument();
    expect(screen.getByText('SO-C')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('Order number, customer, product, SKU…'), 'SO-B');
    expect(screen.getByRole('button', { name: 'Paid 0' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Partially paid 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Any payment 1' })).toBeInTheDocument();
  });

  it('the Overdue chip appears only when an order is overdue', async () => {
    serve(board({ rows: [row({ id: 'a', number: 'SO-A', payment: pay() })] }));
    const first = render(<OrderBoardPage />);
    await screen.findByText('SO-A');
    expect(screen.queryByRole('button', { name: /^Overdue/ })).not.toBeInTheDocument();
    first.unmount();
    serve(board({ rows: [row({ id: 'a', number: 'SO-A', payment: pay({ overdue: 50 }) })] }));
    render(<OrderBoardPage />);
    expect(await screen.findByRole('button', { name: 'Overdue 1' })).toBeInTheDocument();
  });

  it('the In progress tile shows the share paid', async () => {
    serve(board({ rows: [row({ total: 100, payment: pay({ state: 'partial', pct: 29, paid: 29 }) })] }));
    render(<OrderBoardPage />);
    await screen.findByText('SO-00412');
    expect(tile(/^In progress 1/)).toHaveTextContent('29% paid');
  });

  it('the To ship tile adds up its own orders and their share paid, and keeps its meaning as a tooltip', async () => {
    serve(board({ rows: [
      row({ id: 'a', status: 'to_ship', total: 100, payment: pay({ state: 'partial', pct: 29, paid: 29 }) }),
      row({ id: 'b', number: 'SO-B', status: 'to_ship', total: 300, payment: pay({ state: 'paid', pct: 100, paid: 300 }) }),
      row({ id: 'c', number: 'SO-C', status: 'to_order', total: 5000 }),
    ] }));
    render(<OrderBoardPage />);
    await screen.findByText('SO-B');
    const toShip = tile(/^To ship 2 400/); // the chip is only "To ship 2"
    expect(toShip).toHaveTextContent(/400.*82% paid/);
    expect(toShip).not.toHaveTextContent('5');
    expect(toShip).toHaveAttribute('title', 'everything in stock');
  });

  it('an empty To ship tile keeps its plain hint', async () => {
    serve(board({ rows: [row({ status: 'to_order' })] }));
    render(<OrderBoardPage />);
    await screen.findByText('SO-00412');
    expect(tile(/^To ship 0 everything in stock/)).toBeInTheDocument();
  });

  it('"Also open for this customer" lands on the order even when 3D only hid it', async () => {
    const user = userEvent.setup();
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    serve(board({ rows: [
      row({ customer_id: 'c1', contact: { name: 'Intendance', email: '', phone: '', mobile: '' } }),
      row({ id: 'so3', number: 'SO-00421', customer_id: 'c1', is_core: false }),
    ] }));
    render(<OrderBoardPage />);
    await user.click(await screen.findByRole('button', { name: /SO-00412/ }));
    expect(screen.queryByRole('button', { name: /SO-00421 / })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'SO-00421' }));
    expect(await screen.findByRole('button', { name: /SO-00421 / })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /3D only/ })).toHaveAttribute('aria-pressed', 'false');
    expect(localStorage.getItem('orders.coreOnly')).toBeNull(); // this visit only
    expect(scroll).toHaveBeenCalled();
  });

  it('All mixes finished orders into the list, 50 at a time; a status chip leaves them out', async () => {
    const user = userEvent.setup();
    serve(board());
    serveFinished(Array.from({ length: 60 }, (_, i) => fin(i + 1)));
    render(<OrderBoardPage />);
    expect(await screen.findByText('SO-F001')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All 62' })).toBeInTheDocument();
    expect(screen.getAllByTestId('order-number')).toHaveLength(50);
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getAllByTestId('order-number')).toHaveLength(62);
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'To ship 1' }));
    expect(screen.queryByText('SO-F001')).not.toBeInTheDocument();
    expect(screen.getByText('SO-00412')).toBeInTheDocument();
  });

  it('finished orders take their place in every sort, with no separation', async () => {
    const user = userEvent.setup();
    serve(board());
    serveFinished([fin(1, { date: '2026-03-01', total: 5000 }), fin(2, { date: new Date().toISOString().slice(0, 10), total: 1 })]);
    render(<OrderBoardPage />);
    await screen.findByText('SO-F001');
    const numbers = () => screen.getAllByTestId('order-number').map(n => n.textContent);
    expect(numbers()[0]).toBe('SO-F001'); // oldest first
    expect(numbers().at(-1)).toBe('SO-F002');
    await user.click(screen.getByRole('button', { name: /^Value/ }));
    expect(numbers().slice(-2)).toEqual(['SO-F001', 'SO-F002']); // 5 000 and 1 sit below the open orders
  });

  it('Hide finished takes them off the list and is remembered', async () => {
    const user = userEvent.setup();
    serve(board());
    serveFinished([fin(1)]);
    render(<OrderBoardPage />);
    await screen.findByText('SO-F001');
    await user.click(screen.getByRole('button', { name: 'Hide finished' }));
    expect(screen.queryByText('SO-F001')).not.toBeInTheDocument();
    expect(screen.getByText('SO-00412')).toBeInTheDocument();
    expect(localStorage.getItem('orders.hideFinished')).toBe('true');
  });

  it('the search reaches finished orders', async () => {
    const user = userEvent.setup();
    serve(board());
    serveFinished([fin(1, { customer: 'Zorglub' }), fin(2)]);
    render(<OrderBoardPage />);
    await screen.findByText('SO-F002');
    await user.type(screen.getByPlaceholderText('Order number, customer, product, SKU…'), 'zorglub');
    expect(screen.getAllByTestId('order-number').map(n => n.textContent)).toEqual(['SO-F001']);
  });

  it('3D only filters finished orders too, keeping the ones the server cannot place', async () => {
    const user = userEvent.setup();
    serve(board());
    serveFinished([fin(1, { is_core: true }), fin(2, { is_core: false }), fin(3, { is_core: null })]);
    render(<OrderBoardPage />);
    await screen.findByText('SO-F001');
    expect(screen.getByText('SO-F003')).toBeInTheDocument();
    expect(screen.queryByText('SO-F002')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All 4' })).toBeInTheDocument(); // 2 open + 2 finished
    await user.click(screen.getByRole('button', { name: /3D only/ }));
    expect(screen.getByText('SO-F002')).toBeInTheDocument();
  });

  it('a finished row shows the Zoho flag until opened, then the percentage', async () => {
    const user = userEvent.setup();
    serve(board());
    serveFinished([fin(1, { paid_flag: 'partial' })]);
    render(<OrderBoardPage />);
    const card = await screen.findByRole('button', { name: /SO-F001/ });
    expect(within(card).getByTestId('order-pay')).toHaveTextContent('Partially paid');
    await user.click(card);
    await waitFor(() => expect(within(card).getByTestId('order-pay')).toHaveTextContent('40% paid'));
  });

  it('opening a finished order shows a loader, then its lines, contact and payment', async () => {
    const user = userEvent.setup();
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    serve(board());
    serveFinished([fin(1)], async () => {
      await gate;
      return HttpResponse.json({ ...row({ id: 'f1', number: 'SO-F001', contact: { name: 'Intendance', email: '', phone: '', mobile: '' },
        payment: pay({ left: 100 }) }), status: 'finished' });
    });
    render(<OrderBoardPage />);
    await user.click(await screen.findByRole('button', { name: /SO-F001/ }));
    expect(screen.getByText('Loading this order from Zoho…')).toBeInTheDocument();
    release();
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.getByText('Intendance')).toBeInTheDocument();
    expect(screen.getByText('Left to pay')).toBeInTheDocument();
  });

  it('Refresh reloads the finished list but not the finished orders already opened', async () => {
    const user = userEvent.setup();
    let lists = 0;
    let details = 0;
    serve(board());
    serveFinished([fin(1)]);
    server.use(
      http.get('/api/v1/order-board/finished', () => { lists += 1; return HttpResponse.json({ rows: [fin(1)] }); }),
      http.get('/api/v1/order-board/finished/:id', () => {
        details += 1;
        return HttpResponse.json({ ...row({ id: 'f1', number: 'SO-F001' }), status: 'finished' });
      }),
      http.post('/api/v1/order-board/refresh', () => HttpResponse.json(board())),
    );
    render(<OrderBoardPage />);
    await user.click(await screen.findByRole('button', { name: /SO-F001/ }));
    await screen.findByRole('table');
    expect(details).toBe(1);
    const listsBefore = lists;
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(lists).toBe(listsBefore + 1));
    expect(details).toBe(1);
  });

  it('a finished order that cannot load offers Retry', async () => {
    const user = userEvent.setup();
    let fail = true;
    serve(board());
    serveFinished([fin(1)], () => (fail ? HttpResponse.json({ detail: 'down' }, { status: 502 }) : HttpResponse.json({
      ...row({ id: 'f1', number: 'SO-F001' }), status: 'finished' })));
    render(<OrderBoardPage />);
    await user.click(await screen.findByRole('button', { name: /SO-F001/ }));
    expect(await screen.findByText('Could not load this order from Zoho.')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('a finished order refused because Zoho is busy says so and tries again by itself', async () => {
    const user = userEvent.setup();
    serve(board());
    serveFinished([fin(1)], () => HttpResponse.json({ detail: 'Zoho is busy, try again shortly.' }, { status: 503 }));
    render(<OrderBoardPage />);
    await user.click(await screen.findByRole('button', { name: /SO-F001/ }));
    expect(await screen.findByText('Zoho is busy, trying again…')).toBeInTheDocument();
    expect(screen.queryByText('Could not load this order from Zoho.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('OrderBoardPage actions', () => {
  it('the prepare icon opens its order on the choice of what to pick', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/v1/order-board', () => HttpResponse.json(board({ rows: [row()] }))),
      http.get('/api/v1/order-board/orders/so1/picklist', () => HttpResponse.json({ lines: [{ line_id: row().lines[0].id, quantity: 1 }] })),
    );
    render(<OrderBoardPage />);
    await screen.findByText('SO-00412');
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    expect(await screen.findByRole('columnheader', { name: 'To pick' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create and print' })).toBeInTheDocument();
  });

  it('the hand icon opens its order', async () => {
    const user = userEvent.setup();
    serve(board({ rows: [row({ packages: [{ id: 'p9', shipment_id: 's9', number: 'PKG-9', status: 'not_shipped', date: '2026-11-05' }], lines: [line({ packable: 0, packed_waiting: 1 })] })] }));
    render(<OrderBoardPage />);
    await screen.findByText('SO-00412');
    await user.click(screen.getByRole('button', { name: 'Hand over the parcel' }));
    expect(screen.getByRole('button', { name: /SO-00412/, expanded: true })).toBeInTheDocument();
  });
  it('?order= opens and scrolls to that order once; closing it does not reopen it, an unknown id does nothing', async () => {
    const user = userEvent.setup();
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    window.history.pushState({}, '', '/orders?order=so2');
    serve(board());
    const view = render(<OrderBoardPage />);
    const card = await screen.findByRole('button', { name: /SO-00418/, expanded: true });
    expect(scroll).toHaveBeenCalled();
    expect(window.location.search).toBe('?order=so2');
    await user.click(card);
    expect(screen.getByRole('button', { name: /SO-00418/, expanded: false })).toBeInTheDocument();
    view.unmount();
    window.history.pushState({}, '', '/orders?order=nope');
    render(<OrderBoardPage />);
    await screen.findByText('SO-00412');
    expect(screen.queryAllByRole('button', { expanded: true })).toHaveLength(0);
    window.history.pushState({}, '', '/');
  });

  it('a second click on the hand icon reopens a cancelled bar', async () => {
    const user = userEvent.setup();
    const waiting = row({ packages: [{ id: 'p9', shipment_id: 's9', number: 'PKG-9', status: 'not_shipped', date: '2026-11-05' }], lines: [line({ packable: 0, packed_waiting: 1 })] });
    serve(board({ rows: [waiting] }));
    server.use(http.get('/api/v1/order-board/orders/so1/packages/p9/handover', () => HttpResponse.json({ units: 1, available: false, to_invoice: false, invoice_total: null, manual: false, manual_reason: null, credit: 0, covered_by: [] })));
    render(<OrderBoardPage />);
    await screen.findByText('SO-00412');
    await user.click(screen.getByRole('button', { name: 'Hand over the parcel' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Handed to the customer' })).not.toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Hand over the parcel' })[0]); // the row icon; the band has one too
    expect(await screen.findByRole('button', { name: 'Handed to the customer' })).toBeInTheDocument();
  });
  it('a ?order= link that arrives while the board is loading opens the order once it is ready', async () => {
    window.history.pushState({}, '', '/orders?order=so2');
    server.use(http.get('/api/v1/order-board', async () => { await new Promise(r => setTimeout(r, 200)); return HttpResponse.json(board()); }));
    render(<OrderBoardPage />);
    expect(screen.queryByText('SO-00418')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /SO-00418/, expanded: true })).toBeInTheDocument();
    window.history.pushState({}, '', '/');
  });

  it('navigating to another ?order= while mounted opens that order; a closed one is not reopened', async () => {
    const user = userEvent.setup();
    window.history.pushState({}, '', '/orders?order=so2');
    serve(board());
    render(<OrderBoardPage />);
    const first = await screen.findByRole('button', { name: /SO-00418/, expanded: true });
    await user.click(first);
    act(() => {
      window.history.pushState({}, '', '/orders?order=so3');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(await screen.findByRole('button', { name: /SO-00421/, expanded: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /SO-00418/, expanded: false })).toBeInTheDocument();
    window.history.pushState({}, '', '/');
  });

  it('the row hand icon is disabled while a hand-over of that order is in flight', async () => {
    const user = userEvent.setup();
    let hits = 0;
    const waiting = row({ packages: [{ id: 'p9', shipment_id: 's9', number: 'PKG-9', status: 'not_shipped', date: '2026-11-05' }], lines: [line({ packable: 0, packed_waiting: 1 })] });
    serve(board({ rows: [waiting] }));
    server.use(
      http.get('/api/v1/order-board/orders/so1/packages/p9/handover', () => HttpResponse.json({ units: 1, available: false, to_invoice: false, invoice_total: null, manual: false, manual_reason: null, credit: 0, covered_by: [] })),
      http.post('/api/v1/order-board/orders/so1/packages/p9/handover', async () => { hits++; await new Promise(r => setTimeout(r, 300)); return HttpResponse.json({ board: board({ rows: [] }), outcome: { package_number: 'PKG-9', shipment: 'done', delivered: 'done', invoice: 'none', invoice_number: null, manual_reason: null, credit_applied: 0, failed_step: null, error: null } }); }),
    );
    render(<OrderBoardPage />);
    await screen.findByText('SO-00412');
    await user.click(screen.getByRole('button', { name: 'Hand over the parcel' }));
    await user.click(await screen.findByRole('button', { name: 'Handed to the customer' }));
    const icon = screen.getByRole('button', { name: 'Hand over the parcel' });
    expect(icon).toBeDisabled();
    fireEvent.click(icon);
    expect(screen.getByRole('button', { name: 'Sending to Zoho…' })).toBeDisabled();
    await waitFor(() => expect(hits).toBe(1));
  });

  it('Create invoice on a finished order posts to the invoice endpoint and refetches its detail', async () => {
    const user = userEvent.setup();
    let details = 0;
    let posts = 0;
    serve(board());
    server.use(
      http.get('/api/v1/order-board/finished', () => HttpResponse.json({ rows: [fin(1)] })),
      http.get('/api/v1/order-board/finished/:id', () => {
        details += 1;
        return HttpResponse.json({ ...row({ id: 'f1', number: 'SO-F001', unbilled_units: 1 }), status: 'finished' });
      }),
      http.post('/api/v1/order-board/orders/f1/invoice', () => {
        posts += 1;
        return HttpResponse.json({ board: board(), outcome: { package_number: '', shipment: 'skipped', delivered: 'skipped', invoice: 'created', invoice_number: 'FAC-9', manual_reason: null, credit_applied: 0, failed_step: null, error: null } });
      }),
    );
    render(<OrderBoardPage />);
    await user.click(await screen.findByRole('button', { name: /SO-F001/ }));
    await user.click(await screen.findByRole('button', { name: 'Create invoice' }));
    expect(await screen.findByText('Invoice FAC-9 created')).toBeInTheDocument();
    expect(posts).toBe(1);
    await waitFor(() => expect(details).toBe(2));
  });

  it('a refused hand-over (409) says the order changed and refetches the board', async () => {
    const user = userEvent.setup();
    let boards = 0;
    const waiting = row({ packages: [{ id: 'p9', shipment_id: 's9', number: 'PKG-9', status: 'not_shipped', date: '2026-11-05' }], lines: [line({ packable: 0, packed_waiting: 1 })] });
    server.use(
      http.get('/api/v1/order-board', () => { boards++; return HttpResponse.json(board({ rows: [waiting] })); }),
      http.get('/api/v1/order-board/orders/so1/packages/p9/handover', () => HttpResponse.json({ units: 1, available: false, to_invoice: false, invoice_total: null, manual: false, manual_reason: null, credit: 0, covered_by: [] })),
      http.post('/api/v1/order-board/orders/so1/packages/p9/handover', () => HttpResponse.json({ detail: 'busy' }, { status: 409 })),
    );
    render(<OrderBoardPage />);
    await screen.findByText('SO-00412');
    await user.click(screen.getByRole('button', { name: 'Hand over the parcel' }));
    await user.click(await screen.findByRole('button', { name: 'Handed to the customer' }));
    expect(await screen.findByText('The order changed, check the quantities.')).toBeInTheDocument();
    await waitFor(() => expect(boards).toBe(2));
  });

  it('a picklist for an order that left the board (404) says the order changed and refetches the board', async () => {
    const user = userEvent.setup();
    let boards = 0;
    server.use(
      http.get('/api/v1/order-board', () => { boards++; return HttpResponse.json(board({ rows: [row()] })); }),
      http.get('/api/v1/order-board/orders/so1/picklist', () => HttpResponse.json({ lines: [{ line_id: row().lines[0].id, quantity: 1 }] })),
      http.post('/api/v1/order-board/orders/so1/picklists', () => HttpResponse.json({ detail: 'order_not_on_board' }, { status: 404 })),
    );
    render(<OrderBoardPage />);
    await user.click(await screen.findByRole('button', { name: /SO-00412/ }));
    await user.click(screen.getAllByRole('button', { name: 'Prepare' })[0]);
    await user.click(await screen.findByRole('button', { name: 'Create and print' }));
    expect((await screen.findAllByText(/The order changed, check the quantities\./)).length).toBeGreaterThan(0);
    await waitFor(() => expect(boards).toBe(2));
  });
});
