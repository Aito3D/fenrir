import { useMutation, useQueryClient, type QueryClient, type UseMutationResult } from '@tanstack/react-query';
import { useBoardSync } from './useBoardSync';
import { flashRevert } from './useRevertFlash';
import { ApiError, type AitoProject } from '../api/client';

/** The freshest ACKED version for a project, read straight from the
 *  `['aito-projects']` cache rather than trusting a `mutationFn` closure's
 *  render-time snapshot of `project.version`.
 *
 *  `useOptimisticBoardMutation`'s shared `{id: 'aito-board'}` scope
 *  serializes every board write's EXECUTION — react-query queues a second
 *  mutation's `mutationFn` call behind the first one's settle. But the
 *  CLOSURE `.mutate()` builds is bound to whichever render was current when
 *  `.mutate()` was invoked, and a same-client back-to-back save (blur the
 *  description, then click Save on the shipping card before the first PATCH
 *  resolves) can call `.mutate()` for the second write before any render has
 *  seen the first one's response — so the queued closure still carries the
 *  pre-first-save version. Confirmed empirically in
 *  AitoDetailPanelOptimistic.test.tsx's F2 suite: without this, the second
 *  request's `expected_version` stays stale even though it does not go out
 *  on the wire until after the first one's `onSuccess` has already landed.
 *
 *  Reading the cache INSIDE the `mutationFn` body — rather than closing over
 *  `project.version` — fixes it: the function's body runs fresh at whatever
 *  moment the retryer actually calls it, and `getQueryData` always reflects
 *  the latest committed cache entry at that instant, independent of whether
 *  React has re-rendered the component that built the closure. The
 *  optimistic transforms never touch `version` (only a real server response
 *  does — see utils/aitoOptimistic.ts), so this is genuinely the latest
 *  ACKED value, never a value from another write's not-yet-confirmed
 *  optimistic guess. `fallback` covers the cache-miss case (board query has
 *  no data yet), same shape as `OptimisticBoardOptions.transform`'s own
 *  `undefined`-means-"leave it alone" contract. */
export function latestProjectVersion(queryClient: QueryClient, projectId: number, fallback: number): number {
  return (
    queryClient.getQueryData<AitoProject[]>(['aito-projects'])?.find((p) => p.id === projectId)?.version ?? fallback
  );
}

export interface OptimisticBoardOptions<TData, TVars> {
  mutationFn: (vars: TVars) => Promise<TData>;
  /** The optimistic cache write, applied synchronously before the request
   *  goes out. Pure — see utils/aitoOptimistic.ts for the transforms.
   *  `undefined` means "leave the cache as it is" (a cache miss — the board
   *  query has no data yet, e.g. it errored) rather than fabricating a board
   *  out of just this one write; `setQueryData` already treats an `undefined`
   *  updater result as a no-op, so returning it here costs nothing extra. */
  transform: (previous: AitoProject[] | undefined, vars: TVars) => AitoProject[] | undefined;
  /** Which card to flash if this reverts. Omit for a write with no card of its
   *  own (adding a note, for instance). */
  flashId?: (vars: TVars) => number | null;
  /** Runs at the very start of `onMutate`, BEFORE the optimistic cache write.
   *
   *  For the side effects that have to happen while the board still looks the
   *  way the user left it — the Done celebration reads the archived card's
   *  position here, and one line later the transform takes that card off the
   *  board. Deliberately not `mutationFn`: every board writer shares the
   *  `aito-board` scope, so a queued write's `mutationFn` can run seconds
   *  after the click, while `onMutate` is what the user actually sees
   *  happen. */
  onMutate?: (vars: TVars) => void;
  onSuccess?: (data: TData, vars: TVars) => void;
  onError?: (error: unknown, vars: TVars) => void;
}

interface Context {
  previous: AitoProject[] | undefined;
}

/** One mutation shape for every write that touches the Aito board.
 *
 *  Owns the sequence each of them needs and none of them should reimplement:
 *  cancel in-flight refetches, snapshot, apply the transform, roll back and
 *  flash on failure, and settle through the shared counter so exactly one
 *  refetch happens per burst.
 *
 *  KNOWN LIMIT, inherited from useBoardDrag and accepted there: concurrent
 *  rollbacks stack. Each write snapshots at its own start, so if two fail the
 *  second's rollback restores over the first. Self-corrected one round trip
 *  later by the settle-invalidate. The shared `aito-board` mutation scope makes
 *  this rare rather than impossible. */
export function useOptimisticBoardMutation<TData, TVars>(
  options: OptimisticBoardOptions<TData, TVars>,
): UseMutationResult<TData, unknown, TVars, Context> {
  const queryClient = useQueryClient();
  const boardSync = useBoardSync();

  return useMutation<TData, unknown, TVars, Context>({
    // Every board writer shares one scope so overlapping writes are applied in
    // the order they were made, not the order the network happens to finish
    // them in. Same id useBoardDrag's move mutation uses.
    scope: { id: 'aito-board' },
    mutationFn: options.mutationFn,
    onMutate: async (vars) => {
      // First, and synchronously: after the await below, the DOM this may want
      // to measure is a render away from being stale.
      options.onMutate?.(vars);
      await queryClient.cancelQueries({ queryKey: ['aito-projects'] });
      const previous = queryClient.getQueryData<AitoProject[]>(['aito-projects']);
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], options.transform(previous, vars));
      boardSync.begin();
      return { previous };
    },
    onError: (error, vars, context) => {
      if (context) queryClient.setQueryData(['aito-projects'], context.previous);
      const id = options.flashId?.(vars);
      if (id !== undefined && id !== null) flashRevert(id);
      options.onError?.(error, vars);
      if (error instanceof ApiError && error.status === 409) {
        // A conflict means the server state moved under us: the rollback above
        // restored a snapshot that is ALSO stale. Refetch unconditionally —
        // this is the one case where waiting for the last settle would leave
        // every operator looking at a board the server already disowned.
        queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      }
    },
    onSuccess: (data, vars) => {
      options.onSuccess?.(data, vars);
    },
    onSettled: () => {
      boardSync.settle(queryClient);
    },
  });
}
