// Shared SKU-level filament forecast computation, extracted from
// ForecastPanel so the Stats page can show the same numbers the Inventory
// forecast tab shows — one algorithm, two views. Pure module: no React.

import type { InventorySpool, SpoolUsageRecord, FilamentSkuSettings } from '../api/client';
import { parseUTCDate } from './date';
import { ownRecords, timeOf } from './usageHistory';

const Z_95 = 1.65;

export interface SkuGroup {
  key: string;
  material: string;
  subtype: string | null;
  brand: string | null;
  colorName: string | null;
  /** The SKU's stock: its spools that are not archived. */
  spools: InventorySpool[];
  /** Spools archived in the last ARCHIVED_RATE_WINDOW_DAYS: no stock, but what
   *  they were used for counts towards the rate (#3399). */
  usedUp: InventorySpool[];
  /** It has spools archived longer ago than that: it was in use before the
   *  rate's window, so the window is observed in full (#3407). */
  usedBefore: boolean;
}

// An archived spool counts towards its SKU's rate for this long after it was
// archived; older ones would stretch the estimate over years and dilute it.
// Same as stock_forecast.ARCHIVED_RATE_WINDOW_DAYS in the backend.
export const ARCHIVED_RATE_WINDOW_DAYS = 90;

export function archivedCounts(archivedAt: string, now: number): boolean {
  const at = parseUTCDate(archivedAt)?.getTime();
  return at !== undefined && !Number.isNaN(at) && now - at <= ARCHIVED_RATE_WINDOW_DAYS * 86400000;
}

export interface SkuForecast {
  group: SkuGroup;
  settings: FilamentSkuSettings | null;
  totalRemainingG: number;
  totalLabelG: number;
  totalSpools: number;
  totalUsedG: number;
  dailyRateG: number | null;
  dailyRateStdDev: number | null;
  rateTier: 'history' | 'delta' | 'none';
  effectiveLeadTimeDays: number;
  safetyStockG: number;
  reorderPointG: number;
  daysRemaining: number | null;
  daysUntilROP: number | null;
  projectedEmptyDate: Date | null;
  reorderTriggerDate: Date | null;
  reorderAlert: boolean;
  stockBreakAlert: boolean;
}

export function skuKey(material: string, subtype: string | null, brand: string | null, colorName: string | null) {
  return `${material}||${subtype ?? ''}||${brand ?? ''}||${colorName ?? ''}`;
}

/** A SKU's name for people. In Spoolman mode a filament with no colour name
 *  gets its subtype as one ("PLA Basic" named "Black"), which printed the word
 *  twice: "Bambu Lab PLA Basic Black Black" (#3400). The key keeps the colour. */
export function skuLabel(brand: string | null, material: string, subtype: string | null, colorName: string | null) {
  const sameAsSubtype = !!colorName && !!subtype && colorName.trim().toLowerCase() === subtype.trim().toLowerCase();
  return [brand, material, subtype, sameAsSubtype ? null : colorName].filter(Boolean).join(' ');
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + Math.round(days));
  return d;
}

/**
 * Compute a time-weighted daily consumption rate and standard deviation.
 *
 * Algorithm:
 *   1. Aggregate all usage events by calendar day (UTC date string), summing
 *      weight_used across all spools in the group that printed on that day.
 *      Day-bucketing fixes two problems: (a) concurrent prints from multiple
 *      spools in the same group no longer produce near-zero inter-event gaps
 *      that inflate per-interval rates; (b) the oldest event's weight is no
 *      longer silently dropped — it contributes to its day bucket.
 *   2. Sort day buckets oldest → newest and compute inter-day g/day rates.
 *      The gap is in whole days (minimum 1) so same-day reprints don't
 *      create a zero-duration interval.
 *   3. Apply exponential age-decay: each observation is weighted by
 *      exp(-λ * age_days) so recent prints dominate. λ = ln(2)/30 gives a
 *      30-day half-life — prints from a month ago count half as much.
 *   4. Compute the weighted mean and weighted variance → std dev.
 *
 * Returns null when there are fewer than 2 distinct days (no gap to measure)
 * — the delta-rate fallback handles that case.
 */
export function computeHistoryRate(records: SpoolUsageRecord[]): { rate: number; stdDev: number } | null {
  if (records.length < 2) return null;

  // Aggregate by UTC calendar day so concurrent multi-spool prints on the
  // same day are summed before rate computation.
  const byDay = new Map<string, number>();
  for (const r of records) {
    const day = r.created_at.slice(0, 10); // "YYYY-MM-DD" UTC — consistent with server timestamps
    byDay.set(day, (byDay.get(day) ?? 0) + r.weight_used);
  }

  if (byDay.size < 2) return null;

  const days = [...byDay.entries()]
    .map(([day, totalG]) => ({ ms: new Date(day).getTime(), totalG }))
    .sort((a, b) => a.ms - b.ms);

  const now = Date.now();
  // λ for 30-day half-life: ln(2)/30
  const lambda = Math.LN2 / 30;

  const observations: { rate: number; weight: number }[] = [];

  for (let i = 1; i < days.length; i++) {
    const elapsedDays = Math.max((days[i].ms - days[i - 1].ms) / 86400000, 1);
    const ageDays = (now - days[i].ms) / 86400000;

    // g/day for this inter-day interval: weight printed on day[i] / gap to previous day
    const intervalRate = days[i].totalG / elapsedDays;
    const w = Math.exp(-lambda * ageDays);

    observations.push({ rate: intervalRate, weight: w });
  }

  const totalW = observations.reduce((s, o) => s + o.weight, 0);
  if (totalW === 0) return null;

  const mean = observations.reduce((s, o) => s + o.rate * o.weight, 0) / totalW;
  const variance = observations.reduce((s, o) => s + o.weight * (o.rate - mean) ** 2, 0) / totalW;

  return { rate: mean, stdDev: Math.sqrt(variance) };
}

// The rate when there is not enough usage history (#3407). A spool's total is
// all there is, so it is spread evenly over the time the spool was in use: from
// its first use (Spoolman's first_used, else its earliest usage record, else
// its creation) to its last (else its archiving, else now). What falls inside
// the last ARCHIVED_RATE_WINDOW_DAYS is divided by the days of that window,
// which starts no earlier than the SKU's first use (all of it, when the SKU
// has spools archived before the window), so shelf time is not use
// and the grams and the days cover the same span. Same as
// stock_forecast.delta_rate in the backend.
export function computeDeltaRate(
  spools: InventorySpool[],
  firstUse: Map<number, number>,
  usedBefore: boolean,
  now: number,
): number | null {
  const spans: { consumed: number; start: number; end: number }[] = [];
  for (const sp of spools) {
    // Use weight_used - baseline so "Reset usage to 0" on the Inventory page
    // makes forecast restart from zero rather than carrying stale lifetime
    // consumption across the reset (#1390).
    const consumed = Math.max(0, sp.weight_used - (sp.weight_used_baseline ?? 0));
    if (consumed <= 0) continue;
    const endAt = timeOf(sp.last_used) ?? timeOf(sp.archived_at);
    const end = endAt === null ? now : Math.min(endAt, now);
    const startAt = timeOf(sp.first_used) ?? firstUse.get(sp.id) ?? timeOf(sp.created_at);
    const start = startAt === null ? end : Math.min(startAt, end);
    spans.push({ consumed, start, end });
  }
  if (spans.length === 0) return null;

  const windowStart = now - ARCHIVED_RATE_WINDOW_DAYS * 86400000;
  const observedFrom = usedBefore ? windowStart : Math.max(windowStart, Math.min(...spans.map(s => s.start)));
  const days = (now - observedFrom) / 86400000;
  if (days < 1) return null;
  let grams = 0;
  for (const { consumed, start, end } of spans) {
    const length = end - start;
    if (length < 86400000) {
      // Used up within a day: all of it at its end.
      if (end >= observedFrom) grams += consumed;
      continue;
    }
    const inside = end - Math.max(start, observedFrom);
    if (inside > 0) grams += (consumed * inside) / length;
  }
  return grams / days;
}

/** Group spools into SKUs: the active (non-archived) ones are the stock, the
 *  recently archived ones count towards the rate (#3399), and older used ones
 *  say the SKU was in use before the rate's window (#3407). */
export function groupSpoolsBySku(spools: InventorySpool[], now: number = Date.now()): SkuGroup[] {
  const map = new Map<string, SkuGroup>();
  for (const spool of spools) {
    if (spool.archived_at) continue;
    const key = skuKey(spool.material, spool.subtype, spool.brand, spool.color_name);
    const g = map.get(key) ?? {
      key,
      material: spool.material,
      subtype: spool.subtype,
      brand: spool.brand,
      colorName: spool.color_name,
      spools: [],
      usedUp: [],
      usedBefore: false,
    };
    g.spools.push(spool);
    map.set(key, g);
  }
  // Used-up spools are archived. They are not stock, and a SKU with nothing
  // left is not forecast, but leaving out what they took makes a SKU in weekly
  // use look untouched (#3399).
  for (const spool of spools) {
    if (!spool.archived_at) continue;
    const group = map.get(skuKey(spool.material, spool.subtype, spool.brand, spool.color_name));
    if (!group) continue;
    if (archivedCounts(spool.archived_at, now)) group.usedUp.push(spool);
    // Only a spool that was used says the SKU was in use before the window.
    else if (spool.weight_used > 0) group.usedBefore = true;
  }
  return [...map.values()];
}

/** Per-SKU forecast: consumption rate, reorder point, days remaining, alerts.
 *  In Spoolman mode the usage rows are keyed by Spoolman id, and a spool only
 *  owns the rows from after it was created (#3407). */
export function computeSkuForecasts(
  groups: SkuGroup[],
  skuSettingsList: FilamentSkuSettings[],
  usageHistory: SpoolUsageRecord[],
  globalLeadTime: number,
  spoolmanMode = false,
): SkuForecast[] {
  const settingsMap = new Map<string, FilamentSkuSettings>();
  for (const s of skuSettingsList) settingsMap.set(skuKey(s.material, s.subtype, s.brand, s.color_name), s);

  const usageBySpoolId = new Map<number, SpoolUsageRecord[]>();
  for (const r of usageHistory) {
    const spoolId = spoolmanMode ? r.spoolman_spool_id : r.spool_id;
    // Usage of a deleted spool belongs to no spool here.
    if (spoolId === null || spoolId === undefined) continue;
    const arr = usageBySpoolId.get(spoolId) ?? [];
    arr.push(r);
    usageBySpoolId.set(spoolId, arr);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const now = Date.now();

  return groups.map((group): SkuForecast => {
    // Fall back to the NULL-colour row that pre-upgrade users have so their
    // lead-time / safety-margin overrides survive the first load after the
    // color_name column is added (#forecast-color-grouping migration).
    const skuSettings =
      settingsMap.get(group.key) ??
      (group.colorName !== null ? settingsMap.get(skuKey(group.material, group.subtype, group.brand, null)) ?? null : null);
    const skuLeadTime = skuSettings?.lead_time_days ?? 0;
    const effectiveLeadTimeDays = Math.max(globalLeadTime, skuLeadTime);
    const marginValue = skuSettings?.safety_margin_value ?? 14;
    const marginUnit = skuSettings?.safety_margin_unit ?? 'days';

    const totalRemainingG = group.spools.reduce((s, sp) => s + Math.max(0, sp.label_weight - sp.weight_used), 0);
    const totalLabelG = group.spools.reduce((s, sp) => s + sp.label_weight, 0);
    const rateSpools = [...group.spools, ...(group.usedUp ?? [])];
    // Consumed since baseline (post-reset); see InventoryPage stats calc (#1390).
    // Used-up spools included: it ranks the most-used SKUs.
    const totalUsedG = rateSpools.reduce((s, sp) => s + Math.max(0, sp.weight_used - (sp.weight_used_baseline ?? 0)), 0);

    // Only include history from spools that haven't been reset — pre-reset
    // events on a reset spool have no anchor timestamp so they'd inflate the
    // rate. Spools without a baseline are clean and keep their records.
    // Spoolman hands deleted spools' ids on; built-in ids are never reused.
    const own = new Map(
      rateSpools.map(s => {
        const records = usageBySpoolId.get(s.id) ?? [];
        return [s.id, spoolmanMode ? ownRecords(s, records) : records] as const;
      }),
    );
    const groupHistory: SpoolUsageRecord[] = [];
    for (const s of rateSpools) {
      if ((s.weight_used_baseline ?? 0) === 0) {
        groupHistory.push(...(own.get(s.id) ?? []));
      }
    }

    let dailyRateG: number | null = null;
    let dailyRateStdDev: number | null = null;
    let rateTier: SkuForecast['rateTier'] = 'none';

    const histResult = computeHistoryRate(groupHistory);
    if (histResult !== null) {
      dailyRateG = histResult.rate;
      dailyRateStdDev = histResult.stdDev;
      rateTier = 'history';
    } else {
      // A spool's first use is its earliest record, kept or not: a reset
      // drops records from the rate, not from when use began.
      const firstUse = new Map<number, number>();
      for (const s of rateSpools) {
        for (const r of own.get(s.id) ?? []) {
          const at = timeOf(r.created_at);
          if (at !== null && at < (firstUse.get(s.id) ?? Infinity)) firstUse.set(s.id, at);
        }
      }
      const delta = computeDeltaRate(rateSpools, firstUse, group.usedBefore ?? false, now);
      if (delta !== null) { dailyRateG = delta; rateTier = 'delta'; }
    }

    const sigma = dailyRateStdDev ?? (dailyRateG !== null ? dailyRateG * 0.2 : 0);
    const statisticalSafetyStockG = Z_95 * sigma * Math.sqrt(effectiveLeadTimeDays);
    // safety margin: user-defined buffer on top of statistical safety stock
    const safetyMarginG = marginUnit === 'g'
      ? marginValue
      : (dailyRateG !== null ? dailyRateG * marginValue : marginValue * 5);
    const safetyStockG = statisticalSafetyStockG + safetyMarginG;
    const reorderPointG = dailyRateG !== null
      ? dailyRateG * effectiveLeadTimeDays + safetyStockG
      : 0;

    const daysRemaining = dailyRateG && dailyRateG > 0 ? Math.floor(totalRemainingG / dailyRateG) : null;
    const projectedEmptyDate = daysRemaining !== null ? addDays(today, daysRemaining) : null;

    const daysUntilROP = dailyRateG && dailyRateG > 0
      ? Math.floor((totalRemainingG - reorderPointG) / dailyRateG)
      : null;

    const reorderTriggerDate = daysUntilROP !== null ? addDays(today, Math.max(0, daysUntilROP)) : null;
    const stockBreakAlert = daysRemaining !== null && effectiveLeadTimeDays > 0 && daysRemaining <= effectiveLeadTimeDays;
    const reorderAlert = !stockBreakAlert && daysUntilROP !== null && daysUntilROP <= 0;

    return {
      group, settings: skuSettings,
      totalRemainingG, totalLabelG, totalSpools: group.spools.length, totalUsedG,
      dailyRateG, dailyRateStdDev,
      rateTier,
      effectiveLeadTimeDays, safetyStockG, reorderPointG,
      daysRemaining, daysUntilROP,
      projectedEmptyDate, reorderTriggerDate,
      reorderAlert, stockBreakAlert,
    };
  });
}
