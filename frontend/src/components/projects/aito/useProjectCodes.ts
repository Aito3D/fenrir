import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../api/client';
import { projectKeys } from '../projectQueries';

// Stable when there is no data, so callers' memos don't recompute every render.
const NO_CODES: Record<string, string[]> = {};

/** The first search word shaped like a code de suivi (6 characters, hyphens
 *  ignored). The server folds case and look-alike letters and says no to the rest. */
function trackingCodeIn(query: string): string | null {
  return query.split(/\s+/).find((word) => /^[0-9a-z]{6}$/i.test(word.replace(/-/g, ''))) ?? null;
}

/** Project codes per Aito order (order id as string key), one request shared by
 *  every board card. Absent without `projects:read` — the chips just stay empty.
 *
 *  Given the search `query`, a word in it that is a card's code de suivi is
 *  added to that card's codes as typed, so the search matches it: the token is
 *  never on the board, so the server resolves it to a card id. */
export function useProjectCodes(query = ''): Record<string, string[]> {
  const { data } = useQuery({
    queryKey: projectKeys.projectCodes(),
    queryFn: api.getAitoProjectCodes,
    staleTime: 30_000,
    retry: false,
  });
  const code = trackingCodeIn(query);
  const { data: hit } = useQuery({
    queryKey: ['aito-tracking-code', code?.replace(/-/g, '').toUpperCase()],
    queryFn: () => api.getAitoTrackingCodeCard(code!),
    enabled: code !== null,
    staleTime: 30_000,
    retry: false,
  });
  const codes = data ?? NO_CODES;
  const id = code !== null ? hit?.project_id : null;
  return useMemo(
    () => (id == null ? codes : { ...codes, [id]: [...(codes[String(id)] ?? []), code!] }),
    [codes, id, code],
  );
}
