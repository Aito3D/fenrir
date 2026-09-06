import type { AitoProject } from '../api/client';

/** Print minutes still owed on accepted, live cards — the board header's
 *  backlog figure. Quotes still out are not commitments; Done is history. */
export function printBacklog(projects: AitoProject[]): number {
  return projects.reduce(
    (sum, p) =>
      p.status === 'active' && p.quote_status === 'accepted' && p.column !== 'done'
        ? sum + (p.print_minutes_pending ?? 0)
        : sum,
    0,
  );
}

const DEFAULT_DAILY_HOURS = 8;

/** Printer-hours per day the shop can burn: configured printers (at least
 *  one, so a shop with none still gets a number) × the calculator profiles'
 *  mean daily-usage hours (8 when there are no profiles). */
export function dailyCapacityHours(printerCount: number, dailyHours: number[]): number {
  const valid = dailyHours.filter((h) => Number.isFinite(h) && h > 0);
  const mean = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : DEFAULT_DAILY_HOURS;
  return Math.max(1, printerCount) * mean;
}

/** One decimal under ten hours (2.5), whole hours above (38), plain '0' at
 *  zero — `(0).toFixed(1)` would otherwise read '0.0'. */
export function formatBacklogHours(minutes: number): string {
  if (minutes <= 0) return '0';
  const hours = minutes / 60;
  return hours < 10 ? hours.toFixed(1) : String(Math.round(hours));
}
