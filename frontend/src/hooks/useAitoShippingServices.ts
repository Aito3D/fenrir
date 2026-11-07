import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

/** The shared island/shipping-service table query; one key so every caller dedupes onto one request. */
export function useAitoShippingServices(enabled?: boolean) {
  return useQuery({
    queryKey: ['aito-shipping-services'],
    queryFn: api.getAitoShippingServices,
    staleTime: 60 * 60_000,
    enabled,
  });
}
