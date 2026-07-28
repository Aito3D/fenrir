import { computePricing } from './pricing';
import type { PricingDefaults, PricingFilament, PricingPrinter, PricingResult } from './pricing';
import type { AitoTask, AitoTaskCreate } from '../api/client';

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
  /** Stable client-side identity for a not-yet-persisted row (`id === null`),
   *  set once at creation. This is what TaskEditor keys rows on instead of
   *  array index, so deleting an earlier row can't hand a later row's mounted
   *  `ImpressionFields` instance down into a lower slot — along with whatever
   *  provenance state (`hasEdited`) that instance was carrying. Meaningless
   *  once `id` is non-null; a persisted row's `id` is already a stable,
   *  collision-free identity on its own. */
  uid: string;
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

/** Generates the client-side uid a fresh draft is stamped with. Mirrors the
 *  fallback SliceModal.tsx uses for `previewRequestId`: `crypto.randomUUID`
 *  where available, a timestamp+random string otherwise (older browsers /
 *  non-secure contexts don't expose `crypto.randomUUID`). */
function makeDraftUid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function emptyTaskDraft(): TaskDraft {
  return {
    id: null,
    uid: makeDraftUid(),
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

/** Wire shape -> client shape, the read half of the conversion. `?? 1` on
 *  quantity is defensive only: a saved row always carries a real number (see
 *  `taskDraftToTaskCreate`), never `null`. */
export function taskDraftFromAitoTask(task: AitoTask): TaskDraft {
  return {
    id: task.id,
    // `id` is already stable and unique for a persisted row, so `uid` is
    // never read for one (see the field doc) — this value is filler only,
    // deliberately not `makeDraftUid()`, so a persisted row never resembles
    // a draft.
    uid: `server-${task.id}`,
    title: task.title ?? '',
    description: task.description ?? '',
    scanCost: task.scan_cost,
    modelisationCost: task.modelisation_cost,
    usinageCost: task.usinage_cost,
    impression: {
      printerId: task.impression_printer_id,
      filamentId: task.impression_filament_id,
      weightG: task.impression_weight_g,
      timeMin: task.impression_time_min,
      quantity: task.impression_quantity ?? 1,
      color: task.impression_color ?? '',
    },
    impressionCost: task.impression_cost,
  };
}

/** Client shape -> wire shape, matching the conventions the create modal
 *  established: `title`, `description` and `impression_color` collapse blank
 *  to `null` rather than `''`; every numeric field passes straight through so
 *  a `0` cost stays `0` (free) rather than becoming `null` (disabled). This is
 *  the one place both the create modal (POST) and the detail panel (diffed
 *  into a PATCH) build the wire shape, so the two flows cannot drift apart —
 *  see the design doc finding this fixes. */
export function taskDraftToTaskCreate(t: TaskDraft): AitoTaskCreate {
  return {
    title: t.title.trim() || null,
    description: t.description.trim() || null,
    scan_cost: t.scanCost,
    modelisation_cost: t.modelisationCost,
    usinage_cost: t.usinageCost,
    impression_printer_id: t.impression.printerId,
    impression_filament_id: t.impression.filamentId,
    impression_weight_g: t.impression.weightG,
    impression_time_min: t.impression.timeMin,
    impression_quantity: t.impression.quantity,
    impression_color: t.impression.color.trim() || null,
    impression_cost: t.impressionCost,
  };
}

const orZero = (n: number | null) => n ?? 0;

export function taskTotal(task: TaskDraft): number {
  return orZero(task.scanCost) + orZero(task.modelisationCost) + orZero(task.usinageCost)
    + orZero(task.impressionCost);
}

export function projectTotal(tasks: TaskDraft[]): number {
  return tasks.reduce((sum, t) => sum + taskTotal(t), 0);
}
