import { useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, MoreHorizontal, Search, X } from 'lucide-react';
import type { ColumnSummary } from '../../utils/aitoMobileBoard';

export function ColumnCountPill({ count, pending }: { count: number; pending: boolean }) {
  return (
    <span
      className={`min-w-[1.5rem] px-1.5 py-0.5 text-center text-xs font-medium bg-bambu-dark-tertiary rounded-full tabular-nums ${
        pending ? 'text-bambu-gray' : 'text-bambu-gray-light'
      }`}
    >
      {pending ? '–' : count}
    </span>
  );
}

/** Age of the column's oldest card, on the cards' own heat ramp. */
export function OldestCardChip({ summary }: { summary: ColumnSummary }) {
  const { t } = useTranslation();
  if (summary.oldestDays === null) return null;
  return (
    <span
      data-testid="aito-mobile-oldest"
      title={t('aito.mobile.oldestCard')}
      className={`flex-none px-1.5 py-0.5 rounded-full bg-bambu-dark-tertiary text-[11px] font-semibold tabular-nums ${summary.oldestCls}`}
    >
      <span className="sr-only">{t('aito.mobile.oldestCard')} </span>
      {t('aito.followups.longest', { days: summary.oldestDays })}
    </span>
  );
}

export interface MobileBoardHeaderProps {
  columns: ColumnSummary[];
  current: number;
  pending: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  onJump: (index: number) => void;
  onOpenColumns: () => void;
  columnsOpen: boolean;
  onOpenMore: () => void;
  moreOpen: boolean;
  pickerRef: RefObject<HTMLButtonElement | null>;
  moreRef: RefObject<HTMLButtonElement | null>;
}

/** The phone board's one header row: which column you are on (tap for the
 *  column sheet), how old its oldest card is, search behind a magnifier, and
 *  the detours behind ⋯. Its bottom edge is the six-segment strip — the whole
 *  board's load at a glance, and a second way (with the sheet) to reach any
 *  column without swiping. */
export function MobileBoardHeader({
  columns,
  current,
  pending,
  search,
  onSearchChange,
  onJump,
  onOpenColumns,
  columnsOpen,
  onOpenMore,
  moreOpen,
  pickerRef,
  moreRef,
}: MobileBoardHeaderProps) {
  const { t } = useTranslation();
  const [searchOpen, setSearchOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const active = columns[current];

  useEffect(() => {
    if (searchOpen) inputRef.current?.focus({ preventScroll: true });
  }, [searchOpen]);

  const closeSearch = () => {
    setSearchOpen(false);
    searchButtonRef.current?.focus();
  };

  return (
    <div data-testid="aito-mobile-header" className="flex-none bg-bambu-dark">
      <div className="flex items-center gap-1.5 h-11 pl-4 pr-2">
        <button
          ref={pickerRef}
          type="button"
          onClick={onOpenColumns}
          aria-haspopup="dialog"
          aria-expanded={columnsOpen}
          className="flex items-center gap-2 -ml-2 px-2 py-1.5 min-w-0 rounded-lg text-[15px] font-bold text-white active:bg-bambu-dark-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
        >
          <span aria-hidden="true" className={`w-2 h-2 flex-none rounded-full ${active.column.dot}`} />
          <span className="truncate">{t(active.column.labelKey)}</span>
          <ColumnCountPill count={active.count} pending={pending} />
          <ChevronDown className="w-3.5 h-3.5 flex-none text-bambu-gray" aria-hidden="true" />
          <span className="sr-only">{t('aito.mobile.pickColumn')}</span>
        </button>
        {!pending && <OldestCardChip summary={active} />}
        <span className="flex-1" />
        <button
          ref={searchButtonRef}
          type="button"
          onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          aria-expanded={searchOpen}
          aria-label={t('common.search')}
          className={`relative grid place-items-center w-9 h-9 rounded-lg transition-colors ${
            searchOpen ? 'bg-bambu-green/15 text-bambu-green' : 'text-bambu-gray-light active:bg-bambu-dark-secondary'
          }`}
        >
          <Search className="w-[18px] h-[18px]" aria-hidden="true" />
          {!searchOpen && search.trim() !== '' && (
            <span
              data-testid="aito-mobile-search-dot"
              aria-hidden="true"
              className="absolute top-1.5 right-1.5 w-[7px] h-[7px] rounded-full bg-bambu-green ring-2 ring-bambu-dark"
            />
          )}
        </button>
        <button
          ref={moreRef}
          type="button"
          onClick={onOpenMore}
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          aria-label={t('aito.mobile.moreOptions')}
          className="grid place-items-center w-9 h-9 rounded-lg text-bambu-gray-light active:bg-bambu-dark-secondary"
        >
          <MoreHorizontal className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>

      {/* Collapsible search row: grid 0fr -> 1fr so the height animates
          without measuring. `inert` while closed keeps the hidden input out of
          the tab order and away from screen readers. */}
      <div
        inert={!searchOpen || undefined}
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-(--ease-signature) motion-reduce:transition-opacity ${
          searchOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="mx-3 mb-2.5 flex items-center gap-2 h-10 rounded-lg border border-bambu-green/40 bg-bambu-dark-secondary pl-3 pr-1">
            <Search className="w-4 h-4 flex-none text-bambu-gray" aria-hidden="true" />
            <input
              ref={inputRef}
              data-testid="aito-mobile-search"
              type="search"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  closeSearch();
                }
              }}
              placeholder={t('aito.searchPlaceholder')}
              aria-label={t('aito.searchPlaceholder')}
              className="flex-1 min-w-0 bg-transparent text-sm text-white placeholder:text-bambu-gray outline-none"
            />
            <button
              type="button"
              onClick={() => {
                onSearchChange('');
                closeSearch();
              }}
              aria-label={t('aito.clearSearch')}
              className="grid place-items-center w-8 h-8 rounded-md text-bambu-gray active:bg-bambu-dark-tertiary"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      {/* The strip: the header's bottom edge. Each segment is a real button
          with a taller invisible hit area (the ::after) so a 3 px line is
          still tappable. */}
      <div className="flex gap-0.5 h-[3px]">
        {columns.map((summary, index) => (
          <button
            key={summary.column.id}
            type="button"
            data-testid={`aito-mobile-segment-${summary.column.id}`}
            onClick={() => onJump(index)}
            aria-current={index === current ? 'true' : undefined}
            aria-label={t('aito.mobile.segment', { column: t(summary.column.labelKey), count: summary.count })}
            style={{ flexGrow: Math.max(summary.count, 0.4) }}
            className={`relative basis-0 min-w-3 h-full ${summary.column.dot} transition-[opacity,flex-grow] duration-200 motion-reduce:transition-none after:absolute after:inset-x-0 after:-top-3 after:-bottom-1 after:content-[''] ${
              index === current ? 'opacity-100' : 'opacity-25'
            }`}
          />
        ))}
      </div>
    </div>
  );
}
