import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { useBoardSync } from './useBoardSync';
import { flashRevert } from './useRevertFlash';
import type { AitoProject } from '../api/client';

export interface OptimisticBoardOptions<TData, TVars> {
  mutationFn: (vars: TVars) => Promise<TData>;
  /** The optimistic cache write, applied synchronously before the request
   *  goes out. Pure — see utils/aitoOptimistic.ts for the transforms. */
  transform: (previous: AitoProject[] | undefined, vars: TVars) => AitoProject[];
  /** Which card to flash if this reverts. Omit for a write with no card of its
   *  own (adding a note, for instance). */
  flashId?: (vars: TVars) => number | null;
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
    },
    onSuccess: (data, vars) => {
      options.onSuccess?.(data, vars);
    },
    onSettled: () => {
      boardSync.settle(queryClient);
    },
  });
}
