import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { PdfDownloadButton } from './PdfDownloadButton';
import type { ActionVariant } from './quoteActionGroup';

/** The download twin of `RetainerPrintButton`; the file is named after the
 *  retainer number, falling back to the id like the invoice's. */
export function RetainerDownloadButton({
  projectId,
  retainerId,
  retainerNumber,
  disabled = false,
  variant = 'cell',
}: {
  projectId: number;
  retainerId: string;
  retainerNumber?: string | null;
  disabled?: boolean;
  variant?: ActionVariant;
}) {
  const { t } = useTranslation();
  return (
    <PdfDownloadButton
      fetchPdf={() => api.getAitoRetainerPdf(projectId, retainerId)}
      label={t('aito.downloadRetainer')}
      filename={retainerNumber || retainerId}
      failureMessage={t('aito.retainerPrintFailed')}
      disabled={disabled}
      disabledTitle={t('aito.pdfSyncPending')}
      variant={variant}
    />
  );
}
