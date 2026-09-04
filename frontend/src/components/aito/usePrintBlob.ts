import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../../contexts/ToastContext';

/** How long to wait for the hidden iframe to load the document before giving
 *  up on in-page printing. Generous: this is a local blob, so anything
 *  approaching this means the browser has declined to render it at all. */
const IFRAME_LOAD_TIMEOUT_MS = 3000;
/** How long to keep the object URL alive after handing it to the print
 *  dialog. Revoking immediately cancels the print job — the dialog reads from
 *  the URL lazily — and `afterprint` does not fire in every browser, so this
 *  is the backstop, not the primary. */
const REVOKE_DELAY_MS = 60_000;

/** Put a Blob in front of the printer.
 *
 *  Lifted out of `PdfPrintButton` when the shipping label needed the same
 *  behaviour for an HTML document rather than a PDF: the awkward part — blob,
 *  hidden iframe, load timeout, window.open fallback, unmount guards — is
 *  identical for anything printable, and only the button around it differs.
 *  Two hand-maintained copies of the cross-browser printing dance is how one
 *  of them silently stops working.
 *
 *  Why a blob and not simply an <iframe src>: the PDF endpoints are
 *  authenticated with a Bearer token, and neither an iframe nor an anchor can
 *  carry a header. Producing the bytes ourselves gives us something; an object
 *  URL gives the iframe something same-origin to load. The label has no
 *  endpoint at all — it is built in the browser — so a blob is the only shape
 *  it could ever take.
 *
 *  Why a fallback: printing from an iframe is not reliable across browsers —
 *  Safari has historically refused it outright. A button that silently does
 *  nothing is worse than one that opens a tab, so a throw or a load timeout
 *  escalates to window.open and says so.
 *
 *  `busy` is true from click until the print has been handed off or has
 *  failed; callers disable their button on it, which is what keeps this to
 *  a single in-flight print (and a single pending URL ref) at a time.
 */
export function usePrintBlob({
  /** Toast shown when `produce` throws. Passed in rather than hardcoded:
   *  telling someone their QUOTE could not be fetched when they clicked Print
   *  on an invoice sends them to look at the wrong document. */
  failureMessage,
  /** Name for the file when the blocked-popup fallback hands the blob over
   *  as a download. A blob URL has no path to read a name from. */
  downloadFilename,
}: {
  failureMessage: string;
  downloadFilename: string;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  // Tracks the object URL for the print currently in flight, from the
  // moment it is created until `cleanup` below has taken over its revoke
  // (its own REVOKE_DELAY_MS backstop). Only one print can be in flight at
  // a time — callers disable on `busy` for the whole span between click and
  // settle — so a single ref, mirroring frameRef, is enough; it is not a
  // set. If unmount happens while this is still non-null, nobody has yet
  // scheduled that URL's revoke, so the unmount cleanup below must.
  const pendingUrlRef = useRef<string | null>(null);

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
      // Any pending revoke (iframe path or window.open path alike) is left
      // running rather than force-revoked here: REVOKE_DELAY_MS's own reason
      // for existing — the print dialog reads the URL lazily, so revoking
      // immediately can cancel the job — applies just as much to a dialog
      // still open after this panel is closed as to one still open while it
      // is visible. Its own 60s backstop (scheduled in `cleanup` below) is
      // what revokes it, exactly once, whether or not this component is
      // still mounted when that happens.
      if (frameRef.current) {
        frameRef.current.remove();
        frameRef.current = null;
      }
      // If the print in flight never made it to `cleanup` — the timer path
      // and `onload` both bail on `mountedRef` before reaching it — nothing
      // has scheduled this URL's revoke yet, and it would otherwise pin the
      // whole document in memory for the tab's lifetime. Give it the same
      // delayed revoke `cleanup` would have, rather than revoking now: the
      // reasoning above (a dialog may still be reading it) applies here
      // too, since this fires before that dialog has had a chance to open.
      if (pendingUrlRef.current) {
        const orphanedUrl = pendingUrlRef.current;
        pendingUrlRef.current = null;
        window.setTimeout(() => {
          URL.revokeObjectURL(orphanedUrl);
        }, REVOKE_DELAY_MS);
      }
    };
  }, []);

  const cleanup = (frame: HTMLIFrameElement, url: string) => {
    if (pendingUrlRef.current === url) pendingUrlRef.current = null;
    window.setTimeout(() => {
      frame.remove();
      URL.revokeObjectURL(url);
      if (frameRef.current === frame) frameRef.current = null;
    }, REVOKE_DELAY_MS);
  };

  const openInTab = (url: string, frame: HTMLIFrameElement) => {
    const popup = window.open(url, '_blank');
    if (popup) {
      showToast(t('aito.printOpenedInTab'), 'info');
    } else {
      // Popup blockers refuse window.open outside a user gesture, and both
      // callers of openInTab run from one (the load-timeout timer, the
      // catch around contentWindow.print()). Telling the operator it opened
      // when nothing did is worse than telling them printing failed, so this
      // reports failure — but the document was already produced, so it is
      // handed over as a download rather than only revoked out from under
      // them.
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = downloadFilename;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      showToast(t('aito.printPopupBlocked'), 'error');
    }
    cleanup(frame, url);
    setBusy(false);
  };

  /** Produce the document and print it. `produce` may fetch (the PDF
   *  buttons) or build in memory (the label); either way a throw lands on
   *  `failureMessage`. */
  const print = async (produce: () => Promise<Blob> | Blob) => {
    setBusy(true);
    let url: string | null = null;
    let frame: HTMLIFrameElement | null = null;
    try {
      const blob = await produce();
      if (!mountedRef.current) return;
      url = URL.createObjectURL(blob);
      pendingUrlRef.current = url;
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
      if (url) {
        if (pendingUrlRef.current === url) pendingUrlRef.current = null;
        URL.revokeObjectURL(url);
      }
      setBusy(false);
    }
  };

  return { print, busy };
}
