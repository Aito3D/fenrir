import { describe, expect, it } from "vitest";
import { bucketSplit, chartSeries, cumulativeScale, marginBuckets, niceTicks, OTHER_SERIES, STACK_DIMENSIONS, stackColumns, yFor } from "@/components/revenue/lib/chart";
import { bucket } from "./fixtures";

const b1 = bucket({ key: "2026-09", label: "sept. 2026", ht: 1000, ttc: 1160, goods: 600, services: 400, byNature: { Filaments: 600, "Sans nature": 400 }, byBrand: { SUNLU: 600, Aito3D: 400 }, cumulative: { ht: 1000, ttc: 1160 }, goodsTtc: 696, servicesTtc: 464, byNatureTtc: { Filaments: 696, "Sans nature": 464 }, byBrandTtc: { SUNLU: 696, Aito3D: 464 } });
const b2 = bucket({ ht: 300, ttc: 348, goods: 300, services: 0, byNature: { "3D Printers": 300 }, byBrand: { "Bambu Lab": 300 }, cumulative: { ht: 1300, ttc: 1508 }, partial: true, missingDays: 2 });

describe("bucketSplit", () => {
  it("picks the dimension", () => {
    expect(bucketSplit(b1, "nature")).toEqual({ Filaments: 600, "Sans nature": 400 });
    expect(bucketSplit(b1, "brand")).toEqual({ SUNLU: 600, Aito3D: 400 });
    expect(bucketSplit(b1, "kind")).toEqual({ Biens: 600, Services: 400 });
  });

  it("splits by item when the bucket carries a product selection, empty otherwise", () => {
    expect(bucketSplit(bucket({ byItem: { "Starlink - Support Mini": 300, "Starlink - Support v3&4": 700 } }), "item")).toEqual({
      "Starlink - Support Mini": 300,
      "Starlink - Support v3&4": 700,
    });
    expect(bucketSplit(b1, "item")).toEqual({});
    expect(STACK_DIMENSIONS.map((d) => d.id)).toEqual(["nature", "brand", "kind", "segment", "item"]);
  });
});

describe("chartSeries", () => {
  it("orders series by weight across every bucket and keeps slots stable", () => {
    expect(chartSeries([b1, b2], "nature")).toEqual([
      { key: "Filaments", label: "Filaments", slot: 0 },
      { key: "Sans nature", label: "Sans nature", slot: 1 },
      { key: "3D Printers", label: "3D Printers", slot: 2 },
    ]);
  });

  it("folds everything past MAX_STACK_SERIES into Other", () => {
    const many = bucket({ byBrand: { a: 7, b: 6, c: 5, d: 4, e: 3, f: 2, g: 1 }, ht: 28 });
    const series = chartSeries([many], "brand");
    expect(series.map((s) => s.key)).toEqual(["a", "b", "c", "d", "e", OTHER_SERIES]);
    expect(series[5]).toEqual({ key: OTHER_SERIES, label: "Autres", slot: 5 });
  });
});

describe("chartSeries edge cases (T-1526)", () => {
  it("a bucket without byItem yields no item series, in HT and TTC", () => {
    const b = bucket({ ht: 10, ttc: 12 });
    expect(chartSeries([b], "item")).toEqual([]);
    expect(bucketSplit(b, "item", "ttc")).toEqual({});
    expect(chartSeries([bucket({ byItemTtc: undefined })], "item")).toEqual([]);
  });

  it("two series of identical absolute weight are ordered alphabetically", () => {
    const b = bucket({ byBrand: { B: 100, A: -100 }, ht: 0 });
    expect(chartSeries([b], "brand").map((s) => [s.key, s.slot])).toEqual([["A", 0], ["B", 1]]);
  });
});

describe("stackColumns", () => {
  it("stacks segments bottom-up in slot order, in HT", () => {
    const cols = stackColumns([b1, b2], chartSeries([b1, b2], "nature"), "nature", "ht");
    expect(cols[0]).toMatchObject({ key: "2026-09", total: 1000, cumulative: 1000, partial: false });
    expect(cols[0].segments).toEqual([
      { key: "Filaments", value: 600, from: 0, to: 600 },
      { key: "Sans nature", value: 400, from: 600, to: 1000 },
      { key: "3D Printers", value: 0, from: 1000, to: 1000 },
    ]);
    expect(cols[1]).toMatchObject({ total: 300, cumulative: 1300, partial: true, missingDays: 2 });
  });

  it("stacks each series' own TTC when mode is ttc", () => {
    const cols = stackColumns([b1], chartSeries([b1], "kind"), "kind", "ttc");
    expect(cols[0].total).toBe(1160);
    expect(cols[0].segments.map((s) => Math.round(s.value))).toEqual([696, 464]);
    expect(cols[0].cumulative).toBe(1160);
  });

  it("T-1500: mixed tax rates with a credit note keep each series' real TTC height", () => {
    // 1000 HT @16 % (1160 TTC) in Filaments, -990 HT credit note @5 % (-1039.5 TTC) in Accessoires.
    const b = bucket({ ht: 10, ttc: 121, byNature: { Filaments: 1000, Accessoires: -990 }, byNatureTtc: { Filaments: 1160, Accessoires: -1039 } });
    const series = chartSeries([b], "nature");
    const ttc = stackColumns([b], series, "nature", "ttc")[0];
    expect(ttc.total).toBe(121);
    expect(ttc.segments).toEqual([
      { key: "Filaments", value: 1160, from: 0, to: 1160 },
      { key: "Accessoires", value: -1039, from: 0, to: -1039 },
    ]);
    // HT mode is untouched by the TTC splits.
    expect(stackColumns([b], series, "nature", "ht")[0].segments).toEqual([
      { key: "Filaments", value: 1000, from: 0, to: 1000 },
      { key: "Accessoires", value: -990, from: 0, to: -990 },
    ]);
  });

  it("T-1500: a negative HT net with a positive TTC does not flip the segments", () => {
    const b = bucket({ ht: -10, ttc: 50, byBrand: { a: -100, b: 90 }, byBrandTtc: { a: -100, b: 150 } });
    const col = stackColumns([b], chartSeries([b], "brand"), "brand", "ttc")[0];
    expect(col.segments.map((x) => x.value)).toEqual([-100, 150]);
  });

  it("folds tail series into one Other segment and stacks a negative series below zero", () => {
    const b = bucket({ ht: 4, byBrand: { a: 7, b: 6, c: 5, d: 4, e: 3, f: -21 } });
    const cols = stackColumns([b], chartSeries([b], "brand"), "brand", "ht");
    const other = cols[0].segments.find((s) => s.key === OTHER_SERIES)!;
    expect(other).toEqual({ key: OTHER_SERIES, value: 3, from: 22, to: 25 });
    const f = cols[0].segments.find((s) => s.key === "f")!;
    expect(f).toEqual({ key: "f", value: -21, from: 0, to: -21 });
  });
});

describe("cumulativeScale / yFor", () => {
  const cols = (...c: number[]) => c.map((cumulative) => ({ cumulative }));
  const TOP = 20;
  const H = 196;

  it("is {0, 1} with no columns", () => {
    expect(cumulativeScale([])).toEqual({ min: 0, max: 1 });
  });

  it("all non-negative: min 0, max floored at 1, and yFor equals the old v / max mapping", () => {
    for (const values of [[0, 0], [0.5], [100, 250, 900], [5, 3, 8]]) {
      const { min, max } = cumulativeScale(cols(...values));
      expect(min).toBe(0);
      expect(max).toBe(Math.max(1, ...values));
      for (const v of [0, ...values, max]) {
        expect(yFor(v, min, max, TOP, H)).toBe(TOP + H - (v / max) * H);
      }
    }
  });

  it("a negative cumulative: negative min, max >= 1, every value inside the plot", () => {
    const values = [-400, -150, 200, -50];
    const { min, max } = cumulativeScale(cols(...values));
    expect(min).toBe(-400);
    expect(max).toBe(200);
    for (const v of values) {
      const y = yFor(v, min, max, TOP, H);
      expect(y).toBeGreaterThanOrEqual(TOP);
      expect(y).toBeLessThanOrEqual(TOP + H);
    }
    expect(yFor(min, min, max, TOP, H)).toBe(TOP + H);
    expect(yFor(max, min, max, TOP, H)).toBe(TOP);
  });

  it("all negative: max stays 1 so the range is never degenerate", () => {
    const { min, max } = cumulativeScale(cols(-30, -10));
    expect(min).toBe(-30);
    expect(max).toBe(1);
    expect(yFor(-30, min, max, TOP, H)).toBe(TOP + H);
  });
});

describe("bucketSplit — Client (2026-10-30)", () => {
  it("labels the segments in their fixed order, HT or TTC", () => {
    const b = bucket({ bySegment: { inconnu: 5, pro: 100, particulier: 50 }, bySegmentTtc: { pro: 116 } });
    expect(Object.entries(bucketSplit(b, "segment"))).toEqual([["Pro", 100], ["Particuliers", 50], ["Non identifié", 5]]);
    expect(bucketSplit(b, "segment", "ttc")).toEqual({ Pro: 116 });
  });
});

describe("niceTicks", () => {
  it("rounds the axis to clean steps that cover the maximum", () => {
    expect(niceTicks(1281)).toEqual([0, 500, 1000, 1500]);
    expect(niceTicks(720)).toEqual([0, 200, 400, 600, 800]);
    expect(niceTicks(0)).toEqual([0, 1]);
  });
});

describe("buckets without the permission-gated fields", () => {
  it("bucketSplit by segment yields nothing and chartSeries no segment series", () => {
    const b = bucket({ ht: 10, bySegment: undefined, bySegmentTtc: undefined });
    expect(bucketSplit(b, "segment")).toEqual({});
    expect(bucketSplit(b, "segment", "ttc")).toEqual({});
    expect(chartSeries([b], "segment")).toEqual([]);
  });
});

describe("marginBuckets", () => {
  it("plots costed HT minus cost as one series with its own running total", () => {
    const out = marginBuckets([{ ...b1, costedHt: 800, cost: 300, target: 5000 }, { ...b2, costedHt: 0, cost: 0 }, b2], "Margin");
    expect(out.map((b) => [b.ht, b.ttc, b.cumulative.ht])).toEqual([[500, 500, 500], [0, 0, 500], [0, 0, 500]]);
    expect(bucketSplit(out[0], "brand")).toEqual({ Margin: 500 });
    expect(out[0].target).toBeUndefined();
    expect(out[0].projection).toBeNull();
  });

  it("stacks by the server's margin split when there is one", () => {
    const marginSplit = { nature: { Filaments: 400 }, brand: { SUNLU: 400 }, kind: { Biens: 250, Services: 150 }, segment: { pro: 400 } };
    const [b] = marginBuckets([{ ...b1, costedHt: 900, cost: 500, marginSplit }], "Margin");
    expect(bucketSplit(b, "nature")).toEqual({ Filaments: 400 });
    expect(bucketSplit(b, "kind", "ttc")).toEqual({ Biens: 250, Services: 150 });
    expect(b.bySegment).toEqual({ pro: 400 });
  });
});
