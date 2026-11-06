import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { OrderInvoice } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { SendEmailDialog } from '../aito/SendEmailDialog';
import { useOrderActions } from './useOrderActions';

/** Pick an address and email one of an order's invoices through Zoho Books: the Aito card's dialog and wording. */
export function OrderInvoiceEmailModal({ invoice, onClose }: { invoice: Pick<OrderInvoice, 'id'>; onClose: () => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { emailInvoice } = useOrderActions();
  // Books' current truth, never cached: an address Books has since removed would be refused by the send.
  const content = useQuery({
    queryKey: ['order-invoice-email', invoice.id],
    queryFn: () => api.getOrderInvoiceEmail(invoice.id),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const send = async (to: string) => {
    try {
      await emailInvoice.mutateAsync({ invoiceId: invoice.id, to });
    } catch (e) {
      showToast(t('aito.invoiceEmailFailed'), 'error');
      throw e;
    }
    showToast(t('aito.invoiceEmailed', { email: to }), 'success');
  };

  return (
    <SendEmailDialog
      title={t('aito.sendInvoiceTitle')}
      loadFailed={t('aito.sendInvoiceLoadFailed')}
      content={content}
      onSend={send}
      onClose={onClose}
    />
  );
}
