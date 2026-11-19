import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { OrderDocumentKind } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { SendEmailDialog } from '../aito/SendEmailDialog';
import { useOrderActions } from './useOrderActions';

/** Email the order's quote or a deposit invoice through Zoho Books: the Aito card's dialog and wording. */
export function OrderDocumentEmailModal({ orderId, kind, docId, onClose }: { orderId: string; kind: OrderDocumentKind; docId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { emailDocument } = useOrderActions();
  // Books' current truth, never cached: an address Books has since removed would be refused by the send.
  const content = useQuery({
    queryKey: ['order-document-email', orderId, kind, docId],
    queryFn: () => api.getOrderDocumentEmail(orderId, kind, docId),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const quote = kind === 'quote';

  const send = async (to: string) => {
    try {
      await emailDocument.mutateAsync({ id: orderId, kind, docId, to });
    } catch (e) {
      showToast(t(quote ? 'aito.quoteEmailFailed' : 'aito.retainerEmailFailed'), 'error');
      throw e;
    }
    showToast(t(quote ? 'aito.quoteEmailed' : 'aito.retainerEmailed', { email: to }), 'success');
  };

  return (
    <SendEmailDialog
      title={t(quote ? 'aito.sendQuoteTitle' : 'aito.sendRetainerTitle')}
      loadFailed={t(quote ? 'aito.sendQuoteLoadFailed' : 'aito.sendRetainerLoadFailed')}
      content={content}
      onSend={send}
      onClose={onClose}
    />
  );
}
