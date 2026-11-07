import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

/** The shared non-probing Zoho status query; one key so every caller dedupes onto one request. */
export function useAitoZohoStatus(enabled?: boolean) {
  return useQuery({
    queryKey: ['zoho-status', { probe: false }],
    queryFn: () => api.getZohoStatus(),
    staleTime: 60_000,
    enabled,
  });
}
