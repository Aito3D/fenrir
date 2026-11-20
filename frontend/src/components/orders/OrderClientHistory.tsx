import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, History } from 'lucide-react';
import { api } from '../../api/client';
import type { FinishedOrderRow, OrderBoardLine, OrderBoardRow, OrderPayState } from '../../api/client';
import { formatMoney } from '../../utils/pricing';
import { labelCls, focusRingCls } from '../formStyles';
import { finishedPayState, formatQty, parseDay } from './orderBoard';
import { PaymentPill } from './PaymentPill';

const LIMIT = 5;
// The year only when it is not this one: the rail is narrow.
const dayLabel = (iso: string) => {
  const d = parseDay(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
};

interface Entry {
  id: string;
  number: string;
  date: string;
  total: number | null;
  currency: string;
  state: OrderPayState | null;
  lines: OrderBoardLine[] | null; // null: a finished order, fetched on expand
}

const Lines = ({ lines, currency }: { lines: OrderBoardLine[]; currency: string }) => (
  <ul className="space-y-0.5 px-2.5 pb-1.5 text-xs text-bambu-gray-light">
    {lines.map((l) => (
      <li key={l.id} className="flex justify-between gap-2">
        <span className="truncate">{l.name}</span>
        <span className="whitespace-nowrap tabular-nums">×{formatQty(l.quantity)} · {formatMoney(l.rate, currency)}</span>
      </li>
    ))}
  </ul>
);

// Same query key as FinishedOrderCard, so an order opened in either place is fetched once.
function FinishedLines({ id, currency }: { id: string; currency: string }) {
  const { t } = useTranslation();
  const detail = useQuery({ queryKey: ['order-board-finished-order', id], queryFn: () => api.getFinishedOrder(id), staleTime: 60_000 });
  if (detail.data) return <Lines lines={detail.data.lines} currency={currency} />;
  const [msg, cls] = detail.isError ? [t('common.errorLoading'), 'text-red-400'] : [t('common.loading'), 'text-bambu-gray'];
  return <p className={`px-2.5 pb-1.5 text-xs ${cls}`}>{msg}</p>;
}

/** The client's past orders (open and shipped), newest first, each expandable to what they bought. */
export function OrderClientHistory({ customerId, open, finished, currency }: { customerId: string; open: OrderBoardRow[]; finished: FinishedOrderRow[]; currency: string }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  if (!customerId) return null;

  const entries: Entry[] = [
    ...open.filter((r) => r.customer_id === customerId).map((r) => ({ ...r, state: r.payment?.state ?? null, lines: r.lines })),
    ...finished.filter((r) => r.customer_id === customerId).map((r) => ({ ...r, state: finishedPayState(r), lines: null })),
  ].sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number));
  const shown = all ? entries : entries.slice(0, LIMIT);

  return (
    <div data-testid="order-client-history">
      <p className={`${labelCls} flex items-center gap-1.5`}>
        <History className="h-3.5 w-3.5" aria-hidden="true" />
        {t('orders.newOrder.historyTitle')}
      </p>
      {entries.length === 0 ? (
        <p className="text-xs text-bambu-gray">{t('orders.newOrder.empty')}</p>
      ) : (
        <ul className="space-y-1">
          {shown.map((e) => {
            const isOpen = expanded === e.id;
            return (
              <li key={e.id} className="rounded-md bg-bambu-dark text-xs">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setExpanded(isOpen ? null : e.id)}
                  className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left ${focusRingCls}`}
                >
                  <span data-testid="history-order-number" className="whitespace-nowrap font-mono font-semibold text-white">{e.number}</span>
                  <span className="min-w-0 truncate whitespace-nowrap text-bambu-gray">
                    {dayLabel(e.date)}
                  </span>
                  <span className="ml-auto text-white tabular-nums">{e.total === null ? '–' : formatMoney(e.total, e.currency || currency)}</span>
                  {e.state && <PaymentPill state={e.state} />}
                  <ChevronDown aria-hidden="true" className={`h-3.5 w-3.5 text-bambu-gray transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                </button>
                {isOpen && (e.lines ? <Lines lines={e.lines} currency={e.currency || currency} /> : <FinishedLines id={e.id} currency={e.currency || currency} />)}
              </li>
            );
          })}
        </ul>
      )}
      {!all && entries.length > LIMIT && (
        <button type="button" onClick={() => setAll(true)} className={`mt-1 rounded-md px-2 py-1 text-xs font-medium text-bambu-green hover:bg-bambu-dark-tertiary ${focusRingCls}`}>
          {t('orders.newOrder.showAll')}
        </button>
      )}
    </div>
  );
}
