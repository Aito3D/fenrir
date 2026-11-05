/**
 * The Orders page: list states in the brief's sequence, the three filter
 * scopes, the "3D only" toggle and the grouped lines panel.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import type { OrderBoardLine, OrderBoardResponse, OrderBoardRow } from '../../api/client';

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
import { OrderBoardPage } from '../../pages/OrderBoardPage';

afterEach(() => {
  server.resetHandlers();
  localStorage.clear();
  mockUseAuth.hasPermission.mockImplementation(() => true);
});

const line = (o: Partial<OrderBoardLine> = {}): OrderBoardLine => ({
  id: 'l1', item_id: 'A', name: 'Bambu Lab PLA Basic Noir', sku: 'BL-PLA-BK', state: 'ready', quantity: 1, shipped: 0,
  cancelled: 0, remaining: 1, invoiced: 0, packed_waiting: 0, stock_available: 1, covered: 1, shortfall: 0,
  covered_by_po: 0, po_numbers: [], ...o,
});

const row = (o: Partial<OrderBoardRow> = {}): OrderBoardRow => ({
  id: 'so1', number: 'SO-00412', customer: 'Lycée de Taravao', date: '2026-09-12', total: 13600, currency: 'XPF',
  status: 'to_ship', age_days: 54, is_core: true, ready_ratio: 1, packed: 0,
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
    expect(tile(/^To ship 1 everything in stock/)).toBeInTheDocument();
    expect(tile(/^In progress 2/)).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Order number, customer, product, SKU…'), 'moana');
    expect(screen.queryByText('SO-00412')).not.toBeInTheDocument();
    expect(tile(/^To ship 1 everything in stock/)).toBeInTheDocument(); // tiles unchanged
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
          { number: 'PKG-00031', status: 'delivered', date: '2026-10-28' },
          { number: 'PKG-00034', status: 'not_shipped', date: '2026-11-04' },
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
    expect(screen.getByRole('link', { name: 'Open in Zoho Books' })).toHaveAttribute('href', 'https://books.example/app/1#/salesorders/so1');
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
});
