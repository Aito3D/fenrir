import { addDays, daysInMonth } from "./dates";
import { bucketKeyFor, bucketRange } from "./buckets";
import type { CalendarDay, RevenueBucket, RevenueGranularity, TaxMode } from "./types";

/** The bucket `delta` periods away (negative = earlier). */
export function shiftBucketKey(key: string, g: RevenueGranularity, delta: number): string {
  let k = key;
  for (let i = 0; i < Math.abs(delta); i++) {
    const r = bucketRange(k, g);
    k = bucketKeyFor(delta < 0 ? addDays(r.start, -1) : addDays(r.end, 1), g);
  }
  return k;
}

/** The window moved by `delta` whole buckets, clamped to the history and today; null when the last bucket would start after today or end before the history. */
export function shiftWindow(from: string, to: string, g: RevenueGranularity, delta: number, historyStart: string, today: string): { from: string; to: string } | null {
  const last = bucketRange(shiftBucketKey(bucketKeyFor(to, g), g, delta), g);
  if (last.start > today || last.end < historyStart) return null;
  const first = bucketRange(shiftBucketKey(bucketKeyFor(from, g), g, delta), g).start;
  return { from: first < historyStart ? historyStart : first, to: last.end > today ? today : last.end };
}

const FINER: Partial<Record<RevenueGranularity, RevenueGranularity>> = { year: "month", month: "day", week: "day" };

/** A column's own range one level finer (year → months, month / week → days); null on a day. */
export function drillDown(bucket: Pick<RevenueBucket, "start" | "end">, g: RevenueGranularity): { granularity: RevenueGranularity; from: string; to: string } | null {
  const next = FINER[g];
  return next ? { granularity: next, from: bucket.start, to: bucket.end } : null;
}

export interface PaceSeries {
  days: number;
  /** Running totals by day of month (index 0 = the 1st); null from the first day not fetched on. */
  current: (number | null)[];
  previous: (number | null)[];
  /** The target spread evenly over the month; null without a target (or in TTC). */
  target: (number | null)[] | null;
  /** The last day the current month is known for (1-based), 0 when none. */
  asOfDay: number;
  currentToDate: number | null;
  previousToDate: number | null;
  change: number | null;
  previousTotal: number | null;
}

function runningTotal(days: CalendarDay[], n: number, mode: TaxMode): (number | null)[] {
  const byDom = new Map(days.map((d) => [Number(d.day.slice(8)), d]));
  const out: (number | null)[] = [];
  let run = 0;
  let broken = false;
  for (let i = 1; i <= n; i++) {
    const d = byDom.get(i);
    if (broken || !d || !d.fetched) {
      broken = true;
      out.push(null);
      continue;
    }
    run += mode === "ttc" ? d.ttc : d.ht;
    out.push(run);
  }
  return out;
}

/** `monthKey` = `yyyy-MM`; `current` / `previous` = that month's days and the same month a year earlier. A target is HT, so it is dropped in TTC. */
export function paceSeries(monthKey: string, current: CalendarDay[], previous: CalendarDay[], mode: TaxMode, targetHt: number | null): PaceSeries {
  const [y, m] = monthKey.split("-").map(Number);
  const n = daysInMonth(y, m);
  const cur = runningTotal(current, n, mode);
  const prev = runningTotal(previous, n, mode);
  let asOfDay = 0;
  while (asOfDay < n && cur[asOfDay] !== null) asOfDay++;
  const currentToDate = asOfDay ? cur[asOfDay - 1] : null;
  const previousToDate = asOfDay ? prev[asOfDay - 1] : null;
  return {
    days: n,
    current: cur,
    previous: prev,
    target: targetHt != null && targetHt > 0 && mode === "ht" ? Array.from({ length: n }, (_, i) => Math.round((targetHt * (i + 1)) / n)) : null,
    asOfDay,
    currentToDate,
    previousToDate,
    change: currentToDate != null && previousToDate != null && previousToDate > 0 ? (currentToDate - previousToDate) / previousToDate : null,
    previousTotal: prev[n - 1],
  };
}

/** The last bucket as plain French lines to paste in a message; the wording is not translated on purpose. */
export function summaryText(
  buckets: RevenueBucket[],
  mode: TaxMode,
  fmt: { money: (n: number) => string; pct: (v: number | null) => string },
  filterNote = ""
): string {
  const last = buckets[buckets.length - 1];
  if (!last) return "";
  const pick = (m: { ht: number; ttc: number }) => (mode === "ttc" ? m.ttc : m.ht);
  const tag = mode.toUpperCase();
  const out = [`CA ${last.label}${last.partial ? ` (en cours, ${last.elapsedDays} j)` : ""}${filterNote ? ` — ${filterNote}` : ""} : ${fmt.money(pick(last))} ${tag}`];
  const evo = mode === "ttc" ? last.evolution.ttc : last.evolution.ht;
  if (evo != null) out.push(`• vs période précédente${last.partial ? " (à date)" : ""} : ${fmt.pct(evo)}`);
  if (last.yearAgo && pick(last.yearAgo) > 0) out.push(`• sur un an : ${fmt.pct((pick(last) - pick(last.yearAgo)) / pick(last.yearAgo))} (${fmt.money(pick(last.yearAgo))})`);
  if (last.projection) out.push(`• projection fin de période : ${fmt.money(pick(last.projection))}`);
  if (last.costedHt) {
    const margin = last.costedHt - (last.cost ?? 0);
    out.push(`• marge brute HT : ${fmt.money(margin)} (${Math.round((margin / last.costedHt) * 100)} %)`);
  }
  if (last.target) out.push(`• objectif HT : ${Math.round((last.ht / last.target) * 100)} % de ${fmt.money(last.target)}`);
  return out.join("\n");
}
