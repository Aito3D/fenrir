import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useToast } from '../contexts/ToastContext';

/** Email this project's invoice, then adopt Books' own row for the card.
 *
 *  A plain `useMutation` for the same reason `useSendQuoteMutation` is one:
 *  the email IS the act, so nothing may be predicted locally. The cache is
 *  written only from the server's response, on success.
 *
 *  Simpler than the quote's twin in one way — no board column moves, so
 *  there is no `marked_sent` tri-state and only one success toast. Emailing
 *  an invoice does flip its Books status to `sent`, which is why the
 *  response is written straight into the card's own query rather than merely
 *  invalidating it: the status the operator reads changes as a direct result
 *  of what they just did, and a refetch round trip would show the old one
 *  for a beat.
 */
export function useSendInvoiceMutation(projectId: number, invoiceId: string, onDone: () => void) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: (to: string) => api.sendAitoInvoiceEmail(projectId, { to, invoice_id: invoiceId }),
    onSuccess: (invoice, to) => {
      queryClient.setQueryData(['aito-invoice', projectId], invoice);
      queryClient.invalidateQueries({ queryKey: ['aito-events', projectId] });
      showToast(t('aito.invoiceEmailed', { email: to }), 'success');
      onDone();
    },
    // No rollback to undo — nothing was written. The modal stays open so the
    // user can retry or pick another address without rebuilding the selection.
    onError: () => showToast(t('aito.invoiceEmailFailed'), 'error'),
  });
}
