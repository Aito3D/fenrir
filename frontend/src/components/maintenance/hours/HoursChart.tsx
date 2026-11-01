import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import type { HourEvent, HourMachine } from '../../../api/client';
import {
  dayNumber, fleetTotal, forecastDate, monthStarts, monthlyHours, ratePerMonth, sameAgePoints, seriesPoints,
  type HourPoint, type MachineSeries,
} from '../../../utils/hoursSeries';
import { EventTicks } from './EventTicks';

export type HoursChartMode = 'cumulative' | 'monthly' | 'total' | 'sameAge';
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
function xDomain(range: HoursChartRange, today: string, extendDays = 0): [number | 'dataMin', number] {
  const end = dayNumber(today) * DAY_MS;
  return [range === 'all' ? 'dataMin' : end - RANGE_DAYS[range] * DAY_MS, range === 'all' ? end + extendDays * DAY_MS : end];
}

const DAYS_PER_MONTH = 30.44;
const FORECAST_DAYS = 365;

/** Two points of the dotted forecast: the last reading and the horizon at `pace` h/month; null when nothing is left to draw. */
function forecastRows(
  points: HourPoint[], pace: number | null, today: string, range: HoursChartRange,
): { x: number; y: number }[] | null {
  if (pace === null || pace <= 0 || points.length === 0) return null;
  const last = points[points.length - 1];
  const from = dayNumber(last.date);
  const horizon = dayNumber(today) + FORECAST_DAYS;
  const end = range === 'all' ? horizon : Math.min(horizon, dayNumber(today));
  if (end <= from) return null;
  return [
    { x: from * DAY_MS, y: last.hours },
    { x: end * DAY_MS, y: last.hours + pace * ((end - from) / DAYS_PER_MONTH) },
  ];
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

export function HoursChart({ mode, machines, hidden, series, colors, today, range, focusId, onFocus, onPin, events, gap }: HoursChartProps) {
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

  if (mode === 'sameAge') {
    return (
      <>
        {visible.length > 4 && (
          <p data-testid="hours-same-age-hint" className="mb-2 text-xs text-bambu-gray">{t('maintenance.hours.chart.sameAgeHint')}</p>
        )}
        <ResponsiveContainer width="100%" height={380}>
          <LineChart margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis
              dataKey="day" type="number" domain={[0, 'dataMax']} allowDuplicatedCategory={false} tick={AXIS}
              tickFormatter={(d: number) => `${Math.round(d / DAYS_PER_MONTH)} ${t('maintenance.hours.chart.months')}`}
            />
            <YAxis tickFormatter={(v: number) => `${num(v)} h`} tick={AXIS} width={64} />
            <Tooltip
              labelFormatter={(v) => `${Math.round(Number(v) / DAYS_PER_MONTH)} ${t('maintenance.hours.chart.months')}`}
              formatter={(v, name) => [`${num(Number(v))} h`, name]}
              contentStyle={{ background: 'var(--color-bambu-dark-secondary)', border: `1px solid ${GRID}` }}
            />
            {visible.map((m) => {
              const color = colors.get(m.id);
              const fade = focusId !== null && focusId !== m.id ? 0.2 : 1;
              return (
                <Line
                  key={m.id} data={sameAgePoints(seriesPoints(series.get(m.id)!))} dataKey="hours" name={m.name} type="monotone"
                  stroke={color} strokeWidth={focusId === m.id ? 3 : 2} strokeOpacity={fade}
                  dot={{ r: 3, fill: color, strokeWidth: 0, fillOpacity: fade }} isAnimationActive={false}
                  onMouseEnter={() => onFocus(m.id)} onMouseLeave={() => onFocus(null)} onClick={() => onPin?.(m.id)}
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      </>
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

  const paces = new Map(visible.map((m) => [m.id, ratePerMonth(seriesPoints(series.get(m.id)!), today)]));
  const forecasts = new Map(visible.map((m) => [m.id, forecastRows(seriesPoints(series.get(m.id)!), paces.get(m.id) ?? null, today, range)]));
  const anyForecast = [...forecasts.values()].some(Boolean);
  const focused = focusId === null ? undefined : visible.find((m) => m.id === focusId);
  const focusPoints = focused ? seriesPoints(series.get(focused.id)!) : [];
  const service = focused?.next_service_hours ?? null;
  const serviceDate = service !== null && focusPoints.length > 0
    ? forecastDate(focusPoints[focusPoints.length - 1], paces.get(focused!.id) ?? null, service)
    : null;

  return (
    <ResponsiveContainer width="100%" height={380}>
      <LineChart margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <GapHatch />
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="x" type="number" scale="time" domain={xDomain(range, today, anyForecast ? FORECAST_DAYS : 0)} allowDataOverflow allowDuplicatedCategory={false} tickFormatter={(v: number) => monthFmt.format(v)} tick={AXIS} />
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
            forecasts.get(m.id) && (
              <Line key={`${m.id}-f`} className="hours-forecast" data={forecasts.get(m.id)!} dataKey="y" name={`${m.name} · ${t('maintenance.hours.chart.forecast')}`} type="linear" stroke={color} strokeWidth={1.5} strokeOpacity={fade} strokeDasharray="2 4" dot={false} legendType="none" isAnimationActive={false} />
            ),
          ];
        })}
        {service !== null && (
          <ReferenceLine
            className="hours-service-line" y={service} stroke={AMBER} strokeDasharray="5 4" ifOverflow="extendDomain"
            label={{
              value: t('maintenance.hours.chart.nextService', {
                hours: num(service), date: serviceDate ? dayFmt.format(dayNumber(serviceDate) * DAY_MS) : '—',
              }),
              position: 'insideTopLeft', fill: AMBER, fontSize: 11,
            }}
          />
        )}
        <EventTicks events={events} machines={machines} visibleIds={new Set(visible.map((m) => m.id))} series={series} colors={colors} />
        {gapMarker(gap, today, t, dayFmt)}
      </LineChart>
    </ResponsiveContainer>
  );
}
