import { useCallback, useState } from 'react';

/** The period's five screens, in tab order. */
export type StatsScreen = 'overview' | 'sales' | 'time' | 'money' | 'clients';
export const STATS_SCREENS: readonly StatsScreen[] = ['overview', 'sales', 'time', 'money', 'clients'];

export const statsTabId = (id: StatsScreen) => `aito-stats-tab-${id}`;
export const statsScreenId = (id: StatsScreen) => `aito-stats-screen-${id}`;

const STORAGE_KEY = 'bambuddy-aito-stats-screen';

function isScreen(value: unknown): value is StatsScreen {
  return typeof value === 'string' && (STATS_SCREENS as readonly string[]).includes(value);
}

/** The selected screen, remembered for the session — like the panel's tabs,
 *  sessionStorage on purpose: coming back from the board should land on the
 *  question you were reading, tomorrow morning should start at the Overview. */
export function useStatsScreen(): [StatsScreen, (next: StatsScreen) => void] {
  const [screen, setScreen] = useState<StatsScreen>(() => {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      return isScreen(stored) ? stored : 'overview';
    } catch {
      return 'overview';
    }
  });
  const select = useCallback((next: StatsScreen) => {
    setScreen(next);
    try {
      sessionStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private mode or a blocked store: the choice just does not survive.
    }
  }, []);
  return [screen, select];
}
