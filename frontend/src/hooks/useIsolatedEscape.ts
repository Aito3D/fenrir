import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/** Escape closes THIS dialog only: a window capture-phase listener claims the
 *  key before a host dialog's own window listener (Aito's detail panel) sees
 *  it — the same trick as ConfirmModal's `isolateEscape`. Also moves focus
 *  into the dialog on mount, unless something inside already took it. */
export function useIsolatedEscape(onClose: () => void, dialogRef?: RefObject<HTMLElement | null>) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);
  useEffect(() => {
    const el = dialogRef?.current;
    if (el && !el.contains(document.activeElement)) el.focus();
  }, [dialogRef]);
}
