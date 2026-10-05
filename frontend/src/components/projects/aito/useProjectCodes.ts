import { useQuery } from '@tanstack/react-query';
import { api } from '../../../api/client';

/** Project codes per Aito order (order id as string key), one request shared by
 *  every board card. Absent without `projects:read` — the chips just stay empty. */
export function useProjectCodes(): Record<string, string[]> {
  const { data } = useQuery({
    queryKey: ['aito-project-codes'],
    queryFn: api.getAitoProjectCodes,
    staleTime: 30_000,
    retry: false,
  });
  return data ?? {};
}
