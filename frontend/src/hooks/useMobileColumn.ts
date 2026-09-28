import { useCallback, useState } from 'react';

export const MOBILE_COLUMN_STORAGE_KEY = 'aito.mobile.column';
/** The tablet board's first visible column — its own key, so a phone and a
 *  tablet session never overwrite each other's place. */
export const TABLET_FIRST_STORAGE_KEY = 'aito.tablet.first';

function readStored(ids: readonly string[], storageKey: string): number {
  try {
    const index = ids.indexOf(sessionStorage.getItem(storageKey) ?? '');
    return index >= 0 ? index : 0;
  } catch {
    // Private mode, or storage disabled: start on the first column.
    return 0;
  }
}

/** Which column the phone board is showing (or which column the tablet
 *  board's window starts at), remembered for the session.
 *
 *  sessionStorage, same reasoning as usePanelTab: coming back to the board
 *  mid-session should land where you were, a fresh visit on the first
 *  column. Stored by id, not index, so a renamed or reordered column falls
 *  back to the first one instead of silently shifting. */
export function useMobileColumn(
  ids: readonly string[],
  storageKey: string = MOBILE_COLUMN_STORAGE_KEY,
): [number, (index: number) => void] {
  const [current, setCurrent] = useState(() => readStored(ids, storageKey));
  const select = useCallback(
    (index: number) => {
      const clamped = Math.min(Math.max(index, 0), ids.length - 1);
      setCurrent(clamped);
      try {
        sessionStorage.setItem(storageKey, ids[clamped]);
      } catch {
        // Storage full or disabled: the selection still works for this visit.
      }
    },
    [ids, storageKey],
  );
  return [current, select];
}
