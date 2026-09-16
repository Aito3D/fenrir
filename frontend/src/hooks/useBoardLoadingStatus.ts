import { useEffect, useRef, useState } from 'react';

export type BoardLoadingStatus = 'hidden' | 'shown' | 'leaving';

/** How long a first fetch may take before the board admits it is loading.
 *  Under this, the answer simply arrives and nothing flashes. */
export const BOARD_STATUS_GRACE_MS = 220;
/** The status pill's exit — long enough for its fade to play out. */
export const BOARD_STATUS_EXIT_MS = 200;

/** The board's "loading" status pill as a three-state signal.
 *
 *  `hidden` → `shown` only after a grace period, so a fast reply never
 *  shows a loader that is gone before the eye lands on it. `shown` →
 *  `leaving` → `hidden` when the fetch settles, holding the element mounted
 *  through its fade-out. A fetch that settles inside the grace period goes
 *  straight back to `hidden` with nothing ever mounted. */
export function useBoardLoadingStatus(pending: boolean): BoardLoadingStatus {
  const [status, setStatus] = useState<BoardLoadingStatus>('hidden');
  const current = useRef(status);
  current.current = status;

  useEffect(() => {
    if (pending) {
      const timer = window.setTimeout(() => setStatus('shown'), BOARD_STATUS_GRACE_MS);
      return () => window.clearTimeout(timer);
    }
    if (current.current !== 'shown') return;
    setStatus('leaving');
    const timer = window.setTimeout(() => setStatus('hidden'), BOARD_STATUS_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);

  return status;
}
