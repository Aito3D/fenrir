import { useTranslation } from 'react-i18next';
import { CircleAlert } from 'lucide-react';
import type { OrderPayState } from '../../api/client';
import { PAY_META, TONE } from './orderStatus';

/** Paid / partly paid / unpaid. `fill` is the row pill: the width of its column,
 *  with a green fill `pct`% wide when partly paid. Without `pct` it names the state only. */
export function PaymentPill({ state, pct, overdue, fill }: { state: OrderPayState; pct?: number; overdue?: boolean; fill?: boolean }) {
  const { t } = useTranslation();
  const meta = PAY_META[state];
  const Icon = overdue ? CircleAlert : meta.icon;
  const label = state === 'partial' && pct !== undefined ? t('orders.pay.pct', { pct }) : t(meta.label);
  // The fixed-width row pill has no room for the suffix: it goes in the title and the accessible name.
  const full = overdue ? `${label} · ${t('orders.pay.overdue')}` : label;
  return (
    <span
      title={fill && overdue ? full : undefined}
      aria-label={fill && overdue ? full : undefined}
      className={`relative items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full px-2.5 py-1 text-xs ${fill ? 'flex w-full' : 'inline-flex'} ${TONE[meta.tone].soft} ${overdue ? TONE.danger.text : TONE[meta.tone].text}`}
    >
      {fill && state === 'partial' && pct !== undefined && (
        <span aria-hidden="true" className="absolute inset-y-0 left-0 bg-green-500/40" style={{ width: `${Math.min(100, pct)}%` }} />
      )}
      <Icon aria-hidden="true" className="relative h-3.5 w-3.5 shrink-0" />
      <span className="relative">
        {label}
        {overdue && !fill && <> · {t('orders.pay.overdue')}</>}
      </span>
    </span>
  );
}
