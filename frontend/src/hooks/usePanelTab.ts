import { useCallback, useState } from 'react';

export const PANEL_TAB_STORAGE_KEY = 'aito.panel.tab';

function readStored<T extends string>(ids: readonly T[]): T | null {
  try {
    const stored = sessionStorage.getItem(PANEL_TAB_STORAGE_KEY);
    return ids.find((id) => id === stored) ?? null;
  } catch {
    // Private mode, or storage disabled. The default is fine.
    return null;
  }
}

/** Which tab of the project panel's right column is open.
 *
 *  Remembered in sessionStorage, not localStorage, and on purpose: someone
 *  reading history across several cards should not have to click Activity on
 *  each one, but a fresh visit should land on the reference cards — Details
 *  is the tab that answers "what is this project" and the one most panels are
 *  opened for. Same shape as ActivityRail's depth memory, one tier shorter.
 *
 *  A remembered value that is not one of `ids` (a renamed tab, a hand-edited
 *  store) falls back to the first tab rather than rendering nothing. */
export function usePanelTab<T extends string>(ids: readonly T[]): [T, (next: T) => void] {
  const [selected, setSelected] = useState<T>(() => readStored(ids) ?? ids[0]);

  const select = useCallback((next: T) => {
    setSelected(next);
    try {
      sessionStorage.setItem(PANEL_TAB_STORAGE_KEY, next);
    } catch {
      // Storage full or disabled: the selection still works for this panel.
    }
  }, []);

  return [selected, select];
}
