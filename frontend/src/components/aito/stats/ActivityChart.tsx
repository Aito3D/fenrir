import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AitoStatsDay } from '../../../api/client';
import { useMediaQuery } from '../../../hooks/useMediaQuery';
import { CHART_TOOLTIP_STYLE } from '../../stats/chartTheme';
import { parseLocalDateKey } from '../../../utils/date';
import { AXIS, GRID, SERIES, TOOLTIP_ORDER } from './palette';
import { Empty, Legend, LegendList, Panel } from './primitives';
import { WEEKLY_ABOVE_DAYS, WEEKLY_ABOVE_DAYS_NARROW, foldWeekly } from './weeklyFold';

type ChartRow = AitoStatsDay & { label: string; done7?: number };

/** Grouped bars per day (or per week) for added / accepted / completed, with
 *  a 7-day average of completed in daily mode. */
export function ActivityChart({ daily }: { daily: AitoStatsDay[] }) {
  const { t, i18n } = useTranslation();
  const narrow = useMediaQuery('(max-width: 639px)', () => typeof window !== 'undefined' && window.innerWidth < 640);

  const { rows, weekly } = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'short' });
    if (daily.length > (narrow ? WEEKLY_ABOVE_DAYS_NARROW : WEEKLY_ABOVE_DAYS)) {
      const buckets = foldWeekly<ChartRow>(
        daily,
        (key, start) => ({ day: key, created: 0, accepted: 0, done: 0, label: fmt.format(start) }),
        (b, d) => {
          b.created += d.created;
          b.accepted += d.accepted;
          b.done += d.done;
          return b;
        },
      );
      return { rows: [...buckets.values()], weekly: true };
    }
    const rows: ChartRow[] = daily.map((d, i) => {
      const window = daily.slice(Math.max(0, i - 6), i + 1);
      const done7 = window.reduce((s, r) => s + r.done, 0) / window.length;
      return { ...d, label: fmt.format(parseLocalDateKey(d.day)), done7: Math.round(done7 * 100) / 100 };
    });
    return { rows, weekly: false };
  }, [daily, i18n.language, narrow]);

  const active = rows.some((r) => r.created + r.accepted + r.done > 0);
  const name = (key: string | undefined) =>
    key === 'created'
      ? t('aito.stats.added')
      : key === 'accepted'
        ? t('aito.stats.accepted')
        : key === 'done'
          ? t('aito.stats.completed')
          : t('aito.stats.rolling7');

  return (
    <Panel
      testId="aito-stats-activity"
      title={weekly ? t('aito.stats.activityWeekly') : t('aito.stats.activity')}
      action={
        <LegendList>
          <Legend color={SERIES.created}>{t('aito.stats.added')}</Legend>
          <Legend color={SERIES.accepted}>{t('aito.stats.accepted')}</Legend>
          <Legend color={SERIES.done}>{t('aito.stats.completed')}</Legend>
          {!weekly && (
            <Legend color={SERIES.done} line>
              {t('aito.stats.rolling7')}
            </Legend>
          )}
        </LegendList>
      }
    >
      {active ? (
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={rows} barGap={2} barCategoryGap="25%" margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="label" stroke={AXIS} tickLine={false} axisLine={{ stroke: GRID }} tick={{ fontSize: 11 }} minTickGap={28} />
            <YAxis stroke={AXIS} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} allowDecimals={false} />
            <Tooltip
              cursor={{ stroke: GRID, fill: 'rgba(255,255,255,0.04)' }}
              contentStyle={CHART_TOOLTIP_STYLE}
              animationDuration={120}
              animationEasing="ease-out"
              labelStyle={{ color: '#fff' }}
              itemStyle={{ color: '#a0a0a0' }}
              separator=": "
              itemSorter={(item) => TOOLTIP_ORDER.indexOf(String(item.dataKey))}
              labelFormatter={(label) => (weekly ? t('aito.stats.weekOf', { date: label }) : String(label))}
              formatter={(value: number | undefined, key: string | undefined) => [String(value ?? 0), name(key)]}
            />
            <Bar dataKey="created" fill={SERIES.created} radius={[3, 3, 0, 0]} maxBarSize={14} isAnimationActive={false} />
            <Bar dataKey="accepted" fill={SERIES.accepted} radius={[3, 3, 0, 0]} maxBarSize={14} isAnimationActive={false} />
            <Bar dataKey="done" fill={SERIES.done} radius={[3, 3, 0, 0]} maxBarSize={14} isAnimationActive={false} />
            {!weekly && (
              <Line
                type="monotone"
                dataKey="done7"
                stroke={SERIES.done}
                strokeWidth={2}
                strokeDasharray="4 3"
                dot={false}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      ) : (
        <Empty>{t('aito.stats.empty')}</Empty>
      )}
    </Panel>
  );
}
