import type { QueryClient } from '@tanstack/react-query';
import { type AitoProject } from '../../api/client';
import { replaceProject } from '../../utils/aitoOptimistic';

/** The settle pair every simple single-project board mutation ends its
 *  `onSuccess` with: adopt the server's own row over the optimistic
 *  prediction, then invalidate `['aito-events', projectId]` so
 *  `RecordCard`/`ActivityRail` pick up the `project.updated` event the write
 *  just recorded server-side.
 *
 *  Order matters and is preserved exactly as every call site wrote it out
 *  longhand before this was extracted: the cache write lands first, the
 *  invalidation is only issued after.
 *
 *  Not every mutation's `onSuccess` is JUST this — several append a toast or
 *  a conflict check afterwards. Those callers still call this helper first,
 *  then keep their own extra step inline. */
export function settleProject(queryClient: QueryClient, projectId: number, row: AitoProject): void {
  queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) => replaceProject(prev, row));
  queryClient.invalidateQueries({ queryKey: ['aito-events', projectId] });
}
