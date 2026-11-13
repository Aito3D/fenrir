import { useEffect, useRef } from 'react';

/** A barcode scanner types like a keyboard: fast keys, then Enter. Calls `onCode` with what it typed while `active`. */
export function useScan(active: boolean, onCode: (code: string) => void) {
  const cb = useRef(onCode);
  cb.current = onCode;
  useEffect(() => {
    if (!active) return;
    let buf = '';
    let last = 0;
    const onKey = (e: KeyboardEvent) => {
      // shortcut: a scan while a field has focus types into that field and is ignored here; capture it if operators trip on this
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.timeStamp - last > 100) buf = ''; // a person types slower than a scanner
      last = e.timeStamp;
      if (e.key === 'Enter') {
        if (buf.length >= 4) {
          e.preventDefault(); // or Enter would also press the focused button
          cb.current(buf);
        }
        buf = '';
      } else if (e.key.length === 1) buf += e.key;
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [active]);
}
