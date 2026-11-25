import type { RevenueItemRow } from "./types";

export interface JournalTotals {
  ht: number;
  ttc: number;
  quantity: number;
  /** Cost and margin (always HT) of the rows whose cost is known; null when none is. */
  cost: number | null;
  margin: number | null;
  /** Margin over the HT of the costed rows. */
  rate: number | null;
  /** Share of the HT whose cost is known (0–1). */
  coverage: number;
}

/** Sums for one row, one group or the whole period: rows without a cost stay out of the margin and the rate. */
export function journalTotals(rows: readonly RevenueItemRow[]): JournalTotals {
  let ht = 0, ttc = 0, quantity = 0, cost = 0, costedHt = 0, costed = 0;
  for (const r of rows) {
    ht += r.ht;
    ttc += r.ttc;
    quantity += r.quantity;
    if (r.cost != null) {
      cost += r.cost;
      costedHt += r.ht;
      costed += 1;
    }
  }
  const margin = costed ? costedHt - cost : null;
  return { ht, ttc, quantity, cost: costed ? cost : null, margin, rate: margin !== null && costedHt > 0 ? margin / costedHt : null, coverage: ht > 0 ? costedHt / ht : 1 };
}

/** Fixed thresholds: 30 % and up is healthy, under 10 % is not. */
export function rateTone(rate: number | null): string {
  if (rate === null) return "text-bambu-gray";
  return rate < 0.1 ? "text-status-error" : rate < 0.3 ? "text-status-warning" : "text-status-ok";
}

/**
 * Where the period holding `day` ranks by HT among the periods with sales (1 = best, ties share a rank).
 * Null outside the `top`, without sales, or while fewer than `top` periods have sales.
 */
export function periodRank(buckets: readonly { start: string; end: string; ht: number }[], day: string, top: number): number | null {
  const sold = buckets.filter((b) => b.ht > 0);
  const mine = sold.find((b) => b.start <= day && day <= b.end);
  if (!mine || sold.length < top) return null;
  const rank = 1 + sold.filter((b) => b.ht > mine.ht).length;
  return rank <= top ? rank : null;
}
