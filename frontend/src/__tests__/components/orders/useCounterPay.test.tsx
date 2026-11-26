/** The counter-pay chain: each write once, a retry resumes after the last success. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { OrderBoardResponse } from '../../../api/client';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../../../api/client', async (orig) => {
  const mod = await orig<typeof import('../../../api/client')>();
  const fn = () => vi.fn();
  return {
    ...mod,
    api: {
      createCounterOrder: fn(), createOrderInvoice: fn(), applyOrderCredit: fn(), getOrderPicklistPreview: fn(),
      createOrderPicklist: fn(), createOrderParcel: fn(), handOverOrderParcel: fn(),
    },
  };
});
import { api } from '../../../api/client';
import { useCounterPay } from '../../../components/orders/useCounterPay';

const m = vi.mocked(api);
const body = { customer_id: 'c1', client_ref: 'r1', lines: [{ item_id: 'i1', quantity: 1 }] };
const line = (over = {}) => ({ id: 'l1', name: 'Vase', stock_available: 5, shortfall: 0, remaining: 2, packed_waiting: 0, ...over });
const inv = (balance: number) => ({ id: 'inv1', number: 'FAC-1', total: 12400, balance });
const mkRow = (over = {}, balance = 12400) => ({ id: 'so1', lines: [line()], payment: { invoices: [inv(balance)] }, packages: [{ id: 'pk1', number: 'PKG-1' }], ...over });
const boardOf = (row: unknown) => ({ rows: [row] }) as unknown as OrderBoardResponse;
const created = { invoice: 'created', invoice_number: 'FAC-1', manual_reason: null, credit_applied: 0, failed_step: null, error: null };

const setup = (opts?: { onCreateError?: (e: unknown) => void }) => {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, ...renderHook(() => useCounterPay(opts), { wrapper }) };
};
const arrange = (row: ReturnType<typeof mkRow>, invoiceBalance = 0) => {
  const paidRow = mkRow({ lines: row.lines }, invoiceBalance);
  m.createCounterOrder.mockResolvedValue({ board: boardOf(row), row, salesorder_id: 'so1' } as never);
  m.createOrderInvoice.mockResolvedValue({ board: boardOf(paidRow), outcome: created } as never);
  m.getOrderPicklistPreview.mockResolvedValue({ lines: row.lines.map((l) => ({ line_id: l.id, quantity: 2 })) } as never);
  m.createOrderPicklist.mockResolvedValue({ board: boardOf(paidRow), picklist: { id: 'pl1', number: 'PL-1' } } as never);
  m.createOrderParcel.mockResolvedValue({ board: boardOf(paidRow), package_number: 'PKG-1' } as never);
  m.handOverOrderParcel.mockResolvedValue({ board: boardOf(paidRow), outcome: created } as never);
};
const toPayment = async (r: ReturnType<typeof setup>) => {
  await act(async () => r.result.current.start(body));
  await waitFor(() => expect(r.result.current.step).toBe('payment'));
};

beforeEach(() => vi.resetAllMocks());

describe('useCounterPay', () => {
  it('runs create, then waits for the payment', async () => {
    arrange(mkRow());
    const r = setup();
    await toPayment(r);
    expect(r.result.current).toMatchObject({ wait: 'payment', active: true, busy: false });
    expect(m.createCounterOrder).toHaveBeenCalledTimes(1);
    expect(r.client.getQueryData(['order-board'])).toBeTruthy();
  });

  it('a failed create stays inactive and reports through onCreateError', async () => {
    m.createCounterOrder.mockRejectedValue(new Error('boom'));
    const onCreateError = vi.fn();
    const r = setup({ onCreateError });
    await act(async () => r.result.current.start(body));
    expect(onCreateError).toHaveBeenCalledTimes(1);
    expect(r.result.current).toMatchObject({ active: false, error: null, busy: false });
  });

  it('a full payment invoices the whole order with the cap', async () => {
    arrange(mkRow());
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.settle(12400));
    await waitFor(() => expect(r.result.current.step).toBe('handover'));
    expect(m.createOrderInvoice).toHaveBeenCalledWith('so1', { apply_credit: true, scope: 'whole', credit_cap: 12400 });
  });

  it('pay later invoices without credit', async () => {
    arrange(mkRow(), 12400);
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.payLater());
    await waitFor(() => expect(r.result.current.step).toBe('handover'));
    expect(m.createOrderInvoice).toHaveBeenCalledWith('so1', { apply_credit: false, scope: 'whole' });
    expect(r.result.current.later).toBe(true);
  });

  it('an invoice the payment did not reach is an error, and retry only applies the credit', async () => {
    arrange(mkRow(), 12400);
    m.applyOrderCredit.mockResolvedValue({ applied: 12400, board: boardOf(mkRow({}, 0)) } as never);
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.settle(12400));
    await waitFor(() => expect(r.result.current.error).toBe('orders.counterPay.notAttributed'));
    expect(r.result.current.step).toBe('invoice');
    await act(async () => r.result.current.retry());
    await waitFor(() => expect(r.result.current.step).toBe('handover'));
    expect(m.createOrderInvoice).toHaveBeenCalledTimes(1);
    expect(m.applyOrderCredit).toHaveBeenCalledTimes(1);
    expect(m.applyOrderCredit).toHaveBeenCalledWith('so1', 'inv1');
  });

  it('a server credit_unconfirmed outcome is not attributed even if the balance looks paid', async () => {
    arrange(mkRow(), 0);
    m.createOrderInvoice.mockResolvedValue({ board: boardOf(mkRow({}, 0)), outcome: { ...created, failed_step: 'credit', error: 'credit_unconfirmed' } } as never);
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.settle(12400));
    await waitFor(() => expect(r.result.current.error).toBe('orders.counterPay.notAttributed'));
  });

  it('a manual invoice outcome is worded from its reason', async () => {
    arrange(mkRow());
    m.createOrderInvoice.mockResolvedValue({ board: boardOf(mkRow()), outcome: { ...created, invoice: 'manual', invoice_number: null, manual_reason: 'draft' } } as never);
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.settle(12400));
    await waitFor(() => expect(r.result.current.error).toBe('orders.handover.manualDraft'));
    expect(r.result.current.step).toBe('invoice');
  });

  it('a partial payment passes the invoice step', async () => {
    arrange(mkRow({ lines: [line({ stock_available: 0, shortfall: 2 })] }), 2400);
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.settle(10000));
    await waitFor(() => expect(r.result.current.step).toBe('parcel'));
    expect(r.result.current.paid).toBe(10000);
    expect(r.result.current.question?.id).toBe('l1');
  });

  it('asks about a short line; "yes" forces it, "no" lists it as late', async () => {
    const shorts = mkRow({ lines: [line({ id: 'a', name: 'A', stock_available: 0, shortfall: 2 }), line({ id: 'b', name: 'B', stock_available: 0, shortfall: 2 })] });
    arrange(shorts);
    m.getOrderPicklistPreview.mockResolvedValue({ lines: [] } as never);
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.settle(12400));
    await waitFor(() => expect(r.result.current.question?.id).toBe('a'));
    await act(async () => r.result.current.answer(true));
    expect(r.result.current.question?.id).toBe('b');
    await act(async () => r.result.current.answer(false));
    await waitFor(() => expect(r.result.current.step).toBe('handover'));
    expect(r.result.current).toMatchObject({ forced: ['A'], handedLate: ['B'], question: null });
    expect(m.createOrderPicklist).toHaveBeenCalledWith('so1', [{ line_id: 'a', quantity: 2 }], ['a']);
  });

  it('a failed parcel retries without a second picklist', async () => {
    arrange(mkRow());
    m.createOrderParcel.mockRejectedValueOnce(new Error('nope'));
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.settle(12400));
    await waitFor(() => expect(r.result.current.error).toBe('nope'));
    expect(r.result.current.step).toBe('parcel');
    await act(async () => r.result.current.retry());
    await waitFor(() => expect(r.result.current.step).toBe('handover'));
    expect(m.createOrderPicklist).toHaveBeenCalledTimes(1);
    expect(m.createOrderParcel).toHaveBeenCalledTimes(2);
  });

  it('a service-only order ends on done after the invoice', async () => {
    arrange(mkRow());
    m.getOrderPicklistPreview.mockResolvedValue({ lines: [] } as never);
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.settle(12400));
    await waitFor(() => expect(r.result.current.step).toBe('done'));
    expect(m.createOrderPicklist).not.toHaveBeenCalled();
  });

  it('waits for the hand-over click, then hands over as pickup without credit', async () => {
    arrange(mkRow());
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.settle(12400));
    await waitFor(() => expect(r.result.current).toMatchObject({ step: 'handover', wait: 'handover' }));
    expect(m.handOverOrderParcel).not.toHaveBeenCalled();
    await act(async () => r.result.current.handOver());
    await waitFor(() => expect(r.result.current.step).toBe('done'));
    expect(m.handOverOrderParcel).toHaveBeenCalledTimes(1);
    expect(m.handOverOrderParcel).toHaveBeenCalledWith('so1', 'pk1', { mode: 'pickup', apply_credit: false });
  });

  it('a second click while a step runs does not start it twice', async () => {
    arrange(mkRow());
    let release: (v: unknown) => void = () => {};
    m.createOrderInvoice.mockReturnValue(new Promise((res) => { release = res; }) as never);
    const r = setup();
    await toPayment(r);
    act(() => { r.result.current.settle(12400); r.result.current.settle(12400); });
    expect(m.createOrderInvoice).toHaveBeenCalledTimes(1);
    await act(async () => release({ board: boardOf(mkRow({}, 0)), outcome: created }));
  });

  it('a cancelled payment leaves the row and goes inactive', async () => {
    arrange(mkRow());
    const r = setup();
    await toPayment(r);
    act(() => r.result.current.cancelPayment());
    expect(r.result.current).toMatchObject({ active: false, wait: null });
    expect(r.result.current.row?.id).toBe('so1');
    expect(m.createOrderInvoice).not.toHaveBeenCalled();
  });
});
