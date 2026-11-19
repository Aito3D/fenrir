import { describe, expect, it } from "vitest";
import { addToBasket, effectiveStack } from "@/components/revenue/lib/basket";
import type { RevenueProduct } from "@/components/revenue/lib/types";

const p = (itemId: string) => ({ itemId }) as unknown as RevenueProduct;

describe("addToBasket", () => {
  it("is a no-op for an already-present itemId", () => {
    const cur = [p("a")];
    const r = addToBasket(cur, [p("a")]);
    expect(r.basket).toBe(cur);
    expect(r.switchToItemStack).toBe(false);
  });
  it("keeps one of two copies in one added list", () => {
    const r = addToBasket([], [p("a"), p("a")]);
    expect(r.basket.map((b) => b.itemId)).toEqual(["a"]);
  });
  it("switches to the item stack on the first add only", () => {
    const first = addToBasket([], [p("a")]);
    expect(first.switchToItemStack).toBe(true);
    const second = addToBasket(first.basket, [p("b")]);
    expect(second.basket.map((b) => b.itemId)).toEqual(["a", "b"]);
    expect(second.switchToItemStack).toBe(false);
  });
  it("returns the same basket when nothing is added", () => {
    const cur: RevenueProduct[] = [];
    const r = addToBasket(cur, []);
    expect(r.basket).toBe(cur);
    expect(r.switchToItemStack).toBe(false);
  });
});

describe("effectiveStack", () => {
  it("drops « Biens / Services » to « Nature » once the series is narrowed to one kind", () => {
    expect(effectiveStack(0, "kind", true)).toBe("nature");
    expect(effectiveStack(0, "kind", false)).toBe("kind");
    expect(effectiveStack(0, "brand", true)).toBe("brand");
    expect(effectiveStack(0, "segment", false, true)).toBe("nature");
    expect(effectiveStack(0, "segment", true, false)).toBe("segment");
  });

  it("falls back to nature for an empty basket on item", () => {
    expect(effectiveStack(0, "item")).toBe("nature");
  });
  it("keeps item for a non-empty basket", () => {
    expect(effectiveStack(2, "item")).toBe("item");
  });
  it("leaves brand unchanged with an empty basket", () => {
    expect(effectiveStack(0, "brand")).toBe("brand");
  });
});
