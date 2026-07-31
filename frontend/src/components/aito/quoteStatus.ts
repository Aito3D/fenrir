/** Zoho estimate statuses, labelled for the project detail panel.
 *
 *  The board card used to show these too, styled by colour, but the card's
 *  column already implies the status (see aito_board_rules.evaluate) so that
 *  badge was removed — the detail panel is the only place status still needs
 *  a human-readable label.
 *
 *  A status missing from this map is NOT an error: Zoho can add statuses,
 *  and the caller renders the raw string rather than dropping it — the same
 *  fallback rule ServiceBadges uses for an unknown service id. */
const LABEL_KEYS: Record<string, string> = {
  draft: 'aito.quoteStatus.draft',
  sent: 'aito.quoteStatus.sent',
  viewed: 'aito.quoteStatus.viewed',
  accepted: 'aito.quoteStatus.accepted',
  declined: 'aito.quoteStatus.declined',
  expired: 'aito.quoteStatus.expired',
};

/** The i18n key for a status, or null when we have no translation for it —
 *  in which case the caller renders the raw status string. Guarded with
 *  `Object.hasOwn` rather than a bare `LABEL_KEYS[status]`: `status` is a
 *  free string up to 30 chars accepted from the client (see `POST /aito/`),
 *  so an unguarded lookup could resolve an inherited `Object.prototype`
 *  member (e.g. `status === 'toString'`) instead of `undefined`. */
export function quoteStatusLabelKey(status: string): string | null {
  return Object.hasOwn(LABEL_KEYS, status) ? LABEL_KEYS[status] : null;
}
