import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { Sheet } from './Sheet';
import { focusRingCls } from '../formStyles';
import type { MobileTabMeta } from './MobileTabs';

/** Every tab in one list with its count: any tab is one tap away. */
export function TabSheet<Id extends string>({
  tabs,
  current,
  loading,
  testId,
  onPick,
  onClose,
}: {
  tabs: ReadonlyArray<MobileTabMeta<Id>>;
  current: number;
  loading: boolean;
  testId: string;
  onPick: (index: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Sheet label={t('queue.mobile.tabs')} testId={testId} onClose={onClose}>
      {(close) => (
        <ul className="max-h-[70dvh] overflow-y-auto overscroll-y-contain divide-y divide-bambu-dark-tertiary rounded-xl border border-bambu-dark-tertiary">
          {tabs.map((tab, index) => {
            const active = index === current;
            return (
              <li key={tab.id}>
                <button
                  type="button"
                  aria-current={active ? 'true' : undefined}
                  onClick={() => {
                    onPick(index);
                    close();
                  }}
                  className={`flex w-full items-center gap-3 px-3 py-3 text-left text-[15px] ${active ? 'text-white' : 'text-bambu-gray-light'} ${focusRingCls}`}
                >
                  {tab.icon && <tab.icon className={`h-4 w-4 flex-none ${active ? 'text-bambu-green' : 'text-bambu-gray'}`} aria-hidden />}
                  <span className="flex-1 truncate">{tab.label}</span>
                  {tab.extra}
                  {tab.count != null && (
                    <span className="text-sm tabular-nums text-bambu-gray">{loading ? '–' : tab.count}</span>
                  )}
                  {active && <Check className="h-4 w-4 text-bambu-green" aria-hidden />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}
