import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { AitoStats } from '../../../api/client';
import { useMediaQuery } from '../../../hooks/useMediaQuery';
import { parseLocalDateKey } from '../../../utils/date';
import { CHART_TOOLTIP_STYLE } from '../../stats/chartTheme';
import { computeDelta } from '../../stats/deltas';
import { AXIS, GRID, SERIES } from './palette';
import { Empty, Finding, Panel, Split, Tile } from './primitives';
import { WEEKLY_ABOVE_DAYS, WEEKLY_ABOVE_DAYS_NARROW, foldWeekly } from './weeklyFold';

type Row = { day: string; label: string; views: number };

/** Tracking: how often clients open their public tracking page. */
export function TrackingScreen({ data }: { data: AitoStats }) {
  const { t, i18n } = useTranslation();
  const narrow = useMediaQuery('(max-width: 639px)', () => typeof window !== 'undefined' && window.innerWidth < 640);
  const tracking = data.tracking ?? { views: 0, cards_viewed: 0, cards_with_link: 0 };
  const prevViews = data.previous?.tracking_views;

  const { rows, weekly } = useMemo(() => {
    const daily = data.daily ?? [];
    const fmt = new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'short' });
    if (daily.length > (narrow ? WEEKLY_ABOVE_DAYS_NARROW : WEEKLY_ABOVE_DAYS)) {
      const buckets = foldWeekly<Row>(
        daily,
        (key, start) => ({ day: key, label: fmt.format(start), views: 0 }),
        (b, d) => {
          b.views += d.tracking_views ?? 0;
          return b;
        },
      );
      return { rows: [...buckets.values()], weekly: true };
    }
    return {
      rows: daily.map((d) => ({ day: d.day, label: fmt.format(parseLocalDateKey(d.day)), views: d.tracking_views ?? 0 })),
      weekly: false,
    };
  }, [data.daily, i18n.language, narrow]);

  const peak = useMemo(() => {
    const best = rows.reduce<Row | null>((b, r) => (r.views > 0 && (b === null || r.views > b.views) ? r : b), null);
    if (!best) return null;
    const date = new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'long' }).format(parseLocalDateKey(best.day));
    return weekly ? t('aito.stats.finding.overviewPeakWeek', { date }) : t('aito.stats.finding.overviewPeakDay', { date });
  }, [rows, weekly, i18n.language, t]);

  const lead =
    tracking.views === 0 ? t('aito.stats.finding.trackingNone') : t('aito.stats.finding.tracking', { count: tracking.views });
  const perCard = tracking.cards_viewed > 0 ? (tracking.views / tracking.cards_viewed).toFixed(1) : '—';

  return (
    <div className="grid gap-3">
      <Finding testId="aito-stats-finding" lead={lead} rest={peak} />
      <Split>
        <Panel testId="aito-stats-tracking-chart" title={weekly ? t('aito.stats.trackingWeekly') : t('aito.stats.trackingDaily')}>
          {rows.some((r) => r.views > 0) ? (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={rows} barCategoryGap="25%" margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis dataKey="label" stroke={AXIS} tickLine={false} axisLine={{ stroke: GRID }} tick={{ fontSize: 11 }} minTickGap={28} />
                <YAxis stroke={AXIS} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip
                  cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                  contentStyle={CHART_TOOLTIP_STYLE}
                  animationDuration={120}
                  labelStyle={{ color: '#fff' }}
                  itemStyle={{ color: '#a0a0a0' }}
                  separator=": "
                  labelFormatter={(label) => (weekly ? t('aito.stats.weekOf', { date: label }) : String(label))}
                  formatter={(value: number | undefined) => [String(value ?? 0), t('stats.pipelineTrackingViews')]}
                />
                <Bar dataKey="views" fill={SERIES.created} radius={[3, 3, 0, 0]} maxBarSize={14} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty>{t('aito.stats.empty')}</Empty>
          )}
        </Panel>
        <Panel testId="aito-stats-tracking-band" title={t('aito.stats.thisPeriod')}>
          <div className="grid gap-1.5 stagger-children sm:grid-cols-2 lg:grid-cols-1">
            <Tile
              swatch={SERIES.created}
              value={String(tracking.views)}
              label={t('stats.pipelineTrackingViews')}
              delta={computeDelta(tracking.views, prevViews, 'more-is-good')}
              deltaTitle={prevViews === undefined ? undefined : t('aito.stats.vsPrevious', { value: prevViews })}
            />
            <Tile value={String(tracking.cards_viewed)} label={t('stats.pipelineTrackingCards')} />
            <Tile value={perCard} label={t('aito.stats.trackingPerCard')} />
            <Tile value={String(tracking.cards_with_link)} label={t('stats.pipelineTrackingLinks')} hint={t('aito.stats.asOfToday')} />
          </div>
        </Panel>
      </Split>
    </div>
  );
}
