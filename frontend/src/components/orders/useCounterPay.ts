import { useReducer, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '../../api/client';
import type { CounterOrderLine, OrderBoardLine, OrderBoardResponse, OrderBoardRow, OrderInvoice, OrderPickLines } from '../../api/client';
import { attributed, invoiceOf, pickLines, rowOf, shortLines } from './counterPay';
import type { PayStep } from './counterPay';
import { errorReason, failedStepText } from './orderErrors';
import { waitingPackages } from './orderBoard';
import { takeBoard } from './useOrderActions';

export type PayWait = 'payment' | 'stock' | 'handover' | null;
export interface CounterPayState {
  step: PayStep;
  busy: boolean;
  wait: PayWait;
  error: string | null;
  row: OrderBoardRow | null;
  paid: number;
  later: boolean;
  invoice: OrderInvoice | null;
  question: OrderBoardLine | null;
  handedLate: string[];
  forced: string[];
  active: boolean;
}

const INITIAL: CounterPayState = {
  step: 'order', busy: false, wait: null, error: null, row: null, paid: 0, later: false, invoice: null, question: null, handedLate: [], forced: [], active: false,
};

/** What a retry resumes at: each stage's write is skipped once it succeeded. */
type Stage = 'invoice' | 'parcel' | 'handover';

/** The counter-pay chain: order → payment → invoice → parcel → hand-over. Refs hold the ids and answers of the writes already done. */
export function useCounterPay(opts?: { onCreateError?: (e: unknown) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [state, patch] = useReducer((s: CounterPayState, p: Partial<CounterPayState>) => ({ ...s, ...p }), INITIAL);
  const running = useRef(false);
  const fresh = () => ({
    orderId: '', row: null as OrderBoardRow | null, paid: 0, invoiceNumber: null as string | null, invoiceId: '',
    queue: [] as OrderBoardLine[], have: new Set<string>(), lines: null as OrderPickLines['lines'] | null, force: [] as string[], picklistPosted: false, parcelPosted: false,
    picklistId: '', packageNumber: '', packageId: '', stage: 'invoice' as Stage,
    asked: null as OrderBoardLine | null, forcedNames: [] as string[], lateNames: [] as string[],
  });
  const m = useRef(fresh());

  const take = async (board: OrderBoardResponse): Promise<OrderBoardRow | null> => {
    await takeBoard(queryClient, board);
    const row = rowOf(board, m.current.orderId) ?? null;
    if (row) {
      m.current.row = row;
      patch({ row });
    }
    return row;
  };

  const fail = (stage: Stage, step: PayStep, message: string) => {
    m.current.stage = stage;
    // An empty error would leave retry() disabled and the operator with nothing on screen.
    patch({ step, error: message || t('orders.handover.failed', { reason: '' }) });
  };

  // The one guard against two clicks: a step is started only when none is running.
  const run = async (fn: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    patch({ busy: true, error: null });
    try {
      await fn();
    } finally {
      running.current = false;
      patch({ busy: false });
    }
  };
  const guarded = (stage: Stage, step: PayStep, fn: () => Promise<void>) => async () => {
    try {
      await fn();
    } catch (e) {
      fail(stage, step, errorReason(t, e));
    }
  };

  const checkInvoice = (row: OrderBoardRow | null): boolean => {
    const invoice = invoiceOf(row ?? undefined, m.current.invoiceNumber);
    if (invoice) m.current.invoiceId = invoice.id;
    patch({ invoice: invoice ?? null });
    if (attributed(invoice, m.current.paid)) return true;
    fail('invoice', 'invoice', t('orders.counterPay.notAttributed'));
    return false;
  };

  const runHandOver = guarded('handover', 'handover', async () => {
    const { orderId, packageId } = m.current;
    const r = await api.handOverOrderParcel(orderId, packageId, { mode: 'pickup', apply_credit: false });
    await take(r.board);
    // The server answers 200 when only a later step (delivered) failed: Books has no "Livré" yet.
    if (r.outcome.failed_step) fail('handover', 'handover', failedStepText(t, r.outcome));
    else patch({ step: 'done', wait: null });
  });

  const runParcel = guarded('parcel', 'parcel', async () => {
    const c = m.current;
    if (!c.packageNumber) {
      if (!c.lines) {
        const preview = await api.getOrderPicklistPreview(c.orderId);
        const picked = pickLines(c.row as OrderBoardRow, preview.lines, c.have);
        c.lines = picked.lines.filter((l) => l.quantity > 0);
        c.force = picked.force;
      }
      if (!c.lines.length) {
        patch({ step: 'done', wait: null });
        return;
      }
      // A picklist posted before a lost answer is still open on the board: the server refuses a second one.
      if (!c.picklistId && c.picklistPosted) await take(await api.getOrderBoard());
      if (!c.picklistId) c.picklistId = c.row?.picklists?.find((p) => p.status !== 'completed')?.id ?? '';
      if (!c.picklistId) {
        c.picklistPosted = true;
        const pl = await api.createOrderPicklist(c.orderId, c.lines, c.force);
        c.picklistId = pl.picklist.id;
        await take(pl.board);
      }
      // A parcel posted before a lost answer is already on the order: adopt it (only when it is the one not-shipped parcel).
      if (c.parcelPosted) {
        const waiting = waitingPackages((await take(await api.getOrderBoard())) ?? { packages: [] });
        if (waiting.length === 1) c.packageNumber = waiting[0].number;
      }
      if (!c.packageNumber) {
        c.parcelPosted = true;
        const parcel = await api.createOrderParcel(c.orderId, c.picklistId, c.lines);
        c.packageNumber = parcel.package_number;
        await take(parcel.board);
      }
    }
    let pkg = c.row?.packages.find((p) => p.number === c.packageNumber);
    if (!pkg) {
      await take(await api.getOrderBoard());
      pkg = c.row?.packages.find((p) => p.number === c.packageNumber);
    }
    if (!pkg) throw new Error(t('orders.parcel.stale'));
    c.packageId = pkg.id;
    patch({ step: 'handover', wait: 'handover' });
  });

  const toParcel = async () => {
    const c = m.current;
    const shorts = c.row ? shortLines(c.row) : [];
    if (shorts.length) {
      c.queue = shorts;
      c.asked = shorts[0];
      patch({ step: 'parcel', wait: 'stock', question: shorts[0] });
      return;
    }
    patch({ step: 'parcel', wait: null, question: null });
    await runParcel();
  };

  const runInvoice = guarded('invoice', 'invoice', async () => {
    const c = m.current;
    patch({ step: 'invoice', wait: null });
    if (!c.invoiceNumber) {
      const r = await api.createOrderInvoice(c.orderId, c.paid > 0 ? { apply_credit: true, scope: 'whole', credit_cap: c.paid } : { apply_credit: false, scope: 'whole' });
      const row = await take(r.board);
      const o = r.outcome;
      if (o.invoice === 'created' && o.invoice_number) c.invoiceNumber = o.invoice_number;
      else if (o.invoice === 'manual' || o.invoice === 'draft') {
        fail('invoice', 'invoice', t(o.invoice === 'draft' || o.manual_reason === 'draft' ? 'orders.handover.manualDraft' : 'orders.handover.manual', { number: o.invoice_number ?? '' }));
        return;
      } else if (o.failed_step || o.invoice === 'failed') {
        fail('invoice', 'invoice', failedStepText(t, { ...o, failed_step: o.failed_step ?? 'invoice' }));
        return;
      } else {
        // 'none' after a lost answer: the invoice may already be on the order, so adopt the newest live one.
        const live = (row?.payment?.invoices ?? []).filter((i) => i.status !== 'void' && i.status !== 'draft');
        const newest = live.reduce<OrderInvoice | undefined>((a, i) => (!a || i.date >= a.date ? i : a), undefined);
        if (!newest) {
          fail('invoice', 'invoice', t('orders.counterPay.noInvoice'));
          return;
        }
        c.invoiceNumber = newest.number;
      }
      if (!checkInvoice(row)) return;
      if (o.failed_step === 'credit') {
        fail('invoice', 'invoice', t('orders.counterPay.notAttributed'));
        return;
      }
    } else {
      // Created earlier: re-read first, the invoice may be paid already (lost answer) or missing from the answered board.
      let row = await take(await api.getOrderBoard());
      const invoice = invoiceOf(row ?? undefined, c.invoiceNumber);
      // The cap: only what this sale took and the invoice does not hold yet, never the customer's other credit.
      if (invoice && !attributed(invoice, c.paid)) {
        try {
          row = await take((await api.applyOrderCredit(c.orderId, invoice.id, Math.max(0, Math.round((c.paid - (invoice.total - invoice.balance)) * 100) / 100))).board);
        } catch (e) {
          // The payment is not on the stored board yet, or the first attempt is still writing: say that, not "quantities".
          if (e instanceof ApiError && ((e.status === 400 && (e.code ?? e.message) === 'no_credit') || e.status === 409)) {
            fail('invoice', 'invoice', t(e.status === 409 ? 'orders.busy' : 'orders.counterPay.notAttributed'));
            return;
          }
          throw e;
        }
      }
      if (!checkInvoice(row)) return;
    }
    await toParcel();
  });

  const startChain = (body: { customer_id: string; client_ref: string; lines: CounterOrderLine[] }) =>
    state.active ? Promise.resolve() : run(async () => {
      patch({ ...INITIAL, active: true, busy: true });
      let res;
      try {
        res = await api.createCounterOrder(body);
      } catch (e) {
        patch({ active: false });
        opts?.onCreateError?.(e);
        return;
      }
      m.current = { ...fresh(), orderId: res.salesorder_id };
      const row = (await take(res.board)) ?? res.row;
      patch({ step: 'payment', wait: 'payment', row });
    });

  const settleWith = (amount: number) => {
    if (state.step !== 'payment' || !state.active || running.current) return;
    m.current.paid = amount;
    patch({ paid: amount, later: amount <= 0 });
    void run(runInvoice);
  };

  const answer = (have: boolean) => {
    const c = m.current;
    // The ref moves on before any state update: a second click cannot answer the same line.
    const q = c.asked;
    if (!q || running.current) return;
    const next = c.queue[c.queue.indexOf(q) + 1] ?? null;
    c.asked = next;
    if (have) {
      c.have.add(q.id);
      c.forcedNames.push(q.name);
    } else c.lateNames.push(q.name);
    patch({ forced: [...c.forcedNames], handedLate: [...c.lateNames], question: next, wait: next ? 'stock' : null });
    if (!next) void run(runParcel);
  };

  const retry = () => {
    if (!state.error) return;
    const stage = m.current.stage;
    void run(stage === 'handover' ? runHandOver : stage === 'invoice' ? runInvoice : runParcel);
  };

  return {
    ...state,
    start: startChain,
    settle: settleWith,
    payLater: () => settleWith(0),
    cancelPayment: () => {
      if (state.step === 'payment' && !running.current) patch({ active: false, wait: null });
    },
    answer,
    handOver: () => {
      if (state.step === 'handover' && !state.error && !running.current) void run(runHandOver);
    },
    retry,
    /** Back to a clean slate for the next sale; ignored while a write is running. */
    reset: () => {
      if (running.current) return;
      m.current = fresh();
      patch(INITIAL);
    },
  };
}
