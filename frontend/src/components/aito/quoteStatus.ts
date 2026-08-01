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

/** How serious a status is, matched to the classification QuoteStatusActions
 *  already renders (accept = green, decline = status-error) so the two
 *  surfaces can never disagree about whether a status is bad. `expired` gets
 *  its own warning tone: QuoteStatusActions treats it the same as sent/viewed
 *  (still offers Accept/Decline — see AWAY_STATUSES in aitoBoardRules.ts) but
 *  it is a stalled quote, not a healthy in-flight one, so it should not read
 *  as neutral. Everything else — sent, viewed, draft, and any status Zoho
 *  adds that this map has never heard of — is neutral. Never green: green is
 *  reserved for the one state that actually authorises the work. */
export type QuoteStatusTone = 'success' | 'error' | 'warning' | 'neutral';

const STATUS_TONE: Record<string, QuoteStatusTone> = {
  accepted: 'success',
  declined: 'error',
  expired: 'warning',
};

/** Same `Object.hasOwn` guard as quoteStatusLabelKey, and for the same
 *  reason: `status` is free-text from the client, so a bare lookup could
 *  resolve `Object.prototype` members instead of falling through to
 *  neutral. */
export function quoteStatusTone(status: string): QuoteStatusTone {
  return Object.hasOwn(STATUS_TONE, status) ? STATUS_TONE[status] : 'neutral';
}

/** Complete, literal class strings per tone — Tailwind cannot see a
 *  dynamically-interpolated class name, so each tone's classes must appear
 *  in full somewhere in the source for the build to keep them. Two variants:
 *  the header eyebrow pill (text + border + accent-alpha background) and the
 *  Quote card's plain-text Status row (text only). */
export const QUOTE_STATUS_PILL_TONE_CLASSES: Record<QuoteStatusTone, string> = {
  // green-LIGHT for the text: the pill sits on the header's accent-washed
  // band, where the base accent is too close to its own background to read.
  // The border and fill stay on the base accent — they are behind the text,
  // not competing with it.
  success: 'text-bambu-green-light border-bambu-green/40 bg-bambu-green/10',
  error: 'text-status-error border-status-error/40 bg-status-error/10',
  warning: 'text-status-warning border-status-warning/40 bg-status-warning/10',
  neutral: 'text-bambu-gray-light border-bambu-gray/40 bg-bambu-gray/10',
};

export const QUOTE_STATUS_TEXT_TONE_CLASSES: Record<QuoteStatusTone, string> = {
  // Matches the pill above, so the header and the Quote card never show the
  // same status in two different greens.
  success: 'text-bambu-green-light',
  error: 'text-status-error',
  warning: 'text-status-warning',
  neutral: 'text-bambu-gray-light',
};
