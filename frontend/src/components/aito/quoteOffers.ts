import type { AitoProject } from '../../api/client';

type QuoteStatus = AitoProject['quote_status'];

/** Which of the three quote actions a given status offers — the rules in
 *  QuoteStatusActions' doc, as one lookup so the settle can compare the
 *  held-on status against the real one to know which buttons are leaving,
 *  and so the panel footer can tell whether the bar renders anything. */
export function quoteOffers(status: QuoteStatus) {
  if (status === 'accepted') return { markSent: false, settle: false, decline: false };
  // Mark-as-sent only while the client does not have the quote yet. On sent,
  // viewed, expired and declined they already do, so offering to mark it sent
  // says nothing true.
  const markSent = status === null || status === 'draft';
  // The exact complement of markSent, and deliberately expressed as its
  // negation rather than re-derived: a quote the client has never received
  // cannot be accepted or declined. Because aito_board_rules.evaluate derives
  // the column FROM the status, this is identical to "the card is not in the
  // Quote column" — the two can never disagree, which is why the rule is
  // written against the status the server already sends rather than against
  // project.column.
  const settle = !markSent;
  // Declining an already-declined quote is a no-op the board would still
  // hold-to-confirm and toast about. Accept is what a declined card needs.
  const decline = settle && status !== 'declined';
  return { markSent, settle, decline };
}

/** Whether QuoteStatusActions renders any button for this status. */
export function offersQuoteAction(status: QuoteStatus): boolean {
  const offered = quoteOffers(status);
  return offered.markSent || offered.settle;
}
