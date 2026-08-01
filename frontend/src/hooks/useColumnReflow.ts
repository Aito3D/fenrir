import { useLayoutEffect, useRef } from 'react';

/**
 * Slide a vertical list's surviving rows when the list around them changes —
 * a card filtered out by the board search, a card that just left for Done,
 * a card the server deleted. Without it the rows below the gap teleport
 * upwards, which reads as the list being redrawn rather than as one card
 * leaving.
 *
 * Deliberately narrower than `useFlipReorder`, which is the same technique for
 * the camera wall, and the differences are the whole reason this exists:
 *
 * - **Y only.** The board's columns are one-dimensional; a card never changes
 *   width and never moves sideways within its column.
 * - **No arrivals.** A child with no previous position is left alone. The
 *   board already owns entrances: `useBoardDrag`'s `shouldAnimateIn` decides
 *   which cards get `.animate-rise`, and it deliberately withholds it from a
 *   card that is merely relocating (a cross-column drag remounts the card
 *   under a new parent). Animating unknown children here would both double up
 *   on a genuine arrival and reintroduce the entrance on a relocation.
 * - **Freezable.** Pass `null` as the key to suspend it. The board does that
 *   for the duration of a drag, where dnd-kit is already transforming these
 *   very elements — two systems animating one node fight visibly. Positions
 *   keep being measured while suspended, so when it resumes there is no stale
 *   delta to replay.
 *
 * Children are identified by `data-flip-key`, the same attribute
 * `useFlipReorder` uses, so the two are at least consistent about markup.
 *
 * `offsetTop`, not `getBoundingClientRect().top`: offset* is pure layout,
 * unaffected by the column's own scroll position or by a transform from an
 * animation still in flight — both of which are live here.
 */
export function useColumnReflow(
  containerRef: React.RefObject<HTMLElement | null>,
  /** Identity of the current order/membership; `null` suspends animation. */
  orderKey: string | null,
): void {
  const positionsRef = useRef(new Map<string, number>());
  const prevOrderKeyRef = useRef(orderKey);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const changed = prevOrderKeyRef.current !== orderKey;
    prevOrderKeyRef.current = orderKey;
    if (!container) return;

    const next = new Map<string, number>();
    for (const child of container.children) {
      const key = child.getAttribute('data-flip-key');
      if (key) next.set(key, (child as HTMLElement).offsetTop);
    }

    const animate =
      changed && orderKey !== null && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (animate) {
      for (const child of container.children) {
        const key = child.getAttribute('data-flip-key');
        if (!key) continue;
        const el = child as HTMLElement;
        if (typeof el.animate !== 'function') break;
        const prev = positionsRef.current.get(key);
        const to = next.get(key);
        if (prev === undefined || to === undefined) continue; // arrival — not ours
        const dy = prev - to;
        if (dy === 0) continue;

        // Typing in the search box changes the list on every keystroke, so a
        // reflow landing on a card that is still mid-slide is the normal case,
        // not an edge one. Read where the card visually IS before cancelling
        // anything — cancel() removes the effect immediately and would change
        // what getComputedStyle reports — then start the new tween from there
        // so it continues instead of snapping back to its layout position.
        let liveY = 0;
        const running = el.getAnimations();
        if (running.length > 0) {
          const transform = getComputedStyle(el).transform;
          if (transform && transform !== 'none') liveY = new DOMMatrixReadOnly(transform).m42;
          for (const animation of running) animation.cancel();
        }

        el.animate([{ transform: `translateY(${dy + liveY}px)` }, { transform: 'translateY(0)' }], {
          // Matches SORTABLE_TRANSITION in AitoPage, so a card closing a gap
          // moves at the same speed whether a drag or a filter opened it.
          duration: 250,
          // easeOutQuint — var(--ease-signature) in index.css.
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        });
      }
    }

    positionsRef.current = next;
  });
}
