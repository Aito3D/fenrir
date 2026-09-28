// Fires `onReach` when a sentinel element scrolls to within 1.5 root heights
// of the visible area, so an infinite list asks for its next page before the
// user reaches the last row rather than when they hit it. A callback ref is
// returned (not a RefObject) so the observer attaches the moment the
// sentinel mounts — it is rendered conditionally below the last row, and a
// RefObject would miss the mount. `enabled` is false while a page is in
// flight; flipping it back on creates a fresh observer, and an observer
// always reports its initial intersection, so a viewport taller than one
// page keeps filling without any extra plumbing.
//
// The observer root is resolved from the DOM each time an observer is
// created: the nearest ancestor that is scroll-styled AND actually clips its
// content. A pane that is `overflow-y: auto` only at wide breakpoints grows
// with its rows on narrow screens, and an `overflow-auto` shell that grows
// taller than the window never scrolls itself; treating either as the root
// would leave the sentinel permanently "intersecting" and load every page
// without a scroll. When no ancestor clips, the document scrolls and the
// viewport (`null`) is the root.
import { useCallback, useEffect, useRef, useState } from 'react';

export const LOOK_AHEAD_RATIO = 1.5;

export interface InfiniteScrollSentinelOptions {
  enabled: boolean;
  onReach: () => void;
}

function findScrollRoot(node: HTMLElement): HTMLElement | null {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const { overflowY } = window.getComputedStyle(el);
    if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el;
  }
  return null;
}

export function useInfiniteScrollSentinel({ enabled, onReach }: InfiniteScrollSentinelOptions) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [resizeTick, setResizeTick] = useState(0);
  const onReachRef = useRef(onReach);

  useEffect(() => {
    onReachRef.current = onReach;
  }, [onReach]);

  // A resize can cross the breakpoint that decides which element scrolls, so
  // it re-resolves the root. Throttled to one re-observe per frame, and only
  // listened for while an observer can exist.
  useEffect(() => {
    if (!enabled) return;
    let frame: number | null = null;
    const onResize = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        setResizeTick((t) => t + 1);
      });
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [enabled]);

  useEffect(() => {
    if (!node || !enabled || typeof IntersectionObserver === 'undefined') return;
    const root = findScrollRoot(node);
    const rootHeight = root ? root.clientHeight : window.innerHeight;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onReachRef.current();
      },
      { root, rootMargin: `0px 0px ${Math.round(rootHeight * LOOK_AHEAD_RATIO)}px 0px` },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, enabled, resizeTick]);

  return useCallback((el: HTMLElement | null) => setNode(el), []);
}
