// Bridges print archives and the pricing calculator: estimates a suggested
// sale price for a completed print from the calculator's configuration.
// Pure module — no React, no API calls (mirrors pricing.ts).

import {
  computePricing,
  filamentLineCost,
  type PricingDefaults,
  type PricingFilament,
  type PricingPrinter,
} from './pricing';

export interface NamedCalculatorFilament extends PricingFilament {
  id: number;
  name: string;
  /** Material of the filament profile (e.g. "PLA"); preferred for matching
   *  when present. Older callers may only have the display name. */
  material?: string;
  /** Brand of the filament profile (e.g. "SUNLU"); when the archive knows the
   *  vendor it was sliced with, a brand+material match beats cheapest-material. */
  brand?: string;
}

export interface NamedCalculatorPrinter extends PricingPrinter {
  id: number;
  name: string;
}

export interface ArchivePricingSource {
  filament_used_grams: number | null;
  print_time_seconds: number | null;
  actual_time_seconds?: number | null;
  filament_type: string | null;
  /** Brand(s) the file was sliced with (e.g. "SUNLU"), comma-separated for
   *  multi-material jobs; null/absent on pre-existing or MQTT-only archives. */
  filament_vendor?: string | null;
  /** Measured energy for the job in kWh; when present and > 0 it replaces the
   *  watts × hours estimate in the pricing. */
  energy_kwh?: number | null;
}

export interface ArchivePriceEstimate {
  totalTtc: number;
  /** Machine cost (filament + depreciation + energy + repairs), no provisions/labor. */
  machineCost: number;
  /** Filament cost line (grams × sale price × difficulty × markup). */
  filamentCost: number;
  /** Energy cost line (time × printer watts × tariff × difficulty). */
  energyCost: number;
  filamentId: number;
  filamentName: string;
  /** False when no calculator filament matched the archive's filament type
   *  and the first filament was used as a fallback. */
  filamentMatched: boolean;
  printerId: number;
  printerName: string;
  /** False when no calculator printer matched the archive's printer and the
   *  first printer profile was used as a fallback. */
  printerMatched: boolean;
  weightG: number;
  timeH: number;
  /** Full unit cost the size margin was evaluated at (computePricing total_cost). */
  unitCost: number;
  /** Size-margin multiplier applied (sizeMargin(unitCost)); the quantity factor is 1 for archives. */
  sizeMargin: number;
  /** True when min_task_price lifted the price above the curve. */
  floorApplied: boolean;
}

export const containsEitherWay = (a: string, b: string): boolean => a.includes(b) || b.includes(a);

const cheapest = (candidates: NamedCalculatorFilament[]): NamedCalculatorFilament | undefined =>
  candidates.reduce<NamedCalculatorFilament | undefined>(
    (best, f) => (!best || f.cost_per_kg < best.cost_per_kg ? f : best),
    undefined,
  );

/** Vendor hints worth brand-matching on: split a comma-joined vendor string
 *  and drop empties and "Generic" entries (a generic preset names no real
 *  brand, so it must fall back to the cheapest-material match). */
const vendorHints = (vendor: string | null | undefined): string[] =>
  (vendor ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v.length > 0 && !v.startsWith('generic'));

/** The materials of a print, in slot order. A multi-material job reports them
 *  comma-joined ("PA-CF, ASA"); each is matched on its own so a two-colour
 *  print is priced from its first material rather than from whichever of the
 *  two happens to be cheapest. */
const materialSegments = (filamentType: string | null | undefined): string[] =>
  (filamentType ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const materialTokens = (label: string): string[] =>
  label
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);

/** "PA6-CF" and "pa6 cf" both canonicalise to "pa6-cf". */
const canonicalMaterial = (label: string): string => materialTokens(label).join('-');

/** Tokens denoting a reinforcement filler (carbon / glass / aramid fibre).
 *  A filler changes both the material and its price by a large factor, so two
 *  labels may only be treated as the same filament when their filler sets are
 *  identical: "PA" must never absorb "PA-CF", nor "ABS" absorb "ABS-GF". */
const FILLER_TOKEN = /^(?:cf|gf|af|kf)\d*$/;

const fillerSet = (label: string): string[] =>
  [...new Set(materialTokens(label).filter((t) => FILLER_TOKEN.test(t)))].sort();

const sameReinforcement = (a: string, b: string): boolean => {
  const fa = fillerSet(a);
  const fb = fillerSet(b);
  return fa.length === fb.length && fa.every((f, i) => f === fb[i]);
};

/** The base polymer with its grade number dropped: "pa6" and "pa12" both
 *  reduce to "pa". Only a trailing number goes, so "pet" and "petg" — and
 *  "pa" and "paht" — stay distinct families. */
const polymerFamily = (label: string): string => (materialTokens(label)[0] ?? '').replace(/\d+$/, '');

/** Same polymer family and the same reinforcement, e.g. "PA-CF" ↔ "PA12-CF". */
const sameFamily = (a: string, b: string): boolean => {
  const family = polymerFamily(a);
  return family.length > 0 && family === polymerFamily(b) && sameReinforcement(a, b);
};

/** Material labels a slicer emits verbatim in `filament_type`. A profile whose
 *  material is one of these names a material the slicer can report itself, so
 *  it is NOT what an ambiguous gradeless label means: a print made of PA6-CF
 *  would have said "PA6-CF", therefore "PA-CF" is the custom PA12-CF profile.
 *  Consulted only to rank family candidates — when every candidate is a slicer
 *  label ("PA-GF" with only a "PA6-GF" profile on file) they all stay in play. */
const SLICER_MATERIAL_LABELS = new Set([
  'pla', 'pla-cf', 'pla-gf', 'pla-aero', 'pla-s',
  'petg', 'petg-cf', 'petg-gf', 'pet', 'pet-cf',
  'abs', 'abs-cf', 'abs-gf',
  'asa', 'asa-cf', 'asa-gf', 'asa-aero',
  'pc', 'pc-cf', 'pc-fr',
  'pa', 'pa-cf', 'pa-gf', 'pa6-cf', 'pa6-gf', 'paht-cf',
  'ppa-cf', 'ppa-gf', 'pps', 'pps-cf',
  'pe', 'pe-cf', 'pp', 'pp-cf', 'pp-gf',
  'eva', 'pha', 'hips', 'pva', 'bvoh', 'sbs',
  'tpu', 'tpu-ams',
]);

/** Pick one filament out of a ranked group: a profile whose brand matches one
 *  of the print's vendors wins (vendors are tried in slot order), otherwise
 *  the cheapest of the group. */
const pickFromTier = (
  tier: NamedCalculatorFilament[],
  hints: string[],
): NamedCalculatorFilament | undefined => {
  if (tier.length === 0) return undefined;
  for (const hint of hints) {
    const brandMatch = cheapest(tier.filter((f) => !!f.brand && containsEitherWay(f.brand.toLowerCase(), hint)));
    if (brandMatch) return brandMatch;
  }
  return cheapest(tier);
};

/** Match an archive's filament type (e.g. "PA-CF") against the calculator's
 *  filaments, most specific reading first:
 *
 *    1. the same material exactly ("PA6-CF" → PA6-CF);
 *    2. the same polymer family and reinforcement, preferring a profile the
 *       slicer could not have named itself ("PA-CF" → PA12-CF, not PA6-CF);
 *    3. the same family and reinforcement, any profile ("PA-GF" → PA6-GF);
 *    4. legacy display-name containment, for profiles saved before brand and
 *       material were separate fields.
 *
 *  Reinforcement is never crossed at any tier, so "PA" cannot be priced as
 *  PA-CF and "ABS" cannot be priced as ABS-GF. Within a tier the print's
 *  vendor decides ("SUNLU PLA" over the cheapest PLA), then the lowest cost.
 *  A multi-material print is matched on its first material that resolves.
 *  Falls back to the first filament with matched=false — callers must treat
 *  that as "unknown", not as a price. */
export function matchCalculatorFilament(
  filamentType: string | null | undefined,
  filaments: NamedCalculatorFilament[],
  filamentVendor?: string | null,
): { filament: NamedCalculatorFilament; matched: boolean } | null {
  if (filaments.length === 0) return null;
  const hints = vendorHints(filamentVendor);
  const withMaterial = filaments.filter((f) => !!f.material);

  for (const segment of materialSegments(filamentType)) {
    const canonical = canonicalMaterial(segment);
    const familyMatches = withMaterial.filter((f) => sameFamily(f.material!, segment));
    const tiers: NamedCalculatorFilament[][] = [
      withMaterial.filter((f) => canonicalMaterial(f.material!) === canonical),
      familyMatches.filter((f) => !SLICER_MATERIAL_LABELS.has(canonicalMaterial(f.material!))),
      familyMatches,
      filaments.filter(
        (f) =>
          containsEitherWay(f.name.toLowerCase(), segment.toLowerCase()) && sameReinforcement(f.name, segment),
      ),
    ];
    for (const tier of tiers) {
      const hit = pickFromTier(tier, hints);
      if (hit) return { filament: hit, matched: true };
    }
  }
  return { filament: filaments[0], matched: false };
}

/** Match an archive's printer against the calculator's printer profiles by
 *  case-insensitive containment in either direction, trying each hint in
 *  order (typically the Bambuddy printer name, then the model the file was
 *  sliced for). Falls back to the first profile with matched=false. */
export function matchCalculatorPrinter(
  hints: Array<string | null | undefined>,
  printers: NamedCalculatorPrinter[],
): { printer: NamedCalculatorPrinter; matched: boolean } | null {
  if (printers.length === 0) return null;
  for (const hint of hints) {
    const h = hint?.trim().toLowerCase();
    if (!h) continue;
    const match = printers.find((p) => containsEitherWay(p.name.toLowerCase(), h));
    if (match) return { printer: match, matched: true };
  }
  return { printer: printers[0], matched: false };
}

/** The calculator's filament line only — grams × sale price × difficulty ×
 *  filament markup — for a print, with no printer/energy/margin components.
 *  Used by the Statistics "Filament Cost" tile. Returns null when the
 *  calculator configuration or the print's weight is missing so callers can
 *  fall back to the stored spool-based cost. */
export function estimateFilamentCost(
  source: { filament_used_grams: number | null; filament_type: string | null; filament_vendor?: string | null },
  filaments: NamedCalculatorFilament[],
  defaults: PricingDefaults | undefined,
): number | null {
  if (!defaults) return null;
  const weightG = source.filament_used_grams ?? 0;
  if (weightG <= 0) return null;
  const matched = matchCalculatorFilament(source.filament_type, filaments, source.filament_vendor);
  if (!matched) return null;
  return filamentLineCost(weightG, matched.filament, defaults);
}

/** Suggested sale price for an archived print: the calculator's machine-cost
 *  pricing (total TTC) with all labor inputs at zero, treating the whole job
 *  as one unit since filament_used_grams covers the entire job. Returns null
 *  when the archive or the calculator configuration lacks the required data. */
export function estimateArchiveSalePrice(
  archive: ArchivePricingSource,
  filaments: NamedCalculatorFilament[],
  printers: NamedCalculatorPrinter[],
  defaults: PricingDefaults | undefined,
  printerHints: Array<string | null | undefined> = [],
): ArchivePriceEstimate | null {
  if (!defaults || printers.length === 0) return null;
  const weightG = archive.filament_used_grams ?? 0;
  const timeH = (archive.actual_time_seconds || archive.print_time_seconds || 0) / 3600;
  if (weightG <= 0 || timeH <= 0) return null;

  const matched = matchCalculatorFilament(archive.filament_type, filaments, archive.filament_vendor);
  if (!matched) return null;
  const { printer, matched: printerMatched } = matchCalculatorPrinter(printerHints, printers)!;

  const result = computePricing(
    {
      weight_g: weightG,
      printing_time_h: timeH,
      measured_energy_kwh: archive.energy_kwh && archive.energy_kwh > 0 ? archive.energy_kwh : undefined,
      quantity: 1,
      modeling_hours: 0,
      modeling_base_price: 0,
      prep_model_min: 0,
      prep_slicing_min: 0,
      prep_transfer_min: 0,
      post_removal_min: 0,
      post_support_min: 0,
      post_additional_min: 0,
      post_fulfillment_min: 0,
      stuff_amount: 0,
      stuff_markup_pct: 0,
    },
    matched.filament,
    printer,
    // Archive estimates are machine-cost pricing — the per-job base fee
    // (quotation time) doesn't belong in an after-the-fact suggestion.
    { ...defaults, base_fee_flat: 0 },
  );

  return {
    totalTtc: result.total_ttc,
    machineCost: result.machine_cost,
    filamentCost: result.filament_cost,
    energyCost: result.energy_cost,
    unitCost: result.total_cost,
    sizeMargin: result.size_margin,
    floorApplied: result.floor_applied,
    filamentId: matched.filament.id,
    filamentName: matched.filament.name,
    filamentMatched: matched.matched,
    printerId: printer.id,
    printerName: printer.name,
    printerMatched,
    weightG,
    timeH,
  };
}

/** Calculator configuration loaded once at page level; null when the user
 *  lacks calculator access or the calculator isn't configured yet. */
export interface CalcConfig {
  filaments: NamedCalculatorFilament[];
  printers: NamedCalculatorPrinter[];
  defaults: PricingDefaults;
}

/** Query-param URL that opens the calculator prefilled from a finished print or
 *  a library file. Only passes filamentId/printerId when a real name-match was
 *  found — a fallback pick shouldn't silently override the user's saved choice.
 *  `printerHints` are tried in order by the printer matcher; callers pass what
 *  they have (an archive knows its printer, a library file only its
 *  sliced_for_model). */
export function calculatorPrefillUrl(
  source: ArchivePricingSource,
  calcConfig: CalcConfig | null,
  printerHints: Array<string | null | undefined> = [],
): string {
  const timeH = (source.actual_time_seconds || source.print_time_seconds || 0) / 3600;
  const params = new URLSearchParams({
    weight: (source.filament_used_grams ?? 0).toFixed(1),
    time: timeH.toFixed(2),
    quantity: '1',
    // Slicer estimates can be corrected by the calculator's time-accuracy
    // chip; measured durations need no correction.
    timeSource: source.actual_time_seconds ? 'actual' : 'est',
  });
  // Real measured energy beats the calculator's watts × hours estimate.
  if (source.energy_kwh != null && source.energy_kwh > 0) {
    params.set('energyKwh', String(source.energy_kwh));
  }
  const estimate = calcConfig
    ? estimateArchiveSalePrice(source, calcConfig.filaments, calcConfig.printers, calcConfig.defaults, printerHints)
    : null;
  if (estimate?.filamentMatched) params.set('filamentId', String(estimate.filamentId));
  if (estimate?.printerMatched) params.set('printerId', String(estimate.printerId));
  return `/calculator?${params.toString()}`;
}

/** A print-log row with just what the median needs (ArchiveSlim satisfies it). */
export interface UnitCostSample extends ArchivePricingSource {
  status: string;
  printer_id: number | null;
  completed_at?: string | null;
}

export const MEDIAN_MIN_SAMPLES = 5;
export const MEDIAN_MAX_SAMPLES = 100;

/** Median unit cost (computePricing total_cost, quantity 1) of the most
 *  recent completed prints, priced the way the archive card prices them.
 *  Feeds the "K from your own prints" hint. Null when fewer than
 *  MEDIAN_MIN_SAMPLES rows are usable. Pure so a backend endpoint can
 *  replace it one day without touching the caller. */
export function medianUnitCost(
  rows: UnitCostSample[],
  calcConfig: CalcConfig,
  printerNameById: Map<number, string>,
): { median: number; count: number } | null {
  const costs = rows
    .filter((r) => r.status === 'completed')
    .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''))
    .slice(0, MEDIAN_MAX_SAMPLES)
    .map((r) =>
      estimateArchiveSalePrice(r, calcConfig.filaments, calcConfig.printers, calcConfig.defaults, [
        r.printer_id != null ? printerNameById.get(r.printer_id) : null,
      ])?.unitCost,
    )
    .filter((c): c is number => typeof c === 'number' && Number.isFinite(c))
    .sort((a, b) => a - b);
  if (costs.length < MEDIAN_MIN_SAMPLES) return null;
  const mid = Math.floor(costs.length / 2);
  const median = costs.length % 2 ? costs[mid] : (costs[mid - 1] + costs[mid]) / 2;
  return { median, count: costs.length };
}
