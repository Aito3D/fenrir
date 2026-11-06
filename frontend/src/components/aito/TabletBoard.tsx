import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, FileInput } from 'lucide-react';
import type { AitoProject } from '../../api/client';
import type { ColumnMeta } from './columns';
import { BoardColumnBody } from './BoardColumnBody';
import { moreMenuViewItems, useColumnSummaries } from './touchBoardHelpers';
import { ColumnList } from './ColumnList';
import { ColumnStrip } from './ColumnStrip';
import { ColumnCountPill, OldestCardChip } from './MobileBoardHeader';
import { ActionMenu } from './ActionMenu';
import { TabletBoardHeader } from './TabletBoardHeader';
import { visibleCount, TABLET_GAP_PX, type ColumnSummary } from '../../utils/aitoMobileBoard';
import { TABLET_FIRST_STORAGE_KEY, useMobileColumn } from '../../hooks/useMobileColumn';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import { useSnapPager } from '../../hooks/useSnapPager';

/** Px between two columns' resting positions (their width plus the gap). */
function columnPitch(pager: HTMLElement) {
  const cols = pager.querySelectorAll<HTMLElement>('[data-index]');
  if (cols.length < 2) return 1;
  return cols[1].offsetLeft - cols[0].offsetLeft || 1;
}

export interface TabletBoardProps {
  columns: { column: ColumnMeta; projects: AitoProject[] }[];
  now: number;
  pending: boolean;
  loadingPill: ReactNode;
  filtering: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  onExpandCard: (id: number) => void;
  /** `<FollowupStrip compact …/>`, built by the page that owns its state. */
  followups: ReactNode;
  inProduction: number;
  /** Caption of the ⋯ menu: the in-production count and the backlog. */
  heading: ReactNode;
  doneCount: number;
  onShowView: (view: 'done' | 'trash' | 'stats') => void;
  canCreate: boolean;
  onImport: () => void;
  onNewProject: () => void;
}

/** Every column in one list, anchored under the range picker. Mount only
 *  while open. */
function TabletColumnPopover({
  columns,
  from,
  to,
  pending,
  anchorRef,
  onPick,
  onClose,
}: {
  columns: ColumnSummary[];
  from: number;
  to: number;
  pending: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onPick: (index: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { closing, requestClose, dialogRef } = useDismissableDialog(onClose, { animationMs: 120 });
  // Measured once, at open: the picker does not move while its popover is up.
  const [position] = useState<CSSProperties>(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    return rect && rect.bottom > 0 ? { top: rect.bottom + 6, left: Math.max(8, rect.left) } : { top: 104, left: 16 };
  });
  return (
    <div className="fixed inset-0 z-50">
      <div
        onClick={requestClose}
        className={`absolute inset-0 bg-black/30 ${closing ? 'animate-overlay-out' : 'animate-overlay-in'}`}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('aito.mobile.columns')}
        tabIndex={-1}
        style={position}
        className={`absolute w-[340px] max-w-[calc(100vw-16px)] rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-1.5 shadow-2xl origin-top-left focus:outline-none ${
          closing ? 'animate-pop-out' : 'animate-pop-in'
        }`}
      >
        <ColumnList
          columns={columns}
          from={from}
          to={to}
          pending={pending}
          onPick={(index) => {
            onPick(index);
            requestClose();
          }}
        />
      </div>
    </div>
  );
}

type Overlay = 'columns' | 'more' | null;

/** The tablet board (spec: docs/superpowers/specs/2026-09-27-aito-tablet-board-design.md).
 *
 *  A snapping window of 2–4 full columns, sized from the width the board
 *  actually gets (an open sidebar, a rotation, split screen all adapt). Each
 *  column scrolls inside itself — the page is exactly the viewport under the
 *  shell, for the same reason as the phone board. No drag. */
export function TabletBoard({
  columns,
  now,
  pending,
  loadingPill,
  filtering,
  search,
  onSearchChange,
  onExpandCard,
  followups,
  inProduction,
  heading,
  doneCount,
  onShowView,
  canCreate,
  onImport,
  onNewProject,
}: TabletBoardProps) {
  const { t } = useTranslation();
  const ids = useMemo(() => columns.map(({ column }) => column.id), [columns]);
  const [first, setFirst] = useMobileColumn(ids, TABLET_FIRST_STORAGE_KEY);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [boardWidth, setBoardWidth] = useState(0);
  const rangeRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);

  const k = visibleCount(boardWidth || 900);
  const maxFirst = Math.max(0, columns.length - k);
  const start = Math.min(first, maxFirst);
  const end = start + k - 1;

  const summaries = useColumnSummaries(columns, now);

  // Pages are the possible first columns; the clamp lives here, NOT in the
  // stored value: writing it back saved the provisional pre-measure clamp on
  // mount, and lost the place on a 2 -> 4 -> 2 rotation.
  const adoptFirst = useCallback((index: number) => setFirst(Math.min(index, maxFirst)), [setFirst, maxFirst]);
  const { pagerRef, jump, alignTo, endJump, handlers: pagerHandlers } = useSnapPager(maxFirst + 1, start, adoptFirst, columnPitch);

  // The board's own width, not the viewport's: that is what an open sidebar
  // or a split screen changes.
  useLayoutEffect(() => {
    const pager = pagerRef.current;
    if (!pager) return;
    const measure = () => setBoardWidth(pager.getBoundingClientRect().width);
    measure();
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(pager);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [pagerRef]);

  // The column pitch is in px, so after every width the board is measured at
  // (the hook only sees window resizes) put the window back on its columns.
  // Nothing runs until the board has been measured.
  useLayoutEffect(() => {
    if (!boardWidth) return;
    alignTo(start);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs on size changes only; `start` is read fresh
  }, [boardWidth, k]);

  const scrollToFirst = (index: number, smooth: boolean) => jump(Math.min(Math.max(index, 0), maxFirst), smooth);

  const ensureVisible = (index: number) => {
    if (index < start) scrollToFirst(index, true);
    else if (index > end) scrollToFirst(index - k + 1, true);
  };

  const closeOverlay = (returnTo: HTMLElement | null) => {
    setOverlay(null);
    returnTo?.focus();
  };

  const arrowCls =
    'absolute top-1/2 -translate-y-1/2 z-10 grid place-items-center w-9 h-9 rounded-full border border-bambu-dark-tertiary bg-bambu-dark-tertiary/90 text-white shadow-lg';

  return (
    <div data-testid="aito-tablet-board" className="flex-1 min-h-0 flex flex-col">
      <TabletBoardHeader
        columns={summaries}
        from={start}
        to={end}
        pending={pending}
        inProduction={inProduction}
        followups={followups}
        search={search}
        onSearchChange={onSearchChange}
        onOpenColumns={() => setOverlay('columns')}
        columnsOpen={overlay === 'columns'}
        onOpenMore={() => setOverlay('more')}
        moreOpen={overlay === 'more'}
        rangeRef={rangeRef}
        moreRef={moreRef}
        canCreate={canCreate}
        onNewProject={onNewProject}
      />
      <ColumnStrip columns={summaries} from={start} to={end} onJump={ensureVisible} className="mx-4" />

      <div className="relative flex-1 min-h-0">
        <div
          ref={pagerRef}
          data-testid="aito-tablet-pager"
          aria-busy={pending || undefined}
          {...pagerHandlers}
          // Any scroll the user starts — finger, trackpad, keyboard — takes
          // over from a smooth jump still in flight; a trackpad fires no
          // pointerdown, so without onWheel the header could stay on the
          // jump's target while the pager sits elsewhere.
          onWheel={endJump}
          onKeyDown={endJump}
          className={`h-full flex gap-3 overflow-x-auto overflow-y-hidden snap-x snap-mandatory overscroll-x-contain scrollbar-hide px-4 pt-3 pb-4 scroll-px-4 transition-opacity duration-300 ${
            pending ? 'opacity-40' : ''
          }`}
        >
          {columns.map(({ column, projects }, index) => (
            <section
              key={column.id}
              data-testid={`aito-tablet-col-${column.id}`}
              data-index={index}
              aria-label={t(column.labelKey)}
              style={{ width: `calc((100% - 30px - ${(k - 1) * TABLET_GAP_PX}px) / ${k})` }}
              className="flex-none snap-start flex flex-col min-h-0 rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary/40"
            >
              <div className="flex items-center gap-2 px-3 py-2.5 border-b border-bambu-dark-tertiary/60">
                <span aria-hidden="true" className={`w-2 h-2 flex-none rounded-full ${column.dot}`} />
                <h2 className="flex-1 min-w-0 truncate text-sm font-semibold text-white">{t(column.labelKey)}</h2>
                {!pending && <OldestCardChip summary={summaries[index]} />}
                <ColumnCountPill count={projects.length} pending={pending} />
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain scrollbar-hide p-2 flex flex-col gap-2">
                <BoardColumnBody projects={projects} pending={pending} filtering={filtering} onExpandCard={onExpandCard} />
              </div>
            </section>
          ))}
        </div>
        {start > 0 && (
          <button
            type="button"
            onClick={() => scrollToFirst(start - 1, true)}
            aria-label={t('aito.tablet.previousColumn')}
            className={`${arrowCls} left-2`}
          >
            <ChevronLeft className="w-5 h-5" aria-hidden="true" />
          </button>
        )}
        {end < columns.length - 1 && (
          <button
            type="button"
            onClick={() => scrollToFirst(start + 1, true)}
            aria-label={t('aito.tablet.nextColumn')}
            className={`${arrowCls} right-2`}
          >
            <ChevronRight className="w-5 h-5" aria-hidden="true" />
          </button>
        )}
        {loadingPill}
      </div>

      {overlay === 'columns' && (
        <TabletColumnPopover
          columns={summaries}
          from={start}
          to={end}
          pending={pending}
          anchorRef={rangeRef}
          onPick={ensureVisible}
          onClose={() => closeOverlay(rangeRef.current)}
        />
      )}
      {overlay === 'more' && (
        <ActionMenu
          label={t('aito.mobile.moreOptions')}
          anchorRef={moreRef}
          placement="below"
          caption={heading}
          items={[
            ...moreMenuViewItems(t, pending, doneCount, onShowView),
            { key: 'import', icon: FileInput, label: t('aito.importQuote'), onSelect: onImport },
          ]}
          onClose={() => closeOverlay(moreRef.current)}
        />
      )}
    </div>
  );
}
