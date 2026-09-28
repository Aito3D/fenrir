import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type AitoInvoice, type AitoRetainerInvoice } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import type { EmailDocument } from '../components/aito/emailDocument';

/** Email this project's invoice or retainer invoice, then adopt Books' own
 *  post-send row for the card.
 *
 *  A plain `useMutation` for the same reason `useSendQuoteMutation` is one:
 *  the email IS the act, so nothing may be predicted locally. The cache is
 *  written only from the server's response, on success — straight into the
 *  card's own query rather than merely invalidating it, because emailing
 *  flips the Books status to `sent` and a refetch round trip would show the
 *  old one for a beat. The invoice is one cached row (`['aito-invoice']`);
 *  a retainer is one row inside the cached list (`['aito-retainers']`), so
 *  that path replaces by id. */
export function useSendDocumentEmailMutation(projectId: number, document: EmailDocument, onDone: () => void) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: (to: string): Promise<AitoInvoice | AitoRetainerInvoice> =>
      document.kind === 'invoice'
        ? api.sendAitoInvoiceEmail(projectId, { to, invoice_id: document.id })
        : api.sendAitoRetainerEmail(projectId, { to, retainer_id: document.id }),
    onSuccess: (row, to) => {
      if (document.kind === 'invoice') {
        queryClient.setQueryData(['aito-invoice', projectId], row);
        showToast(t('aito.invoiceEmailed', { email: to }), 'success');
      } else {
        queryClient.setQueryData<AitoRetainerInvoice[]>(['aito-retainers', projectId], (rows) =>
          rows?.map((r) => (r.id === row.id ? (row as AitoRetainerInvoice) : r)),
        );
        showToast(t('aito.retainerEmailed', { email: to }), 'success');
      }
      queryClient.invalidateQueries({ queryKey: ['aito-events', projectId] });
      onDone();
    },
    // No rollback to undo — nothing was written. The modal stays open so the
    // user can retry or pick another address without rebuilding the selection.
    onError: () => showToast(t(document.kind === 'invoice' ? 'aito.invoiceEmailFailed' : 'aito.retainerEmailFailed'), 'error'),
  });
}

/** The invoice-only spelling, kept so existing call sites and tests read
 *  unchanged. */
export function useSendInvoiceMutation(projectId: number, invoiceId: string, onDone: () => void) {
  return useSendDocumentEmailMutation(projectId, { kind: 'invoice', id: invoiceId }, onDone);
}
