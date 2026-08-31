// Pure geometry shared by the margin-curve preview, its drag handles and the
// example-job dot: chart domains and pixel ↔ value mapping. No React.

export const QTY_DOMAIN = [1, 100] as const;

/** The size chart spans 0..10K; it stretches so an example beyond that stays visible. */
export function sizeDomainMax(k: number, exampleUnitCost?: number): number {
  const base = k * 10;
  return exampleUnitCost !== undefined && exampleUnitCost > base ? exampleUnitCost * 1.1 : base;
}

/** T-049: previously this only ever grew past QTY_DOMAIN[1]=100 for a large
 *  example quantity — unlike `sizeDomainMax`, which always contains K
 *  (`k * 10`), a stored `qty_k` (kq) at or beyond 100 rendered the KQ handle
 *  clamped to the domain's right edge, so a single click or arrow key
 *  collapsed it back down. `kq` is optional and stretches the domain to
 *  always contain `kq + 1` (the point the KQ handle actually renders at),
 *  mirroring sizeDomainMax's K coverage — but additively (`kq + KQ_HEADROOM`),
 *  not multiplicatively (`k * 10`). K's handle sits at a *constant* fraction
 *  (1/10) of its domain no matter how large K gets, so a live drag re-reading
 *  that domain after every `onChange` compounds K by ~10x per pointer event
 *  (T-006) — an anchor is required to freeze the domain for the gesture. An
 *  additive relationship keeps the domain's growth rate with respect to kq at
 *  exactly 1, so the same live-domain read-back can, at worst, add a constant
 *  (`KQ_HEADROOM`) per event — linear drift at the plot's clamped right edge,
 *  never the K bug's exponential blow-up — so no drag anchor is needed here.
 *  Below the pre-existing 100 floor this is byte-for-byte the old formula:
 *  `kq` only ever pushes the domain out past where it already was. */
const KQ_HEADROOM = 50;

export function qtyDomainMax(exampleQty?: number, kq?: number): number {
  const kqFloor = kq !== undefined && Number.isFinite(kq) && kq > 0 ? kq + 1 : 0;
  const base = kqFloor > QTY_DOMAIN[1] ? kqFloor + KQ_HEADROOM : QTY_DOMAIN[1];
  return exampleQty !== undefined && exampleQty > base ? exampleQty * 1.1 : base;
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
