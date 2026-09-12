import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type AitoInvoiceCreated } from '../api/client';
import { useToast } from '../contexts/ToastContext';

/** Raise the invoice for a finished project, then show it.
 *
 *  A plain `useMutation` with no optimistic write, same stance as
 *  `useSendInvoiceMutation`: the invoice IS the act, it happens in Zoho, and
 *  nothing about it may be predicted locally. The server's response is
 *  written straight into the Invoice card's own query so the card appears in
 *  the same frame the button disappears — a refetch round trip would leave
 *  the panel briefly showing neither.
 *
 *  The board is invalidated too, not just the card: raising an invoice makes
 *  `aito_quote_sync._is_locked` true on the next pass, which changes the
 *  project's sync state and the Quote card's help text along with it.
 *
 *  The success toast names the deposits, because that is the half of this
 *  action the operator cannot see anywhere else — a retainer reported as not
 *  applied is the cue to go and settle it in Books by hand.
 */
export function useCreateInvoiceMutation(projectId: number, onDone: () => void) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: () => api.createAitoInvoice(projectId),
    onSuccess: (invoice: AitoInvoiceCreated) => {
      queryClient.setQueryData(['aito-invoice', projectId], invoice);
      queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      queryClient.invalidateQueries({ queryKey: ['aito-events', projectId] });
      const applied = invoice.retainers.reduce((sum, r) => sum + r.applied, 0);
      const missed = invoice.retainers.filter((r) => r.applied < r.total);
      showToast(
        missed.length > 0
          ? t('aito.createInvoiceDonePartial', {
              number: invoice.number,
              retainers: missed.map((r) => r.number).join(', '),
            })
          : applied > 0
            ? t('aito.createInvoiceDonePaid', { number: invoice.number })
            : t('aito.createInvoiceDone', { number: invoice.number }),
        missed.length > 0 ? 'warning' : 'success',
      );
      onDone();
    },
    // Nothing was written locally, so there is nothing to roll back. The
    // dialog stays open: the commonest cause is Zoho being briefly
    // unreachable, and retrying from the open dialog is one click.
    onError: (error: Error) => showToast(error.message || t('aito.createInvoiceFailed'), 'error'),
  });
}
