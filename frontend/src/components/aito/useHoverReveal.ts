import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../../utils/motion';
import { hoverRevealDelay, markHoverWarm } from './hoverWarmth';

/** CardView's hover-intent reveal: the dwell timer, its footer pause/resume,
 *  and the grow animation. `disabled` is the drag overlay or a placeholder
 *  (neither may grow under the pointer); `hasTasks` makes the reveal fire
 *  even when the description is not clipped. */
export function useHoverReveal({ disabled, hasTasks }: { disabled: boolean; hasTasks: boolean }) {
  // Hover-intent reveal of a clamped description and of the per-task rows
  // (collapsed, the card shows one summary line for all its tasks — see
  // TaskStepsSummary). ONE dwell per visit: it starts when the pointer enters
  // the card and ends when it leaves the whole card. It used to run per zone
  // (name row, body) and restart at every boundary, so a pointer that drifted
  // from the name to the text never rested a full second inside either — a
  // one-second dwell that took three. The footer is the one exception: its
  // buttons must not move under a pointer that is about to press them, so
  // resting there PAUSES the dwell and moving back up resumes it. How long
  // the dwell is comes from hoverWarmth.ts — a second, or much less right
  // after another card was read. The card floats over its neighbours rather
  // than growing in place: the shell holds the collapsed height so the
  // column never reflows, which is what stops the cards below jumping out
  // from under the pointer that is resting on this one.
  const [expanded, setExpanded] = useState(false);
  const [shellHeight, setShellHeight] = useState<number | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  const timerRef = useRef<number | null>(null);
  // When the running dwell fires, so a pause can compute what is left of it.
  const deadlineRef = useRef<number | null>(null);
  // What a paused dwell still owes; null when nothing is paused.
  const remainingRef = useRef<number | null>(null);
  // `expanded` as a ref, for handlers that must not re-arm the dwell on an
  // already-open card without waiting for a render.
  const expandedRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    deadlineRef.current = null;
  }, []);

  // A card can be unmounted mid-hover by a refetch, a filter or a drag.
  useEffect(() => clearTimer, [clearTimer]);

  const armTimer = useCallback(
    (delay: number) => {
      clearTimer();
      deadlineRef.current = Date.now() + delay;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        deadlineRef.current = null;
        const description = descriptionRef.current;
        const card = cardRef.current;
        if (!description || !card) return;
        // Nothing hidden means nothing to reveal. The +1 absorbs the sub-pixel
        // rounding a fractional line-height leaves behind. Tasks always have
        // something hidden: their names and per-task progress sit behind the
        // summary line until the card grows.
        const clipped = description.scrollHeight > description.clientHeight + 1;
        if (!clipped && !hasTasks) return;
        setShellHeight(card.offsetHeight);
        expandedRef.current = true;
        setExpanded(true);
      }, delay);
    },
    [clearTimer, hasTasks],
  );

  // The pointer arrived on the card (shell mouseenter). Idempotent: a dwell
  // already running or paused is this visit's dwell and keeps its clock —
  // one dwell per visit is the whole rule.
  const startHoverIntent = useCallback(() => {
    // The overlay is a picture of a card mid-drag and a placeholder has no id
    // yet; neither should grow under the pointer.
    if (disabled || expandedRef.current) return;
    if (timerRef.current !== null || remainingRef.current !== null) return;
    armTimer(hoverRevealDelay());
  }, [armTimer, disabled]);

  // The pointer moved onto the footer: hold a PENDING dwell where it is, and
  // leave an open reveal alone. A pointer that crossed the description on its
  // way to a button must not get the reveal a moment later, on the button;
  // one that read the description, got the reveal, and then moved down to
  // the button must keep it (`endHoverIntent`, on the shell, handles the
  // leave).
  const pauseHoverIntent = useCallback(() => {
    if (timerRef.current === null || deadlineRef.current === null) return;
    remainingRef.current = Math.max(0, deadlineRef.current - Date.now());
    clearTimer();
  }, [clearTimer]);

  // The pointer left the footer — back up into the body, or off the card,
  // in which case the shell's own leave runs next and clears this again.
  const resumeHoverIntent = useCallback(() => {
    const remaining = remainingRef.current;
    if (remaining === null || expandedRef.current) return;
    remainingRef.current = null;
    armTimer(remaining);
  }, [armTimer]);

  const endHoverIntent = useCallback(() => {
    clearTimer();
    remainingRef.current = null;
    // Only a reveal that was actually read warms the board; a pointer that
    // merely crossed the card on its way somewhere else was not reading.
    if (expandedRef.current) markHoverWarm();
    expandedRef.current = false;
    setExpanded(false);
    setShellHeight(null);
  }, [clearTimer]);

  // Grow into the reveal instead of jumping to it. The dwell is deliberate
  // — a press cancels it, so by the time this fires the user is holding still
  // and looking straight at the card, which is the worst possible moment to
  // teleport. `shellHeight` is the collapsed
  // height, already measured by the timer above before the state flipped, so
  // both ends of the tween are known and nothing has to be guessed.
  //
  // A layout effect, and WAAPI rather than a CSS transition, for the same two
  // reasons `useFlipReorder` uses them: the animation has to be in flight
  // before the browser paints the expanded height, and inline styles would
  // fight the card's own Tailwind transition on transform/box-shadow — which
  // is what carries the lift and the shadow at the same time.
  //
  // Only the opening is animated. On leave the pointer has already moved on,
  // and a card still shrinking under the NEXT card's hover is worse than one
  // that is simply gone.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!expanded || !card || shellHeight === null) return;
    if (typeof card.animate !== 'function' || prefersReducedMotion()) return;
    const target = card.offsetHeight;
    // Nothing to travel: the reveal only fires when the description is
    // clipped, but a one-word overflow can round to the same height.
    if (target <= shellHeight) return;
    card.animate([{ height: `${shellHeight}px` }, { height: `${target}px` }], {
      // Fast for an entrance (the 250ms budget is for things arriving from
      // off-screen); this box is already there and is only changing size, and
      // the text inside it is being read, so it must settle promptly.
      duration: 200,
      // easeOutQuint — var(--ease-signature) in index.css.
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    });
  }, [expanded, shellHeight]);

  return { expanded, shellHeight, cardRef, descriptionRef, startHoverIntent, pauseHoverIntent, resumeHoverIntent, endHoverIntent };
}
