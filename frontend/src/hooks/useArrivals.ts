import { useRef } from 'react';

/**
 * The keys that arrived AFTER the list first rendered with data, so only they
 * play an entrance animation: a page load never cascades, a new card or event
 * does. Pass `ready=false` while the list is still loading — the first ready
 * render is the baseline. Once a key is flagged it stays flagged, so a re-render
 * mid-animation (a poll) never strips the class and cuts the entrance short;
 * the animation itself plays once, when the element mounts.
 */
export function useArrivals(keys: readonly (string | number)[], ready = true): ReadonlySet<string | number> {
  const known = useRef<Set<string | number> | null>(null);
  const arrived = useRef<Set<string | number>>(new Set());
  if (!ready) return arrived.current;
  if (known.current === null) {
    known.current = new Set(keys);
    return arrived.current;
  }
  for (const key of keys) {
    if (!known.current.has(key)) {
      known.current.add(key);
      arrived.current.add(key);
    }
  }
  return arrived.current;
}
