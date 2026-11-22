/** The opened order on the phone: one tab at a time, every open bar keeps its state across tab switches. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { api } from '../../../api/client';
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

import { render } from '../../utils';
import { OrderLinesPanel } from '../../../components/orders/OrderLinesPanel';
import type { PhoneTab } from '../../../components/orders/OrderSidePanel';

afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

const line = (o: Partial<OrderBoardLine> = {}): OrderBoardLine => ({
  id: 'l1', item_id: 'A', name: 'Bambu Lab PLA Basic Noir', sku: 'BL-PLA-BK', state: 'ready', quantity: 5, shipped: 0,
  cancelled: 0, remaining: 5, invoiced: 0, packed_waiting: 0, stock_available: 5, covered: 5, packable: 5, shortfall: 0, rate: 3400, floor: 0,
  covered_by_po: 0, po_numbers: [], ...o,
});
const panelRow = (o: Partial<OrderPanelRow> = {}): OrderPanelRow => ({
  id: 'so1', number: 'SO-00412', customer: 'Lycée de Taravao', date: '2026-09-12', total: 17000, currency: 'XPF',
  age_days: 5, is_core: true, ready_ratio: 1, packed: 0, unbilled_units: 0, prep: null, customer_id: '', payment: null,
  contact: { name: 'Teva Marchand', email: 'teva@tahiti-nautic.example', phone: '', mobile: '' },
  facts: { channel: '', reference: '', shopify_order: '', quote_number: '', delivery_method: '', payment_terms: '', shopify_url: null, quote_url: null }, version: 'v1', estimable: true,
  units: { total: 5, shipped: 0, ready: 5, backordered: 0, to_order: 0 }, packages: [], lines: [line()],
  zoho_url: 'https://books.example/so/1', ...o,
});
const BASE = '/api/v1/order-board/orders/so1';

/** One client for every rerender, so the open bars are the component's own state. */
function Harness({ row, tab }: { row: OrderPanelRow; tab?: PhoneTab }) {
  harnessClient.setQueryData(['order-board'], { rows: [], scan: false });
  return (
    <QueryClientProvider client={harnessClient}>
      <OrderLinesPanel row={row} phoneTab={tab} start="pick" startTick={1} />
    </QueryClientProvider>
  );
}
const harnessClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('the order panel by phone tab', () => {
  it('phoneTab hides the ref actions', () => {
    const first = render(<OrderLinesPanel row={panelRow()} />);
    expect(screen.getByRole('link', { name: /Zoho Books · SO-00412/ })).toBeInTheDocument();
    first.unmount();
    render(<OrderLinesPanel row={panelRow()} phoneTab="lines" />);
    expect(screen.queryByRole('link', { name: /Zoho Books · SO-00412/ })).not.toBeInTheDocument();
  });

  it('billing tab shows invoices, hides products and contact', () => {
    render(<OrderLinesPanel row={panelRow()} phoneTab="billing" />);
    expect(screen.getByRole('region', { name: 'Product', hidden: true }).parentElement).toHaveAttribute('hidden');
    expect(screen.getByRole('button', { name: 'Invoice now' })).toBeVisible();
    expect(screen.queryByText('Teva Marchand')).not.toBeVisible();
  });

  it('an open pick check survives a tab switch', async () => {
    const user = userEvent.setup();
    server.use(http.get(`${BASE}/picklist`, () => HttpResponse.json({ lines: [{ line_id: 'l1', quantity: 5 }] })));
    const { rerender } = render(<Harness row={panelRow()} tab="lines" />);
    const field = await screen.findByTestId('pack-qty-l1');
    await user.clear(field);
    await user.type(field, '3');
    rerender(<Harness row={panelRow()} tab="billing" />);
    rerender(<Harness row={panelRow()} tab="lines" />);
    expect(screen.getByTestId('pack-qty-l1')).toHaveValue(3);
  });

  it('scan is ignored off the products tab', async () => {
    server.use(http.get(`${BASE}/picklists/pl1`, () => HttpResponse.json({ id: 'pl1', number: 'PL-00013', status: 'yet_to_start', lines: [{ line_id: 'l1', quantity: 5 }] })));
    const row = panelRow({ picklists: [{ id: 'pl1', number: 'PL-00013', status: 'yet_to_start', date: '2026-11-06' }], picked: 0, lines: [line({ codes: ['6975337030001'] })] });
    const open = (tab: PhoneTab) => <PackHarness row={row} tab={tab} />;
    const { rerender } = render(open('lines'));
    expect(await screen.findByText(/Parcel: 0 of 5 on PL-00013/)).toBeInTheDocument();
    const scan = () => [...'6975337030001', 'Enter'].forEach(key => fireEvent.keyDown(document.body, { key }));
    rerender(open('billing'));
    scan();
    expect(screen.getByText(/Parcel: 0 of 5 on PL-00013/)).toBeInTheDocument();
    rerender(open('lines'));
    scan();
    expect(await screen.findByText(/Parcel: 1 of 5 on PL-00013/)).toBeInTheDocument();
  });

  it('activity mounts only when selected', async () => {
    const events = vi.spyOn(api, 'getOrderEvents').mockResolvedValue({ events: [], next_cursor: null } as never);
    const { rerender } = render(<OrderLinesPanel row={panelRow()} phoneTab="lines" />);
    await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); // flush effects and settled promises
    expect(events).not.toHaveBeenCalled();
    rerender(<OrderLinesPanel row={panelRow()} phoneTab="activity" />);
    await waitFor(() => expect(events).toHaveBeenCalled());
  });

  it('the ?sms=1 draft opens visibly even off the client tab', async () => {
    mockUseAuth.isAdmin = true;
    vi.spyOn(api, 'getOrderSmsDraft').mockResolvedValue({ message: 'Bonjour', kind: 'filaments', partial: false, due: 0 });
    window.history.pushState({}, '', '/?order=so1&sms=1');
    try {
      render(<OrderLinesPanel row={panelRow({ contact: { name: 'Teva', email: '', phone: '', mobile: '87 22 45 67' } })} phoneTab="lines" />);
      expect(await screen.findByRole('dialog')).toBeVisible();
    } finally {
      mockUseAuth.isAdmin = false;
      window.history.pushState({}, '', '/');
    }
  });

  it('onBarOpen follows the bar and closes on unmount', async () => {
    const user = userEvent.setup();
    server.use(http.get(`${BASE}/picklist`, () => HttpResponse.json({ lines: [{ line_id: 'l1', quantity: 5 }] })));
    const onBarOpen = vi.fn();
    const { unmount } = render(<OrderLinesPanel row={panelRow()} phoneTab="lines" onBarOpen={onBarOpen} />);
    expect(onBarOpen).toHaveBeenLastCalledWith(false);
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    await waitFor(() => expect(onBarOpen).toHaveBeenLastCalledWith(true));
    unmount();
    expect(onBarOpen).toHaveBeenLastCalledWith(false);
  });
});

function PackHarness({ row, tab }: { row: OrderPanelRow; tab: PhoneTab }) {
  harnessClient.setQueryData(['order-board'], { rows: [], scan: true });
  return (
    <QueryClientProvider client={harnessClient}>
      <OrderLinesPanel row={row} phoneTab={tab} start="pack-pl1" startTick={1} />
    </QueryClientProvider>
  );
}
