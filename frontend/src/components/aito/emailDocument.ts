/** Which Zoho document the send-email modal is about. The quote has its own
 *  modal (its send moves the board column); invoices and retainer invoices
 *  share one, differing only in endpoint, cache key and copy. */
export type EmailDocument = { kind: 'invoice' | 'retainer'; id: string };
