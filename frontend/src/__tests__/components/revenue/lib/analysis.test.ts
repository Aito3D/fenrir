import { describe, expect, it } from "vitest";
import { drillDown, paceSeries, shiftBucketKey, shiftWindow, summaryText } from "@/components/revenue/lib/analysis";
import { bucket } from "./fixtures";

describe("shiftBucketKey / shiftWindow", () => {
  it("steps months, ISO weeks across a year end, and years", () => {
    expect(shiftBucketKey("2026-01", "month", -1)).toBe("2025-12");
    expect(shiftBucketKey("2026-W01", "week", -1)).toBe("2025-W52");
    expect(shiftBucketKey("2025-W52", "week", 2)).toBe("2026-W02");
    expect(shiftBucketKey("2026", "year", -2)).toBe("2024");
  });

  it("moves a window by whole buckets and clamps to the history and today", () => {
    expect(shiftWindow("2025-12-01", "2026-11-17", "month", -1, "2024-01-01", "2026-11-17")).toEqual({ from: "2025-11-01", to: "2026-10-31" });
    expect(shiftWindow("2025-11-01", "2026-10-31", "month", 1, "2024-01-01", "2026-11-17")).toEqual({ from: "2025-12-01", to: "2026-11-17" });
    expect(shiftWindow("2024-01-01", "2026-10-31", "month", -1, "2024-01-01", "2026-11-17")).toEqual({ from: "2024-01-01", to: "2026-09-30" });
  });

  it("returns null when the move leaves the history or passes today", () => {
    expect(shiftWindow("2026-11-01", "2026-11-17", "month", 1, "2024-01-01", "2026-11-17")).toBeNull();
    expect(shiftWindow("2024-01-01", "2024-01-31", "month", -1, "2024-01-01", "2026-11-17")).toBeNull();
  });
});

describe("drillDown", () => {
  it("goes one level finer, and nowhere from a day", () => {
    expect(drillDown({ start: "2026-01-01", end: "2026-12-31" }, "year")).toEqual({ granularity: "month", from: "2026-01-01", to: "2026-12-31" });
    expect(drillDown({ start: "2026-10-01", end: "2026-10-31" }, "month")).toEqual({ granularity: "day", from: "2026-10-01", to: "2026-10-31" });
    expect(drillDown({ start: "2026-10-12", end: "2026-10-18" }, "week")?.granularity).toBe("day");
    expect(drillDown({ start: "2026-10-12", end: "2026-10-12" }, "day")).toBeNull();
  });
});

describe("paceSeries", () => {
  const d = (day: string, ht: number, fetched = true) => ({ day, ht, ttc: ht * 2, fetched });

  it("runs both months to date, compares at the same day and spreads the target", () => {
    const p = paceSeries("2026-11", [d("2026-11-01", 100), d("2026-11-02", 50), d("2026-11-03", 0, false)], [d("2025-11-01", 80), d("2025-11-02", 20)], "ht", 3000);
    expect(p.days).toBe(30);
    expect(p.current.slice(0, 3)).toEqual([100, 150, null]);
    expect(p.asOfDay).toBe(2);
    expect(p.currentToDate).toBe(150);
    expect(p.previousToDate).toBe(100);
    expect(p.change).toBeCloseTo(0.5);
    expect(p.target?.[29]).toBe(3000);
    expect(p.target?.[0]).toBe(100);
    expect(p.previousTotal).toBeNull();
  });

  it("drops the target in TTC and reads TTC figures", () => {
    const p = paceSeries("2026-02", [d("2026-02-01", 10)], [], "ttc", 500);
    expect(p.days).toBe(28);
    expect(p.current[0]).toBe(20);
    expect(p.target).toBeNull();
    expect(p.change).toBeNull();
  });
});

describe("summaryText", () => {
  const fmt = { money: (n: number) => `${n} F`, pct: (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`) };

  it("prints the last bucket with its comparisons", () => {
    const b = bucket({ label: "nov. 2026", ht: 1000, partial: true, elapsedDays: 17, evolution: { ht: 0.1, ttc: 0.1 }, yearAgo: { ht: 800, ttc: 900 }, costedHt: 500, cost: 300, target: 2000 });
    expect(summaryText([b], "ht", fmt, "SUNLU")).toBe(
      ["CA nov. 2026 (en cours, 17 j) — SUNLU : 1000 F HT", "• vs période précédente (à date) : 10%", "• sur un an : 25% (800 F)", "• marge brute HT : 200 F (40 %)", "• objectif HT : 50 % de 2000 F"].join("\n")
    );
    expect(summaryText([], "ht", fmt)).toBe("");
  });

  it("skips the margin line when the server dropped cost and costedHt", () => {
    const b = bucket({ ht: 10 });
    delete b.cost;
    delete b.costedHt;
    expect(summaryText([b], "ht", fmt)).toBe("CA oct. 2026 : 10 F HT");
  });
});
