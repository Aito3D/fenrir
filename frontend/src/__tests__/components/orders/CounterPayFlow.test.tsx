import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { render } from '../../utils';

const print = vi.fn();
vi.mock('../../../components/aito/usePrintBlob', () => ({ usePrintBlob: () => ({ print, busy: false }) }));

import { CounterPayFlow } from '../../../components/orders/CounterPayFlow';
import type { useCounterPay } from '../../../components/orders/useCounterPay';

type Pay = ReturnType<typeof useCounterPay>;

const mkPay = (o: Record<string, unknown> = {}) => ({
  step: 'payment', busy: false, wait: 'payment', error: null, row: { id: 'so1', number: 'SO-9', currency: 'XPF' }, paid: 0, later: false,
  invoice: null, question: null, handedLate: [], forced: [], active: true,
  start: vi.fn(), settle: vi.fn(), payLater: vi.fn(), cancelPayment: vi.fn(), answer: vi.fn(), handOver: vi.fn(), retry: vi.fn(), reset: vi.fn(),
  ...o,
}) as unknown as Pay;

const flow = (pay: Pay, o: Partial<Parameters<typeof CounterPayFlow>[0]> = {}) => {
  const props = { currency: 'XPF', total: 12400, email: null, isDefaultClient: true, onNewSale: vi.fn(), onOpenOrder: vi.fn(), ...o };
  render(<CounterPayFlow pay={pay} {...props} />);
  return props;
};
const invoice = (balance: number) => ({ id: 'inv1', number: 'FAC-1', date: '', due_date: '', total: 12400, balance, status: 'sent', url: null });
const done = (o: Record<string, unknown> = {}) => mkPay({ step: 'done', wait: null, invoice: invoice(0), ...o });

afterEach(() => {
  server.resetHandlers();
  print.mockClear();
});

describe('CounterPayFlow', () => {
  it('shows the three payment choices while waiting for the payment', () => {
    const { onOpenOrder } = flow(mkPay());
    expect(screen.getByRole('button', { name: 'Card (terminal)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cash or cheque' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Pay later/ })).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
    expect(screen.getByText('Payment').closest('li')).toHaveAttribute('aria-current', 'step');
    expect(onOpenOrder).not.toHaveBeenCalled();
  });

  it('cancel stops the sale and opens the order', async () => {
    const pay = mkPay();
    const { onOpenOrder } = flow(pay);
    await userEvent.click(screen.getByRole('button', { name: /^Cancel/ }));
    expect(pay.cancelPayment).toHaveBeenCalledOnce();
    expect(onOpenOrder).toHaveBeenCalledWith('so1');
  });

  it('pay later is aria-disabled for the client de passage and says to pick a client', async () => {
    const pay = mkPay();
    flow(pay);
    const later = screen.getByRole('button', { name: /^Pay later/ });
    expect(later).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(later);
    expect(screen.getByRole('alert')).toHaveTextContent('Pick a customer to pay later');
    expect(pay.payLater).not.toHaveBeenCalled();
  });

  it('pay later runs for a real client', async () => {
    const pay = mkPay();
    flow(pay, { isDefaultClient: false });
    await userEvent.click(screen.getByRole('button', { name: /^Pay later/ }));
    expect(pay.payLater).toHaveBeenCalledOnce();
  });

  it('cash opens the manual dialog and records through the order route, settling once', async () => {
    const user = userEvent.setup();
    let recorded: unknown = null;
    server.use(
      http.get('/api/v1/order-board/orders/so1/payment-target', () =>
        HttpResponse.json({ kind: 'salesorder', document_id: 'so1', number: 'SO-9', max_amount: 12400, left: 12400, link: null })),
      http.post('/api/v1/order-board/orders/so1/manual-payment', async ({ request }) => {
        recorded = await request.json();
        return HttpResponse.json({});
      }),
    );
    const pay = mkPay();
    flow(pay);
    await user.click(screen.getByRole('button', { name: 'Cash or cheque' }));
    await user.click(await screen.findByRole('button', { name: /^Record|^Save|^Confirm/i }, { timeout: 3000 }));
    await vi.waitFor(() => expect(pay.settle).toHaveBeenCalledWith(12400));
    expect(recorded).toMatchObject({ amount: 12400 });
    expect(pay.settle).toHaveBeenCalledTimes(1);
  });

  it('asks the stock question and answers it', async () => {
    const pay = mkPay({ wait: 'stock', step: 'parcel', question: { id: 'l1', name: 'PETG HF Noir', remaining: 1, packed_waiting: 0 } });
    flow(pay);
    expect(screen.getByText(/PETG HF Noir ×1: Zoho shows 0 in stock/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Yes, it leaves with the customer' }));
    expect(pay.answer).toHaveBeenLastCalledWith(true);
    await userEvent.click(screen.getByRole('button', { name: 'No, hand it over later' }));
    expect(pay.answer).toHaveBeenLastCalledWith(false);
  });

  it('the hand-over waits for the operator and lists what stays', async () => {
    const pay = mkPay({ wait: 'handover', step: 'handover', handedLate: ['PETG HF Noir'] });
    flow(pay);
    expect(screen.getByText(/PETG HF Noir stays to prepare/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Handed to the customer' }));
    expect(pay.handOver).toHaveBeenCalledOnce();
  });

  it('shows no invoice buttons before done', () => {
    flow(mkPay({ wait: 'handover', step: 'handover', invoice: invoice(0) }));
    expect(screen.queryByRole('button', { name: 'Print the invoice' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Other options' })).not.toBeInTheDocument();
  });

  it('final screen: a paid sale shows "paid in full"', async () => {
    const pay = done({ paid: 12400 });
    const { onNewSale, onOpenOrder } = flow(pay);
    expect(screen.getByText('Sale complete')).toBeInTheDocument();
    expect(screen.getByText('paid in full')).toBeInTheDocument();
    expect(screen.getByText(/SO-9 · FAC-1/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'New sale' }));
    expect(onNewSale).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: 'Open the order' }));
    expect(onOpenOrder).toHaveBeenCalledWith('so1');
  });

  it('final screen: pay later and a partial payment show the amount due', () => {
    flow(done({ later: true, invoice: invoice(12400) }));
    expect(screen.getByText('Order handed over, to be paid')).toBeInTheDocument();
    expect(screen.getByText(/^amount due 12\s*400/)).toBeInTheDocument();
    expect(screen.queryByText('paid in full')).not.toBeInTheDocument();
  });

  it('final screen: late items and forced stock are called out', () => {
    flow(done({ handedLate: ['A', 'B'], forced: ['C'] }));
    expect(screen.getByText('Sale paid, 2 item(s) to hand over later')).toBeInTheDocument();
    expect(screen.getByText(/C handed over with 0 in stock/)).toBeInTheDocument();
  });

  it('the main button prints the invoice', async () => {
    flow(done());
    await userEvent.click(screen.getByRole('button', { name: 'Print the invoice' }));
    expect(print).toHaveBeenCalledOnce();
  });

  it('email item is disabled without an email and shows "no email address for this customer"', async () => {
    flow(done(), { email: null });
    await userEvent.click(screen.getByRole('button', { name: 'Other options' }));
    const item = screen.getByRole('menuitem', { name: /Send by email/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(item);
    expect(screen.getByRole('alert')).toHaveTextContent('No email address for this customer');
  });

  it('email item opens the invoice email window when there is an address', async () => {
    server.use(http.get('/api/v1/order-board/invoices/inv1/email', () =>
      HttpResponse.json({ to: ['m@example.pf'], subject: 'S', body: 'B', cc: [], attachments: [] })));
    flow(done(), { email: 'm@example.pf' });
    await userEvent.click(screen.getByRole('button', { name: 'Other options' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Send by email/ }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('an error shows Retry and Open the order', async () => {
    const pay = mkPay({ step: 'invoice', wait: null, error: 'The payment is not on the invoice yet', paid: 12400 });
    const { onOpenOrder } = flow(pay);
    expect(screen.getByRole('alert')).toHaveTextContent('The payment is not on the invoice yet');
    expect(screen.getByText('The payment is recorded. Nothing is lost.')).toBeInTheDocument();
    expect(screen.getByRole('progressbar').firstElementChild).toHaveClass('bg-red-500');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(pay.retry).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: 'Open the order' }));
    expect(onOpenOrder).toHaveBeenCalledWith('so1');
  });
});
