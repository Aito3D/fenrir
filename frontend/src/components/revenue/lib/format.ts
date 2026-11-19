const FCP = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const AXIS_NUMBER = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const THIN_SPACE = " ";

/** Whole francs, dot-grouped thousands (the app's FCP convention), U+2212 minus. */
export function formatFcp(n: number): string {
  const r = Math.round(n);
  const digits = FCP.format(Math.abs(r)).replace(/\s/g, ".");
  return `${r < 0 ? "−" : ""}${digits} FCP`;
}

export function formatPct(v: number | null): string {
  if (v == null) return "—";
  const p = v * 100;
  return `${p > 0 ? "+" : ""}${p.toFixed(Math.abs(p) >= 100 ? 0 : 1)} %`;
}

/** Compact axis tick: `0`, `500 k`, `1,0 M` (the currency is stated once, outside the axis). */
export function compactAxis(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (a >= 1_000_000) return `${sign}${AXIS_NUMBER.format(a / 1_000_000)}${THIN_SPACE}M`;
  if (a >= 1_000) return `${sign}${Math.round(a / 1_000)}${THIN_SPACE}k`;
  return `${sign}${Math.round(a)}`;
}

// The server's French fallback group names (series.NO_BRAND / NO_NATURE); every other name is data and passes through.
const SERVER_FALLBACK_KEYS: Record<string, string> = { "Sans marque": "revenue.labels.noBrand", "Sans nature": "revenue.labels.noNature" };

export function serverLabel(name: string, t: (key: string) => string): string {
  const key = SERVER_FALLBACK_KEYS[name];
  return key ? t(key) : name;
}
