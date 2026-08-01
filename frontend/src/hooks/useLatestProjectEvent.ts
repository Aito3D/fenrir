import { useQuery } from '@tanstack/react-query';
import { api, type AitoEvent } from '../api/client';

/** The single newest thing that happened to a project.
 *
 *  Exists because `AitoProject` snapshots a `created_by` and nothing equivalent
 *  for writes: there is no `updated_by` to read, and adding one would mean
 *  teaching every mutation path — description edits, task CRUD, the quote
 *  worker, the status reconciler — to write a column that would be null or
 *  "system" for most of them. The event log already answers this properly.
 *
 *  `depth: 'everything'` is required, not incidental. Reusing the pages
 *  `useProjectEvents` already holds would be free, but those are filtered by the
 *  ActivityRail's depth toggle — so the name in the Record card would silently
 *  change when the reader flipped Story/Detail/Everything.
 *
 *  Keyed under the `['aito-events', projectId]` prefix the note mutation and the
 *  description mutation already invalidate, so it refreshes with them. */
export function useLatestProjectEvent(projectId: number) {
  const query = useQuery({
    queryKey: ['aito-events', projectId, 'latest'],
    queryFn: () => api.getAitoEvents(projectId, { depth: 'everything', limit: 1 }),
  });

  return { data: query.data?.events[0] as AitoEvent | undefined, isLoading: query.isLoading };
}
