import { useTranslation } from 'react-i18next';
import { api, type AitoProject } from '../../api/client';
import { PdfPrintButton } from './PdfPrintButton';

/** Fetch this project's Zoho estimate and put it in front of the printer.
 *
 *  The printing itself — blob, hidden iframe, load timeout, window.open
 *  fallback — lives in `PdfPrintButton`, which the Invoice card's print
 *  button shares. This file is now only the quote-specific parts: the gate,
 *  the endpoint and the label.
 */
export function QuotePrintButton({
  project,
}: {
  project: AitoProject;
}) {
  const { t } = useTranslation();

  // A hand-made card has no quote to print. Unchanged from when this file
  // owned the printing: the gate belongs to the quote, not to the printer.
  if (!project.quote_id) return null;

  return (
    <PdfPrintButton
      fetchPdf={() => api.getAitoQuotePdf(project.id)}
      label={t('aito.printQuote')}
      failureMessage={t('aito.printFailed')}
    />
  );
}
