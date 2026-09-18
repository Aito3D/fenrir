import { useCallback, useEffect, useRef, useState } from 'react';

export type TrackingPanelId = 'pay' | 'shop';

/** Which of the tracking page's two side panels is open — at most one — and
 *  where keyboard focus goes as they come and go: to the opening panel's
 *  title, and back to the button that opened it when it closes. Focus is
 *  handled here, in one effect, rather than in each panel: when one panel
 *  replaces the other, two independent effects would race for it. */
export function useTrackingPanel() {
  const [open, setOpen] = useState<TrackingPanelId | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const titles = useRef<Partial<Record<TrackingPanelId, HTMLElement | null>>>({});
  const pending = useRef<'panel' | 'trigger' | null>(null);

  const show = useCallback((id: TrackingPanelId, from?: HTMLElement | null) => {
    // A hand-off from inside another panel (the payment panel's shop tab):
    // that button will be inert once its panel closes, so focus returns to
    // this panel's own trigger on the card instead — the button that
    // declares it controls the panel.
    if (from) trigger.current = from.closest('[role="dialog"]') ? document.querySelector<HTMLElement>(`[aria-controls="track-panel-${id}"]:not([role="dialog"] *)`) : from;
    pending.current = 'panel';
    setOpen((current) => {
      // Already open: nothing re-renders, so settle the focus here.
      if (current === id) {
        pending.current = null;
        titles.current[id]?.focus({ preventScroll: true });
      }
      return id;
    });
  }, []);

  const close = useCallback(() => {
    pending.current = 'trigger';
    setOpen(null);
  }, []);

  const toggle = useCallback(
    (id: TrackingPanelId, from?: HTMLElement | null) => {
      if (open === id) close();
      else show(id, from);
    },
    [open, show, close],
  );

  useEffect(() => {
    const what = pending.current;
    pending.current = null;
    if (what === 'panel' && open) titles.current[open]?.focus({ preventScroll: true });
    else if (what === 'trigger' && open === null) trigger.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  /** A ref callback for panel `id`'s title, the element focus lands on. */
  const titleRef = useCallback(
    (id: TrackingPanelId) => (el: HTMLElement | null) => {
      titles.current[id] = el;
    },
    [],
  );

  return { open, show, close, toggle, titleRef };
}
