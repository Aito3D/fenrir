import { describe, expect, it } from "vitest";
import { evolutionFor, insightTiles, kpiTiles, unitsLabel, yearOverYear } from "@/components/revenue/lib/kpis";
import type { RevenueBucket } from "@/components/revenue/lib/types";
import { bucket as baseBucket } from "./fixtures";

// KPI suite defaults (non-zero figures), layered over the shared neutral builder.
const bucket = (over: Partial<RevenueBucket> = {}): RevenueBucket =>
  baseBucket({
    ht: 1200,
    ttc: 1392,
    quantity: 3,
    evolution: { ht: 0.1, ttc: 0.2 },
    yearAgo: { ht: 1000, ttc: 1160 },
    cumulative: { ht: 5000, ttc: 5800 },
    ...over,
  });

describe("yearOverYear", () => {
  it("is null without a year-ago figure", () => {
    expect(yearOverYear(bucket({ yearAgo: null }), "ht")).toBeNull();
  });
  it("is null (never Infinity) when the year-ago figure is zero", () => {
    expect(yearOverYear(bucket({ yearAgo: { ht: 0, ttc: 0 } }), "ht")).toBeNull();
  });
  it("computes 1200 against 1000 as 0.2", () => {
    expect(yearOverYear(bucket(), "ht")).toBeCloseTo(0.2);
  });
  it("reads the ttc fields in ttc mode", () => {
    expect(yearOverYear(bucket({ ttc: 2000, yearAgo: { ht: 1, ttc: 1000 } }), "ttc")).toBeCloseTo(1);
  });
});

describe("evolutionFor", () => {
  it("picks the evolution of the mode", () => {
    expect(evolutionFor(bucket(), "ht")).toBe(0.1);
    expect(evolutionFor(bucket(), "ttc")).toBe(0.2);
  });
});

describe("unitsLabel", () => {
  it("pluralises on abs(n) === 1", () => {
    expect(unitsLabel(1)).toBe("1 vendu");
    expect(unitsLabel(-1)).toBe("-1 vendu");
    expect(unitsLabel(2)).toBe("2 vendus");
    expect(unitsLabel(0)).toBe("0 vendus");
  });
});

describe("kpiTiles", () => {
  const prev = bucket({ key: "2026-09", label: "sept. 2026", ht: 900, ttc: 1044, quantity: 1 });
  const last = bucket();
  it("builds the five tiles for a month without selection", () => {
    const t = kpiTiles([prev, last], "ht", "month", 0, "Mois");
    expect(t.map((x) => x.label)).toEqual(["Mois en cours", "Mois précédent", "Évolution", "Sur un an", "Cumul"]);
    expect(t.map((x) => x.hint)).toEqual(["oct. 2026", "sept. 2026", "vs mois précédent", "il y a un an :", "sept. 2026 → oct. 2026"]);
    expect(t.map((x) => x.value)).toEqual([1200, 900, 0.1, expect.closeTo(0.2), 5000]);
    expect(t.map((x) => x.kind)).toEqual(["money", "money", "pct", "pct", "money"]);
    expect(t.map((x) => x.tone)).toEqual([undefined, undefined, "up", "up", undefined]);
    expect(t[3].hintAmount).toBe(1000);
  });
  it("appends units with a selection", () => {
    const t = kpiTiles([prev, last], "ht", "month", 2, "Mois");
    expect(t[0].hint).toBe("oct. 2026 · 3 vendus");
    expect(t[1].hint).toBe("sept. 2026 · 1 vendu");
    expect(t[4].hint).toBe("sept. 2026 → oct. 2026 · 4 vendus");
  });
  it("marks a partial ttc bucket as approximate and uses the ttc fields", () => {
    const t = kpiTiles([bucket({ partial: true, ttcApprox: true })], "ttc", "month", 0, "Mois");
    expect(t[0].hint).toBe("oct. 2026 · en cours · TTC ≈");
    expect(t[0].value).toBe(1392);
    expect(t[2].value).toBe(0.2);
    expect(kpiTiles([bucket({ partial: true, ttcApprox: true })], "ht", "month", 0, "Mois")[0].hint).toBe("oct. 2026 · en cours");
  });
  it("shows a dash for the previous period of a single bucket and no history without year-ago", () => {
    const t = kpiTiles([bucket({ yearAgo: null, evolution: { ht: -0.1, ttc: null } })], "ht", "month", 0, "Mois");
    expect(t[1].value).toBeNull();
    expect(t[1].hint).toBeUndefined();
    expect(t[2].tone).toBe("down");
    expect(t[3].value).toBeNull();
    expect(t[3].hint).toBe("pas d'historique");
    expect(t[3].tone).toBeUndefined();
  });
  it("falls back to the server's previous total when the window starts at the last bucket", () => {
    const t = kpiTiles([bucket({ key: "2026", label: "2026", start: "2026-01-01", end: "2026-12-31", previousTotal: { ht: 800, ttc: 928 } })], "ht", "year", 0, "Année");
    expect(t[1].value).toBe(800);
    expect(t[1].hint).toBe("2025");
  });
  it("labels the comparison ranges of a partial bucket", () => {
    const p = bucket({ partial: true, elapsedDays: 10 });
    const t = kpiTiles([p], "ht", "month", 0, "Mois");
    expect(t[2].hint).toBe("vs 1–10 sept. (à date)");
    expect(t[3].hint).toBe("1–10 oct. 2025 (à date) :");
  });
  it("returns nothing for no buckets", () => {
    expect(kpiTiles([], "ht", "month", 0, "Mois")).toEqual([]);
  });
});

describe("insightTiles", () => {
  it("is empty when no cost, no projection and no target exist", () => {
    expect(insightTiles([bucket()], "ht", "Mois")).toEqual([]);
    expect(insightTiles([], "ht", "Mois")).toEqual([]);
  });
  it("prints the margin over the costed lines, the projection and the target share", () => {
    const b = bucket({ ht: 1000, costedHt: 800, cost: 500, partial: true, projection: { ht: 2000, ttc: 2320 }, projectionMethod: "seasonal", target: 1600 });
    const t = insightTiles([b], "ttc", "Mois");
    expect(t.map((x) => x.label)).toEqual(["Marge brute HT", "Projection fin de mois", "Objectif atteint"]);
    expect(t[0]).toMatchObject({ value: 300, hint: "38 % · coût connu sur 80 % du CA", tone: "up" });
    expect(t[1]).toMatchObject({ value: 2320, hint: "au rythme de l'an dernier" });
    expect(t[2]).toMatchObject({ value: 0.625, kind: "share", hint: "projeté 125 % · objectif HT", hintAmount: 1600, tone: "up" });
  });
  it("a target with no projection tones on the share reached", () => {
    const t = insightTiles([bucket({ ht: 500, target: 1000 })], "ht", "Mois");
    expect(t[0]).toMatchObject({ label: "Objectif atteint", hint: "objectif HT", tone: "down" });
  });
});

describe("insightTiles services per machine hour", () => {
  it("adds the tile when the bucket has services and hours, and skips it without hours", () => {
    const t = insightTiles([bucket({ services: 4000, printHours: 8 })], "ht", "Mois");
    expect(t).toEqual([expect.objectContaining({ label: "Services / h machine", value: 500, hint: "8 h d'impression" })]);
    expect(insightTiles([bucket({ services: 4000, printHours: null })], "ht", "Mois")).toEqual([]);
  });
});

describe("insightTiles without cost fields", () => {
  it("a bucket without cost and costedHt yields no margin tile and does not crash", () => {
    const b = bucket({ cost: undefined, costedHt: undefined });
    expect(insightTiles([b], "ht", "Mois")).toEqual([]);
  });
});
