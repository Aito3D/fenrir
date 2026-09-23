import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AitoStatsDay } from '../../../api/client';
import { useMediaQuery } from '../../../hooks/useMediaQuery';
import { CHART_TOOLTIP_STYLE } from '../../stats/chartTheme';
import { parseLocalDateKey } from '../../../utils/date';
import { AXIS, DECISION, GRID } from './palette';
import { Empty, Legend, LegendList, Panel } from './primitives';
import { WEEKLY_ABOVE_DAYS, WEEKLY_ABOVE_DAYS_NARROW, weekKey, weekStart } from './weeklyFold';

/** Quotes accepted vs declined over time as stacked bars (per day, or per
 *  week on long ranges). The counts themselves live in the Sales facts. */
export function DecisionsChart({ daily }: { daily: AitoStatsDay[] }) {
  const { t, i18n } = useTranslation();
  const narrow = useMediaQuery('(max-width: 639px)', () => typeof window !== 'undefined' && window.innerWidth < 640);

  const { rows, weekly } = useMemo(() => {
    const days = daily.filter((d) => d.declined !== undefined);
    const fmt = new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'short' });
    const weekly = days.length > (narrow ? WEEKLY_ABOVE_DAYS_NARROW : WEEKLY_ABOVE_DAYS);
    const buckets = new Map<string, { label: string; accepted: number; declined: number }>();
    for (const d of days) {
      let key = d.day;
      let label = fmt.format(parseLocalDateKey(d.day));
      if (weekly) {
        const date = parseLocalDateKey(d.day);
        const start = weekStart(date);
        key = weekKey(date);
        label = fmt.format(start);
      }
      const b = buckets.get(key) ?? { label, accepted: 0, declined: 0 };
      b.accepted += d.accepted;
      b.declined += d.declined ?? 0;
      buckets.set(key, b);
    }
    return { rows: [...buckets.values()], weekly };
  }, [daily, i18n.language, narrow]);
  const anyDecision = rows.some((r) => r.accepted + r.declined > 0);

  return (
    <Panel
      testId="aito-stats-decisions"
      title={weekly ? t('aito.stats.decisionsPerWeek') : t('aito.stats.decisionsPerDay')}
      action={
        <LegendList>
          <Legend color={DECISION.accepted}>{t('aito.stats.accepted')}</Legend>
          <Legend color={DECISION.declined}>{t('aito.stats.declined')}</Legend>
        </LegendList>
      }
    >
      {anyDecision ? (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={rows} barCategoryGap="30%" margin={{ top: 8, right: 4, left: -20, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="label" stroke={AXIS} tickLine={false} axisLine={{ stroke: GRID }} tick={{ fontSize: 10.5 }} minTickGap={24} />
            <YAxis stroke={AXIS} tickLine={false} axisLine={false} tick={{ fontSize: 10.5 }} allowDecimals={false} />
            <Tooltip
              cursor={{ fill: 'rgba(255,255,255,0.04)' }}
              contentStyle={CHART_TOOLTIP_STYLE}
              animationDuration={120}
              animationEasing="ease-out"
              labelStyle={{ color: '#fff' }}
              itemStyle={{ color: '#a0a0a0' }}
              separator=": "
              itemSorter={(item) => (item.dataKey === 'accepted' ? 0 : 1)}
              labelFormatter={(label) => (weekly ? t('aito.stats.weekOf', { date: label }) : String(label))}
              formatter={(value: number | undefined, key: string | undefined) => [
                String(value ?? 0),
                key === 'accepted' ? t('aito.stats.accepted') : t('aito.stats.declined'),
              ]}
            />
            <Bar dataKey="accepted" stackId="d" fill={DECISION.accepted} maxBarSize={22} isAnimationActive={false} />
            <Bar dataKey="declined" stackId="d" fill={DECISION.declined} radius={[3, 3, 0, 0]} maxBarSize={22} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <Empty>{t('aito.stats.noDecisions')}</Empty>
      )}
    </Panel>
  );
}
