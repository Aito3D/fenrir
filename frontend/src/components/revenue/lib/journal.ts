import type { RevenueBucket, RevenueItemRow } from "./types";

/** An item row of the journal; `shared` marks a cost taken from the period's production cost rather than the item's own. */
export type JournalRow = RevenueItemRow & { shared?: boolean };

/** The HT a row's own cost covers. */
const ownCostedHt = (r: RevenueItemRow) => (r.cost == null ? 0 : (r.costedHt ?? r.ht));

/**
 * Mirrors the server's bucket costing (series.py `_Acc`): services without a Zoho cost share the
 * period's production cost (filament, energy, wear, labour, fixed costs) pro rata of their HT.
 * `bucket` is the series bucket of the shown period; without one, or without a pool, rows pass through.
 */
export function withProductionCost(rows: readonly RevenueItemRow[], bucket: Pick<RevenueBucket, "costedHt" | "costParts"> | null | undefined): JournalRow[] {
  const production = Object.entries(bucket?.costParts ?? {}).reduce((s, [part, v]) => (part === "items" ? s : s + (v ?? 0)), 0);
  const poolHt = (bucket?.costedHt ?? 0) - rows.reduce((s, r) => s + ownCostedHt(r), 0);
  // Under a franc is rounding, not a pool.
  if (poolHt < 1) return [...rows];
  // shortcut: in a month straddling the first print-log day, services sold before that day are pooled too; split by day if that month matters.
  return rows.map((r) => (r.kind === "service" && r.cost === null ? { ...r, cost: (production * r.ht) / poolHt, costedHt: r.ht, shared: true } : r));
}

export interface JournalTotals {
  ht: number;
  ttc: number;
  quantity: number;
  /** Cost and margin (always HT) of the rows whose cost is known; null when none is. */
  cost: number | null;
  margin: number | null;
  /** Margin over the costed HT. */
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
      costedHt += ownCostedHt(r);
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
