import type { Aito3mfFilament, Aito3mfObject, Aito3mfPlate } from '../api/client';
import type { PricingDefaults, PricingFilament, PricingPrinter } from './pricing';
import { computeImpressionCost, emptyTaskDraft, roundUpTo50 } from './taskDraft';
import type { TaskDraft } from './taskDraft';

/** The slices of the calculator rows the import needs; `CalculatorPrinter` and
 *  `CalculatorFilament` both satisfy them. */
export type ImportPrinter = PricingPrinter & { id: number; name: string };
export type ImportFilament = PricingFilament & { id: number; brand: string; material: string };

const TITLE_MAX = 200;
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The task note: one line per group of identical objects, e.g. "2 x marteau [120x30x50mm]". */
export function objectLines(objects: Aito3mfObject[]): string {
  return objects
    .map((o) => {
      const sized = o.x_mm !== null && o.y_mm !== null && o.z_mm !== null;
      return `${o.count} x ${o.name}${sized ? ` [${o.x_mm}x${o.y_mm}x${o.z_mm}mm]` : ''}`;
    })
    .join('\n');
}

/** The filament the task is priced with: the one the plate uses most of. */
export function mainFilament(plate: Aito3mfPlate): Aito3mfFilament | null {
  return plate.filaments.reduce<Aito3mfFilament | null>((best, f) => (best && best.used_g >= f.used_g ? best : f), null);
}

/** The one calculator printer named after the slicer's model ("X1C", "Bambu Lab X1C"), else
 *  null and the operator picks. Equality, not containment: a file sliced for an A1 must not
 *  silently take the rates of an "A1 mini". */
export function matchPrinter(model: string | null, printers: ImportPrinter[]): number | null {
  if (!model) return null;
  const hits = printers.filter((p) => same(p.name.replace(/^\s*bambu(\s+lab)?\s+/i, ''), model));
  return hits.length === 1 ? hits[0].id : null;
}

/** Material first, brand as the tie-break. `id` is null when the operator has to choose among `candidates`. */
export function matchFilament<F extends ImportFilament>(
  main: Aito3mfFilament | null,
  filaments: F[],
): { id: number | null; candidates: F[] } {
  const byMaterial = main ? filaments.filter((f) => same(f.material, main.type)) : [];
  if (byMaterial.length === 0) return { id: null, candidates: filaments };
  if (byMaterial.length === 1) return { id: byMaterial[0].id, candidates: byMaterial };
  const vendor = main?.vendor;
  const byBrand = vendor && !same(vendor, 'Generic') ? byMaterial.filter((f) => same(f.brand, vendor)) : [];
  return { id: byBrand.length === 1 ? byBrand[0].id : null, candidates: byMaterial };
}

export function plateTitle(
  plate: Aito3mfPlate,
  plateCount: number,
  filename: string,
  fallback: (n: number) => string,
): string {
  const title = plate.name ?? (plateCount === 1 ? filename.replace(/\.[^.]+$/, '') : fallback(plate.index));
  return title.slice(0, TITLE_MAX);
}

/** A plate the slicer produced something for. An empty plate has no time, weight or objects. */
export function isImportable(plate: Aito3mfPlate): boolean {
  return plate.print_time_seconds !== null && plate.weight_g !== null && plate.weight_g > 0 && plate.objects.length > 0;
}

/** One print-only task draft for a plate, priced exactly as `ImpressionFields` prices a typed one. */
export function plateToDraft(
  plate: Aito3mfPlate,
  title: string,
  printer: ImportPrinter,
  filament: ImportFilament,
  defaults: PricingDefaults,
): TaskDraft {
  const impression = {
    printerId: printer.id,
    filamentId: filament.id,
    weightG: plate.weight_g,
    timeMin: plate.print_time_seconds === null ? null : Math.ceil(plate.print_time_seconds / 60),
    quantity: 1,
    color: '',
  };
  const priced = computeImpressionCost(impression, filament, printer, defaults);
  return {
    ...emptyTaskDraft(),
    title,
    impression,
    impressionDescription: objectLines(plate.objects),
    impressionCost: priced ? roundUpTo50(priced.total_ttc) : null,
  };
}
