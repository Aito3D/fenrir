import { dayToUtc } from "./dates";
import type { CalendarDay } from "./types";

export interface CalendarLayout {
  /** Columns of seven cells, Monday first; null pads the first and last week. */
  weeks: (CalendarDay | null)[][];
  /** Mean HT / TTC per weekday (0 = Monday) over the fetched days of the range. */
  weekdayMean: { ht: number; ttc: number }[];
  max: { ht: number; ttc: number };
}

const weekday = (day: string) => (new Date(dayToUtc(day)).getUTCDay() + 6) % 7;

export function calendarLayout(days: CalendarDay[]): CalendarLayout {
  const weeks: (CalendarDay | null)[][] = [];
  let col: (CalendarDay | null)[] = [];
  const sums = Array.from({ length: 7 }, () => ({ ht: 0, ttc: 0, n: 0 }));
  let maxHt = 0;
  let maxTtc = 0;
  for (const d of days) {
    const wd = weekday(d.day);
    if (col.length === 0) for (let i = 0; i < wd; i++) col.push(null);
    col.push(d);
    if (d.fetched) {
      sums[wd].ht += d.ht;
      sums[wd].ttc += d.ttc;
      sums[wd].n += 1;
    }
    maxHt = Math.max(maxHt, d.ht);
    maxTtc = Math.max(maxTtc, d.ttc);
    if (col.length === 7) {
      weeks.push(col);
      col = [];
    }
  }
  if (col.length > 0) {
    while (col.length < 7) col.push(null);
    weeks.push(col);
  }
  return {
    weeks,
    weekdayMean: sums.map((s) => (s.n ? { ht: Math.round(s.ht / s.n), ttc: Math.round(s.ttc / s.n) } : { ht: 0, ttc: 0 })),
    max: { ht: maxHt, ttc: maxTtc },
  };
}
