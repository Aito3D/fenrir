import { useLayoutEffect, useRef } from 'react';

/**
 * Staggered entrance — the children of `containerRef` cascade in one after
 * another (fade + slight upward slide) on the first render that actually has
 * children, i.e. when the user arrives on the page or refreshes.
 *
 * Uses element.animate() rather than a CSS class so it composes with CSS
 * animations the children already carry (e.g. the camera grid's epoch-synced
 * border blink, whose inline animation-delay would collide with a per-child
 * stagger delay) and with inline transforms (dnd-kit sortables).
 *
 * Runs every render (cheap) but animates only once per appearance of the
 * container: it re-arms when the container unmounts or empties, so content
 * behind a tab or expander cascades again each time it is shown. Disabled
 * under prefers-reduced-motion.
 */
export function useStaggeredEntrance(containerRef: React.RefObject<HTMLElement | null>): void {
  const hasEnteredRef = useRef(false);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || container.children.length === 0) {
      hasEnteredRef.current = false;
      return;
    }
    if (hasEnteredRef.current) return;
    hasEnteredRef.current = true;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let i = 0;
    for (const child of container.children) {
      if (!(child instanceof HTMLElement) || typeof child.animate !== 'function') break;
      child.animate(
        [
          { opacity: 0, transform: 'translateY(12px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        {
          duration: 350,
          // Snappy 45ms cascade, capped at 400ms total so a large fleet's last
          // tile still lands promptly instead of trickling in for >1s.
          delay: Math.min(i * 45, 400),
          // easeOutQuint — matches the app's signature entrance curve.
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          fill: 'backwards',
        },
      );
      i++;
    }
  });
}
