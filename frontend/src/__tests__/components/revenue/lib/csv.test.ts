import { describe, expect, it } from "vitest";
import { toCsv } from "@/components/revenue/lib/csv";
import { bucket } from "./fixtures";

const sept = bucket({ label: "sept. 2026", ht: 1000, ttc: 1160, goods: 1000, bySegment: { inconnu: 1000 }, cumulative: { ht: 1000, ttc: 1160 } });
const oct = bucket({
  label: "oct. 2026",
  ht: 1500,
  ttc: 1740,
  goods: 1500,
  bySegment: { inconnu: 1500 },
  evolution: { ht: 0.5, ttc: 0.5 },
  cumulative: { ht: 2500, ttc: 2900 },
  partial: true,
  elapsedDays: 15,
});

describe("toCsv", () => {
  it("writes the sheet's columns with a BOM, semicolons and plain numbers", () => {
    const csv = toCsv([sept, oct]);
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).split("\n");
    expect(lines[0]).toBe("Période;CA HT;CA TTC;Biens HT;Services HT;Pro HT;Particuliers HT;Passage HT;Non identifié HT;Marge HT;HT avec coût;Evol HT %;Cumul HT;Cumul TTC;Jours manquants;En cours;TTC approx");
    expect(lines[1]).toBe("sept. 2026;1000;1160;1000;0;0;0;0;1000;0;0;;1000;1160;0;;");
    expect(lines[2]).toBe("oct. 2026;1500;1740;1500;0;0;0;0;1500;0;0;50,0;2500;2900;0;15;");
  });

  it("flags an in-progress bucket with its elapsed days and an approximate TTC with oui (T-1501)", () => {
    const csv = toCsv([{ ...oct, partial: true, elapsedDays: 16, ttcApprox: true }, { ...oct, partial: false, elapsedDays: null, ttcApprox: false }]);
    const lines = csv.slice(1).split("\n");
    expect(lines[0].endsWith("Jours manquants;En cours;TTC approx")).toBe(true);
    expect(lines[1].endsWith(";16;oui")).toBe(true);
    expect(lines[2].endsWith(";;")).toBe(true);
  });
});
