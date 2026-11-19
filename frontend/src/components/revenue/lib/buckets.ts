import { DAY_MS, addDays, dayToUtc, daysInMonth, isValidDay, isoWeek, isoWeek1Monday, utcToDay } from "./dates";
import type { RangePresetId, RevenueBucket, RevenueGranularity } from "./types";

export const RANGE_PRESETS: { id: RangePresetId; label: string }[] = [
  { id: "this-year", label: "Cette année" },
  { id: "last-12-months", label: "12 derniers mois" },
  { id: "all", label: "Depuis 2024" },
];

const pad2 = (n: number) => String(n).padStart(2, "0");

export function bucketKeyFor(day: string, g: RevenueGranularity): string {
  switch (g) {
    case "day":
      return day;
    case "week": {
      const { year, week } = isoWeek(day);
      return `${year}-W${pad2(week)}`;
    }
    case "month":
      return day.slice(0, 7);
    case "year":
      return day.slice(0, 4);
  }
}

function parseWeekKey(key: string): { year: number; week: number } {
  const [y, w] = key.split("-W");
  return { year: Number(y), week: Number(w) };
}

function isoWeeksInYear(year: number): number {
  // A year has 53 ISO weeks when 28 December falls in week 53.
  return isoWeek(`${year}-12-28`).week;
}

export function bucketRange(key: string, g: RevenueGranularity): { start: string; end: string } {
  switch (g) {
    case "day":
      return { start: key, end: key };
    case "week": {
      const { year, week } = parseWeekKey(key);
      const start = isoWeek1Monday(year) + (week - 1) * 7 * DAY_MS;
      return { start: utcToDay(start), end: utcToDay(start + 6 * DAY_MS) };
    }
    case "month": {
      const [y, m] = key.split("-").map(Number);
      return { start: `${key}-01`, end: `${key}-${pad2(daysInMonth(y, m))}` };
    }
    case "year":
      return { start: `${key}-01-01`, end: `${key}-12-31` };
  }
}

const FR_DAY = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const FR_DAY_MONTH = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
const FR_MONTH = new Intl.DateTimeFormat("fr-FR", { month: "short", year: "numeric", timeZone: "UTC" });

export function bucketLabel(key: string, g: RevenueGranularity): string {
  const { start, end } = bucketRange(key, g);
  switch (g) {
    case "day":
      return FR_DAY.format(new Date(dayToUtc(key)));
    case "week": {
      const { week } = parseWeekKey(key);
      const s = new Date(dayToUtc(start));
      const e = new Date(dayToUtc(end));
      const sameMonth = start.slice(0, 7) === end.slice(0, 7);
      const left = sameMonth ? String(s.getUTCDate()) : start.slice(0, 4) === end.slice(0, 4) ? FR_DAY_MONTH.format(s) : FR_DAY.format(s);
      return `S${pad2(week)} · ${left}–${FR_DAY.format(e)}`;
    }
    case "month":
      return FR_MONTH.format(new Date(dayToUtc(start)));
    case "year":
      return key;
  }
}

/** The same bucket `delta` years away, or null when it does not exist (ISO week 53). */
export function shiftBucketYear(key: string, g: RevenueGranularity, delta: number): string | null {
  switch (g) {
    case "day": {
      const [y, m, d] = key.split("-").map(Number);
      const year = y + delta;
      return `${year}-${pad2(m)}-${pad2(Math.min(d, daysInMonth(year, m)))}`;
    }
    case "week": {
      const { year, week } = parseWeekKey(key);
      const target = year + delta;
      return week > isoWeeksInYear(target) ? null : `${target}-W${pad2(week)}`;
    }
    case "month": {
      const [y, m] = key.split("-");
      return `${Number(y) + delta}-${m}`;
    }
    case "year":
      return String(Number(key) + delta);
  }
}

/** Whether `key` is a bucket key of granularity `g` (`2026-10-15` / `2026-W42` / `2026-10` / `2026`). */
export function isBucketKey(key: string, g: RevenueGranularity): boolean {
  switch (g) {
    case "day":
      return isValidDay(key);
    case "week":
      return /^\d{4}-W\d{2}$/.test(key);
    case "month":
      return /^\d{4}-\d{2}$/.test(key);
    case "year":
      return /^\d{4}$/.test(key);
  }
}

/** « 1–15 sept. » (previous bucket) or « 1–15 sept. 2025 » (year ago): the clipped range a partial bucket is compared with. */
export function toDateRangeLabel(b: RevenueBucket, g: RevenueGranularity, against: "previous" | "year-ago"): string | null {
  // `== null` on purpose: a payload without the field reads as "no comparison", never as `NaN` days.
  if (b.elapsedDays == null) return null;
  // A switch in flight can render a bucket under another granularity's control.
  if (!isBucketKey(b.key, g)) return null;
  const key = against === "year-ago" ? shiftBucketYear(b.key, g, -1) : bucketKeyFor(addDays(b.start, -1), g);
  if (!key) return null;
  const r = bucketRange(key, g);
  const endRaw = addDays(r.start, b.elapsedDays - 1);
  const end = endRaw > r.end ? r.end : endRaw;
  const s = new Date(dayToUtc(r.start));
  const e = new Date(dayToUtc(end));
  const fmtEnd = against === "year-ago" ? FR_DAY : FR_DAY_MONTH;
  if (r.start === end) return fmtEnd.format(e);
  const sameMonth = r.start.slice(0, 7) === end.slice(0, 7);
  return `${sameMonth ? s.getUTCDate() : FR_DAY_MONTH.format(s)}–${fmtEnd.format(e)}`;
}
