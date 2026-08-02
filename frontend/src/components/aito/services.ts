import { SERVICES, STAGES, taskCost } from '../../utils/aitoBoardRules';
import type { ServiceId } from '../../utils/aitoBoardRules';
import type { AitoColumnId } from '../../api/client';
import type { TaskDraft } from '../../utils/taskDraft';
import { ALL_COLUMNS } from './columns';

export type { ServiceId };

/** The four Aito services, keyed by the ids the backend emits.
 *
 *  Shared by `TaskMiniRows` (the board card's per-task row, which iterates
 *  `SERVICES` directly rather than reading ids off the project response) and
 *  `ImportQuoteDrawer` (which derives them from the draft in hand) so the two
 *  can never disagree about a label. The insertion order here is the
 *  canonical order `SERVICES` emits — see
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

/** What one work stage of the board still owes, summed over every task.
 *
 *  `stepsDone`/`stepsTotal` count (task, service) PAIRS: two tasks each
 *  carrying a scan is two steps. `value`/`valueDone` are the money those steps
 *  are quoted at, which is the number the panel's ring is weighted by — seven
 *  steps worth 3 500 to 10 000 FCFP each make "3/7" a poor proxy for progress.
 */
export interface StageWork {
  column: AitoColumnId;
  stepsDone: number;
  stepsTotal: number;
  value: number;
  valueDone: number;
}

/** A project's work, grouped by the board column that performs it.
 *
 *  The grouping comes from `STAGES`, which is the rule engine's own mapping and
 *  is pinned by the contract fixture — printing and machining are two steps on
 *  a task but one column on the board, so they sum into a single entry here.
 *  Read, never extended: adding to `aitoBoardRules` would desync the mirror.
 *
 *  Stages carrying no priced step are omitted rather than returned at zero. A
 *  project with no machining should not show an empty Machining row; `devis`,
 *  `waiting`, `finish` and `done` own no services at all and never appear. */
export function stagesWithWork(tasks: readonly TaskDraft[]): StageWork[] {
  return STAGES.flatMap(([column, services]) => {
    const entry: StageWork = { column, stepsDone: 0, stepsTotal: 0, value: 0, valueDone: 0 };
    for (const task of tasks) {
      for (const service of services) {
        const cost = taskCost(task, service);
        // null is "absent from the job"; 0 is "quoted free" and is a real step.
        if (cost === null) continue;
        entry.stepsTotal += 1;
        entry.value += cost;
        if (task.done[service]) {
          entry.stepsDone += 1;
          entry.valueDone += cost;
        }
      }
    }
    return entry.stepsTotal > 0 ? [entry] : [];
  });
}

/** Service -> the stage dot's Tailwind class, via the rule engine's own
 *  STAGES mapping — shared by the panel's step list and the board card's
 *  task rows so the two can never colour one service two ways. */
const SERVICE_DOT: Record<string, string> = Object.fromEntries(
  STAGES.flatMap(([column, services]) =>
    services.map((service) => [service, ALL_COLUMNS.find((c) => c.id === column)?.dot ?? '']),
  ),
);
export function serviceDotCls(service: string): string {
  return SERVICE_DOT[service] ?? 'bg-bambu-gray';
}
