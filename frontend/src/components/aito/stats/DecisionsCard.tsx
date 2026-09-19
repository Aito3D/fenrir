import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AitoStats } from '../../../api/client';
import { useMediaQuery } from '../../../hooks/useMediaQuery';
import { CHART_TOOLTIP_STYLE } from '../../stats/chartTheme';
import { DeltaBadge } from '../../stats/DeltaBadge';
import { computeDelta } from '../../stats/deltas';
import { localDateKey, parseLocalDateKey } from '../../../utils/date';
import { AXIS, DECLINED, GRID, SERIES } from './palette';
import { Card, Empty, Heading, InnerTile, Legend } from './primitives';
import { useStatsFormat } from './useStatsFormat';

const WEEKLY_ABOVE_DAYS = 45;
const WEEKLY_ABOVE_DAYS_NARROW = 31;

/** Quotes accepted vs declined: the two counts with their money, the
 *  acceptance rate against the previous period, and the decisions over time
 *  as stacked bars (per day, or per week on long ranges). */
export function DecisionsCard({ data }: { data: AitoStats }) {
  const { t, i18n } = useTranslation();
  const { money } = useStatsFormat();
  const narrow = useMediaQuery('(max-width: 639px)', () => typeof window !== 'undefined' && window.innerWidth < 640);

  const accepted = data.conversion.accepted;
  const declined = data.conversion.declined;
  const decided = accepted.count + declined.count;
  const rate = decided > 0 ? Math.round((accepted.count / decided) * 100) : null;
  const prev = data.previous ?? null;
  const prevDecided = prev && prev.declined !== undefined ? prev.accepted + prev.declined : 0;
  const prevRate = prev && prevDecided > 0 ? (prev.accepted / prevDecided) * 100 : null;
  const rateDelta = rate === null ? null : computeDelta(rate, prevRate, 'more-is-good');

  const { rows, weekly } = useMemo(() => {
    const daily = (data.daily ?? []).filter((d) => d.declined !== undefined);
    const fmt = new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'short' });
    const weekly = daily.length > (narrow ? WEEKLY_ABOVE_DAYS_NARROW : WEEKLY_ABOVE_DAYS);
    const buckets = new Map<string, { label: string; accepted: number; declined: number }>();
    for (const d of daily) {
      let key = d.day;
      let label = fmt.format(parseLocalDateKey(d.day));
      if (weekly) {
        const date = parseLocalDateKey(d.day);
        const start = new Date(date);
        start.setDate(date.getDate() - ((date.getDay() + 6) % 7));
        key = localDateKey(start);
        label = fmt.format(start);
      }
      const b = buckets.get(key) ?? { label, accepted: 0, declined: 0 };
      b.accepted += d.accepted;
      b.declined += d.declined ?? 0;
      buckets.set(key, b);
    }
    return { rows: [...buckets.values()], weekly };
  }, [data.daily, i18n.language, narrow]);
  const anyDecision = rows.some((r) => r.accepted + r.declined > 0);

  return (
    <Card testId="aito-stats-decisions">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <Heading>{t('aito.stats.decisionsHeading')}</Heading>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-bambu-gray-light">
          <Legend color={SERIES.accepted}>{t('aito.stats.accepted')}</Legend>
          <Legend color={DECLINED}>{t('aito.stats.declined')}</Legend>
        </ul>
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_2fr]">
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <InnerTile label={t('aito.stats.accepted')} value={String(accepted.count)} sub={accepted.count > 0 ? money(accepted.total) : undefined} />
            <InnerTile label={t('aito.stats.declined')} value={String(declined.count)} sub={declined.count > 0 ? money(declined.total) : undefined} />
          </div>
          <div className="flex items-baseline gap-2 text-sm text-bambu-gray-light">
            {rate === null ? (
              <span>{t('aito.stats.noDecisions')}</span>
            ) : (
              <>
                <span className="text-lg font-semibold text-white">{t('aito.stats.acceptanceRate', { pct: rate })}</span>
                <DeltaBadge
                  delta={rateDelta}
                  title={prevRate === null ? undefined : t('aito.stats.vsPrevious', { value: t('aito.stats.acceptanceRate', { pct: Math.round(prevRate) }) })}
                />
              </>
            )}
          </div>
        </div>
        <div>
          <p className="mb-1 text-[11px] text-bambu-gray">{weekly ? t('aito.stats.decisionsPerWeek') : t('aito.stats.decisionsPerDay')}</p>
          {anyDecision ? (
            <ResponsiveContainer width="100%" height={150}>
              <BarChart data={rows} barCategoryGap="30%" margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis dataKey="label" stroke={AXIS} tickLine={false} axisLine={{ stroke: GRID }} tick={{ fontSize: 10 }} minTickGap={24} />
                <YAxis stroke={AXIS} tickLine={false} axisLine={false} tick={{ fontSize: 10 }} allowDecimals={false} />
                <Tooltip
                  cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                  contentStyle={CHART_TOOLTIP_STYLE}
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
                <Bar dataKey="accepted" stackId="d" fill={SERIES.accepted} maxBarSize={16} isAnimationActive={false} />
                <Bar dataKey="declined" stackId="d" fill={DECLINED} radius={[3, 3, 0, 0]} maxBarSize={16} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty>{t('aito.stats.noDecisions')}</Empty>
          )}
        </div>
      </div>
    </Card>
  );
}
