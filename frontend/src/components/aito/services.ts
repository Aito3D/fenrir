import type { TaskDraft } from '../../utils/taskDraft';

/** The four Aito services, keyed by the ids the backend emits.
 *
 *  Shared by the board card (which receives its ids from `task_services` on
 *  the project response) and a collapsed task row (which derives them from the
 *  draft in hand) so the two can never disagree about a label. The insertion
 *  order here is the canonical order `_task_summaries` emits — see
 *  backend/app/api/routes/aito.py — so a derived badge row reads the same way
 *  as a server-supplied one.
 *
 *  The labels are translated per locale (Scan / Modeling / Printing /
 *  Machining in English), so nothing may render a service by hardcoding its
 *  id or an English name — always go through the key. */
export const AITO_SERVICE_LABEL_KEYS: Record<string, string> = {
  scan: 'aito.serviceScan3D',
  modelisation: 'aito.serviceModelisation3D',
  impression: 'aito.serviceImpression3D',
  usinage: 'aito.serviceUsinage',
};

/** Which services a draft has enabled, in canonical order.
 *
 *  `null` means the service is disabled and `0` means it is free, so
 *  membership is a null check — never a truthiness or `> 0` test, which would
 *  drop a service quoted at zero. Same rule the backend aggregate follows. */
export function enabledServices(task: TaskDraft): string[] {
  const enabled: string[] = [];
  if (task.scanCost !== null) enabled.push('scan');
  if (task.modelisationCost !== null) enabled.push('modelisation');
  if (task.impressionCost !== null) enabled.push('impression');
  if (task.usinageCost !== null) enabled.push('usinage');
  return enabled;
}

export type ServiceId = 'scan' | 'modelisation' | 'impression' | 'usinage';

// Canonical iteration order for the four services. Kept as its own typed
// tuple rather than `Object.keys(AITO_SERVICE_LABEL_KEYS) as ServiceId[]`:
// that record is typed `Record<string, string>`, so a fifth entry added
// there wouldn't widen ServiceId, and COSTS[service] would be `undefined`
// and throw at runtime with no compile error to catch it.
const SERVICE_IDS = ['scan', 'modelisation', 'impression', 'usinage'] as const;

const COSTS: Record<ServiceId, (task: TaskDraft) => number | null> = {
  scan: (t) => t.scanCost,
  modelisation: (t) => t.modelisationCost,
  impression: (t) => t.impressionCost,
  usinage: (t) => t.usinageCost,
};

/** The task's steps, in canonical order — one per service whose cost is set.
 *  A cost of 0 is a step quoted free, not an absent one, so membership is a
 *  null check and never a truthiness test. */
export function taskSteps(task: TaskDraft): { service: ServiceId; cost: number; done: boolean }[] {
  return SERVICE_IDS.filter((service) => COSTS[service](task) !== null).map((service) => ({
    service,
    cost: COSTS[service](task) as number,
    done: task.done[service],
  }));
}

/** True once every step on the task is ticked. A task with no steps at all is
 *  NOT finished here — an empty row is unstarted, not complete — even though
 *  the board's rule engine treats "nothing pending" as nothing to do. The two
 *  answer different questions: this one decides whether the row goes green. */
export function isTaskFinished(task: TaskDraft): boolean {
  const steps = taskSteps(task);
  return steps.length > 0 && steps.every((step) => step.done);
}
