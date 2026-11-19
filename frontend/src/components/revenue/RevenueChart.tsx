import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bar, CartesianGrid, Cell, ComposedChart, Line, ResponsiveContainer, Tooltip, usePlotArea, XAxis, YAxis } from 'recharts';
import type { RevenueCan, RevenueControls } from '../../pages/RevenuePage';
import { AXIS, GRID, SERVICE_COLORS } from '../aito/stats/palette';
import { Legend, LegendList, Panel } from '../aito/stats/primitives';
import { CHART_TOOLTIP_STYLE } from '../stats/chartTheme';
import { focusRingCls } from '../formStyles';
import { RevenueNotes } from './RevenueNotes';
import { RevenueSegmented } from './RevenueSegmented';
import { drillDown } from './lib/analysis';
import { effectiveStack } from './lib/basket';
import { chartSeries, cumulativeScale, niceTicks, OTHER_SERIES, STACK_DIMENSIONS, stackColumns, yFor, type StackDimension, type StackedColumn, type StackSeries } from './lib/chart';
import { compactAxis, formatFcp } from './lib/format';
import type { AnnotationsResponse, RevenueAnnotation, RevenueResponse } from './lib/types';
import { useRevenueResource } from './useRevenueResource';

const COLORS = Object.values(SERVICE_COLORS);
const OTHER_COLOR = '#6b6b6b';
const LINE_COLOR = '#ffffff';
const TARGET_COLOR = '#f59e0b';
const NOTE_COLOR = '#a0a0a0';
const FOCUS_COLOR = '#00ae42';
const HEIGHT = 300;
const SEGMENT_KEY: Record<string, string> = { Pro: 'pro', Particuliers: 'particulier', Passage: 'passage', 'Non identifié': 'inconnu' };

/** Colours belong to the series: a key keeps its colour while it is free, so a series a filter empties repaints nothing. */
function stickyColors(prev: Record<string, number>, series: StackSeries[]): Record<string, number> {
  const named = series.filter((s) => s.key !== OTHER_SERIES);
  const taken = new Set<number>();
  const needs: StackSeries[] = [];
  for (const s of named) {
    const c = prev[s.key];
    if (c !== undefined && !taken.has(c)) taken.add(c);
    else needs.push(s);
  }
  if (needs.length === 0) return prev;
  const out = { ...prev };
  for (const s of needs) {
    const c = COLORS.findIndex((_, i) => !taken.has(i));
    taken.add(c);
    out[s.key] = c;
  }
  return out;
}

interface Row {
  i: number;
  label: string;
  cumulative: number;
  ghost: number;
  partial: boolean;
  [series: `s${number}`]: number;
}

/** Targets, note diamonds, « ! » markers and the focusable columns, laid over the plot (recharts 3 gives custom children the plot area, not the scales). */
function ColumnMarks(p: {
  columns: StackedColumn[];
  yMin: number;
  yMax: number;
  targets: (number | null)[];
  notes: RevenueAnnotation[][];
  label: (i: number) => string;
  missingLabel: (n: number) => string;
  noteLabel: (notes: RevenueAnnotation[]) => string;
  onDrill?: (index: number) => void;
}) {
  const area = usePlotArea();
  const [focused, setFocused] = useState<number | null>(null);
  if (!area || p.columns.length === 0) return null;
  const band = area.width / p.columns.length;
  const y = (v: number) => yFor(v, p.yMin, p.yMax, area.y, area.height);
  return (
    <g>
      {p.columns.map((c, i) => {
        const x0 = area.x + i * band;
        const mid = x0 + band / 2;
        const target = p.targets[i];
        const drill = p.onDrill;
        return (
          <g key={c.key}
            {...(drill
              ? {
                  role: 'button',
                  tabIndex: 0,
                  'aria-label': p.label(i),
                  onClick: () => drill(i),
                  onKeyDown: (e: React.KeyboardEvent) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    drill(i);
                  },
                  onFocus: () => setFocused(i),
                  onBlur: () => setFocused(null),
                  className: 'cursor-pointer outline-none',
                }
              : {})}>
            <rect x={x0} y={area.y} width={band} height={area.height} fill="transparent" />
            {focused === i && <rect x={x0 + 1} y={area.y} width={band - 2} height={area.height} fill="none" stroke={FOCUS_COLOR} strokeWidth={2} rx={4} />}
            {target != null && (
              <line data-target x1={x0 + band * 0.15} x2={x0 + band * 0.85} y1={y(target)} y2={y(target)} stroke={TARGET_COLOR} strokeWidth={2} strokeLinecap="round" />
            )}
            {p.notes[i].length > 0 && (
              <rect data-note x={mid - 4} y={area.y - 14} width={8} height={8} fill={NOTE_COLOR} transform={`rotate(45 ${mid} ${area.y - 10})`}>
                <title>{p.noteLabel(p.notes[i])}</title>
              </rect>
            )}
            {c.missingDays > 0 && (
              <g>
                <title>{p.missingLabel(c.missingDays)}</title>
                <text x={mid} y={area.y + 10} textAnchor="middle" fill="#fbbf24" fontSize={11} fontWeight={700}>!</text>
              </g>
            )}
          </g>
        );
      })}
    </g>
  );
}

/** The ghost of the in-progress column: from the top of its stack up to the projection, outlined only. */
function GhostShape(props: { x?: number; y?: number; width?: number; height?: number }) {
  const { x = 0, y = 0, width = 0, height = 0 } = props;
  if (height <= 0) return null;
  return <rect data-ghost x={x + 0.5} y={y} width={Math.max(0, width - 1)} height={Math.max(0, height - 2)} fill="none" stroke="#808080" strokeDasharray="4 3" rx={3} />;
}

/** Évolution's centrepiece: one stacked column per bucket, the running total on its own axis, the projection, the targets and the notes. */
export function RevenueChart({ payload, controls, can, onStack, onDrill, drillDepth, onBack, today }: {
  payload: RevenueResponse;
  /** The page's active controls. */
  controls: RevenueControls;
  can: RevenueCan;
  onStack: (stack: StackDimension) => void;
  /** Clicking a column (or Enter on it); absent = there is no finer level. */
  onDrill?: (index: number) => void;
  drillDepth: number;
  onBack: () => void;
  today: string;
}) {
  const { t } = useTranslation();
  const { buckets, granularity } = payload;
  const { taxMode } = controls;
  const narrowed = controls.basket.length + controls.brands.size > 0;
  const kindFiltered = controls.kind !== null;
  const segmentFiltered = controls.segment !== null;
  const stack: StackDimension = !can.customers && controls.stack === 'segment' ? 'nature' : effectiveStack(narrowed ? 1 : 0, controls.stack, kindFiltered, segmentFiltered);
  const stackOptions = STACK_DIMENSIONS.filter(
    (d) => (d.id !== 'item' || narrowed) && (d.id !== 'kind' || !kindFiltered) && (d.id !== 'segment' || (!segmentFiltered && can.customers)),
  ).map((d) => ({ id: d.id, label: t(`revenue.chart.stack.${d.id}`) }));

  const notes = useRevenueResource<AnnotationsResponse>('/api/v1/revenue/annotations', 0);
  const annotations = notes.data?.annotations ?? [];

  const series = chartSeries(buckets, stack);
  const columns = stackColumns(buckets, series, stack, taxMode);
  const [palette, setPalette] = useState<{ stack: StackDimension; byKey: Record<string, number> }>({ stack, byKey: {} });
  const prevColors = palette.stack === stack ? palette.byKey : {};
  const byKey = stickyColors(prevColors, series);
  if (palette.stack !== stack || byKey !== palette.byKey) setPalette({ stack, byKey });
  const colorOf = (s: StackSeries) => (s.key === OTHER_SERIES ? OTHER_COLOR : COLORS[byKey[s.key]] ?? OTHER_COLOR);
  const nameOf = (s: StackSeries) => {
    if (s.key === OTHER_SERIES) return t('revenue.chart.other');
    if (stack === 'kind') return t(s.key === 'Biens' ? 'revenue.filters.goods' : 'revenue.filters.services');
    if (stack === 'segment' && SEGMENT_KEY[s.key]) return t(`revenue.filters.segments.${SEGMENT_KEY[s.key]}`);
    return s.label;
  };

  const projectionOf = (i: number) => {
    const p = buckets[i].projection;
    return p ? (taxMode === 'ttc' ? p.ttc : p.ht) : null;
  };
  // A target is an HT figure.
  const targets = buckets.map((b) => (taxMode === 'ht' ? (b.target ?? null) : null));
  const notesOf = buckets.map((b) => annotations.filter((a) => a.day >= b.start && a.day <= b.end));

  const rows: Row[] = columns.map((c, i) => {
    const up = c.segments.reduce((a, s) => a + Math.max(0, s.value), 0);
    const proj = projectionOf(i);
    const row: Row = { i, label: c.label, cumulative: c.cumulative, partial: c.partial, ghost: proj != null && proj > Math.max(0, c.total, up) ? proj - up : 0 };
    c.segments.forEach((seg, j) => {
      row[`s${series[j].slot}`] = seg.value;
    });
    return row;
  });

  // The extent follows the segments, the projection and the targets, so none is clipped.
  const maxUp = Math.max(0, ...buckets.map((_, i) => Math.max(projectionOf(i) ?? 0, targets[i] ?? 0)), ...columns.map((c) => Math.max(0, ...c.segments.map((s) => s.to))));
  const maxDown = Math.min(0, ...columns.map((c) => Math.min(0, ...c.segments.map((s) => s.to))));
  const ticks = niceTicks(maxUp);
  const yMax = ticks[ticks.length - 1];
  const yMin = maxDown < 0 ? -niceTicks(-maxDown).slice(-1)[0] : 0;
  const cum = cumulativeScale(columns);

  const mode = t(`revenue.${taxMode}`);
  const chartLabel = t('revenue.chart.label', { mode, stack: t(`revenue.chart.stack.${stack}`) });
  const columnLabel = (i: number) => {
    const c = columns[i];
    return c.missingDays > 0
      ? t('revenue.chart.columnMissing', { label: c.label, total: formatFcp(c.total), n: c.missingDays })
      : t('revenue.chart.column', { label: c.label, total: formatFcp(c.total) });
  };
  const finer = buckets.length > 0 ? drillDown(buckets[0], granularity)?.granularity : undefined;

  const tooltip = ({ active, payload: items }: { active?: boolean; payload?: readonly { payload?: Row }[] }) => {
    const row = active ? items?.[0]?.payload : undefined;
    if (!row) return null;
    const c = columns[row.i];
    const proj = projectionOf(row.i);
    const target = targets[row.i];
    return (
      <div style={CHART_TOOLTIP_STYLE} className="w-56 px-3 py-2 text-xs text-bambu-gray-light">
        <p className="font-medium text-white">{c.label}{c.partial ? ` · ${t('revenue.chart.inProgress')}` : ''}</p>
        <p className="tabular-nums text-white">{formatFcp(c.total)}</p>
        {c.missingDays > 0 && <p className="text-amber-400">{t('revenue.chart.missingDays', { n: c.missingDays })}</p>}
        {c.segments.map((seg, j) => seg.value !== 0 && (
          <p key={seg.key} className="flex justify-between gap-4"><span className="truncate">{nameOf(series[j])}</span><span className="tabular-nums">{formatFcp(seg.value)}</span></p>
        ))}
        <p className="tabular-nums">{t('revenue.chart.cumulative')} {formatFcp(c.cumulative)}</p>
        {proj != null && <p className="tabular-nums">{t('revenue.chart.projection')} {formatFcp(proj)}</p>}
        {target != null && <p className="tabular-nums" style={{ color: TARGET_COLOR }}>{t('revenue.chart.target')} {formatFcp(target)}</p>}
        {notesOf[row.i].map((n) => (
          <p key={n.id} className="mt-1 truncate" title={n.label}>◆ {n.day.slice(8)}/{n.day.slice(5, 7)} · {n.label}</p>
        ))}
        {onDrill && finer && <p className="mt-1 border-t border-bambu-dark-tertiary pt-1 text-bambu-gray">{t(`revenue.chart.drillHint.${finer}`)}</p>}
      </div>
    );
  };

  return (
    <Panel
      testId="revenue-chart"
      title={
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xs uppercase tracking-wide text-bambu-gray">{t(`revenue.chart.title.${granularity}`)}</p>
          {drillDepth > 0 && (
            <button type="button" onClick={onBack} className={`rounded text-sm text-bambu-green hover:text-white ${focusRingCls}`}>
              {drillDepth > 1 ? t('revenue.chart.backLevels', { n: drillDepth }) : t('revenue.chart.back')}
            </button>
          )}
        </div>
      }
      action={
        <div className="flex flex-wrap items-center gap-3">
          <LegendList label={t('revenue.chart.legend')}>
            {series.map((s) => (
              <Legend key={s.key} color={colorOf(s)}>{nameOf(s)}</Legend>
            ))}
            <Legend color={LINE_COLOR} line>{t('revenue.chart.cumulative')}</Legend>
          </LegendList>
          <RevenueSegmented inPanel label={t('revenue.chart.stackBy')} value={stack} onChange={onStack} options={stackOptions} />
          <RevenueNotes annotations={annotations} onChanged={notes.reload} today={today} canManage={can.notes} />
        </div>
      }
    >
      {/* A group, not an img: an image's children are presentational and the column buttons would go silent. */}
      <div role="group" aria-label={chartLabel} aria-roledescription={t('revenue.chart.roleDescription')}>
        <ResponsiveContainer width="100%" height={HEIGHT}>
          <ComposedChart data={rows} stackOffset="sign" accessibilityLayer={false} margin={{ top: 20, right: 0, left: -4, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="label" stroke={AXIS} tickLine={false} axisLine={{ stroke: GRID }} tick={{ fontSize: 11 }}
              tickFormatter={(l: string) => (l.length > 14 ? `${l.slice(0, 13)}…` : l)} />
            <YAxis yAxisId="left" stroke={AXIS} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} width={52}
              domain={[yMin, yMax]} ticks={yMin < 0 ? [yMin, ...ticks] : ticks} tickFormatter={compactAxis} />
            <YAxis yAxisId="cum" orientation="right" stroke={AXIS} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} width={52}
              domain={[cum.min, cum.max]} ticks={cum.min < 0 ? [cum.min, 0, cum.max] : [0, cum.max]} tickFormatter={compactAxis} />
            <Tooltip content={tooltip} cursor={{ fill: 'rgba(255,255,255,0.04)' }} animationDuration={120} />
            {series.map((s) => (
              <Bar key={s.key} yAxisId="left" dataKey={`s${s.slot}`} stackId="revenue" fill={colorOf(s)} isAnimationActive={false}>
                {rows.map((r) => <Cell key={r.i} fillOpacity={r.partial ? 0.6 : 1} />)}
              </Bar>
            ))}
            <Bar yAxisId="left" dataKey="ghost" stackId="revenue" shape={GhostShape} isAnimationActive={false} />
            <Line yAxisId="cum" dataKey="cumulative" stroke={LINE_COLOR} strokeOpacity={0.7} strokeWidth={2} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
            <ColumnMarks columns={columns} yMin={yMin} yMax={yMax} targets={targets} notes={notesOf} label={columnLabel}
              missingLabel={(n) => t('revenue.chart.missingDays', { n })}
              noteLabel={(ns) => t('revenue.chart.note', { label: ns.map((n) => n.label).join(' · ') })}
              onDrill={onDrill} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <ul className="sr-only" aria-label={t('revenue.chart.values')}>
        {columns.map((c, i) => <li key={c.key}>{columnLabel(i)}</li>)}
      </ul>
      <p className="mt-1 text-[11px] text-bambu-gray">{onDrill ? `${t('revenue.chart.hintDrill')} · ${t('revenue.chart.hint')}` : t('revenue.chart.hint')}</p>
    </Panel>
  );
}
