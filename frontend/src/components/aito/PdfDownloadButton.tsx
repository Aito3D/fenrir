import { useEffect, useRef, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { useToast } from '../../contexts/ToastContext';
import { ACTION_CELL } from './quoteActionGroup';

/** How long to keep the object URL alive after handing it to the anchor.
 *  The click is synchronous but the browser reads the URL lazily when it
 *  starts writing the file, so revoking immediately can abort the save.
 *  Same reasoning (and same value) as PdfPrintButton's REVOKE_DELAY_MS. */
const REVOKE_DELAY_MS = 60_000;

/** Fetch a PDF and hand it to the browser as a file download.
 *
 *  The sibling of `PdfPrintButton`, minus the printing dance: no iframe, no
 *  load timeout, no window.open fallback — an anchor with `download` set
 *  never needs a popup and never triggers a print dialog. What it shares
 *  with the print button is the reason it exists at all: the endpoints are
 *  authenticated with a Bearer token, so a plain `<a href>` to the API
 *  cannot work — the bytes must be fetched, then re-served to the browser
 *  through an object URL.
 *
 *  Rendered as an icon-only pill (bordered, same height as the labelled
 *  Print/Send pills it sits between). Three fully-labelled pills do not fit
 *  the card row in the longer locales — "Télécharger le devis" alone is
 *  wider than a third of the card — and a wrapped label reads worse than an
 *  icon with a title. `label` still feeds aria-label and the tooltip.
 */
export function PdfDownloadButton({
  fetchPdf,
  label,
  /** Filename handed to the anchor's `download` attribute, without the
   *  extension — ".pdf" is appended here so no caller can forget it. */
  filename,
  /** Toast shown when the fetch fails. Passed in for the same reason as
   *  PdfPrintButton's: the message names the document kind, and telling
   *  someone their QUOTE could not be fetched when they clicked Download on
   *  an invoice sends them to look at the wrong document. */
  failureMessage,
  /** Externally forced off — see PdfPrintButton: the caller knows the PDF
   *  the endpoint would return is outdated. */
  disabled = false,
  /** Tooltip shown instead of `label` while `disabled`; aria-label stays
   *  `label` so the accessible name never changes. */
  disabledTitle,
}: {
  fetchPdf: () => Promise<Blob>;
  label: string;
  filename: string;
  failureMessage: string;
  disabled?: boolean;
  disabledTitle?: string;
}) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);

  // Only guards setState-after-unmount; the object URL's revoke is a plain
  // timeout with no lifecycle tie, exactly like PdfPrintButton's backstop —
  // a download still writing to disk after the panel closes must not have
  // its source revoked out from under it.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const safeFilename = () =>
    `${filename.trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'document'}.pdf`;

  const download = async () => {
    setBusy(true);
    try {
      const blob = await fetchPdf();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = safeFilename();
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => {
        URL.revokeObjectURL(url);
      }, REVOKE_DELAY_MS);
    } catch {
      showToast(failureMessage, 'error');
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={download}
      disabled={busy || disabled}
      aria-label={label}
      title={disabled && disabledTitle ? disabledTitle : label}
      className={ACTION_CELL}
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
    </button>
  );
}
