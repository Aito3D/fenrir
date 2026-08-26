/** Presentation only. The BACKEND registry in services/aito_events.py remains
 *  the authority for which kinds a depth returns — this map decides how a kind
 *  looks once the server has decided to send it, and nothing else. A kind
 *  missing from here still renders, using its raw string, rather than
 *  disappearing: the server can learn a new kind before the frontend does. */
export const EVENT_LABEL_KEY: Record<string, string> = {
  'project.created': 'aito.history.projectCreated',
  'quote.created': 'aito.history.quoteCreated',
  'quote.sent': 'aito.history.quoteSent',
  'quote.emailed': 'aito.history.quoteEmailed',
  'invoice.emailed': 'aito.history.invoiceEmailed',
  'quote.viewed': 'aito.history.quoteViewed',
  'quote.accepted': 'aito.history.quoteAccepted',
  'quote.unaccepted': 'aito.history.quoteUnaccepted',
  'quote.declined': 'aito.history.quoteDeclined',
  'quote.expired': 'aito.history.quoteExpired',
  'stage.changed': 'aito.history.stageChanged',
  'project.trashed': 'aito.history.projectTrashed',
  'project.restored': 'aito.history.projectRestored',
  'task.added': 'aito.history.taskAdded',
  'task.updated': 'aito.history.taskUpdated',
  'task.removed': 'aito.history.taskRemoved',
  'task.reordered': 'aito.history.taskReordered',
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
  'project.urgent.set': 'aito.history.projectUrgentSet',
  'project.urgent.cleared': 'aito.history.projectUrgentCleared',
  'project.sav.set': 'aito.history.projectSavSet',
  'project.sav.cleared': 'aito.history.projectSavCleared',
  'project.pause.set': 'aito.history.projectPauseSet',
  'project.pause.cleared': 'aito.history.projectPauseCleared',
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

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? '✓' : '—';
  return String(value);
}

/** `detail` is stored on every event but the label alone only carries the
 *  full story for a handful of kinds — the ones with nothing else to show:
 *
 *  - `zoho.comment` carries Books' verbatim text in `detail.text`. It is the
 *    lossless fallback tier for a comment the pattern table did not
 *    recognise, and without this the bare label "Comment in Zoho Books"
 *    tells the reader nothing.
 *  - `sync.failed` (and the two ambiguous-outcome kinds that share its
 *    shape) carries the reason in `detail.error`, or the two sides of a
 *    disagreement in `detail.ours`/`detail.theirs` — without this a card
 *    that failed last week can say THAT it failed but never WHY.
 *
 *  `detail` is `Record<string, unknown> | null` from the wire, so every read
 *  here is narrowed before use — never rendered as an object.
 *
 *  Deliberately returns plain text, not a translated sentence: the brief for
 *  this fix is explicit that no new i18n keys may be added, so the conflict
 *  sides are shown as bare values rather than composed into a phrase. */
export function detailText(kind: string, detail: Record<string, unknown> | null): string | null {
  if (!detail) return null;

  if (kind === 'zoho.comment') {
    return typeof detail.text === 'string' && detail.text ? detail.text : null;
  }

  if (kind === 'sync.failed') {
    return typeof detail.error === 'string' && detail.error ? detail.error : null;
  }

  if (kind === 'sync.conflict' || kind === 'sync.status_rejected') {
    const hasSides =
      (typeof detail.ours === 'string' && detail.ours) || (typeof detail.theirs === 'string' && detail.theirs);
    return hasSides ? `${formatValue(detail.ours)} → ${formatValue(detail.theirs)}` : null;
  }

  return null;
}

/** The magnitude and unit for the elapsed-gutter label: `null` when the gap
 *  is under a minute (same-minute, nothing worth a row), otherwise the
 *  largest whole unit that fits — days, then hours, then minutes. */
export function elapsedBucket(seconds: number): { value: number; unit: Intl.RelativeTimeFormatUnit } | null {
  if (seconds < 60) return null; // same minute — nothing worth a row

  if (seconds >= 86_400) return { value: Math.round(seconds / 86_400), unit: 'day' };
  if (seconds >= 3_600) return { value: Math.round(seconds / 3_600), unit: 'hour' };
  return { value: Math.round(seconds / 60), unit: 'minute' };
}
