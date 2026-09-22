import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';

/** How long a rating stays fresh in the browser before the endpoint is
 *  re-asked. The backend caches an hour per customer, so this is only about
 *  not re-requesting on every panel open; five minutes like the invoice. */
const RATING_STALE_MS = 5 * 60_000;

/** The customer's payment rating, shared by the drawer and the panel so both
 *  read one cache entry per customer. Disabled for an empty id (no client on
 *  the card, or the walk-in default which the backend rates `new` anyway).
 *  `retry: false`: the endpoint already degrades to `unavailable` instead
 *  of failing, so a retry would only be a network error repeated. */
export function useClientRating(clientId: string) {
  return useQuery({
    queryKey: ['aito-client-rating', clientId],
    queryFn: () => api.getAitoClientRating(clientId),
    enabled: clientId !== '',
    staleTime: RATING_STALE_MS,
    retry: false,
  });
}
