/**
 * Copy text to the clipboard, with a fallback for non-secure contexts.
 *
 * Fenrir is usually reached over plain HTTP on a LAN / tailnet IP, where
 * `navigator.clipboard` is unavailable — so the hidden-textarea + execCommand
 * fallback is required, not optional. Returns true if the copy succeeded.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path.
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  try {
    ta.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    if (ta.parentNode) ta.parentNode.removeChild(ta);
  }
}

/**
 * Start a clipboard write whose text is still being fetched, synchronously — call it inside the
 * click handler. Safari only honours a write issued during the user gesture, and `ClipboardItem`
 * accepts a promised blob, so the gesture survives the round trip. Returns null where that is
 * unsupported (insecure context, old browser); the promise rejects when the write is refused or
 * the text promise rejects/resolves empty.
 */
export function writeClipboardFromPromise(text: Promise<string | null>): Promise<void> | null {
  if (!window.isSecureContext || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return null;
  const blob = text.then((t) => {
    if (!t) throw new Error('empty');
    return new Blob([t], { type: 'text/plain' });
  });
  try {
    return navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
  } catch {
    blob.catch(() => undefined);
    return Promise.reject(new Error('clipboard write refused'));
  }
}

/** Trigger a browser download of `text` as a file named `filename`. */
export function downloadTextFile(text: string, filename: string, mimeType = 'text/plain'): void {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
