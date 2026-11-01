import { usePlotArea, useXAxisDomain, useYAxisDomain } from 'recharts';
import type { HourEvent, HourMachine } from '../../../api/client';
import { dayNumber, seriesPoints, valueAt, type MachineSeries } from '../../../utils/hoursSeries';

const DAY_MS = 86_400_000;
const TICK_H = 10;

interface EventTicksProps {
  events: HourEvent[];
  machines: HourMachine[];
  visibleIds: Set<number>;
  series: Map<number, MachineSeries>;
  colors: Map<number, string>;
}

/**
 * Event marks on the lifetime curves: a 1x10 px tick at the event date, on the machine's curve, with a small
 * glyph per kind. Recharts 3 no longer passes axis scales to `Customized`, so this renders as a direct chart
 * child and rebuilds the (linear) scales from the axis domains and the plot area.
 */
export function EventTicks({ events, machines, visibleIds, series, colors }: EventTicksProps) {
  const area = usePlotArea();
  const xDomain = useXAxisDomain();
  const yDomain = useYAxisDomain();
  if (!area || !xDomain || !yDomain) return null;
  const [x0, x1] = [Number(xDomain[0]), Number(xDomain[1])];
  const [y0, y1] = [Number(yDomain[0]), Number(yDomain[1])];
  if (![x0, x1, y0, y1].every(Number.isFinite) || x1 === x0 || y1 === y0) return null;
  const px = (v: number) => area.x + ((v - x0) / (x1 - x0)) * area.width;
  const py = (v: number) => area.y + area.height - ((v - y0) / (y1 - y0)) * area.height;
  const known = new Set(machines.map((m) => m.id));

  const marks = events.flatMap((ev) => {
    if (!visibleIds.has(ev.machine_id) || !known.has(ev.machine_id)) return [];
    const s = series.get(ev.machine_id);
    const points = s ? seriesPoints(s) : [];
    if (points.length === 0) return [];
    if (ev.kind === 'added' && ev.event_date === points[0].date) return [];
    if (ev.kind === 'retired' && ev.event_date === points[points.length - 1].date) return [];
    const x = px(dayNumber(ev.event_date) * DAY_MS);
    const y = py(valueAt(points, ev.event_date));
    if (x < area.x || x > area.x + area.width) return [];
    const color = colors.get(ev.machine_id);
    return [(
      <g key={ev.id} className="hours-event-tick" data-kind={ev.kind} style={{ pointerEvents: 'all' }}>
        <title>{ev.label}</title>
        <rect x={x - 0.5} y={y - TICK_H / 2} width={1} height={TICK_H} fill={color} />
        {ev.kind === 'note' && <circle cx={x} cy={y - TICK_H / 2 - 3} r={2.5} fill={color} />}
        {ev.kind === 'maintenance' && (
          <rect x={x - 2.5} y={y - TICK_H / 2 - 5} width={5} height={5} fill="none" stroke={color} strokeWidth={1.2} />
        )}
        {ev.kind === 'calibrated' && (
          <circle cx={x} cy={y - TICK_H / 2 - 3} r={2.5} fill="none" stroke={color} strokeWidth={1.2} />
        )}
      </g>
    )];
  });
  return <g>{marks}</g>;
}
