/** Zoho retainer-invoice statuses, labelled for the Billing card's retainer
 *  rows. Its own module for the reason `invoiceStatus.ts` is separate from
 *  `quoteStatus.ts`: the vocabularies overlap by accident, not by contract,
 *  and a status missing here renders raw rather than disappearing. */
const LABEL_KEYS: Record<string, string> = {
  draft: 'aito.retainerStatus.draft',
  sent: 'aito.retainerStatus.sent',
  paid: 'aito.retainerStatus.paid',
  partially_paid: 'aito.retainerStatus.partiallyPaid',
  void: 'aito.retainerStatus.void',
};

export function retainerStatusLabelKey(status: string): string | null {
  return Object.hasOwn(LABEL_KEYS, status) ? LABEL_KEYS[status] : null;
}

export type RetainerStatusTone = 'success' | 'warning' | 'neutral';

/** Green once the deposit is in; a part-paid retainer warns, since the
 *  remainder is still owed; everything else is neutral. */
const STATUS_TONE: Record<string, RetainerStatusTone> = { paid: 'success', partially_paid: 'warning' };

export function retainerStatusTone(status: string): RetainerStatusTone {
  return Object.hasOwn(STATUS_TONE, status) ? STATUS_TONE[status] : 'neutral';
}

/** Full literal class strings per tone — Tailwind cannot see an interpolated
 *  class name. Same three tones as the invoice's. */
export const RETAINER_STATUS_TEXT_TONE_CLASSES: Record<RetainerStatusTone, string> = {
  success: 'text-bambu-green-light',
  warning: 'text-status-warning',
  neutral: 'text-bambu-gray-light',
};
