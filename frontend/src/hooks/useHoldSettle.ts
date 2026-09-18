import { useCallback, useEffect, useState } from 'react';
import { useReducedMotion } from './useReducedMotion';

/** How long a just-held control keeps its pre-hold rendering after its hold
 *  fires — HoldButton's own `completed` window, during which its 650ms bounce
 *  and its bar's 500ms fade play. Both start on the same tick as `onHold`,
 *  and every hold on the board and panel is optimistic: the cache flips on
 *  that tick, and a caller that renders straight from it unmounts the button
 *  before the choreography has drawn a frame. */
export const HOLD_SETTLE_MS = 700;
/** Then the outgoing control leaves on the exit curve rather than vanishing:
 *  `.animate-fade-out-sm`, whose duration this must match. */
export const HOLD_LEAVE_MS = 150;

export type HoldSettleStage = 'settling' | 'leaving';

/** The two-beat settle a caller runs after a hold-to-confirm fires, so it can
 *  keep drawing the pressed control through HoldButton's completion
 *  choreography and then fade it out, instead of re-rendering for the new
 *  state on the same tick and cutting the gesture's payoff at zero.
 *
 *  Returns the current stage (null when nothing is settling) and `start`,
 *  called beside — never instead of — the mutation. The MUTATION is never
 *  delayed; only what the caller draws is. Under reduced motion the bounce
 *  is already `none`, so `start` is a no-op and the caller re-renders on the
 *  tick, exactly as it did before. */
export function useHoldSettle(): [HoldSettleStage | null, () => void] {
  const reducedMotion = useReducedMotion();
  const [stage, setStage] = useState<HoldSettleStage | null>(null);

  useEffect(() => {
    if (!stage) return;
    const id = window.setTimeout(
      () => setStage((current) => (current === 'settling' ? 'leaving' : null)),
      stage === 'settling' ? HOLD_SETTLE_MS : HOLD_LEAVE_MS,
    );
    return () => window.clearTimeout(id);
  }, [stage]);

  const start = useCallback(() => {
    if (!reducedMotion) setStage('settling');
  }, [reducedMotion]);

  return [stage, start];
}
