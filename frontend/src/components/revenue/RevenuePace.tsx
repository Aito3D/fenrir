import { useTranslation } from 'react-i18next';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AXIS, GRID } from '../aito/stats/palette';
import { Empty, Legend, LegendList, Panel } from '../aito/stats/primitives';
import { CHART_TOOLTIP_STYLE } from '../stats/chartTheme';
import { DeltaBadge } from '../stats/DeltaBadge';
import { computeDelta } from '../stats/deltas';
import { Skeleton } from '../Skeleton';
import { paceSeries } from './lib/analysis';
import { bucketLabel, bucketRange, shiftBucketYear } from './lib/buckets';
import { compactAxis, formatFcp } from './lib/format';
import type { DailyResponse, TargetsResponse, TaxMode } from './lib/types';
import { useRevenueResource } from './useRevenueResource';

const CURRENT = '#00ae42';
const TARGET = '#f59e0b';

/** « Am I on track? »: this month's running total day by day against the same month last year and the target spread evenly over the month (HT only). */
export function RevenuePace({ monthKey, filterParams, taxMode, version }: { monthKey: string; filterParams: string; taxMode: TaxMode; version: unknown }) {
  const { t } = useTranslation();
  const cur = bucketRange(monthKey, 'month');
  // A month key always has a year-ago month (only ISO week 53 has none).
  const prevKey = shiftBucketYear(monthKey, 'month', -1)!;
  const prev = bucketRange(prevKey, 'month');
  const a = useRevenueResource<DailyResponse>(`/api/v1/revenue/daily?from=${cur.start}&to=${cur.end}${filterParams}`, version);
  const b = useRevenueResource<DailyResponse>(`/api/v1/revenue/daily?from=${prev.start}&to=${prev.end}${filterParams}`, version);
  const targets = useRevenueResource<TargetsResponse>('/api/v1/revenue/targets', version);
  // Targets cover the whole book; a filtered view has none.
  const targetHt = filterParams !== '' ? null : (targets.data?.targets.find((x) => x.month === monthKey)?.amountHt ?? null);
  // The daily route clamps to the history, so a month before it comes back for the wrong dates: keep the month's own days only.
  const pace = a.data
    ? paceSeries(monthKey, a.data.days.filter((d) => d.day.startsWith(monthKey)), b.data?.days.filter((d) => d.day.startsWith(prevKey)) ?? [], taxMode, targetHt)
    : null;
  const month = bucketLabel(monthKey, 'month');
  const name = (key: string | undefined) =>
    key === 'current' ? t('revenue.pace.thisMonth') : key === 'previous' ? t('revenue.pace.lastYear') : t('revenue.pace.target');
  const rows = pace
    ? Array.from({ length: pace.days }, (_, i) => ({ day: i + 1, current: pace.current[i], previous: pace.previous[i], target: pace.target?.[i] ?? null }))
    : [];

  return (
    <Panel
      title={t('revenue.pace.title', { month })}
      action={
        <LegendList>
          <Legend color={CURRENT}>{t('revenue.pace.thisMonth')}</Legend>
          <Legend color={AXIS}>
            {pace?.previousTotal != null
              ? t('revenue.pace.yearAgoTotal', { year: prevKey.slice(0, 4), total: formatFcp(pace.previousTotal) })
              : prevKey.slice(0, 4)}
          </Legend>
          {pace?.target && (
            <Legend color={TARGET} line>
              {t('revenue.pace.target')}
            </Legend>
          )}
        </LegendList>
      }
    >
      {a.error && !a.data ? (
        <p className="text-sm text-status-error">{a.error}</p>
      ) : !pace ? (
        <Skeleton className="h-[236px] w-full" />
      ) : pace.asOfDay === 0 ? (
        <Empty>{t('revenue.pace.empty')}</Empty>
      ) : (
        <>
          <p className="mb-2 text-xs text-bambu-gray-light">
            <span className="tabular-nums">
              {pace.previousToDate != null
                ? t('revenue.pace.toDateVs', { day: pace.asOfDay, current: formatFcp(pace.currentToDate ?? 0), previous: formatFcp(pace.previousToDate) })
                : t('revenue.pace.toDate', { day: pace.asOfDay, current: formatFcp(pace.currentToDate ?? 0) })}
            </span>
            {pace.change != null && <span className="ml-1.5"><DeltaBadge delta={computeDelta(pace.currentToDate ?? 0, pace.previousToDate, 'more-is-good')} /></span>}
          </p>
          <div role="img" aria-label={t('revenue.pace.chartLabel', { month })}>
            <ResponsiveContainer width="100%" height={236}>
              <LineChart data={rows} accessibilityLayer={false} margin={{ top: 8, right: 8, left: -4, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis dataKey="day" stroke={AXIS} tickLine={false} axisLine={{ stroke: GRID }} tick={{ fontSize: 11 }} ticks={[1, 10, 20, pace.days]} />
                <YAxis stroke={AXIS} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} tickFormatter={compactAxis} width={52} />
                <Tooltip
                  contentStyle={CHART_TOOLTIP_STYLE}
                  animationDuration={120}
                  labelStyle={{ color: '#fff' }}
                  itemStyle={{ color: '#a0a0a0' }}
                  separator=": "
                  labelFormatter={(d) => t('revenue.pace.day', { day: d })}
                  formatter={(value: number | undefined, key: string | undefined) => [value == null ? '—' : formatFcp(value), name(key)]}
                />
                {pace.target && <Line dataKey="target" stroke={TARGET} strokeWidth={1.5} strokeDasharray="5 4" dot={false} isAnimationActive={false} />}
                <Line dataKey="previous" stroke={AXIS} strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line dataKey="current" stroke={CURRENT} strokeWidth={3} strokeLinejoin="round" dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </Panel>
  );
}
