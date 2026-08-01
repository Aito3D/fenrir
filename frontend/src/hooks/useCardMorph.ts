import { useCallback } from 'react';
import { flushSync } from 'react-dom';
import { prefersReducedMotion } from '../utils/motion';

/** Shared between the card and the detail panel so the browser morphs one into
 *  the other. Exactly one element may hold it at any moment. */
export const AITO_CARD_VT_NAME = 'aito-card';

/** Written to <html> for the duration so index.css can suppress the page-level
 *  root/page-title animations — otherwise expanding a card would crossfade the
 *  whole board. */
const VT_SCOPE = 'aito-card';

/** The scope for a close with nothing to morph INTO, which needs its own
 *  because CSS cannot ask whether a transition name has a `new` snapshot.
 *
 *  It is not a cosmetic distinction. Measured in Chrome: a group with only an
 *  `old` gets no UA-generated animation at all, so `aito-card`'s deliberately
 *  opaque group (see index.css) simply sits there, at panel size, until the
 *  slowest OTHER animation in the transition ends — a blank slab over the
 *  board long after the panel's content has faded. The exit scope is what
 *  gives the group an animation of its own. */
const VT_EXIT_SCOPE = 'aito-card-exit';

export interface CardMorphCloseOptions {
  /** Hand the shared name back to the board card, so the panel morphs into
   *  it. Pass `false` when something else is about to move that card — a
   *  deferred flight — and let the panel play its own exit instead. */
  toCard?: boolean;
}

function cardNode(id: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-aito-card-id="${id}"]`);
}

/** Choreographs the card ⇄ detail-panel morph. The name is assigned directly on
 *  the DOM node rather than through React state, so no extra render is needed
 *  before the browser captures the old snapshot. */
export function useCardMorph(setExpandedId: (id: number | null) => void) {
  const open = useCallback(
    (id: number) => {
      const node = cardNode(id);
      if (!node || typeof document.startViewTransition !== 'function' || prefersReducedMotion()) {
        setExpandedId(id);
        return;
      }

      // A card scrolled out of its column's overflow viewport would snapshot clipped.
      node.scrollIntoView({ block: 'nearest' });
      node.style.viewTransitionName = AITO_CARD_VT_NAME;
      document.documentElement.dataset.vt = VT_SCOPE;

      const transition = document.startViewTransition(() => {
        flushSync(() => setExpandedId(id));
        // The panel now holds the name; the card must let go before the new
        // snapshot is captured or the name would be claimed twice.
        node.style.viewTransitionName = '';
      });

      Promise.resolve(transition?.finished).finally(() => {
        delete document.documentElement.dataset.vt;
      });
    },
    [setExpandedId],
  );

  /** Closes the panel. By default it morphs back into the board card it grew
   *  out of; with `toCard: false` it plays an exit and leaves the card alone.
   *
   *  That option exists because the morph and a card flight are both motion
   *  toward the same point, and the morph wins by arriving first. When a
   *  relocation is waiting to fly (Accept, Decline — they live only in the
   *  panel), the card under the morph's destination is already covered by a
   *  ghost and held at `opacity: 0`, so handing it the shared name morphs the
   *  panel into an invisible element and pre-empts the very flight the user is
   *  meant to see. */
  const close = useCallback(
    (id: number, { toCard = true }: CardMorphCloseOptions = {}) => {
      if (typeof document.startViewTransition !== 'function' || prefersReducedMotion()) {
        setExpandedId(null);
        return;
      }

      document.documentElement.dataset.vt = toCard ? VT_SCOPE : VT_EXIT_SCOPE;
      const transition = document.startViewTransition(() => {
        flushSync(() => setExpandedId(null));
        // Panel is gone; hand the name back so the card is the new snapshot.
        const node = toCard ? cardNode(id) : null;
        if (node) node.style.viewTransitionName = AITO_CARD_VT_NAME;
        // Nobody claimed it — either we were told not to, or the card left
        // while the panel was closing (the delete path mutates the cache in
        // the same tick, and this callback runs a frame later). The pseudo
        // styles are resolved after this callback returns, so switching the
        // scope here still lands, and it is what keeps that slab off the
        // board.
        else document.documentElement.dataset.vt = VT_EXIT_SCOPE;
      });

      Promise.resolve(transition?.finished).finally(() => {
        const node = cardNode(id);
        if (node) node.style.viewTransitionName = '';
        delete document.documentElement.dataset.vt;
      });
    },
    [setExpandedId],
  );

  return { open, close };
}
