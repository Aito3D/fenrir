import { summariseTasks } from './aitoBoardRules';
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
   *  component tree — the `ImpressionFields` instance and every other input
   *  in the row — down into a lower slot. That key also gates the row's
   *  expanded/collapsed state (see TaskEditor's `rowKey`), so reusing it
   *  across rows would carry that open/closed state, and whatever a user was
   *  mid-typing into an uncontrolled input, into the wrong row's data.
   *  Meaningless once `id` is non-null; a persisted row's `id` is already a
   *  stable, collision-free identity on its own. */
  uid: string;
  title: string;
  /** Optional free text per service — the quote line's Info: row. '' = none. */
  scanDescription: string;
  modelisationDescription: string;
  impressionDescription: string;
  usinageDescription: string;
  /** null = the service is disabled. 0 stays meaningful as "free". */
  scanCost: number | null;
  modelisationCost: number | null;
  usinageCost: number | null;
  impression: ImpressionDraft;
  /** Frozen total for a saved task; recomputed while the task is being edited.
   *  Stored PRE-discount: `impressionDiscountPct` below is applied on top by
   *  the totals (summariseTasks) and by the quote line itself, never baked
   *  in here — the two must not double-count. */
  impressionCost: number | null;
  /** Percent discount on the printing service (the quote line's "10%"), or
   *  null for none. Top-level beside `impressionCost` — it modifies the cost,
   *  not the print parameters. */
  impressionDiscountPct: number | null;
  /** One flag per service, keyed by the same ids the backend and
   *  AITO_SERVICE_LABEL_KEYS use. A flag is only meaningful when its cost is
   *  not null — the backend clears it otherwise, and refuses to set it. */
  done: Record<'scan' | 'modelisation' | 'impression' | 'usinage', boolean>;
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
    scanDescription: '',
    modelisationDescription: '',
    impressionDescription: '',
    usinageDescription: '',
    scanCost: null,
    modelisationCost: null,
    usinageCost: null,
    impression: { printerId: null, filamentId: null, weightG: null, timeMin: null, quantity: 1, color: '' },
    impressionCost: null,
    impressionDiscountPct: null,
    done: { scan: false, modelisation: false, impression: false, usinage: false },
  };
}

/** Fill an unknown-shaped, previously-persisted task out to the CURRENT
 *  `TaskDraft`, keeping every field that is there and defaulting the rest.
 *
 *  The new-project drawer round-trips its drafts through localStorage under a
 *  key (`aito.newProjectDraft.v1`) that is not bumped when `TaskDraft` gains a
 *  field — and it has gained several: the four per-service descriptions, `uid`,
 *  `impressionDiscountPct`. A blob written before any of those restores a task
 *  missing them, and the fields are read UNGUARDED all over the drawer
 *  (`TaskStepList` does `task[DESCRIPTION_FIELD[service]].trim()` on every
 *  render, `tasksSignature` the same) — so the drawer threw
 *  "Cannot read properties of undefined (reading 'trim')" up to the router
 *  error boundary the moment it opened, and stayed broken until the operator
 *  cleared their storage. This is the one boundary that data crosses, so it is
 *  the one place that has to be defensive; every reader downstream is free to
 *  keep trusting the type.
 *
 *  Filling, not rejecting: a stale blob is somebody's half-typed quote, and
 *  the fields that go missing are additive ones — a task with no description
 *  is exactly a task whose description is ''. Type-checked per field rather
 *  than spread over the default, because a hand-edited or truncated blob can
 *  hold a string where a number belongs, and `{...base, ...raw}` would pass
 *  that straight through to the same class of crash it is meant to stop. */
export function normaliseTaskDraft(raw: unknown): TaskDraft {
  // Per call, so each uid-less legacy row gets its own uid — rowKey() keys
  // unsaved rows on it, and a shared one hands a row's mounted inputs to its
  // neighbour (see `rowKey`).
  const base = emptyTaskDraft();
  if (typeof raw !== 'object' || raw === null) return base;

  const task = raw as Record<string, unknown>;
  const str = (value: unknown) => (typeof value === 'string' ? value : '');
  // Finite check, not just typeof: JSON.parse yields no NaN, but a null cost
  // and a NaN cost mean different things everywhere downstream and only one
  // of them is representable.
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const bool = (value: unknown) => value === true;
  const nested = (value: unknown) =>
    (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const impression = nested(task.impression);
  const done = nested(task.done);

  return {
    id: num(task.id),
    uid: typeof task.uid === 'string' && task.uid !== '' ? task.uid : base.uid,
    title: str(task.title),
    scanDescription: str(task.scanDescription),
    modelisationDescription: str(task.modelisationDescription),
    impressionDescription: str(task.impressionDescription),
    usinageDescription: str(task.usinageDescription),
    scanCost: num(task.scanCost),
    modelisationCost: num(task.modelisationCost),
    usinageCost: num(task.usinageCost),
    impression: {
      printerId: num(impression.printerId),
      filamentId: num(impression.filamentId),
      weightG: num(impression.weightG),
      timeMin: num(impression.timeMin),
      // Quantity is the one number with no null state — 1 is the floor the
      // whole pricing path assumes.
      quantity: num(impression.quantity) ?? 1,
      color: str(impression.color),
    },
    impressionCost: num(task.impressionCost),
    impressionDiscountPct: num(task.impressionDiscountPct),
    done: {
      scan: bool(done.scan),
      modelisation: bool(done.modelisation),
      impression: bool(done.impression),
      usinage: bool(done.usinage),
    },
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
    scanDescription: task.scan_description ?? '',
    modelisationDescription: task.modelisation_description ?? '',
    impressionDescription: task.impression_description ?? '',
    usinageDescription: task.usinage_description ?? '',
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
    impressionDiscountPct: task.impression_discount_pct ?? null,
    done: {
      scan: task.scan_done,
      modelisation: task.modelisation_done,
      impression: task.impression_done,
      usinage: task.usinage_done,
    },
  };
}

/** Client shape -> wire shape, matching the conventions the create modal
 *  established: `title` and `impression_color` collapse blank to `null`
 *  rather than `''`; every numeric field passes straight through so a `0`
 *  cost stays `0` (free) rather than becoming `null` (disabled). This is
 *  the one place both the create modal (POST) and the detail panel (diffed
 *  into a PATCH) build the wire shape, so the two flows cannot drift apart —
 *  see the design doc finding this fixes. */
export function taskDraftToTaskCreate(t: TaskDraft): AitoTaskCreate {
  return {
    title: t.title.trim() || null,
    scan_description: t.scanDescription.trim() || null,
    modelisation_description: t.modelisationDescription.trim() || null,
    impression_description: t.impressionDescription.trim() || null,
    usinage_description: t.usinageDescription.trim() || null,
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
    impression_discount_pct: t.impressionDiscountPct,
    scan_done: t.done.scan,
    modelisation_done: t.done.modelisation,
    impression_done: t.done.impression,
    usinage_done: t.done.usinage,
  };
}

/** Sums a task's four cost fields, treating a disabled service (null) as 0.
 *
 *  Delegates to the mirrored rule engine rather than re-adding the fields:
 *  this figure has to agree with `TaskSummary.total` in
 *  backend/app/services/aito_board_rules.py, and going through the mirror is
 *  what puts it under the contract fixture instead of under a comment. */
/** The commercial rounding for a printing unit price: UP to the next multiple
 *  of 50 (123 -> 150, 201 -> 250, 390 -> 400; exact multiples stay put).
 *  Applied to the CALCULATOR's per-piece figure only — a hand-typed cost is
 *  taken verbatim. The 2-decimal pre-round keeps float noise from bumping an
 *  exact multiple up a whole tier (150.0000000001 must stay 150, not 200). */
export function roundUpTo50(value: number): number {
  return Math.ceil(Math.round(value * 100) / 100 / 50) * 50;
}

export function taskTotal(task: TaskDraft): number {
  return summariseTasks([task]).total;
}

export function projectTotal(tasks: TaskDraft[]): number {
  return summariseTasks(tasks).total;
}

/** True when at least one of the four services is priced on this task.
 *
 *  Tests for `null`, not falsiness: `null` means the service is disabled and
 *  `0` means it is free, and a service quoted at zero is a real line on the
 *  quote. Mirrors the `cost is None` membership test in `summarise()`
 *  (backend/app/services/aito_board_rules.py). */
export function hasPricedService(task: TaskDraft): boolean {
  return (
    task.scanCost !== null
    || task.modelisationCost !== null
    || task.usinageCost !== null
    || task.impressionCost !== null
  );
}

/** Every task must be priced, and there must be at least one.
 *
 *  A task with no priced service produces no line item, so it would appear on
 *  the board and be invisible on the quote — including its header. Requiring
 *  it up front is what makes "one project is one quote" true rather than
 *  usually true. */
export function projectHasPricedService(tasks: TaskDraft[]): boolean {
  return tasks.length > 0 && tasks.every(hasPricedService);
}

/** A stable identity for a row, not its position.
 *
 *  Keying by index hands a deleted row's slot — and everything mounted in
 *  it, the ImpressionFields instance included — down to whichever row slides
 *  up into it: same component identities, same DOM nodes, now showing a
 *  different row's data without ever remounting. `id` is stable and unique
 *  once a task is persisted; `uid` (see TaskDraft) covers it before then. The
 *  `persisted:`/`draft:` prefixes keep the two id spaces from ever colliding
 *  (a draft's `id` is always null, never a real row id, but nothing stops a
 *  future draft uid from formatting the same as some row's numeric id
 *  without the prefix).
 *
 *  Doubles as the key for a row's editing state and every uncontrolled input
 *  inside the row — one more reason `key` and toggle state must use the exact
 *  same string, which is why it is a named function rather than an
 *  expression inlined into the `key` prop: those two must agree, or toggling
 *  one row's form would open another's.
 *
 *  Shared by TaskEditor and NewProjectDrawer — both must call this one
 *  function rather than each keeping its own copy, or the two could drift. */
export function rowKey(task: TaskDraft): string {
  return task.id !== null ? `persisted:${task.id}` : `draft:${task.uid}`;
}
