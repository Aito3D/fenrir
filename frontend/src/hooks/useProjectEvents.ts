import { useInfiniteQuery } from '@tanstack/react-query';
import { api, type AitoEventCursor, type AitoEventPage, type AitoHistoryDepth } from '../api/client';

const PAGE_SIZE = 50;

/** The project's timeline, paged backwards on (occurred_at, id).
 *
 *  Keyed on the depth as well as the project: switching depth changes which
 *  kinds the server returns, so the two are genuinely different result sets
 *  rather than one filtered client-side.
 *
 *  The page param carries BOTH halves of the sort key. An id-only cursor drops
 *  rows outright once id order and occurred_at order diverge, which the backfill
 *  migration guarantees — see the events route's docstring. */
export function useProjectEvents(projectId: number, depth: AitoHistoryDepth) {
  return useInfiniteQuery({
    queryKey: ['aito-events', projectId, depth],
    initialPageParam: undefined as AitoEventCursor | undefined,
    queryFn: ({ pageParam }) =>
      api.getAitoEvents(projectId, { depth, cursor: pageParam, limit: PAGE_SIZE }),
    getNextPageParam: (last: AitoEventPage): AitoEventCursor | undefined => {
      if (!last.has_more || !last.events.length) return undefined;
      const tail = last.events[last.events.length - 1];
      return { id: tail.id, occurredAt: tail.occurred_at };
    },
  });
}
