import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Panel } from '../aito/stats/primitives';
import { PICK_CLS } from './RevenueControls';
import { RevenueSegmented } from './RevenueSegmented';
import { dayToUtc, journalStep, journalWindow, type JournalMode } from './lib/dates';
import { formatAmount } from './lib/format';
import type { ItemsResponse, RevenueItemRow } from './lib/types';
import { useRevenueResource } from './useRevenueResource';

const NUM = 'px-3 py-1.5 text-right tabular-nums';
const sum = (rows: RevenueItemRow[], f: (r: RevenueItemRow) => number) => rows.reduce((s, r) => s + f(r), 0);

/** « Journal »: everything invoiced in one day or one month, item by item, with ‹ › to step through the periods. */
export function RevenueJournal({ today, filterParams, version }: { today: string; filterParams: string; version: unknown }) {
  const { t, i18n } = useTranslation();
  const [mode, setMode] = useState<JournalMode>('day');
  const [day, setDay] = useState(today);
  const { from, to } = journalWindow(mode, day, today);
  const url = `/api/v1/revenue/items?from=${from}&to=${to}${filterParams}`;
  const { data, dataUrl, error } = useRevenueResource<ItemsResponse>(url, version);
  const rows = dataUrl === url && data ? data.items : null;

  const label = new Intl.DateTimeFormat(
    i18n.language,
    mode === 'day' ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' } : { month: 'long', year: 'numeric', timeZone: 'UTC' },
  ).format(dayToUtc(day));
  const prev = journalStep(mode, day, -1, today);
  const next = journalStep(mode, day, 1, today);
  const current = mode === 'day' ? day === today : day.slice(0, 7) === today.slice(0, 7);
  const nav = `${PICK_CLS} px-2`;

  const group = (kind: RevenueItemRow['kind'], title: string) => {
    const list = (rows ?? []).filter((r) => r.kind === kind);
    if (list.length === 0) return null;
    return (
      <tbody data-slot={`revenue-journal-${kind}`}>
        <tr className="border-t border-bambu-dark-tertiary bg-bambu-dark/50 text-xs font-semibold text-bambu-gray-light">
          <th scope="rowgroup" colSpan={2} className="px-3 py-1.5 text-left">{title}</th>
          <td className={NUM}>{formatAmount(sum(list, (r) => r.ht))}</td>
          <td className={`${NUM} hidden sm:table-cell`}>{formatAmount(sum(list, (r) => r.ttc))}</td>
        </tr>
        {list.map((r) => (
          <tr key={r.itemId} className="border-t border-bambu-dark-tertiary/50">
            <th scope="row" className="max-w-0 px-3 py-1.5 text-left font-normal">
              <span className="block truncate text-white" title={r.name}>{r.name}</span>
              <span className="block truncate text-[11px] text-bambu-gray">{[r.nature, r.brand, r.sku].filter(Boolean).join(' · ')}</span>
            </th>
            <td className={NUM}>{r.quantity}</td>
            <td className={NUM}>{formatAmount(r.ht)}</td>
            <td className={`${NUM} hidden sm:table-cell`}>{formatAmount(r.ttc)}</td>
          </tr>
        ))}
      </tbody>
    );
  };

  return (
    <Panel
      title={<RevenueSegmented inPanel label={t('revenue.controls.granularity')} value={mode} onChange={setMode}
        options={[{ id: 'day', label: t('revenue.controls.day') }, { id: 'month', label: t('revenue.controls.month') }]} />}
      action={
        <div className="flex items-center gap-1.5">
          <button type="button" className={nav} aria-label={t('revenue.controls.prev')} title={t('revenue.controls.prev')} disabled={!prev} onClick={() => prev && setDay(prev)}>
            <ChevronLeft aria-hidden className="h-4 w-4" />
          </button>
          <span aria-live="polite" data-slot="revenue-journal-period" className="min-w-40 text-center text-sm font-semibold text-white first-letter:uppercase">{label}</span>
          <button type="button" className={nav} aria-label={t('revenue.controls.next')} title={t('revenue.controls.next')} disabled={!next} onClick={() => next && setDay(next)}>
            <ChevronRight aria-hidden className="h-4 w-4" />
          </button>
          {!current && (
            <button type="button" className={PICK_CLS} onClick={() => setDay(today)}>
              {mode === 'day' ? t('settings.today') : t('revenue.pace.thisMonth')}
            </button>
          )}
        </div>
      }
    >
      {error && !rows ? (
        <p role="alert" className="py-6 text-center text-sm text-status-error">{error}</p>
      ) : !rows ? (
        <p className="py-6 text-center text-sm text-bambu-gray">{t('revenue.state.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-bambu-gray">{t('revenue.table.empty')}</p>
      ) : (
        <>
          <dl className="mb-3 flex flex-wrap gap-x-8 gap-y-2">
            {[
              [t('revenue.table.ht'), formatAmount(sum(rows, (r) => r.ht))],
              [t('revenue.table.units'), sum(rows, (r) => r.quantity)],
              [t('revenue.views.journalReferences'), rows.length],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-[11px] uppercase tracking-wide text-bambu-gray">{k}</dt>
                <dd className="text-xl font-semibold tabular-nums text-white">{v}</dd>
              </div>
            ))}
          </dl>
          <table className="w-full table-fixed text-sm text-bambu-gray-light">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-bambu-gray">
                <th scope="col" className="px-3 py-1.5 text-left font-normal">{t('revenue.chart.stack.item')}</th>
                <th scope="col" className={`${NUM} w-16 font-normal`}>{t('revenue.table.units')}</th>
                <th scope="col" className={`${NUM} w-28 font-normal`}>{t('revenue.table.ht')}</th>
                <th scope="col" className={`${NUM} hidden w-28 font-normal sm:table-cell`}>{t('revenue.table.ttc')}</th>
              </tr>
            </thead>
            {group('goods', t('revenue.filters.goods'))}
            {group('service', t('revenue.filters.services'))}
            <tfoot>
              <tr className="border-t border-bambu-dark-tertiary font-bold text-white">
                <th scope="row" className="px-3 py-2 text-left">{t('settings.total')}</th>
                <td className={NUM}>{sum(rows, (r) => r.quantity)}</td>
                <td className={NUM}>{formatAmount(sum(rows, (r) => r.ht))}</td>
                <td className={`${NUM} hidden sm:table-cell`}>{formatAmount(sum(rows, (r) => r.ttc))}</td>
              </tr>
            </tfoot>
          </table>
        </>
      )}
    </Panel>
  );
}
