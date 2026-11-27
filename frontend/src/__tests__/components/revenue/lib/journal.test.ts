import { describe, expect, it } from "vitest";
import { journalTotals, periodRank, rateTone, withProductionCost } from "@/components/revenue/lib/journal";
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

  it("uses the costed part of a partly costed item", () => {
    const t = journalTotals([{ ...row(10_000, 3_000), costedHt: 6_000 }]);
    expect(t).toMatchObject({ margin: 3_000, rate: 0.5, coverage: 0.6 });
  });
});

describe("withProductionCost", () => {
  const item = (o: Partial<RevenueItemRow>) => ({ itemId: "x", ht: 0, ttc: 0, quantity: 1, kind: "service", cost: null, costedHt: 0, ...o }) as RevenueItemRow;
  const goods = item({ itemId: "g", kind: "goods", ht: 12_000, cost: 9_000, costedHt: 12_000 });
  const print = item({ itemId: "p", ht: 8_000 });
  const model = item({ itemId: "m", ht: 2_000 });

  it("shares the production cost between the services pro rata of their HT", () => {
    const out = withProductionCost([print, model], { costedHt: 10_000, costParts: { filament: 1_500, energy: 500, labor: 2_000 } });
    expect(out.map((r) => [r.cost, r.costedHt, r.shared])).toEqual([[3_200, 8_000, true], [800, 2_000, true]]);
  });

  it("keeps the goods' part of the fixed costs out of what the services share", () => {
    const bucket = { costedHt: 10_000, costParts: { filament: 1_500, fixed: 900, fixedEstimated: 100 }, fixedGoods: 500 };
    expect(withProductionCost([print, model], bucket).map((r) => r.cost)).toEqual([1_600, 400]);
  });

  it("leaves the rows alone without a bucket, without a pool, or under rounding noise", () => {
    expect(withProductionCost([print, model], null)).toEqual([print, model]);
    expect(withProductionCost([goods, print], { costedHt: 12_000, costParts: { items: 9_000, filament: 700 } })).toEqual([goods, print]);
    expect(withProductionCost([goods, print], { costedHt: 12_000.4, costParts: { items: 9_000 } })).toEqual([goods, print]);
  });

  it("agrees with the bucket on goods with their own cost plus pooled services", () => {
    const bucket = { costedHt: 22_000, cost: 13_000, costParts: { items: 9_000, filament: 1_500, labor: 2_500 } };
    const t = journalTotals(withProductionCost([goods, print, model], bucket));
    expect(t.cost).toBeCloseTo(bucket.cost);
    expect(t.margin).toBeCloseTo(bucket.costedHt - bucket.cost);
    expect(t.coverage).toBe(1);
  });

  it("keeps a service's own Zoho cost, and an uncosted good stays unknown", () => {
    const scan = item({ itemId: "s", ht: 1_000, cost: 400, costedHt: 1_000 });
    const spool = item({ itemId: "u", kind: "goods", ht: 3_000 });
    const out = withProductionCost([scan, spool, print], { costedHt: 9_000, costParts: { items: 400, wear: 1_000 } });
    expect(out[0]).toEqual(scan);
    expect(out[1]).toEqual(spool);
    expect(out[2]).toMatchObject({ cost: 1_000, shared: true });
  });

  it("does not touch rows stripped of their cost (no margin permission)", () => {
    const stripped = item({ ht: 5_000, cost: undefined, costedHt: undefined });
    expect(withProductionCost([stripped], { costedHt: 5_000, costParts: { labor: 100 } })).toEqual([stripped]);
  });
});

describe("rateTone", () => {
  it("cuts at 10 % and 30 %", () => {
    expect([null, -0.2, 0.0999, 0.1, 0.2999, 0.3].map(rateTone)).toEqual([
      "text-bambu-gray", "text-status-error", "text-status-error", "text-status-warning", "text-status-warning", "text-status-ok",
    ]);
  });
});

describe('bucketCharges', () => {
  it('sums labour, fixed costs (estimate included) and depreciation, never the variable costs', async () => {
    const { bucketCharges } = await import('../../../../components/revenue/lib/journal');
    expect(bucketCharges({ costParts: { items: 500, filament: 40, labor: 100, fixed: 60, fixedEstimated: 6, depreciation: 30 } })).toBe(196);
    expect(bucketCharges({ costParts: { items: 500 } })).toBeNull();
    expect(bucketCharges(undefined)).toBeNull();
  });
});
