import { useTranslation } from 'react-i18next';
import { Check, List, Printer, Snail } from 'lucide-react';
import { Sheet } from '../../mobile/Sheet';
import { focusRingCls } from '../../formStyles';
import { QUEUE_FILTER_STATUSES, hasActiveQueueFilter } from './queueFilters';

export interface QueueFilterSheetProps {
  printers: ReadonlyArray<{ id: number; name: string }>;
  /** -1 = unassigned, null = all. */
  filterPrinter: number | null;
  onFilterPrinter: (value: number | null) => void;
  /** '' = all. */
  filterStatus: string;
  onFilterStatus: (value: string) => void;
  locations: ReadonlyArray<string>;
  /** '' = all. */
  filterLocation: string;
  onFilterLocation: (value: string) => void;
  /** Queue tab only: the layout toggle + SJF. Omit on other tabs. */
  view?: {
    layout: 'position' | 'printer';
    onLayout: (value: 'position' | 'printer') => void;
    sjf: boolean;
    onSjf: (value: boolean) => void;
  };
  onClose: () => void;
}

const sectionCls = 'px-1 pt-3 pb-1 text-[11px] uppercase tracking-wide text-bambu-gray';
const listCls = 'divide-y divide-bambu-dark-tertiary rounded-xl border border-bambu-dark-tertiary';

function CheckList<T extends string | number | null>({
  label,
  items,
  value,
  onPick,
}: {
  label: string;
  items: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onPick: (value: T) => void;
}) {
  return (
    <>
      <div className={sectionCls}>{label}</div>
      <ul role="group" aria-label={label} className={listCls}>
        {items.map((item) => {
          const active = item.value === value;
          return (
            <li key={String(item.value)}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => onPick(item.value)}
                className={`flex w-full items-center justify-between px-3 py-2.5 text-[15px] ${active ? 'text-white' : 'text-bambu-gray'} ${focusRingCls}`}
              >
                {item.label}
                {active && <Check className="h-4 w-4 text-bambu-green" aria-hidden />}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** The three queue filters (printer / status / location) as check lists, and
 *  on the Queue tab a View section: the layout toggle and the SJF switch.
 *  Replaces the desktop selects and controls row on a phone. */
export function QueueFilterSheet({
  printers,
  filterPrinter,
  onFilterPrinter,
  filterStatus,
  onFilterStatus,
  locations,
  filterLocation,
  onFilterLocation,
  view,
  onClose,
}: QueueFilterSheetProps) {
  const { t } = useTranslation();
  const reset = () => {
    onFilterPrinter(null);
    onFilterStatus('');
    onFilterLocation('');
  };
  return (
    <Sheet label={t('queue.mobile.filters')} testId="queue-filter-sheet" onClose={onClose}>
      {(close) => (
        <div className="max-h-[70dvh] overflow-y-auto overscroll-contain">
          <div className="flex items-center justify-between px-1">
            <span className="text-[15px] font-bold text-white">{t('queue.mobile.filters')}</span>
            <button
              type="button"
              onClick={reset}
              disabled={!hasActiveQueueFilter(filterPrinter, filterStatus, filterLocation)}
              className={`btn-press rounded-lg px-2 py-1 text-sm text-bambu-green disabled:text-bambu-gray ${focusRingCls}`}
            >
              {t('common.reset')}
            </button>
          </div>

          <CheckList
            label={t('common.printer')}
            value={filterPrinter}
            onPick={onFilterPrinter}
            items={[
              { value: null, label: t('queue.filter.allPrinters') },
              { value: -1, label: t('queue.filter.unassigned') },
              ...printers.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
          <CheckList
            label={t('common.status')}
            value={filterStatus}
            onPick={onFilterStatus}
            items={[
              { value: '', label: t('queue.filter.allStatus') },
              ...QUEUE_FILTER_STATUSES.map((s) => ({ value: s, label: t(`queue.status.${s}`) })),
            ]}
          />
          {locations.length > 0 && (
            <CheckList
              label={t('queue.mobile.location')}
              value={filterLocation}
              onPick={onFilterLocation}
              items={[{ value: '', label: t('queue.filter.allLocations') }, ...locations.map((l) => ({ value: l, label: l }))]}
            />
          )}

          {view && (
            <>
              <div className={sectionCls}>{t('queue.mobile.view')}</div>
              <div role="group" aria-label={t('queue.mobile.view')} className="flex flex-col gap-2">
                <div className="flex gap-1 rounded-xl bg-bambu-dark p-1">
                  {(['position', 'printer'] as const).map((layout) => (
                    <button
                      key={layout}
                      type="button"
                      aria-pressed={view.layout === layout}
                      onClick={() => view.onLayout(layout)}
                      className={`btn-press flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg text-sm ${
                        view.layout === layout ? 'bg-bambu-dark-secondary text-white shadow-sm' : 'text-bambu-gray'
                      } ${focusRingCls}`}
                    >
                      {layout === 'position' ? <List className="h-3.5 w-3.5" aria-hidden /> : <Printer className="h-3.5 w-3.5" aria-hidden />}
                      {layout === 'position' ? t('queue.layout.flatList') : t('queue.layout.byPrinter')}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={view.sjf}
                  onClick={() => view.onSjf(!view.sjf)}
                  title={t('queue.sjf.tooltip')}
                  className={`flex items-center justify-between rounded-xl border px-3 py-2.5 text-[15px] ${
                    view.sjf ? 'border-bambu-green/60 bg-bambu-green/10 text-bambu-green' : 'border-bambu-dark-tertiary text-bambu-gray'
                  } ${focusRingCls}`}
                >
                  <span className="flex items-center gap-2">
                    <Snail className="h-4 w-4" aria-hidden />
                    {t('queue.sjf.label')}
                  </span>
                  <span aria-hidden className={`h-2 w-2 rounded-full ${view.sjf ? 'bg-bambu-green' : 'bg-bambu-gray'}`} />
                </button>
              </div>
            </>
          )}

          <button type="button" onClick={close} className={`btn-press mt-4 h-11 w-full rounded-xl bg-bambu-green font-medium text-white ${focusRingCls}`}>
            {t('common.close')}
          </button>
        </div>
      )}
    </Sheet>
  );
}
