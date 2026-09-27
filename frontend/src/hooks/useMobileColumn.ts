import { useCallback, useState } from 'react';

export const MOBILE_COLUMN_STORAGE_KEY = 'aito.mobile.column';

function readStored(ids: readonly string[]): number {
  try {
    const index = ids.indexOf(sessionStorage.getItem(MOBILE_COLUMN_STORAGE_KEY) ?? '');
    return index >= 0 ? index : 0;
  } catch {
    // Private mode, or storage disabled: start on the first column.
    return 0;
  }
}

/** Which column the phone board is showing, remembered for the session.
 *
 *  sessionStorage, same reasoning as usePanelTab: coming back to the board
 *  mid-session should land where you were, a fresh visit on the first
 *  column. Stored by id, not index, so a renamed or reordered column falls
 *  back to the first one instead of silently shifting. */
export function useMobileColumn(ids: readonly string[]): [number, (index: number) => void] {
  const [current, setCurrent] = useState(() => readStored(ids));
  const select = useCallback(
    (index: number) => {
      const clamped = Math.min(Math.max(index, 0), ids.length - 1);
      setCurrent(clamped);
      try {
        sessionStorage.setItem(MOBILE_COLUMN_STORAGE_KEY, ids[clamped]);
      } catch {
        // Storage full or disabled: the selection still works for this visit.
      }
    },
    [ids],
  );
  return [current, select];
}
