import { describe, expect, it } from "vitest";
import { createSearchMatcher, escapeRegex } from "@/components/revenue/lib/search";

describe("createSearchMatcher", () => {
  it("matches every token in any order", () => {
    const m = createSearchMatcher("PLA or");
    expect(m("eSUN - PLA - Or (Gold) - 1.75mm")).toBe(true);
    expect(m("or pla")).toBe(true);
    expect(m("eSUN - PETG - Or")).toBe(false);
  });
  it("matches tokens at a word start in multi-word fields, substrings in space-free ones", () => {
    const m = createSearchMatcher("or");
    expect(m("Filament Orange")).toBe(true);
    expect(m("Cored colors")).toBe(false);
    expect(m("SKU-CORED")).toBe(true);
    expect(m(null, undefined, "Or")).toBe(true);
  });
  it("folds accents and case, and an empty query matches everything", () => {
    expect(createSearchMatcher("ete")("Édition Été")).toBe(true);
    expect(createSearchMatcher("  ")("anything")).toBe(true);
  });
  it("escapes regex characters", () => {
    expect(escapeRegex("a.b*c")).toBe("a\\.b\\*c");
    expect(createSearchMatcher("1.75")("PLA 1.75mm")).toBe(true);
    expect(createSearchMatcher("1.75")("PLA 1x75mm")).toBe(false);
  });
});
