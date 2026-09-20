import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { focusRingCls } from '../../formStyles';
import { STATS_SCREENS, statsScreenId, statsTabId, type StatsScreen } from './screens';

/** The period's segmented control: Overview · Sales · Time · Money · Clients.
 *  WAI-ARIA tabs with manual activation — arrow keys move focus and select,
 *  since every screen is cheap to render. Only the selected tab is in the
 *  tab order. */
export function ScreenTabs({ selected, onSelect }: { selected: StatsScreen; onSelect: (id: StatsScreen) => void }) {
  const { t } = useTranslation();
  const label = (id: StatsScreen) => (id === 'overview' ? t('aito.stats.screen.overview') : t(`aito.stats.${id}`));

  const move = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (index + 1) % STATS_SCREENS.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + STATS_SCREENS.length) % STATS_SCREENS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = STATS_SCREENS.length - 1;
    if (next === null) return;
    e.preventDefault();
    const target = STATS_SCREENS[next];
    onSelect(target);
    document.getElementById(statsTabId(target))?.focus();
  };

  return (
    <div role="tablist" aria-label={t('aito.statistics')} className="inline-flex gap-0.5 rounded-[10px] bg-bambu-dark-secondary/60 p-[3px]">
      {STATS_SCREENS.map((id, index) => {
        const isSelected = id === selected;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            id={statsTabId(id)}
            aria-selected={isSelected}
            aria-controls={statsScreenId(id)}
            tabIndex={isSelected ? 0 : -1}
            onClick={() => onSelect(id)}
            onKeyDown={(e) => move(e, index)}
            className={`rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition-colors duration-150 ${
              isSelected ? 'bg-bambu-dark-secondary text-white shadow-sm' : 'text-bambu-gray-light hover:text-white'
            } ${focusRingCls}`}
          >
            {label(id)}
          </button>
        );
      })}
    </div>
  );
}
