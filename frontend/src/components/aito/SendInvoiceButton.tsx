import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ACTION_CELL } from './quoteActionGroup';
import { Mail } from 'lucide-react';
import { SendInvoiceModal } from './SendInvoiceModal';

/** Email this project's invoice to the client, from the panel's Invoice card.
 *
 *  No EXISTENCE gate of its own, for the same reason `InvoicePrintButton`
 *  has none: whether an invoice exists is only known once the card's query
 *  has answered, so `InvoiceCard` does not render this until it holds one.
 *  That is a different question from the PERMISSION gate — POST
 *  /{project_id}/invoice-email enforces AITO_UPDATE, and unlike existence
 *  that is knowable up front. The permission gate is the call site's, same
 *  as `SendQuoteButton`: `InvoiceCard` wraps this in `canUpdate &&`, one
 *  card up from where `ProjectDetailPanel` does the same for the quote.
 *
 *  Re-sending an invoice already out with the client — they lost the mail,
 *  you are chasing payment — is a real thing to want, so this is offered
 *  whatever the invoice's status.
 *
 *  Same pill styling as `SendQuoteButton`: the two sit one card apart and
 *  must not read as two different kinds of control.
 */
export function SendInvoiceButton({
  projectId,
  invoiceId,
}: {
  projectId: number;
  invoiceId: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('aito.sendInvoice')}
        title={t('aito.sendInvoice')}
        className={ACTION_CELL}
      >
        <Mail className="w-3.5 h-3.5" />
      </button>
      {open && (
        <SendInvoiceModal projectId={projectId} invoiceId={invoiceId} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
