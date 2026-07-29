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
