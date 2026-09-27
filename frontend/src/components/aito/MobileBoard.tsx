import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, BarChart3, FileInput, Plus, Trash2 } from 'lucide-react';
import type { AitoProject } from '../../api/client';
import type { ColumnMeta } from './columns';
import { CardView } from './CardView';
import { BoardCardActions } from './BoardCardActions';
import { MobileBoardHeader } from './MobileBoardHeader';
import { MobileColumnSheet } from './MobileColumnSheet';
import { MobileMenu } from './MobileMenu';
import { summariseColumn } from '../../utils/aitoMobileBoard';
import { useMobileColumn } from '../../hooks/useMobileColumn';
import { useIsReverting } from '../../hooks/useRevertFlash';
import { isPlaceholder } from '../../utils/aitoOptimistic';
import { prefersReducedMotion } from '../../utils/motion';

export interface MobileBoardProps {
  columns: { column: ColumnMeta; projects: AitoProject[] }[];
  now: number;
  pending: boolean;
  loadingPill: ReactNode;
  filtering: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  onExpandCard: (id: number) => void;
  heading: ReactNode;
  doneCount: number;
  onShowView: (view: 'done' | 'trash' | 'stats') => void;
  canCreate: boolean;
  onImport: () => void;
  onNewProject: () => void;
  hideFab: boolean;
}

/** One card on the phone board: the compact CardView with the board's own
 *  footer actions, no sortable wrapper. */
function MobileCard({ project, onExpand }: { project: AitoProject; onExpand: () => void }) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const reverting = useIsReverting(project.id);
  const placeholder = isPlaceholder(project);
  return (
    <div ref={cardRef} className={reverting ? 'animate-revert-flash' : ''}>
      <CardView
        project={project}
        placeholder={placeholder}
        onExpand={onExpand}
        compact
        actions={<BoardCardActions project={project} cardRef={cardRef} />}
      />
    </div>
  );
}

type Overlay = 'columns' | 'more' | 'create' | null;

/** The phone board (spec: docs/superpowers/specs/2026-09-27-aito-mobile-board-design.md).
 *
 *  One column at a time: a horizontal scroll-snap pager, one full-width page
 *  per column, each page scrolling vertically inside itself — the board is
 *  exactly the viewport under the shell's top bar, so the header never
 *  scrolls away and nothing depends on `position: sticky` (which cannot
 *  engage inside the shell's unbounded `overflow-auto` <main>). No drag:
 *  a card's column is derived by the rule engine, and moves happen from the
 *  panel. */
export function MobileBoard({
  columns,
  now,
  pending,
  loadingPill,
  filtering,
  search,
  onSearchChange,
  onExpandCard,
  heading,
  doneCount,
  onShowView,
  canCreate,
  onImport,
  onNewProject,
  hideFab,
}: MobileBoardProps) {
  const { t } = useTranslation();
  const ids = useMemo(() => columns.map(({ column }) => column.id), [columns]);
  const [current, setCurrent] = useMobileColumn(ids);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const pagerRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const fabRef = useRef<HTMLButtonElement>(null);

  const summaries = useMemo(
    () => columns.map(({ column, projects }) => summariseColumn(column, projects, now)),
    [columns, now],
  );

  const scrollToPage = useCallback((index: number, smooth: boolean) => {
    const pager = pagerRef.current;
    if (!pager) return;
    const left = index * pager.clientWidth;
    if (smooth && !prefersReducedMotion() && typeof pager.scrollTo === 'function') {
      pager.scrollTo({ left, behavior: 'smooth' });
    } else {
      pager.scrollLeft = left;
    }
  }, []);

  // Land on the remembered column before the first paint.
  useLayoutEffect(() => {
    scrollToPage(current, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only: afterwards the scroll position IS the source of truth
  }, []);

  // scrollLeft is in px: after a rotation or resize, put the current column
  // back in view instead of landing between two.
  const currentRef = useRef(current);
  useEffect(() => {
    currentRef.current = current;
  }, [current]);
  useEffect(() => {
    const onResize = () => scrollToPage(currentRef.current, false);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [scrollToPage]);

  // A smooth jump (strip tap) scrolls THROUGH every page in between; without
  // this the header would flick through each of their names on the way.
  // Cleared on arrival, or the moment a finger takes over the scroll.
  const jumpTargetRef = useRef<number | null>(null);

  const onScroll = () => {
    const pager = pagerRef.current;
    if (!pager || pager.clientWidth === 0) return;
    const index = Math.round(pager.scrollLeft / pager.clientWidth);
    if (jumpTargetRef.current !== null) {
      if (index === jumpTargetRef.current) jumpTargetRef.current = null;
      return;
    }
    if (index !== current) setCurrent(index);
  };

  const jump = (index: number, smooth: boolean) => {
    jumpTargetRef.current = smooth ? index : null;
    setCurrent(index);
    scrollToPage(index, smooth);
  };

  const closeOverlay = (returnTo: HTMLElement | null) => {
    setOverlay(null);
    returnTo?.focus();
  };

  const fabShown = canCreate && !hideFab && overlay !== 'columns' && overlay !== 'more';

  return (
    <div data-testid="aito-mobile-board" className="flex-1 min-h-0 flex flex-col">
      <MobileBoardHeader
        columns={summaries}
        current={current}
        pending={pending}
        search={search}
        onSearchChange={onSearchChange}
        onJump={(index) => jump(index, true)}
        onOpenColumns={() => setOverlay('columns')}
        columnsOpen={overlay === 'columns'}
        onOpenMore={() => setOverlay('more')}
        moreOpen={overlay === 'more'}
        pickerRef={pickerRef}
        moreRef={moreRef}
      />

      <div className="relative flex-1 min-h-0">
        <div
          ref={pagerRef}
          data-testid="aito-mobile-pager"
          aria-busy={pending || undefined}
          onScroll={onScroll}
          onPointerDown={() => {
            jumpTargetRef.current = null;
          }}
          className={`h-full flex overflow-x-auto overflow-y-hidden snap-x snap-mandatory overscroll-x-contain scrollbar-hide transition-opacity duration-300 ${
            pending ? 'opacity-40' : ''
          }`}
        >
          {columns.map(({ column, projects }, index) => (
            <section
              key={column.id}
              data-testid={`aito-mobile-page-${column.id}`}
              aria-label={t(column.labelKey)}
              inert={index !== current || undefined}
              className="w-full flex-none snap-start snap-always overflow-y-auto overscroll-y-contain px-4 pt-3 pb-28 flex flex-col gap-2"
            >
              {projects.map((project) => (
                <MobileCard key={project.id} project={project} onExpand={() => onExpandCard(project.id)} />
              ))}
              {projects.length === 0 &&
                !pending &&
                (filtering ? (
                  <p className="py-8 text-center text-sm text-bambu-gray">{t('aito.searchNoResults')}</p>
                ) : (
                  <div className="animate-fade-in min-h-[8rem] rounded-lg border border-dashed border-bambu-dark-tertiary/80" />
                ))}
            </section>
          ))}
        </div>
        {loadingPill}
      </div>

      {fabShown && (
        <button
          ref={fabRef}
          type="button"
          data-testid="aito-mobile-fab"
          onClick={() => setOverlay(overlay === 'create' ? null : 'create')}
          aria-haspopup="menu"
          aria-expanded={overlay === 'create'}
          aria-label={t('aito.mobile.create')}
          // Below the shell's nav drawer (z-40 backdrop, z-50 drawer) and any
          // app modal by default; lifted over its own menu's scrim only while
          // that menu is open, so it can still close it.
          className={`fixed right-4 bottom-[calc(1.5rem+env(safe-area-inset-bottom))] ${overlay === 'create' ? 'z-[60]' : 'z-30'} grid place-items-center w-14 h-14 rounded-2xl bg-bambu-green text-white shadow-lg shadow-bambu-green/30`}
        >
          {/* Only the glyph turns (+ → ×): rotating the rounded square
              itself would stand it on a corner. */}
          <Plus
            className={`w-6 h-6 transition-[rotate] duration-200 ease-(--ease-signature) motion-reduce:transition-none ${
              overlay === 'create' ? 'rotate-45' : ''
            }`}
            aria-hidden="true"
          />
        </button>
      )}

      {overlay === 'columns' && (
        <MobileColumnSheet
          columns={summaries}
          current={current}
          pending={pending}
          heading={heading}
          onPick={(index) => jump(index, false)}
          onClose={() => closeOverlay(pickerRef.current)}
        />
      )}
      {overlay === 'more' && (
        <MobileMenu
          label={t('aito.mobile.moreOptions')}
          anchorRef={moreRef}
          placement="below"
          caption={heading}
          items={[
            {
              key: 'done',
              icon: Archive,
              label: t('aito.showDone'),
              trailing: pending ? '–' : doneCount,
              onSelect: () => onShowView('done'),
            },
            { key: 'trash', icon: Trash2, label: t('aito.trash'), onSelect: () => onShowView('trash') },
            { key: 'stats', icon: BarChart3, label: t('aito.statistics'), onSelect: () => onShowView('stats') },
          ]}
          onClose={() => closeOverlay(moreRef.current)}
        />
      )}
      {overlay === 'create' && (
        <MobileMenu
          label={t('aito.mobile.create')}
          anchorRef={fabRef}
          placement="above"
          items={[
            { key: 'import', icon: FileInput, label: t('aito.importQuote'), onSelect: onImport },
            { key: 'new', icon: Plus, label: t('aito.newProject'), onSelect: onNewProject },
          ]}
          onClose={() => closeOverlay(fabRef.current)}
        />
      )}
    </div>
  );
}
