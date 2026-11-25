import { describe, expect, it } from "vitest";
import { journalTotals, periodRank, rateTone } from "@/components/revenue/lib/journal";
import type { RevenueItemRow } from "@/components/revenue/lib/types";

const day = (d: number, ht: number) => ({ start: `2026-11-${String(d).padStart(2, "0")}`, end: `2026-11-${String(d).padStart(2, "0")}`, ht });

describe("periodRank", () => {
  const month = [day(1, 100), day(2, 0), day(3, 500), day(4, 300), day(5, 300), day(6, 50), day(7, 20)];

  it("ranks the day among the days with sales, ties sharing a rank", () => {
    expect(periodRank(month, "2026-11-03", 5)).toBe(1);
    expect(periodRank(month, "2026-11-04", 5)).toBe(2);
    expect(periodRank(month, "2026-11-05", 5)).toBe(2);
    expect(periodRank(month, "2026-11-01", 5)).toBe(4);
  });

  it("is null outside the top, for a day without sales or absent from the series", () => {
    expect(periodRank(month, "2026-11-07", 5)).toBeNull();
    expect(periodRank(month, "2026-11-02", 5)).toBeNull();
    expect(periodRank(month, "2026-11-20", 5)).toBeNull();
  });

  it("waits for as many periods with sales as the top holds", () => {
    expect(periodRank(month.slice(0, 5), "2026-11-03", 5)).toBeNull(); // four days with sales
    expect(periodRank(month.slice(0, 6), "2026-11-03", 5)).toBe(1);
  });

  it("finds a month by any of its days", () => {
    const year = [1, 2, 3].map((m) => ({ start: `2026-0${m}-01`, end: `2026-0${m}-28`, ht: m * 10 }));
    expect(periodRank(year, "2026-02-14", 3)).toBe(2);
  });
});

describe("journalTotals", () => {
  const row = (ht: number, cost: number | null | undefined) => ({ ht, ttc: ht * 1.13, quantity: 1, cost }) as RevenueItemRow;

  it("leaves rows without a cost out of the margin and the rate", () => {
    const t = journalTotals([row(12_000, 9_000), row(2_000, 2_300), row(6_000, null)]);
    expect(t).toMatchObject({ ht: 20_000, quantity: 3, cost: 11_300, margin: 2_700, coverage: 0.7 });
    expect(t.rate).toBeCloseTo(2_700 / 14_000);
  });

  it("has no margin when no cost is known", () => {
    expect(journalTotals([row(6_000, null), row(1_000, undefined)])).toMatchObject({ cost: null, margin: null, rate: null, coverage: 0 });
    expect(journalTotals([])).toMatchObject({ ht: 0, margin: null, rate: null, coverage: 1 });
  });
});

describe("rateTone", () => {
  it("cuts at 10 % and 30 %", () => {
    expect([null, -0.2, 0.0999, 0.1, 0.2999, 0.3].map(rateTone)).toEqual([
      "text-bambu-gray", "text-status-error", "text-status-error", "text-status-warning", "text-status-warning", "text-status-ok",
    ]);
  });
});
