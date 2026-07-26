/** Runtime counterpart to the `prefers-reduced-motion: reduce` media query that
 *  index.css uses to neutralise every CSS animation. Read at call time, not
 *  cached, so toggling the OS setting takes effect without a reload. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
