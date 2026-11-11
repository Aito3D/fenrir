import { useTranslation } from 'react-i18next';
import { Wallet } from 'lucide-react';
import type { OrderPayment } from '../../api/client';
import { formatMoney } from '../../utils/pricing';
import { Card } from '../Card';
import { PaymentPill } from './PaymentPill';
import { TONE } from './orderStatus';

const HATCH = {
  backgroundImage: 'repeating-linear-gradient(135deg, rgb(34 197 94 / 0.85) 0 3px, rgb(34 197 94 / 0.25) 3px 6px)',
};

/** Payment of one order: left to pay, the bar with its legend. `total` replaces the order total while an edit is open:
 *  what is left (or the credit left over) and the uninvoiced rest follow it. A paid retainer on the order's quote
 *  (`quoteNumber`) is its own part. */
export function OrderPaymentBlock({ payment, currency, total, quoteNumber = '' }: { payment: OrderPayment; currency: string; total?: number; quoteNumber?: string }) {
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
    </Card>
  );
}
