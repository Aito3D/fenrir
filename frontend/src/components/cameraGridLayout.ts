import type { ComponentType } from 'react';
import { Grid, Grid2x2, LayoutGrid } from 'lucide-react';

export type GridLayout = 'compact' | 'default' | 'large';

export const GRID_LAYOUT_COLS: Record<GridLayout, string> = {
  compact: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6',
  default: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5',
  large:   'grid-cols-1 sm:grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4',
};

export const GRID_LAYOUT_ICONS: Record<GridLayout, ComponentType<{ className?: string }>> = {
  compact: Grid,
  default: Grid2x2,
  large: LayoutGrid,
};

/** Blink cycle length — must match the grid-border-blink duration in index.css. */
export const GRID_BLINK_PERIOD_MS = 2500;

/**
 * Card highlight class per printer state — the at-a-distance signal on the
 * camera wall. Steady border = all good; blinking border = operator action
 * needed (yellow paused, blue pickup ready, red failed). Green — steady or
 * glowing — always means printing; finished uses blue-400 to match the
 * status legend dots on PrintersPage.
 *
 * Blink branches must not carry `!border-*` classes: the `!important`
 * declaration would beat the CSS border-color animation.
 */
export function gridCardHighlightClass(opts: {
  connected: boolean;
  state: string | null;
  plateCleared: boolean;
  hasQueuedJobs: boolean;
}): string {
  if (!opts.connected) return '!border-transparent';
  if (opts.state === 'RUNNING') {
    return '!border-bambu-green !shadow-[0_0_10px_1px_color-mix(in_srgb,var(--accent)_35%,transparent)]';
  }
  if (opts.state === 'PAUSE') return 'animate-grid-border-blink';
  // Finished: print ready for pickup. `hasQueuedJobs && plateCleared` means the
  // queue flow already confirmed the plate was cleared — nothing left to fetch.
  // (plateCleared alone is unusable here: it defaults to true for non-queue users.)
  if (opts.state === 'FINISH' && !(opts.hasQueuedJobs && opts.plateCleared)) {
    return 'animate-grid-border-blink [--blink-color:rgb(96_165_250)] !shadow-[0_0_12px_2px_rgb(96_165_250/0.3)]';
  }
  if (opts.state === 'FAILED') return 'animate-grid-border-blink [--blink-color:rgb(248_113_113)]';
  return '!border-transparent';
}

/**
 * Inline style syncing a blinking card to a shared epoch clock, so every
 * blinking tile on the wall pulses in phase no matter when it mounted.
 * The negative delay makes phase = (epoch time mod period) — mount time and
 * re-renders cancel out of the equation.
 */
export function gridBlinkSyncStyle(
  highlightClass: string,
  now: number = Date.now(),
): { animationDelay: string } | undefined {
  if (!highlightClass.includes('animate-grid-border-blink')) return undefined;
  return { animationDelay: `-${now % GRID_BLINK_PERIOD_MS}ms` };
}
