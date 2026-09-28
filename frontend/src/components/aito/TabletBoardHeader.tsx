import type { ReactNode, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Kanban, MoreHorizontal, Plus } from 'lucide-react';
import { Button } from '../Button';
import { BoardSearch } from './BoardSearch';
import type { ColumnSummary } from '../../utils/aitoMobileBoard';

/** The tablet board's one header row: the visible range (tap to pick
 *  columns), the in-production count, compact follow-up badges, search, the
 *  detours behind ⋯, and + Projet. */
export function TabletBoardHeader({
  columns,
  from,
  to,
  pending,
  inProduction,
  followups,
  search,
  onSearchChange,
  onOpenColumns,
  columnsOpen,
  onOpenMore,
  moreOpen,
  rangeRef,
  moreRef,
  canCreate,
  onNewProject,
}: {
  columns: ColumnSummary[];
  from: number;
  to: number;
  pending: boolean;
  inProduction: number;
  followups: ReactNode;
  search: string;
  onSearchChange: (value: string) => void;
  onOpenColumns: () => void;
  columnsOpen: boolean;
  onOpenMore: () => void;
  moreOpen: boolean;
  rangeRef: RefObject<HTMLButtonElement | null>;
  moreRef: RefObject<HTMLButtonElement | null>;
  canCreate: boolean;
  onNewProject: () => void;
}) {
  const { t } = useTranslation();
  const a = columns[from].column;
  const b = columns[to].column;
  return (
    <div className="flex-none flex items-center gap-2 px-4 pt-3 pb-2.5 min-w-0">
      <Kanban className="w-5 h-5 flex-none text-bambu-green" aria-hidden="true" />
      <button
        ref={rangeRef}
        type="button"
        data-testid="aito-tablet-range"
        onClick={onOpenColumns}
        aria-haspopup="dialog"
        aria-expanded={columnsOpen}
        aria-label={t('aito.tablet.range', { from: t(a.labelKey), to: t(b.labelKey) })}
        className="flex items-center gap-2 min-w-0 px-2 py-1.5 rounded-lg text-[15px] font-bold text-white hover:bg-bambu-dark-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
      >
        <span aria-hidden="true" className={`w-2 h-2 flex-none rounded-full ${a.dot}`} />
        <span className="truncate">{t(a.labelKey)}</span>
        <span aria-hidden="true" className="text-bambu-gray font-medium">
          →
        </span>
        <span aria-hidden="true" className={`w-2 h-2 flex-none rounded-full ${b.dot}`} />
        <span className="truncate">{t(b.labelKey)}</span>
        <ChevronDown className="w-3.5 h-3.5 flex-none text-bambu-gray" aria-hidden="true" />
      </button>
      <span className="flex-none px-2 py-0.5 text-xs font-medium text-bambu-gray-light bg-bambu-dark-tertiary rounded-full tabular-nums">
        <span aria-hidden="true">{pending ? '–' : inProduction}</span>
        <span className="sr-only">{t('aito.inProduction', { count: inProduction })}</span>
      </span>
      <span className="flex-1" />
      {followups}
      <BoardSearch value={search} onChange={onSearchChange} className="w-[190px] flex-none" />
      <button
        ref={moreRef}
        type="button"
        onClick={onOpenMore}
        aria-haspopup="menu"
        aria-expanded={moreOpen}
        aria-label={t('aito.mobile.moreOptions')}
        className="grid place-items-center w-9 h-9 flex-none rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary text-bambu-gray-light hover:text-white"
      >
        <MoreHorizontal className="w-5 h-5" aria-hidden="true" />
      </button>
      {canCreate && (
        <Button onClick={onNewProject} className="flex-none">
          <Plus className="w-4 h-4 mr-2" />
          {t('aito.newProject')}
        </Button>
      )}
    </div>
  );
}
