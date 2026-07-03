import { useLayoutEffect, useRef } from 'react';

/**
 * FLIP animation for grid reorders — when the order of a container's children
 * changes, each child slides from its old position to its new one instead of
 * teleporting.
 *
 * Children are identified by a `data-flip-key` attribute.
 *
 * Positions are measured with offsetLeft/offsetTop, NOT getBoundingClientRect:
 * offset* reports pure layout position, unaffected by scroll or by transforms
 * from an animation still in flight. (Rect-based measurement corrupted the
 * snapshot when a render landed mid-animation, which made reorders animate in
 * one direction but not back.)
 *
 * Animation uses element.animate() so no inline styles are touched — a
 * transition set inline would override the cards' Tailwind transitions
 * (border glow) until removed.
 *
 * Measurement runs every render (cheap for a few dozen elements); animation
 * only runs when `orderKey` actually changes. Disabled entirely under
 * `prefers-reduced-motion`.
 */
export function useFlipReorder(containerRef: React.RefObject<HTMLElement | null>, orderKey: string): void {
  const positionsRef = useRef(new Map<string, { left: number; top: number }>());
  const prevOrderKeyRef = useRef(orderKey);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const orderChanged = prevOrderKeyRef.current !== orderKey;
    prevOrderKeyRef.current = orderKey;
    if (!container) return;

    const newPositions = new Map<string, { left: number; top: number }>();
    for (const child of container.children) {
      const key = child.getAttribute('data-flip-key');
      if (!key) continue;
      const el = child as HTMLElement;
      newPositions.set(key, { left: el.offsetLeft, top: el.offsetTop });
    }

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (orderChanged && !reduceMotion) {
      for (const child of container.children) {
        const key = child.getAttribute('data-flip-key');
        if (!key) continue;
        const el = child as HTMLElement;
        if (typeof el.animate !== 'function') break;
        const prev = positionsRef.current.get(key);
        const next = newPositions.get(key);
        if (!prev || !next) continue;
        const dx = prev.left - next.left;
        const dy = prev.top - next.top;
        if (dx === 0 && dy === 0) continue;
        el.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
          { duration: 300, easing: 'ease' },
        );
      }
    }

    positionsRef.current = newPositions;
  });
}
