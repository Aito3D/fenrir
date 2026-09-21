/**
 * Shared Monday-start "week folding" for the statistics charts.
 *
 * ActivityChart, DecisionsChart and OverviewScreen's peak-finder each fold a
 * run of daily stats into Monday-start weeks once there are too many days to
 * draw individually. All three used to carry their own copy of the exact
 * same bucket-key expression, and the two thresholds below had already
 * started to drift (DecisionsChart re-declared its own copies instead of
 * importing them). Centralising the bucket key and the constants here stops
 * the *folding math* from drifting further.
 *
 * This module does NOT decide which threshold a caller should use, or
 * resolve the fact that OverviewScreen only ever consults the wide
 * threshold while ActivityChart also has a narrow one for phone widths —
 * that disagreement is a separate, pre-existing behaviour and is left
 * exactly as each caller already had it.
 */

import { localDateKey } from '../../../utils/date';

/** Past this many days (in the default, non-narrow layout) daily bars turn
 *  to hairlines, so charts fold days into Monday-start weeks instead. */
export const WEEKLY_ABOVE_DAYS = 45;

/** Same idea, but for narrow (phone-width) layouts, which run out of pixels
 *  sooner and so fold to weeks at a shorter range. */
export const WEEKLY_ABOVE_DAYS_NARROW = 31;

/**
 * The Monday that starts the week containing `date`.
 *
 * `getDay()` is 0-indexed from Sunday, so `(getDay() + 6) % 7` maps
 * Monday->0, Tuesday->1, ..., Sunday->6 — i.e. how many days to step back to
 * reach that week's Monday. A Sunday therefore folds back to the *previous*
 * Monday, not forward.
 */
export function weekStart(date: Date): Date {
  const start = new Date(date);
  start.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return start;
}

/** The Monday-start bucket key (as used for `Map` keys) for the week
 *  containing `date`. */
export function weekKey(date: Date): string {
  return localDateKey(weekStart(date));
}
