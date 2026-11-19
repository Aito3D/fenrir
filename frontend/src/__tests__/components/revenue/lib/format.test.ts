import { describe, expect, it } from "vitest";
import { compactAxis, formatFcp, formatPct } from "@/components/revenue/lib/format";

const NNBSP = " ";
const MINUS = "−";

describe("formatFcp", () => {
  it("prints FCP with dot-grouped thousands", () => {
    expect(formatFcp(0)).toBe("0 FCP");
    expect(formatFcp(1234567)).toBe("1.234.567 FCP");
    expect(formatFcp(999.6)).toBe("1.000 FCP");
  });
  it("prints a U+2212 minus for negatives", () => {
    expect(formatFcp(-1500)).toBe(`${MINUS}1.500 FCP`);
  });
});

describe("formatPct", () => {
  it("prints a dash for null", () => {
    expect(formatPct(null)).toBe("—");
  });
  it("prints one decimal below 100 %, signed only when positive", () => {
    expect(formatPct(0)).toBe("0.0 %");
    expect(formatPct(0.153)).toBe("+15.3 %");
    expect(formatPct(-0.5)).toBe("-50.0 %");
  });
  it("drops the decimal from 100 % up", () => {
    expect(formatPct(1.234)).toBe("+123 %");
    expect(formatPct(-1.5)).toBe("-150 %");
  });
  it("pins the rounding edges as they are", () => {
    expect(formatPct(0.99951)).toBe("+100.0 %");
    expect(formatPct(-0.0004)).toBe("-0.0 %");
  });
});

describe("compactAxis", () => {
  it("prints small values as whole numbers", () => {
    expect(compactAxis(0)).toBe("0");
    expect(compactAxis(500)).toBe("500");
  });
  it("prints thousands as rounded k", () => {
    expect(compactAxis(1500)).toBe(`2${NNBSP}k`);
  });
  it("prints millions with one decimal comma and a U+2212 minus", () => {
    expect(compactAxis(1_000_000)).toBe(`1,0${NNBSP}M`);
    expect(compactAxis(-2_500_000)).toBe(`${MINUS}2,5${NNBSP}M`);
    expect(compactAxis(-1500)).toBe(`${MINUS}2${NNBSP}k`);
  });
  it("pins the rounding edges as they are", () => {
    expect(compactAxis(999_600)).toBe(`1000${NNBSP}k`);
    expect(compactAxis(-0.4)).toBe(`${MINUS}0`);
  });
});
