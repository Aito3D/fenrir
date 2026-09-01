import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { PdfDownloadButton } from './PdfDownloadButton';

/** Fetch this project's Zoho invoice and save it as a PDF file.
 *
 *  The download twin of `InvoicePrintButton`, and gated the same way — not
 *  at all: whether an invoice exists is only known once the card's query has
 *  answered, so `InvoiceCard` does not render this until it holds one.
 */
export function InvoiceDownloadButton({
  projectId,
  /** The invoice the card is displaying — not a lookup this button performs.
   *  Same contract as InvoicePrintButton: the server owns the candidate set,
   *  this only says which of them. */
  invoiceId,
  /** Display number for the saved file's name. Falls back to the id — an
   *  unfinalised draft has no number yet — which is still unique and still
   *  better than every download being called "invoice.pdf". */
  invoiceNumber,
  /** True while the project's quote sync is pending — same contract as
   *  InvoicePrintButton: the caller holds the project, so the caller
   *  decides. */
  disabled = false,
}: {
  projectId: number;
  invoiceId: string;
  invoiceNumber?: string | null;
  disabled?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <PdfDownloadButton
      fetchPdf={() => api.getAitoInvoicePdf(projectId, invoiceId)}
      label={t('aito.downloadInvoice')}
      filename={invoiceNumber || invoiceId}
      failureMessage={t('aito.invoicePrintFailed')}
      disabled={disabled}
      disabledTitle={t('aito.pdfSyncPending')}
    />
  );
}
