import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, type LucideIcon } from 'lucide-react';
import { useSnapPager } from '../../hooks/useSnapPager';
import { ColumnCountPill } from '../aito/MobileBoardHeader';
import { TabSheet } from './TabSheet';

export interface MobileTabMeta<Id extends string = string> {
  id: Id;
  label: string;
  icon?: LucideIcon;
  /** Shown as a pill in the header and a number in the sheet; null/undefined hides it. */
  count?: number | null;
  /** Status dot / badge after the label (Settings). */
  extra?: ReactNode;
}

export interface MobileTabsProps<Id extends string> {
  tabs: ReadonlyArray<MobileTabMeta<Id>>;
  activeTab: Id;
  onTabChange: (tab: Id) => void;
  loading?: boolean;
  renderTab: (tab: Id) => ReactNode;
  /** Buttons right of the tab name (filters, ⋯). */
  headerRight?: ReactNode;
  /** A row fixed under the strip: search field, page actions, live subtitle. */
  toolbar?: ReactNode;
  /** Prefix for data-testid; defaults to `mobile-tabs`. */
  testId?: string;
}

/** The phone layout of every tabbed page (spec: docs/superpowers/specs/2026-11-01-queue-mobile-design.md,
 *  part 2): one tab at a time in a horizontal scroll-snap pager, a 44 px
 *  header naming the tab (tap for the tab sheet), a segment strip. Only the
 *  current page and its neighbours render their content, so per-tab queries
 *  gated on the active tab keep their gating. Renders as the whole screen
 *  under the shell's top bar; mount it in place of the page's padded root. */
export function MobileTabs<Id extends string>({
  tabs,
  activeTab,
  onTabChange,
  loading = false,
  renderTab,
  headerRight,
  toolbar,
  testId = 'mobile-tabs',
}: MobileTabsProps<Id>) {
  const { t } = useTranslation();
  const current = Math.max(0, tabs.findIndex((tab) => tab.id === activeTab));
  // The hook's settle timer holds whichever setCurrent it was scheduled with,
  // and the scroll that schedules it is often the one that changes the tab.
  // So setCurrent never closes over props: it reads them through a ref that
  // every render refreshes, and keeps one identity for the component's life.
  const propsRef = useRef({ tabs, activeTab, onTabChange });
  propsRef.current = { tabs, activeTab, onTabChange };
  const setCurrent = useCallback((index: number) => {
    const { tabs: tabList, activeTab: active, onTabChange: change } = propsRef.current;
    const tab = tabList[index];
    if (tab && tab.id !== active) change(tab.id);
  }, []);
  const { pagerRef, jump, handlers } = useSnapPager(tabs.length, current, setCurrent);
  const [sheetOpen, setSheetOpen] = useState(false);
  const pickerRef = useRef<HTMLButtonElement>(null);
  const active = tabs[current];

  return (
    <div data-testid={testId} className="flex h-[calc(100dvh-3.5rem)] flex-col">
      <div data-testid={`${testId}-header`} className="flex-none bg-bambu-dark">
        <div className="flex h-11 items-center gap-1.5 pl-4 pr-2">
          <button
            ref={pickerRef}
            type="button"
            onClick={() => setSheetOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={sheetOpen}
            className="-ml-2 flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-[15px] font-bold text-white active:bg-bambu-dark-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
          >
            {active.icon && <active.icon className="h-4 w-4 flex-none text-bambu-green" aria-hidden="true" />}
            <span className="truncate">{active.label}</span>
            {active.extra}
            {active.count != null && <ColumnCountPill count={active.count} pending={loading} />}
            <ChevronDown className="h-3.5 w-3.5 flex-none text-bambu-gray" aria-hidden="true" />
            <span className="sr-only">{t('queue.mobile.pickTab')}</span>
          </button>
          <span className="flex-1" />
          {headerRight}
        </div>

        {/* The strip: equal segments, the current one lit. Equal, not
            count-weighted: one tab's count would swamp the rest. */}
        <div className="flex h-[3px] gap-0.5">
          {tabs.map((tab, index) => (
            <button
              key={tab.id}
              type="button"
              data-testid={`${testId}-segment-${tab.id}`}
              onClick={() => jump(index, true)}
              aria-current={index === current ? 'true' : undefined}
              aria-label={tab.label}
              className={`relative h-full flex-1 transition-colors duration-200 motion-reduce:transition-none after:absolute after:inset-x-0 after:-top-3 after:-bottom-1 after:content-[''] ${
                index === current ? 'bg-bambu-green' : 'bg-bambu-dark-tertiary'
              }`}
            />
          ))}
        </div>
        {toolbar && <div className="px-4 pt-3">{toolbar}</div>}
      </div>

      <div
        ref={pagerRef}
        data-testid={`${testId}-pager`}
        {...handlers}
        className="flex flex-1 min-h-0 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain scrollbar-hide"
      >
        {tabs.map((tab, index) => (
          <section
            key={tab.id}
            data-testid={`${testId}-page-${tab.id}`}
            aria-label={tab.label}
            inert={index !== current || undefined}
            className="w-full flex-none snap-start snap-always overflow-y-auto overscroll-y-contain p-4 pb-24"
          >
            {Math.abs(index - current) <= 1 ? renderTab(tab.id) : null}
          </section>
        ))}
      </div>

      {sheetOpen && (
        <TabSheet
          tabs={tabs}
          current={current}
          loading={loading}
          testId={`${testId}-tab-sheet`}
          onPick={(index) => jump(index, false)}
          onClose={() => {
            setSheetOpen(false);
            pickerRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}
