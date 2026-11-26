/**
 * The Orders page: list states in the brief's sequence, the three filter
 * scopes, the "3D only" toggle and the grouped lines panel.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { Link } from 'react-router-dom';
import { server } from '../mocks/server';
import type { FinishedOrderDetail, FinishedOrderRow, OrderPayment, OrderBoardLine, OrderBoardResponse, OrderBoardRow, QuoteRow } from '../../api/client';

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
  id: `f${n}`, number: `SO-F${String(n).padStart(3, '0')}`, customer: `Client ${n}`, customer_id: 'c1', date: '2026-08-01', total: 5000, currency: 'XPF',
  reference: '', units: { shipped: 3, total: 3 }, paid_flag: null, payment: null, is_core: null, zoho_url: null, ...o,
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
/** Finished orders live under their own tile: show them once the tile has its count. */
const showFinished = async () => fireEvent.click(await screen.findByRole('button', { name: /^Finished [1-9]/ }));

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

  it('lists orders; the tiles and the list follow the search', async () => {
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
    expect(tile(/^To ship 0 everything in stock/)).toBeInTheDocument(); // the tiles count what the search found
    expect(tile(/^Partial 1 partly/)).toBeInTheDocument();

    await user.click(tile(/^To ship 0/));
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
    await user.click(tile(/^Partial 1 partly/));
    await user.click(screen.getByRole('button', { name: /^Value/ }));
    await user.click(screen.getByRole('button', { name: /^Value/ }));
    await user.click(screen.getByRole('button', { name: /^Unpaid/ }));
    const params = new URLSearchParams(window.location.search);
    expect(Object.fromEntries(params)).toEqual({ order: 'nope', q: 'moana', status: 'partial', sort: 'value', flip: '1', pay: 'unpaid' });
    expect(window.history.length).toBe(entries); // replace: typing does not fill the history
    await user.clear(screen.getByPlaceholderText('Order number, customer, product, SKU…'));
    await user.click(tile(/^In progress/));
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
    expect(tile(/^Partial 1 partly/)).toHaveAttribute('aria-pressed', 'true');
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
    expect(tile(/^In progress/)).toHaveAttribute('aria-pressed', 'true');
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
    await waitFor(() => expect(tile(/^Partial 1 partly/)).toHaveAttribute('aria-pressed', 'true'));
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

  it('offers no batch prep-sheet tick without orders:update', async () => {
    mockUseAuth.hasPermission.mockImplementation((p: string) => p !== 'orders:update');
    serve(board());
    render(<OrderBoardPage />);
    await screen.findByText('SO-00412');
    expect(screen.queryByRole('checkbox', { name: /SO-00412/ })).not.toBeInTheDocument();
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
    const toShip = tile(/^To ship 2 400/);
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

  it('finished orders stay out of the list until their tile is chosen, then show 50 at a time', async () => {
    const user = userEvent.setup();
    serve(board());
    serveFinished(Array.from({ length: 60 }, (_, i) => fin(i + 1)));
    render(<OrderBoardPage />);
    await screen.findByText('SO-00412');
    await user.click(await screen.findByRole('button', { name: /^Finished 60/ }));
    // Same-day finished orders read newest number first
    expect(screen.getByText('SO-F060')).toBeInTheDocument();
    expect(screen.queryByText('SO-00412')).not.toBeInTheDocument();
    expect(tile(/^In progress 2/)).toBeInTheDocument(); // open orders only
    expect(screen.getAllByTestId('order-number')).toHaveLength(50);
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getAllByTestId('order-number')).toHaveLength(60);
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('status')).toBe('finished');
    await user.click(tile(/^To ship 1/));
    expect(screen.queryByText('SO-F060')).not.toBeInTheDocument();
    expect(screen.getByText('SO-00412')).toBeInTheDocument();
  });

  it('finished orders read newest first; Age flips them', async () => {
    const user = userEvent.setup();
    serve(board());
    serveFinished([fin(1, { date: '2026-03-01' }), fin(2, { date: new Date().toISOString().slice(0, 10) })]);
    render(<OrderBoardPage />);
    await showFinished();
    const numbers = () => screen.getAllByTestId('order-number').map(n => n.textContent);
    expect(numbers()).toEqual(['SO-F002', 'SO-F001']);
    await user.click(screen.getByRole('button', { name: /^Age/ }));
    expect(numbers()).toEqual(['SO-F001', 'SO-F002']);
  });

  it('opening an order closes the one that was open and puts it in the URL; closing takes it out', async () => {
    const user = userEvent.setup();
    Element.prototype.scrollIntoView = vi.fn();
    serve(board());
    render(<OrderBoardPage />);
    await user.click(await screen.findByRole('button', { name: /SO-00412/ }));
    expect(window.location.search).toBe('?order=so1');
    await user.click(screen.getByRole('button', { name: /SO-00418/ }));
    expect(screen.getByRole('button', { name: /SO-00418/, expanded: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /SO-00412/, expanded: false })).toBeInTheDocument();
    expect(window.location.search).toBe('?order=so2');
    await user.click(screen.getByRole('button', { name: /SO-00418/ }));
    expect(screen.queryAllByRole('button', { expanded: true })).toHaveLength(0);
    expect(window.location.search).toBe('');
  });

  it('a ?order= link to a finished order shows it under Finished', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    window.history.pushState({}, '', '/orders?order=f1');
    serve(board());
    serveFinished([fin(1)]);
    render(<OrderBoardPage />);
    expect(await screen.findByRole('button', { name: /SO-F001/, expanded: true })).toBeInTheDocument();
    expect(tile(/^Finished 1/)).toHaveAttribute('aria-pressed', 'true');
    window.history.pushState({}, '', '/');
  });

  it('/ goes to the search box, j and k walk the rows, and typing in the box moves nothing', async () => {
    const user = userEvent.setup();
    serve(board());
    render(<OrderBoardPage />);
    await screen.findByText('SO-00412');
    const first = screen.getByRole('button', { name: /SO-00412/ });
    const second = screen.getByRole('button', { name: /SO-00418/ });
    await user.keyboard('j');
    expect(first).toHaveFocus();
    await user.keyboard('j');
    expect(second).toHaveFocus();
    await user.keyboard('j');
    expect(second).toHaveFocus(); // the last row stays
    await user.keyboard('k');
    expect(first).toHaveFocus();
    await user.keyboard('/');
    const box = screen.getByPlaceholderText('Order number, customer, product, SKU…');
    expect(box).toHaveFocus();
    await user.keyboard('j/');
    expect(box).toHaveValue('j/');
    expect(box).toHaveFocus();
  });

  it('the To order tile says how many of its orders sit under Partial', async () => {
    serve(board({ rows: [
      row({ status: 'to_order' }),
      row({ id: 'p', number: 'SO-P', status: 'partial', units: { total: 2, shipped: 0, ready: 1, backordered: 0, to_order: 1 } }),
    ] }));
    render(<OrderBoardPage />);
    await screen.findByText('SO-P');
    expect(tile(/^To order 2 incl\. 1 partial/)).toHaveAttribute('title', 'shortfall with no open PO');
  });

  it('a finished row captions its bar with the shipped units', async () => {
    serve(board());
    serveFinished([fin(1, { units: { shipped: 2.5, total: 2.5 } })]);
    render(<OrderBoardPage />);
    await showFinished();
    const number = await screen.findByText('SO-F001');
    expect(within(number.closest('button')!).getByText('2.5/2.5 shipped')).toBeInTheDocument();
  });

  it('the search reaches finished orders', async () => {
    const user = userEvent.setup();
    serve(board());
    serveFinished([fin(1, { customer: 'Zorglub' }), fin(2)]);
    render(<OrderBoardPage />);
    await showFinished();
    await user.type(screen.getByPlaceholderText('Order number, customer, product, SKU…'), 'zorglub');
    expect(tile(/^Finished 1/)).toBeInTheDocument();
    expect(screen.getAllByTestId('order-number').map(n => n.textContent)).toEqual(['SO-F001']);
  });

  it('3D only filters finished orders too, keeping the ones the server cannot place', async () => {
    const user = userEvent.setup();
    serve(board());
    serveFinished([fin(1, { is_core: true }), fin(2, { is_core: false }), fin(3, { is_core: null })]);
    render(<OrderBoardPage />);
    await showFinished();
    expect(screen.getByText('SO-F001')).toBeInTheDocument();
    expect(screen.getByText('SO-F003')).toBeInTheDocument();
    expect(screen.queryByText('SO-F002')).not.toBeInTheDocument();
    expect(tile(/^Finished 2/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /3D only/ }));
    expect(screen.getByText('SO-F002')).toBeInTheDocument();
  });

  it('a finished row shows the Zoho flag until opened, then the percentage', async () => {
    const user = userEvent.setup();
    serve(board());
    serveFinished([fin(1, { paid_flag: 'partial' })]);
    render(<OrderBoardPage />);
    await showFinished();
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
    await showFinished();
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
    await showFinished();
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
    await showFinished();
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
    await showFinished();
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
  it('a ?order= link to an order past the first page still shows it', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    // 60 older orders sort ahead of the target under the default age sort.
    const rows = Array.from({ length: 60 }, (_, i) => row({ id: `old${i}`, number: `SO-9${String(i).padStart(4, '0')}`, age_days: 100 + i }));
    window.history.pushState({}, '', '/orders?order=target');
    serve(board({ rows: [...rows, row({ id: 'target', number: 'SO-07777', age_days: 1 })] }));
    render(<OrderBoardPage />);
    expect(await screen.findByRole('button', { name: /SO-07777/, expanded: true })).toBeInTheDocument();
    expect(screen.queryByText('SO-90059')).toBeInTheDocument();
    expect(screen.queryByText('SO-90000')).not.toBeInTheDocument(); // the page itself stays at 50 rows
    window.history.pushState({}, '', '/');
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
    await showFinished();
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

  it('ticked orders show the batch bar with their count, print one sheet for their ids, and the selection clears', async () => {
    const user = userEvent.setup();
    let sent: unknown = null;
    serve(board({ rows: [row(), row({ id: 'so2', number: 'SO-00418' }), row({ id: 'so3', number: 'SO-00421', lines: [line({ packable: 0 })] })] }));
    server.use(http.post('/api/v1/order-board/prep-sheet/batch', async ({ request }) => {
      sent = await request.json();
      return new HttpResponse(new Blob(['%PDF-']), { headers: { 'Content-Type': 'application/pdf' } });
    }));
    render(<OrderBoardPage />);
    await user.click(await screen.findByRole('checkbox', { name: 'Select SO-00412 for the prep sheet' }));
    // Ticking does not open the order, and an order with nothing to prepare has no box.
    expect(screen.getByRole('button', { name: /SO-00412/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('checkbox', { name: /SO-00421/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Print prep sheets (1)' })).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /SO-00418/ }));
    await user.click(screen.getByRole('button', { name: 'Print prep sheets (2)' }));
    await waitFor(() => expect(sent).toEqual({ ids: ['so1', 'so2'] }));
    await waitFor(() => expect(screen.queryByTestId('orders-batch')).not.toBeInTheDocument());
    expect(screen.getByRole('checkbox', { name: /SO-00412/ })).not.toBeChecked();
  });

  it('a ticked order that leaves the board leaves the selection; Clear selection empties it', async () => {
    const user = userEvent.setup();
    serve(board({ rows: [row(), row({ id: 'so2', number: 'SO-00418' })] }));
    server.use(http.post('/api/v1/order-board/refresh', () => HttpResponse.json(board({ rows: [row()] }))));
    render(<OrderBoardPage />);
    await user.click(await screen.findByRole('checkbox', { name: /SO-00412/ }));
    await user.click(screen.getByRole('checkbox', { name: /SO-00418/ }));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('button', { name: 'Print prep sheets (1)' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    // It fades out, then unmounts.
    await waitFor(() => expect(screen.queryByTestId('orders-batch')).not.toBeInTheDocument());
  });

  it('an open order that leaves the board holds in place, folded and inert, then is gone', async () => {
    const user = userEvent.setup();
    serve(board({ rows: [row(), row({ id: 'so2', number: 'SO-00418' })] }));
    server.use(http.post('/api/v1/order-board/refresh', () => HttpResponse.json(board({ rows: [row({ id: 'so2', number: 'SO-00418' })] }))));
    render(<OrderBoardPage />);
    await user.click(await screen.findByRole('button', { name: /SO-00412/ }));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(document.getElementById('order-so1')?.parentElement).toHaveAttribute('inert'));
    expect(document.getElementById('order-so1')!.nextElementSibling).toBeNull(); // the wrapper holds just the card
    await waitFor(() => expect(document.getElementById('order-so1')).toBeNull());
    expect(screen.getByRole('button', { name: /SO-00418/ })).toBeInTheDocument();
  });

  it('the stats strip is closed until opened, shows the four figures and remembers it was left open', async () => {
    const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
    serve(board({ rows: [
      row({ date: day(0), age_days: 54 }),
      row({ id: 'so2', number: 'SO-00418', status: 'to_order', total: 5000, date: '2026-01-05' }),
    ] }));
    serveFinished([fin(1, { date: day(10), handed_over: day(6) }), fin(2, { date: '2026-01-05' })]);
    render(<OrderBoardPage />);
    const toggle = await screen.findByRole('button', { name: 'Figures' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('orders-stats')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    // Eight weeks, this week last: today's order alone in it, the finished one ten days back in an earlier week.
    const chart = await screen.findByRole('img', { name: /^Orders received per week, last 8 weeks: (\S+ \S+ \d+, ){7}\S+ \S+ 1$/ });
    expect(chart.getAttribute('aria-label')!.match(/ 1(,|$)/g)).toHaveLength(2);
    const stats = screen.getByTestId('orders-stats');
    expect(stats).toHaveTextContent('Order to hand-over, on average4 dhanded over in the last 90 days: 1');
    expect(stats).toHaveTextContent(/Value waiting on stock5.000.*orders with nothing ready: 1/);
    expect(stats).toHaveTextContent('Ready, not handed over54 d');
    expect(localStorage.getItem('orders.statsOpen')).toBe('true');
  });

  it('the stats strip shows a dash with a reason when no hand-over date is stored', async () => {
    localStorage.setItem('orders.statsOpen', 'true');
    serve(board());
    serveFinished([fin(1)]);
    render(<OrderBoardPage />);
    const lead = (await screen.findByText('Order to hand-over, on average')).parentElement!;
    await waitFor(() => expect(lead).toHaveAttribute('title', 'No hand-over date stored for the last 90 days'));
    expect(lead).toHaveTextContent(/average–$/);
  });

  describe('new counter order', () => {
    const zohoStatus = () => server.use(http.get('/api/v1/zoho/status', () =>
      HttpResponse.json({ configured: true, reachable: true, default_contact_id: 'walk-in', default_contact_name: 'Client de passage' })));

    it('new order opens a modal over the board and closes back to it', async () => {
      zohoStatus();
      serve(board());
      render(<OrderBoardPage />);
      await screen.findByText('SO-00412');
      fireEvent.click(screen.getByRole('button', { name: 'New order' }));
      expect(await screen.findByRole('dialog', { name: 'New order' })).toBeInTheDocument();
      expect(screen.getByText('SO-00412')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Abandon' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New order' })).not.toBeInTheDocument());
      expect(screen.getByTestId('orders-tiles')).toBeInTheDocument();
    });

    it('the new order button needs orders:update', async () => {
      mockUseAuth.hasPermission.mockImplementation((p: string) => p !== 'orders:update');
      serve(board());
      render(<OrderBoardPage />);
      await screen.findByText('SO-00412');
      expect(screen.queryByRole('button', { name: 'New order' })).not.toBeInTheDocument();
    });

    it('after create the new order is open (?order=9) and the list is back', async () => {
      zohoStatus();
      localStorage.setItem('orders.newOrderDraft.v1', JSON.stringify({
        lines: [{ item: { id: 'A', name: 'Bambu Lab PLA Basic Noir', sku: 'BL-PLA-BK', rate: 3400, stock_on_hand: 9, product_type: 'goods' }, quantity: 1, discount: '' }],
        client: null, clientRef: '11111111-1111-4111-8111-111111111111',
      }));
      serve(board());
      const fresh = board({ rows: [row({ id: '9', number: 'SO-00999', customer: 'Client de passage' }), ...ROWS] });
      server.use(http.post('/api/v1/order-board/orders', () => HttpResponse.json({ board: fresh, row: null, salesorder_id: '9' })));
      render(<OrderBoardPage />);
      await screen.findByText('SO-00412');
      fireEvent.click(screen.getByRole('button', { name: 'New order' }));
      await screen.findByDisplayValue('Client de passage', undefined, { timeout: 3000 });
      fireEvent.click(screen.getByRole('button', { name: 'Other options' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /^Create order/ }));
      await waitFor(() => expect(window.location.search).toBe('?order=9'), { timeout: 3000 });
      expect(within(await screen.findByTestId('orders-list')).getAllByTestId('order-number').map(n => n.textContent)).toContain('SO-00999');
      expect(screen.getByText('SO-00412')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Order number, customer, product, SKU…')).toBeInTheDocument();
      // the row opens a render after the URL moves: under CI load the two are not in the same tick
      await waitFor(() => expect(within(document.getElementById('order-9')!).getByRole('button', { expanded: true })).toBeInTheDocument());
    });
  });
});

describe('OrderBoardPage on the phone', () => {
  const realMatchMedia = window.matchMedia;
  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      ...realMatchMedia(query),
      matches: query === '(max-width: 767px)',
    })) as typeof window.matchMedia;
  });
  afterEach(() => { window.matchMedia = realMatchMedia; });

  const twoOfOne = () => serve(board({ rows: [
    row({ customer_id: 'c1', contact: { name: 'Intendance', email: '', phone: '', mobile: '' } }),
    row({ id: 'so3', number: 'SO-00421', customer_id: 'c1' }),
  ] }));

  it('opening an order shows the full-screen view', async () => {
    const user = userEvent.setup();
    serve(board());
    render(<OrderBoardPage />);
    await user.click(await screen.findByRole('button', { name: /SO-00412/ }));
    expect(await screen.findByRole('tab', { name: 'Products' })).toBeInTheDocument();
    expect(screen.getByTestId('order-mobile')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /SO-00412/, expanded: true })).toBeInTheDocument();
  });

  it('back clears ?order= and closes the view', async () => {
    const user = userEvent.setup();
    serve(board());
    render(<OrderBoardPage />);
    await user.click(await screen.findByRole('button', { name: /SO-00412/ }));
    await user.click(await screen.findByRole('button', { name: 'Back to orders' }));
    await waitFor(() => expect(screen.queryByTestId('order-mobile')).not.toBeInTheDocument());
    expect(new URLSearchParams(window.location.search).has('order')).toBe(false);
  });

  it('history back closes the view', async () => {
    const user = userEvent.setup();
    serve(board());
    render(<OrderBoardPage />);
    await user.click(await screen.findByRole('button', { name: /SO-00412/ }));
    await screen.findByTestId('order-mobile');
    act(() => { window.history.back(); });
    await waitFor(() => expect(screen.queryByTestId('order-mobile')).not.toBeInTheDocument());
  });

  it('"also open" swaps the order in place, back on Products', async () => {
    const user = userEvent.setup();
    twoOfOne();
    render(<OrderBoardPage />);
    await user.click(await screen.findByRole('button', { name: /SO-00412/ }));
    await user.click(await screen.findByRole('tab', { name: 'Customer' }));
    await user.click(await screen.findByRole('button', { name: 'SO-00421' }));
    const view = await screen.findByTestId('order-mobile');
    await waitFor(() => expect(within(view).getByText('SO-00421')).toBeInTheDocument());
    expect(within(view).getByRole('tab', { name: 'Products' })).toHaveAttribute('aria-selected', 'true');
  });

  it('the view is a dialog that takes focus; closing hands focus back to the row; j does not walk the list behind it', async () => {
    const user = userEvent.setup();
    serve(board());
    render(<OrderBoardPage />);
    await user.click(await screen.findByRole('button', { name: /SO-00412/ }));
    const view = await screen.findByRole('dialog', { name: 'SO-00412' });
    await waitFor(() => expect(view).toHaveFocus());
    await user.keyboard('j');
    expect(view).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Back to orders' }));
    await waitFor(() => expect(screen.queryByTestId('order-mobile')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /SO-00412/ })).toHaveFocus();
  });

  it('an opened order stays on screen when a filter would drop it', async () => {
    const user = userEvent.setup();
    window.history.pushState({}, '', '/orders?pay=unpaid');
    const unpaidRow = row({ payment: pay() });
    serve(board({ rows: [unpaidRow, row({ id: 'so2', number: 'SO-00413', payment: pay() })] }));
    server.use(http.post('/api/v1/order-board/refresh', () => HttpResponse.json(board({ rows: [row({ payment: pay({ state: 'paid', pct: 100, left: 0 }) }), row({ id: 'so2', number: 'SO-00413', payment: pay() })] }))));
    render(<OrderBoardPage />);
    await user.click(await screen.findByRole('button', { name: /SO-00412/ }));
    await screen.findByTestId('order-mobile');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByTestId('order-mobile-summary')).toHaveTextContent('Paid'));
    expect(screen.getByTestId('order-mobile')).toBeInTheDocument();
  });

  it('has no batch checkbox', async () => {
    serve(board());
    render(<OrderBoardPage />);
    await screen.findByText('SO-00412');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('a finished order opens full screen once its detail loads', async () => {
    const user = userEvent.setup();
    serve(board());
    serveFinished([fin(1)]);
    render(<OrderBoardPage />);
    await showFinished();
    await user.click(await screen.findByRole('button', { name: /SO-F001/ }));
    expect(await screen.findByRole('tab', { name: 'Products' })).toBeInTheDocument();
  });

  it('status chips replace the tiles', async () => {
    const user = userEvent.setup();
    serve(board());
    render(<OrderBoardPage />);
    await screen.findByText('SO-00412');
    expect(screen.queryByTestId('orders-tiles')).not.toBeInTheDocument();
    const chip = screen.getByRole('button', { name: /^To ship\s*1$/ });
    await user.click(chip);
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('status')).toBe('to_ship'));
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    await user.click(chip);
    await waitFor(() => expect(new URLSearchParams(window.location.search).has('status')).toBe(false));
  });

  it('the filter sheet changes the payment filter', async () => {
    const user = userEvent.setup();
    serve(board());
    render(<OrderBoardPage />);
    await screen.findByText('SO-00412');
    const trigger = screen.getByRole('button', { name: 'Filters and sort' });
    expect(trigger).not.toHaveTextContent('1');
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Filters and sort' });
    await user.click(within(dialog).getByRole('button', { name: /^Unpaid/ }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('pay')).toBe('unpaid'));
    expect(within(dialog).getByRole('button', { name: 'Show 0 orders' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /^Show \d+ orders$/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Filters and sort' })).toHaveTextContent('1');
  });

  it('the fab starts a new order', async () => {
    const user = userEvent.setup();
    serve(board());
    render(<OrderBoardPage />);
    await screen.findByText('SO-00412');
    await user.click(screen.getByRole('button', { name: 'New order' }));
    expect(await screen.findByRole('button', { name: 'Abandon' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New order' })).not.toBeInTheDocument();
  });

  it('a viewer without orders:update has no fab and no refresh', async () => {
    mockUseAuth.hasPermission.mockImplementation((p: string) => p !== 'orders:update');
    serve(board());
    render(<OrderBoardPage />);
    await screen.findByText('SO-00412');
    expect(screen.queryByRole('button', { name: 'New order' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
  });

  it('the summary line shows the value and the sync status', async () => {
    serve(board());
    render(<OrderBoardPage />);
    await screen.findByText('SO-00412');
    const line = screen.getByTestId('orders-summary');
    expect(line).toHaveTextContent(/38\D?350/);
    expect(line).toHaveTextContent(/Updated/);
    expect(within(line).getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });
});

/** Phone width for one test: the page reads `(max-width: 767px)`. Returns the undo. */
const asPhone = () => {
  const real = window.matchMedia;
  window.matchMedia = ((query: string) => ({ ...real(query), matches: query === '(max-width: 767px)' })) as typeof window.matchMedia;
  return () => { window.matchMedia = real; };
};

describe('OrderBoardPage Devis side', () => {
  const quote = (o: Partial<QuoteRow> = {}): QuoteRow => ({
    id: 'e1', number: 'DEV-00412', customer: 'Nautic Service', customer_id: 'c1', date: '2026-11-10', expiry_date: '2026-12-10',
    state: 'sent', total: 248900, currency: 'XPF', reference: '', age_days: 2, is_core: true, editable: true,
    has_draft_order: false, modified: '', lines: [], ...o,
  });
  const serveQuotes = (rows: QuoteRow[], loading = 0) =>
    server.use(http.get('/api/v1/order-board/quotes', () => HttpResponse.json({ rows, loading, ready: true })));
  const QUOTES = [
    quote(),
    quote({ id: 'e2', number: 'DEV-00414', customer: 'Marc Le Goff', state: 'draft' }),
    quote({ id: 'e3', number: 'DEV-00415', customer: 'Hors 3D', is_core: false }),
    quote({ id: 'e4', number: 'DEV-00398', customer: 'Lycée Vauban', state: 'expired' }),
  ];

  it('the switch counts the current 3D quotes and swaps the orders for the quotes, view=quotes in the URL', async () => {
    const user = userEvent.setup();
    serve(board());
    serveQuotes(QUOTES);
    render(<OrderBoardPage />);
    expect(await screen.findByText('SO-00412')).toBeInTheDocument();
    expect(screen.getByTestId('orders-tiles')).toBeInTheDocument();
    const devis = await screen.findByRole('button', { name: /^Quotes 2$/ });
    expect(devis).toHaveAttribute('aria-pressed', 'false');
    await user.click(devis);
    expect(window.location.search).toContain('view=quotes');
    expect(await screen.findByText('Nautic Service')).toBeInTheDocument();
    expect(screen.queryByTestId('orders-tiles')).not.toBeInTheDocument();
    expect(screen.queryByText('SO-00412')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Orders' }));
    expect(window.location.search).not.toContain('view=');
    expect(await screen.findByText('SO-00412')).toBeInTheDocument();
  });

  it('a link to ?view=quotes&quote=<id> opens that quote', async () => {
    serve(board());
    serveQuotes(QUOTES);
    server.use(http.get('/api/v1/order-board/quotes/:id/events', () => HttpResponse.json({ events: [], has_more: false })));
    window.history.replaceState({}, '', '/orders?view=quotes&quote=e4');
    render(<OrderBoardPage />);
    const row = (await screen.findByText('Lycée Vauban')).closest('button')!;
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /^Expired 1/ })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.setup().click(row);
    expect(window.location.search).not.toContain('quote=');
    expect(window.location.search).toContain('view=quotes');
  });

  it('counts as soon as the list is ready, even while details still load (the loading line says it is partial)', async () => {
    serve(board());
    serveQuotes(QUOTES, 3);
    window.history.replaceState({}, '', '/orders?view=quotes');
    render(<OrderBoardPage />);
    expect(await screen.findByText('Loading quotes… 3 remaining')).toBeInTheDocument();
    expect(screen.getByText('Nautic Service')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Quotes 2$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Current 2$/ })).toBeInTheDocument();
  });

  it('shows no Devis count before the first listing is done', async () => {
    serve(board());
    server.use(http.get('/api/v1/order-board/quotes', () => HttpResponse.json({ rows: [], loading: 0, ready: false })));
    render(<OrderBoardPage />);
    await screen.findByText('SO-00412');
    expect(screen.getByRole('button', { name: /^Quotes –$/ })).toBeInTheDocument();
  });

  it('switching sides drops the other side\'s opened document from the URL', async () => {
    const user = userEvent.setup();
    serve(board());
    serveQuotes(QUOTES);
    window.history.replaceState({}, '', '/orders?order=so1');
    render(<OrderBoardPage />);
    await screen.findAllByText('SO-00412'); // the row and its opened panel
    await user.click(await screen.findByRole('button', { name: /^Quotes 2$/ }));
    await waitFor(() => expect(window.location.search).toContain('view=quotes'));
    expect(window.location.search).not.toContain('order=');
    await user.click(await screen.findByText('Nautic Service'));
    await waitFor(() => expect(window.location.search).toContain('quote=e1'));
    await user.click(screen.getByRole('button', { name: 'Orders' }));
    await waitFor(() => expect(window.location.search).not.toContain('view='));
    expect(window.location.search).not.toContain('quote=');
    expect(await screen.findByText('SO-00412')).toBeInTheDocument();
  });

  it('on the Devis side the header button starts a quote, and the created quote comes back opened', async () => {
    server.use(http.get('/api/v1/zoho/status', () =>
      HttpResponse.json({ configured: true, reachable: true, default_contact_id: 'walk-in', default_contact_name: 'Client de passage' })));
    localStorage.setItem('orders.newQuoteDraft.v1', JSON.stringify({
      lines: [{ item: { id: 'A', name: 'Bambu Lab PLA Basic Noir', sku: 'BL-PLA-BK', rate: 3400, stock_on_hand: 9, product_type: 'goods' }, quantity: 1, discount: '' }],
      client: null, clientRef: '11111111-1111-4111-8111-111111111111',
    }));
    serve(board());
    serveQuotes(QUOTES);
    server.use(
      http.get('/api/v1/order-board/quotes/:id/events', () => HttpResponse.json({ events: [], has_more: false })),
      http.post('/api/v1/order-board/quotes', () => HttpResponse.json({
        quotes: { rows: [quote({ id: 'e9', number: 'DEV-00500', customer: 'Client de passage', state: 'draft' }), ...QUOTES], loading: 0, ready: true },
        estimate_id: 'e9',
      })),
    );
    window.history.replaceState({}, '', '/orders?view=quotes');
    render(<OrderBoardPage />);
    await screen.findByText('Nautic Service');
    expect(screen.queryByRole('button', { name: 'New order' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New quote' }));
    expect(await screen.findByRole('dialog', { name: 'New quote' })).toBeInTheDocument();
    await screen.findByDisplayValue('Client de passage', undefined, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Create quote' }));
    await waitFor(() => expect(window.location.search).toContain('quote=e9'), { timeout: 3000 });
    expect(window.location.search).toContain('view=quotes');
    expect(screen.queryByRole('dialog', { name: 'New quote' })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /DEV-00500/, expanded: true })).toBeInTheDocument();
  });

  it('on a phone the round add button steps aside while a quote is opened', async () => {
    const restore = asPhone();
    try {
      const user = userEvent.setup();
      serve(board());
      serveQuotes(QUOTES);
      server.use(http.get('/api/v1/order-board/quotes/:id/events', () => HttpResponse.json({ events: [], has_more: false })));
      window.history.replaceState({}, '', '/orders?view=quotes');
      render(<OrderBoardPage />);
      await user.click(await screen.findByText('Nautic Service'));
      await waitFor(() => expect(window.location.search).toContain('quote=e1'));
      expect(screen.queryByRole('button', { name: 'New quote' })).not.toBeInTheDocument();
      // The opened quote's contact block repeats the name once it has loaded: the row is the first match.
      await user.click(screen.getAllByText('Nautic Service')[0]);
      await waitFor(() => expect(window.location.search).not.toContain('quote='));
      expect(await screen.findByRole('button', { name: 'New quote' })).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it('a quote opened by a link is scrolled into view', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    serve(board());
    serveQuotes(QUOTES);
    server.use(http.get('/api/v1/order-board/quotes/:id/events', () => HttpResponse.json({ events: [], has_more: false })));
    window.history.replaceState({}, '', '/orders?view=quotes&quote=e4');
    render(<OrderBoardPage />);
    await screen.findByText('Lycée Vauban');
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(scroll.mock.contexts[0]).toBe(document.getElementById('quote-e4'));
  });

  describe('accepting a quote', () => {
    // As the server does: a converted quote leaves the list it returns.
    const accepted = { rows: QUOTES.slice(1), loading: 0, ready: true };
    const NEW = row({ id: 'so9', number: 'SO-00232', customer: 'Nautic Service', status: 'to_order' });
    const accept = ({ draft = false, withRow = true, undoable = !draft } = {}) => {
      Element.prototype.scrollIntoView = vi.fn();
      serve(board());
      serveQuotes([quote({ has_draft_order: draft, state: draft ? 'accepted' : 'sent' }), ...QUOTES.slice(1)]);
      server.use(
        http.get('/api/v1/order-board/quotes/:id/events', () => HttpResponse.json({ events: [], has_more: false })),
        http.get('/api/v1/order-board/orders/:id/events', () => HttpResponse.json({ events: [], has_more: false })),
        http.post(`/api/v1/order-board/quotes/e1/${draft ? 'order' : 'accept'}`, () =>
          HttpResponse.json(withRow
            ? { quotes: accepted, board: board({ rows: [NEW, ...ROWS] }), row: NEW, salesorder_id: 'so9', undoable }
            : { quotes: accepted, board: board(), row: null, salesorder_id: 'so9', undoable })),
      );
      window.history.replaceState({}, '', '/orders?view=quotes&quote=e1');
      render(<OrderBoardPage />);
    };
    const notice = () => screen.findByTestId('quote-accepted');

    it('Accepted opens the new order on the Commandes side with the notice naming both documents', async () => {
      const user = userEvent.setup();
      accept();
      await user.click(within(await screen.findByTestId('quote-actions')).getByRole('button', { name: 'Accepted' }));
      expect(await notice()).toHaveTextContent('Quote DEV-00412 accepted — order SO-00232 created');
      expect(await notice()).toHaveFocus();
      expect(window.location.search).toContain('order=so9');
      expect(window.location.search).not.toContain('view=');
      expect(window.location.search).not.toContain('quote=');
      expect(await screen.findByRole('button', { name: /SO-00232/, expanded: true })).toBeInTheDocument();
    });

    it('Undo calls undo-accept with the order id and returns to the quote, opened', async () => {
      const user = userEvent.setup();
      accept();
      const undone: unknown[] = [];
      server.use(http.post('/api/v1/order-board/quotes/e1/undo-accept', async ({ request }) => {
        undone.push(await request.json());
        return HttpResponse.json({ quotes: { rows: QUOTES, loading: 0, ready: true }, board: board() });
      }));
      await user.click(within(await screen.findByTestId('quote-actions')).getByRole('button', { name: 'Accepted' }));
      await user.click(within(await notice()).getByRole('button', { name: 'Undo' }));
      await waitFor(() => expect(window.location.search).toContain('quote=e1'));
      expect(undone).toEqual([{ salesorder_id: 'so9' }]);
      expect(window.location.search).toContain('view=quotes');
      expect(window.location.search).not.toContain('order=');
      await waitFor(() => expect(screen.queryByTestId('quote-accepted')).not.toBeInTheDocument());
      expect(await screen.findByRole('button', { name: /DEV-00412/, expanded: true })).toHaveTextContent('Sent');
    });

    it('an undo refused as too late says so and drops the Undo button', async () => {
      const user = userEvent.setup();
      accept();
      server.use(http.post('/api/v1/order-board/quotes/e1/undo-accept', () => HttpResponse.json({ detail: 'undo_too_late' }, { status: 400 })));
      await user.click(within(await screen.findByTestId('quote-actions')).getByRole('button', { name: 'Accepted' }));
      await user.click(within(await notice()).getByRole('button', { name: 'Undo' }));
      expect(await within(await notice()).findByText(/too late to undo/)).toBeInTheDocument();
      expect(within(await notice()).queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
      expect(window.location.search).toContain('order=so9');
    });

    it('the notice goes when the viewer switches to the quotes', async () => {
      const user = userEvent.setup();
      accept();
      await user.click(within(await screen.findByTestId('quote-actions')).getByRole('button', { name: 'Accepted' }));
      await notice();
      await user.click(screen.getByRole('button', { name: /^Quotes/ }));
      await user.click(screen.getByRole('button', { name: 'Orders' }));
      await screen.findByText('SO-00412');
      expect(screen.queryByTestId('quote-accepted')).not.toBeInTheDocument();
    });

    it('an order not on the returned board is named by its id, and opens once a later board has it', async () => {
      const user = userEvent.setup();
      accept({ withRow: false });
      server.use(http.post('/api/v1/order-board/refresh', () => HttpResponse.json(board({ rows: [NEW, ...ROWS] }))));
      await user.click(within(await screen.findByTestId('quote-actions')).getByRole('button', { name: 'Accepted' }));
      expect(await notice()).toHaveTextContent('Quote DEV-00412 accepted — order so9 created');
      await screen.findByText('SO-00412');
      const scroll = vi.fn();
      Element.prototype.scrollIntoView = scroll;
      await user.click(screen.getByRole('button', { name: 'Refresh' }));
      expect(await screen.findByRole('button', { name: /SO-00232/, expanded: true })).toBeInTheDocument();
      await waitFor(() => expect(scroll.mock.contexts).toContain(document.getElementById('order-so9')));
    });

    it('the notice goes on the next order action', async () => {
      const user = userEvent.setup();
      accept();
      server.use(http.post('/api/v1/order-board/refresh', () => HttpResponse.json(board({ rows: [NEW, ...ROWS] }))));
      await user.click(within(await screen.findByTestId('quote-actions')).getByRole('button', { name: 'Accepted' }));
      await notice();
      await user.click(screen.getByRole('button', { name: 'Refresh' }));
      await waitFor(() => expect(screen.queryByTestId('quote-accepted')).not.toBeInTheDocument());
    });

    it('Create order on a quote whose draft order Books reuses offers no Undo', async () => {
      const user = userEvent.setup();
      accept({ draft: true });
      await user.click(within(await screen.findByTestId('quote-actions')).getByRole('button', { name: 'Create order' }));
      expect(await notice()).toHaveTextContent('Quote DEV-00412 accepted — order SO-00232 created');
      expect(within(await notice()).queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    });

    it('Accepted offers no Undo when the server says this click did not make the order, whatever the cached quote said', async () => {
      const user = userEvent.setup();
      accept({ undoable: false }); // the cached quote has no draft order: only the answer knows Books reused one
      await user.click(within(await screen.findByTestId('quote-actions')).getByRole('button', { name: 'Accepted' }));
      expect(await notice()).toHaveTextContent('order SO-00232 created');
      expect(within(await notice()).queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    });

    it('an undo answered 404 says the order left the board and drops the Undo button', async () => {
      const user = userEvent.setup();
      accept();
      server.use(http.post('/api/v1/order-board/quotes/e1/undo-accept', () => HttpResponse.json({ detail: 'Not found' }, { status: 404 })));
      await user.click(within(await screen.findByTestId('quote-actions')).getByRole('button', { name: 'Accepted' }));
      await user.click(within(await notice()).getByRole('button', { name: 'Undo' }));
      expect(await within(await notice()).findByText(/the order is no longer on the board/i)).toBeInTheDocument();
      expect(within(await notice()).queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    });

    it('the notice floats on the body, its Undo there once the new order is opened', async () => {
      const user = userEvent.setup();
      accept();
      await user.click(within(await screen.findByTestId('quote-actions')).getByRole('button', { name: 'Accepted' }));
      expect(await screen.findByRole('button', { name: /SO-00232/, expanded: true })).toBeInTheDocument();
      expect((await notice()).parentElement).toBe(document.body);
      expect(within(await notice()).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    });

    it('on a phone the notice floats above the opened order, its Undo reachable', async () => {
      const restore = asPhone();
      try {
        const user = userEvent.setup();
        accept();
        await user.click(within(await screen.findByTestId('quote-actions')).getByRole('button', { name: 'Accepted' }));
        expect(await screen.findByTestId('order-mobile')).toBeInTheDocument();
        expect((await notice()).parentElement).toBe(document.body);
        expect(within(await notice()).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
      } finally {
        restore();
      }
    });

    it('the notice goes when dismissed', async () => {
      const user = userEvent.setup();
      accept();
      await user.click(within(await screen.findByTestId('quote-actions')).getByRole('button', { name: 'Accepted' }));
      await user.click(within(await notice()).getByRole('button', { name: 'Close' }));
      expect(screen.getByTestId('quote-accepted')).toHaveClass('animate-fade-out-sm'); // fades, then unmounts
      await waitFor(() => expect(screen.queryByTestId('quote-accepted')).not.toBeInTheDocument());
    });
  });
});
