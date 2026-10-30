import { useTranslation } from 'react-i18next';
import { ArrowDownUp, ChevronDown } from 'lucide-react';
import { DONE_FILTERS, DONE_SORTS, type DoneFilter, type DoneSort, type WinLoss } from '../../utils/aitoDoneArchive';
import { DONE_OUTCOME_CLS } from './doneOutcome';

/** The sort menu's label per entry. The finished dimension is the one word
 *  that differs between the two archives — Done finishes cards, Trash
 *  deletes them — and the values stay the same so one URL parameter and one
 *  remembered preference serve both. */
const SORT_LABEL_KEY: Record<'finished' | 'deleted', Record<DoneSort, string>> = {
  finished: {
    finishedDesc: 'aito.doneArchive.finishedDesc',
    finishedAsc: 'aito.doneArchive.finishedAsc',
    createdDesc: 'aito.doneArchive.createdDesc',
    createdAsc: 'aito.doneArchive.createdAsc',
    amountDesc: 'aito.doneArchive.amountDesc',
    clientAsc: 'aito.doneArchive.clientAsc',
  },
  deleted: {
    finishedDesc: 'aito.doneArchive.deletedDesc',
    finishedAsc: 'aito.doneArchive.deletedAsc',
    createdDesc: 'aito.doneArchive.createdDesc',
    createdAsc: 'aito.doneArchive.createdAsc',
    amountDesc: 'aito.doneArchive.amountDesc',
    clientAsc: 'aito.doneArchive.clientAsc',
  },
};

/** The archives' controls: an outcome pill row (Done only), the win/loss
 *  figure it implies, and one sort menu.
 *
 *  Pills, not a select, for the outcome: there are five, each with a count,
 *  and the count is half the point — "how many did we lose" is read off the
 *  Declined pill without pressing it. One pill at a time, like the board's
 *  follow-up strip: these are "show only" questions, and two at once
 *  ("declined AND shipped") is never one anyone asks. A pill whose count is 0
 *  is disabled rather than hidden so the row never reflows as a search is
 *  typed — except the pressed one, which must stay pressable to be released.
 *
 *  A native select for the sort: six entries, one chosen, and it has to work
 *  on the phone board too, where a custom menu is the worse control. */
export function ArchiveToolbar({
  counts,
  filter,
  onFilter,
  winLoss,
  sort,
  onSort,
  dateLabel,
}: {
  /** The pill counts. Omitted (Trash) → no pill row. */
  counts?: Record<DoneFilter, number>;
  filter?: DoneFilter;
  onFilter?: (next: DoneFilter) => void;
  /** Accepted against declined over the pills' set, or null when nothing
   *  was decided either way. */
  winLoss?: WinLoss | null;
  sort: DoneSort;
  onSort: (next: DoneSort) => void;
  dateLabel: 'finished' | 'deleted';
}) {
  const { t } = useTranslation();
  const labels = SORT_LABEL_KEY[dateLabel];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pb-3 flex-none">
      {counts && filter && onFilter && (
        <div
          role="group"
          aria-label={t('aito.doneArchive.filterLabel')}
          className="flex flex-wrap items-center gap-1.5 min-w-0"
          onKeyDown={(e) => {
            if (e.key === 'Escape' && filter !== 'all') onFilter('all');
          }}
        >
          {DONE_FILTERS.map((key) => {
            const pressed = filter === key;
            const empty = counts[key] === 0 && !pressed && key !== 'all';
            return (
              <button
                key={key}
                type="button"
                data-testid={`aito-done-filter-${key}`}
                aria-pressed={pressed}
                disabled={empty}
                onClick={() => onFilter(pressed ? 'all' : key)}
                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 whitespace-nowrap transition-[filter,box-shadow,opacity] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current ${
                  DONE_OUTCOME_CLS[key]
                } ${pressed ? 'ring-2 ring-current' : 'hover:brightness-110'} ${empty ? 'opacity-40 cursor-default' : ''}`}
              >
                <span className="text-[11px] font-semibold uppercase tracking-wider">{t(`aito.doneArchive.${key}`)}</span>
                {/* Keyed on the count so the value-tick replays when the
                    search changes it — the same treatment the header's
                    counts get. */}
                <span key={counts[key]} className="text-sm font-bold leading-none tabular-nums animate-value-tick">
                  {counts[key]}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {winLoss && (
        <span
          data-testid="aito-done-winloss"
          title={t('aito.doneArchive.winLossHint')}
          className="text-xs text-bambu-gray tabular-nums whitespace-nowrap"
        >
          {t('aito.doneArchive.winLoss', { won: winLoss.won, lost: winLoss.lost, rate: winLoss.rate })}
        </span>
      )}
      <label className="relative inline-flex items-center ml-auto text-sm text-bambu-gray-light">
        <ArrowDownUp aria-hidden="true" className="absolute left-3 w-4 h-4 pointer-events-none" />
        <span className="sr-only">{t('aito.doneArchive.sortLabel')}</span>
        <select
          data-testid="aito-done-sort"
          value={sort}
          onChange={(event) => onSort(event.target.value as DoneSort)}
          className="appearance-none pl-9 pr-8 py-2 rounded-lg bg-bambu-dark-secondary border border-bambu-dark-tertiary text-sm text-white transition-colors focus:outline-none focus:border-bambu-green/50 cursor-pointer"
        >
          {DONE_SORTS.map((key) => (
            <option key={key} value={key}>
              {t(labels[key])}
            </option>
          ))}
        </select>
        <ChevronDown aria-hidden="true" className="absolute right-3 w-3.5 h-3.5 pointer-events-none" />
      </label>
    </div>
  );
}
