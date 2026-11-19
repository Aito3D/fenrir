import { describe, expect, it } from "vitest";
import { calendarLayout } from "@/components/revenue/lib/insights";

describe("calendarLayout", () => {
  it("lays days in Monday-first weeks with padding and weekday means over fetched days", () => {
    // 2026-10-01 is a Thursday
    const days = [
      { day: "2026-10-01", ht: 100, ttc: 116, fetched: true },
      { day: "2026-10-02", ht: 0, ttc: 0, fetched: false },
      { day: "2026-10-05", ht: 50, ttc: 58, fetched: true },
      { day: "2026-10-08", ht: 300, ttc: 348, fetched: true },
    ];
    const c = calendarLayout(days);
    expect(c.weeks[0].slice(0, 4).map((d) => d?.day ?? null)).toEqual([null, null, null, "2026-10-01"]);
    expect(c.weekdayMean[3]).toEqual({ ht: 200, ttc: 232 });
    expect(c.weekdayMean[4]).toEqual({ ht: 0, ttc: 0 }); // the only Friday was not fetched
    expect(c.max.ht).toBe(300);
  });
});
