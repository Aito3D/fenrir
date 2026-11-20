import { Fragment, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, RotateCw } from 'lucide-react';
import { Panel } from '../aito/stats/primitives';
import { DeltaBadge } from '../stats/DeltaBadge';
import { focusRingCls } from '../formStyles';
import { asDelta } from './lib/finding';
import { evolutionFor, yearOverYear } from './lib/kpis';
import { formatFcp } from './lib/format';
import { toggleInSet } from './lib/dashboard';
import type { ItemsResponse, RevenueBucket, RevenueGranularity, RevenueMonthCheck, TaxMode } from './lib/types';
import { useRevenueResource } from './useRevenueResource';
import { MarginBreakdown } from './MarginBreakdown';

const ROW = 'grid items-baseline gap-3 px-3';
const CELL = 'text-right tabular-nums';
const rate = (margin: number, base: number) => `${Math.round((margin / base) * 100)} %`;

/** A change cell: ▲/▼ badge, « — » without a comparison, « à date » when the bucket is compared on its elapsed days. */
function Evo({ v, elapsedDays }: { v: number | null; elapsedDays: number | null }) {
  const { t } = useTranslation();
  return (
    <span role="cell" className={CELL}>
      {v == null ? <span data-missing className="text-bambu-gray">—</span> : <DeltaBadge delta={asDelta(v)} />}
      {v != null && elapsedDays !== null && <span className="ml-1 block text-[10px] text-bambu-gray">{t('revenue.table.toDate')}</span>}
    </span>
  );
}

/** ✓ or ⚠ beside a closed month checked against Zoho's own total; a gap offers « Recharger » to whoever may sync. */
function CheckMark({ check, label, onRefetch }: { check: RevenueMonthCheck; label: string; onRefetch?: (month: string, label: string) => void }) {
  const { t, i18n } = useTranslation();
  const title = check.ok
    ? t('revenue.sync.checkOk', { date: new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'short' }).format(new Date(check.checkedAt)) })
    : t('revenue.sync.checkGap', { zoho: formatFcp(check.zohoHt), cache: formatFcp(check.cacheHt) });
  const tone = check.ok ? 'text-bambu-green' : 'text-amber-700 dark:text-amber-400';
  return (
    <>
      <span role="img" aria-label={title} title={title} className={`shrink-0 text-xs ${tone}`}>{check.ok ? '✓' : '⚠'}</span>
      {!check.ok && onRefetch && (
        <button type="button" onClick={() => onRefetch(check.month, label)} aria-label={t('revenue.sync.reloadMonthHint', { month: label })}
          title={t('revenue.sync.reloadMonthHint', { month: label })}
          className={`shrink-0 rounded p-0.5 hover:text-white ${tone} ${focusRingCls}`}>
          {/* An icon, not the word: the period column is narrow and the month name must stay readable. */}
          <RotateCw aria-hidden="true" className="h-3 w-3" />
        </button>
      )}
    </>
  );
}

function ItemRows({ bucket, filterParams, version, cols, margin }: { bucket: RevenueBucket; filterParams: string; version: unknown; cols: string; margin: boolean }) {
  const { t } = useTranslation();
  const { data, error } = useRevenueResource<ItemsResponse>(`/api/v1/revenue/items?from=${bucket.start}&to=${bucket.end}${filterParams}`, version);
  const note = (text: string, cls = 'text-bambu-gray') => (
    <div role="row" className="px-3 pl-9">
      <span role="cell" className={`text-xs ${cls}`}>{text}</span>
    </div>
  );
  if (error && !data) return note(error, 'text-status-error');
  if (!data) return note(t('revenue.state.loading'));
  if (data.items.length === 0) return note(t('revenue.table.empty'));
  return (
    <>
      {data.items.map((r) => (
        <div key={r.itemId} role="row" className={`${ROW} py-1 text-xs text-bambu-gray-light`} style={{ gridTemplateColumns: cols }}>
          <span role="cell" className="min-w-0 pl-6">
            <span className="block truncate text-white" title={r.name}>{r.name}</span>
            <span className="block truncate text-[11px] text-bambu-gray">
              {[t(`revenue.filters.${r.kind === 'service' ? 'services' : 'goods'}`), r.nature, r.brand, r.sku].filter(Boolean).join(' · ')}
            </span>
          </span>
          <span role="cell" className={CELL}>{formatFcp(r.ht)}</span>
          <span role="cell" className={CELL}>{formatFcp(r.ttc)}</span>
          <span role="cell" />
          <span role="cell" />
          {margin && <span role="cell" className={CELL}>{r.cost == null ? '—' : formatFcp(r.ht - r.cost)}</span>}
          {margin && <span role="cell" />}
          <span role="cell" />
          <span role="cell" className={CELL}>{r.quantity}</span>
        </div>
      ))}
    </>
  );
}

/** « Détail par période »: one row per bucket, newest first; a row opens onto the items sold in it. */
export function RevenueTable({ buckets, granularity, taxMode, canMargin, filterParams, version, checks, onRefetch }: {
  buckets: RevenueBucket[];
  granularity: RevenueGranularity;
  taxMode: TaxMode;
  canMargin: boolean;
  filterParams: string;
  version: unknown;
  /** Month checks against Zoho, passed only when the page shows the unfiltered book by month. */
  checks?: RevenueMonthCheck[];
  onRefetch?: (month: string, label: string) => void;
}) {
  const { t } = useTranslation();
  const hintId = useId();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // Cost fields are stripped by the server without the margin permission.
  const margin = canMargin && buckets.some((b) => b.costedHt !== undefined);
  const cols = `minmax(0,1.5fr) repeat(${margin ? 8 : 6},minmax(0,1fr))`;
  const rows = [...buckets].reverse();
  const checkOf = new Map(granularity === 'month' ? (checks ?? []).map((c) => [c.month, c]) : []);
  const heads = [
    { id: 'period', label: granularity === 'day' ? t('revenue.controls.day') : t('revenue.table.period') },
    { id: 'ht', label: t('revenue.table.ht') },
    { id: 'ttc', label: t('revenue.table.ttc') },
    { id: 'change', label: t('revenue.table.change') },
    { id: 'yoy', label: t('revenue.table.yoy') },
    ...(margin ? [{ id: 'margin', label: t('revenue.table.margin') }, { id: 'perHour', label: t('revenue.table.perHour') }] : []),
    { id: 'cumulative', label: t('revenue.table.cumulative') },
    { id: 'units', label: t('revenue.table.units') },
  ];

  return (
    <Panel title={t('revenue.table.title')}>
      <span id={hintId} hidden>{t('revenue.table.marginHint')}</span>
      {/* Eight figures do not fit a phone or the narrow split column: the rows scroll sideways, never wrap. */}
      <div role="region" tabIndex={0} aria-label={t('revenue.table.title')} className={`overflow-x-auto rounded-lg ${focusRingCls}`}>
      <div role="table" aria-label={t('revenue.table.title')} className="grid min-w-[66rem] gap-1.5 text-[13px]">
        <div role="row" className={`${ROW} text-[11px] text-bambu-gray`} style={{ gridTemplateColumns: cols }}>
          {heads.map((h, i) => (
            <span key={h.id} role="columnheader" className={i === 0 ? '' : 'text-right'}
              {...(h.id === 'margin' ? { title: t('revenue.table.marginHint'), 'aria-describedby': hintId } : h.id === 'perHour' ? { title: t('revenue.table.perHourHint') } : {})}>{h.label}</span>
          ))}
        </div>
        {rows.map((b) => {
          const expanded = open.has(b.key);
          // The margin is computed on the costed sales only; say how much of the HT that covers when it is not all of it.
          const coverage = b.costedHt != null && b.costedHt > 0 && b.ht > 0 ? Math.round((b.costedHt / b.ht) * 100) : null;
          const coveragePct = coverage != null && coverage < 100 ? `${coverage} %` : null;
          return (
            <Fragment key={b.key}>
              <div role="row" className={`${ROW} rounded-lg bg-bambu-dark py-2`} style={{ gridTemplateColumns: cols }}>
                <span role="cell" className="min-w-0">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                  <button type="button" aria-expanded={expanded} onClick={() => setOpen((o) => toggleInSet(o, b.key))}
                    className={`flex min-w-0 max-w-full items-baseline gap-1 rounded text-left text-bambu-gray-light hover:text-white ${focusRingCls}`}>
                    <ChevronRight aria-hidden className={`h-3.5 w-3.5 shrink-0 self-center transition-transform ${expanded ? 'rotate-90' : ''}`} />
                    <span className="truncate">{b.label}</span>
                  </button>
                  {checkOf.has(b.key) && <CheckMark check={checkOf.get(b.key)!} label={b.label} onRefetch={onRefetch} />}
                  </span>
                  {(b.partial || b.missingDays > 0) && (
                    <span className="ml-[18px] flex flex-wrap gap-x-2 text-[11px] text-amber-700 dark:text-amber-400">
                      {b.partial && <span>{t('revenue.chart.inProgress')}</span>}
                      {b.missingDays > 0 && <span>{t('revenue.chart.missingDays', { n: b.missingDays })}</span>}
                    </span>
                  )}
                </span>
                <span role="cell" className={`${CELL} font-medium text-white`}>{formatFcp(b.ht)}</span>
                <span role="cell" className={`${CELL} text-bambu-gray-light`}>{`${formatFcp(b.ttc)}${b.ttcApprox ? ' ≈' : ''}`}</span>
                <Evo v={evolutionFor(b, taxMode)} elapsedDays={b.elapsedDays} />
                <Evo v={yearOverYear(b, taxMode)} elapsedDays={b.elapsedDays} />
                {margin && (
                  <span role="cell" className={`${CELL} text-bambu-gray-light`} title={coveragePct ? t('revenue.table.coverage', { pct: coveragePct }) : undefined}>
                    {b.costedHt != null && b.costedHt > 0 ? (
                      <>
                        {formatFcp(b.costedHt - (b.cost ?? 0))} <span className="text-xs text-bambu-gray">{rate(b.costedHt - (b.cost ?? 0), b.costedHt)}</span>
                        {coveragePct && <span className="block text-[10px] text-bambu-gray">{t('revenue.table.coverageShort', { pct: coveragePct })}</span>}
                      </>
                    ) : (
                      '—'
                    )}
                  </span>
                )}
                {margin && (
                  <span role="cell" className={`${CELL} text-bambu-gray-light`}>
                    {b.printHours ? `${formatFcp(b.services / b.printHours)} /h` : '—'}
                  </span>
                )}
                <span role="cell" className={`${CELL} text-bambu-gray-light`}>{formatFcp(taxMode === 'ttc' ? b.cumulative.ttc : b.cumulative.ht)}</span>
                <span role="cell" className={`${CELL} text-bambu-gray-light`}>{b.quantity}</span>
              </div>
              {expanded && margin && b.costParts && (
                <div role="row" className="px-3 py-1.5 pl-9">
                  <span role="cell" className="block max-w-sm text-xs text-bambu-gray-light">
                    <MarginBreakdown bucket={b} />
                  </span>
                </div>
              )}
              {expanded && <ItemRows bucket={b} filterParams={filterParams} version={version} cols={cols} margin={margin} />}
            </Fragment>
          );
        })}
      </div>
      </div>
    </Panel>
  );
}
