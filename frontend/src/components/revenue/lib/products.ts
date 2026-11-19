import { createSearchMatcher } from "./search";
import type { RevenueKind, RevenueProduct } from "./types";

export const ITEM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A brand name folded for comparison: the key the brand filter sends and the series matches on. */
export const brandKey = (brand: string | null | undefined): string => (brand ?? "").trim().toLowerCase();

export interface BrandOption {
  /** The first spelling seen, what the chip prints. */
  brand: string;
  /** `brandKey(brand)`, what the `brand=` parameter carries. */
  key: string;
  totalHt: number;
  count: number;
}

/** Brands sold in scope, derived from the products list; heaviest |CA| first, brandless products belong to no option. */
export function brandOptions(products: RevenueProduct[]): BrandOption[] {
  const byKey = new Map<string, BrandOption>();
  for (const p of products) {
    const key = brandKey(p.brand);
    if (!key) continue;
    const opt = byKey.get(key);
    if (opt) {
      opt.totalHt += p.totalHt;
      opt.count += 1;
    } else {
      byKey.set(key, { brand: (p.brand ?? "").trim(), key, totalHt: p.totalHt, count: 1 });
    }
  }
  return [...byKey.values()].sort((a, b) => Math.abs(b.totalHt) - Math.abs(a.totalHt) || a.brand.localeCompare(b.brand));
}

/**
 * Chips of the picked brands: the options whose key is picked, in options order, then any picked
 * key that dropped out of `options`, labelled by its key, so the filter stays visible and removable.
 */
export function pickedBrandChips(brands: ReadonlySet<string>, options: BrandOption[]): { key: string; brand: string }[] {
  const known = options.filter((o) => brands.has(o.key));
  const listed = new Set(known.map((o) => o.key));
  const missing = [...brands].filter((key) => !listed.has(key));
  return [...known.map((o) => ({ key: o.key, brand: o.brand })), ...missing.map((key) => ({ key, brand: key }))];
}

/** Matches listed under the search box; « Ajouter les N résultats » still adds every match. */
export const MAX_SHOWN_MATCHES = 12;

/** Under two characters or before the products load nothing matches; else name + SKU token match minus the basket, catalogue order kept. */
export function searchProducts(
  products: RevenueProduct[] | null,
  query: string,
  basketIds: ReadonlySet<string>,
  max = MAX_SHOWN_MATCHES,
): { matches: RevenueProduct[]; shown: RevenueProduct[] } {
  const q = query.trim();
  if (!products || q.length < 2) return { matches: [], shown: [] };
  const matcher = createSearchMatcher(q);
  const matches = products.filter((x) => !basketIds.has(x.itemId) && matcher(x.name, x.sku));
  return { matches, shown: matches.slice(0, max) };
}

/** Products whose folded brand is picked; `null` before the list loads, the same array when no brand is picked. */
export function filterByBrands(products: RevenueProduct[] | null, brands: ReadonlySet<string>): RevenueProduct[] | null {
  return products && brands.size > 0 ? products.filter((x) => brands.has(brandKey(x.brand))) : products;
}

/** Products of the picked kind (a product without a `kind` is kept); the same array when no kind is picked. */
export function filterByKind(products: RevenueProduct[] | null, kind: RevenueKind | null): RevenueProduct[] | null {
  if (!products || !kind) return products;
  const want = kind === "services" ? "service" : "goods";
  return products.filter((p) => !p.kind || p.kind === want);
}

/** The brand popover trigger's label: bare, the one picked brand, or the count. */
export function brandFilterLabel(picked: { brand: string }[]): string {
  return picked.length === 0 ? "Marque" : picked.length === 1 ? `Marque : ${picked[0].brand}` : `Marques (${picked.length})`;
}
