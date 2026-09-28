import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { PdfPrintButton } from './PdfPrintButton';
import type { ActionVariant } from './quoteActionGroup';

/** Fetch one of this project's retainer invoices and put it in front of the
 *  printer. Third of the family after `QuotePrintButton` and
 *  `InvoicePrintButton`, sharing everything through `PdfPrintButton`. No
 *  gate of its own: the row only renders once `useAitoRetainers` holds it. */
export function RetainerPrintButton({
  projectId,
  retainerId,
  disabled = false,
  variant = 'cell',
}: {
  projectId: number;
  retainerId: string;
  /** True while the quote sync is pending — same rule as the invoice. */
  disabled?: boolean;
  variant?: ActionVariant;
}) {
  const { t } = useTranslation();
  return (
    <PdfPrintButton
      fetchPdf={() => api.getAitoRetainerPdf(projectId, retainerId)}
      label={t('aito.printRetainer')}
      failureMessage={t('aito.retainerPrintFailed')}
      disabled={disabled}
      disabledTitle={t('aito.pdfSyncPending')}
      variant={variant}
    />
  );
}
