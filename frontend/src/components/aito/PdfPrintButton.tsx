import { ACTION_CELL } from './quoteActionGroup';
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
  /** Externally forced off — the caller knows the PDF the endpoint would
   *  return is outdated (a quote edit still on its way to Zoho). Distinct
   *  from `busy`, which is the hook's own in-flight state. */
  disabled = false,
  /** Tooltip shown INSTEAD of `label` while `disabled` — the one place the
   *  operator can learn why the button refuses. aria-label stays `label`
   *  so the button keeps its accessible name (and test queries) either way. */
  disabledTitle,
}: {
  fetchPdf: () => Promise<Blob>;
  label: string;
  failureMessage: string;
  disabled?: boolean;
  disabledTitle?: string;
}) {
  // A blob URL is not "download.pdf" on its own — the browser has no path to
  // read a name from — so the fallback anchor needs one supplied. Derived
  // from `label` ("Print quote" -> "quote.pdf") rather than hardcoded: this
  // component is shared between the quote and invoice buttons, and a
  // filename that always says "quote" on an invoice download would be a
  // second, quieter version of the bug this fix closes.
  const downloadFilename = `${(label.replace(/^print\s+/i, '').trim() || 'document').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`;

  const { print, busy } = usePrintBlob({ failureMessage, downloadFilename });

  return (
    <button
      type="button"
      onClick={() => print(fetchPdf)}
      disabled={busy || disabled}
      aria-label={label}
      title={disabled && disabledTitle ? disabledTitle : label}
      className={ACTION_CELL}
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Printer className="w-3.5 h-3.5" />}
    </button>
  );
}
