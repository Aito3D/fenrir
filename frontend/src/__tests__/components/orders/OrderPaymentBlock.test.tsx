/** The payment buttons of an opened order: shown only when the server names a document, prefilled with what is left. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError, api } from '../../../api/client';
import type { AitoTerminalPayment, OrderPayment, OrderPaymentLink, OrderPaymentTarget } from '../../../api/client';
import { render } from '../../utils';
import { OrderPaymentBlock } from '../../../components/orders/OrderPaymentBlock';

const pay = (o: Partial<OrderPayment> = {}): OrderPayment => ({
  state: 'partial', pct: 40, paid: 8000, invoice_paid: 8000, retainer: 0, advance: 0, due: 12000, overdue: 0, rest: 0, left: 12000,
  next_due: null, invoices: [], ...o,
});
const target = (o: Partial<OrderPaymentTarget> = {}): OrderPaymentTarget => ({
  kind: 'invoice', document_id: 'inv-2', number: 'FA-2', max_amount: 15000, left: 12000, link: null, ...o,
});
const tpe = (o: Partial<AitoTerminalPayment> = {}): AitoTerminalPayment => ({
  id: 7, document_kind: 'invoice', document_number: 'FA-2', status: 'processing', amount: 12000, amount_confirmed: null,
  booking_status: 'pending', booking_error: null, sync_error: null, created_at: '2026-11-11T01:00:00', settled_at: null, ...o,
});
const link = (o: Partial<OrderPaymentLink> = {}): OrderPaymentLink => ({
  id: 3, state: 'pending', amount: 12000, currency: 'XPF', url: 'https://pay.example/x', expires_on: '2026-12-11', paid_at: null,
  sync_error: null, minted: true, document_number: 'FA-2', ...o,
});

describe('OrderPaymentBlock payment buttons', () => {
  afterEach(() => vi.restoreAllMocks());

  it('buttons hidden without target', async () => {
    const get = vi.spyOn(api, 'getOrderPaymentTarget').mockResolvedValue(target({ kind: null, document_id: null, number: null, max_amount: null }));
    render(<OrderPaymentBlock payment={pay()} currency="XPF" orderId="so1" />);
    await vi.waitFor(() => expect(get).toHaveBeenCalledWith('so1'));
    expect(screen.queryByRole('button', { name: /Payment link/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Card terminal/ })).not.toBeInTheDocument();
  });

  it('buttons hidden without orders:update (no orderId), and the target is never asked', () => {
    const get = vi.spyOn(api, 'getOrderPaymentTarget');
    render(<OrderPaymentBlock payment={pay()} currency="XPF" />);
    expect(screen.queryByRole('button', { name: /Card terminal/ })).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it('TPE opens with left to pay', async () => {
    vi.spyOn(api, 'getOrderPaymentTarget').mockResolvedValue(target());
    vi.spyOn(api, 'getOrderTerminalPayment').mockResolvedValue(null);
    const start = vi.spyOn(api, 'startOrderTerminalPayment').mockResolvedValue(tpe());
    render(<OrderPaymentBlock payment={pay()} currency="XPF" orderId="so1" />);
    await userEvent.click(await screen.findByRole('button', { name: /Card terminal/ }));
    expect(await screen.findByLabelText('Amount')).toHaveValue('12000');
    await userEvent.click(screen.getByRole('button', { name: 'Start the terminal' }));
    expect(await screen.findByText('Waiting for the card on the terminal…')).toBeInTheDocument();
    expect(start).toHaveBeenCalledWith('so1', 12000);
  });

  it('the prefill is capped at the document balance', async () => {
    vi.spyOn(api, 'getOrderPaymentTarget').mockResolvedValue(target({ max_amount: 5000 }));
    vi.spyOn(api, 'getOrderTerminalPayment').mockResolvedValue(null);
    render(<OrderPaymentBlock payment={pay()} currency="XPF" orderId="so1" />);
    await userEvent.click(await screen.findByRole('button', { name: /Card terminal/ }));
    expect(await screen.findByLabelText('Amount')).toHaveValue('5000');
  });

  it('a retainer target uses the deposit wording, not the invoice one', async () => {
    vi.spyOn(api, 'getOrderPaymentTarget').mockResolvedValue(target({ kind: 'retainer', document_id: 'ret-1', number: 'RET-1' }));
    vi.spyOn(api, 'getOrderTerminalPayment').mockResolvedValue(null);
    render(<OrderPaymentBlock payment={pay()} currency="XPF" orderId="so1" />);
    await userEvent.click(await screen.findByRole('button', { name: /Card terminal/ }));
    expect(await screen.findByText(/Deposit invoice on the quote/)).toBeInTheDocument();
    expect(screen.queryByText(/Heimdall caps it at the balance/)).not.toBeInTheDocument();
  });

  it('a charge still in flight reopens on its waiting screen', async () => {
    vi.spyOn(api, 'getOrderPaymentTarget').mockResolvedValue(target());
    vi.spyOn(api, 'getOrderTerminalPayment').mockResolvedValue(tpe());
    render(<OrderPaymentBlock payment={pay()} currency="XPF" orderId="so1" />);
    await userEvent.click(await screen.findByRole('button', { name: /Card terminal/ }));
    expect(await screen.findByText('Waiting for the card on the terminal…')).toBeInTheDocument();
    expect(screen.queryByLabelText('Amount')).not.toBeInTheDocument();
  });

  it('a replayed link shows what it holds, with a note, not what was typed', async () => {
    vi.spyOn(api, 'getOrderPaymentTarget').mockResolvedValue(target());
    const create = vi.spyOn(api, 'createOrderPaymentLink').mockResolvedValue(link({ amount: 3000, document_number: 'FA-OLD' }));
    render(<OrderPaymentBlock payment={pay()} currency="XPF" orderId="so1" />);
    await userEvent.click(await screen.findByRole('button', { name: /Payment link/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Create the link' }));
    expect(create).toHaveBeenCalledWith('so1', 12000);
    expect(await screen.findByText(/An earlier attempt was resumed: this is on FA-OLD/)).toBeInTheDocument();
    expect(screen.getByText('FA-OLD')).toBeInTheDocument();
    expect(screen.getByText('https://pay.example/x')).toBeInTheDocument();
  });

  it('an open link can be cancelled from its dialog', async () => {
    vi.spyOn(api, 'getOrderPaymentTarget').mockResolvedValue(target({ link: link() }));
    const cancel = vi.spyOn(api, 'cancelOrderPaymentLink').mockResolvedValue(link({ state: 'cancelled' }));
    render(<OrderPaymentBlock payment={pay()} currency="XPF" orderId="so1" />);
    await userEvent.click(await screen.findByRole('button', { name: /Payment link/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel the link' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel this link?' }));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith('so1'));
  });

  it('a terminal refused for an open link offers to cancel it and charge', async () => {
    vi.spyOn(api, 'getOrderPaymentTarget').mockResolvedValue(target());
    vi.spyOn(api, 'getOrderTerminalPayment').mockResolvedValue(null);
    const start = vi.spyOn(api, 'startOrderTerminalPayment')
      .mockRejectedValueOnce(new ApiError('A payment link is open for this order', 409, 'link_open'))
      .mockResolvedValueOnce(tpe());
    render(<OrderPaymentBlock payment={pay()} currency="XPF" orderId="so1" />);
    await userEvent.click(await screen.findByRole('button', { name: /Card terminal/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Start the terminal' }));
    expect(await screen.findByText(/A payment link is open for this order: the client could pay it as well/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel the link and charge the terminal' }));
    expect(await screen.findByText('Waiting for the card on the terminal…')).toBeInTheDocument();
    expect(start).toHaveBeenNthCalledWith(1, 'so1', 12000);
    expect(start).toHaveBeenNthCalledWith(2, 'so1', 12000, true);
  });
});
