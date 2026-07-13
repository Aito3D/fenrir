// Bridges print archives and the pricing calculator: estimates a suggested
// sale price for a completed print from the calculator's configuration.
// Pure module — no React, no API calls (mirrors pricing.ts).

import { computePricing, type PricingDefaults, type PricingFilament, type PricingPrinter } from './pricing';

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

const containsEitherWay = (a: string, b: string): boolean => a.includes(b) || b.includes(a);

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
    defaults,
  );

  return {
    totalTtc: result.total_ttc,
    machineCost: result.machine_cost,
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
