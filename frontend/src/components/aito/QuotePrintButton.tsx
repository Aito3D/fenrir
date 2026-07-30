import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Printer } from 'lucide-react';
import { api, type AitoProject } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';

/** How long to wait for the hidden iframe to load the PDF before giving up on
 *  in-page printing. Generous: this is a local blob, so anything approaching
 *  this means the browser has declined to render it at all. */
const IFRAME_LOAD_TIMEOUT_MS = 3000;
/** How long to keep the object URL alive after handing it to the print
 *  dialog. Revoking immediately cancels the print job — the dialog reads from
 *  the URL lazily — and `afterprint` does not fire in every browser, so this
 *  is the backstop, not the primary. */
const REVOKE_DELAY_MS = 60_000;

/** Fetch this project's Zoho estimate and put it in front of the printer.
 *
 *  Why a blob and not simply an <iframe src>: the endpoint is authenticated
 *  with a Bearer token, and neither an iframe nor an anchor can carry a
 *  header. Fetching gives us the bytes; an object URL gives the iframe
 *  something same-origin to load.
 *
 *  Why a fallback: printing a PDF from an iframe is not reliable across
 *  browsers — Safari has historically refused it outright. A button that
 *  silently does nothing is worse than one that opens a tab, so a throw or a
 *  load timeout escalates to window.open and says so. */
export function QuotePrintButton({ project }: { project: AitoProject }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  if (!project.quote_id) return null;

  const cleanup = (frame: HTMLIFrameElement, url: string) => {
    window.setTimeout(() => {
      frame.remove();
      URL.revokeObjectURL(url);
    }, REVOKE_DELAY_MS);
  };

  const openInTab = (url: string, frame: HTMLIFrameElement) => {
    window.open(url, '_blank');
    showToast(t('aito.printOpenedInTab'), 'info');
    cleanup(frame, url);
  };

  const print = async () => {
    setBusy(true);
    let url: string | null = null;
    let frame: HTMLIFrameElement | null = null;
    try {
      const blob = await api.getAitoQuotePdf(project.id);
      url = URL.createObjectURL(blob);
      frame = document.createElement('iframe');
      frame.style.position = 'fixed';
      frame.style.width = '0';
      frame.style.height = '0';
      frame.style.border = '0';
      frame.style.visibility = 'hidden';
      frameRef.current = frame;

      const objectUrl = url;
      const element = frame;
      let settled = false;

      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        openInTab(objectUrl, element);
      }, IFRAME_LOAD_TIMEOUT_MS);

      element.onload = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        try {
          element.contentWindow?.focus();
          element.contentWindow?.print();
          cleanup(element, objectUrl);
        } catch {
          openInTab(objectUrl, element);
        }
      };

      element.src = objectUrl;
      document.body.appendChild(element);
    } catch {
      showToast(t('aito.printFailed'), 'error');
      if (frame) frame.remove();
      if (url) URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={print}
      disabled={busy}
      aria-label={t('aito.printQuote')}
      title={t('aito.printQuote')}
      className="inline-flex items-center p-1 -m-1 rounded-md text-bambu-gray hover:text-bambu-green hover:bg-bambu-green/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Printer className="w-3.5 h-3.5" />}
    </button>
  );
}
