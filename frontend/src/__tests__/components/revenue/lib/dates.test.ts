import { describe, expect, it } from "vitest";
import { addDays, allDays, daysBetween, daysInMonth, isValidDay, isoWeek } from "@/components/revenue/lib/dates";

describe("revenue-dates", () => {
  it("isValidDay accepts yyyy-MM-dd that round-trips and rejects everything else", () => {
    expect(isValidDay("2026-10-15")).toBe(true);
    expect(isValidDay("2024-02-29")).toBe(true);
    expect(isValidDay("2026-02-30")).toBe(false);
    expect(isValidDay("2026-1-5")).toBe(false);
    expect(isValidDay("15/10/2026")).toBe(false);
    expect(isValidDay("")).toBe(false);
  });

  it("addDays crosses months, years and leap days", () => {
    expect(addDays("2026-10-15", 1)).toBe("2026-10-16");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-10-15", -7)).toBe("2026-10-08");
  });

  it("allDays is inclusive and empty when from > to", () => {
    expect(allDays("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(allDays("2026-10-02", "2026-10-01")).toEqual([]);
    expect(allDays("2024-01-01", "2026-10-15")).toHaveLength(1019);
  });

  it("isoWeek follows ISO 8601 across year ends", () => {
    expect(isoWeek("2026-10-15")).toEqual({ year: 2026, week: 42 });
    expect(isoWeek("2024-01-01")).toEqual({ year: 2024, week: 1 }); // a Monday
    expect(isoWeek("2024-12-30")).toEqual({ year: 2025, week: 1 }); // Monday of ISO week 1 of 2025
    expect(isoWeek("2027-01-01")).toEqual({ year: 2026, week: 53 }); // 2026 has 53 ISO weeks
    expect(isoWeek("2025-12-28")).toEqual({ year: 2025, week: 52 });
  });

  it("daysInMonth handles leap years", () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it("daysBetween counts inclusive days", () => {
    expect(daysBetween("2024-01-01", "2026-10-15")).toBe(1019);
    expect(daysBetween("2026-10-15", "2026-10-15")).toBe(1);
  });

  it("daysBetween is 0 when from > to or either day is invalid", () => {
    expect(daysBetween("2026-10-16", "2026-10-15")).toBe(0);
    expect(daysBetween("nope", "2026-10-15")).toBe(0);
    expect(daysBetween("2026-10-15", "nope")).toBe(0);
    expect(daysBetween("", "")).toBe(0);
  });

  it("daysBetween equals allDays(...).length over month and year boundaries", () => {
    const ranges: [string, string][] = [
      ["2026-01-31", "2026-02-01"],
      ["2024-02-28", "2024-03-01"],
      ["2025-02-28", "2025-03-01"],
      ["2025-12-31", "2026-01-01"],
      ["2023-12-25", "2026-01-05"],
      ["2026-10-15", "2026-10-15"],
      ["2026-10-15", "2026-10-14"],
      ["2000-02-29", "2100-03-01"],
      ["2026-03-01", "2026-03-31"],
      ["2026-02-30", "2026-03-05"],
      ["bad", "2026-03-05"],
      ["2026-03-05", "bad"],
    ];
    for (const [from, to] of ranges) expect(daysBetween(from, to)).toBe(allDays(from, to).length);
  });
});
