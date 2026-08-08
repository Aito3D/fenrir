/** Zoho invoice statuses, labelled for the Invoice card.
 *
 *  A separate module from `quoteStatus.ts` on purpose, not by oversight:
 *  Books' invoice vocabulary and its estimate vocabulary share no member at
 *  all. Feeding an invoice status through `quoteStatusLabelKey` would return
 *  null for every one of them and render the raw `partially_paid` at the
 *  user — the two maps look similar and are not interchangeable.
 *
 *  A status missing from this map is NOT an error: Zoho can add statuses, and
 *  the caller renders the raw string rather than dropping it — the same
 *  fallback rule quoteStatus.ts follows. */
const LABEL_KEYS: Record<string, string> = {
  draft: 'aito.invoiceStatus.draft',
  sent: 'aito.invoiceStatus.sent',
  unpaid: 'aito.invoiceStatus.unpaid',
  paid: 'aito.invoiceStatus.paid',
  partially_paid: 'aito.invoiceStatus.partiallyPaid',
  overdue: 'aito.invoiceStatus.overdue',
  void: 'aito.invoiceStatus.void',
};

/** The i18n key for a status, or null when we have no translation for it.
 *  `Object.hasOwn` rather than a bare lookup, for the same reason
 *  quoteStatusLabelKey uses it: the status is upstream free text, and an
 *  unguarded lookup could resolve an inherited `Object.prototype` member
 *  (e.g. `status === 'toString'`) instead of `undefined`. */
export function invoiceStatusLabelKey(status: string): string | null {
  return Object.hasOwn(LABEL_KEYS, status) ? LABEL_KEYS[status] : null;
}

export type InvoiceStatusTone = 'success' | 'error' | 'warning' | 'neutral';

/** Green means the money arrived — the one fact the operator opens this card
 *  for. `overdue` is the only error: it is the state that costs something.
 *  `partially_paid` warns rather than succeeds, because a part-paid invoice
 *  still has a balance owing and reading it as green is how it gets
 *  forgotten. `void` stays neutral: a cancelled invoice is not a failure,
 *  and colouring it red would have it read as a problem to chase. */
const STATUS_TONE: Record<string, InvoiceStatusTone> = {
  paid: 'success',
  overdue: 'error',
  partially_paid: 'warning',
};

export function invoiceStatusTone(status: string): InvoiceStatusTone {
  return Object.hasOwn(STATUS_TONE, status) ? STATUS_TONE[status] : 'neutral';
}

/** Complete, literal class strings per tone — Tailwind cannot see a
 *  dynamically-interpolated class name, so each tone's classes must appear in
 *  full in the source for the build to keep them. Text-only, matching the
 *  Quote card's Status row (QUOTE_STATUS_TEXT_TONE_CLASSES) so the two cards
 *  in the same column render a status the same way. */
export const INVOICE_STATUS_TEXT_TONE_CLASSES: Record<InvoiceStatusTone, string> = {
  success: 'text-bambu-green-light',
  error: 'text-status-error',
  warning: 'text-status-warning',
  neutral: 'text-bambu-gray-light',
};
