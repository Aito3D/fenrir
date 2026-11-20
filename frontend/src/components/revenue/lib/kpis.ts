import { toDateRangeLabel } from "./buckets";
import type { RevenueBucket, RevenueGranularity, TaxMode } from "./types";

export interface KpiTile {
  label: string;
  /** Raw figure; the component formats it (`money` for "money", `pct` for "pct"); null reads "—". */
  value: number | null;
  /** "share" is an unsigned ratio (`84 %`), "pct" a signed change (`+12,0 %`). */
  kind: "money" | "pct" | "share";
  hint?: string;
  /** Amount the component appends to `hint` as ` <money>` (the year-ago tile). */
  hintAmount?: number;
  tone?: "up" | "down";
}

const pickMode = (m: { ht: number; ttc: number }, mode: TaxMode) => (mode === "ttc" ? m.ttc : m.ht);

export function evolutionFor(b: RevenueBucket, mode: TaxMode): number | null {
  return mode === "ttc" ? b.evolution.ttc : b.evolution.ht;
}

export function yearOverYear(b: RevenueBucket, mode: TaxMode): number | null {
  if (!b.yearAgo) return null;
  const ago = pickMode(b.yearAgo, mode);
  return ago > 0 ? (pickMode(b, mode) - ago) / ago : null;
}

export const unitsLabel = (n: number) => `${n} vendu${Math.abs(n) === 1 ? "" : "s"}`;

const toneOf = (v: number | null): "up" | "down" | undefined => (v == null ? undefined : v >= 0 ? "up" : "down");

/**
 * The five KPI tiles. `granularityLabel` is the capitalised label ("Mois")
 * passed in by the caller so the lib does not duplicate the component's map.
 */
export function kpiTiles(buckets: RevenueBucket[], mode: TaxMode, granularity: RevenueGranularity, selection: number, granularityLabel: string): KpiTile[] {
  const last = buckets[buckets.length - 1];
  const prev = buckets[buckets.length - 2];
  if (!last) return [];
  // For a product selection the units matter as much as the francs.
  const qty = (b: RevenueBucket) => (selection > 0 ? ` · ${unitsLabel(b.quantity)}` : "");
  const totalQty = buckets.reduce((s, b) => s + b.quantity, 0);
  const evo = evolutionFor(last, mode);
  const yoy = yearOverYear(last, mode);
  const unit = granularityLabel.toLowerCase();
  const prevRange = toDateRangeLabel(last, granularity, "previous");
  const yearRange = toDateRangeLabel(last, granularity, "year-ago");
  return [
    {
      label: `${granularityLabel} en cours`,
      value: pickMode(last, mode),
      kind: "money",
      hint: `${last.partial ? `${last.label} · en cours${last.ttcApprox && mode === "ttc" ? " · TTC ≈" : ""}` : last.label}${qty(last)}`,
    },
    {
      label: `${granularityLabel} précédent`,
      value: prev ? pickMode(prev, mode) : null,
      kind: "money",
      hint: prev ? `${prev.label}${qty(prev)}` : undefined,
    },
    { label: "Évolution", value: evo, kind: "pct", hint: prevRange ? `vs ${prevRange} (à date)` : `vs ${unit} précédent`, tone: toneOf(evo) },
    {
      label: "Sur un an",
      value: yoy,
      kind: "pct",
      hint: last.yearAgo ? `${yearRange ? `${yearRange} (à date)` : "il y a un an"} :` : "pas d'historique",
      hintAmount: last.yearAgo ? pickMode(last.yearAgo, mode) : undefined,
      tone: toneOf(yoy),
    },
    {
      label: "Cumul",
      value: pickMode(last.cumulative, mode),
      kind: "money",
      hint: `${buckets[0].label} → ${last.label}${selection > 0 ? ` · ${unitsLabel(totalQty)}` : ""}`,
    },
  ];
}

/**
 * The second KPI row, on the last bucket: gross margin (HT — a cost is HT
 * whatever the display mode, over the lines whose item has a cost), the
 * projection to the end of a partial bucket, and the share of the target
 * reached (with the projection's share in the hint). A tile is left out when
 * its figure does not exist (no cost known, a complete bucket, no target).
 */
export function insightTiles(buckets: RevenueBucket[], mode: TaxMode, granularityLabel: string): KpiTile[] {
  const last = buckets[buckets.length - 1];
  if (!last) return [];
  const out: KpiTile[] = [];
  const costedHt = last.costedHt ?? 0;
  if (costedHt !== 0) {
    const margin = costedHt - (last.cost ?? 0);
    out.push({
      label: "Marge brute HT",
      value: margin,
      kind: "money",
      hint: `${Math.round((margin / costedHt) * 100)} % · coût connu sur ${last.ht ? Math.round((costedHt / last.ht) * 100) : 0} % du CA`,
      tone: margin >= 0 ? "up" : "down",
    });
  }
  if (last.printHours && last.services) {
    out.push({ label: "Services / h machine", value: last.services / last.printHours, kind: "money", hint: `${last.printHours} h d'impression` });
  }
  if (last.projection) {
    out.push({
      label: `Projection fin de ${granularityLabel.toLowerCase()}`,
      value: pickMode(last.projection, mode),
      kind: "money",
      hint: last.projectionMethod === "seasonal" ? "au rythme de l'an dernier" : "au rythme actuel",
    });
  }
  if (last.target != null && last.target > 0) {
    const projected = last.projection ? last.projection.ht / last.target : null;
    out.push({
      label: "Objectif atteint",
      value: last.ht / last.target,
      kind: "share",
      hint: `${projected != null ? `projeté ${Math.round(projected * 100)} % · ` : ""}objectif HT`,
      hintAmount: last.target,
      tone: (projected ?? last.ht / last.target) >= 1 ? "up" : "down",
    });
  }
  return out;
}
