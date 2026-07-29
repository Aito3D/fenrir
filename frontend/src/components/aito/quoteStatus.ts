/** Zoho estimate statuses, styled and labelled for the board card.
 *
 *  Colour carries the meaning so a full board reads at a glance: accepted is
 *  the app's brand green (its "done" colour, same as the finish column),
 *  declined and expired are the error tone, sent and viewed are the quote
 *  column's cool blue, draft is inert grey.
 *
 *  A status missing from these maps is NOT an error: Zoho can add statuses,
 *  and the card renders the raw string in the neutral style rather than
 *  dropping it — the same fallback rule ServiceBadges uses for an unknown
 *  service id. */
export const QUOTE_STATUS_NEUTRAL = 'bg-bambu-dark-tertiary text-bambu-gray-light';

export const QUOTE_STATUS_STYLES: Record<string, string> = {
  draft: QUOTE_STATUS_NEUTRAL,
  sent: 'bg-sky-400/15 text-sky-300',
  viewed: 'bg-sky-400/15 text-sky-300',
  accepted: 'bg-bambu-green/15 text-bambu-green',
  declined: 'bg-status-error/15 text-status-error',
  expired: 'bg-status-error/15 text-status-error',
};

const LABEL_KEYS: Record<string, string> = {
  draft: 'aito.quoteStatus.draft',
  sent: 'aito.quoteStatus.sent',
  viewed: 'aito.quoteStatus.viewed',
  accepted: 'aito.quoteStatus.accepted',
  declined: 'aito.quoteStatus.declined',
  expired: 'aito.quoteStatus.expired',
};

/** The Tailwind classes for a status, or the neutral fallback when we have no
 *  style for it. `quote_status` is a free string up to 30 chars accepted from
 *  the client (see `POST /aito/`), so a plain-object index must be guarded
 *  with `Object.hasOwn` — an unguarded `QUOTE_STATUS_STYLES[status]` would
 *  fall through to `Object.prototype` for a status like `'toString'` and
 *  return a function instead of `undefined`. */
export function quoteStatusStyle(status: string): string {
  return Object.hasOwn(QUOTE_STATUS_STYLES, status) ? QUOTE_STATUS_STYLES[status] : QUOTE_STATUS_NEUTRAL;
}

/** The i18n key for a status, or null when we have no translation for it —
 *  in which case the caller renders the raw status string. Guarded the same
 *  way as `quoteStatusStyle`, and for the same reason: `status` is
 *  client-influenced, so a bare `LABEL_KEYS[status]` could resolve to an
 *  inherited `Object.prototype` member (e.g. `status === 'toString'`) rather
 *  than `undefined`. */
export function quoteStatusLabelKey(status: string): string | null {
  return Object.hasOwn(LABEL_KEYS, status) ? LABEL_KEYS[status] : null;
}
