import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Empty, Facts, Panel, Split, Tile } from '../aito/stats/primitives';
import { Skeleton } from '../Skeleton';
import { formatFcp } from './lib/format';
import type { AgingBucket, CashResponse, FunnelOutcome, FunnelResponse, PipelineResponse } from './lib/types';
import { useRevenueResource } from './useRevenueResource';

const AMBER = 'text-amber-700 dark:text-amber-400';
const NOTE = 'text-[11px] text-bambu-gray';

const AGING: Array<[AgingBucket, string]> = [
  ['notDue', 'bg-bambu-green'], ['d30', 'bg-amber-300'], ['d60', 'bg-amber-500'], ['d90', 'bg-orange-600'], ['over', 'bg-red-600'],
];

/** What is owed by how late it is, the payment delay, who is late, and the cash the next 90 days should bring. */
function Aging({ data }: { data: CashResponse }) {
  const { t } = useTranslation();
  const { aging, dso, forecast } = data;
  const shown = AGING.filter(([k]) => aging.buckets[k] > 0);
  return (
    <>
      {shown.length > 0 && (
        <>
          <h3 className="pt-1 text-[13px] font-medium text-white">{t('revenue.aging.title')}</h3>
          <div className="flex h-1.5 gap-px overflow-hidden rounded-full" aria-hidden="true" data-testid="revenue-aging-bar">
            {AGING.map(([k, cls]) => <div key={k} className={cls} style={{ flexGrow: aging.buckets[k] }} />)}
          </div>
        </>
      )}
      <Facts
        rows={[
          ...shown.map(([k, cls]) => ({
            label: <span className="inline-flex items-center gap-2"><span aria-hidden="true" className={`h-2 w-2 rounded-full ${cls}`} />{t(`revenue.aging.${k}`)}</span>,
            value: formatFcp(aging.buckets[k]),
          })),
          { label: t('revenue.aging.dso'), value: dso === null ? '—' : t('revenue.aging.days', { n: dso }) },
          ...(aging.byCustomer ?? []).filter((r) => r.overdue > 0).map((r) => ({
            label: <span className="block truncate" title={r.customerName}>{r.customerName}</span>,
            value: formatFcp(r.balance),
            note: <span className={AMBER}>{`${t('revenue.aging.ofWhichLate', { amount: formatFcp(r.overdue) })} · ${t('revenue.cash.daysLate', { n: r.oldestDays })}`}</span>,
          })),
        ]}
      />
      <h3 className="pt-1 text-[13px] font-medium text-white">{t('revenue.forecast.title')}</h3>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2">
        {forecast.map((w) => (
          <Tile key={w.window} label={t(`revenue.forecast.${w.window}`)} value={formatFcp(w.invoices + w.orders)} />
        ))}
      </div>
      {forecast[0]?.orders > 0 && (
        <p className={NOTE}>{`${t('revenue.forecast.d30')} : ${t('revenue.forecast.split', { invoices: formatFcp(forecast[0].invoices), orders: formatFcp(forecast[0].orders) })}`}</p>
      )}
    </>
  );
}

function Cash({ data }: { data: CashResponse }) {
  const { t } = useTranslation();
  const month = data.months[data.months.length - 1];
  const { outstanding, topOverdue, coverage } = data;
  const ratio = month && month.invoicedTtc > 0 ? Math.min(1, month.collected / month.invoicedTtc) : null;
  return (
    <div className="space-y-2">
      {month && (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(13.5rem,1fr))] gap-2">
            <Tile label={t('revenue.cash.invoiced')} value={formatFcp(month.invoicedTtc)} />
            <Tile label={t('revenue.cash.collected')} value={formatFcp(month.collected)}
              hint={month.collectedUnknown > 0 ? t('revenue.cash.toSplit', { amount: formatFcp(month.collectedUnknown) }) : undefined} />
          </div>
          {ratio !== null && (
            <div className="h-1 overflow-hidden rounded-full bg-bambu-dark" aria-hidden="true" data-testid="revenue-cash-bar">
              {/* scaleX, not width: the fill eases to a new period's ratio on the compositor. */}
              <div className="h-full origin-left rounded-full bg-bambu-green transition-transform duration-300 ease-[var(--ease-signature)] motion-reduce:transition-none"
                style={{ transform: `scaleX(${ratio})` }} />
            </div>
          )}
        </>
      )}
      <Facts
        rows={[
          { label: t('revenue.cash.owed'), value: formatFcp(outstanding.total), note: t('revenue.cash.invoices', { n: outstanding.invoices }) },
          ...(outstanding.overdue > 0
            ? [{ label: t('revenue.cash.overdue'), value: <span className={AMBER}>{formatFcp(outstanding.overdue)}</span> }]
            : []),
          ...(topOverdue ?? []).map((r) => ({
            label: <span className="block truncate" title={`${r.number} · ${r.customerName}`}>{`${r.number} · ${r.customerName}`}</span>,
            value: formatFcp(r.balance),
            note: <span className={AMBER}>{t('revenue.cash.daysLate', { n: r.daysOverdue })}</span>,
          })),
        ]}
      />
      <Aging data={data} />
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

const OUTCOMES: Array<[FunnelOutcome, string]> = [
  ['accepted', 'bg-bambu-green'], ['declined', 'bg-red-600'], ['expired', 'bg-bambu-gray'], ['awaiting', 'bg-amber-400'],
];
// The server's amount bands (pipeline.FUNNEL_BANDS), XPF TTC.
const BAND_LIMITS = [10_000, 50_000];
const rate = (v: number | null) => (v === null ? '—' : `${Math.round(v)} %`);

/** What became of the quotes sent in the last 12 months: how many are won, how fast, and at which amounts they are lost. */
function Funnel({ data }: { data: FunnelResponse }) {
  const { t } = useTranslation();
  if (data.sent.count === 0) return <Empty>{t('revenue.funnel.empty')}</Empty>;
  const [low, high] = BAND_LIMITS.map(formatFcp);
  const bandLabel = { small: t('revenue.funnel.upTo', { amount: low }), medium: t('revenue.funnel.between', { from: low, to: high }), large: t('revenue.funnel.over', { amount: high }) };
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(13.5rem,1fr))] gap-2">
        <Tile label={t('revenue.funnel.rate')} value={rate(data.conversion.count)} hint={t('revenue.funnel.decided', { n: data.conversion.decided })} />
        <Tile label={t('revenue.funnel.rateValue')} value={rate(data.conversion.value)} />
      </div>
      <div className="flex h-1.5 gap-px overflow-hidden rounded-full" aria-hidden="true" data-testid="revenue-funnel-bar">
        {OUTCOMES.map(([k, cls]) => <div key={k} className={cls} style={{ flexGrow: data[k].count }} />)}
      </div>
      <Facts
        rows={[
          ...OUTCOMES.map(([k, cls]) => ({
            label: <span className="inline-flex items-center gap-2"><span aria-hidden="true" className={`h-2 w-2 rounded-full ${cls}`} />{t(`revenue.funnel.${k}`)}</span>,
            value: formatFcp(data[k].total),
            note: t('revenue.funnel.quotes', { n: data[k].count }),
          })),
          { label: t('revenue.funnel.delay'), value: data.medianDaysToAccept === null ? '—' : t('revenue.funnel.days', { n: data.medianDaysToAccept }) },
          ...data.bands.map((b) => ({
            label: bandLabel[b.band],
            value: rate(b.conversion),
            note: b.decided > 0 ? t('revenue.funnel.ratio', { accepted: b.accepted, decided: b.decided }) : undefined,
          })),
        ]}
      />
      {data.missingTotal > 0 && <p className={NOTE}>{t('revenue.pipeline.missingTotal', { n: data.missingTotal })}</p>}
    </div>
  );
}

function Half<T>({ title, url, version, children }: { title: string; url: string; version: unknown; children: (d: T) => ReactNode }) {
  const { data, error } = useRevenueResource<T>(url, version);
  return (
    <Panel title={title}>
      {error ? <p role="alert" className="text-sm text-status-error">{error}</p> : !data ? <Skeleton className="h-32 w-full" /> : children(data)}
    </Panel>
  );
}

/** « Trésorerie et carnet »: this month's cash vs invoiced and what is owed, then the Aito order book. Whole-business figures. */
export function RevenueCash({ version, below, aside }: {
  version: unknown;
  /** Stacked under the cash panel, and under the order book and quotes: each column packs on its own, so a tall panel leaves no hole beside it. */
  below?: ReactNode;
  aside?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Split>
      <div className="grid min-w-0 content-start gap-3">
        <Half<CashResponse> title={t('revenue.cash.title')} url="/api/v1/revenue/cash" version={version}>
          {(d) => (d.syncedAt === null && !d.error ? <Empty>{t('revenue.cash.empty')}</Empty> : <Cash data={d} />)}
        </Half>
        {below}
      </div>
      <div className="grid min-w-0 content-start gap-3">
        <Half<PipelineResponse> title={t('revenue.pipeline.title')} url="/api/v1/revenue/pipeline" version={version}>
          {(d) => <Pipeline data={d} />}
        </Half>
        <Half<FunnelResponse> title={t('revenue.funnel.title')} url="/api/v1/revenue/funnel" version={version}>
          {(d) => <Funnel data={d} />}
        </Half>
        {aside}
      </div>
    </Split>
  );
}
