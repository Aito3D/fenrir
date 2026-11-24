import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import type { OrderDocumentKind } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { SendEmailDialog } from '../aito/SendEmailDialog';
import { useOrderActions } from './useOrderActions';
import { quoteReason, useQuoteActions } from './useQuoteActions';

type Target = { orderId: string; kind: OrderDocumentKind; docId: string; quoteId?: never } | { quoteId: string; orderId?: never; kind?: never; docId?: never };

/** Email the order's quote or a deposit invoice through Zoho Books: the Aito card's dialog and wording.
 *  Given `quoteId` instead, it emails a quote of the Devis side (whose answer is the fresh quotes list). */
export function OrderDocumentEmailModal({ onClose, ...target }: Target & { onClose: () => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { emailDocument } = useOrderActions();
  const { email: emailQuote } = useQuoteActions();
  const { orderId, kind, docId, quoteId } = target;
  // Books' current truth, never cached: an address Books has since removed would be refused by the send.
  const content = useQuery({
    queryKey: quoteId ? ['quote-email', quoteId] : ['order-document-email', orderId, kind, docId],
    queryFn: () => (quoteId ? api.getQuoteEmail(quoteId) : api.getOrderDocumentEmail(orderId!, kind!, docId!)),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const quote = !!quoteId || kind === 'quote';

  const send = async (to: string) => {
    try {
      if (quoteId) await emailQuote.mutateAsync({ id: quoteId, to });
      else await emailDocument.mutateAsync({ id: orderId!, kind: kind!, docId: docId!, to });
    } catch (e) {
      showToast(
        e instanceof ApiError && e.code === 'recipient_recently_edited' ? t('aito.emailRecipientRecentlyEdited')
        // The once-a-minute guard and the email rate limit answer 409 too: the server's words, not "another action".
        : quoteId && e instanceof ApiError && e.status === 409 ? t('orders.quotes.emailFailed', { reason: e.message })
        : quoteId ? t('orders.quotes.emailFailed', { reason: quoteReason(t, e) })
        // The server's reason (Books' own words on a 502) is what tells a refusal from an outage.
        : `${t(quote ? 'aito.quoteEmailFailed' : 'aito.retainerEmailFailed')}${e instanceof ApiError && e.message ? ` — ${e.message}` : ''}`,
        'error',
      );
      throw e;
    }
    showToast(t(quote ? 'aito.quoteEmailed' : 'aito.retainerEmailed', { email: to }), 'success');
  };

  const dialog = (
    <SendEmailDialog
      title={t(quote ? 'aito.sendQuoteTitle' : 'aito.sendRetainerTitle')}
      loadFailed={t(quote ? 'aito.sendQuoteLoadFailed' : 'aito.sendRetainerLoadFailed')}
      content={content}
      onSend={send}
      onClose={onClose}
    />
  );
  // A quote of the Devis side wears violet: the shared (Aito) dialog's green primary button is recoloured from here.
  return quoteId ? (
    <div data-testid="quote-email-accent" className="contents [&_.bg-bambu-green]:!bg-violet-600 [&_.bg-bambu-green]:!text-white [&_.bg-bambu-green]:hover:!bg-violet-500 [&_.bg-bambu-green]:focus:!ring-violet-500">
      {dialog}
    </div>
  ) : dialog;
}
