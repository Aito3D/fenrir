import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import type { FinishedOrderRow, OrderBoardRow } from '../../api/client';
import { formatMoney } from '../../utils/pricing';
import { avgLeadDays, parseDay, totalValue, utcToday, weeklyCounts } from './orderBoard';

interface Props {
  open: boolean;
  onToggle: () => void;
  /** The open orders, after the brand toggle. */
  rows: OrderBoardRow[];
  /** The finished orders, after the brand toggle; undefined until they are read. */
  finished: FinishedOrderRow[] | undefined;
}

/** Four figures under the tiles, from what the board already holds. The To ship tile already prints the
 *  value ready to go, so the fourth figure is how long the oldest of those orders has waited. */
export function OrderStatsStrip({ open, onToggle, rows, finished }: Props) {
  const { t, i18n } = useTranslation();

  const figures = () => {
    const today = utcToday();
    const weeks = finished && weeklyCounts([...rows, ...finished].map(r => r.date), today);
    const peak = Math.max(1, ...(weeks ?? []).map(w => w.n));
    const label = (start: string) => parseDay(start).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short' });
    const lead = finished ? avgLeadDays(finished, today) : null;
    const blocked = rows.filter(r => r.status === 'incoming' || r.status === 'to_order');
    const waiting = rows.filter(r => r.status === 'to_ship');
    const figure = (name: string, value: ReactNode, hint?: string, title?: string) => (
      <div title={title}>
        <dt className="text-xs text-bambu-gray">{name}</dt>
        <dd className="mt-1 text-lg font-semibold text-white">{value}</dd>
        {hint && <dd className="text-xs text-bambu-gray">{hint}</dd>}
      </div>
    );
    return (
      <dl data-testid="orders-stats" className="grid grid-cols-2 gap-4 px-4 pb-3 lg:grid-cols-4">
        {figure(t('orders.stats.weekly'), weeks ? (
          <div
            role="img"
            aria-label={`${t('orders.stats.weekly')}: ${weeks.map(w => `${label(w.start)} ${w.n}`).join(', ')}`}
            className="flex h-12 items-end gap-1"
          >
            {weeks.map(w => (
              <div key={w.start} title={`${label(w.start)}: ${w.n}`} className="flex h-full flex-1 flex-col justify-end text-center text-[10px] font-normal text-bambu-gray">
                {w.n}
                <div className="rounded-sm bg-bambu-green/70" style={{ height: `${(w.n / peak) * 70}%`, minHeight: 2 }} />
              </div>
            ))}
          </div>
        ) : '–')}
        {figure(
          t('orders.stats.lead'),
          lead ? t('orders.age', { n: lead.days.toLocaleString(i18n.language) }) : '–',
          lead ? t('orders.stats.leadHint', { n: lead.n }) : undefined,
          lead || !finished ? undefined : t('orders.stats.leadNone'),
        )}
        {figure(
          t('orders.stats.blocked'),
          blocked.length ? formatMoney(totalValue(blocked), blocked[0].currency) : '–',
          t('orders.stats.blockedHint', { n: blocked.length }),
        )}
        {figure(
          t('orders.stats.ready'),
          waiting.length ? t('orders.age', { n: Math.max(...waiting.map(r => r.age_days)) }) : '–',
          t('orders.stats.readyHint'),
        )}
      </dl>
    );
  };

  return (
    <div className="mb-5 rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-xl px-4 py-2 text-left text-xs text-bambu-gray hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green"
      >
        <ChevronDown aria-hidden="true" className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
        {t('orders.stats.title')}
      </button>
      {open && figures()}
    </div>
  );
}
