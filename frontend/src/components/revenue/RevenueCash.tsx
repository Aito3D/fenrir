import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Empty, Facts, Panel, Split, Tile } from '../aito/stats/primitives';
import { Skeleton } from '../Skeleton';
import { bucketLabel } from './lib/buckets';
import { formatFcp } from './lib/format';
import type { CashResponse, PipelineResponse } from './lib/types';
import { useRevenueResource } from './useRevenueResource';

const AMBER = 'text-amber-700 dark:text-amber-400';
const NOTE = 'text-[11px] text-bambu-gray';

/** What should come in within 30 days: invoices falling due, plus overdue money young enough to expect; then the order book still to invoice. */
function Forecast({ owed, pipeline }: { owed: CashResponse['outstanding']; pipeline: PipelineResponse | null }) {
  const { t } = useTranslation();
  // An older payload has no forecast parts: nothing to show rather than zeros.
  if (owed.dueSoon == null) return null;
  const toInvoice = pipeline ? Math.max(0, pipeline.accepted.total - pipeline.accepted.retainerPaid) : 0;
  return (
    <section data-testid="revenue-cash-forecast" className="space-y-1.5 pt-1">
      <h3 className="flex items-baseline justify-between gap-4 text-[13px] font-medium text-white">
        {t('revenue.cash.forecast.title')}
        <span className="tabular-nums">{formatFcp(owed.dueSoon + owed.lateRecent)}</span>
      </h3>
      <Facts
        rows={[
          { label: t('revenue.cash.forecast.dueSoon'), value: formatFcp(owed.dueSoon) },
          { label: t('revenue.cash.forecast.lateRecent'), value: formatFcp(owed.lateRecent) },
          ...(toInvoice > 0 ? [{ label: t('revenue.cash.forecast.toInvoice'), value: formatFcp(toInvoice), note: t('revenue.cash.forecast.toInvoiceNote') }] : []),
        ]}
      />
      {owed.lateOld > 0 && <p className={NOTE}>{t('revenue.cash.forecast.lateOld', { amount: formatFcp(owed.lateOld) })}</p>}
    </section>
  );
}

function Cash({ data, pipeline }: { data: CashResponse; pipeline: PipelineResponse | null }) {
  const { t } = useTranslation();
  const month = data.months[data.months.length - 1];
  const { outstanding, topOverdue, coverage } = data;
  const ratio = month && month.invoicedTtc > 0 ? Math.min(1, month.collected / month.invoicedTtc) : null;
  // Everything owed is late: one amber line instead of the same amount twice.
  const allLate = outstanding.overdue > 0 && outstanding.overdue >= outstanding.total;
  return (
    <div className="space-y-2">
      {month && (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(13.5rem,1fr))] gap-2">
            {/* The month is named: what is owed below is today's, not this month's. */}
            <Tile label={`${t('revenue.cash.invoiced')} · ${bucketLabel(month.month, 'month')}`} value={formatFcp(month.invoicedTtc)} />
            <Tile label={`${t('revenue.cash.collected')} · ${bucketLabel(month.month, 'month')}`} value={formatFcp(month.collected)}
              hint={month.collectedUnknown > 0 ? t('revenue.cash.toSplit', { amount: formatFcp(month.collectedUnknown) }) : undefined} />
          </div>
          {ratio !== null && (
            <div className="h-1 overflow-hidden rounded-full bg-bambu-dark" aria-hidden="true" data-testid="revenue-cash-bar">
              <div className="h-full rounded-full bg-bambu-green" style={{ width: `${ratio * 100}%` }} />
            </div>
          )}
        </>
      )}
      <Facts
        rows={[
          allLate
            ? { label: t('revenue.cash.allOverdue'), value: <span className={AMBER}>{formatFcp(outstanding.total)}</span>, note: t('revenue.cash.invoices', { n: outstanding.invoices }) }
            : { label: t('revenue.cash.owed'), value: formatFcp(outstanding.total), note: t('revenue.cash.invoices', { n: outstanding.invoices }) },
          ...(outstanding.overdue > 0 && !allLate
            ? [{ label: t('revenue.cash.overdue'), value: <span className={AMBER}>{formatFcp(outstanding.overdue)}</span> }]
            : []),
          ...(topOverdue ?? []).map((r) => ({
            label: <span className="block truncate" title={`${r.number} · ${r.customerName}`}>{`${r.number} · ${r.customerName}`}</span>,
            value: formatFcp(r.balance),
            note: <span className={AMBER}>{t('revenue.cash.daysLate', { n: r.daysOverdue })}</span>,
          })),
        ]}
      />
      <Forecast owed={outstanding} pipeline={pipeline} />
      {coverage.unknown > 0 && <p className={NOTE}>{t('revenue.cash.coverage', { amount: formatFcp(coverage.unknown) })}</p>}
      {data.error && <p className={`text-[11px] ${AMBER}`}>{t('revenue.cash.error', { error: data.error })}</p>}
    </div>
  );
}

function Pipeline({ data }: { data: PipelineResponse }) {
  const { t } = useTranslation();
  const { accepted, awaiting } = data;
  if (accepted.count === 0 && awaiting.count === 0) return <Empty>{t('revenue.pipeline.empty')}</Empty>;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(13.5rem,1fr))] gap-2">
        <Tile label={t('revenue.pipeline.accepted')} value={formatFcp(accepted.total)}
          hint={[t('revenue.pipeline.cards', { n: accepted.count }), accepted.missingTotal > 0 ? t('revenue.pipeline.missingTotal', { n: accepted.missingTotal }) : null].filter(Boolean).join(' · ')} />
        <Tile label={t('revenue.pipeline.retainers')} value={formatFcp(accepted.retainerPaid)} />
      </div>
      {accepted.byColumn.length > 0 && (
        <Facts rows={accepted.byColumn.map((c) => ({ label: t(`aito.columns.${c.column}`), value: formatFcp(c.total), note: t('revenue.pipeline.cards', { n: c.count }) }))} />
      )}
      <h3 className="pt-1 text-[13px] font-medium text-white">{t('revenue.pipeline.awaiting')}</h3>
      <Facts
        rows={[{
          label: t('revenue.pipeline.cards', { n: awaiting.count }),
          value: formatFcp(awaiting.total),
          note: awaiting.oldestDays != null ? t('revenue.pipeline.oldest', { n: awaiting.oldestDays }) : undefined,
        }]}
      />
    </div>
  );
}

function Half<T>({ title, action, res, children }: {
  title: string;
  action?: ReactNode;
  res: { data: T | null; error: string | null };
  children: (d: T) => ReactNode;
}) {
  const { data, error } = res;
  return (
    <Panel title={title} action={action}>
      {error ? <p role="alert" className="text-sm text-status-error">{error}</p> : !data ? <Skeleton className="h-32 w-full" /> : children(data)}
    </Panel>
  );
}

/** « Trésorerie et carnet »: this month's cash vs invoiced and what is owed, then the Aito order book. Whole-business figures. */
export function RevenueCash({ version }: { version: unknown }) {
  const { t } = useTranslation();
  const cash = useRevenueResource<CashResponse>('/api/v1/revenue/cash', version);
  // Read once for both halves: the forecast adds the order book still to invoice.
  const pipeline = useRevenueResource<PipelineResponse>('/api/v1/revenue/pipeline', version);
  return (
    <Split>
      <Half<CashResponse> title={t('revenue.cash.title')} res={cash}>
        {(d) => (d.syncedAt === null && !d.error ? <Empty>{t('revenue.cash.empty')}</Empty> : <Cash data={d} pipeline={pipeline.data} />)}
      </Half>
      <Half<PipelineResponse> title={t('revenue.pipeline.title')} res={pipeline}>
        {(d) => <Pipeline data={d} />}
      </Half>
    </Split>
  );
}
