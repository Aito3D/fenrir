import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, MoreHorizontal, SlidersHorizontal, Trash2, type LucideIcon } from 'lucide-react';
import { useSnapPager } from '../../../hooks/useSnapPager';
import { ActionMenu } from '../../aito/ActionMenu';
import { ColumnCountPill } from '../../aito/MobileBoardHeader';
import { QueueTabSheet } from './QueueTabSheet';
import { QueueFilterSheet, type QueueFilterSheetProps } from './QueueFilterSheet';
import { hasActiveQueueFilter } from './queueFilters';

export type QueueTabId = 'queue' | 'batches' | 'history' | 'timeline' | 'pipelines';

export interface QueueTabMeta {
  id: QueueTabId;
  label: string;
  icon: LucideIcon;
  count: number | null;
}

export interface MobileQueueProps {
  tabs: ReadonlyArray<QueueTabMeta>;
  activeTab: QueueTabId;
  onTabChange: (tab: QueueTabId) => void;
  loading: boolean;
  renderTab: (tab: QueueTabId) => ReactNode;
  /** Printer / status / location; null on tabs that have no filters. */
  filters: Omit<QueueFilterSheetProps, 'onClose' | 'view'> | null;
  /** The Queue tab's layout toggle + SJF; undefined elsewhere. */
  view: QueueFilterSheetProps['view'];
  /** History with items: Clear history behind ⋯; null hides the button. */
  onClearHistory: (() => void) | null;
}

type Overlay = 'tabs' | 'filters' | 'more' | null;

/** The phone Queue page (spec: docs/superpowers/specs/2026-11-01-queue-mobile-design.md).
 *
 *  One tab at a time: a horizontal scroll-snap pager, one full-width page per
 *  tab, each scrolling vertically inside itself. The header names the tab
 *  (tap for the tab sheet); its bottom edge is a five-segment strip. Only the
 *  current page and its neighbours render their content, so the per-tab
 *  queries the page gates on `activeTab` keep their gating. */
export function MobileQueue({
  tabs,
  activeTab,
  onTabChange,
  loading,
  renderTab,
  filters,
  view,
  onClearHistory,
}: MobileQueueProps) {
  const { t } = useTranslation();
  const current = Math.max(0, tabs.findIndex((tab) => tab.id === activeTab));
  // Memoised: the hook's settle timer holds whichever setCurrent it was
  // scheduled with, so a fresh closure every render would act on stale props.
  const setCurrent = useCallback(
    (index: number) => {
      const tab = tabs[index];
      if (tab && tab.id !== activeTab) onTabChange(tab.id);
    },
    [tabs, activeTab, onTabChange],
  );
  const { pagerRef, jump, handlers } = useSnapPager(tabs.length, current, setCurrent);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const pickerRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLButtonElement>(null);

  const active = tabs[current];
  const filterOn = filters !== null && hasActiveQueueFilter(filters.filterPrinter, filters.filterStatus, filters.filterLocation);

  const closeOverlay = (returnTo: HTMLElement | null) => {
    setOverlay(null);
    returnTo?.focus();
  };

  return (
    <div data-testid="queue-mobile" className="flex h-[calc(100dvh-3.5rem)] flex-col">
      <div data-testid="queue-mobile-header" className="flex-none bg-bambu-dark">
        <div className="flex h-11 items-center gap-1.5 pl-4 pr-2">
          <button
            ref={pickerRef}
            type="button"
            onClick={() => setOverlay('tabs')}
            aria-haspopup="dialog"
            aria-expanded={overlay === 'tabs'}
            className="-ml-2 flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-[15px] font-bold text-white active:bg-bambu-dark-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
          >
            <active.icon className="h-4 w-4 flex-none text-bambu-green" aria-hidden="true" />
            <span className="truncate">{active.label}</span>
            {active.count !== null && <ColumnCountPill count={active.count} pending={loading} />}
            <ChevronDown className="h-3.5 w-3.5 flex-none text-bambu-gray" aria-hidden="true" />
            <span className="sr-only">{t('queue.mobile.pickTab')}</span>
          </button>
          <span className="flex-1" />
          {filters !== null && (
            <button
              ref={filterRef}
              type="button"
              onClick={() => setOverlay('filters')}
              aria-haspopup="dialog"
              aria-expanded={overlay === 'filters'}
              aria-label={t('queue.mobile.filters')}
              className={`relative grid h-9 w-9 place-items-center rounded-lg transition-colors ${
                filterOn ? 'text-bambu-green' : 'text-bambu-gray-light active:bg-bambu-dark-secondary'
              }`}
            >
              <SlidersHorizontal className="h-[18px] w-[18px]" aria-hidden="true" />
              {filterOn && (
                <span
                  data-testid="queue-mobile-filter-dot"
                  aria-hidden="true"
                  className="absolute right-1.5 top-1.5 h-[7px] w-[7px] rounded-full bg-bambu-green ring-2 ring-bambu-dark"
                />
              )}
            </button>
          )}
          {onClearHistory && (
            <button
              ref={moreRef}
              type="button"
              onClick={() => setOverlay('more')}
              aria-haspopup="menu"
              aria-expanded={overlay === 'more'}
              aria-label={t('aito.mobile.moreOptions')}
              className="grid h-9 w-9 place-items-center rounded-lg text-bambu-gray-light active:bg-bambu-dark-secondary"
            >
              <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
            </button>
          )}
        </div>

        {/* The strip: five equal segments, the current one lit. Equal, not
            count-weighted: History's count would swamp the rest. */}
        <div className="flex h-[3px] gap-0.5">
          {tabs.map((tab, index) => (
            <button
              key={tab.id}
              type="button"
              data-testid={`queue-mobile-segment-${tab.id}`}
              onClick={() => jump(index, true)}
              aria-current={index === current ? 'true' : undefined}
              aria-label={tab.label}
              className={`relative h-full flex-1 transition-colors duration-200 motion-reduce:transition-none after:absolute after:inset-x-0 after:-top-3 after:-bottom-1 after:content-[''] ${
                index === current ? 'bg-bambu-green' : 'bg-bambu-dark-tertiary'
              }`}
            />
          ))}
        </div>
      </div>

      <div
        ref={pagerRef}
        data-testid="queue-mobile-pager"
        {...handlers}
        className="flex flex-1 min-h-0 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain scrollbar-hide"
      >
        {tabs.map((tab, index) => (
          <section
            key={tab.id}
            data-testid={`queue-mobile-page-${tab.id}`}
            aria-label={tab.label}
            inert={index !== current || undefined}
            className="w-full flex-none snap-start snap-always overflow-y-auto overscroll-y-contain p-4 pb-24"
          >
            {Math.abs(index - current) <= 1 ? renderTab(tab.id) : null}
          </section>
        ))}
      </div>

      {overlay === 'tabs' && (
        <QueueTabSheet
          tabs={tabs}
          current={current}
          loading={loading}
          onPick={(index) => jump(index, false)}
          onClose={() => closeOverlay(pickerRef.current)}
        />
      )}
      {overlay === 'filters' && filters !== null && (
        <QueueFilterSheet {...filters} view={view} onClose={() => closeOverlay(filterRef.current)} />
      )}
      {overlay === 'more' && onClearHistory && (
        <ActionMenu
          label={t('aito.mobile.moreOptions')}
          anchorRef={moreRef}
          placement="below"
          items={[{ key: 'clear', icon: Trash2, label: t('queue.clearHistory'), danger: true, onSelect: onClearHistory }]}
          onClose={() => closeOverlay(moreRef.current)}
        />
      )}
    </div>
  );
}
