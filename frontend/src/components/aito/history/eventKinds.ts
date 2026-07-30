/** Presentation only. The BACKEND registry in services/aito_events.py remains
 *  the authority for which kinds a depth returns — this map decides how a kind
 *  looks once the server has decided to send it, and nothing else. A kind
 *  missing from here still renders, using its raw string, rather than
 *  disappearing: the server can learn a new kind before the frontend does. */
export const EVENT_LABEL_KEY: Record<string, string> = {
  'project.created': 'aito.history.projectCreated',
  'quote.created': 'aito.history.quoteCreated',
  'quote.sent': 'aito.history.quoteSent',
  'quote.viewed': 'aito.history.quoteViewed',
  'quote.accepted': 'aito.history.quoteAccepted',
  'quote.declined': 'aito.history.quoteDeclined',
  'quote.expired': 'aito.history.quoteExpired',
  'stage.changed': 'aito.history.stageChanged',
  'project.trashed': 'aito.history.projectTrashed',
  'project.restored': 'aito.history.projectRestored',
  'task.added': 'aito.history.taskAdded',
  'task.updated': 'aito.history.taskUpdated',
  'task.removed': 'aito.history.taskRemoved',
  'task.step.ticked': 'aito.history.taskStepTicked',
  'task.step.unticked': 'aito.history.taskStepUnticked',
  'project.updated': 'aito.history.projectUpdated',
  'note.added': 'aito.history.noteAdded',
  'zoho.comment': 'aito.history.zohoComment',
  'sync.queued': 'aito.history.syncQueued',
  'sync.pushed': 'aito.history.syncPushed',
  'sync.failed': 'aito.history.syncFailed',
  'sync.locked': 'aito.history.syncLocked',
  'sync.conflict': 'aito.history.syncConflict',
  'sync.status_rejected': 'aito.history.syncStatusRejected',
  'poll.reconciled': 'aito.history.pollReconciled',
};

/** Red overrides the actor colour: a failure is the one thing worth finding
 *  without reading, and its actor (always the system) says nothing useful. */
const FAILURE_KINDS = new Set(['sync.failed', 'sync.conflict', 'sync.status_rejected']);

export function dotClass(kind: string, actorClass: string): string {
  if (FAILURE_KINDS.has(kind)) return 'bg-status-error';
  if (actorClass === 'client') return 'bg-amber-400';
  if (actorClass === 'user') return 'bg-bambu-green';
  return 'bg-bambu-gray';
}
