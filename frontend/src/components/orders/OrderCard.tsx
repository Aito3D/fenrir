import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import type { OrderBoardRow } from '../../api/client';
import { formatMoney } from '../../utils/pricing';
import { Card } from '../Card';
import { ageTone, formatQty, parseDay } from './orderBoard';
import { OrderLinesPanel } from './OrderLinesPanel';
import { PaymentPill } from './PaymentPill';
import { STATUS_META, TONE } from './orderStatus';

const AGE = {
  neutral: 'bg-bambu-dark-tertiary/60 text-bambu-gray',
  warning: `${TONE.warning.soft} ${TONE.warning.text}`,
  danger: `${TONE.danger.soft} ${TONE.danger.text}`,
};

// Below lg the row stacks: number and status, then customer and value, then the bar.
const ROW_GRID =
  'grid items-center gap-x-3 gap-y-1.5 grid-cols-[minmax(0,1fr)_auto_1.25rem] ' +
  "[grid-template-areas:'num_status_chev'_'cust_value_chev'_'bar_bar_bar'_'pay_pay_pay'] " +
  'lg:[grid-template-areas:none] lg:grid-cols-[6.5rem_minmax(0,1fr)_3.5rem_minmax(11rem,16rem)_auto_9.5rem_7.5rem_1.25rem]';

/** One order: the collapsed row is the button that opens its lines. */
export function OrderCard({
  row,
  open,
  onToggle,
  others,
  onGoto,
}: {
  row: OrderBoardRow;
  open: boolean;
  onToggle: () => void;
  others?: { id: string; number: string }[];
  onGoto?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const meta = STATUS_META[row.status];
  const tone = TONE[meta.tone];
  const Icon = meta.icon;
  const units = row.units;
  const width = (n: number) => ({ width: units.total > 0 ? `${(n / units.total) * 100}%` : '0%' });
  const age = t('orders.age', { n: row.age_days });

  return (
    <Card id={`order-${row.id}`} className="overflow-clip">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={`w-full px-4 py-3 text-left hover:bg-bambu-dark-tertiary/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bambu-green ${ROW_GRID}`}
      >
        <span data-testid="order-number" className="font-mono text-sm font-semibold text-white [grid-area:num] lg:[grid-area:auto]">
          {row.number}
        </span>
        <span className="min-w-0 [grid-area:cust] lg:[grid-area:auto]">
          <span className="block truncate text-white">{row.customer || '–'}</span>
          <span className="block text-xs text-bambu-gray">
            {parseDay(row.date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
            <span className="lg:hidden"> · {age}</span>
          </span>
        </span>
        <span className={`hidden justify-self-start rounded-md px-2 py-0.5 text-xs lg:inline-block ${AGE[ageTone(row.age_days)]}`}>{age}</span>
        <span className="[grid-area:bar] lg:[grid-area:auto]">
          <span className="flex h-2 overflow-hidden rounded-full bg-bambu-dark">
            <span className={TONE.neutral.bar} style={width(units.shipped)} />
            <span className={TONE.success.bar} style={width(units.ready)} />
            <span className={TONE.warning.bar} style={width(units.backordered)} />
            <span className={TONE.danger.bar} style={width(units.to_order)} />
          </span>
          <span className="mt-1 flex justify-between gap-2 whitespace-nowrap text-[11px] text-bambu-gray">
            <span>
              {t('orders.shipped', { shipped: formatQty(units.shipped), total: formatQty(units.total) })}
              {row.packed > 0 && <> · {t('orders.packed', { n: formatQty(row.packed) })}</>}
            </span>
            <span>{t('orders.readyPct', { pct: Math.round(row.ready_ratio * 100) })}</span>
          </span>
        </span>
        <span
          className={`inline-flex items-center gap-1.5 justify-self-end rounded-full px-2.5 py-1 text-xs [grid-area:status] lg:justify-self-start lg:[grid-area:auto] ${tone.soft} ${tone.text}`}
        >
          <Icon aria-hidden="true" className="h-3.5 w-3.5" />
          {t(meta.label)}
        </span>
        <span data-testid="order-pay" className="[grid-area:pay] lg:[grid-area:auto]">
          {row.payment ? (
            <PaymentPill state={row.payment.state} pct={row.payment.pct} overdue={row.payment.overdue > 0} fill />
          ) : (
            <span className="text-sm text-bambu-gray">–</span>
          )}
        </span>
        <span data-testid="order-value" className={`text-right text-sm tabular-nums [grid-area:value] lg:[grid-area:auto] ${row.total === null ? 'text-bambu-gray' : 'text-white'}`}>
          {row.total === null ? '–' : formatMoney(row.total, row.currency)}
        </span>
        <ChevronDown aria-hidden="true" className={`h-4 w-4 text-bambu-gray transition-transform [grid-area:chev] lg:[grid-area:auto] ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <OrderLinesPanel row={row} others={others} onGoto={onGoto} />}
    </Card>
  );
}
