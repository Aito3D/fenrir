import { useLayoutEffect, useRef } from 'react';

/**
 * FLIP animation for grid reorders — when the order of a container's children
 * changes, each child slides from its old position to its new one instead of
 * teleporting. A child that also *resizes* (a tile spanning to 2×2 for the
 * spotlight / a paused print) grows into place via a combined translate+scale
 * so it doesn't hard-jump to its new size while neighbors slide. A child that
 * appears on an already-populated container (e.g. a printer reconnecting
 * mid-session) has no prior slot to slide from, so it fades + rises in instead
 * of popping in fully-formed beside settled neighbors. First-time population is
 * left to useStaggeredEntrance.
 *
 * Children are identified by a `data-flip-key` attribute.
 *
 * Positions AND sizes are measured with offset* (offsetLeft/Top/Width/Height),
 * NOT getBoundingClientRect: offset* reports pure layout geometry, unaffected
 * by scroll or by transforms from an animation still in flight. (Rect-based
 * measurement corrupted the snapshot when a render landed mid-animation, which
 * made reorders animate in one direction but not back.)
 *
 * Animation uses element.animate() so no inline styles are touched — a
 * transition set inline would override the cards' Tailwind transitions
 * (border glow) until removed.
 *
 * Measurement runs every render (cheap for a few dozen elements); animation
 * only runs when `orderKey` actually changes. Disabled entirely under
 * `prefers-reduced-motion`.
 */
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function useFlipReorder(containerRef: React.RefObject<HTMLElement | null>, orderKey: string): void {
  const positionsRef = useRef(new Map<string, Rect>());
  const prevOrderKeyRef = useRef(orderKey);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const orderChanged = prevOrderKeyRef.current !== orderKey;
    prevOrderKeyRef.current = orderKey;
    if (!container) return;

    const newPositions = new Map<string, Rect>();
    for (const child of container.children) {
      const key = child.getAttribute('data-flip-key');
      if (!key) continue;
      const el = child as HTMLElement;
      newPositions.set(key, { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight });
    }

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Only treat missing prior positions as "new arrivals" once the wall has
    // been populated — the very first paint (empty → full) is owned by
    // useStaggeredEntrance, and animating both would double up.
    const wallPopulated = positionsRef.current.size > 0;
    if (orderChanged && !reduceMotion) {
      for (const child of container.children) {
        const key = child.getAttribute('data-flip-key');
        if (!key) continue;
        const el = child as HTMLElement;
        if (typeof el.animate !== 'function') break;
        const prev = positionsRef.current.get(key);
        const next = newPositions.get(key);
        if (!next) continue;
        if (!prev) {
          // New tile joined an already-populated wall — fade + rise it in, the
          // same entrance the first-load stagger uses (no stagger delay: it's
          // a lone arrival, not a cascade).
          if (wallPopulated) {
            el.animate(
              [
                { opacity: 0, transform: 'translateY(12px)' },
                { opacity: 1, transform: 'translateY(0)' },
              ],
              // keep in sync with --ease-signature in index.css
              { duration: 300, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'backwards' },
            );
          }
          continue;
        }
        const dx = prev.left - next.left;
        const dy = prev.top - next.top;
        // Scale factors for a tile that changed size (spotlight / paused tile
        // spanning to 2×2). 1 when unchanged. Guard against a zero next size.
        const sx = next.width > 0 ? prev.width / next.width : 1;
        const sy = next.height > 0 ? prev.height / next.height : 1;
        const moved = dx !== 0 || dy !== 0;
        const resized = Math.abs(sx - 1) > 0.01 || Math.abs(sy - 1) > 0.01;
        if (!moved && !resized) continue;
        // easeOutQuint — the app's signature curve (calc-rise, modal-in,
        // sidebar-in); a confident settle that matches the rest of the UI
        // instead of the flat built-in `ease`.
        // keep in sync with --ease-signature in index.css
        const easing = 'cubic-bezier(0.22, 1, 0.36, 1)';
        if (!resized) {
          // Pure reorder slide — default transform-origin is fine for translate.
          el.animate(
            [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
            { duration: 320, easing },
          );
        } else {
          // Grow/shrink in place: invert the size change to scale, anchored at
          // the top-left corner so the scale composes correctly with the
          // offset-based translate, then animate back to the natural size. The
          // tile (and its live video) zooms to its new span instead of snapping.
          el.animate(
            [
              { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
              { transformOrigin: '0 0', transform: 'translate(0, 0) scale(1, 1)' },
            ],
            { duration: 320, easing },
          );
        }
      }
    }

    positionsRef.current = newPositions;
  });
}
