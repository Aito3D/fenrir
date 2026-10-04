import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { HourMachine } from '../../../api/client';
import {
  dayNumber, fleetTotal, monthStarts, monthlyHours, seriesPoints, type HourPoint, type MachineSeries,
} from '../../../utils/hoursSeries';

export type HoursChartMode = 'cumulative' | 'monthly' | 'total';

interface HoursChartProps {
  mode: HoursChartMode;
  machines: HourMachine[];
  hidden: Set<number>;
  series: Map<number, MachineSeries>;
  colors: Map<number, string>;
  today: string;
}

const DAY_MS = 86_400_000;
const toXY = (p: HourPoint) => ({ x: dayNumber(p.date) * DAY_MS, y: p.hours });
const GRID = 'var(--color-bambu-dark-tertiary)';
const AXIS = { stroke: 'var(--color-bambu-gray)', fontSize: 11 };

export function HoursChart({ mode, machines, hidden, series, colors, today }: HoursChartProps) {
  const { t, i18n } = useTranslation();
  const num = (v: number) => Math.round(v).toLocaleString(i18n.language);
  const monthFmt = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { month: 'short', year: '2-digit', timeZone: 'UTC' }),
    [i18n.language],
  );
  const dayFmt = useMemo(() => new Intl.DateTimeFormat(i18n.language, { timeZone: 'UTC' }), [i18n.language]);
  const visible = machines.filter((m) => !hidden.has(m.id));

  if (mode === 'monthly') {
    const firstDates = visible.map((m) => seriesPoints(series.get(m.id)!)[0]?.date).filter(Boolean) as string[];
    const from = firstDates.sort()[0] ?? today;
    const months = monthStarts(from, today);
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
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="x" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={(v: number) => monthFmt.format(v)} tick={AXIS} />
          <YAxis tickFormatter={(v: number) => `${num(v)} h`} tick={AXIS} width={72} />
          <Tooltip
            labelFormatter={(v) => dayFmt.format(Number(v))}
            formatter={(v) => [`${num(Number(v))} h`, t('maintenance.hours.modeTotal')]}
            contentStyle={{ background: 'var(--color-bambu-dark-secondary)', border: `1px solid ${GRID}` }}
          />
          <Area dataKey="y" stroke="var(--color-bambu-green)" fill="var(--color-bambu-green)" fillOpacity={0.12} strokeWidth={2.5} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={380}>
      <LineChart margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="x" type="number" scale="time" domain={['dataMin', 'dataMax']} allowDuplicatedCategory={false} tickFormatter={(v: number) => monthFmt.format(v)} tick={AXIS} />
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
          const auto = s.auto.length ? [...(lastManual ? [lastManual] : []), ...s.auto].map(toXY) : [];
          return [
            <Line key={`${m.id}-m`} data={s.manual.map(toXY)} dataKey="y" name={m.name} type="monotone" stroke={color} strokeWidth={2} dot={{ r: 3, fill: color, strokeWidth: 0 }} isAnimationActive={false} />,
            auto.length > 0 && (
              <Line key={`${m.id}-a`} data={auto} dataKey="y" name={`${m.name} · ${t('maintenance.hours.auto')}`} type="monotone" stroke={color} strokeWidth={1.5} strokeDasharray="4 4" dot={false} legendType="none" isAnimationActive={false} />
            ),
          ];
        })}
      </LineChart>
    </ResponsiveContainer>
  );
}
