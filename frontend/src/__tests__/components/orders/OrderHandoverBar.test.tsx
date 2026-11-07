/** The hand-over bar under a waiting parcel, the band that opens it, and "Create invoice" on the invoices card. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import type { OrderBoardLine, OrderHandoverOutcome, OrderHandoverPreview, OrderPackage, OrderPanelRow } from '../../../api/client';

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
vi.mock('../../../components/aito/usePrintBlob', () => ({ usePrintBlob: () => ({ print: vi.fn(), busy: false }) }));

import { render } from '../../utils';
import { OrderLinesPanel } from '../../../components/orders/OrderLinesPanel';

afterEach(() => {
  server.resetHandlers();
  mockUseAuth.hasPermission.mockImplementation(() => true);
});

const line = (o: Partial<OrderBoardLine> = {}): OrderBoardLine => ({
  id: 'l1', item_id: 'A', name: 'Bambu Lab PLA Basic Noir', sku: 'BL-PLA-BK', state: 'ready', quantity: 2, shipped: 0,
  cancelled: 0, remaining: 2, invoiced: 0, packed_waiting: 2, stock_available: 2, covered: 2, packable: 0, shortfall: 0,
  covered_by_po: 0, po_numbers: [], ...o,
});
const pkg = (n: number, o: Partial<OrderPackage> = {}): OrderPackage => ({ id: `p${n}`, shipment_id: `s${n}`, number: `PKG-${n}`, status: 'not_shipped', date: '2026-11-05', ...o });
const panelRow = (o: Partial<OrderPanelRow> = {}): OrderPanelRow => ({
  id: 'so1', number: 'SO-00412', customer: 'Lycée de Taravao', date: '2026-09-12', total: 14400, currency: 'XPF',
  age_days: 5, is_core: true, ready_ratio: 1, packed: 2, unbilled_units: 0, prep: null, customer_id: '', payment: null, contact: null,
  facts: { channel: '', reference: '', shopify_order: '', quote_number: '', delivery_method: '', payment_terms: '', shopify_url: null, quote_url: null },
  units: { total: 2, shipped: 0, ready: 0, backordered: 0, to_order: 0 }, packages: [pkg(1)], lines: [line()],
  zoho_url: null, ...o,
});

const preview = (o: Partial<OrderHandoverPreview> = {}): OrderHandoverPreview => ({
  units: 2, available: true, to_invoice: true, invoice_total: 14400, manual: false, manual_reason: null, credit: 10400, covered_by: [], ...o,
});
const outcome = (o: Partial<OrderHandoverOutcome> = {}): OrderHandoverOutcome => ({
  package_number: 'PKG-1', shipment: 'done', delivered: 'done', invoice: 'created', invoice_number: 'FAC-7', manual_reason: null,
  credit_applied: 10400, failed_step: null, error: null, ...o,
});
const answer = (o: Partial<OrderHandoverOutcome> = {}) => ({ board: { rows: [], computed_at: null, stock_loaded_at: null, sync: {} }, outcome: outcome(o) });

const servePreview = (p: OrderHandoverPreview | number) =>
  server.use(http.get('/api/v1/order-board/orders/so1/packages/p1/handover', () => (typeof p === 'number' ? HttpResponse.json({ detail: 'x' }, { status: p }) : HttpResponse.json(p))));
const post = (handler: (body: unknown) => Response | Promise<Response>) =>
  server.use(http.post('/api/v1/order-board/orders/so1/packages/p1/handover', async ({ request }) => handler(await request.json())));
const open = async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'Hand over the parcel' }));
const amount = (n: string) => new RegExp(n.replace(/(\d)(?=(\d{3})+$)/, '$1[\\s\\u202f\\u00a0,.]?'));

describe('the hand-over bar', () => {
  it('opens on pick-up and sends mode pickup with the credit applied', async () => {
    const user = userEvent.setup();
    servePreview(preview());
    let body: unknown;
    post(b => { body = b; return HttpResponse.json(answer()); });
    render(<OrderLinesPanel row={panelRow()} />);
    await open(user);
    expect(screen.getByRole('button', { name: 'Shop pick-up' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('The parcel becomes “delivered” in Zoho.')).toBeInTheDocument();
    await screen.findByText(/Creates the invoice for this parcel/);
    await user.click(screen.getByRole('button', { name: 'Handed to the customer' }));
    expect(await screen.findByText('Parcel PKG-1 handed to the customer · Invoice FAC-7 created')).toBeInTheDocument();
    expect(body).toEqual({ mode: 'pickup', apply_credit: true });
    expect(screen.queryByRole('button', { name: 'Handed to the customer' })).not.toBeInTheDocument();
  });

  it('switching to delivery changes the note, the button and the body', async () => {
    const user = userEvent.setup();
    servePreview(preview());
    let body: unknown;
    post(b => { body = b; return HttpResponse.json(answer()); });
    render(<OrderLinesPanel row={panelRow()} />);
    await open(user);
    await user.click(screen.getByRole('button', { name: 'Delivery' }));
    expect(screen.getByRole('button', { name: 'Delivery' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('The parcel becomes “shipped” in Zoho.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mark as shipped' }));
    expect(await screen.findByText(/Parcel PKG-1 marked as shipped/)).toBeInTheDocument();
    expect(body).toEqual({ mode: 'delivery', apply_credit: true });
  });

  it('shows the amount, the credit and what stays due; unticking the credit raises what is due', async () => {
    const user = userEvent.setup();
    servePreview(preview());
    let body: unknown;
    post(b => { body = b; return HttpResponse.json(answer()); });
    render(<OrderLinesPanel row={panelRow()} />);
    await open(user);
    expect(await screen.findByText(new RegExp(`Creates the invoice for this parcel: .*${amount('14400').source}`))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`Still due .*${amount('4000').source}`))).toBeInTheDocument();
    const box = screen.getByRole('checkbox', { name: /Apply the customer’s credit/ });
    expect(box).toBeChecked();
    await user.click(box);
    expect(screen.getByText(new RegExp(`Still due .*${amount('14400').source}`))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Handed to the customer' }));
    await waitFor(() => expect(body).toEqual({ mode: 'pickup', apply_credit: false }));
  });

  it('says Invoice settled when the credit covers it', async () => {
    servePreview(preview({ credit: 14400 }));
    render(<OrderLinesPanel row={panelRow()} start="handover-p1" />);
    expect(await screen.findByText('Invoice settled')).toBeInTheDocument();
  });

  it('names the invoices when nothing is left to invoice', async () => {
    servePreview(preview({ to_invoice: false, invoice_total: null, credit: 0, covered_by: ['FAC-1', 'FAC-2'] }));
    render(<OrderLinesPanel row={panelRow()} start="handover-p1" />);
    expect(await screen.findByText('Already invoiced (FAC-1, FAC-2): no new invoice.')).toBeInTheDocument();
  });

  it('words a manual preview by its reason', async () => {
    servePreview(preview({ manual: true, manual_reason: 'draft', covered_by: ['FAC-D'] }));
    const first = render(<OrderLinesPanel row={panelRow()} start="handover-p1" />);
    expect(await screen.findByText('A draft invoice (FAC-D) is waiting in Zoho: send it there first.')).toBeInTheDocument();
    first.unmount();
    servePreview(preview({ manual: true, manual_reason: 'order_money' }));
    render(<OrderLinesPanel row={panelRow()} start="handover-p1" />);
    expect(await screen.findByText('A discount or charge on this order cannot be split: invoice it in Zoho.')).toBeInTheDocument();
  });

  it('still hands over when the preview failed, and says Zoho did not answer', async () => {
    const user = userEvent.setup();
    servePreview(500);
    let body: unknown;
    post(b => { body = b; return HttpResponse.json(answer({ invoice: 'none', invoice_number: null })); });
    render(<OrderLinesPanel row={panelRow()} start="handover-p1" />);
    expect(await screen.findByText('Zoho did not say what will be invoiced.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Handed to the customer' }));
    expect(await screen.findByText('Parcel PKG-1 handed to the customer')).toBeInTheDocument();
    expect(body).toEqual({ mode: 'pickup', apply_credit: true });
  });

  it('confirm is available while the preview is still loading', async () => {
    const user = userEvent.setup();
    server.use(http.get('/api/v1/order-board/orders/so1/packages/p1/handover', async () => { await new Promise(r => setTimeout(r, 400)); return HttpResponse.json(preview()); }));
    let hits = 0;
    post(() => { hits++; return HttpResponse.json(answer()); });
    render(<OrderLinesPanel row={panelRow()} start="handover-p1" />);
    await user.click(screen.getByRole('button', { name: 'Handed to the customer' }));
    await waitFor(() => expect(hits).toBe(1));
  });

  it('a partial outcome warns that the invoice failed and closes the bar', async () => {
    const user = userEvent.setup();
    servePreview(preview());
    post(() => HttpResponse.json(answer({ invoice: 'failed', invoice_number: null, failed_step: 'invoice', error: 'Books said no', credit_applied: 0 })));
    render(<OrderLinesPanel row={panelRow()} start="handover-p1" />);
    await user.click(screen.getByRole('button', { name: 'Handed to the customer' }));
    expect(await screen.findByText('The invoice could not be created: Books said no')).toBeInTheDocument();
    expect(screen.getByText('Parcel PKG-1 handed to the customer')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Handed to the customer' })).not.toBeInTheDocument();
  });

  it('words a manual outcome and a credit left off the board', async () => {
    const user = userEvent.setup();
    servePreview(preview());
    post(() => HttpResponse.json(answer({ invoice: 'manual', manual_reason: 'draft', invoice_number: 'FAC-D', credit_applied: 0 })));
    const first = render(<OrderLinesPanel row={panelRow()} start="handover-p1" />);
    await user.click(screen.getByRole('button', { name: 'Handed to the customer' }));
    expect(await screen.findByText('A draft invoice (FAC-D) is waiting in Zoho: send it there first.')).toBeInTheDocument();
    first.unmount();
    post(() => HttpResponse.json(answer({ failed_step: 'credit', error: 'credit_off_board' })));
    render(<OrderLinesPanel row={panelRow()} start="handover-p1" />);
    await user.click(screen.getByRole('button', { name: 'Handed to the customer' }));
    expect(await screen.findByText('The order left the list: apply the customer’s credit in Zoho.')).toBeInTheDocument();
  });

  it('a 503 keeps the bar open and says Zoho is busy', async () => {
    const user = userEvent.setup();
    servePreview(preview());
    post(() => HttpResponse.json({ detail: 'unavailable' }, { status: 503 }));
    render(<OrderLinesPanel row={panelRow()} start="handover-p1" />);
    await user.click(screen.getByRole('button', { name: 'Handed to the customer' }));
    expect(await screen.findByText('Zoho is busy, try again in a moment.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Handed to the customer' })).toBeEnabled();
  });

  it('sends one request however often confirm is hit, and locks the switch and the credit meanwhile', async () => {
    const user = userEvent.setup();
    servePreview(preview());
    let hits = 0;
    post(async () => { hits++; await new Promise(r => setTimeout(r, 200)); return HttpResponse.json(answer()); });
    render(<OrderLinesPanel row={panelRow()} start="handover-p1" />);
    await screen.findByRole('checkbox');
    const confirm = screen.getByRole('button', { name: 'Handed to the customer' });
    await user.click(confirm);
    await user.click(confirm);
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Sending to Zoho…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delivery' })).toBeDisabled();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(await screen.findByText(/Parcel PKG-1 handed to the customer/)).toBeInTheDocument();
    expect(hits).toBe(1);
  });
});

describe('the hand-over bar, answers and refusals', () => {
  const confirmText = 'Handed to the customer';
  it.each([[400, 'too_many'], [409, 'busy']])('a %i refusal says the order changed and keeps the bar open', async (status, detail) => {
    const user = userEvent.setup();
    servePreview(preview());
    post(() => HttpResponse.json({ detail }, { status }));
    render(<OrderLinesPanel row={panelRow()} start="handover-p1" />);
    await user.click(screen.getByRole('button', { name: confirmText }));
    expect(await screen.findByText('The order changed, check the quantities.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: confirmText })).toBeEnabled();
  });

  it('a 502 shows the server message as the reason', async () => {
    const user = userEvent.setup();
    servePreview(preview());
    post(() => HttpResponse.json({ detail: 'Books said no' }, { status: 502 }));
    render(<OrderLinesPanel row={panelRow()} start="handover-p1" />);
    await user.click(screen.getByRole('button', { name: confirmText }));
    expect(await screen.findByText('The hand-over did not complete: Books said no')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: confirmText })).toBeEnabled();
  });

  it('a discount that cannot be split is a warning, next to the success toast', async () => {
    const user = userEvent.setup();
    servePreview(preview());
    post(() => HttpResponse.json(answer({ invoice: 'manual', manual_reason: 'order_money', invoice_number: null, credit_applied: 0 })));
    render(<OrderLinesPanel row={panelRow()} start="handover-p1" />);
    await user.click(screen.getByRole('button', { name: confirmText }));
    expect(await screen.findByText('A discount or charge on this order cannot be split: invoice it in Zoho.')).toBeInTheDocument();
    expect(screen.getByText('Parcel PKG-1 handed to the customer')).toBeInTheDocument();
  });

  it('a failed delivery step shows the failure and no success toast', async () => {
    const user = userEvent.setup();
    servePreview(preview());
    post(() => HttpResponse.json(answer({ delivered: 'skipped', invoice: 'none', invoice_number: null, failed_step: 'delivered', error: 'Books timed out', credit_applied: 0 })));
    render(<OrderLinesPanel row={panelRow()} start="handover-p1" />);
    await user.click(screen.getByRole('button', { name: confirmText }));
    expect(await screen.findByText('The hand-over did not complete: Books timed out')).toBeInTheDocument();
    expect(screen.queryByText(/Parcel PKG-1 handed to the customer/)).not.toBeInTheDocument();
  });

  it('a credit left off the board warns and still shows the success toast', async () => {
    const user = userEvent.setup();
    servePreview(preview());
    post(() => HttpResponse.json(answer({ failed_step: 'credit', error: 'credit_off_board', credit_applied: 0 })));
    render(<OrderLinesPanel row={panelRow()} start="handover-p1" />);
    await user.click(screen.getByRole('button', { name: confirmText }));
    expect(await screen.findByText('The order left the list: apply the customer’s credit in Zoho.')).toBeInTheDocument();
    expect(screen.getByText('Parcel PKG-1 handed to the customer · Invoice FAC-7 created')).toBeInTheDocument();
  });

  it('two click events in the same tick send one request', async () => {
    servePreview(preview());
    let hits = 0;
    post(async () => { hits++; await new Promise(r => setTimeout(r, 150)); return HttpResponse.json(answer()); });
    render(<OrderLinesPanel row={panelRow()} start="handover-p1" />);
    const confirm = await screen.findByRole('button', { name: confirmText });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(await screen.findByText(/Parcel PKG-1 handed to the customer/)).toBeInTheDocument();
    expect(hits).toBe(1);
  });

  it('a bar opened again asks Zoho again and shows the new answer', async () => {
    const user = userEvent.setup();
    let asked = 0;
    server.use(http.get('/api/v1/order-board/orders/so1/packages/p1/handover', () => { asked++; return HttpResponse.json(asked === 1 ? preview({ credit: 0 }) : preview({ invoice_total: 9000, credit: 0 })); }));
    render(<OrderLinesPanel row={panelRow()} />);
    await open(user);
    expect(await screen.findByText(new RegExp(`: .*${amount('14400').source}`))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await open(user);
    expect(await screen.findByText(new RegExp(`: .*${amount('9000').source}`))).toBeInTheDocument();
    expect(asked).toBe(2);
  });

  it('a new request for another parcel while one is in flight leaves the bar alone', async () => {
    const user = userEvent.setup();
    servePreview(preview());
    let hits = 0;
    post(async () => { hits++; await new Promise(r => setTimeout(r, 200)); return HttpResponse.json(answer()); });
    const view = render(<OrderLinesPanel row={panelRow({ packages: [pkg(1), pkg(2)] })} start="handover-p1" startTick={1} />);
    await user.click(await screen.findByRole('button', { name: confirmText }));
    view.rerender(<OrderLinesPanel row={panelRow({ packages: [pkg(1), pkg(2)] })} start="handover-p2" startTick={2} />);
    expect(screen.getByRole('button', { name: 'Sending to Zoho…' })).toBeDisabled();
    expect(screen.getByText('PKG-1', { selector: 'span.font-mono' })).toBeInTheDocument();
    await waitFor(() => expect(hits).toBe(1));
  });

  it('a reader sends no preview request', async () => {
    mockUseAuth.hasPermission.mockImplementation(() => false);
    let asked = 0;
    server.use(http.get('/api/v1/order-board/orders/so1/packages/p1/handover', () => { asked++; return HttpResponse.json(preview()); }));
    render(<OrderLinesPanel row={panelRow()} start="handover-p1" />);
    await new Promise(r => setTimeout(r, 100));
    expect(asked).toBe(0);
  });

  it('says so when the available preview has nothing to invoice and names no invoice', async () => {
    servePreview(preview({ to_invoice: false, invoice_total: null, credit: 0, covered_by: [] }));
    render(<OrderLinesPanel row={panelRow()} start="handover-p1" />);
    expect(await screen.findByText('Nothing to invoice for this parcel.')).toBeInTheDocument();
  });
});

describe('the hand-over bar, final review', () => {
  it('words a refused invoice preparation and does not show the raw code', async () => {
    const user = userEvent.setup();
    servePreview(preview());
    post(() => HttpResponse.json(answer({ invoice: 'failed', invoice_number: null, failed_step: 'invoice', error: 'prefill_refused', credit_applied: 0 })));
    render(<OrderLinesPanel row={panelRow()} start="handover-p1" />);
    await user.click(screen.getByRole('button', { name: 'Handed to the customer' }));
    expect(await screen.findByText('Zoho could not prepare the invoice: create it in Zoho.')).toBeInTheDocument();
    expect(screen.queryByText(/prefill_refused/)).not.toBeInTheDocument();
  });

  it('the switch is a labelled group, and closing the bar returns focus to the band button', async () => {
    const user = userEvent.setup();
    servePreview(preview());
    render(<OrderLinesPanel row={panelRow()} />);
    await open(user);
    expect(screen.getByRole('group', { name: 'Hand-over mode' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Hand over the parcel' })).toHaveFocus();
  });

  it('the choice of what to pick closes when a refetch leaves nothing on the shelf', async () => {
    const user = userEvent.setup();
    server.use(http.get('/api/v1/order-board/orders/so1/picklist', () => HttpResponse.json({ lines: [{ line_id: 'l1', quantity: 2 }] })));
    const withStock = () => panelRow({ packages: [], lines: [line({ packable: 2, packed_waiting: 0 })] });
    const second = render(<OrderLinesPanel row={withStock()} />);
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    expect(await screen.findByRole('columnheader', { name: 'To pick' })).toBeInTheDocument();
    second.rerender(<OrderLinesPanel row={panelRow({ packages: [], lines: [line({ packable: 0, packed_waiting: 0 })] })} />);
    expect(screen.queryByRole('columnheader', { name: 'To pick' })).not.toBeInTheDocument();
    second.rerender(<OrderLinesPanel row={withStock()} />);
    expect(screen.queryByRole('columnheader', { name: 'To pick' })).not.toBeInTheDocument();
  });

  it('the parcel check of a picklist does not depend on what the shelf holds', async () => {
    const user = userEvent.setup();
    server.use(http.get('/api/v1/order-board/orders/so1/picklists/pl1', () => HttpResponse.json({ id: 'pl1', number: 'PL-00013', status: 'yet_to_start', lines: [{ line_id: 'l1', quantity: 2 }] })));
    const picklists = [{ id: 'pl1', number: 'PL-00013', status: 'yet_to_start', date: '2026-11-06' }];
    render(<OrderLinesPanel row={panelRow({ packages: [], picklists, picked: 0, lines: [line({ packable: 0, packed_waiting: 0 })] })} />);
    await user.click(screen.getByRole('button', { name: 'Create parcel · PL-00013' }));
    expect(await screen.findByRole('columnheader', { name: 'In the parcel' })).toBeInTheDocument();
  });
});

describe('the Emballé band', () => {
  it('one button per waiting parcel, numbered when there are several, none without orders:update', async () => {
    const user = userEvent.setup();
    servePreview(preview());
    const first = render(<OrderLinesPanel row={panelRow({ packages: [pkg(1), pkg(2)] })} />);
    expect(screen.getByRole('button', { name: 'Hand over PKG-1' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hand over PKG-2' }));
    expect(screen.queryByRole('button', { name: 'Hand over PKG-1' })).not.toBeInTheDocument();
    expect(screen.getByText('PKG-2', { selector: 'span.font-mono' })).toBeInTheDocument();
    first.unmount();
    mockUseAuth.hasPermission.mockImplementation(() => false);
    render(<OrderLinesPanel row={panelRow()} start="handover-p1" />);
    expect(screen.queryByRole('button', { name: 'Hand over the parcel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Handed to the customer' })).not.toBeInTheDocument();
  });

  it('cancelling closes the bar, and a new request for the same parcel opens it again', async () => {
    const user = userEvent.setup();
    servePreview(preview());
    const view = render(<OrderLinesPanel row={panelRow()} start="handover-p1" startTick={1} />);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Handed to the customer' })).not.toBeInTheDocument();
    view.rerender(<OrderLinesPanel row={panelRow()} start="handover-p1" startTick={2} />);
    expect(await screen.findByRole('button', { name: 'Handed to the customer' })).toBeInTheDocument();
  });
});

describe('Create invoice on the invoices card', () => {
  it('posts to the invoice endpoint once, toasts the number and is disabled meanwhile', async () => {
    const user = userEvent.setup();
    let body: unknown;
    let hits = 0;
    server.use(http.post('/api/v1/order-board/orders/so1/invoice', async ({ request }) => {
      hits++;
      body = await request.json();
      await new Promise(r => setTimeout(r, 150));
      return HttpResponse.json(answer({ package_number: '' }));
    }));
    render(<OrderLinesPanel row={panelRow({ unbilled_units: 2, packages: [] })} />);
    const create = screen.getByRole('button', { name: 'Create invoice' });
    await user.click(create);
    await user.click(create);
    expect(create).toBeDisabled();
    expect(await screen.findByText('Invoice FAC-7 created')).toBeInTheDocument();
    expect(body).toEqual({ apply_credit: false });
    expect(hits).toBe(1);
  });

  it('is absent without orders:update', () => {
    mockUseAuth.hasPermission.mockImplementation(() => false);
    render(<OrderLinesPanel row={panelRow({ unbilled_units: 2 })} />);
    expect(screen.queryByRole('button', { name: 'Create invoice' })).not.toBeInTheDocument();
  });

  it('a failed step is worded as a warning', async () => {
    const user = userEvent.setup();
    server.use(http.post('/api/v1/order-board/orders/so1/invoice', () => HttpResponse.json(answer({ package_number: '', invoice: 'failed', invoice_number: null, failed_step: 'invoice', error: 'Books said no' }))));
    render(<OrderLinesPanel row={panelRow({ unbilled_units: 2, packages: [] })} />);
    await user.click(screen.getByRole('button', { name: 'Create invoice' }));
    expect(await screen.findByText('The invoice could not be created: Books said no')).toBeInTheDocument();
  });

  it('applies the credit only when the customer has an advance', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    server.use(http.post('/api/v1/order-board/orders/so1/invoice', async ({ request }) => { bodies.push(await request.json()); return HttpResponse.json(answer({ package_number: '' })); }));
    const payment = { state: 'partial', pct: 40, paid: 0, invoice_paid: 0, advance: 5000, due: 0, overdue: 0, rest: 0, left: 0, next_due: null, invoices: [] } as OrderPanelRow['payment'];
    render(<OrderLinesPanel row={panelRow({ unbilled_units: 2, packages: [], payment })} />);
    await user.click(screen.getByRole('button', { name: 'Create invoice' }));
    await waitFor(() => expect(bodies).toEqual([{ apply_credit: true }]));
  });

  it('says so when there was nothing to invoice', async () => {
    const user = userEvent.setup();
    server.use(http.post('/api/v1/order-board/orders/so1/invoice', () => HttpResponse.json(answer({ package_number: '', invoice: 'none', invoice_number: null, credit_applied: 0 }))));
    render(<OrderLinesPanel row={panelRow({ unbilled_units: 2, packages: [] })} />);
    await user.click(screen.getByRole('button', { name: 'Create invoice' }));
    expect(await screen.findByText('Nothing left to invoice.')).toBeInTheDocument();
  });

  it('two click events in the same tick send one request', async () => {
    let hits = 0;
    server.use(http.post('/api/v1/order-board/orders/so1/invoice', async () => { hits++; await new Promise(r => setTimeout(r, 150)); return HttpResponse.json(answer({ package_number: '' })); }));
    render(<OrderLinesPanel row={panelRow({ unbilled_units: 2, packages: [] })} />);
    const create = screen.getByRole('button', { name: 'Create invoice' });
    fireEvent.click(create);
    fireEvent.click(create);
    expect(await screen.findByText('Invoice FAC-7 created')).toBeInTheDocument();
    expect(hits).toBe(1);
  });
});
