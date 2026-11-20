import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AXIS, GRID } from '../aito/stats/palette';
import { Empty, LegendList, Panel } from '../aito/stats/primitives';
import { CHART_TOOLTIP_STYLE } from '../stats/chartTheme';
import { Skeleton } from '../Skeleton';
import { RevenueSegmented } from './RevenueSegmented';
import { compactAxis, formatFcp, formatPct } from './lib/format';
import type { TaxMode, YoyResponse, YoyYear } from './lib/types';
import { useRevenueResource } from './useRevenueResource';

// Newest year first: the accent green, then fading steps, so the current year reads on top. The two oldest are told
// apart by pattern as well as lightness; every stroke stays at 3:1 or better on the dark panel (#2d2d2d).
const YEAR_STYLE = [
  { color: '#00ae42', width: 3, dash: undefined, border: 'solid' },
  { color: '#3d86e8', width: 2, dash: undefined, border: 'solid' },
  { color: '#a0a0a0', width: 1.5, dash: '6 4', border: 'dashed' },
  { color: '#808080', width: 1.5, dash: '2 3', border: 'dotted' },
] as const;

type Mode = 'cumul' | 'mensuel';

const lastKnown = (values: (number | null)[]) => {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return i;
  return -1;
};

/** Each year's month-by-month revenue against the years before it, as running totals or per month; a month with missing days breaks the line. */
export function RevenueYoy({ filterParams, taxMode, version }: { filterParams: string; taxMode: TaxMode; version: unknown }) {
  const { t, i18n } = useTranslation();
  const { data, error } = useRevenueResource<YoyResponse>(`/api/v1/revenue/yoy${filterParams ? `?${filterParams.slice(1)}` : ''}`, version);
  const [mode, setMode] = useState<Mode>('cumul');
  const monthFmt = new Intl.DateTimeFormat(i18n.language, { month: 'short', timeZone: 'UTC' });
  const months = Array.from({ length: 12 }, (_, i) => monthFmt.format(Date.UTC(2024, i, 1)));
  const ttc = taxMode === 'ttc';
  const tax = t(ttc ? 'revenue.ttc' : 'revenue.ht');
  const years = [...(data?.years ?? [])].sort((a, b) => b.year - a.year).slice(0, YEAR_STYLE.length);
  const cum = (y: YoyYear) => (ttc ? y.cumulativeTtc : y.cumulativeHt);
  const valuesOf = (y: YoyYear) => (mode === 'cumul' ? cum(y) : ttc ? y.ttc : y.ht);
  const rows = months.map((label, i) => Object.fromEntries([['month', label], ...years.map((y) => [`y${y.year}`, valuesOf(y)[i]])]));

  const title = t('revenue.yoy.title');
  const toggle = (
    <RevenueSegmented
      inPanel
      label={t('revenue.yoy.mode')}
      value={mode}
      onChange={setMode}
      options={[
        { id: 'cumul', label: t('revenue.yoy.cumul') },
        { id: 'mensuel', label: t('revenue.yoy.monthly') },
      ]}
    />
  );
  const heading = (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-xs uppercase tracking-wide text-bambu-gray">{title}</p>
      {data && years.length > 0 && toggle}
    </div>
  );

  if (error && !data) return <Panel title={title}><p role="alert" className="text-sm text-status-error">{error}</p></Panel>;
  if (!data) return <Panel title={title}><Skeleton className="h-[260px] w-full" /></Panel>;
  if (years.length === 0) return <Panel title={title}><Empty>{t('revenue.analysis.noData')}</Empty></Panel>;

  // « 2026 à date »: the newest year's running total at its last known month against the year before at that month.
  const current = years[0];
  const previous = years.find((y) => y.year === current.year - 1);
  const at = lastKnown(cum(current));
  const curToDate = at >= 0 ? cum(current)[at] : null;
  const prevToDate = previous && at >= 0 ? cum(previous)[at] : null;
  const change = curToDate !== null && prevToDate ? (curToDate - prevToDate) / prevToDate : null;

  return (
    <Panel
      title={heading}
      action={
        <LegendList label={t('revenue.chart.legend')}>
          {years.map((y, k) => {
            const i = lastKnown(cum(y));
            return (
              <li key={y.year} className="inline-flex items-center gap-1.5">
                <span data-swatch aria-hidden="true" className="inline-block h-0 w-4 border-t-2" style={{ borderTopColor: YEAR_STYLE[k].color, borderTopStyle: YEAR_STYLE[k].border }} />
                <span className={k === 0 ? 'text-white' : ''}>{y.year}</span>{' '}
                <span className="tabular-nums text-bambu-gray">{i >= 0 ? formatFcp(cum(y)[i]!) : '—'}</span>
              </li>
            );
          })}
        </LegendList>
      }
    >
      <div role="img" aria-label={t(mode === 'cumul' ? 'revenue.yoy.chartCumul' : 'revenue.yoy.chartMonthly', { tax })}>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={rows} accessibilityLayer={false} margin={{ top: 8, right: 8, left: -4, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="month" stroke={AXIS} tickLine={false} axisLine={{ stroke: GRID }} tick={{ fontSize: 11 }} interval="preserveStartEnd" />
            <YAxis stroke={AXIS} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} tickFormatter={compactAxis} width={52} />
            <Tooltip
              contentStyle={CHART_TOOLTIP_STYLE}
              animationDuration={120}
              labelStyle={{ color: '#fff' }}
              itemStyle={{ color: '#a0a0a0' }}
              separator=": "
              itemSorter={(item) => -Number(String(item.dataKey).slice(1))}
              labelFormatter={(m) => (mode === 'cumul' ? t('revenue.yoy.tooltipCumul', { month: m }) : String(m))}
              formatter={(value: number | undefined, key: string | undefined) => [value == null ? '—' : formatFcp(value), String(key ?? '').slice(1)]}
            />
            {/* Oldest drawn first so the newest year sits on top. */}
            {[...years].reverse().map((y) => {
              const k = years.indexOf(y);
              const vals = valuesOf(y);
              const { color, width, dash } = YEAR_STYLE[k];
              return (
                <Line
                  key={y.year}
                  dataKey={`y${y.year}`}
                  stroke={color}
                  strokeWidth={width}
                  strokeDasharray={dash}
                  strokeLinejoin="round"
                  isAnimationActive={false}
                  activeDot={{ r: 4 }}
                  // A month between two gaps has no segment to draw: mark it with a dot so it is not lost.
                  dot={(p: { cx?: number; cy?: number; index?: number }) => {
                    const i = p.index ?? 0;
                    const lone = vals[i] !== null && (vals[i - 1] ?? null) === null && (vals[i + 1] ?? null) === null;
                    return lone && p.cx != null && p.cy != null ? (
                      <circle key={i} data-lone cx={p.cx} cy={p.cy} r={k === 0 ? 3.5 : 2.5} fill={color} />
                    ) : (
                      <g key={i} />
                    );
                  }}
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {curToDate !== null && (
        <p data-testid="yoy-to-date" className="mt-2 text-xs tabular-nums text-bambu-gray-light">
          {change !== null && previous ? (
            <>
              {t('revenue.yoy.toDateVs', { year: current.year, amount: formatFcp(curToDate) })}{' '}
              <span className={change >= 0 ? 'text-bambu-green' : 'text-status-error'}>{formatPct(change)}</span>{' '}
              {t('revenue.yoy.samePeriod', { previous: previous.year, first: months[0], month: months[at] })}
            </>
          ) : (
            t('revenue.yoy.toDateAlone', { year: current.year, amount: formatFcp(curToDate), previous: current.year - 1 })
          )}
        </p>
      )}
    </Panel>
  );
}
