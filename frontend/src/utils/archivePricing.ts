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
}

export const containsEitherWay = (a: string, b: string): boolean => a.includes(b) || b.includes(a);

const cheapest = (candidates: NamedCalculatorFilament[]): NamedCalculatorFilament | undefined =>
  candidates.reduce<NamedCalculatorFilament | undefined>(
    (best, f) => (!best || f.cost_per_kg < best.cost_per_kg ? f : best),
    undefined,
  );

/** Match an archive's filament type (e.g. "PLA") against the calculator's
 *  filaments by case-insensitive containment in either direction — first on
 *  the profile's material, then on its display name. When several profiles
 *  match (e.g. Bambu Lab ASA and SUNLU ASA), the cheapest cost_per_kg wins.
 *  Falls back to the first filament with matched=false. */
export function matchCalculatorFilament(
  filamentType: string | null | undefined,
  filaments: NamedCalculatorFilament[],
): { filament: NamedCalculatorFilament; matched: boolean } | null {
  if (filaments.length === 0) return null;
  const type = filamentType?.trim().toLowerCase();
  if (type) {
    const match =
      cheapest(filaments.filter((f) => !!f.material && containsEitherWay(f.material.toLowerCase(), type))) ??
      cheapest(filaments.filter((f) => containsEitherWay(f.name.toLowerCase(), type)));
    if (match) return { filament: match, matched: true };
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
  source: { filament_used_grams: number | null; filament_type: string | null },
  filaments: NamedCalculatorFilament[],
  defaults: PricingDefaults | undefined,
): number | null {
  if (!defaults) return null;
  const weightG = source.filament_used_grams ?? 0;
  if (weightG <= 0) return null;
  const matched = matchCalculatorFilament(source.filament_type, filaments);
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

  const matched = matchCalculatorFilament(archive.filament_type, filaments);
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
