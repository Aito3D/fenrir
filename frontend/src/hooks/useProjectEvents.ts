import { useInfiniteQuery } from '@tanstack/react-query';
import type { AitoEventCursor, AitoEventPage, AitoHistoryDepth } from '../api/client';
import type { EventSource } from '../components/aito/history/ActivityRail';

/** A rail's timeline (an Aito project's or an order's), paged backwards on (occurred_at, id).
 *
 *  Keyed on the depth as well as the project: switching depth changes which
 *  kinds the server returns, so the two are genuinely different result sets
 *  rather than one filtered client-side.
 *
 *  The page param carries BOTH halves of the sort key. An id-only cursor drops
 *  rows outright once id order and occurred_at order diverge, which the backfill
 *  migration guarantees — see the events route's docstring. */
export function useEvents(source: Pick<EventSource, 'key' | 'fetchPage'>, depth: AitoHistoryDepth) {
  return useInfiniteQuery({
    queryKey: [...source.key, depth],
    initialPageParam: undefined as AitoEventCursor | undefined,
    queryFn: ({ pageParam }) => source.fetchPage(depth, pageParam),
    getNextPageParam: (last: AitoEventPage): AitoEventCursor | undefined => {
      if (!last.has_more || !last.events.length) return undefined;
      const tail = last.events[last.events.length - 1];
      return { id: tail.id, occurredAt: tail.occurred_at };
    },
  });
}
