import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, History } from 'lucide-react';
import type { OrderBoardRow, OrderLastEvent } from '../../api/client';
import { parseUTCDate } from '../../utils/date';
import { elapsedBucket } from '../aito/history/eventKinds';
import { SHORT_LABEL_KEY } from './orderEventKinds';
import { formatMoney } from '../../utils/pricing';
import { Card } from '../Card';
import { useAuth } from '../../contexts/AuthContext';
import { ageTone, formatQty, nextStep, parseDay } from './orderBoard';
import { OrderLinesPanel } from './OrderLinesPanel';
import { OrderRowAction } from './OrderRowAction';
import { PaymentPill } from './PaymentPill';
import { ROW_GRID, STATUS_META, TONE } from './orderStatus';

const AGE = {
  neutral: 'bg-bambu-dark-tertiary/60 text-bambu-gray',
  warning: `${TONE.warning.soft} ${TONE.warning.text}`,
  danger: `${TONE.danger.soft} ${TONE.danger.text}`,
};

/** "Marie · SMS de retrait · il y a 2 h": who did the last thing, what, and how long ago. */
function LastActivity({ event }: { event: OrderLastEvent }) {
  const { t, i18n } = useTranslation();
  const at = parseUTCDate(event.occurred_at);
  // Under a minute reads as "1 minute ago" rather than needing a key of its own.
  const ago = at && elapsedBucket(Math.max(60, (Date.now() - at.getTime()) / 1000));
  const shortKey = SHORT_LABEL_KEY[event.kind];
  const parts = [
    event.actor_name,
    shortKey ? t(shortKey) : event.kind,
    ago && new Intl.RelativeTimeFormat(i18n.language, { numeric: 'always' }).format(-ago.value, ago.unit),
  ].filter(Boolean);
  return (
    <span data-testid="order-last-activity" className="inline-flex items-center gap-1">
      <History aria-hidden="true" className="h-3 w-3" />
      {parts.join(' · ')}
    </span>
  );
}

/** One order: the collapsed row is the button that opens its lines. */
export function OrderCard({
  row,
  open,
  onToggle,
  others,
  onGoto,
  onStart,
  start,
  startTick,
}: {
  row: OrderBoardRow;
  open: boolean;
  onToggle: () => void;
  others?: { id: string; number: string }[];
  onGoto?: (id: string) => void;
  /** The row icon: open this order on that step (a `nextStep` target). */
  onStart?: (target: string) => void;
  /** The step the opened panel should start on. */
  start?: string;
  /** Changes with every click on the row icon. */
  startTick?: number;
}) {
  const { t } = useTranslation();
  const meta = STATUS_META[row.status];
  const tone = TONE[meta.tone];
  const Icon = meta.icon;
  const units = row.units;
  const width = (n: number) => ({ width: units.total > 0 ? `${(n / units.total) * 100}%` : '0%' });
  // A pack or hand-over lands on the next refresh: the segments slide to their new share instead of jumping.
  const seg = 'transition-[width] duration-300 ease-(--ease-signature) motion-reduce:duration-[120ms] motion-reduce:ease-linear';
  // The bar in words, segment by segment, with the line states' own names: "Shipped 1 · Ready 2 · Backorder 0 · To order 1".
  const barLabel = (
    [['shipped', units.shipped], ['ready', units.ready], ['backorder', units.backordered], ['toOrder', units.to_order]] as const
  ).map(([key, n]) => `${t(`orders.line.${key}`)} ${formatQty(n)}`).join(' · ');
  const { hasPermission } = useAuth();
  const next = nextStep(row);
  const step = hasPermission('orders:update') ? next : null;
  const age = t('orders.age', { n: row.age_days });
  // While the panel's hand-over bar is open, a prep step on the row icon would only read Books and do nothing.
  const [handingOff, setHandingOff] = useState(false);
  // A saved edit flashes the row once, the way a new invoice flashes in its card.
  const [edited, setEdited] = useState(false);

  return (
    <Card id={`order-${row.id}`} className="overflow-clip">
      <div
        data-fresh={edited || undefined}
        onAnimationEnd={e => { if (e.target === e.currentTarget) setEdited(false); }}
        className={`relative ${edited ? 'bg-bambu-green/10 motion-safe:animate-[pulse_1s_ease-in-out_2]' : ''}`}
      >
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
              {(row.prep || (row.picklists ?? []).some(p => p.status !== 'completed')) && <span className={TONE.success.text}> · {t('orders.prep.inProgress')}</span>}
              {row.contacted && <span className={TONE.success.text}> · {t('aito.contacted')}</span>}
              {row.last_event && <> · <LastActivity event={row.last_event} /></>}
            </span>
          </span>
          <span className={`hidden justify-self-start rounded-md px-2 py-0.5 text-xs lg:inline-block ${AGE[ageTone(row.age_days)]}`}>{age}</span>
          <span className="[grid-area:bar] lg:[grid-area:auto]">
            <span role="img" aria-label={barLabel} className="flex h-2 overflow-hidden rounded-full bg-bambu-dark">
              <span className={`${TONE.neutral.bar} ${seg}`} style={width(units.shipped)} />
              <span className={`${TONE.success.bar} ${seg}`} style={width(units.ready)} />
              <span className={`${TONE.warning.bar} ${seg}`} style={width(units.backordered)} />
              <span className={`${TONE.danger.bar} ${seg}`} style={width(units.to_order)} />
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
          <span data-testid="order-pay" className={`[grid-area:pay] lg:[grid-area:auto] ${step ? 'max-lg:pr-10' : ''}`}>
            {row.payment ? (
              <PaymentPill state={row.payment.state} pct={row.payment.pct} overdue={row.payment.overdue > 0} fill />
            ) : (
              <span className="text-sm text-bambu-gray">–</span>
            )}
          </span>
          <span data-testid="order-value" className={`text-right text-sm tabular-nums [grid-area:value] lg:[grid-area:auto] ${row.total === null ? 'text-bambu-gray' : 'text-white'}`}>
            {row.total === null ? '–' : formatMoney(row.total, row.currency)}
          </span>
          <ChevronDown aria-hidden="true" className={`h-4 w-4 text-bambu-gray transition-transform [grid-area:chev] lg:[grid-area:auto] lg:justify-self-end ${open ? 'rotate-180' : ''}`} />
        </button>
        {step && !(open && handingOff && !step.startsWith('handover-')) && <OrderRowAction row={row} target={step} onStart={onStart} />}
      </div>
      {open && <OrderLinesPanel row={row} others={others} onGoto={onGoto} start={start} startTick={startTick} onHandoverOpen={setHandingOff} onEdited={() => setEdited(true)} />}
    </Card>
  );
}
