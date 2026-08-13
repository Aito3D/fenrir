import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Printer } from 'lucide-react';
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

/** Fetch a PDF and put it in front of the printer.
 *
 *  Extracted from QuotePrintButton when the Invoice card needed the same
 *  behaviour: the awkward part here — blob, hidden iframe, load timeout,
 *  window.open fallback, unmount guards — is identical for any PDF, and only
 *  the endpoint and the label differ. Two hand-maintained copies of the
 *  cross-browser printing dance is how one of them silently stops working.
 *
 *  Why a blob and not simply an <iframe src>: the endpoints are authenticated
 *  with a Bearer token, and neither an iframe nor an anchor can carry a
 *  header. Fetching gives us the bytes; an object URL gives the iframe
 *  something same-origin to load.
 *
 *  Why a fallback: printing a PDF from an iframe is not reliable across
 *  browsers — Safari has historically refused it outright. A button that
 *  silently does nothing is worse than one that opens a tab, so a throw or a
 *  load timeout escalates to window.open and says so.
 */
export function PdfPrintButton({
  fetchPdf,
  label,
  /** Toast shown when the fetch fails. Passed in rather than hardcoded: the
   *  existing string names the quote specifically, and telling someone their
   *  QUOTE could not be fetched when they clicked Print on an invoice sends
   *  them to look at the wrong document. */
  failureMessage,
  /** Renders `label` beside the icon, styled as a bordered pill matching the
   *  panel footer's "Open in Zoho" link. Opt-in (default false) rather than a
   *  default change: the icon-only rendering is kept for any other caller
   *  that wants the compact form. */
  withLabel = false,
  /** Extra classes for the labelled form — the cards stretch it to share a
   *  row, or to fill one. */
  className = '',
}: {
  fetchPdf: () => Promise<Blob>;
  label: string;
  failureMessage: string;
  withLabel?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const timeoutRef = useRef<number | null>(null);
  // Every in-flight 60s revoke backstop (see REVOKE_DELAY_MS). An array of
  // entries rather than a single pair: printing twice inside one 60s window
  // must not lose track of the first URL when the second starts. Entries are
  // matched by object identity rather than by URL string so two entries can
  // never collide. Unmounting does not touch this array at all — see below.
  const pendingRevokesRef = useRef<{ url: string; timerId: number }[]>([]);
  const mountedRef = useRef(true);

  // The fallback timer (and the iframe it may act on) must not outlive the
  // component: closing the detail panel within IFRAME_LOAD_TIMEOUT_MS of
  // clicking print must not later pop a stray tab for a screen the user has
  // already left. Clearing the timeout handles the timer path; mountedRef
  // additionally guards `onload`, which can still fire after unmount.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      // Every pending revoke (iframe path or window.open path alike) is left
      // running rather than force-revoked here: REVOKE_DELAY_MS's own reason
      // for existing — the print dialog reads the URL lazily, so revoking
      // immediately can cancel the job — applies just as much to a dialog
      // still open after this panel is closed as to one still open while it
      // is visible. This matches BASE, where the revoke was a bare
      // `window.setTimeout` with no lifecycle tie to the component at all.
      // Each entry's own 60s backstop (scheduled in `cleanup` below) is what
      // revokes it, exactly once, whether or not this component is still
      // mounted when that happens.
      if (frameRef.current) {
        frameRef.current.remove();
        frameRef.current = null;
      }
    };
  }, []);

  const cleanup = (frame: HTMLIFrameElement, url: string) => {
    const entry = { url, timerId: 0 };
    entry.timerId = window.setTimeout(() => {
      pendingRevokesRef.current = pendingRevokesRef.current.filter((e) => e !== entry);
      frame.remove();
      URL.revokeObjectURL(url);
      if (frameRef.current === frame) frameRef.current = null;
    }, REVOKE_DELAY_MS);
    pendingRevokesRef.current.push(entry);
  };

  const openInTab = (url: string, frame: HTMLIFrameElement) => {
    window.open(url, '_blank');
    showToast(t('aito.printOpenedInTab'), 'info');
    cleanup(frame, url);
    setBusy(false);
  };

  const print = async () => {
    setBusy(true);
    let url: string | null = null;
    let frame: HTMLIFrameElement | null = null;
    try {
      const blob = await fetchPdf();
      if (!mountedRef.current) return;
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
        timeoutRef.current = null;
        if (settled || !mountedRef.current) return;
        settled = true;
        openInTab(objectUrl, element);
      }, IFRAME_LOAD_TIMEOUT_MS);
      timeoutRef.current = timer;

      element.onload = () => {
        if (settled || !mountedRef.current) return;
        settled = true;
        window.clearTimeout(timer);
        timeoutRef.current = null;
        try {
          element.contentWindow?.focus();
          element.contentWindow?.print();
          cleanup(element, objectUrl);
          setBusy(false);
        } catch {
          openInTab(objectUrl, element);
        }
      };

      element.src = objectUrl;
      document.body.appendChild(element);
    } catch {
      showToast(failureMessage, 'error');
      if (frame) frame.remove();
      if (url) URL.revokeObjectURL(url);
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={print}
      disabled={busy}
      aria-label={label}
      title={label}
      className={
        withLabel
          ? `inline-flex items-center gap-1.5 rounded-md border border-bambu-dark-tertiary px-2.5 py-1 text-sm text-bambu-gray-light hover:text-white hover:border-bambu-gray hover:bg-bambu-dark-tertiary/40 transition-colors motion-reduce:transition-none disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40 ${className}`
          : `inline-flex items-center p-1 -m-1 rounded-md text-bambu-gray hover:text-bambu-green hover:bg-bambu-green/10 transition-colors motion-reduce:transition-none disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40`
      }
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Printer className="w-3.5 h-3.5" />}
      {withLabel && label}
    </button>
  );
}
