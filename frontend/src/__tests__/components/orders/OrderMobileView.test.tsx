/** The full-screen order on the phone: header, summary, tabs and the action bar. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
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

import { render } from '../../utils';
import { OrderMobileView } from '../../../components/orders/OrderMobileView';
import { formatMoney } from '../../../utils/pricing';

afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
  mockUseAuth.hasPermission.mockImplementation(() => true);
  sessionStorage.clear();
  localStorage.clear();
  window.history.pushState({}, '', '/');
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
const unpaid = { state: 'unpaid' as const, pct: 0, left: 17000, overdue: 0 };
const view = (row: OrderPanelRow, props: Partial<Parameters<typeof OrderMobileView>[0]> = {}) => (
  <OrderMobileView row={row} status="to_ship" onClose={vi.fn()} onStart={vi.fn()} {...props} />
);
const bar = () => screen.queryByTestId('order-mobile-bar');
const selected = (name: string) => expect(screen.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');

describe('OrderMobileView', () => {
  it('renders header, summary and the four tabs', () => {
    render(view(panelRow()));
    expect(screen.getByText('Lycée de Taravao')).toBeInTheDocument();
    expect(screen.getByText('SO-00412')).toBeInTheDocument();
    expect(screen.getByTestId('order-mobile-summary')).toHaveTextContent(formatMoney(17000, 'XPF').replace(/\s/g, ' ')).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Products', 'Billing', 'Customer', 'Activity']);
  });

  it('back calls onClose', async () => {
    const onClose = vi.fn();
    render(view(panelRow(), { onClose }));
    await userEvent.click(screen.getByRole('button', { name: 'Back to orders' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('the primary button follows nextStep and calls onStart', async () => {
    const onStart = vi.fn();
    render(view(panelRow(), { onStart }));
    await userEvent.click(within(bar()!).getByRole('button', { name: 'Prepare' }));
    expect(onStart).toHaveBeenCalledWith('pick');
    selected('Products');
  });

  it('collect switches to billing', async () => {
    render(view(panelRow({ payment: unpaid })));
    await userEvent.click(within(bar()!).getByRole('button', { name: 'Collect payment' }));
    selected('Billing');
  });

  it('no action bar without orders:update', () => {
    mockUseAuth.hasPermission.mockImplementation(() => false);
    render(view(panelRow({ payment: unpaid })));
    expect(bar()).not.toBeInTheDocument();
  });

  it('no primary for finished orders', () => {
    render(view(panelRow(), { status: 'finished', onStart: undefined }));
    expect(bar()).not.toBeInTheDocument();
  });

  it('the action bar hides while a bar is open', async () => {
    server.use(http.get('/api/v1/order-board/orders/so1/picklist', () => HttpResponse.json({ lines: [{ line_id: 'l1', quantity: 5 }] })));
    render(view(panelRow(), { start: 'pick', startTick: 1 }));
    await screen.findByTestId('pack-qty-l1');
    await waitFor(() => expect(bar()).not.toBeInTheDocument());
  });

  it('?sms=1 opens on the customer tab', () => {
    window.history.pushState({}, '', '/orders?order=so1&sms=1');
    render(view(panelRow()));
    selected('Customer');
  });

  it('more opens a sheet with the ref actions', async () => {
    render(view(panelRow()));
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/Zoho Books · SO-00412/);
  });
});
