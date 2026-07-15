/** Period-over-period comparison helpers for the Stats page. */

/** How a metric's growth should be judged when comparing periods. */
export type DeltaSemantics = 'more-is-good' | 'more-is-bad' | 'neutral';

export type DeltaTone = 'good' | 'bad' | 'neutral';

export interface StatDelta {
  /** Signed percentage change vs the previous period. */
  pct: number;
  direction: 'up' | 'down' | 'flat';
  tone: DeltaTone;
}

/**
 * Percentage change between two periods. Returns null when there is no
 * usable baseline (previous missing or zero) — a delta against nothing is
 * noise, not signal. Changes under half a percent render as "flat".
 */
export function computeDelta(
  current: number,
  previous: number | null | undefined,
  semantics: DeltaSemantics,
): StatDelta | null {
  if (previous === null || previous === undefined || previous === 0) return null;
  const pct = ((current - previous) / previous) * 100;
  if (Math.abs(pct) < 0.5) {
    return { pct: 0, direction: 'flat', tone: 'neutral' };
  }
  const direction = pct > 0 ? 'up' : 'down';
  const tone: DeltaTone =
    semantics === 'neutral' ? 'neutral'
    : semantics === 'more-is-good'
      ? (pct > 0 ? 'good' : 'bad')
      : (pct > 0 ? 'bad' : 'good');
  return { pct, direction, tone };
}
