import { useEffect, useState } from 'react';

const IDLE_EVENTS = ['pointermove', 'pointerdown', 'keydown'] as const;

/**
 * Kiosk-style idle detection: returns true once there has been no pointer or
 * keyboard input for `timeoutMs` while `enabled`. Any input flips it back to
 * false. Used by the fullscreen camera wall to hide the cursor and chrome.
 */
export function useIdleHide(enabled: boolean, timeoutMs: number): boolean {
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setIdle(false);
      return;
    }
    let timer = setTimeout(() => setIdle(true), timeoutMs);
    const reset = () => {
      // Functional update keeps the same state value when already active, so
      // pointermove storms don't trigger re-renders
      setIdle(prev => (prev ? false : prev));
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), timeoutMs);
    };
    IDLE_EVENTS.forEach(e => document.addEventListener(e, reset, { passive: true }));
    return () => {
      clearTimeout(timer);
      IDLE_EVENTS.forEach(e => document.removeEventListener(e, reset));
    };
  }, [enabled, timeoutMs]);

  return idle;
}
