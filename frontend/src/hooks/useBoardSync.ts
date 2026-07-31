import { useCallback, useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';

/** The board's write arbitration, shared by every mutation that touches
 *  `['aito-projects']`.
 *
 *  TWO COUNTERS, because they answer two different questions, and conflating
 *  them into one used to break optimistic writes entirely:
 *
 *  `pendingWrites` — SETTLE-INVALIDATE ARBITRATION. Every write that touches
 *  the board — drag moves, quote-status changes, delete, restore, create —
 *  feeds this via `begin()`/`settle()`. ONLY THE LAST WRITE TO SETTLE
 *  INVALIDATES: invalidating while another write is still queued or in
 *  flight lets the resulting GET — which predates that write — overwrite its
 *  optimistic cache entry. The last settle always invalidates, so nothing is
 *  left stale. `generation` bumps on every `settle()` so a consumer that
 *  skipped rebuilding while blocked gets a chance to re-run once things go
 *  quiet, even on a render where the underlying query data's identity never
 *  changed.
 *
 *  `dragMoves` — LOCAL-BOARD PROTECTION, drag-only. `useBoardDrag` keeps a
 *  local `board` state so it can own card ordering live during a drag (the
 *  DragOverlay, `dragOver` relocations, the optimistic move). Rebuilding that
 *  local state from the query cache while a drag owns it would clobber the
 *  in-progress reorder. `beginMove()`/`settleMove()`/`isDragIdle()` exist so
 *  ONLY a drag can block that one rebuild.
 *
 *  These used to be the same counter, and that was the bug: every non-drag
 *  write also froze the local-board rebuild, even though a non-drag write has
 *  no local state to protect — its optimistic cache entry IS the board's
 *  truth, so rebuilding the rendered board from the cache during one of these
 *  writes is not merely safe, it is the entire point of writing optimistically
 *  in the first place. With one shared counter, `useOptimisticBoardMutation`'s
 *  `onMutate` wrote the optimistic value into the cache and immediately called
 *  `begin()`, so the guard was already tripped before any re-render could
 *  happen — the card never moved, disappeared, or changed on screen until the
 *  request settled, which defeated the feature. A prior version of this
 *  comment justified the shared counter by claiming a quote-status change
 *  landing mid-drag-settle would rebuild the drag board from stale data if
 *  the two hooks kept separate counters. That reasoning was backwards and is
 *  exactly what produced the bug above: a non-drag write's cache value is not
 *  stale, it is ahead of the server on purpose, and only a drag's own local
 *  state needs protecting from a rebuild.
 *
 *  `useBoardDrag`'s move feeds BOTH counters: it needs the settle-invalidate
 *  arbitration like every other writer, and it is the only writer that also
 *  needs the local-board protection.
 *
 *  MODULE-LEVEL, not per-hook, for both counters: every consumer — every
 *  writer for `pendingWrites`, and `useBoardDrag` alone for `dragMoves` —
 *  must see the same number regardless of how many components have called
 *  this hook. */

let pendingWrites = 0;
let dragMoves = 0;
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
  dragMoves = 0;
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

  // Drag-only local-board protection — see the module docstring for why this
  // is a separate counter from `pendingWrites`. Only `useBoardDrag`'s move
  // path should ever call these.
  const beginMove = useCallback(() => {
    dragMoves += 1;
  }, []);

  const settleMove = useCallback(() => {
    // Same must-not-throw contract as settle(), and for the same reason.
    dragMoves = Math.max(0, dragMoves - 1);
    emit();
  }, []);

  const isDragIdle = useCallback(() => dragMoves === 0, []);

  return {
    generation: currentGeneration,
    begin,
    settle,
    resyncIfIdle,
    isIdle,
    beginMove,
    settleMove,
    isDragIdle,
  };
}
