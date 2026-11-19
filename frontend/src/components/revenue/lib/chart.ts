import type { CustomerSegment, RevenueBucket, TaxMode } from "./types";

const CUSTOMER_SEGMENTS: readonly CustomerSegment[] = ["pro", "particulier", "passage", "inconnu"];
export const SEGMENT_LABEL: Record<CustomerSegment, string> = {
  pro: "Pro",
  particulier: "Particuliers",
  passage: "Passage",
  inconnu: "Non identifié",
};

export const OTHER_SERIES = "__other";

/**
 * Data shaping for the revenue chart: one stacked column per bucket whose
 * height is the bucket's HT (or TTC), split by Nature, brand or goods vs
 * services. Series get a fixed slot by their weight across the *whole*
 * displayed range (the `cost-history-chart.ts` rule) so a colour follows a
 * series from column to column; the tail past `MAX_STACK_SERIES` folds into
 * « Autres ». Positive segments stack up from 0, negative ones (a month
 * where credit notes outweigh sales for a series) stack down from 0.
 */
export type StackDimension = "nature" | "brand" | "kind" | "segment" | "item";
/** « Produit » only means something while a product selection is active (`RevenueBucket.byItem` present). */
export const STACK_DIMENSIONS: { id: StackDimension; label: string }[] = [
  { id: "nature", label: "Nature" },
  { id: "brand", label: "Marque" },
  { id: "kind", label: "Biens / Services" },
  { id: "segment", label: "Client" },
  { id: "item", label: "Produit" },
];

const MAX_STACK_SERIES = 5;

export interface StackSeries {
  key: string;
  label: string;
  slot: number;
}

export interface StackSegment {
  key: string;
  value: number;
  from: number;
  to: number;
}

export interface StackedColumn {
  key: string;
  label: string;
  total: number;
  cumulative: number;
  partial: boolean;
  missingDays: number;
  segments: StackSegment[];
}

export function bucketSplit(b: RevenueBucket, dim: StackDimension, mode: TaxMode = "ht"): Record<string, number> {
  const ttc = mode === "ttc";
  switch (dim) {
    case "nature":
      return ttc ? b.byNatureTtc : b.byNature;
    case "brand":
      return ttc ? b.byBrandTtc : b.byBrand;
    case "kind":
      return ttc ? { Biens: b.goodsTtc, Services: b.servicesTtc } : { Biens: b.goods, Services: b.services };
    case "segment": {
      const src = (ttc ? b.bySegmentTtc : b.bySegment) ?? {};
      const out: Record<string, number> = {};
      for (const seg of CUSTOMER_SEGMENTS) if (src[seg] !== undefined) out[SEGMENT_LABEL[seg]] = src[seg];
      return out;
    }
    case "item":
      return (ttc ? b.byItemTtc : b.byItem) ?? {};
  }
}

export function chartSeries(buckets: RevenueBucket[], dim: StackDimension): StackSeries[] {
  const weight = new Map<string, number>();
  for (const b of buckets) {
    for (const [k, v] of Object.entries(bucketSplit(b, dim))) weight.set(k, (weight.get(k) ?? 0) + Math.abs(v));
  }
  const ranked = [...weight.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  const head = ranked.length > MAX_STACK_SERIES ? ranked.slice(0, MAX_STACK_SERIES) : ranked;
  const series = head.map((key, slot) => ({ key, label: key, slot }));
  if (ranked.length > MAX_STACK_SERIES) series.push({ key: OTHER_SERIES, label: "Autres", slot: MAX_STACK_SERIES });
  return series;
}

export function stackColumns(buckets: RevenueBucket[], series: StackSeries[], dim: StackDimension, mode: TaxMode): StackedColumn[] {
  const named = new Set(series.filter((s) => s.key !== OTHER_SERIES).map((s) => s.key));
  return buckets.map((b) => {
    // In TTC mode each segment is that series' own TTC (each line at its own
    // rate), never the HT split scaled by one bucket-wide ratio.
    const split = bucketSplit(b, dim, mode);
    const valueOf = (key: string) =>
      key === OTHER_SERIES
        ? Object.entries(split).filter(([k]) => !named.has(k)).reduce((a, [, v]) => a + v, 0)
        : (split[key] ?? 0);
    let up = 0;
    let down = 0;
    const segments = series.map((s) => {
      const value = valueOf(s.key);
      if (value >= 0) {
        const seg = { key: s.key, value, from: up, to: up + value };
        up += value;
        return seg;
      }
      const seg = { key: s.key, value, from: down, to: down + value };
      down += value;
      return seg;
    });
    return {
      key: b.key,
      label: b.label,
      total: mode === "ttc" ? b.ttc : b.ht,
      cumulative: mode === "ttc" ? b.cumulative.ttc : b.cumulative.ht,
      partial: b.partial,
      missingDays: b.missingDays,
      segments,
    };
  });
}

/** Extent of the cumulative line: always spans 0, and at least [0, 1]. */
export function cumulativeScale(columns: { cumulative: number }[]): { min: number; max: number } {
  const values = columns.map((c) => c.cumulative);
  return { min: Math.min(0, ...values), max: Math.max(1, ...values) };
}

/** Maps v in [min, max] onto the plot: max at `top`, min at `top + plotHeight`. With min 0 this is `v / max`. */
export function yFor(v: number, min: number, max: number, top: number, plotHeight: number): number {
  return top + plotHeight - ((v - min) / (max - min || 1)) * plotHeight;
}

/** 0 … ≥ max in 4–5 clean steps (1/2/5 × 10^n). */
export function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const candidates = [1, 2, 5, 10].map((m) => m * magnitude);
  const step = candidates.find((c) => c >= rough) ?? candidates[candidates.length - 1];
  const ticks: number[] = [];
  for (let v = 0; v < max + step; v += step) {
    ticks.push(v);
    if (v >= max) break;
  }
  return ticks;
}
