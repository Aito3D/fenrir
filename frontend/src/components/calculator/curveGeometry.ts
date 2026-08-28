// Pure geometry shared by the margin-curve preview, its drag handles and the
// example-job dot: chart domains and pixel ↔ value mapping. No React.

export const QTY_DOMAIN = [1, 100] as const;

/** The size chart spans 0..10K; it stretches so an example beyond that stays visible. */
export function sizeDomainMax(k: number, exampleUnitCost?: number): number {
  const base = k * 10;
  return exampleUnitCost !== undefined && exampleUnitCost > base ? exampleUnitCost * 1.1 : base;
}

export function qtyDomainMax(exampleQty?: number): number {
  return exampleQty !== undefined && exampleQty > QTY_DOMAIN[1] ? exampleQty * 1.1 : QTY_DOMAIN[1];
}

/** Linear map of a pointer x (page px) onto [min, max] over the plot area
 *  starting at plotLeft with plotWidth px. Clamped; a zero-width plot maps to min. */
export function xToValue(px: number, plotLeft: number, plotWidth: number, min: number, max: number): number {
  if (plotWidth <= 0) return min;
  const t = Math.min(1, Math.max(0, (px - plotLeft) / plotWidth));
  return min + t * (max - min);
}

export function roundK(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  const digits = Math.floor(Math.log10(value));
  const scale = 10 ** (digits - 2);
  return Math.round(value / scale) * scale;
}

export function roundKQ(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1;
}

/** Parse the raw example-job field strings into numbers usable by the
 *  pricing engine. Null when the unit cost is unusable (≤ 0 or non-finite);
 *  the quantity floors to at least 1. */
export function parsedExample(e: { unitCost: string; quantity: string }): { unitCost: number; quantity: number } | null {
  const u = Number(e.unitCost);
  const q = Math.floor(Number(e.quantity));
  if (!Number.isFinite(u) || u <= 0) return null;
  return { unitCost: u, quantity: Number.isFinite(q) && q >= 1 ? q : 1 };
}
