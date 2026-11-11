import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Smartphone, Wallet } from 'lucide-react';
import { api } from '../../api/client';
import type { AitoTerminalPayment, OrderPayment, OrderPaymentLink } from '../../api/client';
import { PaymentLinkDialog } from '../aito/payment/PaymentLinkModal';
import { TerminalPaymentDialog } from '../aito/payment/TerminalPaymentModal';
import { isTerminalOpen } from '../aito/payment/useTerminalPayment';
import type { PaymentDocument } from '../aito/payment/paymentDocument';
import { formatMoney } from '../../utils/pricing';
import { Card } from '../Card';
import { PaymentPill } from './PaymentPill';
import { TONE } from './orderStatus';

const HATCH = {
  backgroundImage: 'repeating-linear-gradient(135deg, rgb(34 197 94 / 0.85) 0 3px, rgb(34 197 94 / 0.25) 3px 6px)',
};

/** Payment of one order: left to pay, the bar with its legend. `total` replaces the order total while an edit is open:
 *  what is left (or the credit left over) and the uninvoiced rest follow it. A paid retainer on the order's quote
 *  (`quoteNumber`) is its own part. With `orderId` (the caller holds orders:update) it also offers Aito's payment
 *  link and counter terminal on the order's document. */
export function OrderPaymentBlock({ payment, currency, total, quoteNumber = '', orderId }: { payment: OrderPayment; currency: string; total?: number; quoteNumber?: string; orderId?: string }) {
  const { t } = useTranslation();
  const money = (n: number) => formatMoney(n, currency);
  const p = total === undefined ? payment : {
    ...payment,
    left: Math.round((total - payment.paid) * 100) / 100,
    rest: Math.max(0, Math.round((total - payment.invoice_paid - payment.retainer - payment.advance - payment.due - payment.overdue) * 100) / 100),
  };
  // Parts never add up to more than the bar, even when invoices exceed the order total.
  const whole = p.invoice_paid + p.retainer + p.advance + p.due + p.overdue + p.rest;
  const parts = [
    { id: 'invoice_paid', n: p.invoice_paid, cls: TONE.success.bar, dot: TONE.success.bar, label: t(p.advance > 0 || p.retainer > 0 ? 'orders.pay.legendInvoice' : 'orders.pay.legendPaid') },
    { id: 'retainer', n: p.retainer, cls: TONE.success.bar, dot: TONE.success.bar, label: t('orders.pay.legendRetainer', { number: quoteNumber }).trim() },
    { id: 'advance', n: p.advance, cls: '', dot: '', label: t('orders.pay.legendAdvance') },
    { id: 'due', n: p.due, cls: TONE.warning.bar, dot: TONE.warning.bar, label: t('orders.pay.legendDue') },
    { id: 'overdue', n: p.overdue, cls: TONE.danger.bar, dot: TONE.danger.bar, label: t('orders.pay.legendOverdue') },
    { id: 'rest', n: p.rest, cls: '', dot: 'bg-bambu-dark ring-1 ring-bambu-dark-tertiary', label: t('orders.pay.legendRest') },
  ];

  return (
    <Card className="p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Wallet aria-hidden="true" className="h-3.5 w-3.5 text-bambu-gray" />
        <span className="font-semibold uppercase tracking-wide text-white">{t('orders.pay.title')}</span>
        <PaymentPill state={p.state} pct={p.pct} overdue={p.overdue > 0} />
        <span data-testid="pay-left" className="ml-auto tabular-nums text-bambu-gray">
          {p.left > 0 ? (
            <>{t('orders.pay.left')} <span className="font-semibold text-white">{money(p.left)}</span></>
          ) : p.left < 0 ? (
            t('orders.edit.creditLeft', { amount: money(-p.left) })
          ) : (
            t('orders.pay.nothingLeft')
          )}
        </span>
      </div>
      <div aria-hidden="true" className="mt-2.5 flex h-2.5 overflow-hidden rounded-full bg-bambu-dark">
        {parts.filter(x => x.id !== 'rest').map(x => (
          <span
            key={x.id}
            data-testid={`pay-seg-${x.id}`}
            className={x.cls}
            style={{ width: `${whole > 0 ? Math.min(100, (100 * x.n) / whole) : 0}%`, ...(x.id === 'advance' ? HATCH : {}) }}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
        {parts.filter(x => x.n > 0).map(x => (
          <span key={x.id} className="inline-flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${x.dot}`} style={x.id === 'advance' ? HATCH : undefined} />
            <span className="text-bambu-gray">{x.label}</span>
            <span className="tabular-nums text-white">{money(x.n)}</span>
          </span>
        ))}
      </div>
      {p.advance > 0 && <div className="mt-1.5 text-[11px] text-bambu-gray">{t('orders.pay.advanceNote')}</div>}
      {orderId && <OrderPaymentActions orderId={orderId} currency={currency} left={payment.left} />}
    </Card>
  );
}

const BUTTON = 'inline-flex items-center gap-1.5 rounded-md border border-bambu-dark-tertiary px-2.5 py-1 text-xs text-white hover:bg-bambu-dark-tertiary disabled:opacity-50';

/** "Lien de paiement" and "TPE" on the document the server picks (the newest invoice with a balance, else the quote's
 *  open retainer), prefilled with what is left to pay, capped at that document's balance. Hidden when there is none. */
function OrderPaymentActions({ orderId, currency, left }: { orderId: string; currency: string; left: number }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // `left` in the key: a payment that lands on the board re-reads the target. The previous answer stays while it
  // loads, so an open dialog is never unmounted by the payment it just took.
  const target = useQuery({
    queryKey: ['order-payment-target', orderId, left],
    queryFn: () => api.getOrderPaymentTarget(orderId),
    placeholderData: keepPreviousData,
  });
  // What a dialog opened on, kept here so a payment that empties the target never unmounts the dialog showing it.
  const [open, setOpen] = useState<{ document: PaymentDocument; hint?: string; link?: OrderPaymentLink | null; terminal?: AitoTerminalPayment | null } | null>(null);
  const [opening, setOpening] = useState(false);
  const data = target.data;
  const due = data?.max_amount == null ? 0 : Math.min(Math.max(0, Math.round(data.left)), data.max_amount);
  // The dialogs only tell a quote deposit from the rest; the server charges its own target whatever this says.
  const document: PaymentDocument | null =
    data?.kind && data.document_id && data.max_amount !== null
      ? { kind: 'invoice', id: data.document_id, number: data.number ?? '', due: due > 0 ? due : null, currency }
      : null;
  // A retainer is not an invoice balance: its own hint, not the invoice one.
  const hint = data?.kind === 'retainer' ? t('orders.pay.retainerHint') : undefined;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['order-payment-target', orderId] });
    void queryClient.invalidateQueries({ queryKey: ['order-board'], exact: true });
    void queryClient.invalidateQueries({ queryKey: ['order-events', orderId] });
  };
  const openTerminal = async (doc: PaymentDocument) => {
    setOpening(true);
    // A charge still in flight reopens on its waiting screen rather than offering a second one.
    const current = await api.getOrderTerminalPayment(orderId).catch(() => null);
    setOpening(false);
    setOpen({ document: doc, hint, terminal: isTerminalOpen(current) ? current : null });
  };
  if (!document && !open) return null;
  return (
    <div className="mt-2.5 flex flex-wrap gap-2">
      {document && (
        <>
          <button type="button" className={BUTTON} onClick={() => setOpen({ document, hint, link: data?.link ?? null })}>
            <Link2 aria-hidden="true" className="h-3.5 w-3.5" />
            {t('aito.payment.linkTitle')}
          </button>
          <button type="button" className={BUTTON} onClick={() => void openTerminal(document)} disabled={opening}>
            <Smartphone aria-hidden="true" className="h-3.5 w-3.5" />
            {t('orders.pay.terminal')}
          </button>
        </>
      )}
      {open && open.terminal === undefined && (
        <PaymentLinkDialog
          document={open.document}
          hint={open.hint}
          link={open.link ?? null}
          onClose={() => setOpen(null)}
          onCreate={async (amount) => {
            const link = await api.createOrderPaymentLink(orderId, amount);
            void queryClient.invalidateQueries({ queryKey: ['order-payment-target', orderId] });
            return link;
          }}
        />
      )}
      {open && open.terminal !== undefined && (
        <TerminalPaymentDialog
          document={open.document}
          hint={open.hint}
          initialPayment={open.terminal}
          onClose={() => setOpen(null)}
          pollKey={['order-terminal-payment', orderId]}
          onStart={(amount) => api.startOrderTerminalPayment(orderId, amount)}
          fetchPayment={async () => {
            const row = await api.getOrderTerminalPayment(orderId);
            if (!row) throw new Error(t('common.errorLoading'));
            return row;
          }}
          onSeen={(payment) => {
            if (!isTerminalOpen(payment)) refresh();
          }}
        />
      )}
    </div>
  );
}
