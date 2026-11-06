import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api, type AitoInvoiceEmailContent, type AitoRetainerEmailContent } from '../../api/client';
import { useSendDocumentEmailMutation } from '../../hooks/useSendInvoiceMutation';
import { SendEmailDialog } from './SendEmailDialog';
import type { EmailDocument } from './emailDocument';

/** Pick an address and email this project's invoice through Zoho Books.
 *
 *  The Send-quote modal's twin, and deliberately identical in shape: the two
 *  open from cards one above the other and must not read as two different
 *  kinds of dialog. The dialog itself is `SendEmailDialog`, shared with the
 *  Order Board's invoices; this is the Aito card's query and send around it.
 *
 *  Takes the `EmailDocument` (invoice or retainer) rather than the project
 *  row: unlike a quote, whose id lives on the project, the invoice or
 *  retainer is only known once the card's query has answered — and pinning
 *  to THAT document is the point (see `document`).
 */
export function SendInvoiceModal({
  projectId,
  /** The invoice or retainer invoice the card is displaying. The card
   *  renders from a cache while the endpoint resolves live, so "whatever is
   *  newest" could email a document whose number the operator never saw.
   *  The server still owns the candidate set; this only says which of them. */
  document,
  contactPersonId = null,
  onClose,
}: {
  projectId: number;
  document: EmailDocument;
  /** The card's contact person, when it has one: preferred over Books'
   *  default recipient. Null on person cards and older company cards. */
  contactPersonId?: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // The dialog closes itself once the send resolved, so the hook's own
  // done-callback has nothing left to do here.
  const mutation = useSendDocumentEmailMutation(projectId, document, () => {});

  const content = useQuery<AitoInvoiceEmailContent | AitoRetainerEmailContent>({
    queryKey: [document.kind === 'invoice' ? 'aito-invoice-email' : 'aito-retainer-email', projectId, document.id],
    queryFn: () =>
      document.kind === 'invoice'
        ? api.getAitoInvoiceEmail(projectId, document.id)
        : api.getAitoRetainerEmail(projectId, document.id),
    // Books' current truth, and the modal is short-lived: a list cached from
    // an hour ago could offer an address Books has since removed, which the
    // send would then reject.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  return (
    <SendEmailDialog
      title={t(document.kind === 'invoice' ? 'aito.sendInvoiceTitle' : 'aito.sendRetainerTitle')}
      loadFailed={t(document.kind === 'invoice' ? 'aito.sendInvoiceLoadFailed' : 'aito.sendRetainerLoadFailed')}
      content={content}
      onSend={mutation.mutateAsync}
      contactPersonId={contactPersonId}
      onClose={onClose}
    />
  );
}
