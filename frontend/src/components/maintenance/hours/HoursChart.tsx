import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import type { HourEvent, HourMachine } from '../../../api/client';
import {
  dayNumber, fleetTotal, monthStarts, monthlyHours, seriesPoints, type HourPoint, type MachineSeries,
} from '../../../utils/hoursSeries';

export type HoursChartMode = 'cumulative' | 'monthly' | 'total';
export type HoursChartRange = '3m' | '12m' | 'all';

interface HoursChartProps {
  mode: HoursChartMode;
  machines: HourMachine[];
  hidden: Set<number>;
  series: Map<number, MachineSeries>;
  colors: Map<number, string>;
  today: string;
  range: HoursChartRange;
  focusId: number | null;
  onFocus: (id: number | null) => void;
  /** Clicking a curve pins the focus on it. */
  onPin?: (id: number) => void;
  /** Drawn from Task 10 on. */
  events: HourEvent[];
  gap: { lastDate: string | null; days: number };
}

const DAY_MS = 86_400_000;
const toXY = (p: HourPoint) => ({ x: dayNumber(p.date) * DAY_MS, y: p.hours });
const GRID = 'var(--color-bambu-dark-tertiary)';
const AXIS = { stroke: 'var(--color-bambu-gray)', fontSize: 11 };
const AMBER = '#d9a441';
const RANGE_DAYS = { '3m': 91, '12m': 365 } as const;

/** X domain for the time axes: the picked window up to today, or the whole history. */
function xDomain(range: HoursChartRange, today: string): [number | 'dataMin', number] {
  const end = dayNumber(today) * DAY_MS;
  return [range === 'all' ? 'dataMin' : end - RANGE_DAYS[range] * DAY_MS, end];
}

function GapHatch() {
  return (
    <defs>
      <pattern id="hours-gap-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="6" stroke={AMBER} strokeWidth="2" strokeOpacity="0.18" />
      </pattern>
    </defs>
  );
}

/** Dashed marker at the newest reading, plus a hatched band when nobody has read a counter for over a month. */
function gapMarker(
  gap: HoursChartProps['gap'], today: string, t: (k: string, o?: Record<string, unknown>) => string,
  dayFmt: Intl.DateTimeFormat,
) {
  if (gap.lastDate === null) return [];
  const x = dayNumber(gap.lastDate) * DAY_MS;
  const label = (value: string, position: 'insideTopLeft' | 'insideTopRight') => ({ value, position, fill: AMBER, fontSize: 11 });
  const out = [
    <ReferenceLine
      key="gap-line" x={x} stroke={AMBER} strokeDasharray="3 3"
      label={label(t('maintenance.hours.chart.lastReading', { date: dayFmt.format(x) }), 'insideTopLeft')}
    />,
  ];
  if (gap.days > 30) {
    out.push(
      <ReferenceArea
        key="gap-band" className="hours-gap-band" ifOverflow="hidden" x1={x} x2={dayNumber(today) * DAY_MS} fill="url(#hours-gap-hatch)"
        label={label(t('maintenance.hours.chart.noReadingsFor', { months: Math.floor(gap.days / 30) }), 'insideTopRight')}
      />,
    );
  }
  return out;
}

export function HoursChart({ mode, machines, hidden, series, colors, today, range, focusId, onFocus, onPin, gap }: HoursChartProps) {
  const { t, i18n } = useTranslation();
  const num = (v: number) => Math.round(v).toLocaleString(i18n.language);
  const monthFmt = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { month: 'short', year: '2-digit', timeZone: 'UTC' }),
    [i18n.language],
  );
  const dayFmt = useMemo(() => new Intl.DateTimeFormat(i18n.language, { timeZone: 'UTC' }), [i18n.language]);
  const visible = machines.filter((m) => !hidden.has(m.id));

  if (!visible.some((m) => seriesPoints(series.get(m.id)!).length > 0)) {
    return (
      <div data-testid="hours-chart-empty" className="flex h-[380px] items-center justify-center text-sm text-bambu-gray">
        {t('maintenance.hours.empty')}
      </div>
    );
  }

  if (mode === 'monthly') {
    const firstDates = visible.map((m) => seriesPoints(series.get(m.id)!)[0]?.date).filter(Boolean) as string[];
    const from = firstDates.sort()[0] ?? today;
    const rangeStart = range === 'all' ? -Infinity : dayNumber(today) - RANGE_DAYS[range];
    const allMonths = monthStarts(from, today);
    const first = allMonths.findIndex((d, i) => dayNumber(allMonths[i + 1] ?? d) > rangeStart || i === allMonths.length - 1);
    const months = allMonths.slice(Math.max(0, first));
    const perMachine = new Map(visible.map((m) => [m.id, monthlyHours(seriesPoints(series.get(m.id)!), months)]));
    const rows = months.map((start, i) => ({
      month: dayNumber(start) * DAY_MS,
      ...Object.fromEntries(visible.map((m) => [`m${m.id}`, perMachine.get(m.id)![i]])),
    }));
    return (
      <>
        <ResponsiveContainer width="100%" height={380}>
          <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="month" tickFormatter={(v: number) => monthFmt.format(v)} tick={AXIS} />
            <YAxis tickFormatter={(v: number) => `${num(v)} h`} tick={AXIS} width={64} />
            <Tooltip
              labelFormatter={(v) => monthFmt.format(Number(v))}
              formatter={(v, name) => [`${num(Number(v))} h`, name]}
              contentStyle={{ background: 'var(--color-bambu-dark-secondary)', border: `1px solid ${GRID}` }}
            />
            {visible.map((m) => (
              <Bar key={m.id} dataKey={`m${m.id}`} name={m.name} stackId="h" fill={colors.get(m.id)} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
        <p className="mt-2 text-xs text-bambu-gray">{t('maintenance.hours.partialMonth')}</p>
      </>
    );
  }

  if (mode === 'total') {
    const all = machines.map((m) => seriesPoints(series.get(m.id)!));
    const dates = [...new Set(all.flat().map((p) => p.date))].sort();
    const totals = fleetTotal(all, dates);
    const data = dates.map((d, i) => ({ x: dayNumber(d) * DAY_MS, y: totals[i] }));
    return (
      <ResponsiveContainer width="100%" height={380}>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <GapHatch />
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="x" type="number" scale="time" domain={xDomain(range, today)} allowDataOverflow tickFormatter={(v: number) => monthFmt.format(v)} tick={AXIS} />
          <YAxis tickFormatter={(v: number) => `${num(v)} h`} tick={AXIS} width={72} />
          <Tooltip
            labelFormatter={(v) => dayFmt.format(Number(v))}
            formatter={(v) => [`${num(Number(v))} h`, t('maintenance.hours.modeTotal')]}
            contentStyle={{ background: 'var(--color-bambu-dark-secondary)', border: `1px solid ${GRID}` }}
          />
          <Area dataKey="y" stroke="var(--color-bambu-green)" fill="var(--color-bambu-green)" fillOpacity={0.12} strokeWidth={2.5} isAnimationActive={false} />
          {gapMarker(gap, today, t, dayFmt)}
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={380}>
      <LineChart margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <GapHatch />
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="x" type="number" scale="time" domain={xDomain(range, today)} allowDataOverflow allowDuplicatedCategory={false} tickFormatter={(v: number) => monthFmt.format(v)} tick={AXIS} />
        <YAxis tickFormatter={(v: number) => `${num(v)} h`} tick={AXIS} width={64} />
        <Tooltip
          labelFormatter={(v) => dayFmt.format(Number(v))}
          formatter={(v, name) => [`${num(Number(v))} h`, name]}
          contentStyle={{ background: 'var(--color-bambu-dark-secondary)', border: `1px solid ${GRID}` }}
        />
        {visible.flatMap((m) => {
          const s = series.get(m.id)!;
          const color = colors.get(m.id);
          const lastManual = s.manual[s.manual.length - 1];
          const showTail = m.trust === 'calibrated' || m.trust === 'drifting';
          const auto = showTail && s.auto.length ? [...(lastManual ? [lastManual] : []), ...s.auto].map(toXY) : [];
          const fade = focusId !== null && focusId !== m.id ? 0.2 : 1;
          const width = focusId === m.id ? 3 : 2;
          const hover = { onMouseEnter: () => onFocus(m.id), onMouseLeave: () => onFocus(null), onClick: () => onPin?.(m.id) };
          return [
            <Line key={`${m.id}-m`} data={s.manual.map(toXY)} dataKey="y" name={m.name} type="monotone" stroke={color} strokeWidth={width} strokeOpacity={fade} dot={{ r: 3, fill: color, strokeWidth: 0, fillOpacity: fade }} isAnimationActive={false} {...hover} />,
            auto.length > 0 && (
              <Line key={`${m.id}-a`} data={auto} dataKey="y" name={`${m.name} · ${t('maintenance.hours.auto')}`} type="monotone" stroke={color} strokeWidth={width - 0.5} strokeOpacity={fade} strokeDasharray="4 4" dot={false} legendType="none" isAnimationActive={false} {...hover} />
            ),
          ];
        })}
        {gapMarker(gap, today, t, dayFmt)}
      </LineChart>
    </ResponsiveContainer>
  );
}
