import { useTranslation } from 'react-i18next';
import { Empty, Panel, Tile } from '../aito/stats/primitives';
import { Skeleton } from '../Skeleton';
import { bucketLabel } from './lib/buckets';
import { formatFcp } from './lib/format';
import type { ResultResponse } from './lib/types';
import { useRevenueResource } from './useRevenueResource';

const NOTE = 'text-[11px] text-bambu-gray';
const dayMonth = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
const DASH = '—';

/** « Do I make money? »: revenue minus every cost per month, and the sales the month needs to cover its charges. */
export function RevenueResult({ version }: { version: unknown }) {
  const { t } = useTranslation();
  const { data, error } = useRevenueResource<ResultResponse>('/api/v1/revenue/result', version);
  const month = data?.months[data.months.length - 1];
  const be = data?.breakEven ?? null;
  return (
    <Panel title={t('revenue.result.title')}>
      {error ? <p role="alert" className="text-sm text-status-error">{error}</p> : !data ? <Skeleton className="h-32 w-full" /> : (
        <div className="space-y-2">
          {month && !month.partial && (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(13.5rem,1fr))] gap-2">
              {month.fixedEstimated > 0 ? (
                <>
                  {/* Never one merged figure: what the books say, then what the month will look like once the usual charges are entered. */}
                  <Tile label={t('revenue.result.realResult')} value={formatFcp(month.resultReal)} tone={month.resultReal < 0 ? 'alert' : undefined} />
                  <Tile label={t('revenue.result.projectedResult')} value={formatFcp(month.result)} tone={month.result < 0 ? 'alert' : undefined}
                    hint={t('revenue.result.estimatedNote', { amount: formatFcp(month.fixedEstimated) })} />
                </>
              ) : (
                <Tile label={t('revenue.result.month')} value={formatFcp(month.result)} tone={month.result < 0 ? 'alert' : undefined} />
              )}
              {be && (
                <>
                  <Tile label={t('revenue.result.breakEven')} value={formatFcp(be.amount)} />
                  <Tile label={t('revenue.result.reached')} value={`${Math.round(be.reached * 100)} %`}
                    hint={be.day === null ? t('revenue.result.notThisMonth') : t(be.projected ? 'revenue.result.expectedOn' : 'revenue.result.reachedOn', { day: dayMonth(be.day) })} />
                </>
              )}
            </div>
          )}
          {!be && <Empty>{t('revenue.result.noRate')}</Empty>}
          {data.fixedMonthly === 0 && <p className={NOTE}>{t('revenue.result.noFixed')}</p>}
          {data.costsSince && data.months.some((m) => m.partial) && (
            <p className={NOTE}>{t('revenue.result.partial', { day: `${dayMonth(data.costsSince)}/${data.costsSince.slice(0, 4)}` })}</p>
          )}
          <div className="overflow-x-auto">
            <table aria-label={t('revenue.result.title')} className="w-full min-w-[720px] text-[13px] tabular-nums">
              <thead className="text-xs text-bambu-gray">
                <tr>
                  <th className="px-2 py-1 text-left font-normal">{t('revenue.result.colMonth')}</th>
                  {(['colRevenue', 'colVariable', 'colLabor', 'colFixed', 'colDepreciation', 'colResult', 'colCoverage'] as const).map((k) => (
                    <th key={k} scope="col" className="px-2 py-1 text-right font-normal">{t(`revenue.result.${k}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...data.months].reverse().map((m) => (
                  <tr key={m.month} className="border-t border-bambu-dark-tertiary">
                    <td className="px-2 py-1 text-left text-bambu-gray-light">{bucketLabel(m.month, 'month')}</td>
                    <td className="px-2 py-1 text-right text-white">{formatFcp(m.ht)}</td>
                    <td className="px-2 py-1 text-right text-bambu-gray-light">{m.partial ? DASH : formatFcp(m.variable)}</td>
                    <td className="px-2 py-1 text-right text-bambu-gray-light">{m.partial ? DASH : formatFcp(m.labor)}</td>
                    <td className="px-2 py-1 text-right text-bambu-gray-light">
                      {formatFcp(m.fixed)}
                      {m.fixedEstimated > 0 && <span className="ml-1 text-amber-700 dark:text-amber-400">≈ +{formatFcp(m.fixedEstimated)}</span>}
                    </td>
                    <td className="px-2 py-1 text-right text-bambu-gray-light">{m.partial ? DASH : formatFcp(m.depreciation)}</td>
                    <td className={`px-2 py-1 text-right font-medium ${!m.partial && m.result < 0 ? 'text-status-error' : 'text-white'}`}>{m.partial ? DASH : formatFcp(m.result)}</td>
                    <td className={`px-2 py-1 text-right ${m.coverage !== null && m.coverage < 0.8 && !m.partial ? 'text-amber-700 dark:text-amber-400' : 'text-bambu-gray'}`}>
                      {m.partial || m.coverage === null ? DASH : `${Math.round(m.coverage * 100)} %`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Panel>
  );
}
