import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, BarChart3, Loader2 } from 'lucide-react';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, type AitoStats, type AitoStatsDay } from '../../api/client';
import { Button } from '../Button';
import { TimeframeSelector } from '../stats/TimeframeSelector';
import { useTimeframe } from '../stats/timeframe';
import { CHART_TOOLTIP_STYLE } from '../stats/chartTheme';
import { DeltaBadge } from '../stats/DeltaBadge';
import { computeDelta, type StatDelta } from '../stats/deltas';
import { COLUMNS } from './columns';
import { formatMoney } from '../../utils/pricing';
import { useCurrency } from '../../hooks/useCurrency';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { localDateKey, parseLocalDateKey } from '../../utils/date';

/** The three series, in the order they happen to a project. Validated as a
 *  categorical trio on the dark surface (OKLCH band, chroma, CVD pairs,
 *  contrast) — swap one and re-run the palette validator, not your eyes. The
 *  colours belong to the ENTITY: a filter that empties a series must not
 *  repaint the others. */
const SERIES = { created: '#3d86e8', accepted: '#c95aa0', done: '#219653' } as const;
const GRID = '#2d2d2d';
const AXIS = '#808080';
const TOOLTIP_ORDER = ['created', 'accepted', 'done', 'done7'];
/** Past this many days the bars turn to hairlines, so the chart folds the
 *  days into Monday-start weeks instead. A phone runs out of pixels sooner. */
const WEEKLY_ABOVE_DAYS = 45;
const WEEKLY_ABOVE_DAYS_NARROW = 31;

type ChartRow = AitoStatsDay & { label: string; done7?: number };

/** The board's statistics view: how much work comes in, how much goes out,
 *  and how long it takes — the questions the board itself cannot answer
 *  because it only shows now. Same endpoint as the Stats page's pipeline
 *  widget, sliced by the same timeframe selector. */
export function StatsView() {
  const { t, i18n } = useTranslation();
  const currency = useCurrency();
  const { timeframe, setTimeframe, range } = useTimeframe('bambuddy-aito-stats-timeframe', 'last-30');
  const query = useQuery({
    queryKey: ['aitoStats', range.dateFrom, range.dateTo],
    queryFn: () => api.getAitoStats(range),
  });
  const data = query.data;
  const narrow = useMediaQuery('(max-width: 639px)', () => typeof window !== 'undefined' && window.innerWidth < 640);

  const { rows, weekly } = useMemo(() => {
    const daily = data?.daily ?? [];
    const fmt = new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'short' });
    if (daily.length > (narrow ? WEEKLY_ABOVE_DAYS_NARROW : WEEKLY_ABOVE_DAYS)) {
      const buckets = new Map<string, ChartRow>();
      for (const d of daily) {
        const date = parseLocalDateKey(d.day);
        const start = new Date(date);
        start.setDate(date.getDate() - ((date.getDay() + 6) % 7));
        const key = localDateKey(start);
        const b = buckets.get(key) ?? { day: key, created: 0, accepted: 0, done: 0, label: fmt.format(start) };
        b.created += d.created;
        b.accepted += d.accepted;
        b.done += d.done;
        buckets.set(key, b);
      }
      return { rows: [...buckets.values()], weekly: true };
    }
    const rows: ChartRow[] = daily.map((d, i) => {
      const window = daily.slice(Math.max(0, i - 6), i + 1);
      const done7 = window.reduce((s, r) => s + r.done, 0) / window.length;
      return { ...d, label: fmt.format(parseLocalDateKey(d.day)), done7: Math.round(done7 * 100) / 100 };
    });
    return { rows, weekly: false };
  }, [data, i18n.language, narrow]);

  return (
    <section data-testid="aito-stats-view" className="animate-rise space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-bambu-gray-light">
          {data?.throughput
            ? t('aito.stats.caption', {
                active: data.throughput.active,
                done: data.board.find((b) => b.column === 'done')?.count ?? 0,
              })
            : ' '}
        </p>
        <TimeframeSelector timeframe={timeframe} onChange={setTimeframe} />
      </div>

      {query.isPending ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-8 h-8 text-bambu-gray animate-spin" />
        </div>
      ) : query.isError || !data ? (
        <div className="text-center py-12">
          <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
          <p className="text-white font-medium">{t('common.errorLoading')}</p>
          <Button variant="secondary" onClick={() => query.refetch()} className="mt-4 mx-auto">
            {t('common.retry')}
          </Button>
        </div>
      ) : !data.throughput ? (
        <Empty>{t('aito.stats.empty')}</Empty>
      ) : (
        <Body data={data} rows={rows} weekly={weekly} currency={currency} />
      )}
    </section>
  );
}

function Body({ data, rows, weekly, currency }: { data: AitoStats; rows: ChartRow[]; weekly: boolean; currency: string }) {
  const { t } = useTranslation();
  const tp = data.throughput!;
  const prev = data.previous ?? null;
  const money = (v: number) => formatMoney(v, currency);
  const days = (v: number | null) => (v === null ? '—' : t('aito.stats.daysShort', { days: v.toFixed(1) }));
  const active = rows.some((r) => r.created + r.accepted + r.done > 0);

  const sent = data.conversion.sent.count;
  const pctOfSent = sent > 0 ? Math.round((tp.accepted / sent) * 100) : null;
  const pctOfAccepted = tp.accepted > 0 ? Math.round((tp.done / tp.accepted) * 100) : null;

  const quoted = data.conversion.accepted.total;
  const invoiced = data.invoicing.invoiced_total;
  const outstanding = data.invoicing.outstanding_balance;
  const showMoney = quoted + invoiced + outstanding > 0;

  const previousTitle = (value: number | string | null | undefined) =>
    value === null || value === undefined ? undefined : t('aito.stats.vsPrevious', { value });

  return (
    <>
      <div data-testid="aito-stats-kpis" className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Tile
          label={t('aito.stats.added')}
          value={String(tp.created)}
          accent={SERIES.created}
          delta={computeDelta(tp.created, prev?.created, 'more-is-good')}
          deltaTitle={previousTitle(prev?.created)}
        />
        <Tile
          label={t('aito.stats.accepted')}
          value={String(tp.accepted)}
          accent={SERIES.accepted}
          delta={computeDelta(tp.accepted, prev?.accepted, 'more-is-good')}
          deltaTitle={previousTitle(prev?.accepted)}
        />
        <Tile
          label={t('aito.stats.completed')}
          value={String(tp.done)}
          accent={SERIES.done}
          delta={computeDelta(tp.done, prev?.done, 'more-is-good')}
          deltaTitle={previousTitle(prev?.done)}
        />
        <Tile
          label={t('aito.stats.perDay')}
          value={tp.per_day === null ? '—' : tp.per_day.toFixed(tp.per_day < 1 ? 2 : 1)}
          sub={tp.per_day === null ? undefined : t('aito.stats.perWeek', { count: Math.round(tp.per_day * 7 * 10) / 10 })}
        />
        <Tile
          label={t('aito.stats.leadTime')}
          value={days(tp.lead_days)}
          sub={tp.lead_days_median === null ? undefined : t('aito.stats.median', { days: tp.lead_days_median.toFixed(1) })}
          delta={computeDelta(tp.lead_days ?? 0, prev?.lead_days, 'more-is-bad')}
          deltaTitle={previousTitle(prev?.lead_days === null || prev?.lead_days === undefined ? null : days(prev.lead_days))}
        />
        <Tile label={t('aito.stats.productionTime')} value={days(tp.production_days)} />
      </div>

      <section data-testid="aito-stats-activity" className="rounded-xl bg-bambu-dark-secondary p-4 space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <Heading>{t('aito.stats.activity')}</Heading>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-bambu-gray-light">
            <Legend color={SERIES.created}>{t('aito.stats.added')}</Legend>
            <Legend color={SERIES.accepted}>{t('aito.stats.accepted')}</Legend>
            <Legend color={SERIES.done}>{t('aito.stats.completed')}</Legend>
            {!weekly && (
              <Legend color={SERIES.done} line>
                {t('aito.stats.rolling7')}
              </Legend>
            )}
          </ul>
        </div>
        {active ? (
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart data={rows} barGap={2} barCategoryGap="25%" margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={GRID} />
              <XAxis dataKey="label" stroke={AXIS} tickLine={false} axisLine={{ stroke: GRID }} tick={{ fontSize: 11 }} minTickGap={28} />
              <YAxis stroke={AXIS} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip
                cursor={{ stroke: GRID, fill: 'rgba(255,255,255,0.04)' }}
                contentStyle={CHART_TOOLTIP_STYLE}
                labelStyle={{ color: '#fff' }}
                itemStyle={{ color: '#a0a0a0' }}
                separator=": "
                itemSorter={(item) => TOOLTIP_ORDER.indexOf(String(item.dataKey))}
                labelFormatter={(label) => (weekly ? t('aito.stats.weekOf', { date: label }) : String(label))}
                formatter={(value: number | undefined, name: string | undefined) => [
                  String(value ?? 0),
                  name === 'created'
                    ? t('aito.stats.added')
                    : name === 'accepted'
                      ? t('aito.stats.accepted')
                      : name === 'done'
                        ? t('aito.stats.completed')
                        : t('aito.stats.rolling7'),
                ]}
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
      </section>

      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <section data-testid="aito-stats-flow" className="rounded-xl bg-bambu-dark-secondary p-4 space-y-3">
          <Heading>{t('aito.stats.flow')}</Heading>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            {data.stage_days.map((s) => {
              const meta = COLUMNS.find((c) => c.id === s.column);
              return (
                <div
                  key={s.column}
                  title={t('stats.pipelineSample', { count: s.sample })}
                  className="rounded-lg bg-bambu-dark px-2 py-2 text-center"
                >
                  <div className="flex items-center justify-center gap-1.5 text-[11px] text-bambu-gray min-w-0">
                    <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${meta?.dot ?? 'bg-bambu-gray'}`} aria-hidden="true" />
                    <span className="truncate">{meta ? t(meta.labelKey) : s.column}</span>
                  </div>
                  <div className="text-sm font-medium text-white">{days(s.median_days)}</div>
                </div>
              );
            })}
          </div>
        </section>

        <section data-testid="aito-stats-funnel" className="rounded-xl bg-bambu-dark-secondary p-4 space-y-3">
          <Heading>{t('aito.stats.funnel')}</Heading>
          <ol className="flex items-stretch gap-2">
            <Step label={t('aito.stats.sent')} value={sent} />
            <Step
              label={t('aito.stats.accepted')}
              value={tp.accepted}
              rate={pctOfSent === null ? undefined : t('aito.stats.ofSent', { pct: pctOfSent })}
              accent={SERIES.accepted}
            />
            <Step
              label={t('aito.stats.completed')}
              value={tp.done}
              rate={pctOfAccepted === null ? undefined : t('aito.stats.ofAccepted', { pct: pctOfAccepted })}
              accent={SERIES.done}
            />
          </ol>
        </section>
      </div>

      {showMoney && (
        <section data-testid="aito-stats-money" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Tile label={t('aito.stats.quoted')} value={money(quoted)} small />
          <Tile label={t('aito.stats.invoiced')} value={money(invoiced)} small />
          <Tile label={t('aito.stats.outstanding')} value={money(outstanding)} small />
        </section>
      )}
    </>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <h3 className="text-sm font-semibold text-white">{children}</h3>;
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      <BarChart3 className="w-8 h-8 text-bambu-gray" aria-hidden="true" />
      <p className="text-sm text-bambu-gray">{children}</p>
    </div>
  );
}

function Legend({ color, line, children }: { color: string; line?: boolean; children: ReactNode }) {
  return (
    <li className="inline-flex items-center gap-1.5">
      {line ? (
        <span
          aria-hidden="true"
          className="inline-block h-0 w-4 border-t-2 border-dashed"
          style={{ borderColor: color }}
        />
      ) : (
        <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      )}
      {children}
    </li>
  );
}

/** One figure. `accent` draws a 2px hairline in the series colour under the
 *  label so the tile and its bars read as the same thing; text stays in text
 *  tokens. Values are proportional figures on purpose — tabular digits look
 *  loose at this size and nothing here aligns vertically. */
function Tile({
  label,
  value,
  sub,
  delta,
  deltaTitle,
  accent,
  small,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: StatDelta | null;
  deltaTitle?: string;
  accent?: string;
  small?: boolean;
}) {
  return (
    <div className="rounded-xl bg-bambu-dark-secondary px-3 py-2.5 min-w-0">
      <div className="flex items-center gap-2 text-xs text-bambu-gray">
        {accent && <span aria-hidden="true" className="inline-block h-0.5 w-3 rounded-full" style={{ backgroundColor: accent }} />}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className={`${small ? 'text-base' : 'text-2xl'} font-semibold text-white truncate`}>{value}</span>
        {delta !== undefined && <DeltaBadge delta={delta} title={deltaTitle} />}
      </div>
      {sub && <div className="text-xs text-bambu-gray-light truncate">{sub}</div>}
    </div>
  );
}

function Step({ label, value, rate, accent }: { label: string; value: number; rate?: string; accent?: string }) {
  return (
    <li className="flex-1 min-w-0 rounded-lg bg-bambu-dark px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] text-bambu-gray truncate">
        {accent && <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: accent }} />}
        {label}
      </div>
      <div className="text-lg font-semibold text-white">{value}</div>
      <div className="text-[11px] text-bambu-gray-light">{rate ?? ' '}</div>
    </li>
  );
}
