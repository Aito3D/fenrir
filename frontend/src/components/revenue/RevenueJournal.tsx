import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { Panel, Tile } from '../aito/stats/primitives';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { focusRingCls } from '../formStyles';
import { RevenueSegmented } from './RevenueSegmented';
import { REVENUE_STORAGE_KEYS } from './lib/dashboard';
import { addDays, dayToUtc } from './lib/dates';
import { formatAmount } from './lib/format';
import { bucketCharges, journalTotals, periodRank, rateTone, withProductionCost, type JournalRow, type JournalTotals } from './lib/journal';
import type { ItemsResponse, RevenueBucket, RevenueGranularity, RevenueResponse, TaxMode } from './lib/types';
import { useRevenueResource } from './useRevenueResource';

const PAD = 'px-2 py-1.5 sm:px-3';
const NUM = `${PAD} whitespace-nowrap text-right tabular-nums`;
const WIDE = 'hidden sm:table-cell';
const LABEL = 'text-[11px] uppercase tracking-wide text-bambu-gray';
const CHIP = 'max-w-full shrink-0 truncate rounded-full border border-current px-1.5 text-[10px] leading-4';
const GROUPS = ['kind', 'brand', 'nature'] as const;
type GroupBy = (typeof GROUPS)[number];
type SortKey = 'name' | 'quantity' | 'amount' | 'margin' | 'rate';

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)} %`);
const money = (v: number | null) => (v === null ? '—' : formatAmount(v));
const cmp = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1);

function storedGroup(): GroupBy {
  try {
    const v = localStorage.getItem(REVENUE_STORAGE_KEYS.journalGroup);
    return GROUPS.find((g) => g === v) ?? 'kind';
  } catch {
    return 'kind';
  }
}

/** One item unfolded: its per-unit figures and its sales over the 30 days ending with the period. Mounted on expand, so fetched then. */
function Detail({ row, tot, taxMode, margin, to, filterParams, version, cols }: {
  row: JournalRow; tot: JournalTotals; taxMode: TaxMode; margin: boolean; to: string; filterParams: string; version: unknown; cols: number;
}) {
  const { t } = useTranslation();
  // The item stands in for a basket filter: the row already passed it.
  const url = `/api/v1/revenue?granularity=day&from=${addDays(to, -29)}&to=${to}&items=${row.itemId}${filterParams.replace(/&items=[^&]*/, '')}`;
  const { data, dataUrl, error } = useRevenueResource<RevenueResponse>(url, version);
  const days = dataUrl === url && data ? data.buckets.map((b) => Math.max(0, taxMode === 'ht' ? b.ht : b.ttc)) : null;
  const max = Math.max(1, ...(days ?? []));
  const per = (v: number | null) => (v === null || !row.quantity ? '—' : formatAmount(v / row.quantity));
  const facts = [
    [t('revenue.journal.unitPrice', { tax: t(`revenue.${taxMode}`) }), per(taxMode === 'ht' ? row.ht : row.ttc), 'text-white'],
    ...(margin ? [[t('revenue.journal.unitCost'), per(tot.cost), 'text-white'], [t('revenue.journal.unitMargin'), per(tot.margin), rateTone(tot.rate)]] : []),
  ];
  const label = days ? t('revenue.journal.soldDays', { n: days.filter((v) => v > 0).length, days: days.length }) : (error ?? t('revenue.state.loading'));
  return (
    <tr data-slot="revenue-journal-detail" className="bg-bambu-dark/40">
      <td colSpan={cols} className="px-3 pb-3 pt-1 sm:pl-8">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
          <dl className="flex flex-wrap gap-x-8 gap-y-2">
            {facts.map(([k, v, tone]) => (
              <div key={k}>
                <dt className={LABEL}>{k}</dt>
                <dd className={`font-semibold tabular-nums ${tone}`}>{v}</dd>
              </div>
            ))}
          </dl>
          {/* The label sits above the bars in normal flow, so a tall bar can never run under it. */}
          <div className="min-w-48 flex-1">
            <p className={LABEL}>{label}</p>
            {days && (
              <div role="img" aria-label={label} className="mt-1.5 flex h-10 items-end gap-px">
                {days.map((v, i) => (
                  <i key={i} className={`min-h-px flex-1 rounded-[1px] ${i === days.length - 1 ? 'bg-bambu-green' : 'bg-bambu-gray/60'}`} style={{ height: `${(v / max) * 100}%` }} />
                ))}
              </div>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}

/**
 * « Journal »: everything invoiced in one period, item by item. The period is the last one of the page's window, at the
 * page's granularity: the controls at the top of the page (and ← →) step through it.
 * With the margin permission it is a margin ledger: cost, margin (always HT), rate and share per item, group and period.
 */
export function RevenueJournal({ bucket, buckets: periods, granularity, today, filterParams, version, taxMode, canMargin }: {
  /** The period shown; it carries the production cost the services share. */
  bucket: RevenueBucket;
  /** The page's window, which ranks the period (record badge). */
  buckets: readonly RevenueBucket[];
  granularity: RevenueGranularity;
  today: string;
  filterParams: string;
  version: unknown;
  taxMode: TaxMode;
  canMargin: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [by, setBy] = useState(storedGroup);
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean } | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const from = bucket.start;
  const to = bucket.end > today ? today : bucket.end;
  const url = `/api/v1/revenue/items?from=${from}&to=${to}${filterParams}`;
  const { data, dataUrl, error } = useRevenueResource<ItemsResponse>(url, version);
  const items = dataUrl === url && data ? data.items : null;
  const rows = items && withProductionCost(items, bucket);
  const charges = bucketCharges(bucket);
  const mode = granularity === 'day' || granularity === 'month' ? granularity : null;
  const rank = rows && rows.length > 0 && mode ? periodRank(periods, from, mode === 'day' ? 5 : 3) : null;

  // A day and a month are spelled out in the reader's language; the other periods keep the series' own label.
  const label = mode
    ? new Intl.DateTimeFormat(
        i18n.language,
        mode === 'day' ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' } : { month: 'long', year: 'numeric', timeZone: 'UTC' },
      ).format(dayToUtc(from))
    : bucket.label;

  // The server strips `cost` without the margin permission.
  const margin = canMargin && !!rows && !rows.some((r) => r.cost === undefined);
  // Below sm the table is Product | Revenue | Margin: the spans must count the visible columns only, or the fixed layout grows phantom ones.
  const narrow = useMediaQuery('(max-width: 639px)', () => typeof window !== 'undefined' && window.innerWidth < 640);
  const cols = narrow ? (margin ? 3 : 2) : margin ? 7 : 3;
  const amt = (x: { ht: number; ttc: number }) => (taxMode === 'ht' ? x.ht : x.ttc);
  const total = journalTotals(rows ?? []);
  const share = (m: number | null) => (m === null || total.margin === null || total.margin <= 0 ? null : m / total.margin);

  const active = sort ?? { key: margin ? 'margin' : 'amount', asc: false };
  const sortValue = (r: JournalRow) =>
    active.key === 'quantity' ? r.quantity : active.key === 'amount' ? amt(r) : (journalTotals([r])[active.key === 'rate' ? 'rate' : 'margin'] ?? -Infinity);
  const ordered = (list: JournalRow[]) =>
    [...list].sort((a, b) => (active.asc ? 1 : -1) * (active.key === 'name' ? a.name.localeCompare(b.name, i18n.language) : cmp(sortValue(a), sortValue(b))));

  const buckets = new Map<string, JournalRow[]>();
  for (const r of rows ?? []) {
    const key = by === 'kind' ? r.kind : (r[by] ?? '');
    buckets.set(key, [...(buckets.get(key) ?? []), r]);
  }
  // Goods before services; brands and natures by what they earn.
  const weight = (g: { key: string; tot: JournalTotals }) => (by === 'kind' ? (g.key === 'goods' ? 1 : 0) : margin ? (g.tot.margin ?? -Infinity) : g.tot.ht);
  const groups = [...buckets].map(([key, list]) => ({ key, list, tot: journalTotals(list) })).sort((a, b) => cmp(weight(b), weight(a)));
  const groupTitle = (key: string) =>
    by === 'kind' ? t(key === 'goods' ? 'revenue.filters.goods' : 'revenue.filters.services') : key || t(by === 'brand' ? 'revenue.labels.noBrand' : 'revenue.labels.noNature');

  const pickGroup = (g: GroupBy) => {
    setBy(g);
    try {
      localStorage.setItem(REVENUE_STORAGE_KEYS.journalGroup, g);
    } catch {
      // Storage refused (private mode): the choice lasts the visit.
    }
  };
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (!n.delete(id)) n.add(id);
      return n;
    });

  const head = (key: SortKey, text: string, cls: string) => {
    const on = active.key === key;
    return (
      <th scope="col" aria-sort={on ? (active.asc ? 'ascending' : 'descending') : 'none'} className={`${cls} font-normal`}>
        {/* A first click sorts names A→Z and figures largest first. */}
        <button type="button" className={`uppercase tracking-wide hover:text-white ${on ? 'text-white' : ''} ${focusRingCls}`} onClick={() => setSort({ key, asc: on ? !active.asc : key === 'name' })}>
          {text}
          {on && <span aria-hidden>{active.asc ? ' ↑' : ' ↓'}</span>}
        </button>
      </th>
    );
  };
  const marginCells = (x: JournalTotals, bar: boolean) => {
    if (!margin) return null;
    const s = share(x.margin);
    return (
      <>
        <td className={`${NUM} ${WIDE} font-normal text-bambu-gray`}>{money(x.cost)}</td>
        <td className={`${NUM} ${rateTone(x.rate)}`}>{money(x.margin)}</td>
        <td className={`${NUM} ${WIDE} ${rateTone(x.rate)}`}>{pct(x.rate)}</td>
        <td className={`${NUM} ${WIDE}`}>
          {pct(s)}
          {bar && (
            <div aria-hidden className="mt-1 h-1 overflow-hidden rounded-full bg-bambu-dark-tertiary">
              <div className="h-full rounded-full bg-bambu-green" style={{ width: `${Math.min(100, Math.max(0, (s ?? 0) * 100))}%` }} />
            </div>
          )}
        </td>
      </>
    );
  };

  return (
    <Panel
      title={<span aria-live="polite" data-slot="revenue-journal-period" className="text-sm font-semibold text-white first-letter:uppercase">{label}</span>}
      action={rank !== null && (
        <span data-slot="revenue-journal-record" className="rounded-full bg-status-warning/15 px-2 py-0.5 text-[11px] font-semibold text-status-warning">
          {'★ '}
          {mode === 'day'
            ? rank === 1 ? t('revenue.journal.bestDay') : t('revenue.journal.rankDay', { n: rank })
            : rank === 1 ? t('revenue.journal.bestMonth') : t('revenue.journal.rankMonth', { n: rank })}
        </span>
      )}
    >
      {error && !rows ? (
        <p role="alert" className="py-6 text-center text-sm text-status-error">{error}</p>
      ) : !rows ? (
        <p className="py-6 text-center text-sm text-bambu-gray">{t('revenue.state.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-bambu-gray">{t('revenue.table.empty')}</p>
      ) : (
        <>
          <div data-slot="revenue-journal-kpis" className={`mb-3 grid grid-cols-2 gap-2 ${margin ? 'sm:grid-cols-5' : 'sm:grid-cols-4'}`}>
            <Tile label={t(`revenue.table.${taxMode}`)} value={formatAmount(amt(total))} />
            {margin && <Tile label={t('revenue.analysis.marginTitle')} value={money(total.margin)} tone={total.margin !== null && total.margin < 0 ? 'alert' : undefined} />}
            {margin && <Tile label={t('revenue.journal.marginRate')} value={pct(total.rate)} hint={t('revenue.table.coverage', { pct: `${Math.round(total.coverage * 100)} %` })} hintWrap />}
            {margin && <Tile label={t('revenue.charges.title')} value={money(charges)} />}
            <Tile label={t('revenue.table.units')} value={String(total.quantity)} hint={`${t('revenue.views.journalReferences')} · ${rows.length}`} />
          </div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className={LABEL}>{t('revenue.journal.groupBy')}</span>
            <RevenueSegmented inPanel label={t('revenue.journal.groupBy')} value={by} onChange={pickGroup}
              options={[{ id: 'kind', label: t('revenue.filters.type') }, { id: 'brand', label: t('revenue.filters.brand') }, { id: 'nature', label: t('revenue.chart.stack.nature') }]} />
          </div>
          <table className="w-full table-fixed text-sm text-bambu-gray-light">
            <thead>
              <tr className="text-[11px] text-bambu-gray">
                {head('name', t('revenue.chart.stack.item'), `${PAD} text-left`)}
                {head('quantity', t('revenue.table.units'), `${NUM} ${WIDE} w-16`)}
                {head('amount', t(`revenue.table.${taxMode}`), `${NUM} w-[5.5rem] sm:w-28`)}
                {margin && (
                  <>
                    <th scope="col" className={`${NUM} ${WIDE} w-24 font-normal uppercase tracking-wide`}>{t('revenue.journal.cost')}</th>
                    {head('margin', t('revenue.table.margin'), `${NUM} w-[5.5rem] sm:w-28`)}
                    {head('rate', t('revenue.journal.rate'), `${NUM} ${WIDE} w-20`)}
                    <th scope="col" className={`${NUM} ${WIDE} w-20 font-normal uppercase tracking-wide`}>{t('revenue.journal.share')}</th>
                  </>
                )}
              </tr>
            </thead>
            {groups.map((g) => (
              <tbody key={g.key} data-slot={by === 'kind' ? `revenue-journal-${g.key}` : 'revenue-journal-group'}>
                <tr className="border-t border-bambu-dark-tertiary bg-bambu-dark/50 text-xs font-semibold text-bambu-gray-light">
                  <th scope="rowgroup" colSpan={narrow ? 1 : 2} className={`${PAD} truncate text-left`}>
                    <span>{groupTitle(g.key)}</span> <span className="font-normal text-bambu-gray">· {g.list.length}</span>
                  </th>
                  <td className={NUM}>{formatAmount(amt(g.tot))}</td>
                  {marginCells(g.tot, false)}
                </tr>
                {ordered(g.list).map((r) => {
                  const x = journalTotals([r]);
                  const isOpen = open.has(r.itemId);
                  return (
                    <Fragment key={r.itemId}>
                      {/* The whole row is the click target; the button inside carries the keyboard and the state. */}
                      <tr className={`cursor-pointer border-t border-bambu-dark-tertiary/50 hover:bg-white/[.03] ${isOpen ? 'bg-white/[.04]' : ''}`} onClick={() => toggle(r.itemId)}>
                        <th scope="row" className={`${PAD} max-w-0 text-left font-normal`}>
                          <button type="button" aria-expanded={isOpen} className={`flex w-full min-w-0 items-start gap-1 text-left ${focusRingCls}`}>
                            <ChevronRight aria-hidden className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-bambu-gray transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                            <span className="min-w-0 flex-1">
                              {/* Below sm the name keeps the whole line and the chips wrap under it. */}
                              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 sm:flex-nowrap">
                                <span className="w-full truncate text-white sm:w-auto" title={r.name}>{r.name}</span>
                                {margin && r.cost == null && <span className={`${CHIP} text-bambu-gray`}>{t('revenue.journal.unknownCost')}</span>}
                                {margin && r.shared && <span className={`${CHIP} text-bambu-gray`} title={t('revenue.journal.sharedCostHint')}>{t('revenue.journal.sharedCost')}</span>}
                                {x.margin !== null && x.margin < 0 && margin && <span className={`${CHIP} text-status-error`}>{t('revenue.journal.atLoss')}</span>}
                              </span>
                              <span className="block truncate text-[11px] text-bambu-gray">
                                {/* The Units column is hidden below sm: the quantity leads the meta line there. */}
                                <span className="sm:hidden">{`× ${r.quantity} · `}</span>
                                {[by === 'nature' ? null : r.nature, by === 'brand' ? null : r.brand, r.sku].filter(Boolean).join(' · ')}
                              </span>
                            </span>
                          </button>
                        </th>
                        <td className={`${NUM} ${WIDE}`}>{r.quantity}</td>
                        <td className={NUM}>{formatAmount(amt(r))}</td>
                        {marginCells(x, true)}
                      </tr>
                      {isOpen && <Detail row={r} tot={x} taxMode={taxMode} margin={margin} to={to} filterParams={filterParams} version={version} cols={cols} />}
                    </Fragment>
                  );
                })}
              </tbody>
            ))}
            <tfoot>
              <tr className="border-t border-bambu-dark-tertiary font-bold text-white">
                <th scope="row" className={`${PAD} py-2 text-left`}>{t('settings.total')}</th>
                <td className={`${NUM} ${WIDE}`}>{total.quantity}</td>
                <td className={NUM}>{formatAmount(amt(total))}</td>
                {marginCells(total, false)}
              </tr>
            </tfoot>
          </table>
        </>
      )}
    </Panel>
  );
}
