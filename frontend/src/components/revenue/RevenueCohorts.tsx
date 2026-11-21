import { useTranslation } from 'react-i18next';
import { Empty, Facts, Panel, Split } from '../aito/stats/primitives';
import { Skeleton } from '../Skeleton';
import { bucketLabel } from './lib/buckets';
import { formatFcp } from './lib/format';
import type { CohortsResponse } from './lib/types';
import { useRevenueResource } from './useRevenueResource';

const NOTE = 'mb-2 text-[11px] text-bambu-gray';
const TH = 'px-2 py-1 font-normal';
const fullDay = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;

function Grid({ cohorts }: { cohorts: CohortsResponse['cohorts'] }) {
  const { t } = useTranslation();
  const rows = cohorts.filter((c) => c.size > 0);
  if (rows.length === 0) return <Empty>{t('revenue.customers.empty')}</Empty>;
  return (
    <div className="overflow-x-auto">
      <table aria-label={t('revenue.cohorts.title')} className="w-full min-w-[760px] border-separate border-spacing-[2px] text-xs tabular-nums">
        <thead className="text-bambu-gray">
          <tr>
            <th className={`${TH} text-left`}>{t('revenue.cohorts.month')}</th>
            <th className={`${TH} text-right`}>{t('revenue.cohorts.size')}</th>
            <th className={`${TH} text-right`}>{t('revenue.cohorts.perCustomer')}</th>
            {rows[0].retention.map((_, k) => <th key={k} className={`${TH} text-center`}>{t('revenue.cohorts.after', { n: k + 1 })}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.month}>
              <th scope="row" className="whitespace-nowrap px-2 py-1 text-left font-normal text-bambu-gray-light">{bucketLabel(c.month, 'month')}</th>
              <td className="px-2 py-1 text-right text-white">{c.size}</td>
              <td className="whitespace-nowrap px-2 py-1 text-right text-bambu-gray-light">{formatFcp(c.revenuePerCustomer)}</td>
              {c.retention.map((pct, k) => (
                <td key={k} title={pct === null ? undefined : t('revenue.cohorts.cell', { pct: Math.round(pct), n: k + 1 })}
                  className="rounded-sm px-1 py-1 text-center text-white"
                  // The app's green, denser as more of the cohort came back.
                  style={pct === null ? undefined : { backgroundColor: `rgba(0, 174, 66, ${0.08 + Math.min(pct, 100) * 0.006})` }}>
                  {pct === null ? '' : `${Math.round(pct)} %`}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AtRisk({ rows }: { rows: CohortsResponse['atRisk'] }) {
  const { t } = useTranslation();
  if (rows.length === 0) return <Empty>{t('revenue.cohorts.riskEmpty')}</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-[13px] tabular-nums">
        <thead className="text-xs text-bambu-gray">
          <tr>
            <th className={`${TH} text-left`}>{t('revenue.cohorts.colCustomer')}</th>
            <th className={`${TH} text-right`}>{t('revenue.cohorts.colLast')}</th>
            <th className={`${TH} text-right`}>{t('revenue.cohorts.colUsual')}</th>
            <th className={`${TH} text-right`}>{t('revenue.cohorts.colSince')}</th>
            <th className={`${TH} text-right`}>{t('revenue.cohorts.colRevenue')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.customerName}-${r.lastDay}`} className="border-t border-bambu-dark-tertiary">
              <td className="max-w-[14rem] truncate px-2 py-1 text-left text-white" title={r.customerName}>{r.customerName}</td>
              <td className="px-2 py-1 text-right text-bambu-gray-light">{fullDay(r.lastDay)}</td>
              <td className="px-2 py-1 text-right text-bambu-gray-light">{t('revenue.cohorts.everyDays', { n: r.usualGapDays })}</td>
              <td className="px-2 py-1 text-right text-amber-700 dark:text-amber-400">{t('revenue.cohorts.days', { n: r.daysSince })}</td>
              <td className="whitespace-nowrap px-2 py-1 text-right font-medium text-white">{formatFcp(r.revenue12m)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** « Who comes back? »: retention by month of first purchase, what a customer is worth in a year, and regulars gone quiet. */
export function RevenueCohorts({ version }: { version: unknown }) {
  const { t } = useTranslation();
  const { data, error } = useRevenueResource<CohortsResponse>('/api/v1/revenue/cohorts', version);
  if (error) return <Panel title={t('revenue.cohorts.title')}><p role="alert" className="text-sm text-status-error">{error}</p></Panel>;
  if (!data) return <Skeleton className="h-64 w-full" />;
  return (
    <>
      <Panel title={t('revenue.cohorts.title')}>
        <p className={NOTE}>{t('revenue.cohorts.intro')}</p>
        <Grid cohorts={data.cohorts} />
      </Panel>
      <Split>
        <Panel title={t('revenue.cohorts.riskTitle')}>
          <p className={NOTE}>{t('revenue.cohorts.riskIntro')}</p>
          <AtRisk rows={data.atRisk} />
        </Panel>
        <Panel title={t('revenue.cohorts.ltvTitle')}>
          <p className={NOTE}>{t('revenue.cohorts.ltvIntro')}</p>
          {data.ltv.length === 0 ? <Empty>{t('revenue.cohorts.ltvEmpty')}</Empty> : (
            <Facts rows={data.ltv.map((s) => ({
              label: t(`revenue.filters.segments.${s.segment}`),
              value: formatFcp(s.ltv12),
              note: t('revenue.cohorts.ltvCustomers', { n: s.customers }),
            }))} />
          )}
        </Panel>
      </Split>
    </>
  );
}
