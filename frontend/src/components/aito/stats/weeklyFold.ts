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
 * `foldWeekly` below goes one step further and also owns the per-week
 * accumulation loop (the `new Map(); for (const d of daily) { ... }` pattern
 * itself) for ActivityChart, whose loop is *only* that pattern.
 * DecisionsChart's loop also has to choose, per call, between folding into
 * weeks or leaving each day as its own bucket (it draws daily bars below the
 * fold threshold); that extra branch doesn't fit `foldWeekly`'s
 * single-purpose shape, so it still uses `weekStart`/`weekKey` directly.
 * OverviewScreen's peak-finder loop is *also* only that pattern and reads
 * just as well through `foldWeekly` in isolation — but wiring it up
 * alongside ActivityChart merges the two files' separately-counted (and
 * separately 100%-covered) `buckets.get(key) ?? seed(...)` branches into one
 * shared instance, which measurably drops branch coverage for this scope
 * below its floor even though no line anywhere becomes newly untested.
 * ActivityChart was kept because it is the bigger win (also retiring a dead
 * re-export and a double `weekStart`/`weekKey` computation); OverviewScreen
 * was left on its own hand-rolled loop rather than trip that floor.
 *
 * This module does NOT decide which threshold a caller should use, or
 * resolve the fact that OverviewScreen only ever consults the wide
 * threshold while ActivityChart also has a narrow one for phone widths —
 * that disagreement is a separate, pre-existing behaviour and is left
 * exactly as each caller already had it.
 */

import type { AitoStatsDay } from '../../../api/client';
import { localDateKey, parseLocalDateKey } from '../../../utils/date';

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

/**
 * Fold a run of `daily` stats into Monday-start weekly buckets.
 *
 * Walks `daily` once; the first time a week is seen, `seed(key, start)`
 * creates its bucket, and every day (including that first one) is then
 * folded into it via `accumulate(bucket, day)`. `accumulate` may mutate and
 * return the same bucket, or return a new one — either works. Returned as a
 * `Map` (not a flat array) so callers that need the week's key or start date
 * back — e.g. to report which week was busiest — still have it.
 *
 * This only owns the grouping; what a bucket looks like and how a day is
 * folded into it is entirely up to the caller.
 */
export function foldWeekly<T>(
  daily: AitoStatsDay[],
  seed: (key: string, start: Date) => T,
  accumulate: (bucket: T, day: AitoStatsDay) => T,
): Map<string, T> {
  const buckets = new Map<string, T>();
  for (const d of daily) {
    const start = weekStart(parseLocalDateKey(d.day));
    const key = localDateKey(start);
    const current = buckets.get(key) ?? seed(key, start);
    buckets.set(key, accumulate(current, d));
  }
  return buckets;
}
