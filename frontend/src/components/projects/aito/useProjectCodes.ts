import { useQuery } from '@tanstack/react-query';
import { api } from '../../../api/client';
import { projectKeys } from '../projectQueries';

// Stable when there is no data, so callers' memos don't recompute every render.
const NO_CODES: Record<string, string[]> = {};

/** Project codes per Aito order (order id as string key), one request shared by
 *  every board card. Absent without `projects:read` — the chips just stay empty. */
export function useProjectCodes(): Record<string, string[]> {
  const { data } = useQuery({
    queryKey: projectKeys.projectCodes(),
    queryFn: api.getAitoProjectCodes,
    staleTime: 30_000,
    retry: false,
  });
  return data ?? NO_CODES;
}
