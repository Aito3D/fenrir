import { describe, expect, it } from "vitest";
import {
  bucketKeyFor,
  bucketLabel,
  bucketRange,
  isBucketKey,
  shiftBucketYear,
  toDateRangeLabel,
} from "@/components/revenue/lib/buckets";
import type { RevenueBucket } from "@/components/revenue/lib/types";

const bucket = (over: Partial<RevenueBucket> = {}): RevenueBucket => ({
  key: "2026-10",
  label: "oct. 2026",
  start: "2026-10-01",
  end: "2026-10-31",
  ht: 0,
  ttc: 0,
  goods: 0,
  services: 0,
  byNature: {},
  byBrand: {},
  goodsTtc: 0,
  servicesTtc: 0,
  byNatureTtc: {},
  byBrandTtc: {},
  projection: null,
  projectionMethod: null,
  quantity: 0,
  evolution: { ht: null, ttc: null },
  yearAgo: null,
  elapsedDays: 15,
  cumulative: { ht: 0, ttc: 0 },
  partial: true,
  missingDays: 0,
  ttcApprox: false,
  ...over,
});

describe("bucket keys, ranges and labels", () => {
  it("keys a day per granularity", () => {
    expect(bucketKeyFor("2026-10-15", "day")).toBe("2026-10-15");
    expect(bucketKeyFor("2026-10-15", "week")).toBe("2026-W42");
    expect(bucketKeyFor("2026-10-15", "month")).toBe("2026-10");
    expect(bucketKeyFor("2026-10-15", "year")).toBe("2026");
    expect(bucketKeyFor("2024-12-30", "week")).toBe("2025-W01");
  });

  it("ranges are the full calendar bucket", () => {
    expect(bucketRange("2026-W42", "week")).toEqual({ start: "2026-10-12", end: "2026-10-18" });
    expect(bucketRange("2025-W01", "week")).toEqual({ start: "2024-12-30", end: "2025-01-05" });
    expect(bucketRange("2024-02", "month")).toEqual({ start: "2024-02-01", end: "2024-02-29" });
    expect(bucketRange("2026", "year")).toEqual({ start: "2026-01-01", end: "2026-12-31" });
    expect(bucketRange("2026-10-15", "day")).toEqual({ start: "2026-10-15", end: "2026-10-15" });
  });

  it("labels in French", () => {
    expect(bucketLabel("2026-10", "month")).toBe("oct. 2026");
    expect(bucketLabel("2026", "year")).toBe("2026");
    expect(bucketLabel("2026-10-15", "day")).toBe("15 oct. 2026");
    expect(bucketLabel("2026-W42", "week")).toBe("S42 · 12–18 oct. 2026");
    expect(bucketLabel("2025-W01", "week")).toBe("S01 · 30 déc. 2024–5 janv. 2025");
  });

  it("shifts a bucket by a year, refusing a week 53 that does not exist and clamping 29 Feb", () => {
    expect(shiftBucketYear("2026-10", "month", -1)).toBe("2025-10");
    expect(shiftBucketYear("2026", "year", -1)).toBe("2025");
    expect(shiftBucketYear("2026-W42", "week", -1)).toBe("2025-W42");
    expect(shiftBucketYear("2026-W53", "week", -1)).toBeNull();
    expect(shiftBucketYear("2024-02-29", "day", -1)).toBe("2023-02-28");
  });

  it("labels a week spanning two months in one year, and a week inside one month", () => {
    expect(bucketLabel("2026-W41", "week")).toBe("S41 · 5–11 oct. 2026");
    expect(bucketLabel("2026-W40", "week")).toBe("S40 · 28 sept.–4 oct. 2026");
  });

  it("isBucketKey checks the key shape per granularity", () => {
    expect(isBucketKey("2026-10-15", "day")).toBe(true);
    expect(isBucketKey("2026-02-30", "day")).toBe(false);
    expect(isBucketKey("2026-W42", "week")).toBe(true);
    expect(isBucketKey("2026-10", "week")).toBe(false);
    expect(isBucketKey("2026-10", "month")).toBe(true);
    expect(isBucketKey("2026", "year")).toBe(true);
    expect(isBucketKey("2026-10", "year")).toBe(false);
  });
});

describe("toDateRangeLabel", () => {
  it("labels the clipped comparison range", () => {
    const oct = bucket();
    expect(toDateRangeLabel(oct, "month", "previous")).toBe("1–15 sept.");
    expect(toDateRangeLabel(oct, "month", "year-ago")).toBe("1–15 oct. 2025");
    expect(toDateRangeLabel({ ...oct, elapsedDays: null }, "month", "previous")).toBeNull();
  });

  it("returns null, never throws, when the bucket key does not parse under the granularity asked", () => {
    const oct = bucket();
    expect(toDateRangeLabel(oct, "day", "year-ago")).toBeNull();
    expect(toDateRangeLabel(oct, "year", "year-ago")).toBeNull();
    expect(toDateRangeLabel(oct, "week", "year-ago")).toBeNull();
    expect(toDateRangeLabel({ ...oct, elapsedDays: undefined as unknown as number }, "month", "previous")).toBeNull();
  });

  it("toDateRangeLabel: unparseable key, year-ago with no counterpart week, single-day and cross-month ranges", () => {
    const oct = bucket();
    expect(toDateRangeLabel({ ...oct, key: "2026" }, "month", "previous")).toBeNull();
    const wk = { ...oct, key: "2026-W53", start: "2026-12-28", elapsedDays: 3 };
    expect(toDateRangeLabel(wk, "week", "year-ago")).toBeNull();
    expect(toDateRangeLabel({ ...oct, elapsedDays: 1 }, "month", "year-ago")).toBe("1 oct. 2025");
    expect(toDateRangeLabel({ ...oct, elapsedDays: 1 }, "month", "previous")).toBe("1 sept.");
    expect(toDateRangeLabel({ ...oct, key: "2026-11", start: "2026-11-01", elapsedDays: 40 }, "month", "previous")).toBe("1–31 oct.");
    expect(toDateRangeLabel({ ...oct, key: "2026-W42", start: "2026-10-12", elapsedDays: 5 }, "week", "previous")).toBe("5–9 oct.");
    expect(toDateRangeLabel({ ...oct, key: "2026-W02", start: "2026-01-05", elapsedDays: 5 }, "week", "previous")).toBe("29 déc.–2 janv.");
  });
});
