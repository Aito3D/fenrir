import { useCallback, useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';

/** The board's write arbitration, shared by every mutation that touches
 *  `['aito-projects']`.
 *
 *  Two rules, both moved here from `useBoardDrag`, which discovered both:
 *
 *  ONLY THE LAST WRITE TO SETTLE INVALIDATES. Invalidating while another write
 *  is still queued or in flight lets the resulting GET — which predates that
 *  write — overwrite its optimistic cache entry. The last settle always
 *  invalidates, so nothing is left stale.
 *
 *  THE GENERATION BUMPS ON EVERY SETTLE. `useBoardDrag` rebuilds its local
 *  drag board from the query data only when nothing is pending; the bump is
 *  what lets a rebuild that was skipped while blocked re-run once things go
 *  quiet, even on a render where the query data's identity never changed.
 *
 *  MODULE-LEVEL, not per-hook. A quote-status change landing mid-drag-settle
 *  would rebuild the drag board from stale data if the two hooks kept separate
 *  counters. Every consumer must see the same number. */

let pendingWrites = 0;
let generation = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: module state survives between tests in one file. */
export function __resetBoardSync() {
  pendingWrites = 0;
  generation = 0;
  emit();
}

export function useBoardSync() {
  const currentGeneration = useSyncExternalStore(
    subscribe,
    () => generation,
    () => generation,
  );

  const begin = useCallback(() => {
    pendingWrites += 1;
  }, []);

  const settle = useCallback((queryClient: QueryClient) => {
    // Must not throw: on the success path React Query runs onSettled inside
    // the same try as the mutationFn, so a throw here re-runs onError +
    // onSettled and double-decrements.
    pendingWrites = Math.max(0, pendingWrites - 1);
    generation += 1;
    emit();
    if (pendingWrites === 0) {
      queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
    }
  }, []);

  const resyncIfIdle = useCallback((queryClient: QueryClient) => {
    if (pendingWrites > 0) return;
    queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
  }, []);

  const isIdle = useCallback(() => pendingWrites === 0, []);

  return { generation: currentGeneration, begin, settle, resyncIfIdle, isIdle };
}
