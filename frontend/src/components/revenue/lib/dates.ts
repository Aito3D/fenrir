export const DAY_MS = 86_400_000;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function dayToUtc(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function utcToDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `yyyy-MM-dd` that round-trips (so `2026-02-30` is refused, not normalised). */
export function isValidDay(s: string): boolean {
  if (!DAY_RE.test(s)) return false;
  const ms = dayToUtc(s);
  return Number.isFinite(ms) && utcToDay(ms) === s;
}

export function addDays(day: string, n: number): string {
  return utcToDay(dayToUtc(day) + n * DAY_MS);
}

/** Inclusive on both ends; empty when `from > to`. */
export function allDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = dayToUtc(from), end = dayToUtc(to); t <= end; t += DAY_MS) out.push(utcToDay(t));
  return out;
}

/** Inclusive day count, equal to `allDays(from, to).length`: 0 when `from > to` or either day is unparseable. */
export function daysBetween(from: string, to: string): number {
  const n = Math.round((dayToUtc(to) - dayToUtc(from)) / DAY_MS) + 1;
  return n > 0 ? n : 0; // NaN > 0 is false, so an invalid day gives 0
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Monday = 0 … Sunday = 6. */
function mondayIndex(ms: number): number {
  return (new Date(ms).getUTCDay() + 6) % 7;
}

/** The Monday starting ISO week 1 of `year` (the week holding 4 January). */
export function isoWeek1Monday(year: number): number {
  const jan4 = Date.UTC(year, 0, 4);
  return jan4 - mondayIndex(jan4) * DAY_MS;
}

/** ISO 8601 week: the year is the one holding the week's Thursday. */
export function isoWeek(day: string): { year: number; week: number } {
  const t = dayToUtc(day);
  const thursday = t + (3 - mondayIndex(t)) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - isoWeek1Monday(year)) / (7 * DAY_MS)) + 1;
  return { year, week };
}
