import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { render } from '../../utils';
import { NewOrderDraftRow } from '../../../components/orders/NewOrderDraftRow';
import type { OrderItemHit } from '../../../api/client';
import { formatMoney } from '../../../utils/pricing';

const DRAFT_KEY = 'orders.newOrderDraft.v1';
const DEFAULT_ID = 'walk-in';
const item = (o: Partial<OrderItemHit> = {}): OrderItemHit => ({
  id: 'A', name: 'Bambu Lab PLA Basic Noir', sku: 'BL-PLA-BK', rate: 1000, stock_on_hand: 9, product_type: 'goods', ...o,
});
const seed = (lines: { item: OrderItemHit; quantity: number; discount: string }[]) =>
  localStorage.setItem(DRAFT_KEY, JSON.stringify({ lines, client: null, clientRef: '11111111-1111-4111-8111-111111111111' }));

const boardResult = { board: { rows: [], computed_at: null, stock_loaded_at: null, sync: {} }, row: null, salesorder_id: '9' };

beforeEach(() => {
  server.use(
    http.get('/api/v1/zoho/status', () =>
      HttpResponse.json({ configured: true, reachable: true, default_contact_id: DEFAULT_ID, default_contact_name: 'Client de passage' })),
    http.get('/api/v1/order-board/items', () => HttpResponse.json({ items: [item()] })),
  );
});

afterEach(() => {
  server.resetHandlers();
  localStorage.clear();
});

const renderRow = (onCreated = vi.fn(), onClose = vi.fn()) => {
  render(<NewOrderDraftRow currency="XPF" open={[]} finished={[]} onCreated={onCreated} onClose={onClose} />);
  return { onCreated, onClose };
};
const createBtn = () => screen.getByRole('button', { name: 'Create order' });
const lineTotal = () => screen.getByTestId('draft-line-total');

describe('NewOrderDraftRow', () => {
  it('starts on the client de passage', async () => {
    renderRow();
    expect(await screen.findByDisplayValue('Client de passage')).toBeInTheDocument();
    expect(screen.queryByTestId('order-client-history')).not.toBeInTheDocument();
  });

  it('adding the same item twice bumps quantity', async () => {
    const user = userEvent.setup();
    renderRow();
    const search = screen.getByLabelText('Scan or search a product (name, SKU)…');
    await user.type(search, 'pla');
    await user.click(await screen.findByRole('button', { name: /^Bambu Lab PLA Basic Noir/ }));
    await user.type(search, 'pla');
    await user.click(await screen.findByRole('button', { name: /^Bambu Lab PLA Basic Noir/ }));
    expect(screen.getByLabelText('Qty · Bambu Lab PLA Basic Noir')).toHaveValue(2);
    expect(screen.getAllByTestId('draft-line-total')).toHaveLength(1);
  });

  it('a scanned barcode adds the line once the search answers, and a second scan bumps it', async () => {
    const user = userEvent.setup();
    server.use(http.get('/api/v1/order-board/items', ({ request }) => HttpResponse.json({
      items: new URL(request.url).searchParams.get('q') === '3760123456789'
        ? [item({ id: 'B', name: 'PLA Silk Or', sku: 'PLA-SILK' }), item({ ean: '3760123456789' })]
        : [],
    })));
    renderRow();
    const search = screen.getByLabelText('Scan or search a product (name, SKU)…');
    await user.type(search, '3760123456789{Enter}'); // Enter lands before the search has answered
    await waitFor(() => expect(screen.getByLabelText('Qty · Bambu Lab PLA Basic Noir')).toHaveValue(1));
    expect(search).toHaveValue('');
    expect(screen.queryByLabelText('Qty · PLA Silk Or')).not.toBeInTheDocument();
    await user.type(search, '3760123456789{Enter}');
    await waitFor(() => expect(screen.getByLabelText('Qty · Bambu Lab PLA Basic Noir')).toHaveValue(2));
    expect(search).toHaveValue('');
  });

  it('a scanned code nothing matches adds nothing', async () => {
    const user = userEvent.setup();
    let answered = 0;
    server.use(http.get('/api/v1/order-board/items', () => {
      answered += 1;
      return HttpResponse.json({ items: [item(), item({ id: 'B', name: 'PLA Silk Or', sku: 'PLA-SILK' })] });
    }));
    renderRow();
    const search = screen.getByLabelText('Scan or search a product (name, SKU)…');
    await user.type(search, '99999999{Enter}');
    await waitFor(() => expect(answered).toBe(1));
    await screen.findByRole('button', { name: /^PLA Silk Or/ }); // the hits show, none was picked
    expect(screen.queryByTestId('draft-line-total')).not.toBeInTheDocument();
    expect(search).toHaveValue('99999999');
  });

  it('discount 10% and 5 change the line total; 120% blocks create', async () => {
    const user = userEvent.setup();
    let posted = 0;
    server.use(http.post('/api/v1/order-board/orders', () => { posted += 1; return HttpResponse.json(boardResult); }));
    seed([{ item: item(), quantity: 2, discount: '' }]);
    renderRow();
    expect(lineTotal().textContent).toBe(formatMoney(2000, 'XPF'));
    const discount = screen.getByLabelText('Discount · Bambu Lab PLA Basic Noir');
    await user.type(discount, '10%');
    expect(lineTotal().textContent).toBe(formatMoney(1800, 'XPF'));
    await user.clear(discount);
    await user.type(discount, '5');
    expect(lineTotal().textContent).toBe(formatMoney(1995, 'XPF'));
    await user.clear(discount);
    await user.type(discount, '120%');
    expect(discount).toHaveAttribute('aria-invalid', 'true');
    expect(createBtn()).toHaveAttribute('aria-disabled', 'true');
    await user.click(createBtn());
    expect(await screen.findByText(/a percentage up to 100%/)).toBeInTheDocument();
    expect(posted).toBe(0);
  });

  it('shows "2 to order" when quantity exceeds stock but still creates', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    server.use(http.post('/api/v1/order-board/orders', () => HttpResponse.json(boardResult)));
    seed([{ item: item({ stock_on_hand: 3 }), quantity: 5, discount: '' }]);
    renderRow(onCreated);
    expect(screen.getByText('2 to order')).toBeInTheDocument();
    await screen.findByDisplayValue('Client de passage');
    await user.click(createBtn());
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it('create sends customer, client_ref and lines then clears the draft', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    let body: unknown = null;
    server.use(http.post('/api/v1/order-board/orders', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(boardResult);
    }));
    seed([{ item: item(), quantity: 2, discount: '10 %' }, { item: item({ id: 'B', name: 'PLA Silk Or' }), quantity: 1, discount: '' }]);
    renderRow(onCreated);
    await screen.findByDisplayValue('Client de passage');
    await user.click(createBtn());
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(boardResult));
    expect(body).toEqual({
      customer_id: DEFAULT_ID,
      client_ref: '11111111-1111-4111-8111-111111111111',
      lines: [{ item_id: 'A', quantity: 2, discount: '10%' }, { item_id: 'B', quantity: 1 }],
    });
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('keeps the draft when create fails', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    server.use(http.post('/api/v1/order-board/orders', () => HttpResponse.json({ detail: 'create_failed' }, { status: 400 })));
    seed([{ item: item(), quantity: 2, discount: '' }]);
    renderRow(onCreated);
    await screen.findByDisplayValue('Client de passage');
    await user.click(createBtn());
    expect(await screen.findByText(/Order not created: Zoho Books did not confirm/)).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!).lines).toHaveLength(1);
    expect(lineTotal()).toBeInTheDocument();
  });

  it('reset needs a hold and clears lines', async () => {
    seed([{ item: item(), quantity: 2, discount: '' }]);
    renderRow();
    const reset = screen.getByRole('button', { name: /Reset draft/ });
    fireEvent.click(reset);
    expect(lineTotal()).toBeInTheDocument();
    fireEvent.pointerDown(reset);
    await waitFor(() => expect(screen.queryByTestId('draft-line-total')).not.toBeInTheDocument(), { timeout: 2000 });
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('abandon closes and keeps the draft', async () => {
    const user = userEvent.setup();
    seed([{ item: item(), quantity: 2, discount: '' }]);
    const { onClose } = renderRow();
    await user.click(screen.getByRole('button', { name: 'Abandon' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem(DRAFT_KEY)).not.toBeNull();
  });

  it('escape and the backdrop close the modal', async () => {
    const { onClose } = renderRow();
    const dialog = screen.getByRole('dialog', { name: 'New order' });
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
