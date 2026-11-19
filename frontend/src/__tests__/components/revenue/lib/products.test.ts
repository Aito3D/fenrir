import { describe, expect, it } from "vitest";
import { brandFilterLabel, brandOptions, filterByBrands, filterByKind, pickedBrandChips, searchProducts } from "@/components/revenue/lib/products";
import type { RevenueProduct } from "@/components/revenue/lib/types";

describe("brandOptions", () => {
  const product = (itemId: string, brand: string | null, totalHt: number) => ({ itemId, name: itemId, sku: "", brand, totalHt, quantity: 1, lastDay: "2026-10-01" });

  it("breaks an equal |CA| tie alphabetically, a negative total tying a positive one", () => {
    const opts = brandOptions([product("a", "Polymaker", 500), product("b", "eSUN", -500), product("c", "Aito3D", 500)]);
    expect(opts.map((o) => o.brand)).toEqual(["Aito3D", "eSUN", "Polymaker"]);
  });

  it("T-1528: null, undefined and blank brands are left out (the key is empty, so the loop skips them)", () => {
    const undef = { ...product("u", null, 700), brand: undefined } as unknown as RevenueProduct;
    const opts = brandOptions([product("n", null, 900), undef, product("b", "  ", 800), product("e", "eSUN", 100)]);
    expect(opts).toEqual([{ brand: "eSUN", key: "esun", totalHt: 100, count: 1 }]);
  });

  it("folds case and padding into one option (first spelling, trimmed), summing mixed-sign totals and counting products", () => {
    const opts = brandOptions([product("a", "SUNLU", 1000), product("b", " sunlu ", -300), product("c", "eSUN", 600)]);
    expect(opts).toEqual([
      { brand: "SUNLU", key: "sunlu", totalHt: 700, count: 2 },
      { brand: "eSUN", key: "esun", totalHt: 600, count: 1 },
    ]);
  });

  it("lists each brand once with its summed CA and product count, heaviest |CA| first, brandless products left out", () => {
    const opts = brandOptions([product("a", "eSUN", 100), product("b", "Aito3D", -5000), product("c", "eSUN", 250), product("d", null, 9000)]);
    expect(opts).toEqual([
      { brand: "Aito3D", key: "aito3d", totalHt: -5000, count: 1 },
      { brand: "eSUN", key: "esun", totalHt: 350, count: 2 },
    ]);
  });

  it("folds casing and whitespace into one option, keeping the first spelling seen", () => {
    const opts = brandOptions([product("a", "Bambu Lab", 10), product("b", " bambu lab ", 20)]);
    expect(opts).toEqual([{ brand: "Bambu Lab", key: "bambu lab", totalHt: 30, count: 2 }]);
  });

  it("is empty while the list is", () => {
    expect(brandOptions([])).toEqual([]);
  });
});

describe("searchProducts", () => {
  const prod = (itemId: string, name: string, sku = ""): RevenueProduct => ({ itemId, name, sku, brand: null, totalHt: 1, quantity: 1, lastDay: "2026-10-01" });
  const catalogue = [prod("mini", "Starlink - Support Mini", "STL-MINI"), prod("v3", "Starlink - Support v3&4", "STL-V3"), prod("hobie", "Hobie T1", "HOB-T1")];

  it("gives nothing for a 1-char, whitespace-only or empty query", () => {
    expect(searchProducts(catalogue, "s", new Set())).toEqual({ matches: [], shown: [] });
    expect(searchProducts(catalogue, "   ", new Set())).toEqual({ matches: [], shown: [] });
    expect(searchProducts(catalogue, " a ", new Set())).toEqual({ matches: [], shown: [] });
  });

  it("gives nothing while the products are not loaded", () => {
    expect(searchProducts(null, "starlink", new Set())).toEqual({ matches: [], shown: [] });
  });

  it("excludes products already in the basket", () => {
    const r = searchProducts(catalogue, "starlink", new Set(["mini"]));
    expect(r.matches.map((x) => x.itemId)).toEqual(["v3"]);
  });

  it("matches by SKU as well as by name", () => {
    expect(searchProducts(catalogue, "HOB-T1", new Set()).matches.map((x) => x.itemId)).toEqual(["hobie"]);
  });

  it("matches tokens in any order and keeps the catalogue order", () => {
    expect(searchProducts(catalogue, "mini starlink", new Set()).matches.map((x) => x.itemId)).toEqual(["mini"]);
    expect(searchProducts(catalogue, "starlink", new Set()).matches.map((x) => x.itemId)).toEqual(["mini", "v3"]);
  });

  it("caps the shown rows at 12 while matches keeps every hit", () => {
    const many = Array.from({ length: 20 }, (_, i) => prod(`p${i}`, `Widget ${i}`));
    const r = searchProducts(many, "widget", new Set());
    expect(r.matches).toHaveLength(20);
    expect(r.shown).toHaveLength(12);
    expect(r.shown).toEqual(r.matches.slice(0, 12));
  });
});

describe("filterByKind", () => {
  const p = (itemId: string, kind?: "goods" | "service"): RevenueProduct => ({ itemId, name: itemId, sku: "", brand: null, kind, totalHt: 1, quantity: 1, lastDay: "" });
  it("keeps the picked kind (and kind-less rows), identity without a kind", () => {
    const list = [p("a", "goods"), p("b", "service"), p("c")];
    expect(filterByKind(list, "services")?.map((x) => x.itemId)).toEqual(["b", "c"]);
    expect(filterByKind(list, "goods")?.map((x) => x.itemId)).toEqual(["a", "c"]);
    expect(filterByKind(list, null)).toBe(list);
    expect(filterByKind(null, "goods")).toBeNull();
  });
});

describe("filterByBrands", () => {
  const prod = (itemId: string, brand: string | null): RevenueProduct => ({ itemId, name: itemId, sku: "", brand, totalHt: 1, quantity: 1, lastDay: "2026-10-01" });
  const list = [prod("a", " SUNLU "), prod("b", "eSUN"), prod("c", null), prod("d", "sunlu")];

  it("is null while the products are not loaded", () => {
    expect(filterByBrands(null, new Set(["sunlu"]))).toBeNull();
    expect(filterByBrands(null, new Set())).toBeNull();
  });

  it("returns the very same array when no brand is picked", () => {
    expect(filterByBrands(list, new Set())).toBe(list);
  });

  it("keeps the products whose folded brand is picked, in catalogue order", () => {
    expect(filterByBrands(list, new Set(["sunlu"]))!.map((x) => x.itemId)).toEqual(["a", "d"]);
    expect(filterByBrands(list, new Set(["esun", "sunlu"]))!.map((x) => x.itemId)).toEqual(["a", "b", "d"]);
  });

  it("drops brandless products and returns a new array", () => {
    const out = filterByBrands(list, new Set(["nobody"]));
    expect(out).toEqual([]);
    expect(out).not.toBe(list);
  });
});

describe("brandFilterLabel", () => {
  it("prints the bare label, the single brand, or the count", () => {
    expect(brandFilterLabel([])).toBe("Marque");
    expect(brandFilterLabel([{ brand: "eSUN" }])).toBe("Marque : eSUN");
    expect(brandFilterLabel([{ brand: "eSUN" }, { brand: "SUNLU" }])).toBe("Marques (2)");
  });
});

describe("pickedBrandChips", () => {
  const options = [
    { brand: "eSUN", key: "esun", totalHt: 10, count: 1 },
    { brand: "SUNLU", key: "sunlu", totalHt: 5, count: 1 },
  ];
  it("is empty when nothing is picked", () => {
    expect(pickedBrandChips(new Set(), options)).toEqual([]);
    expect(pickedBrandChips(new Set(), [])).toEqual([]);
  });
  it("keeps the options order whatever the click order", () => {
    expect(pickedBrandChips(new Set(["sunlu", "esun"]), options)).toEqual([
      { key: "esun", brand: "eSUN" },
      { key: "sunlu", brand: "SUNLU" },
    ]);
  });
  it("appends keys missing from the options after the known ones, labelled by key, in picked order", () => {
    expect(pickedBrandChips(new Set(["gone2", "sunlu", "gone1", "esun"]), options)).toEqual([
      { key: "esun", brand: "eSUN" },
      { key: "sunlu", brand: "SUNLU" },
      { key: "gone2", brand: "gone2" },
      { key: "gone1", brand: "gone1" },
    ]);
  });
  it("still returns a chip for every key when there are no options", () => {
    expect(pickedBrandChips(new Set(["x"]), [])).toEqual([{ key: "x", brand: "x" }]);
  });
});
