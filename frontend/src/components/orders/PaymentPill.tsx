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
  // The fixed-width row pill has no room for the suffix: it goes in the title and as visually hidden text.
  const full = overdue ? `${label} · ${t('orders.pay.overdue')}` : label;
  // A partial pill reads in white (on the fill in the row, on the soft tint in the block). Only a row pill keeps the white
  // when overdue, since its green fill makes red text unreadable: the icon and a thin ring carry the alert instead.
  const white = state === 'partial' && (fill || !overdue);
  const ring = fill && overdue && state === 'partial';
  return (
    <span
      title={fill && overdue ? full : undefined}
      className={`relative items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full px-2.5 py-1 text-xs ${fill ? 'flex w-full' : 'inline-flex'} ${TONE[meta.tone].soft} ${ring ? 'ring-1 ring-inset ring-red-500/60' : ''} ${white ? 'text-white' : overdue ? TONE.danger.text : TONE[meta.tone].text}`}
    >
      {fill && state === 'partial' && pct !== undefined && (
        <span aria-hidden="true" className="absolute inset-y-0 left-0 bg-green-500/40 transition-[width] duration-300 ease-(--ease-signature) motion-reduce:duration-[120ms] motion-reduce:ease-linear" style={{ width: `${Math.min(100, pct)}%` }} />
      )}
      <Icon aria-hidden="true" className={`relative h-3.5 w-3.5 shrink-0 ${ring ? TONE.danger.text : ''}`} />
      <span className="relative">
        {label}
        {overdue && !fill && <> · {t('orders.pay.overdue')}</>}
        {overdue && fill && <span className="sr-only"> · {t('orders.pay.overdue')}</span>}
      </span>
    </span>
  );
}
