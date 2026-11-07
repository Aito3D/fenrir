import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, PackageCheck } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { FinishedOrderRow } from '../../api/client';
import { formatMoney } from '../../utils/pricing';
import { Button } from '../Button';
import { Card } from '../Card';
import { Skeleton } from '../Skeleton';
import { finishedPayState, parseDay } from './orderBoard';
import { OrderLinesPanel } from './OrderLinesPanel';
import { PaymentPill } from './PaymentPill';
import { ROW_GRID, TONE } from './orderStatus';

/** A shipped order: the list row knows little, so opening it fetches the lines, contact and invoices from Zoho. */
export function FinishedOrderCard({ row, open, onToggle }: { row: FinishedOrderRow; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const detail = useQuery({
    queryKey: ['order-board-finished-order', row.id],
    queryFn: () => api.getFinishedOrder(row.id),
    enabled: open,
    staleTime: 60_000,
    // "Zoho is busy" (503) is the shared per-minute call budget being spent, usually by the Kanban: it clears
    // within the minute, so wait and try again before telling the operator it failed.
    retry: (count, error) => error instanceof ApiError && error.status === 503 && count < 4,
    retryDelay: 5_000,
  });
  // The list row only carries Zoho's paid flag; a computed payment (the detail's, else the row's) adds the percentage.
  const payment = detail.data?.payment ?? row.payment;
  const state = detail.data?.payment?.state ?? finishedPayState(row);

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
          </span>
        </span>
        <span aria-hidden="true" className="hidden lg:block" />
        <span className="[grid-area:bar] lg:[grid-area:auto]">
          <span className="flex h-2 overflow-hidden rounded-full bg-bambu-dark">
            <span className={`${TONE.neutral.bar} w-full`} />
          </span>
        </span>
        <span
          className={`inline-flex items-center gap-1.5 justify-self-end rounded-full px-2.5 py-1 text-xs [grid-area:status] lg:justify-self-start lg:[grid-area:auto] ${TONE.neutral.soft} ${TONE.neutral.text}`}
        >
          <PackageCheck aria-hidden="true" className="h-3.5 w-3.5" />
          {t('orders.finished.shipped')}
        </span>
        <span data-testid="order-pay" className="[grid-area:pay] lg:[grid-area:auto]">
          {state ? (
            <PaymentPill state={state} pct={payment?.pct} overdue={!!payment && payment.overdue > 0} fill />
          ) : (
            <span className="text-sm text-bambu-gray">–</span>
          )}
        </span>
        <span data-testid="order-value" className={`text-right text-sm tabular-nums [grid-area:value] lg:[grid-area:auto] ${row.total === null ? 'text-bambu-gray' : 'text-white'}`}>
          {row.total === null ? '–' : formatMoney(row.total, row.currency)}
        </span>
        <ChevronDown aria-hidden="true" className={`h-4 w-4 text-bambu-gray transition-transform [grid-area:chev] lg:[grid-area:auto] lg:justify-self-end ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && detail.data && <OrderLinesPanel row={detail.data} />}
      {open && detail.isError && (
        <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm text-white">
          {t('orders.finished.loadFailed')}
          <Button variant="secondary" size="sm" onClick={() => detail.refetch()}>
            {t('orders.retry')}
          </Button>
        </div>
      )}
      {open && detail.isPending && (
        <div className="space-y-2 px-4 py-3">
          <div className="text-sm text-bambu-gray">{t(detail.failureCount > 0 ? 'orders.finished.busyRetrying' : 'orders.finished.loading')}</div>
          <Skeleton className="h-10 rounded-lg" />
        </div>
      )}
    </Card>
  );
}
