import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mail } from 'lucide-react';
import { SendInvoiceModal } from './SendInvoiceModal';

/** Email this project's invoice to the client, from the panel's Invoice card.
 *
 *  No gate of its own, for the same reason `InvoicePrintButton` has none:
 *  whether an invoice exists is only known once the card's query has
 *  answered, so `InvoiceCard` does not render this until it holds one.
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
  className = '',
}: {
  projectId: number;
  invoiceId: string;
  className?: string;
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
        className={`inline-flex items-center gap-1.5 rounded-md border border-bambu-dark-tertiary px-2.5 py-1 text-sm text-bambu-gray-light hover:text-white hover:border-bambu-gray hover:bg-bambu-dark-tertiary/40 transition-colors motion-reduce:transition-none disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40 ${className}`}
      >
        <Mail className="w-3.5 h-3.5" />
        {t('aito.sendInvoice')}
      </button>
      {open && (
        <SendInvoiceModal projectId={projectId} invoiceId={invoiceId} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
