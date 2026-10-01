import { useEffect, useRef } from 'react';

/** Opens a menu on a bare keypress (`.` for the open card's actions), unless
 *  the operator is typing: a focused input, textarea, select or contenteditable
 *  keeps the key. Modified presses (⌘, Ctrl, Alt) are left to the browser. */
export function useMenuShortcut(key: string, enabled: boolean, open: () => void) {
  // Latest callback without re-binding the listener on every render.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== key || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      openRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [key, enabled]);
}
