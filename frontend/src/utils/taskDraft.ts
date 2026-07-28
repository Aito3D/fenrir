import { computePricing } from './pricing';
import type { PricingDefaults, PricingFilament, PricingPrinter, PricingResult } from './pricing';

export interface ImpressionDraft {
  printerId: number | null;
  filamentId: number | null;
  weightG: number | null;
  timeMin: number | null;
  quantity: number;
  color: string;
}

/** One task of a project. `id` is null until the row exists server-side, which
 *  is what lets the same editor serve the create modal (drafts) and the detail
 *  panel (persisted rows). */
export interface TaskDraft {
  id: number | null;
  title: string;
  description: string;
  /** null = the service is disabled. 0 stays meaningful as "free". */
  scanCost: number | null;
  modelisationCost: number | null;
  usinageCost: number | null;
  impression: ImpressionDraft;
  /** Frozen total for a saved task; recomputed while the task is being edited. */
  impressionCost: number | null;
}

export function emptyTaskDraft(): TaskDraft {
  return {
    id: null,
    title: '',
    description: '',
    scanCost: null,
    modelisationCost: null,
    usinageCost: null,
    impression: { printerId: null, filamentId: null, weightG: null, timeMin: null, quantity: 1, color: '' },
    impressionCost: null,
  };
}

export function splitMinutes(total: number): { days: number; hours: number; minutes: number } {
  const t = Math.max(0, Math.floor(total || 0));
  return { days: Math.floor(t / 1440), hours: Math.floor((t % 1440) / 60), minutes: t % 60 };
}

export function joinMinutes(parts: { days: number; hours: number; minutes: number }): number {
  return Math.max(0, Math.floor(parts.days || 0)) * 1440
    + Math.max(0, Math.floor(parts.hours || 0)) * 60
    + Math.max(0, Math.floor(parts.minutes || 0));
}

/** Impression3D's cost, through the same engine the calculator page uses.
 *
 *  Two departures from a calculator quote, both deliberate:
 *  - The per-job flats (`base_fee_flat`, `consumables_packaging_flat`) are
 *    zeroed. The engine treats them as one-time per JOB; a project is the job,
 *    so a project with three print tasks would otherwise be charged them three
 *    times, silently.
 *  - Modelling, prep, post-processing and extras are zero. Modelisation3D is
 *    its own service line, so including modelling here would double-count it;
 *    the rest are not captured by this form at all.
 *
 *  Returns null when the service is disabled — any of printer, filament,
 *  weight or time missing. */
export function computeImpressionCost(
  impression: ImpressionDraft,
  filament: PricingFilament | null,
  printer: PricingPrinter | null,
  defaults: PricingDefaults,
): PricingResult | null {
  const { printerId, filamentId, weightG, timeMin } = impression;
  if (printerId === null || filamentId === null || weightG === null || timeMin === null) return null;
  if (!filament || !printer) return null;

  return computePricing(
    {
      weight_g: weightG,
      printing_time_h: timeMin / 60,
      quantity: Math.max(1, Math.floor(impression.quantity || 1)),
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
    filament,
    printer,
    { ...defaults, base_fee_flat: 0, consumables_packaging_flat: 0 },
  );
}

const orZero = (n: number | null) => n ?? 0;

export function taskTotal(task: TaskDraft): number {
  return orZero(task.scanCost) + orZero(task.modelisationCost) + orZero(task.usinageCost)
    + orZero(task.impressionCost);
}

export function projectTotal(tasks: TaskDraft[]): number {
  return tasks.reduce((sum, t) => sum + taskTotal(t), 0);
}
