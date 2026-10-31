import { useEffect, useRef, useState } from 'react';

/** `.animate-modal-out`'s duration: the app-wide 150ms exit beat. */
export const DIALOG_EXIT_MS = 150;

/** The projects dialogs' close: `requestClose` flips `closing` (DialogShell swaps in the exit
 *  classes that same render) and fires `onClose` once the exit has had time to play — a
 *  setTimeout, not `animationend`, which never fires once reduced motion or jsdom replaces the
 *  animation. A dialog that cannot close is worse than one that skips its exit. Confirming a step
 *  (the next surface replaces this one at once) calls the caller's own callback directly instead.
 *  Escape stays with `useIsolatedEscape` (capture-phase ownership); route it through
 *  `requestClose` too. */
export function useDialogExit(onClose: () => void): { closing: boolean; requestClose: () => void } {
  const [closing, setClosing] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!closing) return;
    const id = window.setTimeout(() => onCloseRef.current(), DIALOG_EXIT_MS);
    return () => window.clearTimeout(id);
  }, [closing]);
  return { closing, requestClose: () => setClosing(true) };
}
