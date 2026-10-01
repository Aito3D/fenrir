import { ACTION_CELL, type ActionVariant } from './quoteActionGroup';
import { DOC_ICON_BUTTON_CLS, LINK_ICON_CLS } from './linkActionHelpers';
import { Loader2, Printer } from 'lucide-react';
import { usePrintBlob } from './usePrintBlob';

/** Fetch a PDF and put it in front of the printer.
 *
 *  Extracted from QuotePrintButton when the Invoice card needed the same
 *  behaviour; the printing itself now lives in `usePrintBlob`, shared again
 *  with the shipping label. What is left here is the PDF-shaped button: the
 *  endpoint, the label, and the filename the fallback download gets.
 *
 *  Renders icon-only, as one cell of the Quote/Invoice action group — see
 *  `quoteActionGroup.ts` for why that row carries no visible labels. `label`
 *  is still required: it supplies aria-label, the tooltip, and the fallback
 *  download's filename.
 */
export function PdfPrintButton({
  fetchPdf,
  label,
  /** Toast shown when the fetch fails. Passed in rather than hardcoded: the
   *  existing string names the quote specifically, and telling someone their
   *  QUOTE could not be fetched when they clicked Print on an invoice sends
   *  them to look at the wrong document. */
  failureMessage,
  variant = 'cell',
}: {
  fetchPdf: () => Promise<Blob>;
  label: string;
  failureMessage: string;
  variant?: ActionVariant;
}) {
  // A blob URL is not "download.pdf" on its own — the browser has no path to
  // read a name from — so the fallback anchor needs one supplied. Derived
  // from `label` ("Print quote" -> "quote.pdf") rather than hardcoded: this
  // component is shared between the quote and invoice buttons, and a
  // filename that always says "quote" on an invoice download would be a
  // second, quieter version of the bug this fix closes.
  const downloadFilename = `${(label.replace(/^print\s+/i, '').trim() || 'document').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`;

  const { print, busy } = usePrintBlob({ failureMessage, downloadFilename });

  const icon = variant === 'icon' ? LINK_ICON_CLS : 'w-3.5 h-3.5';
  return (
    <button
      type="button"
      onClick={() => print(fetchPdf)}
      disabled={busy}
      aria-label={label}
      title={label}
      className={variant === 'icon' ? DOC_ICON_BUTTON_CLS : ACTION_CELL}
    >
      {busy ? <Loader2 className={`${icon} animate-spin`} /> : <Printer className={icon} />}
    </button>
  );
}
