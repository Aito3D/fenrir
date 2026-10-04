import { useQuery } from '@tanstack/react-query';
import { api, type AitoProject } from '../../api/client';

/** This quote's own unspent deposits + its open invoice (GET invoice-deposits).
 *  Live, like useAitoInvoice; the caller gates it on an invoice with a balance. */
export function useAitoInvoiceDeposits(project: AitoProject, enabled: boolean) {
  return useQuery({
    queryKey: ['aito-invoice-deposits', project.id],
    queryFn: () => api.getAitoInvoiceDeposits(project.id),
    enabled,
    staleTime: 30_000,
  });
}
