/** The counter-pay chain: each write once, a retry resumes after the last success. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ApiError } from '../../../api/client';
import type { OrderBoardResponse } from '../../../api/client';

const tSpy = vi.hoisted(() => vi.fn((k: string, _o?: unknown) => k));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: tSpy }) }));
vi.mock('../../../api/client', async (orig) => {
  const mod = await orig<typeof import('../../../api/client')>();
  const fn = () => vi.fn();
  return {
    ...mod,
    api: {
      createCounterOrder: fn(), createOrderInvoice: fn(), applyOrderCredit: fn(), getOrderPicklistPreview: fn(),
      createOrderPicklist: fn(), createOrderParcel: fn(), handOverOrderParcel: fn(), getOrderBoard: fn(),
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

beforeEach(() => {
  vi.resetAllMocks();
  tSpy.mockImplementation((k: string) => k);
});

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
    expect(r.result.current.step).toBe('order');
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
    m.getOrderBoard.mockResolvedValue(boardOf(mkRow({}, 12400)));
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.settle(12400));
    await waitFor(() => expect(r.result.current.error).toBe('orders.counterPay.notAttributed'));
    expect(r.result.current.error?.length).toBeGreaterThan(0);
    expect(r.result.current.step).toBe('invoice');
    await act(async () => r.result.current.retry());
    await waitFor(() => expect(r.result.current.step).toBe('handover'));
    expect(m.createOrderInvoice).toHaveBeenCalledTimes(1);
    expect(m.applyOrderCredit).toHaveBeenCalledTimes(1);
    expect(m.applyOrderCredit).toHaveBeenCalledWith('so1', 'inv1', 12400);
  });

  it('a partly paid sale retries the credit capped at what the invoice does not hold yet', async () => {
    arrange(mkRow(), 12400);
    m.createOrderInvoice.mockResolvedValue({ board: boardOf(mkRow({}, 12400)), outcome: created } as never);
    // 2000 taken, 500 already applied: balance 11900 on a 12400 invoice.
    m.getOrderBoard.mockResolvedValue(boardOf(mkRow({}, 11900)));
    m.applyOrderCredit.mockResolvedValue({ applied: 1500, board: boardOf(mkRow({}, 10400)) } as never);
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.settle(2000));
    await waitFor(() => expect(r.result.current.error).toBe('orders.counterPay.notAttributed'));
    await act(async () => r.result.current.retry());
    await waitFor(() => expect(r.result.current.step).toBe('handover'));
    expect(m.applyOrderCredit).toHaveBeenCalledWith('so1', 'inv1', 1500);
  });

  describe('the apply-credit retry words its refusals', () => {
    // First pass fails on the unpaid invoice; the retry re-reads it unpaid and applies the credit.
    const toRetry = async (refusal: unknown) => {
      arrange(mkRow(), 12400);
      m.getOrderBoard.mockResolvedValue(boardOf(mkRow({}, 12400)));
      m.applyOrderCredit.mockRejectedValue(refusal);
      const r = setup();
      await toPayment(r);
      await act(async () => r.result.current.settle(12400));
      await waitFor(() => expect(r.result.current.error).toBe('orders.counterPay.notAttributed'));
      await act(async () => r.result.current.retry());
      await waitFor(() => expect(m.applyOrderCredit).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(r.result.current.busy).toBe(false));
      return r;
    };

    it.each([['a coded detail', new ApiError('x', 400, 'no_credit')], ['a plain-string detail', new ApiError('no_credit', 400)]])(
      'a 400 no_credit (%s) says the payment is not on the invoice yet', async (_n, e) => {
        const r = await toRetry(e);
        expect(r.result.current).toMatchObject({ step: 'invoice', error: 'orders.counterPay.notAttributed' });
      });

    it('a 409 says the shop is busy', async () => {
      const r = await toRetry(new ApiError('Another action', 409));
      expect(r.result.current).toMatchObject({ step: 'invoice', error: 'orders.busy' });
    });

    it('another 400 code keeps the generic wording', async () => {
      const r = await toRetry(new ApiError('version', 400, 'other_code'));
      expect(r.result.current.error).toBe('orders.parcel.stale');
    });

    it('a 409 on a step that is not the retry keeps the generic wording', async () => {
      arrange(mkRow());
      m.createOrderInvoice.mockRejectedValue(new ApiError('Another action', 409));
      const r = setup();
      await toPayment(r);
      await act(async () => r.result.current.settle(12400));
      await waitFor(() => expect(r.result.current.error).toBe('orders.parcel.stale'));
    });
  });

  describe('invoice retry re-reads the board first', () => {
    // The created answer's board lacks the invoice: the hook holds its number but no id.
    const lacking = () => {
      arrange(mkRow(), 0);
      m.createOrderInvoice.mockResolvedValue({ board: boardOf(mkRow({ payment: { invoices: [] } })), outcome: created } as never);
    };
    const toError = async (r: ReturnType<typeof setup>) => {
      await toPayment(r);
      await act(async () => r.result.current.settle(12400));
      await waitFor(() => expect(r.result.current.error).toBe('orders.counterPay.notAttributed'));
    };

    it('an invoice missing from the answer but paid on the re-read goes on without apply-credit', async () => {
      lacking();
      m.getOrderBoard.mockResolvedValue(boardOf(mkRow({}, 0)));
      const r = setup();
      await toError(r);
      await act(async () => r.result.current.retry());
      await waitFor(() => expect(r.result.current.step).toBe('handover'));
      expect(m.applyOrderCredit).not.toHaveBeenCalled();
      expect(m.createOrderInvoice).toHaveBeenCalledTimes(1);
    });

    it('an unpaid invoice on the re-read gets the credit with its real id', async () => {
      lacking();
      m.getOrderBoard.mockResolvedValue(boardOf(mkRow({}, 12400)));
      m.applyOrderCredit.mockResolvedValue({ applied: 12400, board: boardOf(mkRow({}, 0)) } as never);
      const r = setup();
      await toError(r);
      await act(async () => r.result.current.retry());
      await waitFor(() => expect(r.result.current.step).toBe('handover'));
      expect(m.applyOrderCredit).toHaveBeenCalledTimes(1);
      expect(m.applyOrderCredit).toHaveBeenCalledWith('so1', 'inv1', 12400);
    });

    it('an invoice still missing on the re-read stays an error and never calls the API with an empty id', async () => {
      lacking();
      m.getOrderBoard.mockResolvedValue(boardOf(mkRow({ payment: { invoices: [] } })));
      const r = setup();
      await toError(r);
      await act(async () => r.result.current.retry());
      await waitFor(() => expect(m.getOrderBoard).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(r.result.current.busy).toBe(false));
      expect(r.result.current.error).toBe('orders.counterPay.notAttributed');
      expect(m.applyOrderCredit).not.toHaveBeenCalled();
    });

    it.each([
      ['a board without the order', () => boardOf(mkRow({ id: 'other' }, 12400))],
      ['a row holding only another invoice', () => boardOf(mkRow({ payment: { invoices: [{ id: 'inv9', number: 'FAC-9', total: 12400, balance: 0 }] } }))],
    ])('a re-read answered with %s stays notAttributed: no credit, no second invoice', async (_n, board) => {
      lacking();
      m.getOrderBoard.mockResolvedValue(board());
      const r = setup();
      await toError(r);
      await act(async () => r.result.current.retry());
      await waitFor(() => expect(m.getOrderBoard).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(r.result.current.busy).toBe(false));
      expect(r.result.current).toMatchObject({ step: 'invoice', error: 'orders.counterPay.notAttributed', invoice: null });
      expect(m.applyOrderCredit).not.toHaveBeenCalled();
      expect(m.createOrderInvoice).toHaveBeenCalledTimes(1);
    });

    it('a lost apply-credit answer: the next retry sees the invoice paid and does not apply again', async () => {
      arrange(mkRow(), 12400);
      m.applyOrderCredit.mockRejectedValueOnce(new Error('network'));
      m.getOrderBoard.mockResolvedValueOnce(boardOf(mkRow({}, 12400))).mockResolvedValue(boardOf(mkRow({}, 0)));
      const r = setup();
      await toError(r);
      await act(async () => r.result.current.retry());
      await waitFor(() => expect(r.result.current.error).toBe('network'));
      await act(async () => r.result.current.retry());
      await waitFor(() => expect(r.result.current.step).toBe('handover'));
      expect(m.applyOrderCredit).toHaveBeenCalledTimes(1);
    });
  });

  it('a line unticked at the payment step is invoiced but left out of the parcel, with no stock question', async () => {
    arrange(mkRow({ lines: [line({ id: 'a', name: 'A' }), line({ id: 'b', name: 'B', stock_available: 0, shortfall: 2 })] }));
    const r = setup();
    await toPayment(r);
    act(() => r.result.current.toggleHeld('b'));
    await act(async () => r.result.current.settle(12400));
    await waitFor(() => expect(r.result.current.step).toBe('handover'));
    expect(m.createOrderPicklist).toHaveBeenCalledWith('so1', [{ line_id: 'a', quantity: 2 }], []);
    expect(r.result.current.handedLate).toEqual(['B']);
    act(() => r.result.current.toggleHeld('a'));
    expect(r.result.current.held).toEqual(['b']);
  });

  it('two synchronous answers on one short line list its name once', async () => {
    arrange(mkRow({ lines: [line({ id: 'a', name: 'A', stock_available: 0, shortfall: 2 })] }));
    m.getOrderPicklistPreview.mockResolvedValue({ lines: [] } as never);
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.settle(12400));
    await waitFor(() => expect(r.result.current.question?.id).toBe('a'));
    await act(async () => {
      r.result.current.answer(true);
      r.result.current.answer(true);
    });
    await waitFor(() => expect(r.result.current.step).toBe('handover'));
    expect(r.result.current.forced).toEqual(['A']);
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

  describe('an invoice answer that is not a clean created', () => {
    const answered = async (outcome: Record<string, unknown>) => {
      arrange(mkRow());
      m.createOrderInvoice.mockResolvedValue({ board: boardOf(mkRow()), outcome: { ...created, ...outcome } } as never);
      const r = setup();
      await toPayment(r);
      await act(async () => r.result.current.settle(12400));
      await waitFor(() => expect(r.result.current.error).toBeTruthy());
      return r;
    };

    it('a draft left by a failed "mark sent" names the draft and its number, not the discount text', async () => {
      const r = await answered({ invoice: 'draft', invoice_number: 'FAC-7', manual_reason: null, failed_step: 'sent', error: 'timeout' });
      expect(r.result.current).toMatchObject({ step: 'invoice', error: 'orders.handover.manualDraft' });
      expect(tSpy).toHaveBeenCalledWith('orders.handover.manualDraft', { number: 'FAC-7' });
      expect(tSpy).not.toHaveBeenCalledWith('orders.handover.manual', expect.anything());
      expect(m.createOrderInvoice).toHaveBeenCalledTimes(1);
    });

    it('a manual outcome with reason draft keeps the draft text', async () => {
      const r = await answered({ invoice: 'manual', invoice_number: 'FAC-8', manual_reason: 'draft' });
      expect(r.result.current).toMatchObject({ step: 'invoice', error: 'orders.handover.manualDraft' });
      expect(tSpy).toHaveBeenCalledWith('orders.handover.manualDraft', { number: 'FAC-8' });
    });

    it('a manual outcome with another reason keeps the discount-or-charge text', async () => {
      const r = await answered({ invoice: 'manual', invoice_number: null, manual_reason: 'discount' });
      expect(r.result.current).toMatchObject({ step: 'invoice', error: 'orders.handover.manual' });
      expect(tSpy).toHaveBeenCalledWith('orders.handover.manual', { number: '' });
    });
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
    // The retry re-reads the board for a parcel to adopt: none there, so it posts again.
    m.getOrderBoard.mockResolvedValue(boardOf(mkRow({}, 0)));
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

  it('an invoice outcome none with an invoice on the row adopts it', async () => {
    arrange(mkRow(), 0);
    m.createOrderInvoice.mockResolvedValue({ board: boardOf(mkRow({}, 0)), outcome: { ...created, invoice: 'none', invoice_number: null } } as never);
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.settle(12400));
    await waitFor(() => expect(r.result.current.step).toBe('handover'));
    expect(r.result.current.error).toBeNull();
    expect(r.result.current.invoice?.id).toBe('inv1');
    expect(m.createOrderInvoice).toHaveBeenCalledTimes(1);
  });

  it('an adopted invoice the payment did not reach asks only for the credit', async () => {
    arrange(mkRow(), 12400);
    m.createOrderInvoice.mockResolvedValue({ board: boardOf(mkRow({}, 12400)), outcome: { ...created, invoice: 'none', invoice_number: null } } as never);
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.settle(12400));
    await waitFor(() => expect(r.result.current.error).toBe('orders.counterPay.notAttributed'));
    expect(m.applyOrderCredit).not.toHaveBeenCalled();
  });

  it('an invoice outcome none with no invoice on the row is a worded error and retry posts again', async () => {
    arrange(mkRow());
    m.createOrderInvoice.mockResolvedValue({ board: boardOf(mkRow({ payment: { invoices: [] } })), outcome: { ...created, invoice: 'none', invoice_number: null } } as never);
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.settle(12400));
    await waitFor(() => expect(r.result.current.error).toBe('orders.counterPay.noInvoice'));
    expect(r.result.current.step).toBe('invoice');
    await act(async () => r.result.current.retry());
    await waitFor(() => expect(m.createOrderInvoice).toHaveBeenCalledTimes(2));
  });

  describe('a lost invoice answer (outcome none): which live invoice is adopted', () => {
    const iv = (id: string, number: string, date: string | undefined, status: string) => ({ id, number, date, status, total: 12400, balance: 0 });
    const adopt = async (invoices: unknown[]) => {
      arrange(mkRow());
      m.createOrderInvoice.mockResolvedValue({ board: boardOf(mkRow({ payment: { invoices } })), outcome: { ...created, invoice: 'none', invoice_number: null } } as never);
      const r = setup();
      await toPayment(r);
      await act(async () => r.result.current.settle(12400));
      await waitFor(() => expect(r.result.current.step).toBe('handover'));
      return r;
    };

    it('takes the newest live invoice, skipping a newer void one and a newer draft', async () => {
      const r = await adopt([
        iv('i1', 'FAC-1', '2026-01-01', 'paid'), iv('i2', 'FAC-2', '2026-03-01', 'sent'),
        iv('i3', 'FAC-3', '2026-05-01', 'void'), iv('i4', 'FAC-4', '2026-06-01', 'draft'),
      ]);
      expect(r.result.current.invoice).toMatchObject({ id: 'i2', number: 'FAC-2' });
    });

    it('with equal dates the later one on the row wins', async () => {
      const r = await adopt([iv('i1', 'FAC-1', '2026-03-01', 'sent'), iv('i2', 'FAC-2', '2026-03-01', 'sent')]);
      expect(r.result.current.invoice).toMatchObject({ id: 'i2' });
    });

    it('ODDITY: an invoice with no date, met first, is never replaced by a dated one', async () => {
      const r = await adopt([iv('i1', 'FAC-1', undefined, 'sent'), iv('i2', 'FAC-2', '2026-03-01', 'sent')]);
      expect(r.result.current.invoice).toMatchObject({ id: 'i1' });
    });

    it('only void and draft invoices on the row is the no-invoice error', async () => {
      arrange(mkRow());
      m.createOrderInvoice.mockResolvedValue({ board: boardOf(mkRow({ payment: { invoices: [iv('i3', 'FAC-3', '2026-05-01', 'void'), iv('i4', 'FAC-4', '2026-06-01', 'draft')] } })), outcome: { ...created, invoice: 'none', invoice_number: null } } as never);
      const r = setup();
      await toPayment(r);
      await act(async () => r.result.current.settle(12400));
      await waitFor(() => expect(r.result.current.error).toBe('orders.counterPay.noInvoice'));
    });
  });

  it('a failed invoice outcome with no failed_step falls back to the invoice wording', async () => {
    arrange(mkRow());
    m.createOrderInvoice.mockResolvedValue({ board: boardOf(mkRow()), outcome: { ...created, invoice: 'failed', invoice_number: null, failed_step: null, error: 'zoho 500' } } as never);
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.settle(12400));
    await waitFor(() => expect(r.result.current.error).toBe('orders.handover.invoiceFailed'));
    expect(tSpy).toHaveBeenCalledWith('orders.handover.invoiceFailed', { reason: 'zoho 500' });
    expect(r.result.current.step).toBe('invoice');
  });

  it('a failed invoice outcome is worded, never empty', async () => {
    arrange(mkRow());
    m.createOrderInvoice.mockResolvedValue({ board: boardOf(mkRow()), outcome: { ...created, invoice: 'failed', invoice_number: null, failed_step: 'invoice', error: 'zoho 500' } } as never);
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.settle(12400));
    await waitFor(() => expect(r.result.current.error).toBe('orders.handover.invoiceFailed'));
  });

  it('a hand-over answer with a failed step is an error, and retry reaches done', async () => {
    arrange(mkRow());
    m.handOverOrderParcel.mockResolvedValueOnce({ board: boardOf(mkRow({}, 0)), outcome: { ...created, failed_step: 'delivered', error: 'x' } } as never);
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.settle(12400));
    await waitFor(() => expect(r.result.current.step).toBe('handover'));
    await act(async () => r.result.current.handOver());
    await waitFor(() => expect(r.result.current.error?.length).toBeGreaterThan(0));
    expect(r.result.current.step).toBe('handover');
    await act(async () => r.result.current.retry());
    await waitFor(() => expect(r.result.current.step).toBe('done'));
    expect(m.handOverOrderParcel).toHaveBeenCalledTimes(2);
  });

  it('a thrown createOrderInvoice is a worded error; the retry posts a second invoice call and adopts the one on the board', async () => {
    arrange(mkRow(), 0);
    m.createOrderInvoice.mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ board: boardOf(mkRow({}, 0)), outcome: { ...created, invoice: 'none', invoice_number: null } } as never);
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.settle(12400));
    await waitFor(() => expect(r.result.current.error).toBe('timeout'));
    expect(r.result.current.step).toBe('invoice');
    expect(r.result.current.busy).toBe(false);
    await act(async () => r.result.current.retry());
    await waitFor(() => expect(r.result.current.step).toBe('handover'));
    expect(m.createOrderInvoice).toHaveBeenCalledTimes(2);
    expect(m.applyOrderCredit).not.toHaveBeenCalled();
    expect(r.result.current.invoice?.id).toBe('inv1');
    expect(r.result.current.error).toBeNull();
  });

  it('a thrown hand-over is a worded error, and retry hands over again to done', async () => {
    arrange(mkRow());
    m.handOverOrderParcel.mockRejectedValueOnce(new Error('timeout'));
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.settle(12400));
    await waitFor(() => expect(r.result.current.step).toBe('handover'));
    await act(async () => r.result.current.handOver());
    await waitFor(() => expect(r.result.current.error).toBe('timeout'));
    expect(r.result.current.step).toBe('handover');
    await act(async () => r.result.current.retry());
    await waitFor(() => expect(r.result.current.step).toBe('done'));
    expect(m.handOverOrderParcel).toHaveBeenCalledTimes(2);
    expect(m.createOrderInvoice).toHaveBeenCalledTimes(1);
    expect(m.createOrderParcel).toHaveBeenCalledTimes(1);
  });

  it.each([['an empty-message Error', new Error('')], ['a non-Error rejection', 'plain string']])('%s still leaves a non-empty error and a callable retry', async (_n, reason) => {
    arrange(mkRow());
    m.createOrderParcel.mockRejectedValueOnce(reason);
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.settle(12400));
    await waitFor(() => expect(r.result.current.error).toBe('orders.handover.failed'));
    expect(r.result.current.step).toBe('parcel');
    // The retry re-reads the board for a parcel to adopt: none there, so it posts again.
    m.getOrderBoard.mockResolvedValue(boardOf(mkRow({}, 0)));
    await act(async () => r.result.current.retry());
    await waitFor(() => expect(r.result.current.step).toBe('handover'));
    expect(m.createOrderParcel).toHaveBeenCalledTimes(2);
  });

  it('retry with no error makes no API call', async () => {
    arrange(mkRow());
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.retry());
    expect(r.result.current).toMatchObject({ step: 'payment', busy: false, error: null });
    for (const f of Object.values(m)) if (f !== m.createCounterOrder) expect(f).not.toHaveBeenCalled();
    expect(m.createCounterOrder).toHaveBeenCalledTimes(1);
  });

  it('board answers invalidate the finished list and the events', async () => {
    arrange(mkRow());
    const r = setup();
    const spy = vi.spyOn(r.client, 'invalidateQueries');
    await toPayment(r);
    const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(['order-board', 'finished']));
    expect(keys).toContain(JSON.stringify(['order-events']));
  });

  it('start while active creates only one order', async () => {
    arrange(mkRow());
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.start(body));
    expect(m.createCounterOrder).toHaveBeenCalledTimes(1);
  });

  it('a parcel retry adopts the open picklist the lost answer left', async () => {
    arrange(mkRow());
    m.createOrderPicklist.mockRejectedValueOnce(new Error('timeout'));
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.settle(12400));
    await waitFor(() => expect(r.result.current.error).toBe('timeout'));
    m.getOrderBoard.mockResolvedValue(boardOf(mkRow({ picklists: [{ id: 'plX', number: 'PL-9', status: 'open' }] }, 0)));
    await act(async () => r.result.current.retry());
    await waitFor(() => expect(r.result.current.step).toBe('handover'));
    expect(m.createOrderPicklist).toHaveBeenCalledTimes(1);
    expect(m.createOrderParcel).toHaveBeenCalledWith('so1', 'plX', [{ line_id: 'l1', quantity: 2 }]);
  });

  describe('a parcel answer lost to a timeout', () => {
    const pk = (id: string, number: string, status = 'not_shipped') => ({ id, number, status });
    const lost = async (r: ReturnType<typeof setup>) => {
      await toPayment(r);
      await act(async () => r.result.current.settle(12400));
      await waitFor(() => expect(r.result.current.error).toBe('timeout'));
    };

    it('a retry adopts the one not-shipped parcel and hands over without posting again', async () => {
      arrange(mkRow());
      m.createOrderParcel.mockRejectedValueOnce(new Error('timeout'));
      const r = setup();
      await lost(r);
      m.getOrderBoard.mockResolvedValue(boardOf(mkRow({ packages: [pk('pkX', 'PKG-9')] }, 0)));
      await act(async () => r.result.current.retry());
      await waitFor(() => expect(r.result.current.step).toBe('handover'));
      expect(m.createOrderParcel).toHaveBeenCalledTimes(1);
      await act(async () => r.result.current.handOver());
      await waitFor(() => expect(r.result.current.step).toBe('done'));
      expect(m.handOverOrderParcel).toHaveBeenCalledWith('so1', 'pkX', { mode: 'pickup', apply_credit: false });
    });

    it('a retry posts again when the board shows no parcel to adopt', async () => {
      arrange(mkRow());
      m.createOrderParcel.mockRejectedValueOnce(new Error('timeout'));
      const r = setup();
      await lost(r);
      m.getOrderBoard.mockResolvedValue(boardOf(mkRow({ packages: [pk('pkS', 'PKG-0', 'shipped')] }, 0)));
      await act(async () => r.result.current.retry());
      await waitFor(() => expect(r.result.current.step).toBe('handover'));
      expect(m.createOrderParcel).toHaveBeenCalledTimes(2);
    });

    it('a retry does not guess between two not-shipped parcels and posts again', async () => {
      arrange(mkRow());
      m.createOrderParcel.mockRejectedValueOnce(new Error('timeout'));
      const r = setup();
      await lost(r);
      m.getOrderBoard.mockResolvedValue(boardOf(mkRow({ packages: [pk('pkA', 'PKG-8'), pk('pkB', 'PKG-9')] }, 0)));
      await act(async () => r.result.current.retry());
      await waitFor(() => expect(r.result.current.step).toBe('handover'));
      expect(m.createOrderParcel).toHaveBeenCalledTimes(2);
    });

    it('the first attempt never re-reads the board to adopt', async () => {
      arrange(mkRow());
      m.getOrderBoard.mockResolvedValue(boardOf(mkRow({ packages: [pk('pkX', 'PKG-9')] }, 0)));
      const r = setup();
      await toPayment(r);
      await act(async () => r.result.current.settle(12400));
      await waitFor(() => expect(r.result.current.step).toBe('handover'));
      expect(m.getOrderBoard).not.toHaveBeenCalled();
      expect(m.createOrderParcel).toHaveBeenCalledTimes(1);
    });

    it('reset clears the flag: the next sale posts its first parcel without a re-read', async () => {
      arrange(mkRow());
      m.createOrderParcel.mockRejectedValueOnce(new Error('timeout'));
      const r = setup();
      await lost(r);
      m.getOrderBoard.mockResolvedValue(boardOf(mkRow({ packages: [pk('pkX', 'PKG-9')] }, 0)));
      act(() => r.result.current.reset());
      await toPayment(r);
      await act(async () => r.result.current.settle(12400));
      await waitFor(() => expect(r.result.current.step).toBe('handover'));
      expect(m.createOrderParcel).toHaveBeenCalledTimes(2);
      expect(m.getOrderBoard).not.toHaveBeenCalled();
    });

    describe('a re-post refused after the server refreshed its copy', () => {
      const refused = (code = 'too_many') => new ApiError(code, 400);
      const text = (code: string) => `orders.err.${code}`;
      it.each(['too_many', 'nothing_to_pack'])('%s: one re-read adopts the one waiting parcel and hands over', async (code) => {
        arrange(mkRow());
        m.createOrderParcel.mockRejectedValueOnce(new Error('timeout'));
        const r = setup();
        await lost(r);
        m.createOrderParcel.mockRejectedValueOnce(refused(code));
        m.getOrderBoard.mockResolvedValueOnce(boardOf(mkRow({ packages: [] }, 0)));
        m.getOrderBoard.mockResolvedValueOnce(boardOf(mkRow({ packages: [pk('pkX', 'PKG-9')] }, 0)));
        await act(async () => r.result.current.retry());
        await waitFor(() => expect(r.result.current.step).toBe('handover'));
        expect(r.result.current.error).toBeNull();
        expect(m.createOrderParcel).toHaveBeenCalledTimes(2);
        expect(m.getOrderBoard).toHaveBeenCalledTimes(2);
        await act(async () => r.result.current.handOver());
        await waitFor(() => expect(r.result.current.step).toBe('done'));
        expect(m.handOverOrderParcel).toHaveBeenCalledWith('so1', 'pkX', { mode: 'pickup', apply_credit: false });
      });

      it.each([
        ['none', [] as ReturnType<typeof pk>[]],
        ['two', [pk('pkA', 'PKG-8'), pk('pkB', 'PKG-9')]],
      ])('the re-read shows %s waiting: the refusal is shown and retry stays available', async (_n, packages) => {
        arrange(mkRow());
        m.createOrderParcel.mockRejectedValueOnce(new Error('timeout'));
        const r = setup();
        await lost(r);
        m.createOrderParcel.mockRejectedValueOnce(refused());
        m.getOrderBoard.mockResolvedValueOnce(boardOf(mkRow({ packages: [] }, 0)));
        m.getOrderBoard.mockResolvedValueOnce(boardOf(mkRow({ packages }, 0)));
        await act(async () => r.result.current.retry());
        await waitFor(() => expect(r.result.current.error).toBe(text('too_many')));
        expect(r.result.current.step).toBe('parcel');
        expect(m.getOrderBoard).toHaveBeenCalledTimes(2);
        expect(m.createOrderParcel).toHaveBeenCalledTimes(2);
      });

      it('a first attempt refused too_many shows the refusal without any adoption re-read', async () => {
        arrange(mkRow());
        m.createOrderParcel.mockRejectedValueOnce(refused());
        m.getOrderBoard.mockResolvedValue(boardOf(mkRow({ packages: [pk('pkX', 'PKG-9')] }, 0)));
        const r = setup();
        await toPayment(r);
        await act(async () => r.result.current.settle(12400));
        await waitFor(() => expect(r.result.current.error).toBe(text('too_many')));
        expect(m.getOrderBoard).not.toHaveBeenCalled();
        expect(r.result.current.step).toBe('parcel');
      });

      it('another 400 code keeps today text and does not adopt', async () => {
        arrange(mkRow());
        m.createOrderParcel.mockRejectedValueOnce(new Error('timeout'));
        const r = setup();
        await lost(r);
        m.getOrderBoard.mockResolvedValue(boardOf(mkRow({ packages: [pk('pkX', 'PKG-9')] }, 0)));
        m.getOrderBoard.mockResolvedValueOnce(boardOf(mkRow({ packages: [] }, 0)));
        m.createOrderParcel.mockRejectedValueOnce(refused('picklist_open'));
        await act(async () => r.result.current.retry());
        await waitFor(() => expect(r.result.current.error).toBe(text('picklist_open')));
        expect(m.getOrderBoard).toHaveBeenCalledTimes(1);
      });

      it('a 409 keeps today text and does not adopt', async () => {
        arrange(mkRow());
        m.createOrderParcel.mockRejectedValueOnce(new Error('timeout'));
        const r = setup();
        await lost(r);
        m.getOrderBoard.mockResolvedValueOnce(boardOf(mkRow({ packages: [] }, 0)));
        m.createOrderParcel.mockRejectedValueOnce(new ApiError('too_many', 409));
        await act(async () => r.result.current.retry());
        await waitFor(() => expect(r.result.current.error).toBe('orders.parcel.stale'));
        expect(m.getOrderBoard).toHaveBeenCalledTimes(1);
      });

      it('a failed re-read surfaces the original refusal, not the re-read error', async () => {
        arrange(mkRow());
        m.createOrderParcel.mockRejectedValueOnce(new Error('timeout'));
        const r = setup();
        await lost(r);
        m.createOrderParcel.mockRejectedValueOnce(refused());
        m.getOrderBoard.mockResolvedValueOnce(boardOf(mkRow({ packages: [] }, 0)));
        m.getOrderBoard.mockRejectedValueOnce(new Error('offline'));
        await act(async () => r.result.current.retry());
        await waitFor(() => expect(r.result.current.error).toBe(text('too_many')));
        expect(r.result.current.step).toBe('parcel');
      });

      it('reset clears the flag: a first-attempt refusal in the next sale is not adopted', async () => {
        arrange(mkRow());
        m.createOrderParcel.mockRejectedValueOnce(new Error('timeout'));
        const r = setup();
        await lost(r);
        act(() => r.result.current.reset());
        m.createOrderParcel.mockRejectedValueOnce(refused());
        m.getOrderBoard.mockResolvedValue(boardOf(mkRow({ packages: [pk('pkX', 'PKG-9')] }, 0)));
        await toPayment(r);
        await act(async () => r.result.current.settle(12400));
        await waitFor(() => expect(r.result.current.error).toBe(text('too_many')));
        expect(m.getOrderBoard).not.toHaveBeenCalled();
      });
    });

    it('a failed re-read shows the error and keeps the retry available', async () => {
      arrange(mkRow());
      m.createOrderParcel.mockRejectedValueOnce(new Error('timeout'));
      const r = setup();
      await lost(r);
      m.getOrderBoard.mockRejectedValueOnce(new Error('offline'));
      await act(async () => r.result.current.retry());
      await waitFor(() => expect(r.result.current.error).toBe('offline'));
      expect(m.createOrderParcel).toHaveBeenCalledTimes(1);
      m.getOrderBoard.mockResolvedValue(boardOf(mkRow({ packages: [pk('pkX', 'PKG-9')] }, 0)));
      await act(async () => r.result.current.retry());
      await waitFor(() => expect(r.result.current.step).toBe('handover'));
      expect(m.createOrderParcel).toHaveBeenCalledTimes(1);
    });
  });

  it('a package missing from the row refetches the board once', async () => {
    arrange(mkRow());
    m.createOrderParcel.mockResolvedValue({ board: boardOf(mkRow({ packages: [] }, 0)), package_number: 'PKG-1' } as never);
    m.getOrderBoard.mockResolvedValue(boardOf(mkRow({}, 0)));
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.settle(12400));
    await waitFor(() => expect(r.result.current.step).toBe('handover'));
    expect(m.getOrderBoard).toHaveBeenCalledTimes(1);
  });

  it('a fractional quantity flows into the picklist and parcel unchanged', async () => {
    arrange(mkRow());
    m.getOrderPicklistPreview.mockResolvedValue({ lines: [{ line_id: 'l1', quantity: 2.5 }] } as never);
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.settle(12400));
    await waitFor(() => expect(r.result.current.step).toBe('handover'));
    expect(m.createOrderPicklist).toHaveBeenCalledWith('so1', [{ line_id: 'l1', quantity: 2.5 }], []);
    expect(m.createOrderParcel).toHaveBeenCalledWith('so1', 'pl1', [{ line_id: 'l1', quantity: 2.5 }]);
  });

  it('reset after a finished sale lets the next one create an order and post a new picklist', async () => {
    arrange(mkRow());
    const r = setup();
    const sale = async () => {
      await toPayment(r);
      await act(async () => r.result.current.settle(12400));
      await waitFor(() => expect(r.result.current.step).toBe('handover'));
      await act(async () => r.result.current.handOver());
      await waitFor(() => expect(r.result.current.step).toBe('done'));
    };
    await sale();
    act(() => r.result.current.reset());
    expect(r.result.current).toMatchObject({ active: false, step: 'order', paid: 0, invoice: null, row: null });
    await sale();
    expect(m.createCounterOrder).toHaveBeenCalledTimes(2);
    expect(m.createOrderPicklist).toHaveBeenCalledTimes(2);
    expect(m.createOrderInvoice).toHaveBeenCalledTimes(2);
  });

  it('reset while a step runs does nothing', async () => {
    arrange(mkRow());
    m.createOrderInvoice.mockReturnValue(new Promise(() => {}) as never);
    const r = setup();
    await toPayment(r);
    act(() => r.result.current.settle(12400));
    await waitFor(() => expect(r.result.current.busy).toBe(true));
    act(() => r.result.current.reset());
    expect(r.result.current).toMatchObject({ active: true, step: 'invoice', busy: true });
  });

  it('the retry credit cap is rounded to the cent (no float residue sent to Books)', async () => {
    // 100.3 - 100.1 = 0.19999999999999574 held on the invoice, so 0.3 - that = 0.10000000000000426 unrounded.
    const money = (balance: number) => mkRow({ payment: { invoices: [{ id: 'inv1', number: 'FAC-1', total: 100.3, balance }] } });
    arrange(mkRow(), 12400);
    m.createOrderInvoice.mockResolvedValue({ board: boardOf(money(100.3)), outcome: created } as never);
    m.getOrderBoard.mockResolvedValue(boardOf(money(100.1)));
    m.applyOrderCredit.mockResolvedValue({ applied: 0.1, board: boardOf(money(100.2)) } as never);
    const r = setup();
    await toPayment(r);
    await act(async () => r.result.current.settle(0.3));
    await waitFor(() => expect(r.result.current.error).toBe('orders.counterPay.notAttributed'));
    await act(async () => r.result.current.retry());
    await waitFor(() => expect(m.applyOrderCredit).toHaveBeenCalledTimes(1));
    expect(m.applyOrderCredit).toHaveBeenCalledWith('so1', 'inv1', 0.1);
  });

  describe('re-entry guards', () => {
    const toHandover = async (r: ReturnType<typeof setup>) => {
      await toPayment(r);
      await act(async () => r.result.current.settle(12400));
      await waitFor(() => expect(r.result.current.step).toBe('handover'));
    };

    it('a second start() while the first runs creates one order', async () => {
      arrange(mkRow());
      const r = setup();
      await act(async () => {
        void r.result.current.start(body);
        void r.result.current.start(body);
      });
      await waitFor(() => expect(r.result.current.step).toBe('payment'));
      expect(m.createCounterOrder).toHaveBeenCalledTimes(1);
    });

    it('a second handOver() while the hand-over write is in flight posts once', async () => {
      arrange(mkRow());
      let release: (v: unknown) => void = () => {};
      m.handOverOrderParcel.mockReturnValue(new Promise((res) => { release = res; }) as never);
      const r = setup();
      await toHandover(r);
      await act(async () => {
        r.result.current.handOver();
        r.result.current.handOver();
      });
      expect(m.handOverOrderParcel).toHaveBeenCalledTimes(1);
      await act(async () => r.result.current.handOver());
      expect(m.handOverOrderParcel).toHaveBeenCalledTimes(1);
      await act(async () => release({ board: boardOf(mkRow({}, 0)), outcome: created }));
      await waitFor(() => expect(r.result.current.step).toBe('done'));
    });

    it('handOver() outside the hand-over step does nothing', async () => {
      arrange(mkRow());
      const r = setup();
      await toPayment(r);
      await act(async () => r.result.current.handOver());
      expect(m.handOverOrderParcel).not.toHaveBeenCalled();
      expect(r.result.current.step).toBe('payment');
    });

    it('handOver() with an error on screen does nothing (retry is the way)', async () => {
      arrange(mkRow());
      m.handOverOrderParcel.mockResolvedValueOnce({ board: boardOf(mkRow({}, 0)), outcome: { ...created, failed_step: 'delivered', error: 'x' } } as never);
      const r = setup();
      await toHandover(r);
      await act(async () => r.result.current.handOver());
      await waitFor(() => expect(r.result.current.error).toBeTruthy());
      await act(async () => r.result.current.handOver());
      expect(m.handOverOrderParcel).toHaveBeenCalledTimes(1);
    });

    it('cancelPayment() while a write is running keeps the sale active', async () => {
      arrange(mkRow());
      m.createOrderInvoice.mockReturnValue(new Promise(() => {}) as never);
      const r = setup();
      await toPayment(r);
      // Same render closure: step is still 'payment' when the second call runs, the ref says a write started.
      act(() => {
        r.result.current.settle(12400);
        r.result.current.cancelPayment();
      });
      await waitFor(() => expect(r.result.current.busy).toBe(true));
      expect(r.result.current).toMatchObject({ active: true, wait: null });
    });

    it('cancelPayment() after the payment step keeps the sale active', async () => {
      arrange(mkRow());
      const r = setup();
      await toHandover(r);
      act(() => r.result.current.cancelPayment());
      expect(r.result.current).toMatchObject({ active: true, step: 'handover', wait: 'handover' });
    });

    it('cancelPayment() on the payment step with nothing running ends the sale', async () => {
      arrange(mkRow());
      const r = setup();
      await toPayment(r);
      act(() => r.result.current.cancelPayment());
      expect(r.result.current).toMatchObject({ active: false, wait: null });
    });
  });
});
