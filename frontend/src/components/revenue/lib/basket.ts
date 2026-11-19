import type { StackDimension } from "./chart";
import type { RevenueProduct } from "./types";

/**
 * Adds products to the basket, deduplicated by itemId. `switchToItemStack` is true when the basket
 * was empty and now is not. Returns `cur` itself when nothing was added.
 */
export function addToBasket(
  cur: RevenueProduct[],
  added: RevenueProduct[],
): { basket: RevenueProduct[]; switchToItemStack: boolean } {
  const have = new Set(cur.map((b) => b.itemId));
  const fresh: RevenueProduct[] = [];
  for (const p of added) {
    if (have.has(p.itemId)) continue;
    have.add(p.itemId);
    fresh.push(p);
  }
  if (fresh.length === 0) return { basket: cur, switchToItemStack: false };
  return { basket: [...cur, ...fresh], switchToItemStack: cur.length === 0 };
}

/** « Produit » needs a basket, « Biens / Services » a series not narrowed to one kind, « Client » one not narrowed to a segment; each falls back to « Nature ». */
export function effectiveStack(basketSize: number, stack: StackDimension, kindFiltered = false, segmentFiltered = false): StackDimension {
  if (basketSize === 0 && stack === "item") return "nature";
  if (kindFiltered && stack === "kind") return "nature";
  if (segmentFiltered && stack === "segment") return "nature";
  return stack;
}
