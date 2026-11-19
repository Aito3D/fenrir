import { describe, expect, it } from "vitest";
import { controlsFromSearch, controlsToSearch } from "@/components/revenue/lib/url";

const defaults = {
  granularity: "month" as const,
  taxMode: "ht" as const,
  stack: "nature" as const,
  range: { preset: "default" as const },
  kind: null,
  segment: null,
  view: "evolution" as const,
  brands: [] as string[],
  items: [] as string[],
};

describe("revenue URL state", () => {
  it("is empty at the defaults", () => {
    expect(controlsToSearch(defaults)).toBe("");
    expect(controlsFromSearch("")).toEqual({});
  });

  it("round-trips every control", () => {
    const state = {
      ...defaults,
      granularity: "week" as const,
      taxMode: "ttc" as const,
      stack: "segment" as const,
      range: { preset: "custom" as const, from: "2026-01-01", to: "2026-06-30" },
      kind: "services" as const,
      segment: "pro" as const,
      view: "clients" as const,
      brands: ["bambu lab", "esun"],
      items: ["123", "456"],
    };
    const q = controlsToSearch(state);
    expect(q).toBe("?g=week&tax=ttc&stack=segment&from=2026-01-01&to=2026-06-30&kind=services&segment=pro&view=clients&brand=bambu+lab&brand=esun&items=123,456");
    expect(controlsFromSearch(q)).toEqual({
      granularity: "week",
      taxMode: "ttc",
      stack: "segment",
      range: state.range,
      kind: "services",
      segment: "pro",
      view: "clients",
      brands: ["bambu lab", "esun"],
      items: ["123", "456"],
    });
    expect(controlsFromSearch(controlsToSearch({ ...defaults, range: { preset: "all" } }))).toEqual({ range: { preset: "all" } });
  });

  it("drops anything that does not validate", () => {
    expect(controlsFromSearch("?g=decade&tax=gross&stack=zzz&from=2026-13-01&to=2026-01-01&preset=never&kind=x&segment=vip&view=nope&items=bad%20id")).toEqual({});
    expect(controlsFromSearch("?from=2026-06-01&to=2026-01-01&preset=this-year")).toEqual({ range: { preset: "this-year" } });
  });
});
