import { SERVICES, taskCost } from '../../utils/aitoBoardRules';
import type { ServiceId } from '../../utils/aitoBoardRules';
import type { TaskDraft } from '../../utils/taskDraft';

export type { ServiceId };

/** The four Aito services, keyed by the ids the backend emits.
 *
 *  Shared by the board card (which receives its ids from `task_services` on
 *  the project response) and a collapsed task row (which derives them from the
 *  draft in hand) so the two can never disagree about a label. The insertion
 *  order here is the canonical order `SERVICES` emits — see
 *  backend/app/services/aito_board_rules.py — so a derived badge row reads
 *  the same way as a server-supplied one.
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

/** The task's steps, in canonical order — one per service whose cost is set.
 *  A cost of 0 is a step quoted free, not an absent one, so membership is a
 *  null check and never a truthiness test. */
export function taskSteps(task: TaskDraft): { service: ServiceId; cost: number; done: boolean }[] {
  return SERVICES.filter((service) => taskCost(task, service) !== null).map((service) => ({
    service,
    cost: taskCost(task, service) as number,
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
