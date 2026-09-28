// Fires `onReach` when a sentinel element scrolls to within 1.5 root heights
// of the visible area, so an infinite list asks for its next page before the
// user reaches the last row rather than when they hit it. A callback ref is
// returned (not a RefObject) so the observer attaches the moment the
// sentinel mounts — it is rendered conditionally below the last row, and a
// RefObject would miss the mount. `enabled` is false while a page is in
// flight; flipping it back on creates a fresh observer, and an observer
// always reports its initial intersection, so a viewport taller than one
// page keeps filling without any extra plumbing.
import { useCallback, useEffect, useRef, useState } from 'react';

export const LOOK_AHEAD_RATIO = 1.5;

export interface InfiniteScrollSentinelOptions {
  rootRef?: React.RefObject<HTMLElement | null>;
  enabled: boolean;
  onReach: () => void;
}

export function useInfiniteScrollSentinel({ rootRef, enabled, onReach }: InfiniteScrollSentinelOptions) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [resizeTick, setResizeTick] = useState(0);
  const onReachRef = useRef(onReach);

  useEffect(() => {
    onReachRef.current = onReach;
  }, [onReach]);

  useEffect(() => {
    const bump = () => setResizeTick((t) => t + 1);
    window.addEventListener('resize', bump);
    return () => window.removeEventListener('resize', bump);
  }, []);

  useEffect(() => {
    if (!node || !enabled || typeof IntersectionObserver === 'undefined') return;
    const root = rootRef?.current ?? null;
    const rootHeight = root ? root.clientHeight : window.innerHeight;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onReachRef.current();
      },
      { root, rootMargin: `0px 0px ${Math.round(rootHeight * LOOK_AHEAD_RATIO)}px 0px` },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, enabled, rootRef, resizeTick]);

  return useCallback((el: HTMLElement | null) => setNode(el), []);
}
