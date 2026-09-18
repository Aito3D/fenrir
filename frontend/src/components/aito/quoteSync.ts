import type { AitoProject } from '../../api/client';

/** Sync-row label per stored sync state. `locked` gets a label and nothing
 *  else: the "changes stay local" sentence that used to sit under it was the
 *  tallest row on every invoiced card, for one fact the label already
 *  states.
 *
 *  'locked' resolves to the INVOICED label; the other kind of lock (see
 *  `canForceSync` below) overrides it, because "Quote invoiced" is simply
 *  untrue of a quote that was never billed. */
const SYNC_LABEL_KEY: Record<string, string> = {
  pending: 'aito.syncPendingLabel',
  error: 'aito.syncError',
  locked: 'aito.quoteLocked',
};

/** Why the backend's status reconciler is stuck, keyed by the stored fact it
 *  recorded. `conflict`: Books changed the status under us. `rejected`: Books
 *  refused the status we pushed. Both interpolate the two statuses. */
const BLOCK_MESSAGE_KEY: Record<string, string> = {
  conflict: 'aito.quoteConflict',
  rejected: 'aito.quoteRejected',
};

export interface QuoteSyncView {
  /** i18n key for the Sync row, or undefined for an idle project. */
  syncLabelKey: string | undefined;
  /** i18n key for the status-block sentence, or null when nothing is blocked. */
  blockKey: string | null;
  /** Whether the Billing card has anything to say beyond the quote number.
   *
   *  The card is gated on `quote_number` so a hand-made project shows no
   *  empty heading — but these messages must never be gated with it. A sync
   *  error, a status block or a declined quote on a project whose number is
   *  missing would vanish into a card that no longer renders, and a conflict
   *  that reaches nobody is exactly how a previous design lost them. */
  hasQuoteMessage: boolean;
  /** Whether the operator has to DO something about the sync: a failed push,
   *  a status block, or a push the worker REFUSED (see `canForceSync`).
   *  Pending is a state, not a problem, and an INVOICED card would otherwise
   *  carry the dot for the rest of its life — the refusal kind is the
   *  opposite, an unfinished job with a control sitting behind a tab, which
   *  is exactly what this flag exists to stop hiding. */
  needsAttention: boolean;
  /** Whether this card's lock is one a re-attempt could still clear, i.e.
   *  whether to offer the Force sync control.
   *
   *  There are exactly two kinds of lock (backend/app/services/
   *  aito_quote_sync.py's `_lock_project`). The invoiced kind stamps
   *  `quote_invoiced` and is genuinely final — Books does not un-invoice a
   *  quote. The other kind is a REFUSAL to push: today the only one is a
   *  tax-exclusive estimate, which Aito's tax-inclusive costs cannot be
   *  written onto without inflating the total by the tax rate. That is a
   *  fact about the estimate as Books last returned it, not about the card —
   *  and 'locked' leaves the sync sweep for good, so once the estimate is
   *  fixed in Books nothing would ever look again.
   *
   *  Decided on `quote_invoiced`, never on the text of `quote_sync_error`:
   *  the flag is a column written by exactly one branch, while the message
   *  is prose. A legacy locked row from before that flag existed reads as
   *  forceable here; forcing it costs one Books read and re-locks it as
   *  invoiced, which is self-correcting rather than harmful — the worker,
   *  not this button, decides what a re-attempt means. */
  canForceSync: boolean;
}

/** Everything the panel derives from a project's sync fields, in one place,
 *  so the Billing card's rows, its gate and the Details tab's attention dot
 *  cannot disagree about what counts as a message.
 *
 *  Object.hasOwn-guarded, same reason as quoteStatus.ts's own lookups: the
 *  union types on these fields describe what the backend is SUPPOSED to send,
 *  not a runtime check on what arrives over the wire, so an unguarded
 *  `BLOCK_MESSAGE_KEY[project.quote_status_block]` could resolve an inherited
 *  Object.prototype member (e.g. 'toString') instead of falling through. */
export function deriveQuoteSync(project: AitoProject): QuoteSyncView {
  const blockKey = project.quote_status_block
    ? Object.hasOwn(BLOCK_MESSAGE_KEY, project.quote_status_block)
      ? BLOCK_MESSAGE_KEY[project.quote_status_block]
      : null
    : null;
  const canForceSync = project.quote_sync_state === 'locked' && !project.quote_invoiced;
  const syncLabelKey = canForceSync
    ? 'aito.syncBlockedLabel'
    : Object.hasOwn(SYNC_LABEL_KEY, project.quote_sync_state)
      ? SYNC_LABEL_KEY[project.quote_sync_state]
      : undefined;
  return {
    syncLabelKey,
    blockKey,
    hasQuoteMessage: Boolean(syncLabelKey) || Boolean(blockKey) || project.quote_status === 'declined',
    needsAttention: project.quote_sync_state === 'error' || Boolean(blockKey) || canForceSync,
    canForceSync,
  };
}
