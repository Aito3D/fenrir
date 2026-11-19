import { Fragment, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { Panel } from '../aito/stats/primitives';
import { DeltaBadge } from '../stats/DeltaBadge';
import { focusRingCls } from '../formStyles';
import { asDelta } from './lib/finding';
import { evolutionFor, yearOverYear } from './lib/kpis';
import { formatFcp } from './lib/format';
import { toggleInSet } from './lib/dashboard';
import type { ItemsResponse, RevenueBucket, RevenueGranularity, TaxMode } from './lib/types';
import { useRevenueResource } from './useRevenueResource';

const ROW = 'grid items-baseline gap-3 px-3';
const CELL = 'text-right tabular-nums';
const rate = (margin: number, base: number) => `${Math.round((margin / base) * 100)} %`;

/** A change cell: ▲/▼ badge, « — » without a comparison, « à date » when the bucket is compared on its elapsed days. */
function Evo({ v, elapsedDays }: { v: number | null; elapsedDays: number | null }) {
  const { t } = useTranslation();
  return (
    <span role="cell" className={CELL}>
      {v == null ? <span className="text-bambu-gray">—</span> : <DeltaBadge delta={asDelta(v)} />}
      {v != null && elapsedDays !== null && <span className="ml-1 block text-[10px] text-bambu-gray">{t('revenue.table.toDate')}</span>}
    </span>
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
          <span role="cell" />
          <span role="cell" className={CELL}>{r.quantity}</span>
        </div>
      ))}
    </>
  );
}

/** « Détail par période »: one row per bucket, newest first; a row opens onto the items sold in it. */
export function RevenueTable({ buckets, granularity, taxMode, canMargin, filterParams, version }: {
  buckets: RevenueBucket[];
  granularity: RevenueGranularity;
  taxMode: TaxMode;
  canMargin: boolean;
  filterParams: string;
  version: unknown;
}) {
  const { t } = useTranslation();
  const hintId = useId();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // Cost fields are stripped by the server without the margin permission.
  const margin = canMargin && buckets.some((b) => b.costedHt !== undefined);
  const cols = `minmax(0,1.5fr) repeat(${margin ? 7 : 6},minmax(0,1fr))`;
  const rows = [...buckets].reverse();
  const heads = [
    granularity === 'day' ? t('revenue.controls.day') : t('revenue.table.period'),
    t('revenue.table.ht'),
    t('revenue.table.ttc'),
    t('revenue.table.change'),
    t('revenue.table.yoy'),
    ...(margin ? [t('revenue.table.margin')] : []),
    t('revenue.table.cumulative'),
    t('revenue.table.units'),
  ];

  return (
    <Panel title={t('revenue.table.title')}>
      <span id={hintId} hidden>{t('revenue.table.marginHint')}</span>
      {/* Eight figures do not fit a phone or the narrow split column: the rows scroll sideways, never wrap. */}
      <div className="overflow-x-auto">
      <div role="table" aria-label={t('revenue.table.title')} className="grid min-w-[60rem] gap-1.5 text-[13px]">
        <div role="row" className={`${ROW} text-[11px] text-bambu-gray`} style={{ gridTemplateColumns: cols }}>
          {heads.map((h, i) => (
            <span key={h} role="columnheader" className={i === 0 ? '' : 'text-right'}
              {...(margin && h === t('revenue.table.margin') ? { title: t('revenue.table.marginHint'), 'aria-describedby': hintId } : {})}>{h}</span>
          ))}
        </div>
        {rows.map((b) => {
          const expanded = open.has(b.key);
          return (
            <Fragment key={b.key}>
              <div role="row" className={`${ROW} rounded-lg bg-bambu-dark py-2`} style={{ gridTemplateColumns: cols }}>
                <span role="cell" className="min-w-0">
                  <button type="button" aria-expanded={expanded} onClick={() => setOpen((o) => toggleInSet(o, b.key))}
                    className={`flex min-w-0 max-w-full items-baseline gap-1 rounded text-left text-bambu-gray-light hover:text-white ${focusRingCls}`}>
                    <ChevronRight aria-hidden className={`h-3.5 w-3.5 shrink-0 self-center transition-transform ${expanded ? 'rotate-90' : ''}`} />
                    <span className="truncate">{b.label}</span>
                  </button>
                  {(b.partial || b.missingDays > 0) && (
                    <span className="ml-[18px] flex flex-wrap gap-x-2 text-[11px] text-amber-400">
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
                  <span role="cell" className={`${CELL} text-bambu-gray-light`}>
                    {b.costedHt != null && b.costedHt > 0 ? (
                      <>
                        {formatFcp(b.costedHt - (b.cost ?? 0))} <span className="text-xs text-bambu-gray">{rate(b.costedHt - (b.cost ?? 0), b.costedHt)}</span>
                      </>
                    ) : (
                      '—'
                    )}
                  </span>
                )}
                <span role="cell" className={`${CELL} text-bambu-gray-light`}>{formatFcp(taxMode === 'ttc' ? b.cumulative.ttc : b.cumulative.ht)}</span>
                <span role="cell" className={`${CELL} text-bambu-gray-light`}>{b.quantity}</span>
              </div>
              {expanded && <ItemRows bucket={b} filterParams={filterParams} version={version} cols={cols} margin={margin} />}
            </Fragment>
          );
        })}
      </div>
      </div>
    </Panel>
  );
}
