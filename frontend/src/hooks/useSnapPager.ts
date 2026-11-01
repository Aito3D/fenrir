import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { prefersReducedMotion } from '../utils/motion';

/** Quiet time after the last scroll event before the pager is checked for
 *  resting between two pages. Scroll events arrive every frame while anything
 *  moves, so this only fires once the scroll has truly stopped. */
const SETTLE_DELAY_MS = 150;

export interface SnapPagerHandlers {
  onScroll: () => void;
  onPointerDown: () => void;
  onTouchStart: () => void;
  onTouchEnd: () => void;
  onTouchCancel: () => void;
}

/** A horizontal scroll-snap pager of `count` full-width pages whose resting
 *  page is `current`: lands on it before first paint, follows a swipe, jumps
 *  on request, re-aligns after a width change, and settles itself when a
 *  swipe is released between two pages (the Aito phone board's mechanics).
 *
 *  Spread `handlers` on the scrolling element and give it `pagerRef`. */
export function useSnapPager(
  count: number,
  current: number,
  setCurrent: (index: number) => void,
): { pagerRef: RefObject<HTMLDivElement | null>; jump: (index: number, smooth: boolean) => void; handlers: SnapPagerHandlers } {
  const pagerRef = useRef<HTMLDivElement>(null);

  // The width the pager was last laid out for: a resize only re-aligns when
  // this changes. On a phone, `resize` also fires for height-only changes
  // (the browser toolbar collapsing, the keyboard), and re-aligning then
  // would yank a swipe in progress to the stale `current`.
  const alignedWidthRef = useRef(0);

  const scrollToPage = useCallback((index: number, smooth: boolean) => {
    const pager = pagerRef.current;
    if (!pager) return;
    alignedWidthRef.current = pager.clientWidth;
    const left = index * pager.clientWidth;
    if (smooth && !prefersReducedMotion() && typeof pager.scrollTo === 'function') {
      pager.scrollTo({ left, behavior: 'smooth' });
    } else {
      pager.scrollLeft = left;
    }
  }, []);

  // Land on the remembered page before the first paint.
  useLayoutEffect(() => {
    scrollToPage(current, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only: afterwards the scroll position IS the source of truth
  }, []);

  // scrollLeft is in px: after a rotation or resize, put the current page
  // back in view instead of landing between two.
  const currentRef = useRef(current);
  useEffect(() => {
    currentRef.current = current;
  }, [current]);
  useEffect(() => {
    const onResize = () => {
      const pager = pagerRef.current;
      if (!pager || pager.clientWidth === alignedWidthRef.current) return;
      scrollToPage(currentRef.current, false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [scrollToPage]);

  // A smooth jump scrolls THROUGH every page in between; without this the
  // header would flick through each of their names on the way. Cleared on
  // arrival, or the moment a finger takes over the scroll.
  //
  // Snapping is switched off for the ride: WebKit stops a smooth programmatic
  // scroll at the first snap point it meets (bugs.webkit.org 228686).
  const jumpTargetRef = useRef<number | null>(null);

  const endJump = useCallback(() => {
    jumpTargetRef.current = null;
    const pager = pagerRef.current;
    if (pager) pager.style.scrollSnapType = '';
  }, []);

  // Native snapping is not trusted to finish the job: on a real phone WebKit
  // can leave the pager resting between two pages (the pages are vertical
  // scrollers themselves, which defeats the parent's snap on some builds).
  // Once the scroll has gone quiet and no finger is down, the pager snaps
  // itself to the nearest page and adopts it. Idempotent: an aligned pager
  // is left alone, so the scroll this triggers does not re-trigger it.
  const fingerDownRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const settle = useCallback(() => {
    settleTimerRef.current = null;
    const pager = pagerRef.current;
    if (!pager || pager.clientWidth === 0 || fingerDownRef.current) return;
    const index = Math.min(Math.max(Math.round(pager.scrollLeft / pager.clientWidth), 0), count - 1);
    if (jumpTargetRef.current !== null) endJump();
    if (index !== currentRef.current) setCurrent(index);
    if (Math.abs(pager.scrollLeft - index * pager.clientWidth) > 1) scrollToPage(index, true);
  }, [count, endJump, scrollToPage, setCurrent]);

  const scheduleSettle = useCallback(() => {
    if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(settle, SETTLE_DELAY_MS);
  }, [settle]);

  useEffect(
    () => () => {
      if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
    },
    [],
  );

  const onScroll = useCallback(() => {
    const pager = pagerRef.current;
    if (!pager || pager.clientWidth === 0) return;
    scheduleSettle();
    const index = Math.round(pager.scrollLeft / pager.clientWidth);
    if (jumpTargetRef.current !== null) {
      if (index === jumpTargetRef.current) endJump();
      return;
    }
    if (index !== currentRef.current) setCurrent(index);
  }, [endJump, scheduleSettle, setCurrent]);

  const jump = useCallback(
    (index: number, smooth: boolean) => {
      const pager = pagerRef.current;
      if (smooth && pager) {
        jumpTargetRef.current = index;
        pager.style.scrollSnapType = 'none';
      } else {
        endJump();
      }
      setCurrent(index);
      scrollToPage(index, smooth);
    },
    [endJump, scrollToPage, setCurrent],
  );

  const onTouchStart = useCallback(() => {
    fingerDownRef.current = true;
    endJump();
  }, [endJump]);
  const onTouchEnd = useCallback(() => {
    fingerDownRef.current = false;
    scheduleSettle();
  }, [scheduleSettle]);

  return {
    pagerRef,
    jump,
    handlers: { onScroll, onPointerDown: endJump, onTouchStart, onTouchEnd, onTouchCancel: onTouchEnd },
  };
}
