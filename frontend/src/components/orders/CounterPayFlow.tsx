import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Check, Loader2 } from 'lucide-react';
import { ApiError, api } from '../../api/client';
import type { AitoTerminalPayment } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { formatMoney } from '../../utils/pricing';
import { ManualPaymentModal } from '../aito/payment/ManualPaymentModal';
import { TerminalPaymentDialog } from '../aito/payment/TerminalPaymentModal';
import { isTerminalOpen } from '../aito/payment/useTerminalPayment';
import type { PaymentDocument } from '../aito/payment/paymentDocument';
import { usePrintBlob } from '../aito/usePrintBlob';
import { focusRingCls } from '../formStyles';
import { givableLines, PAY_STEPS } from './counterPay';
import { formatQty } from './orderBoard';
import { OrderInvoiceEmailModal } from './OrderInvoiceEmailModal';
import { SplitButton } from './SplitButton';
import type { useCounterPay } from './useCounterPay';

const PRIMARY = `btn-press inline-flex h-11 w-full items-center justify-center rounded-lg bg-bambu-green px-4 text-sm font-semibold text-white hover:bg-bambu-green-light disabled:cursor-wait disabled:opacity-70 ${focusRingCls}`;
const GHOST = `btn-press inline-flex h-11 w-full items-center justify-center rounded-lg border border-bambu-dark-tertiary px-4 text-sm text-white hover:bg-bambu-dark-tertiary ${focusRingCls}`;
const PANEL = 'animate-rise space-y-3 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-3 text-sm';

type Dialog = { kind: 'terminal'; document: PaymentDocument; payment: AitoTerminalPayment | null } | { kind: 'manual'; document: PaymentDocument };

/** The right column of a counter sale: a progress bar, the six steps, and the one panel the sale is waiting on. */
export function CounterPayFlow({ pay, currency, total, email, isDefaultClient, onNewSale, onOpenOrder, onDialog }: {
  pay: ReturnType<typeof useCounterPay>;
  currency: string;
  total: number;
  /** The live Books contact's email; null for the client de passage. */
  email: string | null;
  isDefaultClient: boolean;
  onNewSale: () => void;
  onOpenOrder: (id: string) => void;
  /** Told when a payment dialog opens or closes: the modal does not close behind one. */
  onDialog?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const panel = useRef<HTMLDivElement>(null);
  // On a phone the panel sits below the fold: bring it into view when the sale asks for something.
  useEffect(() => {
    panel.current?.scrollIntoView?.({ block: 'nearest' });
  }, [pay.step, pay.wait, pay.error]);
  const index = PAY_STEPS.indexOf(pay.step);
  const done = pay.step === 'done';
  const failed = !!pay.error;
  const rowState = (i: number) => (i < index || done ? 'done' : i > index ? 'todo' : failed ? 'error' : pay.wait ? 'wait' : 'now');
  return (
    <div data-testid="counter-pay" className="animate-rise space-y-4">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={PAY_STEPS.length - 1}
        aria-valuenow={index}
        aria-label={t('orders.newOrder.title')}
        className="h-1.5 overflow-hidden rounded-full bg-bambu-dark-tertiary"
      >
        <div
          className={`h-full origin-left transition-[width] duration-500 motion-reduce:transition-none ${failed ? 'bg-red-500' : 'bg-bambu-green'}`}
          style={{ width: `${(index / (PAY_STEPS.length - 1)) * 100}%` }}
        />
      </div>
      <ol className="space-y-0.5">
        {PAY_STEPS.map((s, i) => {
          const state = rowState(i);
          const ring = state === 'wait' ? 'border-amber-400' : state === 'error' ? 'border-red-500' : 'border-bambu-green';
          return (
            <li
              key={s}
              data-state={state}
              aria-current={i === index && !done ? 'step' : undefined}
              className={`flex items-center gap-2.5 py-1.5 text-sm ${state === 'todo' ? 'text-bambu-gray' : state === 'error' ? 'text-red-400' : 'text-white'} ${state === 'now' ? 'font-semibold' : ''}`}
            >
              <span
                aria-hidden="true"
                className={`grid h-5 w-5 flex-shrink-0 place-items-center rounded-full border-2 text-[11px] transition-colors duration-200 ${
                  state === 'done' ? 'border-bambu-green bg-bambu-green text-white' : state === 'todo' ? 'border-bambu-dark-tertiary' : ring
                }`}
              >
                {state === 'done' ? <Check className="h-3 w-3" /> : state === 'now' ? <Loader2 className="h-3 w-3 animate-spin text-bambu-green" /> : state === 'error' ? '!' : null}
              </span>
              {t(`orders.counterPay.step.${s}`)}
            </li>
          );
        })}
      </ol>
      {/* The plain panels are keyed: they share this slot, and a reused div would not replay its rise. */}
      <div ref={panel}>
      {done ? (
        <Final pay={pay} currency={currency} email={email} onNewSale={onNewSale} onOpenOrder={onOpenOrder} />
      ) : failed ? (
        <div key="error" role="alert" className={PANEL}>
          <p className="font-semibold text-red-400">{pay.error}</p>
          {pay.paid > 0 && <p className="text-bambu-gray">{t('orders.counterPay.kept')}</p>}
          <div className="flex gap-2">
            <button type="button" disabled={pay.busy} onClick={pay.retry} className={PRIMARY}>{pay.busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}{t('orders.counterPay.retry')}</button>
            <button type="button" onClick={() => pay.row && onOpenOrder(pay.row.id)} className={GHOST}>{t('orders.counterPay.openOrder')}</button>
          </div>
        </div>
      ) : pay.wait === 'payment' && pay.row ? (
        <PaymentPanel pay={pay} orderId={pay.row.id} currency={currency} total={total} isDefaultClient={isDefaultClient} onOpenOrder={onOpenOrder} onDialog={onDialog} />
      ) : pay.wait === 'stock' && pay.question ? (
        <div key={`stock-${pay.question.name}`} className={PANEL}>
          <p>{t('orders.counterPay.stockAsk', { name: pay.question.name, n: pay.question.remaining - pay.question.packed_waiting, stock: formatQty(pay.question.stock_available ?? 0) })}</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => pay.answer(true)} className={PRIMARY}>{t('orders.counterPay.stockYes')}</button>
            <button type="button" onClick={() => pay.answer(false)} className={GHOST}>{t('orders.counterPay.stockNo')}</button>
          </div>
        </div>
      ) : pay.wait === 'handover' ? (
        <div key="handover" className={PANEL}>
          <p>{t('orders.counterPay.give')}</p>
          {pay.handedLate.length > 0 && <p className="text-xs text-amber-400">{t('orders.counterPay.late', { names: pay.handedLate.join(', ') })}</p>}
          <button type="button" disabled={pay.busy} onClick={pay.handOver} className={PRIMARY}>{pay.busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}{t('orders.counterPay.handed')}</button>
        </div>
      ) : null}
      </div>
    </div>
  );
}

function PaymentPanel({ pay, orderId, currency, total, isDefaultClient, onOpenOrder, onDialog }: {
  pay: ReturnType<typeof useCounterPay>;
  orderId: string;
  currency: string;
  total: number;
  isDefaultClient: boolean;
  onOpenOrder: (id: string) => void;
  onDialog?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const givable = pay.row ? givableLines(pay.row) : [];
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [opening, setOpening] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  // onSeen fires on every poll of a paid charge: one sale settles once.
  const settled = useRef(false);
  const settle = (amount: number) => {
    if (settled.current) return;
    settled.current = true;
    setDialog(null);
    pay.settle(amount);
  };
  // A paid charge whose booking is still pending is "open": the invoice would not find the payment yet.
  const paidAndBooked = (p: AitoTerminalPayment | null | undefined): p is AitoTerminalPayment => p?.status === 'paid' && !isTerminalOpen(p);
  useEffect(() => {
    onDialog?.(!!dialog);
  }, [dialog, onDialog]);
  useEffect(() => () => onDialog?.(false), [onDialog]);
  // The order's current charge, as `Collect` polls it: a card paid behind a closed dialog still settles the sale.
  const charge = useQuery({
    queryKey: ['order-terminal-current', orderId],
    queryFn: () => api.getOrderTerminalPayment(orderId),
    refetchInterval: q => (isTerminalOpen(q.state.data) ? 3000 : false),
    retry: false,
    staleTime: 0,
  });
  const latest = useRef(settle);
  latest.current = settle;
  useEffect(() => {
    const p = charge.data;
    if (paidAndBooked(p)) latest.current(p.amount_confirmed ?? p.amount);
  }, [charge.data]);
  // The same document `Collect` builds on the order card: the server picks what the charge lands on.
  // A card still open on the terminal: cash or pay later now would leave the customer's tap unapplied.
  const locked = isTerminalOpen(charge.data);
  const blocked = () => {
    setWhy(t('aito.payment.err.terminal_in_progress'));
  };
  const open = async (kind: 'terminal' | 'manual') => {
    setOpening(true);
    try {
      const target = await api.getOrderPaymentTarget(orderId);
      if (!target.kind || !target.document_id || target.max_amount === null) throw new Error(t('common.errorLoading'));
      const due = Math.min(Math.max(0, Math.round(target.left)), target.max_amount);
      const document: PaymentDocument = { kind: 'invoice', id: target.document_id, number: target.number ?? '', due: due > 0 ? due : null, currency };
      // A charge still in flight reopens on its waiting screen rather than offering a second one.
      const payment = kind === 'terminal' ? await api.getOrderTerminalPayment(orderId) : null;
      // Already paid and booked behind a closed dialog: settle, never offer a second charge.
      if (paidAndBooked(payment)) {
        settle(payment.amount_confirmed ?? payment.amount);
        return;
      }
      setDialog(kind === 'terminal' ? { kind, document, payment: isTerminalOpen(payment) ? payment : null } : { kind, document });
    } catch {
      showToast(t('common.errorLoading'), 'error');
    } finally {
      setOpening(false);
    }
  };
  return (
    <div className={PANEL}>
      <p>{t('orders.counterPay.howPay', { amount: formatMoney(total, currency) })}</p>
      <div className="flex gap-2">
        <button type="button" disabled={opening} onClick={() => void open('terminal')} className={PRIMARY}>{t('orders.counterPay.card')}</button>
        <button type="button" disabled={opening} aria-disabled={locked || undefined} onClick={() => (locked ? blocked() : void open('manual'))} className={`${GHOST} ${locked ? 'opacity-45' : ''}`}>{t('orders.counterPay.cash')}</button>
      </div>
      <button
        type="button"
        aria-disabled={isDefaultClient || locked || undefined}
        onClick={() => (locked ? blocked() : isDefaultClient ? setWhy(t('orders.counterPay.laterNeedsClient')) : pay.payLater())}
        className={`${GHOST} ${isDefaultClient || locked ? 'opacity-45' : ''}`}
      >
        {t('orders.counterPay.later')}
      </button>
      {why && <p role="alert" className="text-xs text-amber-400">{why}</p>}
      {givable.length > 0 && (
        <fieldset className="space-y-1 border-t border-bambu-dark-tertiary pt-3">
          <legend className="float-left mb-1 w-full text-xs text-bambu-gray">{t('orders.counterPay.givenNow')}</legend>
          {givable.map((l) => (
            <label key={l.id} className="flex min-h-8 cursor-pointer items-center gap-2 text-xs text-white">
              <input type="checkbox" checked={!pay.held.includes(l.id)} onChange={() => pay.toggleHeld(l.id)} className="h-4 w-4 flex-shrink-0 accent-bambu-green" />
              <span className={`min-w-0 flex-1 truncate ${pay.held.includes(l.id) ? 'text-bambu-gray line-through' : ''}`}>{l.name}</span>
              <span className="tabular-nums text-bambu-gray">×{formatQty(l.remaining - l.packed_waiting)}</span>
            </label>
          ))}
        </fieldset>
      )}
      <button
        type="button"
        onClick={() => {
          pay.cancelPayment();
          onOpenOrder(orderId);
        }}
        className={`${GHOST} text-bambu-gray`}
      >
        {t('orders.counterPay.cancelPay')}
      </button>
      {dialog?.kind === 'manual' && (
        <ManualPaymentModal
          document={dialog.document}
          initialMode="cash"
          onClose={() => setDialog(null)}
          onRecord={async (body) => {
            await api.recordOrderManualPayment(orderId, body);
            settle(body.amount);
          }}
        />
      )}
      {dialog?.kind === 'terminal' && (
        <TerminalPaymentDialog
          document={dialog.document}
          initialPayment={dialog.payment}
          onClose={() => {
            setDialog(null);
            void charge.refetch();
          }}
          pollKey={['order-terminal-payment', orderId]}
          onStart={(amount) => api.startOrderTerminalPayment(orderId, amount)}
          recover={(e) =>
            e instanceof ApiError && e.code === 'link_open'
              ? {
                  message: t('orders.pay.linkOpen'),
                  label: t('orders.pay.cancelLinkAndCharge'),
                  start: (amount) => api.startOrderTerminalPayment(orderId, amount, true),
                }
              : null
          }
          fetchPayment={async () => {
            const row = await api.getOrderTerminalPayment(orderId);
            if (!row) throw new Error(t('common.errorLoading'));
            return row;
          }}
          onSeen={(payment) => {
            if (paidAndBooked(payment)) settle(payment.amount_confirmed ?? payment.amount);
          }}
        />
      )}
    </div>
  );
}

function Final({ pay, currency, email, onNewSale, onOpenOrder }: {
  pay: ReturnType<typeof useCounterPay>;
  currency: string;
  email: string | null;
  onNewSale: () => void;
  onOpenOrder: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [emailing, setEmailing] = useState(false);
  const invoice = pay.invoice;
  const { print, busy } = usePrintBlob({ failureMessage: t('aito.invoicePrintFailed'), downloadFilename: `${invoice?.number || 'invoice'}.pdf` });
  const title = pay.later ? 'doneLater' : pay.handedLate.length ? 'doneLate' : 'doneSale';
  const line = (children: ReactNode) => <p className="text-xs text-amber-400">{children}</p>;
  return (
    <div className={PANEL}>
      <div className="text-center">
        <Check aria-hidden="true" className="animate-slice-done mx-auto h-8 w-8 text-bambu-green" />
        <p className="font-semibold text-white">{t(`orders.counterPay.${title}`, { n: pay.handedLate.length })}</p>
        <p className="mt-1 text-xs text-bambu-gray">
          {[pay.row?.number, invoice?.number].filter(Boolean).join(' · ')}
          {invoice && (
            <>
              {' · '}
              {invoice.balance < 0.01
                ? <span className="text-bambu-green">{t('orders.counterPay.settled')}</span>
                : <span className="text-amber-400">{t('orders.counterPay.due', { amount: formatMoney(invoice.balance, currency) })}</span>}
            </>
          )}
        </p>
      </div>
      {pay.handedLate.length > 0 && line(t('orders.counterPay.late', { names: pay.handedLate.join(', ') }))}
      {pay.forced.length > 0 && line(t('orders.counterPay.fixStock', { names: pay.forced.join(', ') }))}
      <button type="button" onClick={onNewSale} className={PRIMARY}>{t('orders.counterPay.newSale')}</button>
      {invoice && (
        <div className="flex">
          <SplitButton
            menuBelow
            label={t('orders.counterPay.printInvoice')}
            menuLabel={t('orders.counterPay.more')}
            busy={busy}
            onClick={() => void print(() => api.getOrderInvoicePdf(invoice.id))}
            className="h-11 border border-bambu-dark-tertiary text-white hover:bg-bambu-dark-tertiary"
            items={[{
              key: 'email',
              label: t('orders.counterPay.emailInvoice'),
              hint: email ?? undefined,
              disabledReason: email ? undefined : t('orders.counterPay.noEmail'),
              onSelect: () => setEmailing(true),
            }]}
          />
        </div>
      )}
      <button type="button" onClick={() => pay.row && onOpenOrder(pay.row.id)} className={`${GHOST} text-bambu-gray`}>{t('orders.counterPay.openOrder')}</button>
      {emailing && invoice && <OrderInvoiceEmailModal invoice={invoice} onClose={() => setEmailing(false)} />}
    </div>
  );
}
