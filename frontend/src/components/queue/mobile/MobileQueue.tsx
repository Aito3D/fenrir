import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreHorizontal, SlidersHorizontal, Trash2, type LucideIcon } from 'lucide-react';
import { ActionMenu } from '../../aito/ActionMenu';
import { MobileTabs, type MobileTabMeta } from '../../mobile/MobileTabs';
import { QueueFilterSheet, type QueueFilterSheetProps } from './QueueFilterSheet';
import { hasActiveQueueFilter } from './queueFilters';

export type QueueTabId = 'queue' | 'batches' | 'history' | 'timeline' | 'pipelines';

export interface QueueTabMeta extends MobileTabMeta<QueueTabId> {
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

type Overlay = 'filters' | 'more' | null;

/** The phone Queue page (spec: docs/superpowers/specs/2026-11-01-queue-mobile-design.md):
 *  the shared MobileTabs shell plus the filter sheet and the ⋯ menu. */
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
  const [overlay, setOverlay] = useState<Overlay>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLButtonElement>(null);
  const filterOn = filters !== null && hasActiveQueueFilter(filters.filterPrinter, filters.filterStatus, filters.filterLocation);

  const closeOverlay = (returnTo: HTMLElement | null) => {
    setOverlay(null);
    returnTo?.focus();
  };

  return (
    <>
      <MobileTabs
        testId="queue-mobile"
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={onTabChange}
        loading={loading}
        renderTab={renderTab}
        headerRight={
          <>
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
          </>
        }
      />
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
    </>
  );
}
