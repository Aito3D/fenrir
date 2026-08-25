import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { PdfPrintButton } from './PdfPrintButton';

/** Fetch this project's Zoho invoice and put it in front of the printer.
 *
 *  The twin of `QuotePrintButton`, sharing all of its machinery through
 *  `PdfPrintButton`. No gate of its own: unlike the quote — whose id sits on
 *  the project and can be checked for free — whether an invoice exists is
 *  only known once the card's query has answered, so `InvoiceCard` does not
 *  render this until it holds one.
 */
export function InvoicePrintButton({
  projectId,
  /** The invoice the card is displaying — not a lookup this button performs.
   *  The card reads from a cache while the endpoint resolves live, so
   *  printing "whatever is newest" could hand over a document whose number
   *  the operator never saw. The server still owns the candidate set; this
   *  only says which of them. */
  invoiceId,
}: {
  projectId: number;
  invoiceId: string;
}) {
  const { t } = useTranslation();

  return (
    <PdfPrintButton
      fetchPdf={() => api.getAitoInvoicePdf(projectId, invoiceId)}
      label={t('aito.printInvoice')}
      failureMessage={t('aito.invoicePrintFailed')}
    />
  );
}
