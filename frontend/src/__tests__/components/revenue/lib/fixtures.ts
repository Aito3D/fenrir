import type { RevenueBucket } from "@/components/revenue/lib/types";

/** Neutral (zero / null / false) bucket builder shared by the revenue lib suites. */
export function bucket(over: Partial<RevenueBucket> = {}): RevenueBucket {
  return {
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
    bySegment: {},
    bySegmentTtc: {},
    cost: 0,
    costedHt: 0,
    projection: null,
    projectionMethod: null,
    quantity: 0,
    evolution: { ht: null, ttc: null },
    yearAgo: null,
    elapsedDays: null,
    cumulative: { ht: 0, ttc: 0 },
    partial: false,
    missingDays: 0,
    ttcApprox: false,
    ...over,
  };
}
