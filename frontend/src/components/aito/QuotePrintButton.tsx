import { useTranslation } from 'react-i18next';
import { api, type AitoProject } from '../../api/client';
import { PdfPrintButton } from './PdfPrintButton';
import type { ActionVariant } from './quoteActionGroup';

/** Fetch this project's Zoho estimate and put it in front of the printer.
 *
 *  The printing itself — blob, hidden iframe, load timeout, window.open
 *  fallback — lives in `PdfPrintButton`, which the Invoice card's print
 *  button shares. This file is now only the quote-specific parts: the gate,
 *  the endpoint and the label.
 *
 *  Not gated on a pending sync: the endpoint pushes the card's changes to
 *  Zoho first and answers once Zoho holds the latest lines, so the button
 *  simply shows its spinner a little longer.
 */
export function QuotePrintButton({
  project,
  variant = 'cell',
}: {
  project: AitoProject;
  variant?: ActionVariant;
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
      variant={variant}
    />
  );
}
