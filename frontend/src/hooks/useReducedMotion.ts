import { useCallback, useSyncExternalStore } from 'react';
import { prefersReducedMotion } from '../utils/motion';

const QUERY = '(prefers-reduced-motion: reduce)';

/** `prefersReducedMotion()` as reactive state.
 *
 *  The plain util is deliberately uncached so that toggling the OS setting
 *  takes effect without a reload — but a component that reads it once into a
 *  `useMemo` throws that away, because nothing tells React to render again. The
 *  CSS side of the motion system has no such problem: `@media
 *  (prefers-reduced-motion: reduce)` in index.css re-evaluates itself. This is
 *  for the JS-driven animations that CSS cannot reach — dnd-kit's drop flight,
 *  the view-transition card morph — so they honour the setting on the same
 *  keystroke the CSS ones do.
 *
 *  `useSyncExternalStore` rather than `useState` + an effect: the snapshot is
 *  read during render, so the first paint is already correct instead of
 *  animating once and then correcting itself. */
export function useReducedMotion(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
    const mql = window.matchMedia(QUERY);
    // `addListener` is the deprecated form, and it is what Safari before 14
    // has instead of `addEventListener`. Cheap to keep: without it the hook
    // would throw on the browsers most likely to be running an old OS.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    if (typeof mql.addListener === 'function') {
      mql.addListener(onChange);
      return () => mql.removeListener(onChange);
    }
    return () => {};
  }, []);

  // Same value on the server as the client's first paint: no motion is the
  // safe default to render before anything can be measured.
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}
