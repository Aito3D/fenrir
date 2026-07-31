import type { AitoColumnId } from '../api/client';

/** The Aito board's rules, mirrored from
 *  backend/app/services/aito_board_rules.py.
 *
 *  A mirror exists because the board is optimistic: a card must move the
 *  instant a step is ticked or a quote is accepted, which means predicting the
 *  column locally rather than waiting to be told it.
 *
 *  This mirror is NOT maintained by discipline. It is pinned by a generated
 *  contract fixture — see backend/tests/aito_rules_fixture.py. Change the
 *  Python and the backend test fails until the fixture is regenerated;
 *  regenerate it and this file's test fails until it is brought back in line.
 *
 *  Imports nothing local but a type. `services.ts` and `taskDraft.ts` both
 *  import FROM here; importing either of them back would close a cycle. */

export type MoveLock = 'quote' | 'waiting' | 'declined' | 'steps' | null;

/** Board order, left to right. */
export const COLUMN_ORDER: readonly AitoColumnId[] = [
  'devis',
  'waiting',
  'scan',
  'model',
  'print',
  'finish',
  'done',
];

/** Canonical service order — every derived list is emitted in it, so a badge
 *  row is stable across refetches regardless of task creation order.
 *
 *  This is the single declaration of which services exist. `ServiceId` below
 *  is derived FROM this array (`as const` + indexed access) rather than
 *  hand-typed alongside it, and deliberately so: a plain `Record<string, ...>`
 *  keyed by service, or a union typed by hand next to this array, would let a
 *  fifth service compile into `ServiceId` without ever landing here — and
 *  every lookup keyed by the union (`COST_KEYS`, `TaskLike.done`) would then
 *  miss it silently at runtime, `undefined` with no compile error to catch
 *  it. Making `SERVICES` authoritative closes that: a service can only be
 *  added by editing this array, which immediately fails compilation of every
 *  `Record<ServiceId, ...>` until it is filled in too. `STAGES` below can't be
 *  pinned this way — TypeScript has no way to express "every union member
 *  appears in this nested array" — so it is covered by a test instead
 *  (aitoBoardRules.test.ts: "every service is staged exactly once"). */
export const SERVICES = ['scan', 'modelisation', 'impression', 'usinage'] as const;

export type ServiceId = (typeof SERVICES)[number];

/** Statuses meaning the quote has left the shop: the answer is the client's to
 *  give, not ours to write. `viewed` only says they opened it and `expired`
 *  says they never answered — both are still waiting on them. */
export const AWAY_STATUSES: ReadonlySet<string> = new Set(['sent', 'viewed', 'expired']);

/** Which services each work stage covers, in board order. Printing and
 *  machining share one column while remaining two separate steps on a task:
 *  the column is left only once BOTH are ticked everywhere they appear.
 *
 *  Exported only so the contract test can assert every member of `SERVICES`
 *  appears in exactly one stage — unlike `ServiceId`, that completeness can't
 *  be pinned by the type system, since nothing stops a tuple entry from being
 *  duplicated or omitted while still type-checking as `readonly ServiceId[]`. */
export const STAGES: readonly (readonly [AitoColumnId, readonly ServiceId[]])[] = [
  ['scan', ['scan']],
  ['model', ['modelisation']],
  ['print', ['impression', 'usinage']],
];

/** The minimum a task must expose for these rules to read it. Structural, not
 *  `TaskDraft`, for the same reason the Python is duck-typed: it keeps this
 *  module free of any dependency that could cycle back into it. */
export interface TaskLike {
  scanCost: number | null;
  modelisationCost: number | null;
  impressionCost: number | null;
  usinageCost: number | null;
  done: Record<ServiceId, boolean>;
}

const COST_KEYS: Record<ServiceId, keyof TaskLike> = {
  scan: 'scanCost',
  modelisation: 'modelisationCost',
  impression: 'impressionCost',
  usinage: 'usinageCost',
};

/** One service's cost, or null when the service is absent from the job.
 *  `0` is a real cost — a step quoted free. */
export function taskCost(task: TaskLike, service: ServiceId): number | null {
  return task[COST_KEYS[service]] as number | null;
}

/** The whole rule set: `[column, moveLock]`.
 *
 *  `moveLock` names why the card is still pinned to a derived column, and is
 *  null only once the rules let go of it — which happens exactly between
 *  Finish and Done. That release is what gates the card's mark-done and
 *  restore buttons; nothing about it is a drag any more.
 *
 *  Rule ORDER matters twice, and is the part a data-driven version could not
 *  express. Waiting outranks the steps, so ticking a step on a card that is
 *  out with the client moves nothing — the work is not authorised yet. And the
 *  stage search runs before the nothing-left-to-do fallback, which is what
 *  evicts a card from Done the moment any step is re-opened; swapped,
 *  un-ticking would leave it parked in Done forever. */
export function evaluate(
  quoteStatus: string | null,
  storedColumn: AitoColumnId,
  pending: readonly string[],
): [AitoColumnId, MoveLock] {
  if (quoteStatus === 'declined') return ['done', 'declined'];
  if (quoteStatus !== null && AWAY_STATUSES.has(quoteStatus)) return ['waiting', 'waiting'];
  if (quoteStatus !== 'accepted') {
    // null included: a hand-made card with no Zoho quote waits for Accept
    // exactly like a draft does. Acceptance is the single gate.
    return ['devis', 'quote'];
  }

  const pendingSet = new Set(pending);
  for (const [stage, services] of STAGES) {
    if (services.some((service) => pendingSet.has(service))) return [stage, 'steps'];
  }

  // Nothing left to do. This is the ONLY place the stored column is believed,
  // and only between Finish and Done — which is what makes that one manual
  // transition (the card's mark-done / restore buttons) possible inside an
  // otherwise fully derived model.
  return [storedColumn === 'done' ? 'done' : 'finish', null];
}

/** One task's steps, as the card draws them. Mirrors `TaskSteps` in
 *  backend/app/services/aito_board_rules.py. `services` is what the task
 *  carries and `done` the ticked subset, both in `SERVICES` order. */
export interface TaskSteps {
  services: ServiceId[];
  done: ServiceId[];
}

export interface TaskSummary {
  count: number;
  total: number;
  services: ServiceId[];
  pending: ServiceId[];
  stepsTotal: number;
  stepsDone: number;
  /** One entry per task, in the order given — the card draws a row each. */
  stepsByTask: TaskSteps[];
}

/** Everything a project's tasks say about it, in one pass.
 *
 *  A cost of null means the service is absent from the job and is skipped
 *  entirely; 0 means it is quoted free, which is a real step that must show
 *  its badge, hold its column and count toward the progress bar.
 *
 *  `stepsTotal`/`stepsDone` count (task, service) PAIRS, not services: two
 *  tasks each carrying a scan are two steps, where `services` reports 'scan'
 *  once. */
export function summariseTasks(tasks: readonly TaskLike[]): TaskSummary {
  let total = 0;
  let stepsTotal = 0;
  let stepsDone = 0;
  const enabled = new Set<ServiceId>();
  const unticked = new Set<ServiceId>();
  const stepsByTask: TaskSteps[] = [];

  for (const task of tasks) {
    const taskServices: ServiceId[] = [];
    const taskDone: ServiceId[] = [];
    for (const service of SERVICES) {
      const cost = taskCost(task, service);
      if (cost === null) continue;
      enabled.add(service);
      taskServices.push(service);
      total += cost;
      stepsTotal += 1;
      if (task.done[service]) {
        stepsDone += 1;
        taskDone.push(service);
      } else {
        unticked.add(service);
      }
    }
    stepsByTask.push({ services: taskServices, done: taskDone });
  }

  return {
    count: tasks.length,
    total,
    services: SERVICES.filter((service) => enabled.has(service)),
    pending: SERVICES.filter((service) => unticked.has(service)),
    stepsTotal,
    stepsDone,
    stepsByTask,
  };
}
