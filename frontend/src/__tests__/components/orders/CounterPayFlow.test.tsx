import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { render } from '../../utils';

const print = vi.fn();
// The props the flow hands the card dialog, captured so a test can drive them like the real dialog would.
const dialogProps = vi.hoisted(() => ({ current: null as null | {
  document: { id: string; due: number | null };
  onStart: (amount: number) => Promise<unknown>;
  recover: (e: unknown) => null | { message: string; label: string; start: (amount: number) => Promise<unknown> };
  fetchPayment: () => Promise<unknown>;
} }));
vi.mock('../../../components/aito/usePrintBlob', () => ({ usePrintBlob: () => ({ print, busy: false }) }));

// The real dialog polls every 3 s: a stand-in that reports what the test tells it to.
vi.mock('../../../components/aito/payment/TerminalPaymentModal', () => ({
  TerminalPaymentDialog: (props: { onSeen: (p: unknown) => void; onClose: () => void } & NonNullable<typeof dialogProps.current>) => {
    dialogProps.current = props;
    const { onSeen, onClose } = props;
    return (
    <div data-testid="terminal-dialog">
      <button type="button" onClick={() => onSeen({ id: 1, status: 'paid', booking_status: 'booked', amount: 12400, amount_confirmed: 12400 })}>seen-paid</button>
      <button type="button" onClick={onClose}>close-dialog</button>
    </div>
    );
  },
}));

import { ApiError, api } from '../../../api/client';
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

const charge = (status: string, booking_status: string | null = 'booked') => ({
  id: 1, document_kind: 'invoice', document_number: 'SO-9', status, amount: 12400, amount_confirmed: 12400, booking_status,
  booking_error: null, sync_error: null, created_at: '', settled_at: null,
});
const TERMINAL = '/api/v1/order-board/orders/so1/terminal-payment';
const currentCharge = (row: unknown) => server.use(http.get(TERMINAL, () => HttpResponse.json(row)));
const target = () => server.use(http.get('/api/v1/order-board/orders/so1/payment-target', () =>
  HttpResponse.json({ kind: 'salesorder', document_id: 'so1', number: 'SO-9', max_amount: 12400, left: 12400, link: null })));

beforeEach(() => currentCharge(null));
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

  it('an open card charge blocks cash and pay later, and says why', async () => {
    currentCharge(charge('pending', null));
    const pay = mkPay();
    flow(pay, { isDefaultClient: false });
    const later = screen.getByRole('button', { name: /^Pay later/ });
    await vi.waitFor(() => expect(later).toHaveAttribute('aria-disabled', 'true'));
    await userEvent.click(later);
    expect(screen.getByRole('alert')).toHaveTextContent('already in progress');
    await userEvent.click(screen.getByRole('button', { name: 'Cash or cheque' }));
    expect(pay.payLater).not.toHaveBeenCalled();
    expect(screen.queryByRole('radio', { name: 'Cash' })).not.toBeInTheDocument();
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
    expect(await screen.findByRole('radio', { name: 'Cash' }, { timeout: 3000 })).toHaveAttribute('aria-checked', 'true');
    await user.click(await screen.findByRole('button', { name: /^Record|^Save|^Confirm/i }, { timeout: 3000 }));
    await vi.waitFor(() => expect(pay.settle).toHaveBeenCalledWith(12400));
    expect(recorded).toMatchObject({ amount: 12400, mode: 'cash' });
    expect(pay.settle).toHaveBeenCalledTimes(1);
  });

  it('asks the stock question and answers it', async () => {
    const pay = mkPay({ wait: 'stock', step: 'parcel', question: { id: 'l1', name: 'PETG HF Noir', remaining: 3, packed_waiting: 0, stock_available: 1 } });
    flow(pay);
    expect(screen.getByText(/PETG HF Noir ×3: Zoho shows 1 in stock/)).toBeInTheDocument();
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

  describe('a card paid behind a closed dialog', () => {
    it('onSeen fired three times with the same paid, booked charge settles once', async () => {
      const user = userEvent.setup();
      target();
      const pay = mkPay();
      flow(pay);
      await user.click(screen.getByRole('button', { name: 'Card (terminal)' }));
      const seen = await screen.findByRole('button', { name: 'seen-paid' });
      await user.click(seen);
      await user.click(seen);
      await user.click(seen);
      expect(pay.settle).toHaveBeenCalledTimes(1);
      expect(pay.settle).toHaveBeenCalledWith(12400);
    });

    it('the polled current charge settles once it is paid and booked, after the dialog was closed', async () => {
      const user = userEvent.setup();
      target();
      const pay = mkPay();
      flow(pay);
      await user.click(screen.getByRole('button', { name: 'Card (terminal)' }));
      await screen.findByTestId('terminal-dialog');
      currentCharge(charge('paid'));
      await user.click(screen.getByRole('button', { name: 'close-dialog' }));
      await vi.waitFor(() => expect(pay.settle).toHaveBeenCalledWith(12400));
      expect(pay.settle).toHaveBeenCalledTimes(1);
    });

    it('a paid charge whose booking is pending does not settle yet', async () => {
      currentCharge(charge('paid', 'pending'));
      const pay = mkPay();
      flow(pay);
      await new Promise(r => setTimeout(r, 150));
      expect(pay.settle).not.toHaveBeenCalled();
    });

    it.each(['failed', 'cancelled', 'expired', 'needs_attention'])('a %s charge never settles', async (status) => {
      currentCharge(charge(status, null));
      const pay = mkPay();
      flow(pay);
      await new Promise(r => setTimeout(r, 150));
      expect(pay.settle).not.toHaveBeenCalled();
    });

    it('Card while the current charge is already paid and booked settles instead of offering a new charge', async () => {
      const user = userEvent.setup();
      target();
      const pay = mkPay();
      flow(pay);
      // The mount poll saw nothing yet; the click reads the charge afresh.
      currentCharge(charge('paid'));
      await user.click(screen.getByRole('button', { name: 'Card (terminal)' }));
      await vi.waitFor(() => expect(pay.settle).toHaveBeenCalledWith(12400));
      expect(screen.queryByTestId('terminal-dialog')).not.toBeInTheDocument();
    });
  });

  it('brings the active panel into view when the step changes', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    flow(mkPay());
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    // @ts-expect-error test cleanup
    delete Element.prototype.scrollIntoView;
  });

  it('reports a payment dialog opening and closing', async () => {
    const user = userEvent.setup();
    target();
    const onDialog = vi.fn();
    flow(mkPay(), { onDialog });
    await user.click(screen.getByRole('button', { name: 'Card (terminal)' }));
    await screen.findByTestId('terminal-dialog');
    expect(onDialog).toHaveBeenLastCalledWith(true);
    await user.click(screen.getByRole('button', { name: 'close-dialog' }));
    expect(onDialog).toHaveBeenLastCalledWith(false);
  });

  describe('the payment target', () => {
    const targetOf = (o: Record<string, unknown>) => server.use(http.get('/api/v1/order-board/orders/so1/payment-target', () =>
      HttpResponse.json({ kind: 'salesorder', document_id: 'so1', number: 'SO-9', max_amount: 12400, left: 12400, link: null, ...o })));

    it.each([
      ['kind', { kind: null }],
      ['document_id', { document_id: null }],
      ['max_amount', { max_amount: null }],
    ])('a target without %s shows the error toast and opens no dialog', async (_name, o) => {
      const user = userEvent.setup();
      targetOf(o);
      flow(mkPay());
      await user.click(screen.getByRole('button', { name: 'Card (terminal)' }));
      expect(await screen.findByText('Error loading data')).toBeInTheDocument();
      expect(screen.queryByTestId('terminal-dialog')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Card (terminal)' })).toBeEnabled();
    });

    it('a rejected target read shows the error toast and re-enables both buttons', async () => {
      const user = userEvent.setup();
      server.use(http.get('/api/v1/order-board/orders/so1/payment-target', () => HttpResponse.json({ detail: 'boom' }, { status: 500 })));
      flow(mkPay());
      await user.click(screen.getByRole('button', { name: 'Cash or cheque' }));
      expect(await screen.findByText('Error loading data')).toBeInTheDocument();
      expect(screen.queryByRole('radio', { name: 'Cash' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Card (terminal)' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Cash or cheque' })).toBeEnabled();
    });

    it.each([
      ['more left than max_amount is clamped to max_amount', { left: 12.6, max_amount: 10 }, 10],
      ['a fractional left is rounded', { left: 12.6, max_amount: 100 }, 13],
      ['nothing left leaves no due', { left: 0 }, null],
      ['a negative left leaves no due', { left: -5 }, null],
    ])('%s', async (_name, o, due) => {
      const user = userEvent.setup();
      targetOf(o);
      flow(mkPay());
      await user.click(screen.getByRole('button', { name: 'Card (terminal)' }));
      await screen.findByTestId('terminal-dialog');
      expect(dialogProps.current!.document.due).toBe(due);
    });
  });

  describe('the card dialog wiring', () => {
    const openDialog = async () => {
      const user = userEvent.setup();
      target();
      flow(mkPay());
      await user.click(screen.getByRole('button', { name: 'Card (terminal)' }));
      await screen.findByTestId('terminal-dialog');
      return dialogProps.current!;
    };
    afterEach(() => vi.restoreAllMocks());

    it('onStart charges the amount without the force flag', async () => {
      const start = vi.spyOn(api, 'startOrderTerminalPayment').mockResolvedValue({ id: 1 } as never);
      const props = await openDialog();
      await props.onStart(5000);
      expect(start).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledWith('so1', 5000);
    });

    it('a link_open refusal offers to cancel the pay link and charge, forcing exactly once', async () => {
      const start = vi.spyOn(api, 'startOrderTerminalPayment').mockResolvedValue({ id: 1 } as never);
      const props = await openDialog();
      const offer = props.recover(new ApiError('open', 409, 'link_open'));
      expect(offer).toMatchObject({ message: expect.any(String), label: expect.any(String) });
      expect(start).not.toHaveBeenCalled();
      await offer!.start(7000);
      expect(start).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledWith('so1', 7000, true);
    });

    it('any other error offers no recovery', async () => {
      const props = await openDialog();
      expect(props.recover(new ApiError('nope', 409, 'other'))).toBeNull();
      expect(props.recover(new Error('link_open'))).toBeNull();
    });

    it('fetchPayment returns the current charge, and throws when there is none', async () => {
      const props = await openDialog();
      currentCharge(charge('pending', null));
      await expect(props.fetchPayment()).resolves.toMatchObject({ id: 1 });
      currentCharge(null);
      await expect(props.fetchPayment()).rejects.toThrow();
    });
  });
});
