import { useTranslation } from 'react-i18next';
import { api, type AitoProject } from '../../api/client';
import { PdfDownloadButton } from './PdfDownloadButton';
import type { ActionVariant } from './quoteActionGroup';

/** Fetch this project's Zoho estimate and save it as a PDF file.
 *
 *  The download twin of `QuotePrintButton`: same endpoint, same gate, only
 *  the destination differs — disk instead of the print dialog. The file is
 *  named after the quote number so a folder of saved quotes stays legible;
 *  a card mid-creation may not have one yet, so 'quote' is the fallback.
 */
export function QuoteDownloadButton({
  project,
  variant = 'cell',
}: {
  project: AitoProject;
  variant?: ActionVariant;
}) {
  const { t } = useTranslation();

  // A hand-made card has no quote. A card whose quote is still being created
  // has none YET: the endpoint waits for the creation, so the button is
  // already useful.
  if (!project.quote_id && project.quote_sync_state !== 'pending') return null;

  return (
    <PdfDownloadButton
      fetchPdf={() => api.getAitoQuotePdf(project.id)}
      label={t('aito.downloadQuote')}
      filename={project.quote_number || 'quote'}
      failureMessage={t('aito.printFailed')}
      variant={variant}
    />
  );
}
