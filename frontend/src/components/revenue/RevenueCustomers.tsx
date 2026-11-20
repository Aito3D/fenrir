import { useTranslation } from 'react-i18next';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AXIS, GRID, SERIES } from '../aito/stats/palette';
import { Legend, LegendList, Panel, Split, Tile } from '../aito/stats/primitives';
import { CHART_TOOLTIP_STYLE } from '../stats/chartTheme';
import { focusRingCls } from '../formStyles';
import { Skeleton } from '../Skeleton';
import { RevenueSegmented } from './RevenueSegmented';
import { REVENUE_HISTORY_START } from './lib/dates';
import { compactAxis, formatFcp } from './lib/format';
import type { CustomerSegment, CustomersResponse, RetentionRow, RevenueGranularity, SegmentRow, TaxMode } from './lib/types';
import { useRevenueResource } from './useRevenueResource';

const CUSTOMER_SEGMENTS: readonly CustomerSegment[] = ['pro', 'particulier', 'passage', 'inconnu'];
// loki's validated segment palette; « Non identifié » in the neutral grey.
const SEGMENT_COLOR: Record<CustomerSegment, string> = { pro: '#3987e5', particulier: '#d95926', passage: '#199e70', inconnu: '#6b6f85' };
const FROM_KEY: Record<CustomerSegment, string> = { pro: 'fromPro', particulier: 'fromParticulier', passage: 'fromPassage', inconnu: 'fromInconnu' };
const PICKABLE = ['all', 'pro', 'particulier', 'passage'] as const;

const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const figures = (s: SegmentRow, mode: TaxMode) =>
  mode === 'ttc' ? { goods: s.goodsTtc, services: s.servicesTtc, total: s.ttc } : { goods: s.goods, services: s.services, total: s.ht };

function Dot({ segment }: { segment: CustomerSegment }) {
  return <span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: SEGMENT_COLOR[segment] }} />;
}

/** One 100 % bar for a kind, split by segment, with its plain-language takeaway. */
function KindBar({ label, values }: { label: string; values: { segment: CustomerSegment; value: number }[] }) {
  const { t } = useTranslation();
  const positive = values.map((v) => ({ ...v, value: Math.max(0, v.value) }));
  const total = positive.reduce((a, v) => a + v.value, 0);
  const top = [...positive].sort((a, b) => b.value - a.value)[0];
  const name = (s: CustomerSegment) => t(`revenue.filters.segments.${s}`);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-3 rounded-lg bg-bambu-dark px-3 py-2 text-xs">
        <span className="w-24 shrink-0 truncate text-bambu-gray-light">{label}</span>
        <span role="img" aria-label={t('revenue.customers.byType', { label, total: formatFcp(total) })} className="flex h-2 min-w-0 flex-1 gap-[2px]">
          {positive.filter((v) => v.value > 0).map((v) => (
            <span key={v.segment} className="block h-full min-w-[3px] rounded-[2px]" style={{ flexGrow: v.value, backgroundColor: SEGMENT_COLOR[v.segment] }} />
          ))}
        </span>
        <span className="shrink-0 text-right tabular-nums text-bambu-gray-light">{formatFcp(total)}</span>
      </div>
      <LegendList>
        {positive.map((v) => (
          <Legend key={v.segment} color={SEGMENT_COLOR[v.segment]}>
            {name(v.segment)} <span className="tabular-nums">{share(v.value, total)} %</span>
          </Legend>
        ))}
      </LegendList>
      <p className="text-xs text-bambu-gray-light">
        {total > 0 && top ? t(`revenue.customers.${FROM_KEY[top.segment]}`, { label, pct: share(top.value, total) }) : t('revenue.customers.noSales', { label })}
      </p>
    </div>
  );
}

const SIDES = ['new', 'returning', 'anon'] as const;
type Side = (typeof SIDES)[number];
const SIDE_COLOR: Record<Side, string> = { new: SERIES.created, returning: SERIES.done, anon: SEGMENT_COLOR.inconnu };

/** « Nouveaux et fidèles »: each period's sales stacked by first-time buyers, earlier buyers and unidentified sales. */
function RetentionChart({ rows, mode }: { rows: RetentionRow[]; mode: TaxMode }) {
  const { t } = useTranslation();
  const name = (s: Side) => t(`revenue.customers.retention.${s}`);
  const data = rows.map((r) => ({ row: r, label: r.label, ...Object.fromEntries(SIDES.map((s) => [s, mode === 'ttc' ? r[`${s}Ttc`] : r[`${s}Ht`]])) }));
  return (
    <Panel
      title={t('revenue.customers.retention.title')}
      action={
        <LegendList label={t('revenue.chart.legend')}>
          {SIDES.map((s) => <Legend key={s} color={SIDE_COLOR[s]}>{name(s)}</Legend>)}
        </LegendList>
      }
    >
      <div role="img" aria-label={t('revenue.customers.retention.chart', { tax: t(`revenue.${mode}`) })}>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data} stackOffset="sign" accessibilityLayer={false} margin={{ top: 8, right: 8, left: -4, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="label" stroke={AXIS} tickLine={false} axisLine={{ stroke: GRID }} tick={{ fontSize: 11 }} interval="preserveStartEnd" />
            <YAxis stroke={AXIS} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} tickFormatter={compactAxis} width={52} />
            <Tooltip
              contentStyle={CHART_TOOLTIP_STYLE}
              animationDuration={120}
              labelStyle={{ color: '#fff' }}
              itemStyle={{ color: '#a0a0a0' }}
              separator=": "
              formatter={(value: number | undefined, key: string | undefined, item: { payload?: { row: RetentionRow } }) => {
                const side = key as Side;
                const amount = formatFcp(value ?? 0);
                const row = item.payload?.row;
                return [side === 'anon' || !row ? amount : t('revenue.customers.retention.withCount', { amount, n: row[`${side}Count`] }), name(side)];
              }}
            />
            {SIDES.map((s) => <Bar key={s} dataKey={s} stackId="r" fill={SIDE_COLOR[s]} isAnimationActive={false} />)}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-2 text-xs text-bambu-gray">{t('revenue.customers.retention.note')}</p>
    </Panel>
  );
}

/** « Clients »: acquisition, the per-segment split (a row toggles the page segment filter) and the best customers. */
export function RevenueCustomers(p: {
  from: string;
  to: string;
  granularity: RevenueGranularity;
  filterParams: string;
  taxMode: TaxMode;
  segment: CustomerSegment | null;
  onSegment: (s: CustomerSegment | null) => void;
  version: unknown;
}) {
  const { t, i18n } = useTranslation();
  const url = p.from && p.to ? `/api/v1/revenue/customers?from=${p.from}&to=${p.to}&granularity=${p.granularity}${p.filterParams}` : null;
  const { data, error } = useRevenueResource<CustomersResponse>(url, p.version);
  const mode = p.taxMode;
  const segName = (s: CustomerSegment) => t(`revenue.filters.segments.${s}`);

  const picker = (
    <div>
      <RevenueSegmented
        label={t('revenue.filters.segment')}
        value={p.segment ?? 'all'}
        onChange={(v) => p.onSegment(v === 'all' ? null : v)}
        options={PICKABLE.map((id) => ({ id, label: t(`revenue.filters.segments.${id}`) }))}
      />
    </div>
  );

  if (error && !data) {
    return (
      <>
        {picker}
        <Panel><p role="alert" className="text-sm text-status-error">{error}</p></Panel>
      </>
    );
  }
  if (!data) {
    return (
      <>
        {picker}
        <Panel><Skeleton className="h-40 w-full" /></Panel>
      </>
    );
  }

  const rows = CUSTOMER_SEGMENTS.map((seg) => data.segments.find((s) => s.segment === seg)).filter((s): s is SegmentRow => !!s);
  const grand = rows.reduce((a, s) => a + figures(s, mode).total, 0);
  const pick = (m: { ht: number; ttc: number }) => (mode === 'ttc' ? m.ttc : m.ht);
  const topValue = Math.max(0, ...data.customers.map(pick));
  const acq = data.acquisition;
  // A range opening on the first cached day has no « before »: every customer would read new.
  const acqBlind = data.from <= REVENUE_HISTORY_START;
  const date = new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const toggle = (s: CustomerSegment) => p.onSegment(p.segment === s ? null : s);

  return (
    <>
      {picker}
      {acqBlind ? (
        <p className="text-xs text-bambu-gray">{t('revenue.customers.blind')}</p>
      ) : (
        <Panel>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <Tile label={t('revenue.customers.newCustomers')} value={String(acq.newCount)} hint={t('revenue.customers.newHint', { amount: formatFcp(acq.newHt) })} />
            <Tile label={t('revenue.customers.returning')} value={String(acq.returningCount)} hint={t('revenue.customers.returningHint', { amount: formatFcp(acq.returningHt) })} />
            <Tile label={t('revenue.customers.newShare')} value={`${share(acq.newHt, acq.newHt + acq.returningHt)} %`} hint={t('revenue.customers.newShareHint')} />
            <Tile label={t('revenue.customers.avgBasket')} value={acq.avgBasketHt == null ? '—' : formatFcp(acq.avgBasketHt)} hint={t('revenue.customers.avgBasketHint', { n: acq.customerDays })} />
          </div>
        </Panel>
      )}
      <RetentionChart rows={data.retention} mode={mode} />
      <Split>
        <Panel
          title={t('revenue.customers.topTitle')}
          action={
            <span className="text-xs tabular-nums text-bambu-gray">
              <span className="mr-2 text-bambu-gray-light">{t(`revenue.table.${mode}`)}</span>
              {t('revenue.customers.total', { n: data.customerCount })}
              {data.customerCount > data.customers.length ? ` · ${t('revenue.customers.shown', { n: data.customers.length })}` : ''}
            </span>
          }
        >
          {data.customers.length === 0 ? (
            <p className="rounded-lg bg-bambu-dark px-3 py-2 text-sm text-bambu-gray">{t('revenue.customers.empty')}</p>
          ) : (
            <ol aria-label={t('revenue.customers.topTitle')} className="grid gap-1.5 text-xs">
              {data.customers.map((c) => (
                <li key={c.customerId} className="rounded-lg bg-bambu-dark px-3 py-2">
                  <div className="flex items-center gap-3">
                    <span className="flex min-w-0 flex-1 items-center gap-2 sm:w-56 sm:flex-none sm:shrink-0">
                      <span className="truncate text-white" title={c.name}>{c.name}</span>
                      <span className="inline-flex shrink-0 items-center gap-1 text-bambu-gray"><Dot segment={c.segment} />{segName(c.segment)}</span>
                    </span>
                    <span className="hidden min-w-0 flex-1 sm:block" aria-hidden="true">
                      {pick(c) > 0 && topValue > 0 && (
                        <span data-bar className="block h-2 min-w-[3px] rounded-[2px]" style={{ width: `${(pick(c) / topValue) * 100}%`, backgroundColor: SEGMENT_COLOR[c.segment] }} />
                      )}
                    </span>
                    <span className="shrink-0 text-right tabular-nums text-bambu-gray-light">{`${formatFcp(pick(c))} · ${share(pick(c), grand)} %`}</span>
                  </div>
                  <p className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] tabular-nums text-bambu-gray">
                    {t('revenue.customers.customerDetail', {
                      goods: formatFcp(c.goods),
                      services: formatFcp(c.services),
                      days: c.activeDays,
                      date: date.format(new Date(`${c.lastDay}T00:00:00Z`)),
                    }).split(' · ').map((part, i) => (
                      <span key={i} className="whitespace-nowrap">{i > 0 ? `· ${part}` : part}</span>
                    ))}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Panel>
        <Panel title={t('revenue.customers.segmentsTitle')} action={<span className="text-xs text-bambu-gray">{t('revenue.customers.segmentsHint', { mode: t(`revenue.${mode}`) })}</span>}>
          <div className="space-y-3">
            {error && <p role="alert" className="text-xs text-status-error">{error}</p>}
            {data.unsplitHt !== 0 && (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                {t('revenue.customers.unsplit', { amount: formatFcp(data.unsplitHt) })}
              </p>
            )}
            <div className="grid gap-1.5">
              {rows.map((s) => {
                const f = figures(s, mode);
                const on = p.segment === s.segment;
                return (
                  <button
                    key={s.segment}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(s.segment)}
                    className={`rounded-lg px-3 py-2 text-left text-[13px] transition-colors ${on ? 'bg-bambu-dark-tertiary' : 'bg-bambu-dark hover:bg-bambu-dark-tertiary/60'} ${focusRingCls}`}
                  >
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="inline-flex min-w-0 items-center gap-2 text-white">
                        <Dot segment={s.segment} />
                        {segName(s.segment)}
                        {on && <span className="text-xs text-bambu-green">{t('revenue.customers.activeFilter')}</span>}
                      </span>
                      <span className="shrink-0 font-medium tabular-nums text-white">
                        {formatFcp(f.total)} <span className="text-xs font-normal text-bambu-gray">{share(f.total, grand)} %</span>
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[11px] tabular-nums text-bambu-gray">
                      {t('revenue.customers.segmentDetail', { goods: formatFcp(f.goods), services: formatFcp(f.services), n: s.customers })}
                    </span>
                  </button>
                );
              })}
            </div>
            <KindBar label={t('revenue.filters.goods')} values={rows.map((s) => ({ segment: s.segment, value: figures(s, mode).goods }))} />
            <KindBar label={t('revenue.filters.services')} values={rows.map((s) => ({ segment: s.segment, value: figures(s, mode).services }))} />
          </div>
        </Panel>
      </Split>
    </>
  );
}
