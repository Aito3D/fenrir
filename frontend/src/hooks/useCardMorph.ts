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

  const close = useCallback(
    (id: number) => {
      if (typeof document.startViewTransition !== 'function' || prefersReducedMotion()) {
        setExpandedId(null);
        return;
      }

      document.documentElement.dataset.vt = VT_SCOPE;
      const transition = document.startViewTransition(() => {
        flushSync(() => setExpandedId(null));
        // Panel is gone; hand the name back so the card is the new snapshot.
        const node = cardNode(id);
        if (node) node.style.viewTransitionName = AITO_CARD_VT_NAME;
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
