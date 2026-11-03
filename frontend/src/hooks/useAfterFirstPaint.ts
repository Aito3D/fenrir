import { useEffect, useState } from 'react';

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

/** `false` on the first render, `true` once the browser has had an idle
 *  moment after mount (bounded at 1.5 s), or after 300 ms where
 *  `requestIdleCallback` does not exist (Safari, jsdom).
 *
 *  Used to hold back shell queries that no first paint needs — the update
 *  check, external links, smart plugs, debug logging, developer-mode
 *  warnings — so the page's own data calls are not queued behind them. On
 *  the HTTP/1.1 LAN deployment every request competes for six connections,
 *  so the order they start in is the order the page can use them. */
export function useAfterFirstPaint(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const w = window as IdleWindow;
    if (typeof w.requestIdleCallback === 'function') {
      const id = w.requestIdleCallback(() => setReady(true), { timeout: 1500 });
      return () => w.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(() => setReady(true), 300);
    return () => window.clearTimeout(id);
  }, []);
  return ready;
}
