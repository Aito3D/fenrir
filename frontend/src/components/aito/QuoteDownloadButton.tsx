import { useTranslation } from 'react-i18next';
import { api, type AitoProject } from '../../api/client';
import { PdfDownloadButton } from './PdfDownloadButton';

/** Fetch this project's Zoho estimate and save it as a PDF file.
 *
 *  The download twin of `QuotePrintButton`: same endpoint, same gate, only
 *  the destination differs — disk instead of the print dialog. The file is
 *  named after the quote number so a folder of saved quotes stays legible;
 *  a card mid-creation may not have one yet, so 'quote' is the fallback.
 */
export function QuoteDownloadButton({
  project,
}: {
  project: AitoProject;
}) {
  const { t } = useTranslation();

  // A hand-made card has no quote to download — same gate as
  // QuotePrintButton, for the same reason.
  if (!project.quote_id) return null;

  return (
    <PdfDownloadButton
      fetchPdf={() => api.getAitoQuotePdf(project.id)}
      label={t('aito.downloadQuote')}
      filename={project.quote_number || 'quote'}
      failureMessage={t('aito.printFailed')}
      // Same gate, same reason as QuotePrintButton: a download taken while
      // an edit is still on its way to Zoho saves the pre-edit PDF.
      disabled={project.quote_sync_state === 'pending'}
      disabledTitle={t('aito.pdfSyncPending')}
    />
  );
}
