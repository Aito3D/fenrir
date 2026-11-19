import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Facts, Panel, Split, Tile } from '../aito/stats/primitives';
import { focusRingCls } from '../formStyles';
import { Skeleton } from '../Skeleton';
import { RevenueSegmented } from './RevenueSegmented';
import { formatFcp, serverLabel } from './lib/format';
import type { AbcClass, AbcResult, AnalysisResponse, DormantRow, MarginRow } from './lib/types';
import { useRevenueResource } from './useRevenueResource';

const CLASSES: readonly AbcClass[] = ['A', 'B', 'C'];
// The mockup's class colours, for swatches and bars only; the letter is printed in a readable text colour.
const CLASS_COLOR: Record<AbcClass, string> = { A: '#219653', B: '#c26a1c', C: '#6b6b6b' };
const ROWS_COLLAPSED = 25;
const pct = (v: number) => `${Math.round(v * 100)} %`.replace('-', '−');

function ShareBar({ label, parts }: { label: string; parts: { cls: AbcClass; v: number }[] }) {
  const total = parts.reduce((s, p) => s + p.v, 0) || 1;
  const text = parts.map((p) => `${p.cls} ${pct(p.v / total)}`).join(', ');
  return (
    <div className="flex items-center gap-3 rounded-lg bg-bambu-dark px-3 py-2 text-xs">
      <span className="w-20 shrink-0 truncate text-bambu-gray-light">{label}</span>
      <span role="img" aria-label={`${label}: ${text}`} className="flex h-2 min-w-0 flex-1 gap-[2px]">
        {parts.filter((p) => p.v > 0).map((p) => (
          <span key={p.cls} className="block h-full min-w-[3px] rounded-[2px]" style={{ flexGrow: p.v, backgroundColor: CLASS_COLOR[p.cls] }} />
        ))}
      </span>
    </div>
  );
}

function ParetoTiles({ abc }: { abc: AbcResult }) {
  const { t } = useTranslation();
  const count = CLASSES.reduce((s, c) => s + abc.classes[c].count, 0);
  return (
    <Panel>
      <div className="grid gap-2 sm:grid-cols-3">
        {CLASSES.map((c) => (
          <Tile
            key={c}
            swatch={CLASS_COLOR[c]}
            label={t('revenue.analysis.classLabel', { cls: c })}
            value={String(abc.classes[c].count)}
            hint={t('revenue.analysis.classHint', {
              products: count ? pct(abc.classes[c].count / count) : '—',
              revenue: abc.total ? pct(abc.classes[c].ht / abc.total) : '—',
            })}
          />
        ))}
      </div>
      <div className="mt-2 grid gap-1.5">
        <ShareBar label={t('revenue.analysis.productsBar')} parts={CLASSES.map((c) => ({ cls: c, v: abc.classes[c].count }))} />
        <ShareBar label={t('revenue.analysis.revenueBar')} parts={CLASSES.map((c) => ({ cls: c, v: abc.classes[c].ht }))} />
      </div>
    </Panel>
  );
}

function Pareto({ abc }: { abc: AbcResult }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const count = CLASSES.reduce((s, c) => s + abc.classes[c].count, 0);
  const rows = expanded ? abc.rows : abc.rows.slice(0, ROWS_COLLAPSED);
  const top = abc.rows[0]?.ht ?? 0;
  const title = t('revenue.analysis.paretoTitle');
  return (
    <Panel title={title} action={<span className="text-[11px] text-bambu-gray">{t('revenue.analysis.paretoNote')}</span>}>
      {abc.rows.length === 0 ? (
        <p className="rounded-lg bg-bambu-dark px-3 py-2 text-sm text-bambu-gray">{t('revenue.analysis.nothingToRank')}</p>
      ) : (
        <ol aria-label={title} className="grid gap-1.5 text-xs">
          {rows.map((r, i) => (
            <li key={r.itemId} className="rounded-lg bg-bambu-dark px-3 py-2">
              <div className="flex items-center gap-3">
                <span className="flex min-w-0 shrink basis-56 items-baseline gap-2">
                  <span aria-hidden="true" className="w-5 shrink-0 text-right tabular-nums text-bambu-gray">{i + 1}</span>
                  <b data-cls className="shrink-0 font-semibold text-bambu-gray-light">{r.cls}</b>
                  <span className="min-w-0 truncate text-white" title={r.name}>{r.name}</span>
                </span>
                <span className="min-w-0 flex-1" aria-hidden="true">
                  {top > 0 && <span className="block h-2 min-w-[3px] rounded-[2px]" style={{ width: `${(r.ht / top) * 100}%`, backgroundColor: CLASS_COLOR[r.cls] }} />}
                </span>
                <span className="w-36 shrink-0 whitespace-nowrap text-right tabular-nums text-bambu-gray-light">{`${formatFcp(r.ht)} · ${(r.share * 100).toFixed(1)} %`}</span>
              </div>
              <p className="mt-0.5 flex flex-wrap gap-x-2 pl-7 text-[11px] tabular-nums text-bambu-gray">
                {r.sku && <span className="min-w-0 truncate">{r.sku}</span>}
                <span>{t('revenue.analysis.rowDetail', { brand: r.brand ?? '—', cum: pct(r.cumShare) })}</span>
              </p>
            </li>
          ))}
        </ol>
      )}
      {abc.rows.length > ROWS_COLLAPSED && (
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}
          className={`mt-2 rounded text-xs text-bambu-green hover:underline ${focusRingCls}`}>
          {expanded ? t('revenue.analysis.collapse') : t('revenue.analysis.showFirst', { n: abc.rows.length })}
          {expanded && count > abc.rows.length ? ` ${t('revenue.analysis.outOf', { n: count })}` : ''}
        </button>
      )}
    </Panel>
  );
}

function Margins({ byBrand, byNature }: { byBrand: MarginRow[]; byNature: MarginRow[] }) {
  const { t } = useTranslation();
  const [dim, setDim] = useState<'brand' | 'nature'>('brand');
  const rows = (dim === 'brand' ? byBrand : byNature).filter((r) => r.ht !== 0);
  const max = Math.max(1, ...rows.map((r) => r.margin));
  const title = t('revenue.analysis.marginTitle');
  return (
    <Panel
      title={title}
      action={
        <RevenueSegmented inPanel label={t('revenue.analysis.marginBy')} value={dim} onChange={setDim}
          options={[{ id: 'brand', label: t('revenue.filters.brand') }, { id: 'nature', label: t('revenue.chart.stack.nature') }]} />
      }
    >
      {rows.length === 0 ? (
        <p className="rounded-lg bg-bambu-dark px-3 py-2 text-sm text-bambu-gray">{t('revenue.analysis.noData')}</p>
      ) : (
        <ol aria-label={title} className="grid gap-1.5 text-xs">
          {rows.map((r) => (
            <li key={r.key} className="rounded-lg bg-bambu-dark px-3 py-2">
              <div className="flex items-center gap-3">
                <span className="min-w-0 shrink basis-28 truncate text-bambu-gray-light" title={serverLabel(r.key, t)}>{serverLabel(r.key, t)}</span>
                <span className="min-w-0 flex-1" aria-hidden="true">
                  {r.margin > 0 && <span data-bar className="block h-2 min-w-[3px] rounded-[2px] bg-bambu-green" style={{ width: `${(r.margin / max) * 100}%` }} />}
                </span>
                <span className="shrink-0 whitespace-nowrap text-right tabular-nums text-bambu-gray-light">{`${r.rate == null ? '—' : pct(r.rate)} · ${formatFcp(r.margin)}`}</span>
              </div>
              {r.coverage < 0.95 && (
                <p className="mt-0.5 text-[11px] text-amber-400">{t('revenue.analysis.coverage', { pct: pct(r.coverage), amount: formatFcp(r.ht) })}</p>
              )}
            </li>
          ))}
        </ol>
      )}
      <p className="mt-2 text-[11px] text-bambu-gray">{t('revenue.analysis.marginNote')}</p>
    </Panel>
  );
}

function Dormant({ rows }: { rows: DormantRow[] }) {
  const { t, i18n } = useTranslation();
  const date = new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const title = t('revenue.analysis.dormantTitle');
  return (
    <Panel title={title}>
      <p className="mb-2 text-[11px] text-bambu-gray">{t('revenue.analysis.dormantHint')}</p>
      {rows.length === 0 ? (
        <p className="rounded-lg bg-bambu-dark px-3 py-2 text-sm text-bambu-gray">{t('revenue.analysis.none')}</p>
      ) : (
        <div role="region" aria-label={title} tabIndex={0} className={`max-h-[28rem] overflow-y-auto rounded-lg ${focusRingCls}`}>
          <Facts
            rows={rows.map((r) => ({
              label: (
                <>
                  <span className="block text-white">{r.name}</span>
                  {(r.brand || r.sku) && <span className="block text-[11px] text-bambu-gray">{[r.brand, r.sku].filter(Boolean).join(' · ')}</span>}
                </>
              ),
              value: <span>{formatFcp(r.ht)}</span>,
              note: r.lastDay ? t('revenue.analysis.lastSale', { date: date.format(new Date(`${r.lastDay}T00:00:00Z`)) }) : undefined,
            }))}
          />
        </div>
      )}
    </Panel>
  );
}

/** « Produits »: which items make the revenue (ABC), which earn it (margin), which stopped selling. */
export function RevenueAnalysis(p: { from: string; to: string; filterParams: string; version: unknown }) {
  const url = p.from && p.to ? `/api/v1/revenue/analysis?from=${p.from}&to=${p.to}${p.filterParams}` : null;
  const { data, error } = useRevenueResource<AnalysisResponse>(url, p.version);

  if (error && !data) return <Panel><p role="alert" className="text-sm text-status-error">{error}</p></Panel>;
  if (!data) {
    return (
      <>
        <Skeleton className="h-64 w-full" />
        <Split>
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </Split>
      </>
    );
  }
  return (
    <>
      <ParetoTiles abc={data.abc} />
      <Split>
        <Pareto abc={data.abc} />
        <div className="grid gap-3">
          {data.marginByBrand && data.marginByNature && <Margins byBrand={data.marginByBrand} byNature={data.marginByNature} />}
          <Dormant rows={data.dormant} />
        </div>
      </Split>
    </>
  );
}
